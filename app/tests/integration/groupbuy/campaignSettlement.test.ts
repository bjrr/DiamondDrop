import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  CampaignNotFoundForSettlementError,
  closeGroupBuyCampaignAndComputeRefunds,
  gatherGroupBuyPaidLinesForClose,
  recomputeGroupBuyRefunds,
} from "~/jobs/groupbuy/campaignSettlement.server";
import {
  RefundNotApprovedError,
  approveGroupBuyRefund,
  beginRefundProcessing,
  computeRefundsAtClose,
  releaseRefundForShipping,
} from "~/jobs/groupbuy/refundLedger.server";
import {
  advanceApprovedGroupBuyRefundToProcessing,
  executeGroupBuyRefund,
} from "~/jobs/groupbuy/executeGroupBuyRefund.server";
import { CampaignNotOpenError, closeGroupBuyCampaign, getCurrentTier, getQualifyingUnits, recordUnitEvent } from "~/jobs/groupbuy/unitLedger.server";
import { openGroupBuyCampaign } from "~/jobs/groupbuy/openCampaign.server";
import { AdminApiError } from "~/shopify/admin/productClient.server";
import { RecordingGroupBuySettlementOrderLookupPort } from "~/shopify/admin/groupBuySettlementOrderLookupAdapter.server";
import {
  GroupBuyRefundExecutionNotImplementedError,
  RecordingGroupBuyRefundExecutionPort,
  ShopifyGroupBuyRefundExecutionAdapter,
} from "~/shopify/admin/groupBuyRefundExecutionAdapter.server";

/**
 * The close/settlement surface, end to end: `closeGroupBuyCampaignAndComputeRefunds`
 * / `recomputeGroupBuyRefunds` (`campaignSettlement.server.ts`), the
 * approval gate (`refundLedger.server.ts`, migration
 * `20260928020000_group_buy_refund_approval_gate`), and idempotent refund
 * execution (`executeGroupBuyRefund.server.ts`). Real Postgres throughout;
 * `RecordingGroupBuyRefundExecutionPort`/`RecordingGroupBuySettlementOrderLookupPort`
 * fakes stand in for Shopify, the same "real DB, faked external API" shape
 * `tests/integration/rma/executeRmaRemedy.test.ts` uses.
 */

const ASOF = new Date("2026-09-28T12:00:00Z");
let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;
let numericSeq = 1;
function nextNumericId(): string {
  numericSeq += 1;
  return `${Date.now()}${numericSeq}`;
}

async function heaviestVariant() {
  return prisma.masterVariant.findFirstOrThrow({
    where: { status: "active", isLuxurySteal: false },
    orderBy: { baseWeightGrams: "desc" },
  });
}

async function draftCampaign(variantId: string) {
  return prisma.groupBuyCampaign.create({
    data: {
      code: `gb-settle-${uniq()}`,
      name: "settlement fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: {
        create: [
          { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
          { tierNumber: 2, minQualifyingUnits: 5, priceMultiplier: "0.990000" },
        ],
      },
      variants: {
        create: [{ masterVariantId: variantId, frozenBaseBankPaymentPriceMinorUnits: 1_000_00n, frozenLandedCostMinorUnits: 1n }],
      },
    },
  });
}

async function createAcknowledgment() {
  const policy = await prisma.policyVersion.create({
    data: {
      slug: `gb-settle-ack-${uniq()}`,
      version: 1,
      effectiveFrom: new Date(),
      text: "settlement fixture policy text",
      contentHash: `hash-${uniq()}`,
    },
  });
  return prisma.acknowledgment.create({
    data: {
      exactText: "settlement fixture exact text",
      policyVersionId: policy.id,
      acknowledgedAt: new Date(),
      affirmativeActionLabel: "I Understand & Agree",
    },
  });
}

/** A Bank Payment order + one line, the shape `gatherGroupBuyPaidLinesForClose` matches against `GroupBuyUnitEvent.orderRef`. */
async function createBankPaymentOrder(input: {
  campaignId: string;
  masterVariantId: string;
  quotedBankPaymentPriceMinorUnits: bigint;
}) {
  const ack = await createAcknowledgment();
  const orderGid = `gid://shopify/Order/${nextNumericId()}`;
  await prisma.groupBuyBankPaymentOrder.create({
    data: {
      campaignId: input.campaignId,
      shopifyDraftOrderGid: `gid://shopify/DraftOrder/${randomUUID()}`,
      shopifyOrderGid: orderGid,
      customerEmail: `buyer-${uniq()}@example.com`,
      customerGid: `gid://shopify/Customer/${nextNumericId()}`,
      tierNumberAtQuote: 1,
      quotedAt: ASOF,
      cancellationAcknowledgmentId: ack.id,
      lines: {
        create: [
          {
            masterVariantId: input.masterVariantId,
            quantity: 1,
            quotedBankPaymentPriceMinorUnits: input.quotedBankPaymentPriceMinorUnits,
            quotedRegularCardPriceMinorUnits: input.quotedBankPaymentPriceMinorUnits,
            currency: "USD",
          },
        ],
      },
    },
  });
  return orderGid;
}

async function purchase(campaignId: string, masterVariantId: string, orderRef: string, quantity = 1) {
  const lineRef = `gid://shopify/LineItem/${nextNumericId()}`;
  await recordUnitEvent({
    campaignId,
    masterVariantId,
    kind: "purchased",
    quantity,
    orderRef,
    lineRef,
    externalRef: lineRef,
    occurredAt: ASOF,
    recordedBy: "test",
  });
  return lineRef;
}

describe("gatherGroupBuyPaidLinesForClose", () => {
  it("resolves a Bank Payment line from its own quoted price", async () => {
    const variant = await heaviestVariant();
    const campaign = await draftCampaign(variant.id);
    await openGroupBuyCampaign({ campaignId: campaign.id, openedBy: "staff", asOf: ASOF });
    const orderRef = await createBankPaymentOrder({
      campaignId: campaign.id,
      masterVariantId: variant.id,
      quotedBankPaymentPriceMinorUnits: 1_000_00n,
    });
    const lineRef = await purchase(campaign.id, variant.id, orderRef);

    const gathered = await gatherGroupBuyPaidLinesForClose(campaign.id);

    expect(gathered.unresolved).toHaveLength(0);
    expect(gathered.resolved).toHaveLength(1);
    expect(gathered.resolved[0]).toMatchObject({
      lineRef,
      orderRef,
      paymentBasis: "bank_payment",
      paidPerUnitMinorUnits: 1_000_00n,
      qualifyingUnits: 1,
    });
  });

  it("leaves a line with no matching Bank Payment order UNRESOLVED rather than guessing a price", async () => {
    const variant = await heaviestVariant();
    const campaign = await draftCampaign(variant.id);
    await openGroupBuyCampaign({ campaignId: campaign.id, openedBy: "staff", asOf: ASOF });
    const lineRef = await purchase(campaign.id, variant.id, `gid://shopify/Order/${nextNumericId()}`);

    const gathered = await gatherGroupBuyPaidLinesForClose(campaign.id);

    expect(gathered.resolved).toHaveLength(0);
    expect(gathered.unresolved).toHaveLength(1);
    const [unresolved] = gathered.unresolved;
    expect(unresolved?.lineRef).toBe(lineRef);
    expect(unresolved?.reason).toMatch(/no order-lookup port/i);
  });

  it("resolves a Card-basis line via the supplied order-lookup port", async () => {
    const variant = await heaviestVariant();
    const campaign = await draftCampaign(variant.id);
    await openGroupBuyCampaign({ campaignId: campaign.id, openedBy: "staff", asOf: ASOF });
    const orderRef = `gid://shopify/Order/${nextNumericId()}`;
    const lineRef = await purchase(campaign.id, variant.id, orderRef);

    const orderLookup = new RecordingGroupBuySettlementOrderLookupPort();
    orderLookup.seed(orderRef, lineRef, {
      paidPerUnitMinorUnits: 1_050_00n,
      currency: "USD",
      customerGid: "gid://shopify/Customer/999",
    });

    const gathered = await gatherGroupBuyPaidLinesForClose(campaign.id, { orderLookup });

    expect(gathered.unresolved).toHaveLength(0);
    expect(gathered.resolved).toHaveLength(1);
    expect(gathered.resolved[0]).toMatchObject({
      paymentBasis: "card",
      paidPerUnitMinorUnits: 1_050_00n,
      customerRef: "gid://shopify/Customer/999",
    });
    expect(orderLookup.calls).toHaveLength(1);
  });
});

describe("closeGroupBuyCampaignAndComputeRefunds", () => {
  it("closes the campaign and computes the refund owed on a Bank Payment line in one call", async () => {
    const variant = await heaviestVariant();
    const campaign = await draftCampaign(variant.id);
    await openGroupBuyCampaign({ campaignId: campaign.id, openedBy: "staff", asOf: ASOF });
    const orderRef = await createBankPaymentOrder({
      campaignId: campaign.id,
      masterVariantId: variant.id,
      quotedBankPaymentPriceMinorUnits: 1_000_00n,
    });
    // 5 units reaches tier 2 (99% of base) — the customer who bought at
    // tier-1 pricing before the 5th unit is owed the 1% difference.
    await purchase(campaign.id, variant.id, orderRef, 5);

    const result = await closeGroupBuyCampaignAndComputeRefunds({ campaignId: campaign.id, closedBy: "staff" });

    expect(result.closed.finalTierNumber).toBe(2);
    expect(result.unresolved).toHaveLength(0);
    expect(result.computed.owedCount).toBe(1);

    const refund = await prisma.groupBuyRefund.findFirstOrThrow({ where: { campaignId: campaign.id } });
    expect(refund.status).toBe("pending");
    expect(refund.paymentBasis).toBe("bank_payment");
    expect(refund.refundAmountMinorUnits).toBeGreaterThan(0n);
  });

  it("refuses a second close — the final tier and refunds are locked, not recomputed", async () => {
    const variant = await heaviestVariant();
    const campaign = await draftCampaign(variant.id);
    await openGroupBuyCampaign({ campaignId: campaign.id, openedBy: "staff", asOf: ASOF });
    await purchase(campaign.id, variant.id, `gid://shopify/Order/${nextNumericId()}`);
    await closeGroupBuyCampaignAndComputeRefunds({ campaignId: campaign.id, closedBy: "staff" });

    await expect(
      closeGroupBuyCampaignAndComputeRefunds({ campaignId: campaign.id, closedBy: "staff" })
    ).rejects.toThrow(CampaignNotOpenError);
  });

  it("does not change the public qualifying-unit count or unlocked tier", async () => {
    const variant = await heaviestVariant();
    const campaign = await draftCampaign(variant.id);
    await openGroupBuyCampaign({ campaignId: campaign.id, openedBy: "staff", asOf: ASOF });
    await purchase(campaign.id, variant.id, `gid://shopify/Order/${nextNumericId()}`, 5);

    const before = await getCurrentTier(campaign.id);
    await closeGroupBuyCampaignAndComputeRefunds({ campaignId: campaign.id, closedBy: "staff" });
    const after = await getCurrentTier(campaign.id);
    const liveCount = await getQualifyingUnits(campaign.id);

    expect(after.qualifyingUnits).toBe(before.qualifyingUnits);
    expect(after.tier.tierNumber).toBe(before.tier.tierNumber);
    expect(liveCount.total).toBe(before.qualifyingUnits);
  });
});

describe("recomputeGroupBuyRefunds", () => {
  it("fills in a line left unresolved at close once an order-lookup port becomes available, without duplicating the resolved one", async () => {
    const variant = await heaviestVariant();
    const campaign = await draftCampaign(variant.id);
    await openGroupBuyCampaign({ campaignId: campaign.id, openedBy: "staff", asOf: ASOF });
    const bankOrderRef = await createBankPaymentOrder({
      campaignId: campaign.id,
      masterVariantId: variant.id,
      quotedBankPaymentPriceMinorUnits: 1_000_00n,
    });
    await purchase(campaign.id, variant.id, bankOrderRef);
    const cardOrderRef = `gid://shopify/Order/${nextNumericId()}`;
    const cardLineRef = await purchase(campaign.id, variant.id, cardOrderRef, 4); // 5 total -> tier 2

    const closed = await closeGroupBuyCampaignAndComputeRefunds({ campaignId: campaign.id, closedBy: "staff" });
    expect(closed.unresolved).toHaveLength(1);
    expect(await prisma.groupBuyRefund.count({ where: { campaignId: campaign.id } })).toBe(1);

    const orderLookup = new RecordingGroupBuySettlementOrderLookupPort();
    orderLookup.seed(cardOrderRef, cardLineRef, { paidPerUnitMinorUnits: 1_050_00n, currency: "USD" });

    const recomputed = await recomputeGroupBuyRefunds({ campaignId: campaign.id, computedBy: "staff", orderLookup });

    expect(recomputed.unresolved).toHaveLength(0);
    expect(recomputed.computed.created).toBe(1); // only the newly-resolved line
    expect(recomputed.computed.skipped).toBe(1); // the bank line, already computed
    expect(await prisma.groupBuyRefund.count({ where: { campaignId: campaign.id } })).toBe(2);
  });

  it("refuses a campaign that does not exist", async () => {
    await expect(
      recomputeGroupBuyRefunds({ campaignId: randomUUID(), computedBy: "staff" })
    ).rejects.toThrow(CampaignNotFoundForSettlementError);
  });
});

describe("the negative-refund floor at the integration boundary", () => {
  it("floors a negative computation at zero and records WHY, rather than charging the customer", async () => {
    const variant = await heaviestVariant();
    const campaign = await draftCampaign(variant.id);
    await openGroupBuyCampaign({ campaignId: campaign.id, openedBy: "staff", asOf: ASOF });
    await purchase(campaign.id, variant.id, "order-neg", 1); // stays on tier 1
    const closed = await closeGroupBuyCampaign({ campaignId: campaign.id, closedBy: "staff" });
    expect(closed.finalTierNumber).toBe(1);

    // Deliberately a paid amount BELOW whatever the final tier price rounds
    // to (0 minor units guarantees this regardless of the frozen profile's
    // rounding/price-ending rules) — the shape a pre-fix campaign or a
    // caller bypassing the monotonic fold could still hand this function,
    // per computeTierRefund's own header.
    await computeRefundsAtClose({
      campaignId: campaign.id,
      computedBy: "staff",
      paidLines: [
        {
          masterVariantId: variant.id,
          orderRef: "order-neg",
          lineRef: "line-neg",
          paymentBasis: "bank_payment",
          paidPerUnitMinorUnits: 0n,
          qualifyingUnits: 1,
        },
      ],
    });

    const refund = await prisma.groupBuyRefund.findFirstOrThrow({ where: { campaignId: campaign.id, lineRef: "line-neg" } });
    expect(refund.status).toBe("not_owed");
    expect(refund.refundAmountMinorUnits).toBe(0n); // never a charge
    const event = await prisma.groupBuyRefundEvent.findFirstOrThrow({ where: { refundId: refund.id } });
    expect(event.reason).toMatch(/exceeded the price paid/i);
  });
});

describe("the approval gate (owner decision: money never moves without explicit staff approval)", () => {
  async function pendingRefund() {
    const variant = await heaviestVariant();
    const campaign = await draftCampaign(variant.id);
    await openGroupBuyCampaign({ campaignId: campaign.id, openedBy: "staff", asOf: ASOF });
    const orderRef = await createBankPaymentOrder({
      campaignId: campaign.id,
      masterVariantId: variant.id,
      quotedBankPaymentPriceMinorUnits: 1_000_00n,
    });
    await purchase(campaign.id, variant.id, orderRef, 5);
    await closeGroupBuyCampaignAndComputeRefunds({ campaignId: campaign.id, closedBy: "staff" });
    return prisma.groupBuyRefund.findFirstOrThrow({ where: { campaignId: campaign.id } });
  }

  it("refuses to begin processing an unapproved refund, even once released for shipping", async () => {
    const refund = await pendingRefund();
    await releaseRefundForShipping({ refundId: refund.id, actor: "staff" });

    await expect(beginRefundProcessing({ refundId: refund.id, actor: "staff" })).rejects.toThrow(RefundNotApprovedError);

    const unchanged = await prisma.groupBuyRefund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(unchanged.status).toBe("releasable");
  });

  it("refuses at the DATABASE too — a raw SQL bypass cannot move an unapproved refund into processing", async () => {
    const refund = await pendingRefund();
    await releaseRefundForShipping({ refundId: refund.id, actor: "staff" });

    await expect(
      prisma.groupBuyRefund.update({ where: { id: refund.id }, data: { status: "processing" } })
    ).rejects.toThrow();
  });

  it("approving twice records the reviewer/timestamp once, and a subsequent execution issues at most once", async () => {
    const refund = await pendingRefund();
    await releaseRefundForShipping({ refundId: refund.id, actor: "staff" });

    const first = await approveGroupBuyRefund({ refundId: refund.id, actor: "staff:first-reviewer" });
    const second = await approveGroupBuyRefund({ refundId: refund.id, actor: "staff:second-reviewer" });

    expect(second.approvedByActorRef).toBe("staff:first-reviewer");
    expect(second.approvedAt?.toISOString()).toBe(first.approvedAt?.toISOString());

    const port = new RecordingGroupBuyRefundExecutionPort();
    await executeGroupBuyRefund(refund.id, "staff", { port });
    await executeGroupBuyRefund(refund.id, "staff", { port }); // already issued — read-only no-op

    expect(port.calls).toHaveLength(1);
  });

  it("approval is write-once — the DATABASE refuses to change the recorded reviewer once set", async () => {
    const refund = await pendingRefund();
    await approveGroupBuyRefund({ refundId: refund.id, actor: "staff:original" });

    await expect(
      prisma.groupBuyRefund.update({ where: { id: refund.id }, data: { approvedByActorRef: "staff:someone-else" } })
    ).rejects.toThrow();
  });
});

describe("executeGroupBuyRefund — idempotent execution", () => {
  async function approvedAndReleasedRefund() {
    const variant = await heaviestVariant();
    const campaign = await draftCampaign(variant.id);
    await openGroupBuyCampaign({ campaignId: campaign.id, openedBy: "staff", asOf: ASOF });
    const orderRef = await createBankPaymentOrder({
      campaignId: campaign.id,
      masterVariantId: variant.id,
      quotedBankPaymentPriceMinorUnits: 1_000_00n,
    });
    await purchase(campaign.id, variant.id, orderRef, 5);
    await closeGroupBuyCampaignAndComputeRefunds({ campaignId: campaign.id, closedBy: "staff" });
    const refund = await prisma.groupBuyRefund.findFirstOrThrow({ where: { campaignId: campaign.id } });
    await releaseRefundForShipping({ refundId: refund.id, actor: "staff" });
    await approveGroupBuyRefund({ refundId: refund.id, actor: "staff:reviewer" });
    return refund;
  }

  it("issues via the recording port and records the processor reference", async () => {
    const refund = await approvedAndReleasedRefund();
    const port = new RecordingGroupBuyRefundExecutionPort();

    const issued = await executeGroupBuyRefund(refund.id, "staff", { port });

    expect(issued.status).toBe("issued");
    expect(issued.processorReference).toBe(port.result.reference);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]).toMatchObject({ orderGid: refund.orderRef, lineItemGid: refund.lineRef, totalAmountMinorUnits: refund.refundAmountMinorUnits });
  });

  it("a definitive Shopify rejection marks the refund failed, and a genuine retry mints a fresh idempotency key", async () => {
    const refund = await approvedAndReleasedRefund();
    const port = new RecordingGroupBuyRefundExecutionPort();
    port.error = new AdminApiError("refundCreate", ["insufficient funds on gateway"]);

    await expect(executeGroupBuyRefund(refund.id, "staff", { port })).rejects.toThrow(AdminApiError);
    const afterFailure = await prisma.groupBuyRefund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(afterFailure.status).toBe("failed");
    expect(afterFailure.failureReason).toMatch(/insufficient funds/i);

    port.error = null;
    const issued = await executeGroupBuyRefund(refund.id, "staff", { port });
    expect(issued.status).toBe("issued");
    expect(port.calls).toHaveLength(2); // a genuinely new attempt, not a blocked replay
  });

  it("an ambiguous (non-AdminApiError) failure leaves the refund at 'processing', never 'failed' — it might have already succeeded", async () => {
    const refund = await approvedAndReleasedRefund();
    const port = new RecordingGroupBuyRefundExecutionPort();
    port.error = new Error("socket hang up");

    await expect(executeGroupBuyRefund(refund.id, "staff", { port })).rejects.toThrow(/socket hang up/);

    const afterFailure = await prisma.groupBuyRefund.findUniqueOrThrow({ where: { id: refund.id } });
    expect(afterFailure.status).toBe("processing");
    expect(afterFailure.failureReason).toBeNull();
  });

  it("the production adapter refuses every call (unverified mutation shape) and is classified a definitive failure, not in_doubt", async () => {
    const refund = await approvedAndReleasedRefund();
    const dummyClient = { graphql: async () => ({ json: async () => ({}) }) };
    const port = new ShopifyGroupBuyRefundExecutionAdapter(dummyClient);

    await expect(executeGroupBuyRefund(refund.id, "staff", { port })).rejects.toThrow(
      GroupBuyRefundExecutionNotImplementedError
    );

    const afterFailure = await prisma.groupBuyRefund.findUniqueOrThrow({ where: { id: refund.id } });
    // A DEFINITIVE failure (no network call was ever made), not in_doubt —
    // safe to retry once a verified adapter replaces this stub.
    expect(afterFailure.status).toBe("failed");
  });

  it("refuses to execute an unapproved refund, even if released for shipping", async () => {
    const variant = await heaviestVariant();
    const campaign = await draftCampaign(variant.id);
    await openGroupBuyCampaign({ campaignId: campaign.id, openedBy: "staff", asOf: ASOF });
    const orderRef = await createBankPaymentOrder({
      campaignId: campaign.id,
      masterVariantId: variant.id,
      quotedBankPaymentPriceMinorUnits: 1_000_00n,
    });
    await purchase(campaign.id, variant.id, orderRef, 5);
    await closeGroupBuyCampaignAndComputeRefunds({ campaignId: campaign.id, closedBy: "staff" });
    const refund = await prisma.groupBuyRefund.findFirstOrThrow({ where: { campaignId: campaign.id } });
    await releaseRefundForShipping({ refundId: refund.id, actor: "staff" });

    const port = new RecordingGroupBuyRefundExecutionPort();
    await expect(executeGroupBuyRefund(refund.id, "staff", { port })).rejects.toThrow(RefundNotApprovedError);
    expect(port.calls).toHaveLength(0);
  });

  it("advanceApprovedGroupBuyRefundToProcessing supports the manual 'record what I did in Shopify Admin' fallback path", async () => {
    const refund = await approvedAndReleasedRefund();

    const advanced = await advanceApprovedGroupBuyRefundToProcessing(refund.id, "staff");
    expect(advanced.status).toBe("processing");
  });
});
