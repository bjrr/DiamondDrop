import { randomUUID } from "node:crypto";

import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { prisma } from "~/db/client.server";
import { getLatestPolicyVersion } from "~/db/repositories/policyVersionRepository.server";
import { idempotencyKeyRepository } from "~/db/repositories/idempotencyKeyRepository.server";
import { coalesceCheckoutLines, type RawCheckoutLine } from "~/domain/bankpayment/coalesceLines";
import {
  buildGroupBuyBankCheckoutResultDto,
  resolveGroupBuyFormattedAmountDue,
  toGroupBuyCustomerResponse,
  type GroupBuyBankCheckoutResultDto,
  type QuotedGroupBuyLineForResult,
} from "~/domain/bankpayment/groupBuyCheckoutResponseDto";
import { buildPaymentInstructionsView } from "~/domain/bankpayment/paymentInstructionsView";
import { computeGroupBuyBankCheckoutIdempotencyKey } from "~/domain/bankpayment/groupBuyCheckoutIdempotencyKey";
import { computeGroupBuyTierLinePrice, type GroupBuyTierPricingProfile } from "~/domain/bankpayment/groupBuyTierPrice";
import {
  groupBuyInitialPaymentDeadline,
  resolveGroupBuyPaymentWindowStart,
} from "~/domain/bankpayment/groupBuyPaymentWindow";
import { buildGroupBuyPaymentInstructionsEmail } from "~/domain/bankpayment/groupBuyPaymentInstructionsEmail";
import { normalizeShopifyVariantGid } from "~/domain/cart/shopifyVariantId";
import { resolveEmailPort } from "~/lib/email/configuredPort.server";
import {
  resolveBankPaymentCoordinates,
  type BankPaymentCoordinates,
} from "~/lib/payments/bankPaymentCoordinates.server";
import { minorUnitsToDecimalString } from "~/shopify/admin/priceSyncAdapter.server";
import { buildAcknowledgmentRecord } from "~/domain/evidence/acknowledgment";
import {
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_LINE_ITEM_PROPERTY_NAME,
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG,
} from "~/domain/groupbuy/cancellationAcknowledgmentText";
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
 *
 * ============================================================================
 * CANCELLATION ACKNOWLEDGMENT — OWNER-APPROVED 2026-09-27, WIRED IN
 * ============================================================================
 * `~/domain/groupbuy/cancellationAcknowledgmentText.ts` pins the owner's own
 * approved copy (README/owner-decisions cancellation and close rules). Same
 * evidence-not-checkbox discipline as `apps.carat.rma-intake.tsx`'s return
 * -policy acknowledgment: `cancellationAcknowledgmentAccepted` must be the
 * LITERAL boolean `true` (never a default, never inferred from absence), and
 * this route REFUSES the request server-side, fail closed, when it is
 * missing or false — the zod schema's `z.literal(true)` makes an absent/false
 * value a generic 400, exactly like RMA's `returnPolicyAcknowledgmentAccepted`.
 * The recorded `Acknowledgment` row (exact text, policy version, label,
 * timestamp, and the AUTHENTICATED `customerGid` — never a client-supplied
 * identity field) is created inside `performGroupBuyBankCheckout`'s own
 * transaction, in the SAME atomic write as the order/lines, and
 * `GroupBuyBankPaymentOrder.cancellationAcknowledgmentId` is a REQUIRED
 * (NOT NULL) FK to it — an order row cannot exist in Postgres without one,
 * matching `RmaRequest.returnPolicyAcknowledgmentId`'s own discipline. The
 * `503 acknowledgment_copy_pending_approval` branch below is a fail-closed
 * guard for a misprovisioned environment where the policy_version migration
 * has not run — kept, never deleted, same as RMA's identical guard — and is
 * checked BEFORE any Shopify Admin API call so a missing policy never results
 * in a live draft/real order with no acknowledgment behind it.
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
  // THE ONE required affirmative action (owner approval 2026-09-27). Must be
  // the LITERAL boolean `true` — never a default, never inferred from
  // absence, mirroring `returnPolicyAcknowledgmentAccepted` in the RMA
  // intake route. See this file's CANCELLATION ACKNOWLEDGMENT module comment.
  cancellationAcknowledgmentAccepted: z.literal(true),
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
  /**
   * The RESOLVED cancellation-policy `policy_version` row's own `id`/`text` —
   * resolved once in `action()`, before any Shopify call, so a missing
   * provisioning fails closed before a real order is ever created. See this
   * file's CANCELLATION ACKNOWLEDGMENT module comment.
   */
  cancellationPolicyVersion: { id: string; text: string };
  /**
   * Proven present BEFORE any Shopify call by the action-level gate. Passed
   * through rather than re-read so the coordinates that gated the order are
   * exactly the ones the customer is sent.
   */
  paymentCoordinates: BankPaymentCoordinates;
}): Promise<GroupBuyBankCheckoutResultDto> {
  // THE ACKNOWLEDGMENT ID IS MINTED BEFORE SHOPIFY IS CALLED, not after.
  //
  // The `orders/create` handler resolves a Group Buy line's acknowledgment
  // candidate from the `_carat_gb_cancel_ack` line-item property and from
  // NOTHING else — no database fallback keyed on the order, deliberately, so
  // that a reference is never mistaken for proof. The property therefore has
  // to be on the line at `draftOrderCreate` time, which is before the
  // transaction below (where the row used to be created, and where its id used
  // to first exist). Minting the id here and passing it explicitly to
  // `tx.acknowledgment.create` is what closes that ordering gap.
  //
  // WITHOUT THIS, every Bank Payment Group Buy order reached the webhook with
  // no property, verified as `no_candidate` -> `unmatched`, was HELD, and
  // recorded ZERO qualifying units — silently breaking the locked rule that a
  // placed Group Buy order counts toward public progress immediately,
  // INCLUDING pending Bank Payment orders.
  //
  // SERVER-GENERATED, and that distinction matters: unlike
  // `apps.carat.warranty-claim.tsx`'s claim id (supplied by the client, safe
  // only because primary-key uniqueness forces it to be a brand-new row),
  // nothing outside this function ever proposes this value, so there is no
  // caller-controlled identifier to reason about at all.
  //
  // FAILS CLOSED. If the transaction below never commits, the completed
  // Shopify order carries a property pointing at an acknowledgment row that
  // does not exist; `getAcknowledgmentById` returns null, the line verifies as
  // `unmatched`, and it is held at zero units — the safe direction, and the
  // same outcome as the bug this replaces, but only in the failure case.
  const cancellationAcknowledgmentId = randomUUID();

  const lineItems: DraftOrderLineItemInput[] = input.quotedLines.map((line) => ({
    shopifyVariantGid: line.shopifyVariantGid,
    quantity: line.quantity,
    unitPrice: Money.fromMinorUnits(line.quotedBankPaymentPriceMinorUnits, line.currency),
    customAttributes: [
      {
        key: GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_LINE_ITEM_PROPERTY_NAME,
        value: cancellationAcknowledgmentId,
      },
    ],
  }));

  const created = await input.draftOrderPort.createDraftOrder({
    // THE AUTHENTICATED CUSTOMER, not whoever Shopify would match from the
    // email. Without this the order is attached to an email-derived customer
    // record, the `orders/create` handler compares THAT against the
    // acknowledgment's authenticated customer, finds `customer_mismatch`, and
    // counts ZERO units — while the order also fails to appear in the
    // customer's own account. Found by the Slice 6 live gate, which is the
    // only place the two customer records could be seen to differ.
    customerGid: input.customerGid,
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

  // ATOMIC: the acknowledgment, the header and every line are written
  // together, or none is — a real, already-completed Shopify order with no
  // matching local record (or one with no recorded acknowledgment behind
  // it) is not a state anything downstream could reason about. This is the
  // ONLY place this route ever calls `tx.acknowledgment.create` — exactly
  // once per idempotency key, since `executeIdempotent` never re-invokes
  // this function for a retried request (see its own doc comment).
  const groupBuyBankPaymentOrder = await prisma.$transaction(async (tx) => {
    const cancellationAcknowledgment = await tx.acknowledgment.create({
      data: {
        // The id already sent to Shopify on every line above. Passed
        // explicitly rather than defaulted so the property the webhook reads
        // and the row it looks up cannot drift apart.
        id: cancellationAcknowledgmentId,
        ...buildAcknowledgmentRecord({
        exactText: input.cancellationPolicyVersion.text,
        policyVersionId: input.cancellationPolicyVersion.id,
        acknowledgedAt: quotedAt,
        affirmativeActionLabel: GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
        // THE AUTHENTICATED identity (docs/REQUIRED-CUSTOMER-ACCOUNTS.md) —
        // never a client-supplied field.
          customerRef: input.customerGid,
          campaignRef: input.campaignCode,
        }),
      },
    });

    const order = await tx.groupBuyBankPaymentOrder.create({
      data: {
        campaignId: input.campaignId,
        shopifyDraftOrderGid: created.draftOrderGid,
        shopifyOrderGid: completed.orderGid,
        customerEmail: input.resolvedEmail,
        customerGid: input.customerGid,
        tierNumberAtQuote: input.tierNumber,
        quotedAt,
        cancellationAcknowledgmentId: cancellationAcknowledgment.id,
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

  /**
   * THE AMOUNT DUE, COMPUTED ONCE (register D12).
   *
   * BIGINT THROUGHOUT. Quantity is multiplied into the unit price in minor
   * units and summed; the decimal string is produced once, at the end, by
   * the same helper the Shopify price path uses. No float ever touches this.
   *
   * HOISTED OUT OF THE EMAIL BRANCH DELIBERATELY. It used to be computed
   * inside the `if (emailResolution.configured)` block, which was correct
   * while email was the only surface that stated an amount. Email is now the
   * SECONDARY channel: the on-screen confirmation and the durable orders
   * page both state this figure too, and they must state the same one. If
   * this stayed inside that branch, an unconfigured mail provider would
   * silently leave the customer's screen without an amount — the exact
   * email dependency D12 exists to remove.
   *
   * EVERY LINE IS CHARGED AT ITS BANK PAYMENT PRICE. Unlike Buy Now there is
   * no per-line eligibility flag to honour here: the whole order is one
   * payment basis, chosen at placement.
   */
  const totalDueMinorUnits = input.quotedLines.reduce(
    (sum, line) => sum + line.quotedBankPaymentPriceMinorUnits * BigInt(line.quantity),
    0n
  );
  const formattedAmountDue = minorUnitsToDecimalString(totalDueMinorUnits);
  const amountCurrency = input.quotedLines[0]!.currency;

  // PAYMENT INSTRUCTIONS — the email, now the SECONDARY channel (§1.5).
  //
  // Coordinates were already proven present before any Shopify call, so this
  // cannot produce a partial email; the resolution is passed in rather than
  // re-read so the check that gated the order and the values that reach the
  // customer are the same ones.
  //
  // THE DEADLINE IS NOT COMPUTED HERE. It comes from the same
  // `groupBuyPaymentWindow` module the inactivation sweep uses, applied to
  // this order's own window start, so the email cannot promise a different
  // deadline from the one that will actually be enforced.
  //
  // A send failure does NOT undo the order: the order is committed, its units
  // count, and the price is locked. It is logged at error so staff can send
  // instructions by hand — losing the order because the mail provider is down
  // would be far worse than an order whose instructions arrive late.
  try {
    const emailResolution = resolveEmailPort();
    if (!emailResolution.configured) {
      logger.error("group_buy_bank_checkout.instructions_email_unconfigured", {
        groupBuyBankPaymentOrderId: groupBuyBankPaymentOrder.id,
        reason: emailResolution.reason,
      });
    } else {
      // The SAME figure the on-screen confirmation and the orders page
      // state — computed once above, never recomputed per surface.
      const content = buildGroupBuyPaymentInstructionsEmail({
        bankPaymentOrderId: groupBuyBankPaymentOrder.id,
        campaignCode: input.campaignCode,
        formattedAmountDue: `${formattedAmountDue} ${amountCurrency}`,
        // THE 48-HOUR CUSTOMER DEADLINE, not the 96-hour inactivation instant.
        // The email states "You have 48 hours to send payment" immediately
        // below this date; printing the 96-hour value there told the customer
        // two different things at once — a date four days out under the words
        // "48 hours". The extension is described in prose, never folded
        // silently into the number. Caught by the production configuration
        // gate, which is the only place the two could be compared.
        paymentDeadline: groupBuyInitialPaymentDeadline(
          resolveGroupBuyPaymentWindowStart(groupBuyBankPaymentOrder)
        ),
        coordinates: input.paymentCoordinates,
      });
      await emailResolution.port.send({
        from: emailResolution.from,
        to: [input.resolvedEmail],
        subject: content.subject,
        text: content.text,
      });
      // NOTHING ABOUT THE COORDINATES IS LOGGED — not which method, not a
      // masked tail. Only that instructions went out, and for which order.
      logger.info("group_buy_bank_checkout.instructions_email_sent", {
        groupBuyBankPaymentOrderId: groupBuyBankPaymentOrder.id,
      });
    }
  } catch (error) {
    logger.error("group_buy_bank_checkout.instructions_email_failed", {
      groupBuyBankPaymentOrderId: groupBuyBankPaymentOrder.id,
      errorName: error instanceof Error ? error.name : "unknown",
    });
  }

  return buildGroupBuyBankCheckoutResultDto({
    groupBuyBankPaymentOrderId: groupBuyBankPaymentOrder.id,
    campaignId: input.campaignId,
    campaignCode: input.campaignCode,
    draftOrderGid: created.draftOrderGid,
    shopifyOrderGid: completed.orderGid,
    tierNumber: input.tierNumber,
    quotedAt,
    formattedAmountDue,
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

  // --- CANCELLATION ACKNOWLEDGMENT — resolved BEFORE any campaign/Shopify
  // work, same "fail closed before touching Shopify" ordering as RMA's own
  // acknowledgment gate. `cancellationAcknowledgmentAccepted` was already
  // required to be the literal `true` by the schema above; this is the
  // separate, independent check that the POLICY ITSELF is actually
  // provisioned in this environment. See this file's CANCELLATION
  // ACKNOWLEDGMENT module comment. ---
  const cancellationPolicyVersion = await getLatestPolicyVersion(GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG);
  if (!cancellationPolicyVersion) {
    logger.error("group_buy_bank_checkout.acknowledgment_copy_pending_approval", {});
    return Response.json({ error: "acknowledgment_copy_pending_approval" }, { status: 503 });
  }

  // --- PAYMENT COORDINATES MUST EXIST BEFORE ANY ORDER DOES. ---
  //
  // Checked HERE, before Shopify is touched, and not at send time. The whole
  // point of this route is to produce an order the customer then PAYS for; if
  // we cannot tell them where to send money, creating the order first would
  // leave a real Shopify order, a real counted unit and a customer with no way
  // to pay and no idea why. Failing before anything exists is the only honest
  // order of operations — the same reasoning as the acknowledgment-copy gate
  // immediately above.
  //
  // The reason string names MISSING VARIABLES only, never a coordinate value;
  // the response carries no detail at all, because a customer cannot act on
  // our configuration problem and an attacker should not learn our state from
  // it. (`resolveBankPaymentCoordinates`' own header explains why those are
  // two separate rules.)
  const paymentCoordinates = resolveBankPaymentCoordinates();
  if (!paymentCoordinates.configured) {
    logger.error("group_buy_bank_checkout.payment_coordinates_unconfigured", {
      reason: paymentCoordinates.reason,
    });
    return Response.json({ error: "checkout_unavailable" }, { status: 503 });
  }

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
          cancellationPolicyVersion: { id: cancellationPolicyVersion.id, text: cancellationPolicyVersion.text },
          paymentCoordinates: paymentCoordinates.coordinates,
        })
    );
    /**
     * THE CUSTOMER ENVELOPE, COMPOSED AFTER THE IDEMPOTENT TRANSACTION
     * (register D12).
     *
     * Deliberately NOT inside `performGroupBuyBankCheckout`. Whatever that
     * function returns is what `executeIdempotent` WRITES TO POSTGRES as
     * `resultPayload`, and these instructions carry bank coordinates —
     * `bankPaymentCoordinates.server.ts` says "NOT PERSISTED, EVER". Composing
     * here means a replay re-reads the coordinates from configuration rather
     * than from a stored copy, which is also why rotating them is safe for
     * the mechanism and unsafe for OPEN ORDERS (see this route's operations
     * note in docs/LAUNCH-BLOCKER-REGISTER.md).
     *
     * `result` was previously returned raw, exposing `draftOrderGid` and
     * `shopifyOrderGid` to the browser. Those are live handles to a real
     * unpaid order; the customer has the only reference that matters.
     */
    const resolvedAmountDue = resolveGroupBuyFormattedAmountDue(result);
    if (resolvedAmountDue === null) {
      // An old payload whose lines cannot produce an amount. Fail closed
      // rather than render a panel with a blank figure next to a bank
      // account number — the order exists and staff can see it.
      logger.error("group_buy_bank_checkout.replay_response_unbuildable", {
        groupBuyBankPaymentOrderId: result.groupBuyBankPaymentOrderId,
      });
      return Response.json({ error: "checkout_unavailable" }, { status: 503 });
    }

    const instructions = buildPaymentInstructionsView({
      flow: "group_buy",
      reference: result.groupBuyBankPaymentOrderId,
      formattedAmountDue: resolvedAmountDue,
      currency: result.lines[0]?.currency ?? quotedLines[0]!.currency,
      // The 48-HOUR customer deadline the result already carries — not the
      // 96-hour inactivation instant. See `paymentDueBy`'s own comment.
      paymentDeadline: new Date(result.paymentDueBy),
      coordinates: paymentCoordinates.coordinates,
    });

    return Response.json(toGroupBuyCustomerResponse(result, instructions), { status: 200 });
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
