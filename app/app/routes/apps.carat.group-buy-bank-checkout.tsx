import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { prisma } from "~/db/client.server";
import { idempotencyKeyRepository } from "~/db/repositories/idempotencyKeyRepository.server";
import { coalesceCheckoutLines, type RawCheckoutLine } from "~/domain/bankpayment/coalesceLines";
import {
  buildGroupBuyBankCheckoutResultDto,
  type GroupBuyBankCheckoutResultDto,
  type QuotedGroupBuyLineForResult,
} from "~/domain/bankpayment/groupBuyCheckoutResponseDto";
import { computeGroupBuyBankCheckoutIdempotencyKey } from "~/domain/bankpayment/groupBuyCheckoutIdempotencyKey";
import { computeGroupBuyTierLinePrice, type GroupBuyTierPricingProfile } from "~/domain/bankpayment/groupBuyTierPrice";
import { normalizeShopifyVariantGid } from "~/domain/cart/shopifyVariantId";
import {
  executeIdempotent,
  IdempotentOperationFailedError,
  InDoubtIdempotencyError,
} from "~/domain/idempotency";
import { Money } from "~/domain/money/money";
import type { RoundingRuleId } from "~/domain/money/rounding";
import type { PriceEndingRuleId, RegularCardPriceRuleId } from "~/domain/pricing/types";
import { getCurrentTier } from "~/jobs/groupbuy/unitLedger.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import type {
  DraftOrderLineItemInput,
  DraftOrderPort,
  DraftOrderShippingAddressInput,
} from "~/shopify/admin/draftOrderAdapter.server";
import { ShopifyDraftOrderAdapter } from "~/shopify/admin/draftOrderAdapter.server";
import { AdminApiError } from "~/shopify/admin/productClient.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * POST /apps/carat/group-buy-bank-checkout — Group Buy Bank Payment
 * ordering (docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md §14, §24;
 * docs/ARCHITECTURE-MVP1.md §6.1/§6.2; README "Group Buy — Locked MVP1
 * Direction").
 *
 * THE GAP THIS CLOSES. Group Buy uses NATIVE Shopify checkout with the
 * variant price set to the current tier's Regular/Card Price
 * (`~/jobs/groupbuy/tierPriceSync.server.ts`) — native checkout cannot
 * switch price by payment method, so a customer choosing Bank Payment has no
 * path to the lower Bank Payment Price. Owner §14: "do not silently fake a
 * checkout price switch that Shopify cannot honor." This route is the real
 * mechanism: a server-created, server-priced Shopify order, mirroring the
 * proven Buy Now Bank Payment shape (`apps.carat.bank-checkout.tsx`) as a
 * SEPARATE path — see that route's own header comment for why criterion 76
 * (Buy Now and Group Buy must never share one cart/order) means this file
 * must not extend it, and it must not extend this one.
 *
 * A RESOURCE ROUTE — no default export. `allowedActionOrigins` is
 * unconditionally `[]` in every production build, so a default export here
 * would 400 every legitimate storefront caller before validation runs (see
 * `csrfResourceRouteFence.test.ts`).
 *
 * WHY THIS ROUTE COMPLETES THE ORDER IMMEDIATELY, UNLIKE BUY NOW. Owner §24:
 * "A Group Buy Bank Payment order counts toward campaign units immediately
 * when the order is placed, even before funds clear." Counting happens when
 * `groupBuyOrderHandler.server.ts`'s `orders/create` webhook sees a REAL
 * Shopify order, and a draft order alone is not one. Buy Now's
 * `BankPaymentOrder` withholds `draftOrderComplete` until an admin manually
 * verifies payment (§22: "inventory is not reserved until manual admin
 * verification"); that rule is Buy Now's, not Group Buy's, and applying it
 * here would silently break immediate participation counting. So this route
 * calls `completeDraftOrder` (the SAME method Buy Now's verification screen
 * calls later) in the same request that creates the draft — no change to
 * `~/shopify/admin/draftOrderAdapter.server.ts` was needed or made.
 * `completeDraftOrder` attaches no payment gateway, so the resulting order is
 * UNPAID (`displayFinancialStatus: PENDING`) exactly as it is for Buy Now —
 * nothing here asserts a receipt nobody has seen.
 *
 * PRICE COMES FROM THE FROZEN CAMPAIGN SNAPSHOT AND THE LIVE CURRENT TIER,
 * NEVER FROM `getPublishedVariantPrice`. That resolver serves ordinary Buy
 * Now pricing and deliberately excludes any variant belonging to an OPEN
 * Group Buy campaign (`OpenCampaignExclusionSource`,
 * `~/jobs/pricing/ports.ts`) — using it here would silently read nothing, or
 * worse, a stale pre-campaign Buy Now price. `getCurrentTier` (the same
 * resolver `tierPriceSync.server.ts` uses to publish the Shopify variant
 * price) and `computeGroupBuyTierLinePrice` (the same
 * bank-in/round/end/card-derive pipeline `tierPriceSync.server.ts` and
 * `groupBuyRepository.server.ts`'s settlement code each already use) are
 * called, never restated.
 *
 * THE ORDER'S PRICE IS LOCKED AT PLACEMENT, PERMANENTLY (owner §21/§24:
 * "customers pay the price shown when they join"). If the campaign later
 * reaches a better tier, THIS order is not repriced or refunded here — that
 * is campaign-close settlement's job (`GroupBuyRefund`, computed once the
 * final tier locks). This route's only correctness obligation is to charge
 * and record whatever the CURRENT tier is at the moment of the call.
 *
 * WHAT THIS ROUTE DOES NOT SEND. Unlike Buy Now's bank-checkout, this route
 * never calls `sendInvoice`. Buy Now's invoice email carries the owner
 * -approved "not committed" disclosure (`notCommittedDisclosure.ts`), and
 * that copy is FACTUALLY WRONG for Group Buy (it says a 24-hour guarantee
 * and "does not complete your order"; a Group Buy Bank Payment order has a
 * 48h+48h window and DOES complete into a real, participation-counting
 * order immediately). No owner-approved Group Buy equivalent exists yet.
 * Inventing that copy here would repeat the exact mistake this codebase's
 * own discipline elsewhere refuses to make ("nothing here invents customer
 * -facing wording" — see `apps.carat.bank-checkout.tsx`'s own module
 * comment). Flagged for owner/architect copy approval; the response DTO
 * carries `paymentDueBy` so whatever surface is built next (confirmation
 * page or a follow-up email job) has the figure it needs without
 * recomputing it.
 *
 * WHAT THIS ROUTE DOES NOT OWN. Reactivation after 96-hour inactivation
 * (`groupBuyBankPaymentReactivation.server.ts`) and the inactivation sweep
 * (`~/jobs/bankpayment/groupBuyBankPaymentInactivationSweep.server.ts`) are
 * separate modules — this route's job is placing the order correctly, not
 * its lifecycle afterward.
 */

const MAX_REQUEST_LINES = 100;
/**
 * Must move together with `MAX_VERIFIABLE_LINE_ITEMS` in
 * `~/shopify/admin/draftOrderAdapter.server.ts` (private there — restated
 * here for the identical reason `apps.carat.bank-checkout.tsx` restates its
 * own copy): checked here, BEFORE the adapter is ever called, so a request
 * that would fail the adapter's own guard is refused with a clear reason.
 */
const MAX_VERIFIABLE_LINE_ITEMS = 50;
const MAX_QUANTITY_PER_LINE = 9_999;

const checkoutLineRequestSchema = z.object({
  shopifyVariantId: z.string().min(1).max(200),
  quantity: z.number().int().positive().max(MAX_QUANTITY_PER_LINE),
});

const shippingAddressRequestSchema = z.object({
  firstName: z.string().min(1).max(200).optional(),
  lastName: z.string().min(1).max(200).optional(),
  address1: z.string().min(1).max(500),
  address2: z.string().min(1).max(500).optional(),
  city: z.string().min(1).max(200),
  provinceCode: z.string().min(1).max(10).optional(),
  zip: z.string().min(1).max(20),
  countryCode: z.string().length(2),
  phone: z.string().min(1).max(50).optional(),
}) satisfies z.ZodType<DraftOrderShippingAddressInput>;

const groupBuyBankCheckoutRequestSchema = z.object({
  // A literal, not an enum — same defensive backstop
  // `apps.carat.bank-checkout.tsx` uses: this endpoint creates ONLY Group Buy
  // Bank Payment orders, and requiring the caller to assert it guards
  // against a theme bug routing a Card-mode Group Buy cart here.
  mode: z.literal("bank"),
  campaignCode: z.string().min(1).max(200),
  email: z.string().trim().email().max(320),
  shippingAddress: shippingAddressRequestSchema,
  lines: z.array(checkoutLineRequestSchema).min(1).max(MAX_REQUEST_LINES),
});

function badRequest(reason: string) {
  return Response.json({ error: "invalid_request", reason }, { status: 400 });
}

function unpurchasableLines(lines: readonly { shopifyVariantId: string; reason: "unknown_variant" }[]) {
  return Response.json({ error: "unpurchasable_lines", lines }, { status: 400 });
}

function campaignNotOpen() {
  return Response.json({ error: "campaign_not_open" }, { status: 400 });
}

function notGroupBuyVariant(shopifyVariantIds: readonly string[]) {
  return Response.json({ error: "not_group_buy_variant", shopifyVariantIds }, { status: 400 });
}

/**
 * `gid://shopify/Customer/<id>` from the App Proxy's `logged_in_customer_id`.
 * Mirrors `apps.carat.bank-checkout.tsx`'s identically-named helper — the
 * caller below never passes a null/absent id past the authentication gate.
 */
function normalizeCustomerGid(rawId: string): string {
  return rawId.startsWith("gid://") ? rawId : `gid://shopify/Customer/${rawId}`;
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

/**
 * Shopify order tags are short and staff-facing — same truncation scheme as
 * `apps.carat.bank-checkout.tsx`'s `draftOrderCorrelationTag`, restated
 * (not imported — that file is a separate, frozen checkout path) with a
 * distinct prefix so a support search can tell the two flows apart at a
 * glance.
 */
export function groupBuyDraftOrderCorrelationTag(idempotencyKey: string): string {
  const hex = idempotencyKey.slice(idempotencyKey.indexOf(":") + 1);
  return `carat-gb-idem-${hex.slice(0, 24)}`;
}

interface QuotedGroupBuyCheckoutLine extends QuotedGroupBuyLineForResult {
  readonly masterVariantId: string;
}

/**
 * The idempotent operation itself: create the draft order, complete it into
 * a real (unpaid) Shopify order, then persist `GroupBuyBankPaymentOrder` +
 * `GroupBuyBankPaymentOrderLine` in one transaction. Returns the fully
 * JSON-safe result DTO that `executeIdempotent` stores as `resultPayload`
 * and a replay returns verbatim.
 */
async function performGroupBuyBankCheckout(input: {
  draftOrderPort: DraftOrderPort;
  resolvedEmail: string;
  /** THE AUTHORIZATION BASIS (docs/REQUIRED-CUSTOMER-ACCOUNTS.md). */
  customerGid: string;
  shippingAddress: DraftOrderShippingAddressInput;
  campaignId: string;
  campaignCode: string;
  tierNumber: number;
  quotedLines: readonly QuotedGroupBuyCheckoutLine[];
  idempotencyKey: string;
}): Promise<GroupBuyBankCheckoutResultDto> {
  const lineItems: DraftOrderLineItemInput[] = input.quotedLines.map((line) => ({
    shopifyVariantGid: line.shopifyVariantGid,
    quantity: line.quantity,
    unitPrice: Money.fromMinorUnits(line.quotedBankPaymentPriceMinorUnits, line.currency),
  }));

  const created = await input.draftOrderPort.createDraftOrder({
    email: input.resolvedEmail,
    shippingAddress: input.shippingAddress,
    lineItems,
    // Staff-facing only (never cost/margin data) — lets an admin looking at
    // the Shopify order understand which campaign/tier produced it without
    // cross-referencing our own database first.
    note: `Group Buy campaign ${input.campaignCode} — tier ${input.tierNumber} (Bank Payment)`,
    // THE TAG IS WHAT MAKES AN `in_doubt` KEY RESOLVABLE BY HAND if
    // `completeDraftOrder` below fails after `createDraftOrder` already
    // succeeded — identical reasoning to `apps.carat.bank-checkout.tsx`'s
    // own tag.
    tags: [groupBuyDraftOrderCorrelationTag(input.idempotencyKey)],
  });

  // Completed in the SAME request — see this route's own module comment for
  // why Group Buy cannot wait for manual admin verification the way Buy Now
  // does. No payment gateway is attached, so the resulting order is UNPAID.
  const completed = await input.draftOrderPort.completeDraftOrder({
    draftOrderGid: created.draftOrderGid,
  });

  const quotedAt = new Date();

  // ATOMIC: either both the header and every line are written, or neither
  // is — a real, already-completed Shopify order with no matching local
  // record (or a partial one) is not a state anything downstream could
  // reason about.
  const groupBuyBankPaymentOrder = await prisma.$transaction(async (tx) => {
    const order = await tx.groupBuyBankPaymentOrder.create({
      data: {
        campaignId: input.campaignId,
        shopifyDraftOrderGid: created.draftOrderGid,
        shopifyOrderGid: completed.orderGid,
        customerEmail: input.resolvedEmail,
        customerGid: input.customerGid,
        tierNumberAtQuote: input.tierNumber,
        quotedAt,
      },
    });

    await tx.groupBuyBankPaymentOrderLine.createMany({
      data: input.quotedLines.map((line) => ({
        groupBuyBankPaymentOrderId: order.id,
        masterVariantId: line.masterVariantId,
        quantity: line.quantity,
        quotedBankPaymentPriceMinorUnits: line.quotedBankPaymentPriceMinorUnits,
        quotedRegularCardPriceMinorUnits: line.quotedRegularCardPriceMinorUnits,
        currency: line.currency,
      })),
    });

    return order;
  });

  logger.info("group_buy_bank_checkout.completed", {
    groupBuyBankPaymentOrderId: groupBuyBankPaymentOrder.id,
    campaignId: input.campaignId,
    tierNumber: input.tierNumber,
    lineCount: input.quotedLines.length,
  });

  return buildGroupBuyBankCheckoutResultDto({
    groupBuyBankPaymentOrderId: groupBuyBankPaymentOrder.id,
    campaignId: input.campaignId,
    campaignCode: input.campaignCode,
    draftOrderGid: created.draftOrderGid,
    shopifyOrderGid: completed.orderGid,
    tierNumber: input.tierNumber,
    quotedAt,
    lines: input.quotedLines,
  });
}

/**
 * TEST-ONLY OVERRIDE HOOK — mirrors `apps.carat.bank-checkout.tsx`'s
 * identically-named export. Production code never sets this.
 */
let draftOrderPortOverrideForTests: DraftOrderPort | null = null;
export function __setDraftOrderPortForTests(port: DraftOrderPort | null): void {
  draftOrderPortOverrideForTests = port;
}

/**
 * Obtains the real, offline-session-backed `DraftOrderPort` for THE shop.
 * `~/shopify.server` is imported dynamically, and only from inside this
 * function, for the same reason `apps.carat.bank-checkout.tsx` does —
 * importing it at module scope would require Shopify OAuth to be configured
 * merely to LOAD this route file.
 */
async function createDraftOrderPort(): Promise<DraftOrderPort> {
  if (draftOrderPortOverrideForTests) return draftOrderPortOverrideForTests;

  const { SHOPIFY_SHOP_DOMAIN } = getEnv();
  if (!SHOPIFY_SHOP_DOMAIN) {
    throw new Error(
      "SHOPIFY_SHOP_DOMAIN is not configured; Group Buy Bank Payment Checkout cannot reach the Shopify Admin API."
    );
  }

  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOPIFY_SHOP_DOMAIN);
  return new ShopifyDraftOrderAdapter(admin);
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const { verified, loggedInCustomerId } = verifyAppProxySignature(url.searchParams, getEnv().SHOPIFY_API_SECRET);
  if (!verified) {
    logger.warn("group_buy_bank_checkout.proxy_rejected", { reason: "invalid_or_missing_signature" });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // docs/REQUIRED-CUSTOMER-ACCOUNTS.md §4 — checked BEFORE the body is even
  // parsed, same discipline as `apps.carat.bank-checkout.tsx`.
  if (!loggedInCustomerId) {
    logger.warn("group_buy_bank_checkout.anonymous_rejected", {});
    return authenticationRequired();
  }
  const customerGid = normalizeCustomerGid(loggedInCustomerId);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("body is not valid JSON");
  }

  const parsed = groupBuyBankCheckoutRequestSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest("body does not match the group buy bank checkout request contract");
  }
  const { campaignCode, lines: requestLines, shippingAddress } = parsed.data;
  const resolvedEmail = parsed.data.email.toLowerCase();

  // --- Resolve the campaign FIRST: every downstream check (eligibility,
  // pricing) is scoped to it, and a request naming an unknown/non-open
  // campaign has nothing legitimate to check lines against. ---
  const campaign = await prisma.groupBuyCampaign.findUnique({
    where: { code: campaignCode },
    include: { variants: true, pricingProfile: true },
  });
  if (!campaign || campaign.status !== "open") {
    logger.warn("group_buy_bank_checkout.campaign_not_open", { campaignCode });
    return campaignNotOpen();
  }
  if (!campaign.pricingProfile) {
    // Should be impossible for a campaign that reached `open` — opening
    // always freezes a profile in the same transaction — but a defensive,
    // named failure beats a null-pointer deep in the pricing pipeline below.
    logger.error("group_buy_bank_checkout.campaign_missing_frozen_profile", { campaignId: campaign.id });
    return Response.json({ error: "pricing_failed" }, { status: 500 });
  }

  // --- Resolve every requested Shopify variant id to a master_variant row. ---
  const requestedGids = requestLines.map((line) => normalizeShopifyVariantGid(line.shopifyVariantId));
  const variants = await prisma.masterVariant.findMany({
    where: { shopifyVariantGid: { in: requestedGids } },
    select: { id: true, shopifyVariantGid: true },
  });
  const variantByGid = new Map(variants.map((v) => [v.shopifyVariantGid as string, v]));

  const unknownGids = new Set<string>();
  const rawLines: RawCheckoutLine[] = [];
  for (const line of requestLines) {
    const gid = normalizeShopifyVariantGid(line.shopifyVariantId);
    const variant = variantByGid.get(gid);
    if (!variant) {
      unknownGids.add(gid);
      continue;
    }
    rawLines.push({ masterVariantId: variant.id, shopifyVariantGid: gid, quantity: line.quantity });
  }
  if (unknownGids.size > 0) {
    return unpurchasableLines([...unknownGids].map((gid) => ({ shopifyVariantId: gid, reason: "unknown_variant" as const })));
  }

  // --- THE MIRROR OF CRITERION 76: refuse anything that is NOT a Group Buy
  // variant of THIS OPEN campaign, server-side, even if the theme only ever
  // offers eligible variants. This is the same boundary
  // `apps.carat.bank-checkout.tsx`'s `findGroupBuyVariantIds` enforces in
  // reverse — that route refuses a variant found here; this route requires
  // it. ---
  const campaignVariantByMasterVariantId = new Map(campaign.variants.map((v) => [v.masterVariantId, v]));
  const resolvedMasterVariantIds = [...new Set(rawLines.map((l) => l.masterVariantId))];
  const ineligibleVariantIds = resolvedMasterVariantIds.filter((id) => !campaignVariantByMasterVariantId.has(id));
  if (ineligibleVariantIds.length > 0) {
    const offendingGids = [
      ...new Set(rawLines.filter((l) => ineligibleVariantIds.includes(l.masterVariantId)).map((l) => l.shopifyVariantGid)),
    ];
    logger.warn("group_buy_bank_checkout.non_group_buy_variant_rejected", {
      campaignId: campaign.id,
      count: offendingGids.length,
    });
    return notGroupBuyVariant(offendingGids);
  }

  // --- Coalesce duplicate variants into one line with a summed quantity
  // BEFORE the adapter is ever reached (identical reasoning to Buy Now's
  // bank-checkout — the adapter refuses a repeated variant by design). ---
  const coalescedLines = coalesceCheckoutLines(rawLines);

  if (coalescedLines.length > MAX_VERIFIABLE_LINE_ITEMS) {
    return badRequest(
      `cannot process more than ${MAX_VERIFIABLE_LINE_ITEMS} distinct line items; received ${coalescedLines.length}`
    );
  }

  // --- Price every line from the FROZEN base at the campaign's CURRENT
  // tier — never from `getPublishedVariantPrice` (see this route's own
  // module comment). ---
  const { tier } = await getCurrentTier(campaign.id);
  const pricingProfile: GroupBuyTierPricingProfile = {
    roundingRuleId: campaign.pricingProfile.roundingRuleId as RoundingRuleId,
    priceEndingRuleId: campaign.pricingProfile.priceEndingRuleId as PriceEndingRuleId,
    regularCardPriceRuleId: campaign.pricingProfile.regularCardPriceRuleId as RegularCardPriceRuleId,
    fixedCardUpliftRate: campaign.pricingProfile.fixedCardUpliftRate.toString(),
  };

  const quotedLines: QuotedGroupBuyCheckoutLine[] = coalescedLines.map((line) => {
    const campaignVariant = campaignVariantByMasterVariantId.get(line.masterVariantId)!;
    const price = computeGroupBuyTierLinePrice(
      campaignVariant.frozenBaseBankPaymentPriceMinorUnits,
      tier,
      pricingProfile,
      campaign.currency
    );
    return {
      masterVariantId: line.masterVariantId,
      shopifyVariantGid: line.shopifyVariantGid,
      quantity: line.quantity,
      currency: campaign.currency,
      quotedBankPaymentPriceMinorUnits: price.bankPaymentPriceMinorUnits,
      quotedRegularCardPriceMinorUnits: price.regularCardPriceMinorUnits,
    };
  });

  // --- Idempotency key, committed BEFORE the Admin API call. ---
  const idempotencyKey = computeGroupBuyBankCheckoutIdempotencyKey(
    customerGid,
    campaign.id,
    quotedLines.map((line) => ({
      shopifyVariantGid: line.shopifyVariantGid,
      quantity: line.quantity,
      unitPriceMinorUnits: line.quotedBankPaymentPriceMinorUnits.toString(),
      currency: line.currency,
    }))
  );

  let draftOrderPort: DraftOrderPort;
  try {
    draftOrderPort = await createDraftOrderPort();
  } catch (error) {
    logger.error("group_buy_bank_checkout.shopify_unavailable", {
      message: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ error: "checkout_unavailable" }, { status: 503 });
  }

  try {
    const result = await executeIdempotent(
      idempotencyKeyRepository,
      idempotencyKey,
      "group_buy_bank_payment_checkout",
      // Audit payload for the idempotency row — counts and identities only,
      // never a price/cost/margin figure beyond what the customer is
      // already being quoted, and never the shipping address.
      { resolvedEmail, customerGid, campaignId: campaign.id, tierNumber: tier.tierNumber, lineCount: quotedLines.length },
      () =>
        performGroupBuyBankCheckout({
          draftOrderPort,
          resolvedEmail,
          customerGid,
          shippingAddress,
          campaignId: campaign.id,
          campaignCode: campaign.code,
          tierNumber: tier.tierNumber,
          quotedLines,
          idempotencyKey,
        })
    );
    return Response.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof InDoubtIdempotencyError) {
      logger.warn("group_buy_bank_checkout.idempotency_in_doubt", { key: idempotencyKey });
      return Response.json(
        { error: "checkout_unresolved", reason: "A previous attempt for this order is still being resolved." },
        { status: 409 }
      );
    }
    if (error instanceof IdempotentOperationFailedError) {
      logger.warn("group_buy_bank_checkout.idempotency_failed_previously", { key: idempotencyKey });
      return Response.json(
        { error: "checkout_failed_previously", reason: "A previous attempt for this order did not succeed." },
        { status: 409 }
      );
    }
    if (error instanceof AdminApiError) {
      logger.error("group_buy_bank_checkout.shopify_admin_api_failed", {
        operation: error.operation,
        problems: error.problems,
      });
      return Response.json(
        { error: "checkout_upstream_failed", reason: "Shopify was unable to create the order." },
        { status: 502 }
      );
    }
    throw error;
  }
}
