import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { listAuditEventsForEntity } from "~/db/repositories/auditEventRepository.server";
import {
  BankPaymentAmountMismatchError,
  BankPaymentOrderNotOpenForVerificationError,
  checkLinesAvailability,
  completeVerifiedBankPaymentOrder,
  loadBankPaymentOrderForVerification,
  resolveDraftOrderResultingOrder,
  searchBankPaymentOrders,
  verifyAndCompleteBankPaymentOrder,
  type LineAvailability,
  type VerifyAndCompleteInput,
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
 * (spec §5.4/§14/§19 criteria 87-91, 103-104, 112-124). Shopify's Admin API
 * is faked on both sides this module talks to it: `fakeDraftOrderPort` for
 * completion (mirrors `completeOrder.test.ts`), and `fakeAdminClient` for
 * BOTH the `availableForSale` re-check (mirrors `variantAvailability.test.ts`'s
 * own fake shape) and D25's `draftOrder { order { id } }` read-before-write
 * check — `write_draft_orders` access and live availability are exercised
 * for real only in the live gate, not here.
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
/** D23 — the authenticated Shopify staff identity every test verifies as. */
const VERIFIER = { verifiedByShopifyUserId: 42n, verifiedByEmail: "jordan@example.com" };

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

/** A port whose completeDraftOrder always throws — D25's completion-failure path. */
function failingPort(message = "Shopify Admin API draftOrderComplete failed: simulated outage") {
  const port: DraftOrderPort = {
    async createDraftOrder() {
      throw new Error("not used");
    },
    async sendInvoice() {
      throw new Error("not used");
    },
    async completeDraftOrder(): Promise<CompletedDraftOrder> {
      throw new Error(message);
    },
    async cancelDraftOrder() {
      throw new Error("not used");
    },
  };
  return port;
}

/**
 * Handles BOTH Admin API shapes this module reads: the `nodes(ids:)`
 * availability query (criterion 103) and the `draftOrder { order { id } }`
 * read-before-write query (criterion 120). Dispatches on the query text
 * rather than requiring a separate fake per call site, since
 * `verifyAndCompleteBankPaymentOrder` now always reaches both in one call.
 */
function fakeAdminClient(
  opts: {
    availabilityByGid?: Record<string, boolean>;
    /** Keyed by draft order gid. Absent key or explicit `null` both mean "Shopify confirms no resulting order yet". */
    draftOrderResultByGid?: Record<string, { orderGid: string; orderName: string | null } | null>;
  } = {}
): AdminGraphqlClient {
  const availabilityByGid = opts.availabilityByGid ?? {};
  const draftOrderResultByGid = opts.draftOrderResultByGid ?? {};
  return {
    async graphql(query: string, options?: { variables?: Record<string, unknown> }) {
      if (query.includes("draftOrder(")) {
        const draftOrderGid = (options?.variables?.id as string) ?? "";
        const result = draftOrderResultByGid[draftOrderGid] ?? null;
        return {
          async json() {
            return {
              data: {
                draftOrder: {
                  id: draftOrderGid,
                  order: result ? { id: result.orderGid, name: result.orderName } : null,
                },
              },
            };
          },
        };
      }
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
            // D23: the authenticated identity, not a typed name.
            verifiedByShopifyUserId: 7n,
            verifiedByEmail: "earlier-fixture-admin@example.com",
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
  });
  if (!result.ok) throw new Error("fixture submission failed to validate");
  return { ...result.value, ...overrides };
}

/** Assembles a full `VerifyAndCompleteInput`, merging the common identity/admin fields with per-test overrides. */
function verifyInput(overrides: Partial<VerifyAndCompleteInput> & Pick<VerifyAndCompleteInput, "bankPaymentOrderId" | "submission" | "draftOrderPort">): VerifyAndCompleteInput {
  return {
    shop: SHOP,
    ...VERIFIER,
    admin: fakeAdminClient(),
    availabilityShownToAdmin: [],
    ...overrides,
  };
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
    const admin = fakeAdminClient({
      availabilityByGid: { "gid://shopify/ProductVariant/a": true, "gid://shopify/ProductVariant/b": false },
    });
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
    const admin = fakeAdminClient();
    const result = await checkLinesAvailability(admin, [{ masterVariantId: "mv-x", shopifyVariantGid: null }]);
    expect(result).toEqual<LineAvailability[]>([{ masterVariantId: "mv-x", shopifyVariantGid: null, availableForSale: null }]);
  });

  it("reports null (not true) when Shopify's answer omits the id entirely", async () => {
    const admin = fakeAdminClient();
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

    const result = await verifyAndCompleteBankPaymentOrder(
      verifyInput({
        bankPaymentOrderId: order.id,
        submission,
        draftOrderPort: port,
        availabilityShownToAdmin: [
          { masterVariantId: order.lines[0]!.masterVariantId, shopifyVariantGid: "gid://shopify/ProductVariant/x", availableForSale: true },
        ],
      })
    );

    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") throw new Error("expected completed");
    expect(result.shopifyOrderGid).toBe("gid://shopify/Order/700001");
    expect(completeCalls).toEqual([{ draftOrderGid: order.shopifyDraftOrderGid }]);

    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.verifiedPaymentAmountMinorUnits).toBe(100_000n);
    expect(after.verifiedPaymentCurrency).toBe("USD");
    expect(after.verifiedPaymentMethod).toBe("zelle");
    expect(after.verifiedPaymentReference).toBe("REF-700");
    expect(after.verifiedByEmail).toBe(VERIFIER.verifiedByEmail);
    expect(after.verifiedByShopifyUserId).toBe(VERIFIER.verifiedByShopifyUserId);
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
    expect(verifiedEvent.actorRef).toContain(VERIFIER.verifiedByEmail);
    expect(verifiedEvent.actorRef).toContain(SHOP);
    // Never admin-only cost/margin data — only what the customer was quoted and what arrived.
    expect(JSON.stringify(verifiedEvent.after).toLowerCase()).not.toContain("landedcost");
    expect(JSON.stringify(verifiedEvent.after).toLowerCase()).not.toContain("margin");
  });

  it("a double submit verifies exactly once and completes exactly once (criterion 88)", async () => {
    const order = await aBankOrder({});
    const { port, completeCalls } = fakePort("gid://shopify/Order/700002");
    const submission = aSubmission();

    const first = await verifyAndCompleteBankPaymentOrder(
      verifyInput({ bankPaymentOrderId: order.id, submission, draftOrderPort: port })
    );
    const second = await verifyAndCompleteBankPaymentOrder(
      verifyInput({
        bankPaymentOrderId: order.id,
        // A second admin submits the SAME amount (a mismatched amount would
        // now be refused before reaching the duplicate check at all — see
        // the D24 describe block) but a different identity — must NOT
        // overwrite the first verification.
        submission,
        draftOrderPort: port,
        verifiedByShopifyUserId: 99n,
        verifiedByEmail: "a-different-admin@example.com",
      })
    );

    expect(first.outcome).toBe("completed");
    expect(second.outcome).toBe("completed");
    if (first.outcome !== "completed" || second.outcome !== "completed") throw new Error("expected completed");
    expect(second.shopifyOrderGid).toBe(first.shopifyOrderGid);
    expect(completeCalls).toHaveLength(1);

    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.verifiedByEmail).toBe(VERIFIER.verifiedByEmail); // the FIRST submission's identity, not the second's

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
      verifyAndCompleteBankPaymentOrder(
        verifyInput({ bankPaymentOrderId: order.id, submission: aSubmission(), draftOrderPort: port, verifiedByEmail: "admin-a@example.com" })
      ),
      verifyAndCompleteBankPaymentOrder(
        verifyInput({ bankPaymentOrderId: order.id, submission: aSubmission(), draftOrderPort: port, verifiedByEmail: "admin-b@example.com" })
      ),
    ]);

    expect(a.outcome).toBe("completed");
    expect(b.outcome).toBe("completed");
    if (a.outcome !== "completed" || b.outcome !== "completed") throw new Error("expected completed");
    expect(a.shopifyOrderGid).toBe(b.shopifyOrderGid);
    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("completed");
    expect(["admin-a@example.com", "admin-b@example.com"]).toContain(after.verifiedByEmail);
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

    const result = await verifyAndCompleteBankPaymentOrder(
      verifyInput({
        bankPaymentOrderId: order.id,
        submission: aSubmission(),
        draftOrderPort: port,
        availabilityShownToAdmin: [
          { masterVariantId: order.lines[0]!.masterVariantId, shopifyVariantGid: "gid://shopify/ProductVariant/sold-out", availableForSale: false },
        ],
      })
    );

    expect(result.outcome).toBe("completed");
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
      verifyAndCompleteBankPaymentOrder(
        verifyInput({ bankPaymentOrderId: order.id, submission: aSubmission(), draftOrderPort: port })
      )
    ).rejects.toBeInstanceOf(BankPaymentOrderNotOpenForVerificationError);

    expect(completeCalls).toHaveLength(0);
    const events = await listAuditEventsForEntity("bank_payment_order", order.id);
    expect(events).toHaveLength(0);
    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.verifiedAt).toBeNull();
  });
});

describe("D24 — a mismatched amount refuses BEFORE anything is persisted (criteria 115-117)", () => {
  it("refuses an underpayment, writes only the refusal audit event, and persists nothing", async () => {
    const order = await aBankOrder({}); // expected total: 100_000n minor units
    const { port, completeCalls } = fakePort();
    const submission = aSubmission({ amountReceivedMinorUnits: 90_000n }); // $900 against a $1,000 expectation

    await expect(
      verifyAndCompleteBankPaymentOrder(verifyInput({ bankPaymentOrderId: order.id, submission, draftOrderPort: port }))
    ).rejects.toBeInstanceOf(BankPaymentAmountMismatchError);

    expect(completeCalls).toHaveLength(0);
    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.verifiedAt).toBeNull();
    expect(after.verifiedPaymentAmountMinorUnits).toBeNull();
    expect(after.status).toBe("open");

    const events = await listAuditEventsForEntity("bank_payment_order", order.id);
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("bank_payment_order.verify_amount_mismatch_refused");
    expect(events[0]!.after).toMatchObject({
      expectedMinorUnits: "100000",
      receivedMinorUnits: "90000",
      differenceMinorUnits: "-10000",
      currencyMismatch: false,
    });
  });

  it("refuses an overpayment the same way", async () => {
    const order = await aBankOrder({});
    const { port } = fakePort();
    const submission = aSubmission({ amountReceivedMinorUnits: 110_000n });

    await expect(
      verifyAndCompleteBankPaymentOrder(verifyInput({ bankPaymentOrderId: order.id, submission, draftOrderPort: port }))
    ).rejects.toBeInstanceOf(BankPaymentAmountMismatchError);

    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.verifiedAt).toBeNull();
  });

  it("refuses a currency mismatch even when the numeric amount matches", async () => {
    const order = await aBankOrder({});
    const { port } = fakePort();
    const submission = aSubmission({ currency: "EUR" });

    let caught: unknown;
    try {
      await verifyAndCompleteBankPaymentOrder(verifyInput({ bankPaymentOrderId: order.id, submission, draftOrderPort: port }));
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(BankPaymentAmountMismatchError);
    expect((caught as BankPaymentAmountMismatchError).comparison.currencyMismatch).toBe(true);

    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.verifiedAt).toBeNull();
  });

  it("accepts an exact match — the boundary case right next to refusal", async () => {
    const order = await aBankOrder({});
    const { port, completeCalls } = fakePort("gid://shopify/Order/exact-match");
    const submission = aSubmission({ amountReceivedMinorUnits: 100_000n, currency: "USD" });

    const result = await verifyAndCompleteBankPaymentOrder(
      verifyInput({ bankPaymentOrderId: order.id, submission, draftOrderPort: port })
    );
    expect(result.outcome).toBe("completed");
    expect(completeCalls).toHaveLength(1);
  });
});

describe("D25 — completion failing after verification is recorded (criteria 118-120)", () => {
  it("leaves the order verified-but-not-completed when completion fails, without throwing", async () => {
    const order = await aBankOrder({});
    const port = failingPort("simulated Shopify outage");
    const submission = aSubmission();

    const result = await verifyAndCompleteBankPaymentOrder(
      verifyInput({ bankPaymentOrderId: order.id, submission, draftOrderPort: port })
    );

    expect(result.outcome).toBe("completion_failed");
    if (result.outcome !== "completion_failed") throw new Error("expected completion_failed");
    expect(result.completionError).toContain("simulated Shopify outage");

    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    // Verification WAS recorded — this is the whole point of D25: the evidence is never lost.
    expect(after.verifiedAt).not.toBeNull();
    expect(after.verifiedPaymentAmountMinorUnits).toBe(100_000n);
    // But completion did not happen.
    expect(after.status).toBe("open");
    expect(after.shopifyOrderGid).toBeNull();
    expect(after.completedAt).toBeNull();

    const events = await listAuditEventsForEntity("bank_payment_order", order.id);
    const actions = events.map((e) => e.action);
    expect(actions).toContain("bank_payment_order.verified");
    expect(actions).toContain("bank_payment_order.completion_failed");
    expect(actions).not.toContain("bank_payment_order.completed");
  });

  it("a retry submission (a plain duplicate, not the explicit recovery action) never re-verifies or re-records the amount", async () => {
    const order = await aBankOrder({ verified: true }); // already verified, status still "open" — the D25 recovery state
    const { port, completeCalls } = fakePort("gid://shopify/Order/recovered");

    const result = await verifyAndCompleteBankPaymentOrder(
      verifyInput({
        bankPaymentOrderId: order.id,
        // A different amount submitted by mistake — must be ignored entirely, not compared, not written.
        submission: aSubmission({ amountReceivedMinorUnits: 1n }),
        draftOrderPort: port,
      })
    );

    expect(result.outcome).toBe("completed");
    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    // The ORIGINAL fixture's verification, untouched.
    expect(after.verifiedPaymentAmountMinorUnits).toBe(100_000n);
    expect(after.verifiedByEmail).toBe("earlier-fixture-admin@example.com");
    expect(after.status).toBe("completed");
    expect(completeCalls).toHaveLength(1);

    const events = await listAuditEventsForEntity("bank_payment_order", order.id);
    // No amount-mismatch refusal and no fresh `.verified` event — this order
    // was already verified before this call started.
    expect(events.some((e) => e.action === "bank_payment_order.verify_amount_mismatch_refused")).toBe(false);
    expect(events.some((e) => e.action === "bank_payment_order.verified")).toBe(false);
    expect(events.some((e) => e.action === "bank_payment_order.verify_duplicate_ignored")).toBe(true);
  });
});

describe("resolveDraftOrderResultingOrder — the read half of D25's read-before-write (criterion 120)", () => {
  it("returns null when Shopify confirms no resulting order yet", async () => {
    const admin = fakeAdminClient({ draftOrderResultByGid: { "gid://shopify/DraftOrder/1": null } });
    expect(await resolveDraftOrderResultingOrder(admin, "gid://shopify/DraftOrder/1")).toBeNull();
  });

  it("returns the existing order when Shopify already completed the draft", async () => {
    const admin = fakeAdminClient({
      draftOrderResultByGid: { "gid://shopify/DraftOrder/1": { orderGid: "gid://shopify/Order/500", orderName: "#500" } },
    });
    expect(await resolveDraftOrderResultingOrder(admin, "gid://shopify/DraftOrder/1")).toEqual({
      orderGid: "gid://shopify/Order/500",
      orderName: "#500",
    });
  });
});

describe("completeVerifiedBankPaymentOrder — read-before-write (criterion 120)", () => {
  it("THE DANGEROUS CASE: adopts an order Shopify already created instead of completing a second time", async () => {
    // Simulates exactly 2C-a's live-gate finding: draftOrderComplete
    // succeeded at Shopify, but OUR write of the order id failed, leaving
    // shopify_order_gid NULL here while Shopify already has a real order.
    const order = await aBankOrder({ verified: true });
    const { port, completeCalls } = fakePort("gid://shopify/Order/should-never-be-created");
    const admin = fakeAdminClient({
      draftOrderResultByGid: {
        [order.shopifyDraftOrderGid]: { orderGid: "gid://shopify/Order/already-exists", orderName: "#900" },
      },
    });

    const result = await completeVerifiedBankPaymentOrder({
      bankPaymentOrderId: order.id,
      shop: SHOP,
      admin,
      draftOrderPort: port,
    });

    expect(result).toEqual({ outcome: "completed", shopifyOrderGid: "gid://shopify/Order/already-exists", orderName: "#900" });
    // THE ASSERTION THAT MATTERS: completeDraftOrder was NEVER called.
    expect(completeCalls).toHaveLength(0);

    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.shopifyOrderGid).toBe("gid://shopify/Order/already-exists");
    expect(after.status).toBe("completed");

    const events = await listAuditEventsForEntity("bank_payment_order", order.id);
    expect(events.some((e) => e.action === "bank_payment_order.completion_adopted")).toBe(true);
    expect(events.some((e) => e.action === "bank_payment_order.completed")).toBe(false);
  });

  it("completes normally when Shopify confirms no resulting order exists yet", async () => {
    const order = await aBankOrder({ verified: true });
    const { port, completeCalls } = fakePort("gid://shopify/Order/fresh-completion");
    const admin = fakeAdminClient({ draftOrderResultByGid: { [order.shopifyDraftOrderGid]: null } });

    const result = await completeVerifiedBankPaymentOrder({
      bankPaymentOrderId: order.id,
      shop: SHOP,
      admin,
      draftOrderPort: port,
    });

    expect(result).toEqual({ outcome: "completed", shopifyOrderGid: "gid://shopify/Order/fresh-completion", orderName: "#2001" });
    expect(completeCalls).toHaveLength(1);
  });

  it("is idempotent: a second call finds the order already completed and does not touch Shopify again", async () => {
    const order = await aBankOrder({ verified: true });
    const { port, completeCalls } = fakePort("gid://shopify/Order/once-only");
    const admin = fakeAdminClient({ draftOrderResultByGid: { [order.shopifyDraftOrderGid]: null } });

    await completeVerifiedBankPaymentOrder({ bankPaymentOrderId: order.id, shop: SHOP, admin, draftOrderPort: port });
    const second = await completeVerifiedBankPaymentOrder({ bankPaymentOrderId: order.id, shop: SHOP, admin, draftOrderPort: port });

    expect(second).toEqual({ outcome: "completed", shopifyOrderGid: "gid://shopify/Order/once-only", orderName: null });
    expect(completeCalls).toHaveLength(1);
  });

  it("returns completion_failed (never throws) when the order was never verified", async () => {
    const order = await aBankOrder({});
    const { port } = fakePort();
    const admin = fakeAdminClient();

    const result = await completeVerifiedBankPaymentOrder({ bankPaymentOrderId: order.id, shop: SHOP, admin, draftOrderPort: port });
    expect(result.outcome).toBe("completion_failed");
  });

  it("returns completion_failed (never throws) when Shopify itself fails", async () => {
    const order = await aBankOrder({ verified: true });
    const port = failingPort("simulated outage on retry");
    const admin = fakeAdminClient({ draftOrderResultByGid: { [order.shopifyDraftOrderGid]: null } });

    const result = await completeVerifiedBankPaymentOrder({ bankPaymentOrderId: order.id, shop: SHOP, admin, draftOrderPort: port });
    expect(result).toEqual({ outcome: "completion_failed", error: expect.stringContaining("simulated outage on retry") });

    const events = await listAuditEventsForEntity("bank_payment_order", order.id);
    expect(events.some((e) => e.action === "bank_payment_order.completion_failed")).toBe(true);
  });
});
