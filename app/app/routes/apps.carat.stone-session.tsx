/**
 * Set Your Own Stone — create a stone session and return matching settings.
 *
 * Authoritative requirements: docs/SET-YOUR-OWN-STONE.md §10, §11.
 *
 * ---------------------------------------------------------------------------
 * THE TRUST BOUNDARY
 * ---------------------------------------------------------------------------
 * Compatibility is decided HERE and nowhere else. The storefront renders a
 * verdict; it never computes one, and a status in the request body is
 * ignored rather than trusted. §11 calls for "no client-only trust
 * boundary", and the only way to mean it is for the server to be the sole
 * author of the answer.
 *
 * SIGNED IN OR NOT, the customer may describe a stone and browse — the same
 * stance custom jewelry intake takes for an enquiry. Only the optional
 * certificate upload requires an account, and for the same reason: an
 * endpoint that mints presigned PUTs for anonymous callers is free file
 * hosting on our account (owner decision 2026-10-05).
 *
 * CARAT IS ACCEPTED AND IMMEDIATELY SET ASIDE. It is stored for display and
 * staff review and is not passed to the matcher, which has no parameter for
 * it (§4, §15.5).
 */
import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { findEligibleSettingsForShape } from "~/db/repositories/readySettingRepository.server";
import { groupMountings, type MatchedVariant } from "~/domain/setyourownstone/groupMountings";
import {
  createStoneSession,
  toStoneSessionView,
} from "~/db/repositories/stoneSessionRepository.server";
import {
  COMPATIBILITY_QUALIFIER,
  labelFor,
  matchSettings,
  micrometresToMm,
  mmToMicrometres,
  type MatchResult,
  type StoneShape,
} from "~/domain/setyourownstone/matching";
import { resolveMatchingPolicy } from "~/domain/setyourownstone/policy.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { adminClientForShop } from "~/shopify/admin/offlineClient.server";
import { readVariantDisplay } from "~/shopify/admin/syosProductReader.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

const SHAPES = [
  "round",
  "oval",
  "cushion",
  "princess",
  "emerald",
  "radiant",
  "pear",
  "marquise",
  "asscher",
  "heart",
] as const;

/**
 * Millimetres arrive as a STRING and stay one until `mmToMicrometres`
 * converts them to an integer. Accepting a JSON number here would let a
 * float into the pipeline at the first opportunity, which §11's "no
 * floating-point surprises" exists to prevent.
 */
const mmString = z
  .string()
  .trim()
  .regex(/^\d{1,2}(\.\d{1,3})?$/, "millimetres must be a number with at most 3 decimal places");

const bodySchema = z
  .object({
    /**
     * The three choices §4 offers. The underlying enum is the pricing
     * engine's wider `StoneType`; this narrowing is presentation, enforced
     * at the boundary rather than by a second enum.
     */
    stoneType: z.enum(["natural_diamond", "lab_diamond", "colored_gemstone"]),
    shape: z.enum(SHAPES),
    /** Display only. Never reaches the matcher. */
    caratWeight: z.string().trim().regex(/^\d{1,3}(\.\d{1,3})?$/),
    lengthMm: mmString,
    widthMm: mmString,
    depthMm: mmString.optional(),
    certLab: z.string().trim().min(1).max(100).optional(),
    certNumber: z.string().trim().min(1).max(100).optional(),
    isCurrentlyMounted: z.boolean(),
    notes: z.string().trim().min(1).max(2000).optional(),
  })
  .strict();

function badRequest(message: string) {
  return Response.json({ error: "invalid_request", message }, { status: 400 });
}

/** `gid://shopify/Customer/<id>` from the proxy's `logged_in_customer_id`.
 *
 *  A LOCAL COPY ON PURPOSE. Seventeen App Proxy routes already define this
 *  same two-line helper locally; extracting it is a worthwhile tidy-up but
 *  it is a seventeen-file refactor, and doing that as a side effect of
 *  adding a feature is how unrelated regressions get introduced. Following
 *  the existing convention here, and noted for its own change. */
function normalizeCustomerGid(rawId: string): string {
  return rawId.startsWith("gid://") ? rawId : `gid://shopify/Customer/${rawId}`;
}

/** What the storefront renders for one candidate. Note what is ABSENT: no
 *  tolerance, no rule internals, no vendor range. The customer is told the
 *  verdict, not the arithmetic behind it. */
interface CandidateView {
  readonly variantGid: string;
  readonly label: string;
  readonly status: string;
  readonly nominalLengthMm: string;
  readonly nominalWidthMm: string;
}

function toCandidateView(result: MatchResult): CandidateView {
  return {
    variantGid: result.setting.shopifyVariantGid,
    label: labelFor(result),
    status: result.status,
    nominalLengthMm: micrometresToMm(result.setting.nominalLengthUm),
    nominalWidthMm: micrometresToMm(result.setting.nominalWidthUm),
  };
}

/** The matcher's answer, in the shape the grouping function consumes. */
function toMatchedVariant(result: MatchResult): MatchedVariant {
  return {
    variantGid: result.setting.shopifyVariantGid,
    status: result.status,
    label: labelFor(result),
    centerSizeProfileId: result.setting.centerSizeProfileId ?? null,
    nominalLengthMm: micrometresToMm(result.setting.nominalLengthUm),
    nominalWidthMm: micrometresToMm(result.setting.nominalWidthUm),
  };
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const { verified, loggedInCustomerId, shop, reason } = verifyAppProxySignature(
    url.searchParams,
    getEnv().SHOPIFY_API_SECRET,
    getEnv().SHOPIFY_SHOP_DOMAIN
  );
  if (!verified) {
    logger.warn("stone_session.proxy_rejected", { reason, signedShop: shop });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // From the SIGNED proxy value only, never from the body.
  const customerRef = loggedInCustomerId ? normalizeCustomerGid(loggedInCustomerId) : null;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return badRequest("body is not valid JSON");
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return badRequest("body does not match the stone session contract");
  }
  const body = parsed.data;

  // Converted once, at the boundary, into integers. Everything downstream
  // compares whole micrometres.
  let lengthUm: number;
  let widthUm: number;
  let depthUm: number | null = null;
  try {
    lengthUm = mmToMicrometres(body.lengthMm);
    widthUm = mmToMicrometres(body.widthMm);
    if (body.depthMm !== undefined) depthUm = mmToMicrometres(body.depthMm);
  } catch {
    return badRequest("millimetre measurements must be numbers with at most 3 decimal places");
  }

  // A stone wider than it is long is almost always two fields swapped. Said
  // plainly here rather than silently matching nothing for the rest of the
  // session. Round stones are legitimately equal.
  if (widthUm > lengthUm) {
    return badRequest("length should be the longer measurement — check whether length and width are swapped");
  }

  const session = await createStoneSession({
    customerRef,
    stoneType: body.stoneType,
    shape: body.shape,
    caratWeight: body.caratWeight,
    lengthUm,
    widthUm,
    depthUm,
    certLab: body.certLab ?? null,
    certNumber: body.certNumber ?? null,
    isCurrentlyMounted: body.isCurrentlyMounted,
    notes: body.notes ?? null,
  });

  const settings = await findEligibleSettingsForShape(body.shape as StoneShape);
  const summary = matchSettings(
    { shape: body.shape as StoneShape, lengthUm, widthUm, depthUm: depthUm ?? undefined },
    settings,
    await resolveMatchingPolicy()
  );

  // ------------------------------------------------- the customer-facing cards
  //
  // The matcher answers per variant, correctly: the pilot's 9 x 7 pear
  // matches fifteen variants of one ring. Fifteen identical cards would be
  // absurd, so they collapse to one per mounting + matched centre size, with
  // metal and ring size left for the customer and the centre size shown as
  // settled information.
  //
  // DISPLAY DATA IS READ FROM SHOPIFY, NOT MIRRORED. Title, image, price and
  // availability are Shopify's to change; a stale price on a card is a worse
  // failure than one extra read. If that read fails the customer still gets a
  // usable answer -- the verdict is already computed -- so it degrades to an
  // empty card list rather than a 500.
  const matched = [...summary.automatic, ...summary.reviewRequired].map(toMatchedVariant);
  let mountings: ReturnType<typeof groupMountings> = [];

  if (matched.length > 0 && shop) {
    try {
      const admin = await adminClientForShop(shop);
      if (admin) {
        const display = await readVariantDisplay(admin, matched.map((m) => m.variantGid));
        mountings = groupMountings(matched, display);
      } else {
        logger.warn("stone_session.no_admin_client", { shop });
      }
    } catch (error) {
      logger.warn("stone_session.display_read_failed", {
        shop,
        message: error instanceof Error ? error.message : "unknown",
      });
    }
  }

  logger.info("stone_session.created", {
    sessionReference: session.sessionReference,
    authenticated: customerRef !== null,
    shape: body.shape,
    eligibleSettingsConsidered: settings.length,
    automatic: summary.automatic.length,
    reviewRequired: summary.reviewRequired.length,
    mountingsShown: mountings.length,
  });

  return Response.json(
    {
      session: toStoneSessionView(session),
      display: {
        lengthMm: micrometresToMm(lengthUm),
        widthMm: micrometresToMm(widthUm),
        depthMm: depthUm === null ? null : micrometresToMm(depthUm),
      },
      /**
       * What the storefront renders: one card per mounting + matched centre
       * size. The flat `matches` below is retained for diagnostics and for
       * the existing tests; the UI reads this.
       */
      mountings,
      matches: {
        automatic: summary.automatic.map(toCandidateView),
        reviewRequired: summary.reviewRequired.map(toCandidateView),
        /** True when nothing qualified. The storefront must then lead with
         *  the Custom Setting path (§6.4) — which is also the launch state,
         *  since no ready settings exist yet. */
        customRecommended: summary.customRecommended,
      },
      /** Accompanies every automatic match (§6.3). Never "guaranteed fit". */
      qualifier: COMPATIBILITY_QUALIFIER,
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
