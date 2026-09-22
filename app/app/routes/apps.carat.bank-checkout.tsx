import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { prisma } from "~/db/client.server";
import { idempotencyKeyRepository } from "~/db/repositories/idempotencyKeyRepository.server";
import { getPublishedVariantPrice } from "~/db/repositories/publishedPriceRepository.server";
import { coalesceCheckoutLines, type RawCheckoutLine } from "~/domain/bankpayment/coalesceLines";
import {
  buildBankCheckoutResultDto,
  type BankCheckoutResultDto,
  type QuotedLineForResult,
} from "~/domain/bankpayment/checkoutResponseDto";
import { computeBankCheckoutIdempotencyKey } from "~/domain/bankpayment/idempotencyKey";
import { buildInvoiceCustomMessage } from "~/domain/bankpayment/notCommittedDisclosure";
import { normalizeShopifyVariantGid } from "~/domain/cart/shopifyVariantId";
import {
  executeIdempotent,
  IdempotentOperationFailedError,
  InDoubtIdempotencyError,
} from "~/domain/idempotency";
import { Money } from "~/domain/money/money";
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
 * POST /apps/carat/bank-checkout — Bank Payment Checkout (Slice 2C task 2C-3,
 * docs/specs/SLICE-2C-BANK-PAYMENT-CHECKOUT.md §5.1/§5.6, criteria 71-76,
 * 94-95, 97-106).
 *
 * A RESOURCE ROUTE — no default export. Same reasoning as
 * `apps.carat.cart.tsx`: `allowedActionOrigins` is unconditionally `[]` in
 * every production build, so a default export here would 400 every
 * legitimate storefront caller before validation runs (criterion 74,
 * enforced by csrfResourceRouteFence.test.ts).
 *
 * CRITERION 72 IS THE POINT OF THIS ROUTE, same discipline as the cart
 * route it is modelled on. The request body names WHICH lines, WHICH
 * quantities and asserts the mode is "bank"; it never supplies a price.
 * Every unit price is re-resolved server-side from
 * `getPublishedVariantPrice` (criterion 52) and is the Bank Payment Price
 * for a Bank-Payment-Discount-eligible line, the Regular/Card Price
 * otherwise (criterion 71, owner §18) — a tampered cart attribute or line
 * property can change WHICH lines are requested, never what a line COSTS.
 *
 * WHAT THIS ROUTE DOES NOT OWN. The customer-facing form's presentation,
 * copy and the not-committed disclosure (criterion 84) belong to 2C-6 and
 * are owner-approved text that does not exist yet — nothing here invents
 * customer-facing wording. The 24-hour guarantee SWEEP and its cancellation
 * rule (criteria 78-82, 96, D22) belong to 2C-4 (`app/jobs/bankpayment/`);
 * this route's job is to persist exactly the data that sweep will need
 * (`quotedAt`, `guaranteeExpiresAt`, and each line's
 * `priceCalculationId`/`masterVariantId`), not to evaluate the guarantee
 * itself.
 */

const MAX_REQUEST_LINES = 100;
/**
 * Must move together with `MAX_VERIFIABLE_LINE_ITEMS` in
 * `~/shopify/admin/draftOrderAdapter.server.ts` — that is the hard ceiling
 * this number exists to stay under. Checked here too, BEFORE the adapter is
 * ever called, so a request that would fail the adapter's own guard is
 * refused with a clear reason instead of surfacing as an `AdminApiError`.
 */
const MAX_VERIFIABLE_LINE_ITEMS = 50;
const MAX_QUANTITY_PER_LINE = 9_999;
const GUARANTEE_DURATION_MS = 24 * 60 * 60 * 1000;

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
  /** ISO 3166-2 province/state code, e.g. "CA", "NY" — not validated against a fixed list here; Shopify is the authority on postal validity. */
  provinceCode: z.string().min(1).max(10).optional(),
  zip: z.string().min(1).max(20),
  /** ISO 3166-1 alpha-2 country code, e.g. "US". */
  countryCode: z.string().length(2),
  phone: z.string().min(1).max(50).optional(),
}) satisfies z.ZodType<DraftOrderShippingAddressInput>;

const bankCheckoutRequestSchema = z.object({
  // A literal, not an enum: this endpoint creates ONLY Bank Payment orders
  // (§7's native-vs-custom table — Card checkout is genuine Shopify
  // checkout, never a draft order). Requiring the caller to assert "bank"
  // is a defensive backstop against a theme bug routing a Card-mode cart
  // here and silently getting a bank-priced draft order.
  mode: z.literal("bank"),
  email: z.string().trim().email().max(320),
  shippingAddress: shippingAddressRequestSchema,
  lines: z.array(checkoutLineRequestSchema).min(1).max(MAX_REQUEST_LINES),
});

function badRequest(reason: string) {
  return Response.json({ error: "invalid_request", reason }, { status: 400 });
}

function unpurchasableLines(lines: readonly { shopifyVariantId: string; reason: "unknown_variant" | "unsynced" }[]) {
  return Response.json({ error: "unpurchasable_lines", lines }, { status: 400 });
}

/**
 * Criterion 76: a Buy Now cart and a Group Buy cart may never produce one
 * bank order.
 *
 * THE BOUNDARY IS AN **OPEN** CAMPAIGN, and it is scoped that way to match
 * the one the pricing engine already draws. `OpenCampaignExclusionSource`
 * (`app/jobs/pricing/ports.ts`) is what tells recalculation to leave a
 * variant alone, and it is deliberately scoped to OPEN campaigns, because
 * that is when pricing freezes (CLAUDE.md #7, `GroupBuyCampaignStatus.open`:
 * "Live. Pricing is FROZEN").
 *
 * "Any row, whatever the campaign's status" is the tempting reading and it is
 * wrong in a way that costs sales. A campaign has four states, and three of
 * them leave the variant a perfectly ordinary Buy Now product:
 *
 *   - `draft` — still being configured, nothing frozen. The engine prices the
 *     variant normally, so it has a live published price and shows up under
 *     "As low as" on collection pages. An admin quietly preparing a future
 *     campaign would have broken Buy Now checkout for those variants, with
 *     the customer only finding out after filling in the form.
 *   - `closed`, `cancelled` — the campaign is over. The variant returns to
 *     ordinary Buy Now pricing and the engine reprices it.
 *
 * Only `open` means "this variant is being sold through Group Buy right now",
 * which is the thing criterion 76 exists to keep out of a Buy Now bank order.
 *
 * WHEN SLICE 6 IMPLEMENTS THE REAL `OpenCampaignExclusionSource`, this query
 * and that one must come from ONE place. Two divergent answers to "is this
 * variant sold through Group Buy" is precisely the defect this comment is
 * replacing, and the second copy is cheaper to delete than to re-diagnose.
 */
async function findGroupBuyVariantIds(masterVariantIds: readonly string[]): Promise<Set<string>> {
  const matches = await prisma.groupBuyCampaignVariant.findMany({
    where: {
      masterVariantId: { in: [...masterVariantIds] },
      campaign: { status: "open" },
    },
    select: { masterVariantId: true },
  });
  return new Set(matches.map((m) => m.masterVariantId));
}

/**
 * Shopify order tags are short and staff-facing, so the correlation tag is a
 * fixed prefix plus a truncated key rather than the whole 64-character hash.
 * 24 hex characters is 96 bits — far past collision for the handful of
 * unresolved keys an admin would ever be reconciling — and keeps the tag
 * inside the tightest length limit Shopify applies to tags.
 */
export function draftOrderCorrelationTag(idempotencyKey: string): string {
  const hex = idempotencyKey.slice(idempotencyKey.indexOf(":") + 1);
  return `carat-idem-${hex.slice(0, 24)}`;
}

interface QuotedCheckoutLine extends QuotedLineForResult {
  readonly masterVariantId: string;
  readonly priceCalculationId: string;
  /** The price actually charged for this line — bank price if eligible, card price otherwise (criterion 71, owner §18). */
  readonly unitPriceMinorUnits: bigint;
}

/**
 * The idempotent operation itself (criteria 75, 106): create the draft
 * order, send the invoice, then persist `BankPaymentOrder` +
 * `BankPaymentOrderLine` in one transaction. Returns the fully JSON-safe
 * result DTO that `executeIdempotent` stores as `resultPayload` and a
 * replay returns verbatim — see checkoutResponseDto.ts's header comment.
 */
async function performBankCheckout(input: {
  draftOrderPort: DraftOrderPort;
  resolvedEmail: string;
  shippingAddress: DraftOrderShippingAddressInput;
  quotedLines: readonly QuotedCheckoutLine[];
  idempotencyKey: string;
}): Promise<BankCheckoutResultDto> {
  const lineItems: DraftOrderLineItemInput[] = input.quotedLines.map((line) => ({
    shopifyVariantGid: line.shopifyVariantGid,
    quantity: line.quantity,
    unitPrice: Money.fromMinorUnits(line.unitPriceMinorUnits, line.currency),
  }));

  const created = await input.draftOrderPort.createDraftOrder({
    email: input.resolvedEmail,
    shippingAddress: input.shippingAddress,
    lineItems,
    // THE TAG IS WHAT MAKES AN `in_doubt` KEY RESOLVABLE BY HAND.
    //
    // If the transaction below fails after Shopify has already accepted the
    // draft and sent the invoice, `executeIdempotent` correctly leaves the
    // key `in_doubt` and refuses to retry — we must not invoice twice. But
    // without something of ours written onto the Shopify record, the admin
    // clearing that key has a draft order somewhere in the shop and no way
    // to find it except by guessing at an email and a timestamp.
    //
    // Tags, not `note`: tags are staff-only, whereas a note can surface to
    // the customer on the order, and an internal correlation id is not
    // something a customer should be reading.
    tags: [draftOrderCorrelationTag(input.idempotencyKey)],
  });

  // No second invoice on replay (criterion 75) is guaranteed structurally,
  // not by a flag here: a replay never re-enters this function at all —
  // `executeIdempotent` returns the stored result instead (see the route's
  // action() below).
  await input.draftOrderPort.sendInvoice({
    draftOrderGid: created.draftOrderGid,
    email: input.resolvedEmail,
    customMessage: buildInvoiceCustomMessage(),
  });

  const quotedAt = new Date();
  const guaranteeExpiresAt = new Date(quotedAt.getTime() + GUARANTEE_DURATION_MS);

  // ATOMIC: either both the header and every line are written, or neither
  // is — a draft order with a header but no lines (or vice versa) is not a
  // state 2C-4's sweep or admin verification could reason about.
  const bankPaymentOrder = await prisma.$transaction(async (tx) => {
    const order = await tx.bankPaymentOrder.create({
      data: {
        shopifyDraftOrderGid: created.draftOrderGid,
        customerEmail: input.resolvedEmail,
        quotedAt,
        guaranteeExpiresAt,
      },
    });

    await tx.bankPaymentOrderLine.createMany({
      data: input.quotedLines.map((line) => ({
        bankPaymentOrderId: order.id,
        masterVariantId: line.masterVariantId,
        priceCalculationId: line.priceCalculationId,
        quantity: line.quantity,
        quotedBankPaymentPriceMinorUnits: line.quotedBankPaymentPriceMinorUnits,
        quotedRegularCardPriceMinorUnits: line.quotedRegularCardPriceMinorUnits,
        currency: line.currency,
        eligibleAtQuoteTime: line.eligibleAtQuoteTime,
      })),
    });

    return order;
  });

  logger.info("bank_checkout.completed", {
    bankPaymentOrderId: bankPaymentOrder.id,
    lineCount: input.quotedLines.length,
  });

  return buildBankCheckoutResultDto({
    bankPaymentOrderId: bankPaymentOrder.id,
    draftOrderGid: created.draftOrderGid,
    invoiceUrl: created.invoiceUrl,
    quotedAt,
    guaranteeExpiresAt,
    lines: input.quotedLines,
  });
}

/**
 * TEST-ONLY OVERRIDE HOOK (mirrors `__resetEnvCacheForTests` in
 * `app/lib/env.server.ts`). Set to a fake before calling `action()` in a
 * unit or integration test, and reset to `null` (via `afterEach`) once
 * done — production code never sets this.
 */
let draftOrderPortOverrideForTests: DraftOrderPort | null = null;
export function __setDraftOrderPortForTests(port: DraftOrderPort | null): void {
  draftOrderPortOverrideForTests = port;
}

/**
 * Obtains the real, offline-session-backed `DraftOrderPort` for THE shop
 * (single-merchant app). `~/shopify.server` is imported dynamically, and
 * only from inside this function, for the same reason
 * `productionPriceSyncPort.server.ts` and the pricing cron route do this:
 * importing it at module scope would require Shopify OAuth to be
 * configured merely to LOAD this route file, even in contexts (unit tests,
 * a boot with Shopify not yet configured) that never actually invoke it.
 */
async function createDraftOrderPort(): Promise<DraftOrderPort> {
  if (draftOrderPortOverrideForTests) return draftOrderPortOverrideForTests;

  const { SHOPIFY_SHOP_DOMAIN } = getEnv();
  if (!SHOPIFY_SHOP_DOMAIN) {
    throw new Error(
      "SHOPIFY_SHOP_DOMAIN is not configured; Bank Payment Checkout cannot reach the Shopify Admin API."
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

  // Signature verified BEFORE anything else — same discipline as every
  // other apps.carat.* route.
  const url = new URL(request.url);
  const { verified } = verifyAppProxySignature(url.searchParams, getEnv().SHOPIFY_API_SECRET);
  if (!verified) {
    logger.warn("bank_checkout.proxy_rejected", { reason: "invalid_or_missing_signature" });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("body is not valid JSON");
  }

  const parsed = bankCheckoutRequestSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest("body does not match the bank checkout request contract");
  }
  const { mode, lines: requestLines, shippingAddress } = parsed.data;
  const resolvedEmail = parsed.data.email.toLowerCase();

  // --- Resolve every requested Shopify variant id to a master_variant row,
  // one query rather than one round trip per line. ---
  const requestedGids = requestLines.map((line) => normalizeShopifyVariantGid(line.shopifyVariantId));
  const variants = await prisma.masterVariant.findMany({
    where: { shopifyVariantGid: { in: requestedGids } },
    select: { id: true, shopifyVariantGid: true, bankPaymentDiscountEligible: true },
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
    return unpurchasableLines(
      [...unknownGids].map((gid) => ({ shopifyVariantId: gid, reason: "unknown_variant" as const }))
    );
  }

  // --- Criterion 76: refuse a Group Buy variant server-side, even when the
  // theme guard is bypassed. ---
  const resolvedMasterVariantIds = [...new Set(rawLines.map((l) => l.masterVariantId))];
  const groupBuyVariantIds = await findGroupBuyVariantIds(resolvedMasterVariantIds);
  if (groupBuyVariantIds.size > 0) {
    const offendingGids = [
      ...new Set(rawLines.filter((l) => groupBuyVariantIds.has(l.masterVariantId)).map((l) => l.shopifyVariantGid)),
    ];
    logger.warn("bank_checkout.group_buy_variant_rejected", { count: offendingGids.length });
    return Response.json({ error: "group_buy_variant_present", shopifyVariantIds: offendingGids }, { status: 400 });
  }

  // --- Criterion 72: coalesce duplicate variants into one line with a
  // summed quantity BEFORE the adapter is ever reached — the adapter
  // refuses a repeated variant by design (see coalesceLines.ts). ---
  const coalescedLines = coalesceCheckoutLines(rawLines);

  if (coalescedLines.length > MAX_VERIFIABLE_LINE_ITEMS) {
    return badRequest(
      `cannot process more than ${MAX_VERIFIABLE_LINE_ITEMS} distinct line items; received ${coalescedLines.length}`
    );
  }

  // --- Criteria 71, 72, 52: every line price recomputed server-side from
  // the published calculation at quote time, and `eligibleAtQuoteTime`
  // frozen from the live flag AT THIS MOMENT. ---
  const eligibleByVariant = new Map(variants.map((v) => [v.id, v.bankPaymentDiscountEligible]));
  const unsyncedGids: string[] = [];
  const quotedLines: QuotedCheckoutLine[] = [];
  let currency: string | null = null;

  for (const line of coalescedLines) {
    const published = await getPublishedVariantPrice(line.masterVariantId);
    if (published.kind === "not_purchasable") {
      unsyncedGids.push(line.shopifyVariantGid);
      continue;
    }

    currency = currency ?? published.price.currency;
    const eligible = eligibleByVariant.get(line.masterVariantId) ?? false;
    // Criterion 71, owner §18: eligible -> Bank Payment Price; ineligible ->
    // Regular/Card Price. Identical rule to `priceCartLine`'s bank-mode
    // branch in ~/domain/cart/pricing.ts, restated rather than imported —
    // this route always charges "as if bank mode", never re-derives a tier,
    // and importing the cart's quantity-extended aggregate type here would
    // pull in fields (basis totals, savings) this route has no use for.
    const unitPriceMinorUnits = eligible
      ? published.price.bankPaymentPriceMinorUnits
      : published.price.regularCardPriceMinorUnits;

    quotedLines.push({
      masterVariantId: line.masterVariantId,
      shopifyVariantGid: line.shopifyVariantGid,
      quantity: line.quantity,
      currency: published.price.currency,
      priceCalculationId: published.price.priceCalculationId,
      unitPriceMinorUnits,
      quotedBankPaymentPriceMinorUnits: published.price.bankPaymentPriceMinorUnits,
      quotedRegularCardPriceMinorUnits: published.price.regularCardPriceMinorUnits,
      eligibleAtQuoteTime: eligible,
    });
  }

  if (unsyncedGids.length > 0) {
    return unpurchasableLines(unsyncedGids.map((gid) => ({ shopifyVariantId: gid, reason: "unsynced" as const })));
  }

  // Unreachable in practice (quotedLines is non-empty whenever no line was
  // rejected above, and every published price shares this storefront's one
  // currency), kept as a loud guard rather than a silent `!` assertion.
  if (!currency || quotedLines.some((l) => l.currency !== currency)) {
    logger.error("bank_checkout.currency_resolution_failed", { currency });
    return Response.json({ error: "pricing_failed" }, { status: 500 });
  }

  // --- Idempotency key, committed BEFORE the Admin API call (criteria 75,
  // 105, 106). ---
  const idempotencyKey = computeBankCheckoutIdempotencyKey(
    resolvedEmail,
    mode,
    quotedLines.map((line) => ({
      shopifyVariantGid: line.shopifyVariantGid,
      quantity: line.quantity,
      unitPriceMinorUnits: line.unitPriceMinorUnits.toString(),
      currency: line.currency,
    }))
  );

  let draftOrderPort: DraftOrderPort;
  try {
    draftOrderPort = await createDraftOrderPort();
  } catch (error) {
    logger.error("bank_checkout.shopify_unavailable", {
      message: error instanceof Error ? error.message : String(error),
    });
    return Response.json({ error: "checkout_unavailable" }, { status: 503 });
  }

  try {
    const result = await executeIdempotent(
      idempotencyKeyRepository,
      idempotencyKey,
      "bank_payment_checkout",
      // Audit payload for the idempotency row — counts and the resolved
      // email only. NEVER the shipping address (criteria 97-99) and NEVER
      // a price, cost or margin figure beyond what the customer is already
      // being quoted.
      { resolvedEmail, mode, lineCount: quotedLines.length },
      () =>
        performBankCheckout({
          draftOrderPort,
          resolvedEmail,
          shippingAddress,
          quotedLines,
          idempotencyKey,
        })
    );
    return Response.json(result, { status: 200 });
  } catch (error) {
    if (error instanceof InDoubtIdempotencyError) {
      logger.warn("bank_checkout.idempotency_in_doubt", { key: idempotencyKey });
      return Response.json(
        { error: "checkout_unresolved", reason: "A previous attempt for this order is still being resolved." },
        { status: 409 }
      );
    }
    if (error instanceof IdempotentOperationFailedError) {
      logger.warn("bank_checkout.idempotency_failed_previously", { key: idempotencyKey });
      return Response.json(
        { error: "checkout_failed_previously", reason: "A previous attempt for this order did not succeed." },
        { status: 409 }
      );
    }
    if (error instanceof AdminApiError) {
      logger.error("bank_checkout.shopify_admin_api_failed", {
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
