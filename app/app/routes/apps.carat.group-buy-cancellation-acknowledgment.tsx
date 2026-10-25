import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { prisma } from "~/db/client.server";
import { createAcknowledgment } from "~/db/repositories/acknowledgmentRepository.server";
import { getLatestPolicyVersion } from "~/db/repositories/policyVersionRepository.server";
import { normalizeShopifyVariantGid } from "~/domain/cart/shopifyVariantId";
import {
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_TEXT,
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG,
} from "~/domain/groupbuy/cancellationAcknowledgmentText";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * POST /apps/carat/group-buy-cancellation-acknowledgment — the Group Buy
 * cancellation-policy acknowledgment CAPTURE endpoint for the native/Card
 * checkout path (owner spec 2026-09-27/28, docs/SLICE-2-AND-GROUP-BUY-OWNER
 * -DECISIONS.md, README "Group Buy — Locked MVP1 Direction").
 *
 * A RESOURCE ROUTE — no default export. Same reasoning as every other
 * `apps.carat.*` route: `allowedActionOrigins` is unconditionally `[]` in
 * every production build, so a default export here would 400 every
 * legitimate storefront caller before validation runs (enforced by
 * `csrfResourceRouteFence.test.ts`).
 *
 * ============================================================================
 * THIS ROUTE IS CAPTURE, NOT ENFORCEMENT — SAY SO IN CODE (owner's own
 * instruction, in writing, after a prior mistake elsewhere in this codebase
 * conflated the two)
 * ============================================================================
 * This endpoint records a real, evidence-grade `Acknowledgment` row and
 * returns its id so the theme's gate (`group-buy-cancellation-gate.js`) can
 * attach it to the cart line as a `_`-prefixed line item property. THAT IS
 * ALL IT DOES. It cannot, by itself, stop a customer (or a bypassed
 * storefront) from POSTing directly to `/cart/add` with no acknowledgment at
 * all, or with a copied one. The BINDING control is the `orders/create`
 * verification in `groupBuyOrderHandler.server.ts` — reference-is-not-proof,
 * checked against this order's own authenticated customer, the named
 * campaign, and the CURRENT required text/label/policy version, BEFORE any
 * qualifying unit is ever counted. See that handler's own module comment for
 * the full design. This route existing and working correctly is necessary
 * for a legitimate customer's order to verify; it is not what makes an
 * illegitimate one fail.
 *
 * ============================================================================
 * NO GUEST PATH — REQUIRED CUSTOMER ACCOUNTS
 * ============================================================================
 * UNLIKE `apps.carat.luxury-acknowledgment.tsx` (which records a nullable
 * `customerRef` for a possibly-anonymous visitor), this route REFUSES an
 * anonymous request outright. Group Buy ordering already requires a signed
 * -in customer end to end (docs/REQUIRED-CUSTOMER-ACCOUNTS.md; see
 * `group-buy-campaign.liquid`'s own sign-in gate and
 * `apps.carat.group-buy-bank-checkout.tsx`'s identical refusal), and the
 * order-time verification's `customer_mismatch` check is meaningless against
 * an acknowledgment with no customer on it at all — recording one here would
 * be evidence that could never verify against anything, which is worse than
 * refusing outright.
 */

const bodySchema = z.object({
  campaignCode: z.string().min(1).max(200),
  /** Bare numeric id or full `gid://shopify/ProductVariant/...`, when the theme has one selected. Best-effort only — see below. */
  shopifyVariantId: z.string().min(1).max(200).optional(),
  /** Optional Shopify cart reference, when the theme has one available (mirrors `apps.carat.luxury-acknowledgment.tsx`'s identical field). */
  cartRef: z.string().min(1).max(200).optional(),
});

function badRequest(reason: string) {
  return Response.json({ error: "invalid_request", reason }, { status: 400 });
}

function authenticationRequired() {
  return Response.json(
    {
      error: "authentication_required",
      // docs/REQUIRED-CUSTOMER-ACCOUNTS.md §4's approved gate copy, verbatim
      // — same string every other `apps.carat.*` route in this family uses.
      message: "Please sign in or create a CaratForUs account to continue.",
    },
    { status: 401 }
  );
}

/** `gid://shopify/Customer/<id>` from the App Proxy's `logged_in_customer_id`. The caller below never passes a null/absent id past the authentication gate. */
function normalizeCustomerGid(rawId: string): string {
  return rawId.startsWith("gid://") ? rawId : `gid://shopify/Customer/${rawId}`;
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const { verified, loggedInCustomerId, shop, reason } = verifyAppProxySignature(url.searchParams, getEnv().SHOPIFY_API_SECRET, getEnv().SHOPIFY_SHOP_DOMAIN);
  if (!verified) {
    logger.warn("group_buy_cancellation_acknowledgment.proxy_rejected", { reason, signedShop: shop });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // NO GUEST PATH — see this file's own module comment.
  if (!loggedInCustomerId) {
    logger.warn("group_buy_cancellation_acknowledgment.anonymous_rejected", {});
    return authenticationRequired();
  }
  const customerGid = normalizeCustomerGid(loggedInCustomerId);

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return badRequest("body is not valid JSON");
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return badRequest("body does not match the acknowledgment request contract");
  }
  const { campaignCode, shopifyVariantId, cartRef } = parsed.data;

  // Only ever records evidence for a campaign that genuinely exists and is
  // currently open — mirrors `apps.carat.luxury-acknowledgment.tsx`'s own
  // "never manufacture evidence for something not actually eligible"
  // discipline (there: is this variant really a Luxury Steal; here: is this
  // campaign really open right now).
  const campaign = await prisma.groupBuyCampaign.findUnique({
    where: { code: campaignCode },
    select: { id: true, code: true, status: true },
  });
  if (!campaign || campaign.status !== "open") {
    logger.warn("group_buy_cancellation_acknowledgment.campaign_not_open", { campaignCode });
    return Response.json({ error: "campaign_not_open" }, { status: 422 });
  }

  const policyVersion = await getLatestPolicyVersion(GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG);
  if (!policyVersion) {
    // Should not happen once the migration has run — surfaced loudly rather
    // than silently recording evidence against a policy that does not exist,
    // same fail-closed discipline as every sibling acknowledgment route.
    logger.error("group_buy_cancellation_acknowledgment.policy_unavailable", {
      slug: GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG,
    });
    return Response.json({ error: "policy_unavailable" }, { status: 503 });
  }

  // Best-effort only, never gates creation — mirrors the RMA/warranty routes'
  // identical treatment of an optional variant reference. The order-time
  // verification scopes on `campaignRef`, not on this field.
  let variantGid: string | null = null;
  let productGid: string | null = null;
  if (shopifyVariantId) {
    const gid = normalizeShopifyVariantGid(shopifyVariantId);
    const variant = await prisma.masterVariant.findUnique({
      where: { shopifyVariantGid: gid },
      select: { shopifyVariantGid: true, masterProduct: { select: { shopifyProductGid: true } } },
    });
    if (variant) {
      variantGid = variant.shopifyVariantGid;
      productGid = variant.masterProduct.shopifyProductGid ?? null;
    }
  }

  const acknowledgment = await createAcknowledgment({
    exactText: policyVersion.text,
    policyVersionId: policyVersion.id,
    acknowledgedAt: new Date(),
    affirmativeActionLabel: GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
    // THE AUTHENTICATED identity — never a client-supplied field.
    customerRef: customerGid,
    campaignRef: campaign.code,
    cartRef,
    productRef: productGid ?? undefined,
    variantRef: variantGid ?? undefined,
  });

  logger.info("group_buy_cancellation_acknowledgment.recorded", {
    acknowledgmentId: acknowledgment.id,
    campaignId: campaign.id,
  });

  // Sanity — the pinned text this route just wrote should always equal the
  // in-code constant (the migration/registry fence already guarantees this
  // at the database level); asserting it here too costs nothing and would
  // turn a misprovisioned environment into a loud 500 rather than silently
  // recording evidence that disagrees with what this file believes it wrote.
  if (policyVersion.text !== GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_TEXT) {
    logger.error("group_buy_cancellation_acknowledgment.provisioned_text_mismatch", {
      acknowledgmentId: acknowledgment.id,
    });
  }

  return Response.json(
    { acknowledgmentId: acknowledgment.id },
    { status: 201, headers: { "Cache-Control": "private, no-store" } }
  );
}
