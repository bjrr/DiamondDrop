import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { listAuditEventsForEntity } from "~/db/repositories/auditEventRepository.server";
import {
  BankPaymentOrderNotOpenForVerificationError,
  checkLinesAvailability,
  loadBankPaymentOrderForVerification,
  searchBankPaymentOrders,
  verifyAndCompleteBankPaymentOrder,
  type LineAvailability,
} from "~/domain/bankpayment/verification.server";
import { validateVerificationSubmission, type VerificationSubmission } from "~/domain/bankpayment/verification";
import type { AdminGraphqlClient } from "~/shopify/admin/productClient.server";
import type {
  CompleteDraftOrderInput,
  CompletedDraftOrder,
  DraftOrderPort,
} from "~/shopify/admin/draftOrderAdapter.server";

/**
 * Phase 2C-c, the verification admin surface's database/Shopify-facing half
 * (spec §5.4/§14 criteria 87-91, 103-104). Shopify's Admin API is faked on
 * both sides this module talks to it: `fakeDraftOrderPort` for completion
 * (mirrors `completeOrder.test.ts`), and `fakeAdminClient` for the
 * `availableForSale` re-check (mirrors `variantAvailability.test.ts`'s own
 * fake shape) — `write_draft_orders` access and live availability are
 * exercised for real only in the live gate, not here.
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

const SHOP = "caratforus-dev.myshopify.com";

function fakePort(orderGid = "gid://shopify/Order/999") {
  const completeCalls: CompleteDraftOrderInput[] = [];
  const port: DraftOrderPort = {
    async createDraftOrder() {
      throw new Error("not used");
    },
    async sendInvoice() {
      throw new Error("not used");
    },
    async completeDraftOrder(input): Promise<CompletedDraftOrder> {
      completeCalls.push(input);
      return { orderGid, orderName: "#2001" };
    },
    async cancelDraftOrder() {
      throw new Error("not used");
    },
  };
  return { port, completeCalls };
}

function fakeAdminClient(availabilityByGid: Record<string, boolean>): AdminGraphqlClient {
  return {
    async graphql() {
      return {
        async json() {
          return {
            data: {
              nodes: Object.entries(availabilityByGid).map(([id, availableForSale]) => ({ id, availableForSale })),
            },
          };
        },
      };
    },
  };
}

interface FixtureLine {
  quantity?: number;
  eligibleAtQuoteTime?: boolean;
  quotedBankPaymentPriceMinorUnits?: bigint;
  quotedRegularCardPriceMinorUnits?: bigint;
  hasShopifyVariantGid?: boolean;
}

async function aBankOrder(opts: {
  status?: "open" | "cancelled" | "completed";
  verified?: boolean;
  lines?: FixtureLine[];
  customerEmail?: string;
}) {
  const suffix = uniq();
  const profile = await prisma.pricingProfile.findFirstOrThrow({
    where: { code: "buy_now", isPlaceholder: false },
    orderBy: { version: "desc" },
  });
  const product = await prisma.masterProduct.create({
    data: {
      name: `verification fixture ${suffix}`,
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

  const lineSpecs: FixtureLine[] = opts.lines ?? [{}];
  const lineCreateData = [];
  for (let i = 0; i < lineSpecs.length; i++) {
    const spec = lineSpecs[i]!;
    const variantSuffix = `${suffix}-${i}`;
    const variant = await prisma.masterVariant.create({
      data: {
        masterProductId: product.id,
        metal: "gold",
        purity: "GOLD_14K",
        baseWeightGrams: "3.0000",
        weightPerFullSizeGrams: "0.0000",
        status: "active",
        laborSource: "india",
        shopifyVariantGid:
          spec.hasShopifyVariantGid === false ? null : `gid://shopify/ProductVariant/${variantSuffix}`,
      },
    });
    const snapshot = await prisma.snapshot.create({
      data: { kind: "pricing.it", payload: {}, contentHash: `verification-${randomUUID()}` },
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
        bankPaymentPriceMinorUnits: spec.quotedBankPaymentPriceMinorUnits ?? 100_000n,
        currency: "USD",
        status: "computed",
      },
    });
    lineCreateData.push({
      masterVariantId: variant.id,
      priceCalculationId: calc.id,
      quantity: spec.quantity ?? 1,
      quotedBankPaymentPriceMinorUnits: spec.quotedBankPaymentPriceMinorUnits ?? 100_000n,
      quotedRegularCardPriceMinorUnits: spec.quotedRegularCardPriceMinorUnits ?? 104_500n,
      currency: "USD",
      eligibleAtQuoteTime: spec.eligibleAtQuoteTime ?? true,
    });
  }

  const now = new Date();
  return prisma.bankPaymentOrder.create({
    data: {
      shopifyDraftOrderGid: `gid://shopify/DraftOrder/${suffix}`,
      customerEmail: opts.customerEmail ?? `verify-${suffix}@example.com`,
      status: opts.status ?? "open",
      quotedAt: now,
      guaranteeExpiresAt: new Date(now.getTime() + 86_400_000),
      ...(opts.status === "cancelled"
        ? { cancelledAt: now, cancellationReason: "integration-test fixture" }
        : {}),
      ...(opts.status === "completed"
        ? { completedAt: now, shopifyOrderGid: `gid://shopify/Order/${suffix}` }
        : {}),
      ...(opts.verified
        ? {
            verifiedPaymentAmountMinorUnits: 100_000n,
            verifiedPaymentCurrency: "USD",
            verifiedPaymentMethod: "zelle",
            verifiedPaymentReference: `ref-${suffix}`,
            verifiedAt: now,
            verifiedBy: "earlier-fixture-admin",
          }
        : {}),
      lines: { create: lineCreateData },
    },
    include: { lines: true },
  });
}

function aSubmission(overrides: Partial<VerificationSubmission> = {}): VerificationSubmission {
  const result = validateVerificationSubmission({
    // Dollars and cents, as a bank statement shows it — 1000.00 is 100_000
    // minor units. The form no longer asks staff to do that conversion.
    amountReceived: "1000.00",
    currency: "usd",
    method: "zelle",
    reference: "REF-1",
    verifiedBy: "Jordan Lee",
  });
  if (!result.ok) throw new Error("fixture submission failed to validate");
  return { ...result.value, ...overrides };
}

describe("loadBankPaymentOrderForVerification", () => {
  it("returns null for an unknown id", async () => {
    expect(await loadBankPaymentOrderForVerification(randomUUID())).toBeNull();
  });

  it("returns the order with product/variant labels and the charged unit price per line", async () => {
    const order = await aBankOrder({
      lines: [
        { quantity: 2, eligibleAtQuoteTime: true, quotedBankPaymentPriceMinorUnits: 100_000n, quotedRegularCardPriceMinorUnits: 105_000n },
        { quantity: 1, eligibleAtQuoteTime: false, quotedBankPaymentPriceMinorUnits: 50_000n, quotedRegularCardPriceMinorUnits: 52_500n },
      ],
    });

    const detail = await loadBankPaymentOrderForVerification(order.id);
    expect(detail).not.toBeNull();
    expect(detail!.customerEmail).toBe(order.customerEmail);
    expect(detail!.lines).toHaveLength(2);
    expect(detail!.lines[0]).toMatchObject({ quantity: 2, eligibleAtQuoteTime: true, chargedUnitPriceMinorUnits: 100_000n });
    expect(detail!.lines[1]).toMatchObject({ quantity: 1, eligibleAtQuoteTime: false, chargedUnitPriceMinorUnits: 52_500n });
    expect(detail!.lines[0]!.productTitle).toContain("verification fixture");
    expect(detail!.lines[0]!.variantLabel).toBe("gold GOLD_14K");
  });

  it("never surfaces cost, margin or landed-cost data on the line view", async () => {
    const order = await aBankOrder({});
    const detail = await loadBankPaymentOrderForVerification(order.id);
    const serialized = JSON.stringify(detail, (_key, value) => (typeof value === "bigint" ? value.toString() : value));
    expect(serialized.toLowerCase()).not.toContain("landedcost");
    expect(serialized.toLowerCase()).not.toContain("margin");
  });
});

describe("checkLinesAvailability — criterion 103", () => {
  it("re-queries availableForSale live and maps it back per line", async () => {
    const admin = fakeAdminClient({ "gid://shopify/ProductVariant/a": true, "gid://shopify/ProductVariant/b": false });
    const result = await checkLinesAvailability(admin, [
      { masterVariantId: "mv-a", shopifyVariantGid: "gid://shopify/ProductVariant/a" },
      { masterVariantId: "mv-b", shopifyVariantGid: "gid://shopify/ProductVariant/b" },
    ]);
    expect(result).toEqual<LineAvailability[]>([
      { masterVariantId: "mv-a", shopifyVariantGid: "gid://shopify/ProductVariant/a", availableForSale: true },
      { masterVariantId: "mv-b", shopifyVariantGid: "gid://shopify/ProductVariant/b", availableForSale: false },
    ]);
  });

  it("reports null (not true) for a line with no Shopify variant gid on file", async () => {
    const admin = fakeAdminClient({});
    const result = await checkLinesAvailability(admin, [{ masterVariantId: "mv-x", shopifyVariantGid: null }]);
    expect(result).toEqual<LineAvailability[]>([{ masterVariantId: "mv-x", shopifyVariantGid: null, availableForSale: null }]);
  });

  it("reports null (not true) when Shopify's answer omits the id entirely", async () => {
    const admin = fakeAdminClient({});
    const result = await checkLinesAvailability(admin, [
      { masterVariantId: "mv-y", shopifyVariantGid: "gid://shopify/ProductVariant/missing" },
    ]);
    expect(result[0]!.availableForSale).toBeNull();
  });

  it("makes no Admin API call at all when every line lacks a gid", async () => {
    let called = false;
    const admin: AdminGraphqlClient = {
      async graphql() {
        called = true;
        return { async json() { return { data: { nodes: [] } }; } };
      },
    };
    await checkLinesAvailability(admin, [{ masterVariantId: "mv-z", shopifyVariantGid: null }]);
    expect(called).toBe(false);
  });
});

describe("searchBankPaymentOrders — locating an order", () => {
  it("a blank query lists open orders, newest first", async () => {
    const older = await aBankOrder({ status: "open" });
    await new Promise((resolve) => setTimeout(resolve, 5));
    const newer = await aBankOrder({ status: "open" });
    const completedOrder = await aBankOrder({ status: "completed", verified: true });

    const results = await searchBankPaymentOrders("");
    const ids = results.map((r) => r.id);
    expect(ids).toContain(older.id);
    expect(ids).toContain(newer.id);
    expect(ids).not.toContain(completedOrder.id);
    expect(ids.indexOf(newer.id)).toBeLessThan(ids.indexOf(older.id));
  });

  it("matches by customer email, case-insensitively", async () => {
    const order = await aBankOrder({ customerEmail: `Locate-${uniq()}@Example.com` });
    const results = await searchBankPaymentOrders(order.customerEmail.toLowerCase());
    expect(results.map((r) => r.id)).toContain(order.id);
  });

  it("matches by the Shopify draft order gid", async () => {
    const order = await aBankOrder({});
    const results = await searchBankPaymentOrders(order.shopifyDraftOrderGid);
    expect(results.map((r) => r.id)).toEqual([order.id]);
  });

  it("matches by this app's own order id when it parses as a UUID", async () => {
    const order = await aBankOrder({});
    const results = await searchBankPaymentOrders(order.id);
    expect(results.map((r) => r.id)).toContain(order.id);
  });

  it("a non-UUID, non-matching query returns nothing rather than throwing", async () => {
    const results = await searchBankPaymentOrders("not-a-real-order-at-all");
    expect(results).toEqual([]);
  });
});

describe("verifyAndCompleteBankPaymentOrder", () => {
  it("persists every submitted field, writes a verified audit event, and completes the order through the proven path", async () => {
    const order = await aBankOrder({});
    const { port, completeCalls } = fakePort("gid://shopify/Order/700001");
    const submission = aSubmission({ amountReceivedMinorUnits: 100_000n, currency: "USD", reference: "REF-700" });

    const result = await verifyAndCompleteBankPaymentOrder({
      bankPaymentOrderId: order.id,
      submission,
      shop: SHOP,
      draftOrderPort: port,
      availabilityShownToAdmin: [
        { masterVariantId: order.lines[0]!.masterVariantId, shopifyVariantGid: "gid://shopify/ProductVariant/x", availableForSale: true },
      ],
    });

    expect(result.outcome).toBe("verified_and_completed");
    expect(result.shopifyOrderGid).toBe("gid://shopify/Order/700001");
    expect(completeCalls).toEqual([{ draftOrderGid: order.shopifyDraftOrderGid }]);

    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.verifiedPaymentAmountMinorUnits).toBe(100_000n);
    expect(after.verifiedPaymentCurrency).toBe("USD");
    expect(after.verifiedPaymentMethod).toBe("zelle");
    expect(after.verifiedPaymentReference).toBe("REF-700");
    expect(after.verifiedBy).toBe("Jordan Lee");
    expect(after.verifiedAt).not.toBeNull();
    expect(after.status).toBe("completed");
    expect(after.shopifyOrderGid).toBe("gid://shopify/Order/700001");

    const events = await listAuditEventsForEntity("bank_payment_order", order.id);
    const actions = events.map((e) => e.action);
    expect(actions).toContain("bank_payment_order.verified");
    expect(actions).toContain("bank_payment_order.completed");
    expect(actions.filter((a) => a === "bank_payment_order.verified")).toHaveLength(1);
    expect(actions.filter((a) => a === "bank_payment_order.completed")).toHaveLength(1);
    const verifiedEvent = events.find((e) => e.action === "bank_payment_order.verified")!;
    expect(verifiedEvent.actorType).toBe("staff");
    expect(verifiedEvent.actorRef).toBe(SHOP);
    // Never admin-only cost/margin data — only what the customer was quoted and what arrived.
    expect(JSON.stringify(verifiedEvent.after).toLowerCase()).not.toContain("landedcost");
    expect(JSON.stringify(verifiedEvent.after).toLowerCase()).not.toContain("margin");
  });

  it("a double submit verifies exactly once and completes exactly once (criterion 88)", async () => {
    const order = await aBankOrder({});
    const { port, completeCalls } = fakePort("gid://shopify/Order/700002");
    const submission = aSubmission();

    const first = await verifyAndCompleteBankPaymentOrder({
      bankPaymentOrderId: order.id,
      submission,
      shop: SHOP,
      draftOrderPort: port,
      availabilityShownToAdmin: [],
    });
    const second = await verifyAndCompleteBankPaymentOrder({
      bankPaymentOrderId: order.id,
      // A second admin submits DIFFERENT numbers — must NOT overwrite the first verification.
      submission: aSubmission({ amountReceivedMinorUnits: 999_999n, verifiedBy: "A Different Admin" }),
      shop: SHOP,
      draftOrderPort: port,
      availabilityShownToAdmin: [],
    });

    expect(first.outcome).toBe("verified_and_completed");
    expect(second.outcome).toBe("already_verified");
    expect(second.shopifyOrderGid).toBe(first.shopifyOrderGid);
    expect(completeCalls).toHaveLength(1);

    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.verifiedPaymentAmountMinorUnits).toBe(100_000n); // the FIRST submission's amount, not the second's
    expect(after.verifiedBy).toBe("Jordan Lee");

    const events = await listAuditEventsForEntity("bank_payment_order", order.id);
    const actions = events.map((e) => e.action);
    expect(actions.filter((a) => a === "bank_payment_order.verified")).toHaveLength(1);
    expect(actions.filter((a) => a === "bank_payment_order.completed")).toHaveLength(1);
    expect(actions.filter((a) => a === "bank_payment_order.verify_duplicate_ignored")).toHaveLength(1);
  });

  it("two concurrent submissions verify exactly once and complete exactly once", async () => {
    const order = await aBankOrder({});
    const { port, completeCalls } = fakePort("gid://shopify/Order/700003");

    const [a, b] = await Promise.all([
      verifyAndCompleteBankPaymentOrder({
        bankPaymentOrderId: order.id,
        submission: aSubmission({ verifiedBy: "Admin A" }),
        shop: SHOP,
        draftOrderPort: port,
        availabilityShownToAdmin: [],
      }),
      verifyAndCompleteBankPaymentOrder({
        bankPaymentOrderId: order.id,
        submission: aSubmission({ verifiedBy: "Admin B" }),
        shop: SHOP,
        draftOrderPort: port,
        availabilityShownToAdmin: [],
      }),
    ]);

    expect(a.shopifyOrderGid).toBe(b.shopifyOrderGid);
    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("completed");
    expect(["Admin A", "Admin B"]).toContain(after.verifiedBy);
    // completeBankPaymentOrder's own compare-and-set guarantees one STORED
    // gid; both callers may reach the port in a genuine race (see
    // completeOrder.test.ts's identical assertion).
    expect(completeCalls.length).toBeGreaterThanOrEqual(1);

    const events = await listAuditEventsForEntity("bank_payment_order", order.id);
    expect(events.filter((e) => e.action === "bank_payment_order.verified")).toHaveLength(1);
    expect(events.filter((e) => e.action === "bank_payment_order.completed")).toHaveLength(1);
  });

  it("a sold-out line is recorded in the verify audit event but does NOT block verification (criterion 104)", async () => {
    const order = await aBankOrder({});
    const { port } = fakePort("gid://shopify/Order/700004");

    const result = await verifyAndCompleteBankPaymentOrder({
      bankPaymentOrderId: order.id,
      submission: aSubmission(),
      shop: SHOP,
      draftOrderPort: port,
      availabilityShownToAdmin: [
        { masterVariantId: order.lines[0]!.masterVariantId, shopifyVariantGid: "gid://shopify/ProductVariant/sold-out", availableForSale: false },
      ],
    });

    expect(result.outcome).toBe("verified_and_completed");
    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("completed");

    const events = await listAuditEventsForEntity("bank_payment_order", order.id);
    const verifiedEvent = events.find((e) => e.action === "bank_payment_order.verified")!;
    expect(verifiedEvent.after).toMatchObject({
      availabilityShownToAdmin: [{ availableForSale: false }],
    });
  });

  it("refuses to verify a cancelled order, and writes no audit event", async () => {
    const order = await aBankOrder({ status: "cancelled" });
    const { port, completeCalls } = fakePort();

    await expect(
      verifyAndCompleteBankPaymentOrder({
        bankPaymentOrderId: order.id,
        submission: aSubmission(),
        shop: SHOP,
        draftOrderPort: port,
        availabilityShownToAdmin: [],
      })
    ).rejects.toBeInstanceOf(BankPaymentOrderNotOpenForVerificationError);

    expect(completeCalls).toHaveLength(0);
    const events = await listAuditEventsForEntity("bank_payment_order", order.id);
    expect(events).toHaveLength(0);
    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.verifiedAt).toBeNull();
  });
});
