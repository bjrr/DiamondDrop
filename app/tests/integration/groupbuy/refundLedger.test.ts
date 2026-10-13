import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { openGroupBuyCampaign } from "~/jobs/groupbuy/openCampaign.server";
import {
  CampaignNotClosedError,
  GroupBuyRefundAlreadyIssuedError,
  GroupBuyRefundLineAlreadyResolvedError,
  GroupBuyRefundProcessingError,
  RefundNotApprovedError,
  approveGroupBuyRefund,
  beginRefundProcessing,
  computeRefundsAtClose,
  getRefundHistory,
  markRefundFailed,
  markRefundIssued,
  recordGroupBuyRefundForUnresolvedLine,
  recordGroupBuyRefundOverride,
  releaseRefundForShipping,
  type PaidLineInput,
} from "~/jobs/groupbuy/refundLedger.server";
import { closeGroupBuyCampaign, recordUnitEvent } from "~/jobs/groupbuy/unitLedger.server";
import { MoneyDecimal } from "~/domain/money/decimal";
import { deriveRegularCardPrice } from "~/domain/pricing/regularCardPrice";

/**
 * The tier-adjustment refund ledger, end to end (README §173).
 *
 * Owner-confirmed timing: settled at CLOSE, HELD through production and QC,
 * processed at SHIPPING. The tests that matter most are the ones proving money
 * cannot go out twice — §371 — because that is the one mistake here that costs
 * real money rather than correctness.
 */

const ASOF = new Date("2026-09-18T12:00:00Z");
let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;

/** Opens a campaign, sells `units`, closes it, and returns the frozen base. */
async function closedCampaign(units: number) {
  const variant = await prisma.masterVariant.findFirstOrThrow({
    where: { status: "active", isLuxurySteal: false },
    orderBy: { baseWeightGrams: "desc" },
  });

  const draft = await prisma.groupBuyCampaign.create({
    data: {
      code: `gb-refund-${uniq()}`,
      name: "refund fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: {
        create: [
          { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
          { tierNumber: 2, minQualifyingUnits: 5, priceMultiplier: "0.990000" },
        ],
      },
      variants: {
        create: [
          { masterVariantId: variant.id, frozenBaseBankPaymentPriceMinorUnits: 1n, frozenLandedCostMinorUnits: 0n },
        ],
      },
    },
  });

  await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF });

  if (units > 0) {
    await recordUnitEvent({
      campaignId: draft.id,
      masterVariantId: variant.id,
      kind: "purchased",
      quantity: units,
      orderRef: "order-1",
      lineRef: "line-1",
      externalRef: `ext-${uniq()}`,
      occurredAt: ASOF,
      recordedBy: "test",
    });
  }

  const closed = await closeGroupBuyCampaign({ campaignId: draft.id, closedBy: "staff" });
  const frozen = await prisma.groupBuyCampaignVariant.findFirstOrThrow({
    where: { campaignId: draft.id },
  });

  return {
    campaignId: draft.id,
    variantId: variant.id,
    basePrice: frozen.frozenBaseBankPaymentPriceMinorUnits,
    finalTier: closed.finalTierNumber,
  };
}

describe("refunds are computed at close", () => {
  it("refuses to compute while the campaign is still open", async () => {
    // The final tier only exists once the count is locked; computing earlier
    // would settle against a tier that can still move.
    // The heaviest eligible piece, for the same reason as the helper above:
    // a light variant clears the $100 minimum profit only narrowly, so even a
    // 1% tier breaches it and the campaign cannot open at all.
    const variant = await prisma.masterVariant.findFirstOrThrow({
      where: { status: "active", isLuxurySteal: false },
      orderBy: { baseWeightGrams: "desc" },
    });
    const draft = await prisma.groupBuyCampaign.create({
      data: {
        code: `gb-open-${uniq()}`,
        name: "still open",
        currency: "USD",
        createdBy: "test",
        tiers: {
          create: [
            { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
            { tierNumber: 2, minQualifyingUnits: 5, priceMultiplier: "0.990000" },
          ],
        },
        variants: {
          create: [
            { masterVariantId: variant.id, frozenBaseBankPaymentPriceMinorUnits: 1n, frozenLandedCostMinorUnits: 0n },
          ],
        },
      },
    });
    await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF });

    await expect(
      computeRefundsAtClose({ campaignId: draft.id, paidLines: [], computedBy: "staff" })
    ).rejects.toThrow(CampaignNotClosedError);
  });

  it("owes the difference when the campaign reached a better tier", async () => {
    // Five units reaches tier 2 at 99% of base. A customer who paid full base
    // is owed 1%.
    const c = await closedCampaign(5);
    expect(c.finalTier).toBe(2);

    const result = await computeRefundsAtClose({
      campaignId: c.campaignId,
      computedBy: "staff",
      paidLines: [
        {
          masterVariantId: c.variantId,
          orderRef: "order-1",
          lineRef: "line-1",
          paymentBasis: "bank_payment",
          paidPerUnitMinorUnits: c.basePrice,
          qualifyingUnits: 5,
        },
      ],
    });

    expect(result.created).toBe(1);
    expect(result.owedCount).toBe(1);
    expect(result.totalOwedMinorUnits).toBeGreaterThan(0n);

    const refund = await prisma.groupBuyRefund.findFirstOrThrow({
      where: { campaignId: c.campaignId },
    });
    expect(refund.status).toBe("pending");
    // Both prices stored, not just the difference — "why was this customer
    // refunded $X?" needs what they paid and what the campaign settled at.
    expect(refund.paidPerUnitMinorUnits).toBe(c.basePrice);
    expect(refund.finalPerUnitMinorUnits).toBeLessThan(c.basePrice);
  });

  it("records not_owed rather than nothing when the price did not move", async () => {
    // One unit stays on tier 1 at full base, so nobody is owed anything. The
    // row still exists: "checked and owed nothing" must be distinguishable from
    // "never looked at".
    const c = await closedCampaign(1);
    expect(c.finalTier).toBe(1);

    await computeRefundsAtClose({
      campaignId: c.campaignId,
      computedBy: "staff",
      paidLines: [
        {
          masterVariantId: c.variantId,
          orderRef: "order-1",
          lineRef: "line-1",
          paymentBasis: "bank_payment",
          paidPerUnitMinorUnits: c.basePrice,
          qualifyingUnits: 1,
        },
      ],
    });

    const refund = await prisma.groupBuyRefund.findFirstOrThrow({
      where: { campaignId: c.campaignId },
    });
    expect(refund.status).toBe("not_owed");
    expect(refund.refundAmountMinorUnits).toBe(0n);
  });

  it("is idempotent — recomputing does not create a second payable row", async () => {
    const c = await closedCampaign(5);
    const line: PaidLineInput = {
      masterVariantId: c.variantId,
      orderRef: "order-1",
      lineRef: "line-1",
      paymentBasis: "bank_payment",
      paidPerUnitMinorUnits: c.basePrice,
      qualifyingUnits: 5,
    };

    const first = await computeRefundsAtClose({
      campaignId: c.campaignId,
      paidLines: [line],
      computedBy: "staff",
    });
    const second = await computeRefundsAtClose({
      campaignId: c.campaignId,
      paidLines: [line],
      computedBy: "staff",
    });

    expect(first.created).toBe(1);
    // Re-running after a partial failure finishes the job rather than doubling
    // it.
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(1);
    expect(await prisma.groupBuyRefund.count({ where: { campaignId: c.campaignId } })).toBe(1);
  });
});

describe("the hold through production and QC", () => {
  async function pendingRefund() {
    const c = await closedCampaign(5);
    await computeRefundsAtClose({
      campaignId: c.campaignId,
      computedBy: "staff",
      paidLines: [
        {
          masterVariantId: c.variantId,
          orderRef: "order-1",
          lineRef: "line-1",
          paymentBasis: "bank_payment",
          paidPerUnitMinorUnits: c.basePrice,
          qualifyingUnits: 5,
        },
      ],
    });
    const refund = await prisma.groupBuyRefund.findFirstOrThrow({ where: { campaignId: c.campaignId } });
    // OWNER DECISION (Group Buy settlement approval gating, added after this
    // suite was first written): beginRefundProcessing now refuses an
    // unapproved refund outright, which would otherwise mask the
    // hold-through-shipping refusal this whole describe block exists to
    // prove. Approving here isolates that concern from THIS suite's own
    // subject — see `campaignSettlement.test.ts`'s "the approval gate"
    // describe block for the approval-gate tests themselves.
    return approveGroupBuyRefund({ refundId: refund.id, actor: "staff" });
  }

  it("REFUSES to pay before the item ships", async () => {
    // The owner's timing, enforced: settled at close, held through production
    // and QC. A direct pending -> processing move would pay too early, EVEN
    // for an already-approved refund — approval authorizes money to move
    // later; it does not waive the shipping hold.
    const refund = await pendingRefund();
    await expect(beginRefundProcessing({ refundId: refund.id, actor: "staff" })).rejects.toThrow(
      /cannot move from pending to processing/
    );
  });

  it("records WHEN the hold ended, which is the audit trail for the rule", async () => {
    const refund = await pendingRefund();
    const shippedAt = new Date("2026-11-01T09:00:00Z");

    await releaseRefundForShipping({ refundId: refund.id, actor: "staff", shippedAt });

    const released = await prisma.groupBuyRefund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(released.status).toBe("releasable");
    expect(released.releasedAt?.toISOString()).toBe(shippedAt.toISOString());
  });

  it("completes the full close -> ship -> process -> issue path", async () => {
    const refund = await pendingRefund();

    await releaseRefundForShipping({ refundId: refund.id, actor: "staff" });
    await beginRefundProcessing({ refundId: refund.id, actor: "staff" });
    await markRefundIssued({
      refundId: refund.id,
      actor: "staff",
      processorReference: "re_abc123",
    });

    const issued = await prisma.groupBuyRefund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(issued.status).toBe("issued");
    expect(issued.processorReference).toBe("re_abc123");
    expect(issued.issuedAt).not.toBeNull();
  });

  it("retries a failure through the same path, and keeps both attempts", async () => {
    const refund = await pendingRefund();

    await releaseRefundForShipping({ refundId: refund.id, actor: "staff" });
    await beginRefundProcessing({ refundId: refund.id, actor: "staff" });
    await markRefundFailed({ refundId: refund.id, actor: "staff", failureReason: "card expired" });
    await releaseRefundForShipping({ refundId: refund.id, actor: "staff" });
    await beginRefundProcessing({ refundId: refund.id, actor: "staff" });
    await markRefundIssued({ refundId: refund.id, actor: "staff", processorReference: "re_retry" });

    const history = await getRefundHistory(refund.id);
    // A refund that failed once and then succeeded must not be indistinguishable
    // from one that worked first time. The leading "pending" is
    // `pendingRefund()`'s own approveGroupBuyRefund call — a same-status
    // event (approval authorizes a later transition; it is not one itself),
    // recorded before any of the transitions this test drives.
    expect(history.map((h) => h.toStatus)).toEqual([
      "pending",
      "pending",
      "releasable",
      "processing",
      "failed",
      "releasable",
      "processing",
      "issued",
    ]);
    expect(history.find((h) => h.toStatus === "failed")?.reason).toBe("card expired");
  });
});

describe("no duplicate customer value", () => {
  async function issuedRefund() {
    const c = await closedCampaign(5);
    await computeRefundsAtClose({
      campaignId: c.campaignId,
      computedBy: "staff",
      paidLines: [
        {
          masterVariantId: c.variantId,
          orderRef: "order-1",
          lineRef: "line-1",
          paymentBasis: "bank_payment",
          paidPerUnitMinorUnits: c.basePrice,
          qualifyingUnits: 5,
        },
      ],
    });
    const refund = await prisma.groupBuyRefund.findFirstOrThrow({
      where: { campaignId: c.campaignId },
    });
    await approveGroupBuyRefund({ refundId: refund.id, actor: "staff" });
    await releaseRefundForShipping({ refundId: refund.id, actor: "staff" });
    await beginRefundProcessing({ refundId: refund.id, actor: "staff" });
    await markRefundIssued({ refundId: refund.id, actor: "staff", processorReference: "re_first" });
    return refund;
  }

  it("refuses to re-process an issued refund through the service", async () => {
    const refund = await issuedRefund();
    await expect(
      releaseRefundForShipping({ refundId: refund.id, actor: "staff" })
    ).rejects.toThrow(/cannot move from issued/);
    await expect(beginRefundProcessing({ refundId: refund.id, actor: "staff" })).rejects.toThrow();
  });

  it("refuses at the DATABASE too, so a script cannot pay twice", async () => {
    // The guarantee that survives something bypassing this module entirely.
    const refund = await issuedRefund();

    await expect(
      prisma.groupBuyRefund.update({ where: { id: refund.id }, data: { status: "releasable" } })
    ).rejects.toThrow(/already issued/);
  });

  it("refuses to alter the amount or processor reference once issued", async () => {
    const refund = await issuedRefund();

    await expect(
      prisma.groupBuyRefund.update({
        where: { id: refund.id },
        data: { refundAmountMinorUnits: 999_999n },
      })
    ).rejects.toThrow(/settled once issued/);
  });

  it("keeps one refund row per line, by unique key", async () => {
    const refund = await issuedRefund();

    await expect(
      prisma.groupBuyRefund.create({
        data: {
          campaignId: refund.campaignId,
          masterVariantId: refund.masterVariantId,
          orderRef: refund.orderRef,
          lineRef: refund.lineRef,
          paymentBasis: "bank_payment",
          paidPerUnitMinorUnits: 1000n,
          finalPerUnitMinorUnits: 0n,
          qualifyingUnits: 1,
          refundAmountMinorUnits: 1000n,
          currency: "USD",
        },
      })
    ).rejects.toThrow();
  });

  it("refuses to mark issued without a processor reference", async () => {
    // An issued refund with no reference cannot be reconciled, which makes
    // "did we actually pay this?" unanswerable.
    const c = await closedCampaign(5);
    await computeRefundsAtClose({
      campaignId: c.campaignId,
      computedBy: "staff",
      paidLines: [
        {
          masterVariantId: c.variantId,
          orderRef: "order-1",
          lineRef: "line-1",
          paymentBasis: "bank_payment",
          paidPerUnitMinorUnits: c.basePrice,
          qualifyingUnits: 5,
        },
      ],
    });
    const refund = await prisma.groupBuyRefund.findFirstOrThrow({
      where: { campaignId: c.campaignId },
    });
    await approveGroupBuyRefund({ refundId: refund.id, actor: "staff" });
    await releaseRefundForShipping({ refundId: refund.id, actor: "staff" });
    await beginRefundProcessing({ refundId: refund.id, actor: "staff" });

    await expect(
      markRefundIssued({ refundId: refund.id, actor: "staff", processorReference: "  " })
    ).rejects.toThrow(/processor reference is required/);
  });
});

describe("the history is evidence", () => {
  it("cannot be edited or deleted", async () => {
    const c = await closedCampaign(5);
    await computeRefundsAtClose({
      campaignId: c.campaignId,
      computedBy: "staff",
      paidLines: [
        {
          masterVariantId: c.variantId,
          orderRef: "order-1",
          lineRef: "line-1",
          paymentBasis: "bank_payment",
          paidPerUnitMinorUnits: c.basePrice,
          qualifyingUnits: 5,
        },
      ],
    });
    const refund = await prisma.groupBuyRefund.findFirstOrThrow({
      where: { campaignId: c.campaignId },
    });
    const event = await prisma.groupBuyRefundEvent.findFirstOrThrow({
      where: { refundId: refund.id },
    });

    await expect(
      prisma.groupBuyRefundEvent.update({ where: { id: event.id }, data: { actor: "someone else" } })
    ).rejects.toThrow(/append-only/);
    await expect(
      prisma.groupBuyRefundEvent.delete({ where: { id: event.id } })
    ).rejects.toThrow(/append-only/);
  });
});

describe("refunds settle in the basis the money arrived in", () => {
  /**
   * THE BRANCH THAT MOVES THE MOST MONEY, and until this suite was extended it
   * had no coverage at all.
   *
   * A campaign freezes a BANK PAYMENT base. A card customer paid that base
   * uplifted by the tier schedule and ceilinged to $5. Comparing what they paid
   * against a bank-basis tier price would treat the entire uplift as an
   * overcharge and refund it — 3-5% of every card order, at every tier drop,
   * looking like a perfectly ordinary refund.
   */
  const cardPriceOf = (bankMinorUnits: bigint): bigint =>
    deriveRegularCardPrice(
      bankMinorUnits,
      new MoneyDecimal("0.050000"),
      "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1"
    ).regularCardPriceMinorUnits;

  it("refunds a CARD line against card-basis prices, not bank-basis ones", async () => {
    const c = await closedCampaign(5);
    expect(c.finalTier).toBe(2);

    // What this customer was actually charged: the card price of the tier-1
    // (full) bank price, because they bought before the campaign reached tier 2.
    const paidCard = cardPriceOf(c.basePrice);

    await computeRefundsAtClose({
      campaignId: c.campaignId,
      computedBy: "staff",
      paidLines: [
        {
          masterVariantId: c.variantId,
          orderRef: "order-card",
          lineRef: "line-card",
          paymentBasis: "card",
          paidPerUnitMinorUnits: paidCard,
          qualifyingUnits: 1,
        },
      ],
    });

    const refund = await prisma.groupBuyRefund.findFirstOrThrow({
      where: { campaignId: c.campaignId, lineRef: "line-card" },
    });

    // The final tier price the customer is settled against must ALSO be a card
    // price. Recomputed here from the frozen base rather than read back from
    // the row being tested.
    const finalBank = (c.basePrice * 99n) / 100n;
    const finalBankRounded =
      finalBank % 100n === 0n ? finalBank : finalBank + (100n - (finalBank % 100n));
    expect(refund.finalPerUnitMinorUnits).toBe(cardPriceOf(finalBankRounded));
    expect(refund.paymentBasis).toBe("card");

    // And decisively NOT the bank-basis tier price, which is what the bug
    // would have used.
    expect(refund.finalPerUnitMinorUnits).not.toBe(finalBankRounded);
  });

  it("refunds a card line LESS than the same line would get on a bank basis", async () => {
    // The size of the bug, stated as a comparison. Two lines, identical except
    // for the basis and therefore the amount paid, settled in the same run.
    const c = await closedCampaign(5);
    const paidBank = c.basePrice;
    const paidCard = cardPriceOf(c.basePrice);

    await computeRefundsAtClose({
      campaignId: c.campaignId,
      computedBy: "staff",
      paidLines: [
        {
          masterVariantId: c.variantId,
          orderRef: "order-b",
          lineRef: "line-bank",
          paymentBasis: "bank_payment",
          paidPerUnitMinorUnits: paidBank,
          qualifyingUnits: 1,
        },
        {
          masterVariantId: c.variantId,
          orderRef: "order-c",
          lineRef: "line-card",
          paymentBasis: "card",
          paidPerUnitMinorUnits: paidCard,
          qualifyingUnits: 1,
        },
      ],
    });

    const bank = await prisma.groupBuyRefund.findFirstOrThrow({
      where: { campaignId: c.campaignId, lineRef: "line-bank" },
    });
    const card = await prisma.groupBuyRefund.findFirstOrThrow({
      where: { campaignId: c.campaignId, lineRef: "line-card" },
    });

    // Each is a genuine tier adjustment, and each is modest — roughly the 1%
    // the tier moved. Neither is the ~5% a basis mismatch would produce.
    expect(bank.refundAmountMinorUnits).toBeGreaterThan(0n);
    expect(card.refundAmountMinorUnits).toBeGreaterThan(0n);

    const upliftOnThisPiece = paidCard - paidBank;
    expect(
      card.refundAmountMinorUnits,
      "a card refund anywhere near the uplift means the bases were crossed"
    ).toBeLessThan(upliftOnThisPiece);
  });
});

describe("recordGroupBuyRefundOverride — a correction of facts, moved here from groupBuyRepository.server.ts during the refund-ledger consolidation", () => {
  async function refundedLine() {
    const c = await closedCampaign(5); // reaches tier 2
    await computeRefundsAtClose({
      campaignId: c.campaignId,
      computedBy: "staff",
      paidLines: [
        {
          masterVariantId: c.variantId,
          orderRef: "order-1",
          lineRef: "line-1",
          paymentBasis: "bank_payment",
          paidPerUnitMinorUnits: c.basePrice,
          qualifyingUnits: 5,
        },
      ],
    });
    return prisma.groupBuyRefund.findFirstOrThrow({ where: { campaignId: c.campaignId } });
  }

  it("overrides an INPUT (the final price) and the amount is RECOMPUTED from it — never set independently", async () => {
    const refund = await refundedLine();

    // The database's own group_buy_refund_amount_matches_inputs CHECK holds
    // refundAmount = (paid - final) x units at all times, with no exception
    // for a manual override — so overriding "the amount" directly is not a
    // capability this function offers. It overrides the FINAL PRICE input,
    // and the amount is recomputed from the new figure.
    const correctedFinal = refund.finalPerUnitMinorUnits > 0n ? refund.finalPerUnitMinorUnits - 1n : 0n;
    const overridden = await recordGroupBuyRefundOverride(refund.id, {
      overrideBy: "owner",
      overrideReason: "goodwill adjustment to the settled final price",
      finalPerUnitMinorUnits: correctedFinal,
    });

    expect(overridden.finalPerUnitMinorUnits).toBe(correctedFinal);
    expect(overridden.refundAmountMinorUnits).toBe((refund.paidPerUnitMinorUnits - correctedFinal) * 5n);
    expect(overridden.overrideBy).toBe("owner");
    expect(overridden.overrideReason).toBe("goodwill adjustment to the settled final price");
    expect(overridden.overrideAt).not.toBeNull();
  });

  it("leaves an omitted input unchanged — overriding only the paid price does not disturb the final price", async () => {
    const refund = await refundedLine();

    const correctedPaid = refund.paidPerUnitMinorUnits + 10n;
    const overridden = await recordGroupBuyRefundOverride(refund.id, {
      overrideBy: "owner",
      overrideReason: "paid amount was recorded 10 cents low",
      paidPerUnitMinorUnits: correctedPaid,
    });

    expect(overridden.paidPerUnitMinorUnits).toBe(correctedPaid);
    expect(overridden.finalPerUnitMinorUnits).toBe(refund.finalPerUnitMinorUnits);
    expect(overridden.refundAmountMinorUnits).toBe((correctedPaid - refund.finalPerUnitMinorUnits) * 5n);
  });

  it("cannot produce a negative refund — floored at zero, same as initial computation", async () => {
    const refund = await refundedLine();

    // A corrected paid price BELOW the corrected final price — the exact
    // shape computeTierRefund's own zero-floor exists for.
    const correctedFinal = refund.paidPerUnitMinorUnits + 1_000_00n;
    const overridden = await recordGroupBuyRefundOverride(refund.id, {
      overrideBy: "owner",
      overrideReason: "testing the floor",
      finalPerUnitMinorUnits: correctedFinal,
    });

    expect(overridden.refundAmountMinorUnits).toBe(0n); // never a charge
    expect(overridden.refundAmountMinorUnits >= 0n).toBe(true);
  });

  it("refuses to override an already-issued refund", async () => {
    const refund = await refundedLine();
    await approveGroupBuyRefund({ refundId: refund.id, actor: "staff" });
    await releaseRefundForShipping({ refundId: refund.id, actor: "staff" });
    await beginRefundProcessing({ refundId: refund.id, actor: "staff" });
    await markRefundIssued({ refundId: refund.id, actor: "staff", processorReference: "proc-ref-9" });

    await expect(
      recordGroupBuyRefundOverride(refund.id, {
        overrideBy: "owner",
        overrideReason: "too late",
        finalPerUnitMinorUnits: 1n,
      })
    ).rejects.toBeInstanceOf(GroupBuyRefundAlreadyIssuedError);
  });

  it("NEVER bypasses the approval gate — an unapproved refund still cannot begin processing after an override", async () => {
    const refund = await refundedLine();

    await recordGroupBuyRefundOverride(refund.id, {
      overrideBy: "owner",
      overrideReason: "correcting the paid figure",
      paidPerUnitMinorUnits: refund.paidPerUnitMinorUnits + 5n,
    });

    await releaseRefundForShipping({ refundId: refund.id, actor: "staff" });
    await expect(beginRefundProcessing({ refundId: refund.id, actor: "staff" })).rejects.toThrow(RefundNotApprovedError);
  });

  it("does not touch approval facts on an already-approved refund — the write-once database trigger would refuse it even if it tried", async () => {
    const refund = await refundedLine();
    const approved = await approveGroupBuyRefund({ refundId: refund.id, actor: "staff:reviewer-jane" });
    expect(approved.approvedAt).not.toBeNull();

    const overridden = await recordGroupBuyRefundOverride(refund.id, {
      overrideBy: "owner",
      overrideReason: "correcting the final price after approval",
      finalPerUnitMinorUnits: refund.finalPerUnitMinorUnits,
    });

    expect(overridden.approvedByActorRef).toBe("staff:reviewer-jane");
    expect(overridden.approvedAt?.toISOString()).toBe(approved.approvedAt?.toISOString());

    // Bypassing this function entirely, the database's own write-once
    // trigger refuses to change or clear the recorded approval too.
    await expect(
      prisma.groupBuyRefund.update({ where: { id: refund.id }, data: { approvedByActorRef: "someone-else" } })
    ).rejects.toThrow();
    await expect(
      prisma.groupBuyRefund.update({ where: { id: refund.id }, data: { approvedAt: null } })
    ).rejects.toThrow();
  });

  it("records the reviewer, reason and timestamp, queryable afterward", async () => {
    const refund = await refundedLine();
    const before = new Date();

    const overridden = await recordGroupBuyRefundOverride(refund.id, {
      overrideBy: "owner",
      overrideReason: "customer disputed the recorded paid price; corrected from Shopify Admin",
      paidPerUnitMinorUnits: refund.paidPerUnitMinorUnits + 1n,
    });

    expect(overridden.overrideBy).toBe("owner");
    expect(overridden.overrideReason).toBe("customer disputed the recorded paid price; corrected from Shopify Admin");
    expect(overridden.overrideAt).not.toBeNull();
    expect(overridden.overrideAt!.getTime()).toBeGreaterThanOrEqual(before.getTime());

    const reloaded = await prisma.groupBuyRefund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(reloaded.overrideBy).toBe("owner");
    expect(reloaded.overrideReason).toContain("corrected from Shopify Admin");
  });
});

describe("recordGroupBuyRefundOverride reopens or closes the owed/not-owed boundary (architect follow-up, 2026-09-28)", () => {
  async function notOwedRefund() {
    const c = await closedCampaign(1); // stays tier 1 — paying exactly the tier-1 price owes nothing
    await computeRefundsAtClose({
      campaignId: c.campaignId,
      computedBy: "staff",
      paidLines: [
        {
          masterVariantId: c.variantId,
          orderRef: "order-1",
          lineRef: "line-1",
          paymentBasis: "bank_payment",
          paidPerUnitMinorUnits: c.basePrice,
          qualifyingUnits: 1,
        },
      ],
    });
    return prisma.groupBuyRefund.findFirstOrThrow({ where: { campaignId: c.campaignId } });
  }

  it("not_owed -> pending: corrected facts revealing money IS owed reopen the refund, never touching approval", async () => {
    const refund = await notOwedRefund();
    expect(refund.status).toBe("not_owed");
    expect(refund.approvedAt).toBeNull();

    // The customer was actually charged the SAME amount but the true final
    // price was lower than recorded — money IS owed after all.
    const reopened = await recordGroupBuyRefundOverride(refund.id, {
      overrideBy: "owner",
      overrideReason: "the recorded final price was wrong; the true tier price was lower",
      finalPerUnitMinorUnits: 0n,
    });

    expect(reopened.status).toBe("pending");
    expect(reopened.refundAmountMinorUnits).toBeGreaterThan(0n);
    // NEVER bypasses the approval gate — reopening is a status change, not an approval grant.
    expect(reopened.approvedAt).toBeNull();
    expect(reopened.approvedByActorRef).toBeNull();
    await expect(beginRefundProcessing({ refundId: refund.id, actor: "staff" })).rejects.toThrow(RefundNotApprovedError);
  });

  it("pending -> not_owed: corrected facts revealing NOTHING is owed close the refund — the mirror of the forward case", async () => {
    const c = await closedCampaign(5); // tier 2 — owed by construction
    await computeRefundsAtClose({
      campaignId: c.campaignId,
      computedBy: "staff",
      paidLines: [
        {
          masterVariantId: c.variantId,
          orderRef: "order-1",
          lineRef: "line-1",
          paymentBasis: "bank_payment",
          paidPerUnitMinorUnits: c.basePrice,
          qualifyingUnits: 5,
        },
      ],
    });
    const refund = await prisma.groupBuyRefund.findFirstOrThrow({ where: { campaignId: c.campaignId } });
    expect(refund.status).toBe("pending");

    // The customer actually paid the final tier price all along.
    const closed = await recordGroupBuyRefundOverride(refund.id, {
      overrideBy: "owner",
      overrideReason: "the recorded paid price was wrong; the customer paid the final tier price",
      paidPerUnitMinorUnits: refund.finalPerUnitMinorUnits,
    });

    expect(closed.status).toBe("not_owed");
    expect(closed.refundAmountMinorUnits).toBe(0n);
  });

  it("refuses to correct facts while a refund is currently processing", async () => {
    const c = await closedCampaign(5);
    await computeRefundsAtClose({
      campaignId: c.campaignId,
      computedBy: "staff",
      paidLines: [
        {
          masterVariantId: c.variantId,
          orderRef: "order-1",
          lineRef: "line-1",
          paymentBasis: "bank_payment",
          paidPerUnitMinorUnits: c.basePrice,
          qualifyingUnits: 5,
        },
      ],
    });
    const refund = await prisma.groupBuyRefund.findFirstOrThrow({ where: { campaignId: c.campaignId } });
    await approveGroupBuyRefund({ refundId: refund.id, actor: "staff" });
    await releaseRefundForShipping({ refundId: refund.id, actor: "staff" });
    await beginRefundProcessing({ refundId: refund.id, actor: "staff" });

    await expect(
      recordGroupBuyRefundOverride(refund.id, {
        overrideBy: "owner",
        overrideReason: "too soon — a Shopify call may be in flight",
        paidPerUnitMinorUnits: 1n,
      })
    ).rejects.toBeInstanceOf(GroupBuyRefundProcessingError);
  });

  it("refuses at the DATABASE too — a not_owed row can never carry a nonzero refund amount", async () => {
    const refund = await notOwedRefund();

    await expect(
      prisma.groupBuyRefund.update({
        where: { id: refund.id },
        // Internally consistent with the OLDER amount-matches-inputs formula
        // (500 = 1000 - 500, one qualifying unit) — isolates the NEW
        // constraint rather than tripping the older one by accident.
        data: { paidPerUnitMinorUnits: 1000n, finalPerUnitMinorUnits: 500n, refundAmountMinorUnits: 500n },
      })
    ).rejects.toThrow(/group_buy_refund_not_owed_has_zero_amount/);
  });
});

describe("recordGroupBuyRefundForUnresolvedLine — creates the row computeRefundsAtClose could never create for an unresolved line (architect follow-up, 2026-09-28)", () => {
  it("creates a refund row from ONE staff-supplied fact, deriving the final price, qualifying units and amount", async () => {
    const c = await closedCampaign(5); // reaches tier 2 — line-1 never passed to computeRefundsAtClose

    const refund = await recordGroupBuyRefundForUnresolvedLine({
      campaignId: c.campaignId,
      masterVariantId: c.variantId,
      orderRef: "order-1",
      lineRef: "line-1",
      paymentBasis: "bank_payment",
      paidPerUnitMinorUnits: c.basePrice,
      recordedBy: "owner",
      reason: "established the paid price from Shopify Admin after this line failed to resolve automatically",
    });

    expect(refund.qualifyingUnits).toBe(5); // read from the ledger, never trusted from the caller
    expect(refund.paidPerUnitMinorUnits).toBe(c.basePrice);
    expect(refund.finalPerUnitMinorUnits).toBeLessThan(c.basePrice); // tier 2 is strictly cheaper
    expect(refund.refundAmountMinorUnits).toBe((c.basePrice - refund.finalPerUnitMinorUnits) * 5n);
    expect(refund.status).toBe("pending");
    expect(refund.approvedAt).toBeNull(); // lands unapproved
    expect(refund.overrideBy).toBe("owner");
    expect(refund.overrideReason).toContain("Shopify Admin");
    expect(refund.overrideAt).not.toBeNull();
  });

  it("lands in not_owed, never forced into pending, when the corrected facts show nothing is owed", async () => {
    const c = await closedCampaign(5);

    const refund = await recordGroupBuyRefundForUnresolvedLine({
      campaignId: c.campaignId,
      masterVariantId: c.variantId,
      orderRef: "order-1",
      lineRef: "line-1",
      paymentBasis: "bank_payment",
      paidPerUnitMinorUnits: 0n,
      recordedBy: "owner",
      reason: "testing the not_owed path",
    });

    expect(refund.status).toBe("not_owed");
    expect(refund.refundAmountMinorUnits).toBe(0n);
  });

  it("derives the final price through the EXACT SAME pipeline computeRefundsAtClose uses — never a third divergent formula", async () => {
    const c = await closedCampaign(5);

    const manual = await recordGroupBuyRefundForUnresolvedLine({
      campaignId: c.campaignId,
      masterVariantId: c.variantId,
      orderRef: "order-1",
      lineRef: "line-1",
      paymentBasis: "bank_payment",
      paidPerUnitMinorUnits: c.basePrice,
      recordedBy: "owner",
      reason: "compare against the automatic path",
    });

    await computeRefundsAtClose({
      campaignId: c.campaignId,
      computedBy: "staff",
      paidLines: [
        {
          masterVariantId: c.variantId,
          orderRef: "order-2",
          lineRef: "line-2",
          paymentBasis: "bank_payment",
          paidPerUnitMinorUnits: c.basePrice,
          qualifyingUnits: 5,
        },
      ],
    });
    const automatic = await prisma.groupBuyRefund.findFirstOrThrow({ where: { campaignId: c.campaignId, lineRef: "line-2" } });

    expect(manual.finalPerUnitMinorUnits).toBe(automatic.finalPerUnitMinorUnits);
  });

  it("refuses on a line that already resolved — impossible to use as a second way to set a price", async () => {
    const c = await closedCampaign(5);
    await computeRefundsAtClose({
      campaignId: c.campaignId,
      computedBy: "staff",
      paidLines: [
        {
          masterVariantId: c.variantId,
          orderRef: "order-1",
          lineRef: "line-1",
          paymentBasis: "bank_payment",
          paidPerUnitMinorUnits: c.basePrice,
          qualifyingUnits: 5,
        },
      ],
    });

    await expect(
      recordGroupBuyRefundForUnresolvedLine({
        campaignId: c.campaignId,
        masterVariantId: c.variantId,
        orderRef: "order-1",
        lineRef: "line-1",
        paymentBasis: "bank_payment",
        paidPerUnitMinorUnits: c.basePrice,
        recordedBy: "owner",
        reason: "should be refused — this line already resolved",
      })
    ).rejects.toBeInstanceOf(GroupBuyRefundLineAlreadyResolvedError);

    // Structurally impossible, not merely refused by this function's own
    // precondition check — the underlying table's own unique constraint.
    expect(await prisma.groupBuyRefund.count({ where: { campaignId: c.campaignId, lineRef: "line-1" } })).toBe(1);
  });

  it("refuses before the campaign is closed", async () => {
    const variant = await prisma.masterVariant.findFirstOrThrow({
      where: { status: "active", isLuxurySteal: false },
      orderBy: { baseWeightGrams: "desc" },
    });
    const draft = await prisma.groupBuyCampaign.create({
      data: {
        code: `gb-unresolved-open-${uniq()}`,
        name: "still open",
        currency: "USD",
        createdBy: "test",
        tiers: {
          create: [
            { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
            { tierNumber: 2, minQualifyingUnits: 5, priceMultiplier: "0.990000" },
          ],
        },
        variants: {
          create: [{ masterVariantId: variant.id, frozenBaseBankPaymentPriceMinorUnits: 1n, frozenLandedCostMinorUnits: 0n }],
        },
      },
    });
    await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF });

    await expect(
      recordGroupBuyRefundForUnresolvedLine({
        campaignId: draft.id,
        masterVariantId: variant.id,
        orderRef: "o1",
        lineRef: "l1",
        paymentBasis: "bank_payment",
        paidPerUnitMinorUnits: 100_00n,
        recordedBy: "owner",
        reason: "should be refused — campaign still open",
      })
    ).rejects.toBeInstanceOf(CampaignNotClosedError);
  });

  it("lands unapproved — beginRefundProcessing still refuses it, same as any other freshly computed refund", async () => {
    const c = await closedCampaign(5);
    const refund = await recordGroupBuyRefundForUnresolvedLine({
      campaignId: c.campaignId,
      masterVariantId: c.variantId,
      orderRef: "order-1",
      lineRef: "line-1",
      paymentBasis: "bank_payment",
      paidPerUnitMinorUnits: c.basePrice,
      recordedBy: "owner",
      reason: "approval-gate check",
    });

    await releaseRefundForShipping({ refundId: refund.id, actor: "staff" });
    await expect(beginRefundProcessing({ refundId: refund.id, actor: "staff" })).rejects.toThrow(RefundNotApprovedError);
  });
});
