import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { listAuditEventsForEntity } from "~/db/repositories/auditEventRepository.server";
import {
  GroupBuyBankPaymentOrderCampaignNotOpenError,
  reactivateGroupBuyBankPaymentOrder,
} from "~/db/repositories/groupBuyBankPaymentOrderRepository.server";
import { runGroupBuyBankPaymentInactivationSweep } from "~/jobs/bankpayment/groupBuyBankPaymentInactivationSweep.server";
import { openGroupBuyCampaign } from "~/jobs/groupbuy/openCampaign.server";
import { closeGroupBuyCampaign } from "~/jobs/groupbuy/unitLedger.server";

/**
 * The 96-hour inactivation sweep and staff reactivation (owner §24/§26).
 * Money-critical in the sense that guards a customer's payment window, not
 * that it moves money itself — no Shopify calls are exercised here (the
 * checkout route's own suite already proves the ordering/completion path);
 * this file proves the TIME-DRIVEN state machine layered on top of it, and
 * the campaign-open gate on reactivation, against real Postgres.
 */

const ASOF = new Date("2026-09-27T00:00:00Z");
let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;
let numericSeq = 1;
function nextNumericId(): string {
  numericSeq += 1;
  return `${Date.now()}${numericSeq}`;
}

const createdMasterProductIds: string[] = [];

afterEach(async () => {
  if (createdMasterProductIds.length === 0) return;
  await prisma.masterVariant.updateMany({
    where: { masterProductId: { in: createdMasterProductIds } },
    data: { status: "archived" },
  });
  createdMasterProductIds.length = 0;
});

async function createGroupBuyVariant() {
  const product = await prisma.masterProduct.create({
    data: {
      name: `gb-bank-lifecycle fixture ${uniq()}`,
      category: "ring",
      sizeAxis: "none",
      allowedSizeMin: "0",
      allowedSizeMax: "0",
      sizeIncrement: "1",
      baseSize: "0",
      offeredMetals: ["gold"],
      status: "active",
    },
  });
  createdMasterProductIds.push(product.id);

  const variant = await prisma.masterVariant.create({
    data: {
      masterProductId: product.id,
      metal: "gold",
      purity: "GOLD_14K",
      baseWeightGrams: "50.0000",
      weightPerFullSizeGrams: "0.0000",
      status: "active",
      laborSource: "india",
      shopifyVariantGid: `gid://shopify/ProductVariant/${nextNumericId()}`,
      isLuxurySteal: true,
    },
  });
  return variant;
}

async function openCampaignFixture(masterVariantId: string) {
  const campaign = await prisma.groupBuyCampaign.create({
    data: {
      code: `gb-bank-lifecycle-${uniq()}`,
      name: "group buy bank lifecycle fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: {
        create: [
          { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
          { tierNumber: 2, minQualifyingUnits: 5, priceMultiplier: "0.990000" },
        ],
      },
      variants: {
        create: [{ masterVariantId, frozenBaseBankPaymentPriceMinorUnits: 200_000n, frozenLandedCostMinorUnits: 100_000n }],
      },
    },
  });
  await openGroupBuyCampaign({ campaignId: campaign.id, openedBy: "staff", asOf: ASOF });
  return campaign;
}

/** Inserts a `GroupBuyBankPaymentOrder` header row directly — this file tests the LIFECYCLE state machine, not the checkout route that normally creates one. */
async function createOrderRow(input: {
  campaignId: string;
  quotedAt: Date;
  status?: "active" | "inactive";
  reactivatedAt?: Date | null;
}) {
  return prisma.groupBuyBankPaymentOrder.create({
    data: {
      campaignId: input.campaignId,
      shopifyDraftOrderGid: `gid://shopify/DraftOrder/${randomUUID()}`,
      shopifyOrderGid: `gid://shopify/Order/${randomUUID()}`,
      customerEmail: `buyer-${uniq()}@example.com`,
      customerGid: `gid://shopify/Customer/${nextNumericId()}`,
      tierNumberAtQuote: 1,
      quotedAt: input.quotedAt,
      status: input.status ?? "active",
      reactivatedAt: input.reactivatedAt ?? null,
    },
  });
}

describe("runGroupBuyBankPaymentInactivationSweep", () => {
  it("keeps an order active before the 96-hour deadline", async () => {
    const variant = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const quotedAt = new Date("2026-09-20T00:00:00Z");
    const order = await createOrderRow({ campaignId: campaign.id, quotedAt });

    const now = new Date(quotedAt.getTime() + 95 * 60 * 60 * 1000); // 95h — one hour short
    const summary = await runGroupBuyBankPaymentInactivationSweep({ now });

    expect(summary.kept).toBeGreaterThanOrEqual(1);
    const stored = await prisma.groupBuyBankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.status).toBe("active");
    expect(stored.inactivatedAt).toBeNull();
  });

  it("inactivates an order at/after the 96-hour deadline, and records evidence", async () => {
    const variant = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const quotedAt = new Date("2026-09-20T00:00:00Z");
    const order = await createOrderRow({ campaignId: campaign.id, quotedAt });

    const now = new Date(quotedAt.getTime() + 96 * 60 * 60 * 1000);
    const summary = await runGroupBuyBankPaymentInactivationSweep({ now });

    expect(summary.inactivated).toBeGreaterThanOrEqual(1);
    const stored = await prisma.groupBuyBankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.status).toBe("inactive");
    expect(stored.inactivatedAt).toEqual(now);

    const events = await listAuditEventsForEntity("group_buy_bank_payment_order", order.id);
    expect(events.some((e) => e.action === "groupbuy_bank_payment.inactivated")).toBe(true);
  });

  it("a reactivation resets the clock — the SAME now that is overdue against the original quote is not overdue against a later reactivation", async () => {
    const variant = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const quotedAt = new Date("2026-09-01T00:00:00Z");
    const reactivatedAt = new Date("2026-09-25T00:00:00Z");
    const order = await createOrderRow({ campaignId: campaign.id, quotedAt, reactivatedAt });

    // Long past 96h from quotedAt, but well within 96h of reactivatedAt.
    const now = new Date(reactivatedAt.getTime() + 1 * 60 * 60 * 1000);
    await runGroupBuyBankPaymentInactivationSweep({ now });

    const stored = await prisma.groupBuyBankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.status).toBe("active");
  });

  it("is idempotent under two concurrent/overlapping runs — no duplicate evidence, one inactivation", async () => {
    const variant = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const quotedAt = new Date("2026-09-01T00:00:00Z");
    const order = await createOrderRow({ campaignId: campaign.id, quotedAt });

    const now = new Date(quotedAt.getTime() + 200 * 60 * 60 * 1000);
    const [a, b] = await Promise.all([
      runGroupBuyBankPaymentInactivationSweep({ now }),
      runGroupBuyBankPaymentInactivationSweep({ now }),
    ]);

    expect(a.errored).toBe(0);
    expect(b.errored).toBe(0);

    const stored = await prisma.groupBuyBankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.status).toBe("inactive");

    const events = (await listAuditEventsForEntity("group_buy_bank_payment_order", order.id)).filter(
      (e) => e.action === "groupbuy_bank_payment.inactivated"
    );
    expect(events).toHaveLength(1);
  });

  it("one run evaluates every active order independently — an overdue order flips while a fresh one does not", async () => {
    const variant = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const now = new Date("2026-09-27T00:00:00Z");
    const overdue = await createOrderRow({ campaignId: campaign.id, quotedAt: new Date(now.getTime() - 200 * 60 * 60 * 1000) });
    const fresh = await createOrderRow({ campaignId: campaign.id, quotedAt: new Date(now.getTime() - 1 * 60 * 60 * 1000) });

    const summary = await runGroupBuyBankPaymentInactivationSweep({ now });

    expect(summary.errored).toBe(0);
    const storedOverdue = await prisma.groupBuyBankPaymentOrder.findUniqueOrThrow({ where: { id: overdue.id } });
    const storedFresh = await prisma.groupBuyBankPaymentOrder.findUniqueOrThrow({ where: { id: fresh.id } });
    expect(storedOverdue.status).toBe("inactive");
    expect(storedFresh.status).toBe("active");
  });
});

describe("reactivateGroupBuyBankPaymentOrder", () => {
  it("reactivates an inactive order while its campaign is open — same order, price columns untouched", async () => {
    const variant = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const quotedAt = new Date("2026-09-01T00:00:00Z");
    const order = await createOrderRow({ campaignId: campaign.id, quotedAt, status: "inactive" });

    const result = await reactivateGroupBuyBankPaymentOrder({
      groupBuyBankPaymentOrderId: order.id,
      staffIdentity: "staff@caratforus.example",
      now: new Date("2026-09-28T00:00:00Z"),
    });

    expect(result.alreadyActive).toBe(false);
    expect(result.order.status).toBe("active");
    expect(result.order.reactivatedAt).toEqual(new Date("2026-09-28T00:00:00Z"));
    expect(result.order.reactivatedBy).toBe("staff@caratforus.example");
    expect(result.order.reactivationCount).toBe(1);
    // Never touched:
    expect(result.order.shopifyDraftOrderGid).toBe(order.shopifyDraftOrderGid);
    expect(result.order.shopifyOrderGid).toBe(order.shopifyOrderGid);
    expect(result.order.tierNumberAtQuote).toBe(order.tierNumberAtQuote);

    const events = await listAuditEventsForEntity("group_buy_bank_payment_order", order.id);
    expect(events.some((e) => e.action === "groupbuy_bank_payment.reactivated")).toBe(true);
  });

  it("is idempotent — reactivating an already-active order is a successful no-op, not an error", async () => {
    const variant = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const order = await createOrderRow({ campaignId: campaign.id, quotedAt: new Date(), status: "active" });

    const result = await reactivateGroupBuyBankPaymentOrder({
      groupBuyBankPaymentOrderId: order.id,
      staffIdentity: "staff@caratforus.example",
    });

    expect(result.alreadyActive).toBe(true);
    expect(result.order.reactivationCount).toBe(0); // untouched — no reactivation actually happened
  });

  it("refuses automatic reactivation once the campaign has closed (owner §26)", async () => {
    const variant = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const order = await createOrderRow({ campaignId: campaign.id, quotedAt: new Date("2026-09-01T00:00:00Z"), status: "inactive" });

    await closeGroupBuyCampaign({ campaignId: campaign.id, closedBy: "staff" });

    await expect(
      reactivateGroupBuyBankPaymentOrder({ groupBuyBankPaymentOrderId: order.id, staffIdentity: "staff@caratforus.example" })
    ).rejects.toBeInstanceOf(GroupBuyBankPaymentOrderCampaignNotOpenError);

    const stored = await prisma.groupBuyBankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(stored.status).toBe("inactive"); // unchanged
  });
});
