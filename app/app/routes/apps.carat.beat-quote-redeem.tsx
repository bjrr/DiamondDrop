import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { prisma } from "~/db/client.server";
import { getPublishedVariantPrice } from "~/db/repositories/publishedPriceRepository.server";
import {
  BEAT_QUOTE_FALLBACK_PERCENT,
  type FallbackRefusal,
} from "~/domain/beatyourquote/fallbackBenefit";
import type {
  IneligibleLineReason,
  RedemptionLineInput,
} from "~/domain/beatyourquote/redemptionCalculation";
import { normalizeShopifyVariantGid } from "~/domain/cart/shopifyVariantId";
import { Money } from "~/domain/money/money";
import {
  attachRedemptionDraftOrder,
  releaseBeatQuoteRedemption,
  reserveBeatQuoteRedemption,
  type ReserveRefusal,
} from "~/jobs/beatyourquote/redeemFallbackBenefit.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import {
  ShopifyDraftOrderAdapter,
  type DraftOrderShippingAddressInput,
  type DraftOrderPort,
} from "~/shopify/admin/draftOrderAdapter.server";
import { verifyAppProxySignature } from "~/shopify/proxy";
import { BEAT_QUOTE_REDEMPTION_ORDER_TAG_PREFIX } from "~/shopify/webhooks/beatQuoteRedemptionOrderHandler.server";

/**
 * POST /apps/carat/beat-quote-redeem — redeeming the Let Us Beat Your Quote
 * fallback benefit (Slice 10, owner decision 2026-10-10).
 *
 * A RESOURCE ROUTE — no default export, same `allowedActionOrigins: []`
 * reasoning as every other `apps.carat.*` route, enforced by
 * `csrfResourceRouteFence.test.ts`.
 *
 * ============================================================================
 * THE REQUEST SUPPLIES WHAT THE CUSTOMER WANTS TO BUY. NOTHING ELSE.
 * ============================================================================
 * It carries a benefit code, variant ids, quantities, an email and a shipping
 * address. It does NOT carry — and `.strict()` makes it a 400 to try —
 * a price, a subtotal, a discount amount, an eligibility claim, a surface, a
 * customer id, or a stacking authorization. Every one of those is resolved
 * here, from the database:
 *
 *   unit prices        `getPublishedVariantPrice`, the single source of truth
 *   line eligibility   `master_variant.is_luxury_steal` and open-campaign
 *                      membership, read server-side per variant
 *   the customer       the App Proxy's `logged_in_customer_id`, never a body
 *                      field
 *   the discount       `quoteRedemption`, from the benefit's own frozen cap
 *
 * NEVER TRUST A BROWSER-SUPPLIED BENEFIT/CUSTOMER RELATIONSHIP (owner
 * decision, verbatim). The benefit is located by its code and then checked
 * against the AUTHENTICATED customer, because the benefit is non-transferable:
 * possession of a code is not entitlement. A code that belongs to someone else
 * and a code that does not exist get the same answer, so this endpoint cannot
 * be used to discover another customer's benefit.
 *
 * ============================================================================
 * SIGNED-IN ONLY, UNLIKE INTAKE
 * ============================================================================
 * `apps.carat.beat-quote-submission.tsx` deliberately accepts signed-out
 * visitors — it is an acquisition feature and asks for the account id only "if
 * available". This route is the opposite: a single-use, non-transferable
 * benefit cannot be redeemed by someone we cannot identify, and the order has
 * to be attributable to the customer it was issued to.
 *
 * ============================================================================
 * PRICED AT THE REGULAR/CARD PRICE — A FLAGGED ASSUMPTION, NOT A DECISION
 * ============================================================================
 * A redemption completes through Shopify's own checkout, so the lines are
 * priced at the Regular/Card Price and the discount comes off that. Bank
 * Payment redemption is NOT implemented here, and the omission is deliberate
 * rather than overlooked: a Bank Payment order must complete unpaid, with
 * payment terms, manual fund verification, the 24-hour guarantee and the
 * inactivation sweep — a materially different flow from a paid card checkout,
 * and one whose interaction with a single-use benefit (what happens to the
 * benefit when an unpaid Bank Payment redemption is cancelled?) is a product
 * question nobody has answered.
 *
 * WORTH THE OWNER'S ATTENTION: a customer may be better off paying by bank at
 * the lower Bank Payment Price than taking 10% off the Card Price, and this
 * route currently offers no way to compare the two. That is a real
 * customer-fairness question, not a technical gap.
 */

const MAX_REQUEST_LINES = 50;
const MAX_QUANTITY_PER_LINE = 9_999;

const redemptionLineRequestSchema = z
  .object({
    shopifyVariantId: z.string().min(1).max(200),
    quantity: z.number().int().positive().max(MAX_QUANTITY_PER_LINE),
  })
  .strict();

const shippingAddressRequestSchema = z
  .object({
    firstName: z.string().min(1).max(200).optional(),
    lastName: z.string().min(1).max(200).optional(),
    address1: z.string().min(1).max(500),
    address2: z.string().min(1).max(500).optional(),
    city: z.string().min(1).max(200),
    provinceCode: z.string().min(1).max(10).optional(),
    zip: z.string().min(1).max(20),
    countryCode: z.string().length(2),
    phone: z.string().min(1).max(50).optional(),
  })
  .strict() satisfies z.ZodType<DraftOrderShippingAddressInput>;

/**
 * NOTE WHAT IS ABSENT: no discount, no subtotal, no unit price, no eligibility,
 * no surface, no customer id, no stacking flag. `.strict()` turns an attempt to
 * send any of them into a 400 rather than a silent drop — the same discipline
 * the intake route applies to `treatment`, and for the same reason: an
 * accepted-and-ignored field is a field somebody later wires up.
 */
const redemptionRequestSchema = z
  .object({
    benefitCode: z.string().trim().min(1).max(100),
    email: z.string().trim().email().max(320),
    shippingAddress: shippingAddressRequestSchema,
    lines: z.array(redemptionLineRequestSchema).min(1).max(MAX_REQUEST_LINES),
  })
  .strict();

function badRequest(reason: string) {
  return Response.json({ error: "invalid_request", reason }, { status: 400 });
}

function authenticationRequired() {
  return Response.json(
    {
      error: "authentication_required",
      // docs/REQUIRED-CUSTOMER-ACCOUNTS.md §4's approved gate copy, verbatim.
      message: "Please sign in or create a CaratForUs account to continue.",
    },
    { status: 401 }
  );
}

function normalizeCustomerGid(rawId: string): string {
  return rawId.startsWith("gid://") ? rawId : `gid://shopify/Customer/${rawId}`;
}

/**
 * Customer-facing wording for each refusal.
 *
 * ============================================================================
 * WHY THE WRONG-CUSTOMER AND UNKNOWN-CODE MESSAGES ARE IDENTICAL
 * ============================================================================
 * "This benefit was issued to a different account" tells whoever typed the code
 * that it is REAL. That turns this endpoint into an oracle for guessing another
 * customer's benefit code, which is exactly the probing a single-use
 * non-transferable benefit invites. So both say the code is not valid for this
 * account, and the server log — not the response — records which it was.
 *
 * Every other refusal names its actual reason, because the customer can act on
 * it: an expired benefit is a date they can check, an ineligible cart is lines
 * they can change.
 */
const REFUSAL_MESSAGES: Record<ReserveRefusal, string> = {
  benefit_not_found: "That benefit code is not valid for this account.",
  not_transferable: "That benefit code is not valid for this account.",
  expired: "That benefit has expired and can no longer be used.",
  revoked: "That benefit is no longer available.",
  already_redeemed: "That benefit has already been used.",
  already_reserved:
    "That benefit is already being used in another checkout. Complete or abandon that checkout and try again.",
  surface_not_eligible:
    `The ${BEAT_QUOTE_FALLBACK_PERCENT}% benefit applies to regular purchases and Custom Jewelry only.`,
  stacking_not_authorized: "That benefit cannot be combined with another promotion.",
  calculation_refused:
    `None of the items in this order are eligible for the ${BEAT_QUOTE_FALLBACK_PERCENT}% benefit. ` +
    "Community Group Buys and Luxury Steals are excluded.",
};
// THERE IS NO "NOT ISSUED YET" REFUSAL, and that is structural rather than an
// omission. The owner's pre-conditions list "issued" alongside not-expired and
// not-revoked, but a `beat_quote_fallback_benefit` row only comes into
// existence when it is issued — `createFallbackBenefit` writes `issuedAt` with
// it, and the column is NOT NULL. An unissued benefit therefore cannot be
// found, and `benefit_not_found` is the honest answer.

/** 409 for "try again differently", 400 for "this benefit is finished". */
const RETRYABLE_REFUSALS: ReadonlySet<ReserveRefusal> = new Set<ReserveRefusal>([
  "already_reserved",
  "calculation_refused",
  "surface_not_eligible",
  "stacking_not_authorized",
]);

function refused(refusal: ReserveRefusal) {
  return Response.json(
    { error: "benefit_not_redeemable", reason: refusal, message: REFUSAL_MESSAGES[refusal] },
    { status: RETRYABLE_REFUSALS.has(refusal) ? 409 : 400 }
  );
}

/**
 * Lazily built — see `customJewelryDepositPaymentHandler.server.ts`'s header.
 * An eagerly-constructed Admin client makes every refused request pay for a
 * session lookup, and that cost a live 500 once already.
 */
/**
 * Test seam. An integration test has no Shopify session, so it cannot let this
 * route build its own Admin client.
 *
 * DELIBERATELY NOT A PARAMETER on `action`: React Router calls `action` with a
 * fixed signature, and threading a port through it would mean production code
 * carrying an argument only tests supply — the shape where somebody eventually
 * passes a port from a request. A module-level override that tests set and
 * clear keeps the production path with exactly one way to get a client.
 */
let draftOrderPortOverride: DraftOrderPort | null = null;
export function __setDraftOrderPortForTests(port: DraftOrderPort | null): void {
  draftOrderPortOverride = port;
}

async function draftOrderPort(): Promise<DraftOrderPort> {
  if (draftOrderPortOverride) return draftOrderPortOverride;
  const { SHOPIFY_SHOP_DOMAIN } = getEnv();
  if (!SHOPIFY_SHOP_DOMAIN) {
    throw new Error(
      "SHOPIFY_SHOP_DOMAIN is not configured; benefit redemption cannot reach the Shopify Admin API."
    );
  }
  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOPIFY_SHOP_DOMAIN);
  return new ShopifyDraftOrderAdapter(admin);
}

interface ResolvedLine {
  readonly shopifyVariantGid: string;
  readonly quantity: number;
  readonly unitPrice: Money;
  readonly ineligibleBecause: IneligibleLineReason | null;
}

/**
 * Resolves each requested line to a server-side price and an eligibility
 * classification. NOTHING here comes from the request but the variant id and
 * the quantity.
 *
 * A line whose variant is unknown or unsynced is REFUSED rather than silently
 * excluded. Excluding it would quietly shrink the eligible subtotal and so the
 * discount — the customer would be charged a benefit they did not get, on an
 * order they thought included it.
 */
async function resolveLines(
  requestLines: readonly { shopifyVariantId: string; quantity: number }[]
): Promise<
  | { readonly ok: true; readonly lines: readonly ResolvedLine[] }
  | { readonly ok: false; readonly unresolvable: readonly { shopifyVariantId: string; reason: string }[] }
> {
  const gids = requestLines.map((line) => normalizeShopifyVariantGid(line.shopifyVariantId));
  const variants = await prisma.masterVariant.findMany({
    where: { shopifyVariantGid: { in: gids } },
    select: {
      id: true,
      shopifyVariantGid: true,
      isLuxurySteal: true,
      // A variant belonging to an OPEN campaign is a Group Buy line. Closed
      // and cancelled campaigns do not disqualify it: the exclusion is about
      // what the customer is buying now, not what this variant was once sold
      // through.
      groupBuyCampaignVariants: {
        where: { campaign: { status: "open" } },
        select: { id: true },
        take: 1,
      },
    },
  });
  const variantByGid = new Map(variants.map((v) => [v.shopifyVariantGid as string, v]));

  const lines: ResolvedLine[] = [];
  const unresolvable: { shopifyVariantId: string; reason: string }[] = [];

  for (const requestLine of requestLines) {
    const gid = normalizeShopifyVariantGid(requestLine.shopifyVariantId);
    const variant = variantByGid.get(gid);
    if (!variant) {
      unresolvable.push({ shopifyVariantId: requestLine.shopifyVariantId, reason: "unknown_variant" });
      continue;
    }

    // The single source of truth for a published price. Sequential because
    // that function's contract is per-variant; request size is bounded above.
    const published = await getPublishedVariantPrice(variant.id);
    if (published.kind === "not_purchasable") {
      unresolvable.push({ shopifyVariantId: requestLine.shopifyVariantId, reason: "unsynced" });
      continue;
    }

    // Luxury Steals checked FIRST. A variant could in principle be both, and
    // of the two reasons this is the one a customer most needs to hear: a
    // Luxury Steal is Final Sale, which is a bigger deal to the purchase than
    // an ineligible discount.
    const ineligibleBecause: IneligibleLineReason | null = variant.isLuxurySteal
      ? "luxury_steal"
      : variant.groupBuyCampaignVariants.length > 0
        ? "group_buy"
        : null;

    lines.push({
      shopifyVariantGid: gid,
      quantity: requestLine.quantity,
      // THE REGULAR/CARD PRICE. See the module comment: a redemption is a card
      // checkout, so the benefit comes off the card price.
      unitPrice: Money.fromMinorUnits(published.price.regularCardPriceMinorUnits, published.price.currency),
      ineligibleBecause,
    });
  }

  if (unresolvable.length > 0) return { ok: false, unresolvable };
  return { ok: true, lines };
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const { verified, loggedInCustomerId } = verifyAppProxySignature(url.searchParams, getEnv().SHOPIFY_API_SECRET);
  if (!verified) {
    logger.warn("beat_quote_redeem.proxy_rejected", { reason: "invalid_or_missing_signature" });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  // Checked before the body is parsed. A benefit cannot be redeemed by someone
  // we cannot identify.
  if (!loggedInCustomerId) {
    logger.warn("beat_quote_redeem.anonymous_rejected", {});
    return authenticationRequired();
  }
  const customerGid = normalizeCustomerGid(loggedInCustomerId);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("body is not valid JSON");
  }
  const parsed = redemptionRequestSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest("body does not match the benefit redemption request contract");
  }
  const { benefitCode, email, shippingAddress, lines: requestLines } = parsed.data;

  // DUPLICATE VARIANTS REFUSED, NOT COALESCED. The adapter refuses them too,
  // but discovering it there would mean discovering it after the benefit was
  // reserved; and merging quantities is a decision about what the customer is
  // buying, which is not this route's to make silently.
  const seen = new Set<string>();
  for (const line of requestLines) {
    const gid = normalizeShopifyVariantGid(line.shopifyVariantId);
    if (seen.has(gid)) {
      return badRequest(`variant ${line.shopifyVariantId} appears on more than one line`);
    }
    seen.add(gid);
  }

  const resolved = await resolveLines(requestLines);
  if (!resolved.ok) {
    // Refused rather than silently dropped: dropping a line would shrink the
    // eligible subtotal, and the discount with it.
    return Response.json({ error: "unpurchasable_lines", lines: resolved.unresolvable }, { status: 400 });
  }

  const redemptionLines: RedemptionLineInput[] = resolved.lines.map((line) => ({
    reference: line.shopifyVariantGid,
    quantity: line.quantity,
    unitPrice: line.unitPrice,
    ineligibleBecause: line.ineligibleBecause,
  }));

  const now = new Date();
  const reservation = await reserveBeatQuoteRedemption({
    benefitCode,
    // THE AUTHENTICATED CUSTOMER. Not a body field, and not negotiable.
    customerRef: customerGid,
    // Fixed, not taken from the request: this endpoint creates regular Buy Now
    // redemption orders and nothing else. Custom Jewelry redemption runs
    // against an approved project's own purchase, not through here.
    surface: "buy_now",
    lines: redemptionLines,
    // A FACT ABOUT WHAT WE BUILD, not a claim the client makes. The draft
    // order created below carries this benefit and no other discount, and is
    // created with `allowDiscountCodesInCheckout:false` so no code can be
    // added at checkout either. There is no promotion to stack with.
    otherPromotionApplied: false,
    stackingExpresslyAuthorized: false,
    now,
  });

  if (reservation.outcome === "refused") {
    // The log records which refusal it actually was, including the two the
    // response deliberately conflates.
    logger.info("beat_quote_redeem.refused", {
      refusal: reservation.refusal,
      customerGid,
      ...(reservation.detail ? { detail: reservation.detail } : {}),
    });
    return refused(reservation.refusal);
  }

  const intent = reservation.intent;
  const discount = Money.fromMinorUnits(intent.discountMinorUnits, intent.currency);

  let created;
  try {
    const port = await draftOrderPort();
    created = await port.createRedemptionDraftOrder({
      customerGid,
      email: email.toLowerCase(),
      shippingAddress,
      lineItems: resolved.lines.map((line) => ({
        shopifyVariantGid: line.shopifyVariantGid,
        quantity: line.quantity,
        unitPrice: line.unitPrice,
      })),
      discount,
      discountTitle: `Let Us Beat Your Quote — ${BEAT_QUOTE_FALLBACK_PERCENT}% off`,
      redemptionIntentId: intent.id,
      note: `Let Us Beat Your Quote fallback benefit ${benefitCode} (redemption ${intent.id})`,
      // THE TAG IS A LOOKUP HINT, NOT AN AUTHORISATION. `orders/paid` reads it
      // to find which intent might belong to the order, then asks Shopify
      // which order this intent's draft order actually became and refuses if
      // the two disagree — because any Shopify admin user can edit a tag. See
      // `beatQuoteRedemptionOrderHandler.server.ts`.
      tags: [`${BEAT_QUOTE_REDEMPTION_ORDER_TAG_PREFIX}${intent.id}`],
    });
  } catch (error) {
    // RELEASED, NOT LEFT RESERVED. A transient Shopify failure must not lock
    // the benefit until a human notices: the customer did not get a checkout,
    // so they must be able to try again. The release is recorded with the
    // reason, so a repeated failure is visible rather than invisible.
    const released = await releaseBeatQuoteRedemption({
      intentId: intent.id,
      reason: "checkout_failed",
      detail: error instanceof Error ? error.message : "unknown draft order failure",
      now: new Date(),
    });
    logger.error("beat_quote_redeem.draft_order_failed", {
      intentId: intent.id,
      released: released.released,
      error: error instanceof Error ? error.message : String(error),
    });
    return Response.json(
      {
        error: "checkout_unavailable",
        message: "We could not start your checkout. Your benefit has not been used — please try again.",
      },
      { status: 502 }
    );
  }

  // Write-once; the trigger refuses a change, so an intent cannot later be
  // re-pointed at a different checkout.
  await attachRedemptionDraftOrder({ intentId: intent.id, draftOrderGid: created.draftOrderGid });

  logger.info("beat_quote_redeem.reserved_checkout", {
    intentId: intent.id,
    customerGid,
    draftOrderGid: created.draftOrderGid,
    discountMinorUnits: intent.discountMinorUnits.toString(),
  });

  return Response.json(
    {
      redemptionId: intent.id,
      invoiceUrl: created.invoiceUrl,
      // Minor units as strings, never as JSON numbers — a money figure is not a
      // double. The storefront formats these; it does not compute with them.
      discountMinorUnits: intent.discountMinorUnits.toString(),
      eligibleSubtotalMinorUnits: intent.eligibleSubtotalMinorUnits.toString(),
      currency: intent.currency,
      // So the storefront can explain WHY the discount is smaller than 10% of
      // what the customer sees in their cart, rather than appearing to
      // shortchange them.
      excludedLines: resolved.lines
        .filter((line) => line.ineligibleBecause !== null)
        .map((line) => ({ shopifyVariantId: line.shopifyVariantGid, reason: line.ineligibleBecause })),
    },
    { status: 201, headers: { "Cache-Control": "private, no-store" } }
  );
}

/**
 * Exported for the refusal-coverage test only: it asserts that every
 * `FallbackRefusal` and every `ReserveRefusal` has customer-facing wording, so
 * adding a refusal to the domain cannot silently produce an `undefined`
 * message in a customer's browser.
 */
export const __refusalMessagesForTests: Record<FallbackRefusal | ReserveRefusal, string> = REFUSAL_MESSAGES;
