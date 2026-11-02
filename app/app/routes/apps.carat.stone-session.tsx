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
import type { ActionFunctionArgs, LoaderFunctionArgs } from "react-router";
import { z } from "zod";

import { findEligibleSettingsForShape } from "~/db/repositories/readySettingRepository.server";
import { groupMountings, type MatchedVariant } from "~/domain/setyourownstone/groupMountings";
import {
  createStoneSession,
  toStoneSessionView,
  findStoneSessionByReference,
} from "~/db/repositories/stoneSessionRepository.server";
import type { StoneMountedState } from "~/domain/setyourownstone/stoneRemoval";
import {
  STONE_MOUNTED_STATES,
  STONE_REMOVAL_COPY,
  stoneRemovalChargeFor,
  stoneRemovalOfferFor,
} from "~/domain/setyourownstone/stoneRemoval";
import {
  COMPATIBILITY_QUALIFIER,
  REVIEW_REQUIRED_EXPLANATION,
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
import { readMountingVariantPrices } from "~/shopify/admin/syosMountingPricing.server";
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
    /**
     * LOOSE / MOUNTED_PRONG / MOUNTED_UNSUPPORTED (§17.3). Required, because
     * whether CaratForUs may remove the stone is not something to default.
     */
    mountedState: z.enum(STONE_MOUNTED_STATES),
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

/**
 * Match a stone and build everything the storefront renders for it.
 *
 * Shared by the POST that creates a session and the GET that REHYDRATES one,
 * so a customer returning from a mounting detail page sees exactly the cards
 * they left -- recomputed from the server's own record rather than restored
 * from anything the browser kept. This file's standing rule is that state
 * lives on the server and the page holds only an opaque reference; §5 of the
 * 2026-11-02 direction (preserve the SYOS context) is honoured by making the
 * reference sufficient, not by copying the stone into storage.
 */
async function buildMatchPayload(
  stone: { shape: StoneShape; lengthUm: number; widthUm: number; depthUm: number | null },
  shop: string | null,
  /**
   * The removal charge that applies to this session, in minor units — 0 when
   * none does.
   *
   * Passed in so the per-variant TOTALS are computed here, on the server, in
   * BigInt. §17 wants the customer shown mounting, Stone Removal and then the
   * appropriate total; adding those two figures in the browser would be
   * floating-point money arithmetic on a page, which this codebase forbids
   * outright.
   */
  removalFeeMinorUnits: bigint
) {
  const settings = await findEligibleSettingsForShape(stone.shape);
  const summary = matchSettings(
    { shape: stone.shape, lengthUm: stone.lengthUm, widthUm: stone.widthUm, depthUm: stone.depthUm ?? undefined },
    settings,
    await resolveMatchingPolicy()
  );

  // The matcher answers per variant, correctly: the pilot's 9 x 7 pear matches
  // fifteen variants of one ring. Fifteen identical cards would be absurd, so
  // they collapse to one per mounting + matched centre size, with metal and
  // ring size left to the customer and the centre size shown as settled fact.
  //
  // DISPLAY AND PRICES ARE READ FROM SHOPIFY, NOT MIRRORED. Title, image and
  // availability are Shopify's to change, and a stale price on a card is a
  // worse failure than one extra read. If that read fails the customer still
  // gets a usable answer -- the verdict is already computed -- so it degrades
  // to an empty card list rather than a 500.
  const matched = [...summary.automatic, ...summary.reviewRequired].map(toMatchedVariant);
  let mountings: ReturnType<typeof groupMountings> = [];

  if (matched.length > 0 && shop) {
    try {
      const admin = await adminClientForShop(shop);
      if (admin) {
        const gids = matched.map((m) => m.variantGid);
        const display = await readVariantDisplay(admin, gids);
        // Both customer-facing prices, COMPUTED from the structured Shopify
        // inputs by the existing pricing modules -- not read from the
        // bank-price metafield, which is a presentation cache that money is
        // never reconciled from. Supplier cost never leaves that module.
        const prices = await readMountingVariantPrices(admin, gids);
        for (const [gid, d] of display) {
          const base = prices.get(gid) ?? null;
          display.set(gid, { ...d, prices: withRemovalTotals(base, removalFeeMinorUnits) });
        }
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

  return { settings, summary, mountings };
}

/**
 * Mounting prices plus the order totals once a required removal is included.
 *
 * Integer BigInt addition, server-side. The mounting's own two prices are
 * returned unchanged — §7 of the correction is explicit that removal is not
 * part of the mounting formula and must not be absorbed into it — and the
 * totals are added alongside as separate figures.
 *
 * With no fee, nothing is added at all, so a loose-stone card carries no total
 * field to render and no way to imply a charge.
 */
function withRemovalTotals(
  base: { bankPaymentPriceMinorUnits: string; regularCardPriceMinorUnits: string; bankPaymentSavingsMinorUnits: string; currency: string } | null,
  removalFeeMinorUnits: bigint
) {
  if (!base || removalFeeMinorUnits <= 0n) return base;
  return {
    ...base,
    removalFeeMinorUnits: removalFeeMinorUnits.toString(),
    totalCardPriceMinorUnits: (
      BigInt(base.regularCardPriceMinorUnits) + removalFeeMinorUnits
    ).toString(),
    totalBankPaymentPriceMinorUnits: (
      BigInt(base.bankPaymentPriceMinorUnits) + removalFeeMinorUnits
    ).toString(),
  };
}

/**
 * The $50 Stone Removal offer for this session (§17.3).
 *
 * SERVER-DECIDED, ALWAYS. The storefront renders what this says and never
 * works out for itself whether the service applies — the whole point of the
 * prong-only rule is that it is not the page's call.
 *
 * The amount travels as integer minor units, like every other money value
 * crossing this boundary; the storefront formats it without arithmetic.
 */
function removalPayload(session: {
  mountedState: StoneMountedState;
  stoneRemovalRequired: boolean;
}) {
  const offer = stoneRemovalOfferFor(session.mountedState);
  return {
    mountedState: session.mountedState,
    kind: offer.kind,
    /**
     * "Stone Removal Required = Yes/No" (§9). Read off the STORED row rather
     * than recomputed here, so what the storefront is told is the same fact
     * operations will read — and the two cannot drift, because a CHECK
     * constraint forbids the row from disagreeing with its mounted state.
     */
    required: session.stoneRemovalRequired,
    feeMinorUnits: offer.kind === "required" ? offer.feeMinorUnits.toString() : "0",
    currency: "USD",
    label: STONE_REMOVAL_COPY.offerLabel,
    /**
     * The approved wording for whichever case applies, and nothing for a loose
     * stone — there is no service to explain and no decision to make.
     */
    message:
      offer.kind === "required"
        ? STONE_REMOVAL_COPY.offered
        : offer.kind === "unavailable"
          ? STONE_REMOVAL_COPY.unavailable
          : null,
  };
}

/** The payload shape both entry points return. */
function matchResponse(
  session: Awaited<ReturnType<typeof createStoneSession>>,
  stone: { lengthUm: number; widthUm: number; depthUm: number | null },
  built: Awaited<ReturnType<typeof buildMatchPayload>>
) {
  return Response.json(
    {
      session: toStoneSessionView(session),
      display: {
        lengthMm: micrometresToMm(stone.lengthUm),
        widthMm: micrometresToMm(stone.widthUm),
        depthMm: stone.depthUm === null ? null : micrometresToMm(stone.depthUm),
      },
      mountings: built.mountings,
      matches: {
        automatic: built.summary.automatic.map(toCandidateView),
        reviewRequired: built.summary.reviewRequired.map(toCandidateView),
        customRecommended: built.summary.customRecommended,
      },
      qualifier: COMPATIBILITY_QUALIFIER,
      /**
       * The approved Review Required explanation, sent from the server so the
       * storefront cannot improvise it (§8, locked 2026-11-02). Shown only on
       * review-required cards; it never implies a fit guarantee and never
       * mentions the thresholds that produced the verdict.
       */
      reviewExplanation: REVIEW_REQUIRED_EXPLANATION,
      removal: removalPayload(session),
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}

/**
 * GET — rehydrate an existing session by its reference.
 *
 * Exists so opening a mounting's detail page and coming back does not make the
 * customer re-enter their stone (§5). Ownership is enforced the same way the
 * selection route does it: a session belonging to a signed-in customer may
 * only be read by that customer; an anonymous session stays readable, which is
 * what makes the flow work before sign-in.
 */
export async function loader({ request }: LoaderFunctionArgs) {
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
  const customerRef = loggedInCustomerId ? normalizeCustomerGid(loggedInCustomerId) : null;

  const reference = (url.searchParams.get("stone") ?? "").trim();
  if (reference === "" || reference.length > 64) return badRequest("a stone session reference is required");

  const session = await findStoneSessionByReference(reference);
  if (!session) return badRequest("that stone session could not be found");
  if (session.customerRef !== null && session.customerRef !== customerRef) {
    logger.warn("stone_session.not_owned", { sessionReference: session.sessionReference });
    return Response.json({ error: "unauthorized" }, { status: 403 });
  }

  const built = await buildMatchPayload(
    {
      shape: session.shape as StoneShape,
      lengthUm: session.lengthUm,
      widthUm: session.widthUm,
      depthUm: session.depthUm ?? null,
    },
    shop,
    // From the STORED answer, so a returning customer sees the same totals.
    stoneRemovalChargeFor(session.mountedState as StoneMountedState)
  );
  logger.info("stone_session.rehydrated", {
    sessionReference: session.sessionReference,
    mountingsShown: built.mountings.length,
  });
  return matchResponse(session, { lengthUm: session.lengthUm, widthUm: session.widthUm, depthUm: session.depthUm ?? null }, built);
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
    mountedState: body.mountedState,
    notes: body.notes ?? null,
  });

  const built = await buildMatchPayload(
    { shape: body.shape as StoneShape, lengthUm, widthUm, depthUm },
    shop,
    stoneRemovalChargeFor(body.mountedState)
  );
  const { settings, summary, mountings } = built;

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
      // The same approved explanation on the create path as on the rehydrate
      // path, so the wording cannot differ between a first visit and a return
      // from a mounting detail page.
      reviewExplanation: REVIEW_REQUIRED_EXPLANATION,
      // The same offer, from the same builder, on the create path.
      removal: removalPayload(session),
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
