import { prisma } from "~/db/client.server";
import { getQualifyingUnits, closeGroupBuyCampaign, type CloseCampaignResult } from "~/jobs/groupbuy/unitLedger.server";
import { computeRefundsAtClose, type ComputeRefundsResult, type PaidLineInput } from "~/jobs/groupbuy/refundLedger.server";
import { logger } from "~/lib/logger.server";

/**
 * THE GAP THIS CLOSES: `closeGroupBuyCampaign` (`unitLedger.server.ts`) and
 * `computeRefundsAtClose` (`refundLedger.server.ts`) are both correct and
 * both tested, but nothing in the codebase ever calls either one, and
 * `computeRefundsAtClose` in particular needs a `paidLines` argument that
 * nothing assembles. This file is ONLY the missing wiring — it re-derives no
 * rule either already owns (tier selection, refund arithmetic, the
 * monotonic-count fold) and it never writes to `GroupBuyCampaign` or
 * `GroupBuyRefund` itself; both writes happen inside the functions it calls.
 *
 * WHERE "WHAT A LINE PAID" COMES FROM — the exact question the schema's own
 * comment on `GroupBuyBankPaymentOrder` (`prisma/schema.prisma`, "HOW A
 * SETTLEMENT BUILDER TELLS BANK FROM CARD") answers, and this file follows
 * verbatim: every Group Buy order — Bank or Card — is recorded in
 * `GroupBuyUnitEvent.orderRef`/`lineRef` by `groupBuyOrderHandler.server.ts`
 * regardless of basis. A Bank order ADDITIONALLY has a
 * `GroupBuyBankPaymentOrder` row with the SAME `shopifyOrderGid`, and that
 * row's lines carry the exact price this codebase quoted and charged
 * (`quotedBankPaymentPriceMinorUnits`) — no live lookup needed, and none
 * attempted, for that basis. A line with no matching `GroupBuyBankPaymentOrder`
 * was Card, "paid at the tier price Shopify itself charged" (the schema
 * comment's own words) — this codebase never persisted that price anywhere
 * of its own, so the only authoritative source is Shopify's own order record,
 * resolved via the optional `orderLookup` port (D7-style: Shopify stays
 * authoritative rather than this codebase reconstructing a historical tier
 * price from the ledger).
 *
 * NEVER GUESSES A PRICE. A line this function cannot resolve (no bank-payment
 * match AND no order-lookup port supplied, or the port itself cannot resolve
 * it) is returned in `unresolved`, NOT fed into `computeRefundsAtClose` with
 * a fabricated figure — inventing a paid price for a refund computation is
 * exactly the kind of error CLAUDE.md's money rules exist to prevent. The
 * caller (the staff route) is responsible for surfacing `unresolved` rather
 * than treating a completed settlement as covering every line.
 *
 * NATIVE/CARD GROUP BUY ORDERING IS UNDER SEPARATE, ACTIVE CONSTRUCTION
 * elsewhere in this codebase as of 2026-09-28 (see the in-flight
 * `groupBuyOrderHandler.server.ts` rework tracked by another agent). Today,
 * in practice, every qualifying line this function has been exercised
 * against in tests is Bank-basis; the Card branch below exists so a Card
 * line is surfaced honestly as `unresolved` rather than silently dropped or
 * mis-costed, not because Card settlement has been exercised end-to-end.
 */

export class CampaignNotFoundForSettlementError extends Error {
  constructor(readonly campaignId: string) {
    super(`No Group Buy campaign with id ${campaignId}.`);
    this.name = "CampaignNotFoundForSettlementError";
  }
}

/** Resolves ONE Card-basis line's paid price, live, from Shopify. Read-only — never a mutation. */
export interface GroupBuySettlementOrderLookupPort {
  resolveLinePaidPrice(input: {
    orderGid: string;
    lineItemGid: string;
  }): Promise<{ paidPerUnitMinorUnits: bigint; currency: string; customerGid: string | null } | null>;
}

export interface UnresolvedPaidLine {
  readonly lineRef: string;
  readonly orderRef: string;
  readonly masterVariantId: string;
  readonly qualifyingUnits: number;
  readonly reason: string;
}

export interface GatheredPaidLines {
  readonly resolved: readonly PaidLineInput[];
  readonly unresolved: readonly UnresolvedPaidLine[];
}

interface LineFacts {
  readonly orderRef: string;
  readonly masterVariantId: string;
}

/**
 * Assembles `computeRefundsAtClose`'s `paidLines` from what this codebase
 * (and, for Card lines, Shopify itself) actually recorded. Pure read —
 * writes nothing.
 */
export async function gatherGroupBuyPaidLinesForClose(
  campaignId: string,
  deps: { orderLookup?: GroupBuySettlementOrderLookupPort } = {}
): Promise<GatheredPaidLines> {
  // The net-per-line qualifying count — the same fold `closeGroupBuyCampaign`
  // and `recordUnitEvent` already use (imported, not re-derived). A line
  // fully cancelled nets to zero and is correctly skipped: nothing was
  // ultimately purchased on it, so there is nothing to settle.
  const ledger = await getQualifyingUnits(campaignId);

  // `byLine` alone has no orderRef/masterVariantId — those are read straight
  // from the ledger's own rows (a line's order/variant is fixed at its first
  // "purchased" event and never changes across later cancel/refund events on
  // the same line).
  const events = await prisma.groupBuyUnitEvent.findMany({
    where: { campaignId },
    orderBy: { createdAt: "asc" },
    select: { lineRef: true, orderRef: true, masterVariantId: true },
  });
  const lineFacts = new Map<string, LineFacts>();
  for (const event of events) {
    if (!lineFacts.has(event.lineRef)) {
      lineFacts.set(event.lineRef, { orderRef: event.orderRef, masterVariantId: event.masterVariantId });
    }
  }

  const bankOrders = await prisma.groupBuyBankPaymentOrder.findMany({
    where: { campaignId },
    include: { lines: true },
  });
  const bankOrderByShopifyGid = new Map(bankOrders.map((order) => [order.shopifyOrderGid, order] as const));

  const resolved: PaidLineInput[] = [];
  const unresolved: UnresolvedPaidLine[] = [];

  for (const [lineRef, qualifyingUnits] of Object.entries(ledger.byLine)) {
    if (qualifyingUnits <= 0) continue; // fully cancelled — nothing to settle.

    const facts = lineFacts.get(lineRef);
    if (!facts) {
      // Should not happen — every lineRef in byLine came from these same
      // events. Defensive, not an expected path.
      unresolved.push({
        lineRef,
        orderRef: "(unknown)",
        masterVariantId: "(unknown)",
        qualifyingUnits,
        reason: "no ledger event carried order/variant facts for this line",
      });
      continue;
    }

    const bankOrder = bankOrderByShopifyGid.get(facts.orderRef);
    if (bankOrder) {
      const line = bankOrder.lines.find((l) => l.masterVariantId === facts.masterVariantId);
      if (!line) {
        unresolved.push({
          ...facts,
          lineRef,
          qualifyingUnits,
          reason: `matched Bank Payment order ${bankOrder.id} but it has no line for variant ${facts.masterVariantId}`,
        });
        continue;
      }
      resolved.push({
        masterVariantId: facts.masterVariantId,
        orderRef: facts.orderRef,
        lineRef,
        customerRef: bankOrder.customerGid,
        paymentBasis: "bank_payment",
        paidPerUnitMinorUnits: line.quotedBankPaymentPriceMinorUnits,
        qualifyingUnits,
      });
      continue;
    }

    // No matching Bank Payment order — Card basis (schema's own convention).
    if (!deps.orderLookup) {
      unresolved.push({
        ...facts,
        lineRef,
        qualifyingUnits,
        reason: "card-basis line (no matching Bank Payment order); no order-lookup port was supplied to resolve the paid price",
      });
      continue;
    }

    const looked = await deps.orderLookup.resolveLinePaidPrice({ orderGid: facts.orderRef, lineItemGid: lineRef });
    if (!looked) {
      unresolved.push({
        ...facts,
        lineRef,
        qualifyingUnits,
        reason: "card-basis line; Shopify could not resolve a paid price for this order/line",
      });
      continue;
    }

    resolved.push({
      masterVariantId: facts.masterVariantId,
      orderRef: facts.orderRef,
      lineRef,
      customerRef: looked.customerGid ?? undefined,
      paymentBasis: "card",
      paidPerUnitMinorUnits: looked.paidPerUnitMinorUnits,
      qualifyingUnits,
    });
  }

  return { resolved, unresolved };
}

export interface CloseAndComputeResult {
  readonly closed: CloseCampaignResult;
  readonly computed: ComputeRefundsResult;
  readonly unresolved: readonly UnresolvedPaidLine[];
}

/**
 * Staff "Close campaign" action, end to end: lock the final tier
 * (`closeGroupBuyCampaign`), then compute the tier-adjustment refund owed on
 * every resolvable line (`computeRefundsAtClose`). Two separate calls, not
 * one transaction — `closeGroupBuyCampaign` is the one-way door and must not
 * be rolled back merely because refund computation later fails; a retry after
 * a partial failure uses `recomputeGroupBuyRefunds` below, which is exactly
 * this same computation step re-run against the campaign's now-locked state
 * (idempotent — `computeRefundsAtClose` skips lines it already computed).
 */
export async function closeGroupBuyCampaignAndComputeRefunds(options: {
  campaignId: string;
  closedBy: string;
  closedAt?: Date;
  orderLookup?: GroupBuySettlementOrderLookupPort;
}): Promise<CloseAndComputeResult> {
  const closed = await closeGroupBuyCampaign({
    campaignId: options.campaignId,
    closedBy: options.closedBy,
    closedAt: options.closedAt,
  });

  const { computed, unresolved } = await recomputeGroupBuyRefunds({
    campaignId: options.campaignId,
    computedBy: options.closedBy,
    orderLookup: options.orderLookup,
  });

  return { closed, computed, unresolved };
}

export interface RecomputeResult {
  readonly computed: ComputeRefundsResult;
  readonly unresolved: readonly UnresolvedPaidLine[];
}

/**
 * The retry/recompute path for an ALREADY-closed campaign — safe to press at
 * any time, including when nothing is left to do, the same "an up-to-date
 * resync is a no-op" discipline `resync_tier_price` already established on
 * this route: `computeRefundsAtClose` skips any line it has already computed
 * a refund for (`created`/`skipped` counts reflect that), so re-running this
 * after a prior partial success only fills in what is still missing.
 */
export async function recomputeGroupBuyRefunds(options: {
  campaignId: string;
  computedBy: string;
  orderLookup?: GroupBuySettlementOrderLookupPort;
}): Promise<RecomputeResult> {
  const campaign = await prisma.groupBuyCampaign.findUnique({ where: { id: options.campaignId } });
  if (!campaign) throw new CampaignNotFoundForSettlementError(options.campaignId);

  const gathered = await gatherGroupBuyPaidLinesForClose(options.campaignId, { orderLookup: options.orderLookup });

  const computed = await computeRefundsAtClose({
    campaignId: options.campaignId,
    paidLines: gathered.resolved,
    computedBy: options.computedBy,
  });

  if (gathered.unresolved.length > 0) {
    logger.warn("groupbuy.settlement_unresolved_lines", {
      campaignId: options.campaignId,
      unresolvedCount: gathered.unresolved.length,
      // Line/order refs only — no prices (criterion 30 discipline).
      lineRefs: gathered.unresolved.map((u) => u.lineRef),
    });
  }

  return { computed, unresolved: gathered.unresolved };
}
