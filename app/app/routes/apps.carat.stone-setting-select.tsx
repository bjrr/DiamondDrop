/**
 * Set Your Own Stone — record which ready setting the customer chose.
 *
 * Authoritative requirements: docs/SET-YOUR-OWN-STONE.md §8, §10.
 *
 * ---------------------------------------------------------------------------
 * THE COMPATIBILITY VERDICT IS RECOMPUTED HERE, NOT ACCEPTED
 * ---------------------------------------------------------------------------
 * The request says which setting; it does not get to say whether that
 * setting fits. The status and rule are derived server-side from the stored
 * stone and the stored compatibility record, exactly as they were when the
 * customer was shown the list. A body that claimed `status: "automatic"`
 * would be ignored, because §11 requires no client-only trust boundary and a
 * compatibility claim is precisely the thing worth forging.
 *
 * A NO-MATCH SELECTION IS STILL RECORDED. If the customer picks something
 * the rules do not endorse — by editing the page, by coming back to a stale
 * tab after staff corrected a nominal size — the selection is stored with
 * its real verdict rather than refused. Staff review every project before
 * anything is shipped anywhere (§8), so the honest record of "they chose
 * this and it did not match" is more useful than a 400.
 */
import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { findSettingByVariantGid } from "~/db/repositories/readySettingRepository.server";
import {
  findStoneSessionByReference,
  recordSettingSelection,
} from "~/db/repositories/stoneSessionRepository.server";
import {
  COMPATIBILITY_QUALIFIER,
  classify,
  labelFor,
  type StoneShape,
} from "~/domain/setyourownstone/matching";
import { resolveMatchingPolicy } from "~/domain/setyourownstone/policy.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

const bodySchema = z
  .object({
    sessionReference: z.string().trim().min(1).max(64),
    /** Shopify identity of the chosen configuration. */
    variantGid: z.string().trim().min(1).max(255),
    productGid: z.string().trim().min(1).max(255),
    /**
     * Metal, ring size and similar — whatever the product legitimately
     * offers (§8). Values only; this route does not validate them against
     * Shopify, because the cart and checkout already do and duplicating
     * that check here would be a second source of truth for option
     * validity.
     */
    selectedOptions: z.record(z.string().max(100), z.string().max(200)).optional(),
  })
  .strict();

function badRequest(message: string) {
  return Response.json({ error: "invalid_request", message }, { status: 400 });
}

/** `gid://shopify/Customer/<id>` from the proxy's `logged_in_customer_id`.
 *  A local copy, matching the convention in seventeen sibling routes. */
function normalizeCustomerGid(rawId: string): string {
  return rawId.startsWith("gid://") ? rawId : `gid://shopify/Customer/${rawId}`;
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
    logger.warn("stone_setting_select.proxy_rejected", { reason, signedShop: shop });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  const customerRef = loggedInCustomerId ? normalizeCustomerGid(loggedInCustomerId) : null;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return badRequest("body is not valid JSON");
  }
  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return badRequest("body does not match the setting selection contract");
  }
  const body = parsed.data;

  const session = await findStoneSessionByReference(body.sessionReference);
  if (!session) {
    return badRequest("that stone session could not be found");
  }

  // Same ownership rule as the Custom Jewelry handoff: a session belonging
  // to a signed-in customer may only be acted on by that customer. An
  // anonymous session stays claimable.
  if (session.customerRef !== null && session.customerRef !== customerRef) {
    logger.warn("stone_setting_select.session_not_owned", {
      sessionReference: session.sessionReference,
    });
    return Response.json({ error: "unauthorized" }, { status: 403 });
  }

  const setting = await findSettingByVariantGid(body.variantGid);
  if (!setting) {
    return badRequest("that setting is not available for Set Your Own Stone");
  }

  // Derived, never taken from the request.
  const verdict = classify(
    {
      shape: session.shape as StoneShape,
      lengthUm: session.lengthUm,
      widthUm: session.widthUm,
      depthUm: session.depthUm ?? undefined,
    },
    setting,
    await resolveMatchingPolicy()
  );

  const updated = await recordSettingSelection({
    sessionReference: session.sessionReference,
    selectedProductGid: body.productGid,
    selectedVariantGid: body.variantGid,
    selectedOptions: body.selectedOptions ?? null,
    compatibilityStatus: verdict.status,
    compatibilityRule: verdict.rule,
  });

  logger.info("stone_setting_select.recorded", {
    sessionReference: updated.sessionReference,
    status: verdict.status,
    rule: verdict.rule,
    authenticated: customerRef !== null,
  });

  return Response.json(
    {
      sessionReference: updated.sessionReference,
      compatibility: {
        status: verdict.status,
        label: labelFor(verdict),
      },
      qualifier: COMPATIBILITY_QUALIFIER,
      /** §8 and §13: the customer is told to wait for confirmation and
       *  shipping instructions, and nothing more operational than that. */
      nextStep:
        "We will review your stone and setting choice and confirm compatibility before you send us your stone.",
    },
    { headers: { "Cache-Control": "private, no-store" } }
  );
}
