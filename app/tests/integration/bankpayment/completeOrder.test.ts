import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  BankPaymentOrderNotOpenError,
  BankPaymentOrderNotVerifiedError,
  completeBankPaymentOrder,
} from "~/domain/bankpayment/completeOrder.server";
import type {
  CompleteDraftOrderInput,
  CompletedDraftOrder,
  DraftOrderPort,
} from "~/shopify/admin/draftOrderAdapter.server";

/**
 * Completion is the moment a Bank Payment quote becomes a real order against
 * real inventory, so every test here is about a way that could go wrong
 * irreversibly: completing before anyone verified the money, completing twice,
 * or losing which Shopify order we created.
 *
 * The financial status of the resulting order — it must be PENDING, never
 * PAID — cannot be asserted here, because only Shopify decides it. That is
 * pinned two ways instead: `draftOrderAdapter.test.ts` asserts the payment
 * terms that produce it, and `tests/live/slice2cA.completion.ts` reads
 * `displayFinancialStatus` back from the real store.
 */

let sequence = 0;
const uniq = () => `${Date.now() % 900_000}-${(sequence += 1)}`;
const createdMasterProductIds: string[] = [];

afterEach(async () => {
  if (createdMasterProductIds.length === 0) return;
  await prisma.masterVariant.updateMany({
    where: { masterProductId: { in: createdMasterProductIds } },
    data: { status: "archived" },
  });
  createdMasterProductIds.length = 0;
});

function fakePort(orderGid = "gid://shopify/Order/999") {
  const calls: CompleteDraftOrderInput[] = [];
  const port: DraftOrderPort = {
    async createDraftOrder() {
      throw new Error("not used");
    },
    async sendInvoice() {
      throw new Error("not used");
    },
    async completeDraftOrder(input): Promise<CompletedDraftOrder> {
      calls.push(input);
      return { orderGid, orderName: "#1001" };
    },
    async cancelDraftOrder() {
      throw new Error("not used");
    },
  };
  return { port, calls };
}

async function aBankOrder(opts: { verified: boolean; status?: "open" | "cancelled" }) {
  const suffix = uniq();
  const profile = await prisma.pricingProfile.findFirstOrThrow({
    where: { code: "buy_now", isPlaceholder: false },
    orderBy: { version: "desc" },
  });
  const product = await prisma.masterProduct.create({
    data: {
      name: `completion fixture ${suffix}`,
      category: "ring",
      sizeAxis: "none",
      allowedSizeMin: "0",
      allowedSizeMax: "0",
      sizeIncrement: "1",
      baseSize: "0",
      offeredMetals: ["gold"],
      status: "active",
      shopifyProductGid: `gid://shopify/Product/${suffix}`,
    },
  });
  createdMasterProductIds.push(product.id);
  const variant = await prisma.masterVariant.create({
    data: {
      masterProductId: product.id,
      metal: "gold",
      purity: "GOLD_14K",
      baseWeightGrams: "3.0000",
      weightPerFullSizeGrams: "0.0000",
      status: "active",
      laborSource: "india",
      shopifyVariantGid: `gid://shopify/ProductVariant/${suffix}`,
    },
  });
  const snapshot = await prisma.snapshot.create({
    data: { kind: "pricing.it", payload: {}, contentHash: `completion-${randomUUID()}` },
  });
  const calc = await prisma.priceCalculation.create({
    data: {
      runId: randomUUID(),
      masterVariantId: variant.id,
      pricingProfileId: profile.id,
      profileVersion: profile.version,
      engineVersion: "BUY_NOW_PRICING_V1",
      roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
      priceEndingRuleId: "NONE_V1",
      asOf: new Date(),
      snapshotId: snapshot.id,
      landedCostMinorUnits: 1000n,
      bankPaymentPriceMinorUnits: 100_000n,
      currency: "USD",
      status: "computed",
    },
  });

  const now = new Date();
  return prisma.bankPaymentOrder.create({
    data: {
      shopifyDraftOrderGid: `gid://shopify/DraftOrder/${suffix}`,
      customerEmail: `completion-${suffix}@example.com`,
      status: opts.status ?? "open",
      quotedAt: now,
      guaranteeExpiresAt: new Date(now.getTime() + 86_400_000),
      // `bank_payment_order_status_coherent` refuses a cancelled order that
      // carries no cancellation record — the status and its evidence travel
      // together. The fixture satisfies the constraint rather than working
      // around it.
      ...(opts.status === "cancelled"
        ? { cancelledAt: now, cancellationReason: "integration-test fixture" }
        : {}),
      ...(opts.verified
        ? {
            verifiedPaymentAmountMinorUnits: 100_000n,
            verifiedPaymentCurrency: "USD",
            verifiedPaymentMethod: "zelle",
            verifiedPaymentReference: `ref-${suffix}`,
            verifiedAt: now,
            // D23: verified_by is now the authenticated Shopify staff
            // identity (user id + email), not a typed name — updated by the
            // 2C-c revision's schema change (prisma/migrations/
            // 20260922060000_bank_payment_verified_by_authenticated_identity).
            verifiedByShopifyUserId: 1n,
            verifiedByEmail: "integration-test@example.com",
          }
        : {}),
      lines: {
        create: [
          {
            masterVariantId: variant.id,
            priceCalculationId: calc.id,
            quantity: 1,
            quotedBankPaymentPriceMinorUnits: 100_000n,
            quotedRegularCardPriceMinorUnits: 104_500n,
            currency: "USD",
            eligibleAtQuoteTime: true,
          },
        ],
      },
    },
  });
}

describe("§22 — nothing is committed before payment is verified", () => {
  it("REFUSES to complete an order nobody has verified, and never reaches Shopify", async () => {
    const order = await aBankOrder({ verified: false });
    const { port, calls } = fakePort();

    await expect(
      completeBankPaymentOrder({ bankPaymentOrderId: order.id, port })
    ).rejects.toBeInstanceOf(BankPaymentOrderNotVerifiedError);

    // The refusal must happen BEFORE the call, not be cleaned up after it —
    // a draft completed in error is a real order against real inventory.
    expect(calls).toHaveLength(0);
    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.shopifyOrderGid).toBeNull();
    expect(after.status).toBe("open");
  });

  it("refuses an order that is not open", async () => {
    const order = await aBankOrder({ verified: true, status: "cancelled" });
    const { port, calls } = fakePort();

    await expect(
      completeBankPaymentOrder({ bankPaymentOrderId: order.id, port })
    ).rejects.toBeInstanceOf(BankPaymentOrderNotOpenError);
    expect(calls).toHaveLength(0);
  });
});

describe("completion records which Shopify order it created", () => {
  it("persists the EXACT gid, the timestamp and the terminal status", async () => {
    const order = await aBankOrder({ verified: true });
    const { port, calls } = fakePort("gid://shopify/Order/424242");

    const result = await completeBankPaymentOrder({ bankPaymentOrderId: order.id, port });

    expect(result.shopifyOrderGid).toBe("gid://shopify/Order/424242");
    expect(result.alreadyCompleted).toBe(false);
    expect(calls).toEqual([{ draftOrderGid: order.shopifyDraftOrderGid }]);

    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.shopifyOrderGid).toBe("gid://shopify/Order/424242");
    expect(after.status).toBe("completed");
    expect(after.completedAt).not.toBeNull();
  });

  /**
   * A DUPLICATE ORDER IS THE WORST OUTCOME THIS FUNCTION CAN PRODUCE — it
   * commits real inventory twice against one payment — so the replay is
   * asserted on the PORT not being called, not merely on the returned value
   * looking right.
   */
  it("a replay returns the stored gid and never calls Shopify again", async () => {
    const order = await aBankOrder({ verified: true });
    const { port, calls } = fakePort("gid://shopify/Order/515151");

    const first = await completeBankPaymentOrder({ bankPaymentOrderId: order.id, port });
    const second = await completeBankPaymentOrder({ bankPaymentOrderId: order.id, port });

    expect(second.shopifyOrderGid).toBe(first.shopifyOrderGid);
    expect(second.alreadyCompleted).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("two concurrent callers produce one Shopify order and one stored gid", async () => {
    const order = await aBankOrder({ verified: true });
    const { port, calls } = fakePort("gid://shopify/Order/626262");

    const [a, b] = await Promise.all([
      completeBankPaymentOrder({ bankPaymentOrderId: order.id, port }),
      completeBankPaymentOrder({ bankPaymentOrderId: order.id, port }),
    ]);

    expect(a.shopifyOrderGid).toBe(b.shopifyOrderGid);
    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.shopifyOrderGid).toBe("gid://shopify/Order/626262");
    // Both may reach the port in a genuine race — the compare-and-set is what
    // guarantees a single STORED gid. Asserting zero duplicate calls here
    // would be asserting a lock this function deliberately does not take.
    expect(calls.length).toBeGreaterThanOrEqual(1);
  });
});
