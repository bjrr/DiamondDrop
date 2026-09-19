import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { openGroupBuyCampaign } from "~/jobs/groupbuy/openCampaign.server";
import {
  CampaignNotClosedError,
  beginRefundProcessing,
  computeRefundsAtClose,
  getRefundHistory,
  markRefundFailed,
  markRefundIssued,
  releaseRefundForShipping,
  type PaidLineInput,
} from "~/jobs/groupbuy/refundLedger.server";
import { closeGroupBuyCampaign, recordUnitEvent } from "~/jobs/groupbuy/unitLedger.server";

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
    where: { status: "active", masterProduct: { isLuxurySteal: false } },
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
          { masterVariantId: variant.id, frozenBaseCashPriceMinorUnits: 1n, frozenLandedCostMinorUnits: 0n },
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
    basePrice: frozen.frozenBaseCashPriceMinorUnits,
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
      where: { status: "active", masterProduct: { isLuxurySteal: false } },
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
            { masterVariantId: variant.id, frozenBaseCashPriceMinorUnits: 1n, frozenLandedCostMinorUnits: 0n },
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
          paymentBasis: "cash",
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
          paymentBasis: "cash",
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
      paymentBasis: "cash",
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
          paymentBasis: "cash",
          paidPerUnitMinorUnits: c.basePrice,
          qualifyingUnits: 5,
        },
      ],
    });
    return prisma.groupBuyRefund.findFirstOrThrow({ where: { campaignId: c.campaignId } });
  }

  it("REFUSES to pay before the item ships", async () => {
    // The owner's timing, enforced: settled at close, held through production
    // and QC. A direct pending -> processing move would pay too early.
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
    // from one that worked first time.
    expect(history.map((h) => h.toStatus)).toEqual([
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
          paymentBasis: "cash",
          paidPerUnitMinorUnits: c.basePrice,
          qualifyingUnits: 5,
        },
      ],
    });
    const refund = await prisma.groupBuyRefund.findFirstOrThrow({
      where: { campaignId: c.campaignId },
    });
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
          paymentBasis: "cash",
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
          paymentBasis: "cash",
          paidPerUnitMinorUnits: c.basePrice,
          qualifyingUnits: 5,
        },
      ],
    });
    const refund = await prisma.groupBuyRefund.findFirstOrThrow({
      where: { campaignId: c.campaignId },
    });
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
          paymentBasis: "cash",
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
