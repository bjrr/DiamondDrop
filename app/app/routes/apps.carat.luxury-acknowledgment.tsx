import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { createAcknowledgment } from "~/db/repositories/acknowledgmentRepository.server";
import { isMasterVariantLuxurySteal } from "~/db/repositories/luxuryStealRepository.server";
import { getLatestPolicyVersion } from "~/db/repositories/policyVersionRepository.server";
import { prisma } from "~/db/client.server";
import {
  LUXURY_STEALS_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
  LUXURY_STEALS_ACKNOWLEDGMENT_POLICY_SLUG,
  LUXURY_STEALS_ACKNOWLEDGMENT_TEXT,
} from "~/domain/luxurysteals/acknowledgmentText";
import { normalizeShopifyVariantGid } from "~/domain/cart/shopifyVariantId";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * POST /apps/carat/luxury-acknowledgment — the Final Sale acknowledgment
 * capture endpoint (Slice 3 task 3-3, docs/specs/SLICE-3-LUXURY-STEALS.md
 * §4.3, criteria 133-136 and 146).
 *
 * A RESOURCE ROUTE — no default export. Same reasoning as every other
 * `apps.carat.*` route: `allowedActionOrigins` is unconditionally `[]` in
 * every production build, so a default export here would 400 every
 * legitimate storefront caller before validation runs (enforced by
 * `csrfResourceRouteFence.test.ts`).
 *
 * WHAT THIS ROUTE REFUSES TO DO (the hard constraint). It never records an
 * acknowledgment for a variant that is not, right now, a Luxury Steal in
 * Postgres (criterion 150). A client-supplied "isLuxurySteal" flag does not
 * exist in this route's request schema at all — the ONLY server-side truth
 * this route will act on is `isMasterVariantLuxurySteal`, task 3-1's read of
 * `master_variant.is_luxury_steal`. Manufacturing an acknowledgment row for
 * an item that carries no Final Sale terms would itself be false evidence,
 * which is worse than recording nothing.
 *
 * NEVER PRE-CHECKED, NEVER INFERRED. This endpoint records an affirmative
 * action that the customer already took in the theme (clicking "I
 * Understand & Agree") — it does not create that action. The request is
 * trusted to represent "the customer just clicked the button" only insofar
 * as the App Proxy signature authenticates the caller as the storefront;
 * nothing here infers consent from silence, a default, or a prior visit.
 *
 * WHAT THIS RETURNS. Only the new `Acknowledgment` row's id (criterion 136:
 * "the reference travels with the cart line"). Task 3-5 attaches that id to
 * the cart line as a line item property; task 3-4's order-time check later
 * matches an order line back to this id. No pricing, cost or margin data is
 * in scope for this route at all.
 */

const bodySchema = z.object({
  /** Bare numeric id or full `gid://shopify/ProductVariant/...` — same normalization as `apps.carat.cart.tsx`. */
  shopifyVariantId: z.string().min(1).max(200),
  /**
   * Optional Shopify cart reference (e.g. `cart.token`), when the theme has
   * one available. Acknowledgment is required BEFORE add-to-cart (criterion
   * 133), so a cart may not exist yet for a first-time visitor — this field
   * is deliberately optional, matching `Acknowledgment.cartRef`'s own
   * nullability (spec §0.5).
   */
  cartRef: z.string().min(1).max(200).optional(),
});

function badRequest(reason: string) {
  return Response.json({ error: "invalid_request", reason }, { status: 400 });
}

/** `gid://shopify/Customer/<id>` from the App Proxy's `logged_in_customer_id` query param, or `null` for a guest/logged-out request. Mirrors `normalizeShopifyVariantGid`'s bare-vs-gid handling for the same Shopify id convention. */
function normalizeCustomerGid(rawId: string | null): string | null {
  if (!rawId) return null;
  return rawId.startsWith("gid://") ? rawId : `gid://shopify/Customer/${rawId}`;
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const { verified, loggedInCustomerId, shop, reason } = verifyAppProxySignature(url.searchParams, getEnv().SHOPIFY_API_SECRET, getEnv().SHOPIFY_SHOP_DOMAIN);
  if (!verified) {
    logger.warn("luxury_acknowledgment.proxy_rejected", { reason, signedShop: shop });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

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
  const { shopifyVariantId, cartRef } = parsed.data;

  const gid = normalizeShopifyVariantGid(shopifyVariantId);
  const variant = await prisma.masterVariant.findUnique({
    where: { shopifyVariantGid: gid },
    select: { id: true, shopifyVariantGid: true, masterProduct: { select: { shopifyProductGid: true } } },
  });

  if (!variant) {
    logger.warn("luxury_acknowledgment.unknown_variant", { shopifyVariantId: gid });
    return Response.json({ error: "unknown_variant" }, { status: 404 });
  }

  // CRITERION 150 — the ONLY question this route asks Postgres, never a
  // client-supplied flag and never the theme's cached metafield read.
  const isLuxurySteal = await isMasterVariantLuxurySteal(variant.id);
  if (!isLuxurySteal) {
    logger.warn("luxury_acknowledgment.not_a_luxury_steal", { masterVariantId: variant.id });
    return Response.json({ error: "not_a_luxury_steal" }, { status: 422 });
  }

  const policyVersion = await getLatestPolicyVersion(LUXURY_STEALS_ACKNOWLEDGMENT_POLICY_SLUG);
  if (!policyVersion) {
    // Should not happen once `prisma/seed.ts` has run — surfaced loudly
    // rather than silently recording evidence against a policy that does
    // not exist.
    logger.error("luxury_acknowledgment.policy_unavailable", {
      slug: LUXURY_STEALS_ACKNOWLEDGMENT_POLICY_SLUG,
    });
    return Response.json({ error: "policy_unavailable" }, { status: 500 });
  }

  const customerRef = normalizeCustomerGid(loggedInCustomerId);

  const acknowledgment = await createAcknowledgment({
    exactText: LUXURY_STEALS_ACKNOWLEDGMENT_TEXT,
    policyVersionId: policyVersion.id,
    acknowledgedAt: new Date(),
    affirmativeActionLabel: LUXURY_STEALS_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
    customerRef: customerRef ?? undefined,
    cartRef,
    productRef: variant.masterProduct.shopifyProductGid ?? undefined,
    variantRef: variant.shopifyVariantGid ?? undefined,
  });

  logger.info("luxury_acknowledgment.recorded", {
    acknowledgmentId: acknowledgment.id,
    masterVariantId: variant.id,
  });

  return Response.json(
    { acknowledgmentId: acknowledgment.id },
    { status: 201, headers: { "Cache-Control": "private, no-store" } }
  );
}
