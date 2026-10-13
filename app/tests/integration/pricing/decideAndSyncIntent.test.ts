import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { decideAndSyncIntent } from "~/jobs/pricing/decideAndSyncIntent.server";
import { InvalidIntentTransitionError, decideIntent } from "~/jobs/pricing/intentTransitions.server";
import type { ShopifyPriceSyncPort } from "~/jobs/pricing/ports";

/**
 * Spec §16.8 criterion 59 — a human approval must actually publish, through
 * the SAME `syncApprovedPriceSyncIntent` function the auto-apply branch of
 * `runRecalculation.server.ts` calls. Before this, `decide --status approved`
 * reached `approved` and stopped: an admin sign-off that looked like it
 * worked and reached nobody.
 */

let fixtureSequence = 0;
const uniqueInt = (): number => (Date.now() % 900_000) + 1_000 + (fixtureSequence += 1);

/**
 * Every variant this file creates, ARCHIVED after each test — the disposable
 * database is shared across every integration test file in the run, and
 * `runPriceRecalculation` (called by other files) queries `status: "active"`
 * with no per-file scope. See syncApprovedIntent.test.ts's identical note.
 */
const createdVariantIds: string[] = [];

afterEach(async () => {
  if (createdVariantIds.length === 0) return;
  await prisma.masterVariant.updateMany({
    where: { id: { in: createdVariantIds } },
    data: { status: "archived" },
  });
  createdVariantIds.length = 0;
});

class FakePort implements ShopifyPriceSyncPort {
  readonly calls: {
    shopifyProductGid: string;
    shopifyVariantGid: string;
    regularCardPriceMinorUnits: string;
    currency: string;
    priceCalculationId: string;
  }[] = [];
  failNextWith: Error | null = null;

  async applyVariantPrice(input: {
    shopifyProductGid: string;
    shopifyVariantGid: string;
    regularCardPrice: { toJSON(): { amountMinorUnits: string; currency: string } };
    priceCalculationId: string;
  }): Promise<{ appliedAt: Date }> {
    if (this.failNextWith) {
      const err = this.failNextWith;
      this.failNextWith = null;
      throw err;
    }
    const json = input.regularCardPrice.toJSON();
    this.calls.push({
      shopifyProductGid: input.shopifyProductGid,
      shopifyVariantGid: input.shopifyVariantGid,
      regularCardPriceMinorUnits: json.amountMinorUnits,
      currency: json.currency,
      priceCalculationId: input.priceCalculationId,
    });
    return { appliedAt: new Date("2026-09-19T12:00:00Z") };
  }
}

interface FixtureOptions {
  bankPaymentPriceMinorUnits: bigint;
  isPlaceholder?: boolean;
  intentStatus?: "pending_approval" | "approved" | "synced";
  linked?: boolean;
}

async function makeFixture(opts: FixtureOptions) {
  const suffix = randomUUID().slice(0, 8);
  const linked = opts.linked ?? true;

  const product = await prisma.masterProduct.create({
    data: {
      name: `decide-and-sync fixture ${suffix}`,
      category: "ring",
      sizeAxis: "none",
      allowedSizeMin: "0",
      allowedSizeMax: "0",
      sizeIncrement: "1",
      baseSize: "0",
      offeredMetals: ["gold"],
      status: "active",
      shopifyProductGid: linked ? `gid://shopify/Product/${suffix}` : null,
    },
  });
  const variant = await prisma.masterVariant.create({
    data: {
      masterProductId: product.id,
      metal: "gold",
      purity: "GOLD_14K",
      baseWeightGrams: "3.0000",
      weightPerFullSizeGrams: "0.0000",
      status: "active",
      laborSource: "india",
      shopifyVariantGid: linked ? `gid://shopify/ProductVariant/${suffix}` : null,
    },
  });
  createdVariantIds.push(variant.id);
  const profile = await prisma.pricingProfile.create({
    data: {
      code: "buy_now",
      version: uniqueInt(),
      marginModel: "TARGET_GROSS_MARGIN_V1",
      targetGrossMarginRate: opts.isPlaceholder ? "0.999900" : "0.420000",
      minGrossMarginRate: opts.isPlaceholder ? "0.999800" : "0.350000",
      minDollarProfitMinorUnits: 15000n,
      currency: "USD",
      roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
      regularCardPriceRuleId: "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1",
      fixedCardUpliftRate: "0.050000",
      priceEndingRuleId: "NONE_V1",
      autoApplyToleranceBps: 200,
      effectiveFrom: new Date("2020-01-01T00:00:00Z"),
      createdBy: "integration-test",
      isPlaceholder: opts.isPlaceholder ?? false,
    },
  });
  const snapshot = await prisma.snapshot.create({
    data: { kind: "pricing.it", payload: {}, contentHash: `decide-and-sync-${suffix}` },
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
      bankPaymentPriceMinorUnits: opts.bankPaymentPriceMinorUnits,
      currency: "USD",
      status: "computed",
    },
  });
  const intent = await prisma.priceSyncIntent.create({
    data: {
      masterVariantId: variant.id,
      priceCalculationId: calc.id,
      decision: "needs_approval",
      status: opts.intentStatus ?? "pending_approval",
      reason: "queued because the change exceeded tolerance",
      attemptCount: 0,
    },
  });

  return { product, variant, profile, snapshot, calc, intent };
}

describe("criterion 59 — an approved intent actually publishes", () => {
  it("moves pending_approval -> approved -> synced, calling the port once with the tiered card price", async () => {
    const { variant, calc, intent } = await makeFixture({ bankPaymentPriceMinorUnits: 100_000n }); // $1,000.00 bank
    const port = new FakePort();

    const result = await decideAndSyncIntent(
      { intentId: intent.id, status: "approved", actor: "staff-1" },
      { port }
    );

    expect(result.syncError).toBeUndefined();
    expect(result.sync?.kind).toBe("synced");
    expect(port.calls).toHaveLength(1);
    // $1,000 bank -> 4.0% tier -> $1,040.00, already a $5 multiple.
    expect(port.calls[0]?.regularCardPriceMinorUnits).toBe("104000");

    const after = await prisma.priceSyncIntent.findUnique({ where: { id: intent.id } });
    expect(after?.status).toBe("synced");
    expect(after?.decidedBy).toBe("staff-1");

    const variantAfter = await prisma.masterVariant.findUnique({ where: { id: variant.id } });
    expect(variantAfter?.lastSyncedPriceCalculationId).toBe(calc.id);

    // decideIntent's own audit event AND syncApprovedPriceSyncIntent's own
    // audit event both fire — the wrapper adds no third writer.
    const approvedAudit = await prisma.auditEvent.findMany({
      where: { entityType: "price_sync_intent", entityId: intent.id, action: "price_sync_intent.approved" },
    });
    expect(approvedAudit).toHaveLength(1);
    const syncedAudit = await prisma.auditEvent.findMany({
      where: { entityType: "price_sync_intent", entityId: intent.id, action: "price_sync_intent.synced" },
    });
    expect(syncedAudit).toHaveLength(1);
  });

  it("produces the identical published figure syncApprovedPriceSyncIntent produces directly, for the same bank price and profile", async () => {
    // Two fixtures at the same bank price: one carried through the MANUAL
    // approval wrapper, one whose intent is created already `approved` — the
    // shape runRecalculation.server.ts's auto-apply branch creates directly.
    // Both must publish byte-identical figures, because both go through the
    // one publish function.
    const bankPaymentPriceMinorUnits = 250_000n; // $2,500.00 — a tier boundary
    const manual = await makeFixture({ bankPaymentPriceMinorUnits });
    const auto = await makeFixture({ bankPaymentPriceMinorUnits, intentStatus: "approved" });

    const manualPort = new FakePort();
    const autoPort = new FakePort();

    const { syncApprovedPriceSyncIntent } = await import("~/jobs/pricing/syncApprovedIntent.server");

    const manualResult = await decideAndSyncIntent(
      { intentId: manual.intent.id, status: "approved", actor: "staff-2" },
      { port: manualPort }
    );
    const autoOutcome = await syncApprovedPriceSyncIntent(auto.intent.id, { port: autoPort });

    expect(manualResult.sync?.kind).toBe("synced");
    expect(autoOutcome.kind).toBe("synced");
    expect(manualPort.calls[0]?.regularCardPriceMinorUnits).toBe(autoPort.calls[0]?.regularCardPriceMinorUnits);
    expect(manualPort.calls[0]?.currency).toBe(autoPort.calls[0]?.currency);
  });
});

describe("a rejected intent never reaches the port", () => {
  it("returns no sync outcome and makes no Admin API call", async () => {
    const { intent } = await makeFixture({ bankPaymentPriceMinorUnits: 100_000n });
    const port = new FakePort();

    const result = await decideAndSyncIntent(
      { intentId: intent.id, status: "rejected", actor: "staff-3", reason: "priced wrong" },
      { port }
    );

    expect(result.sync).toBeUndefined();
    expect(result.syncError).toBeUndefined();
    expect(port.calls).toHaveLength(0);

    const after = await prisma.priceSyncIntent.findUnique({ where: { id: intent.id } });
    expect(after?.status).toBe("rejected");
  });
});

describe("a publish failure on manual approval matches auto-apply's own failure behaviour", () => {
  it("leaves the intent in syncing, does not touch the compare-and-set anchor, and reports the failure rather than claiming success", async () => {
    const { variant, intent } = await makeFixture({ bankPaymentPriceMinorUnits: 100_000n });
    const port = new FakePort();
    port.failNextWith = new Error("simulated Admin API outage");

    const result = await decideAndSyncIntent(
      { intentId: intent.id, status: "approved", actor: "staff-4" },
      { port }
    );

    // Not thrown up to the caller — matches runRecalculation.server.ts's own
    // auto-apply try/catch, which logs and continues rather than crashing.
    expect(result.syncError).toBeInstanceOf(Error);
    expect(result.syncError?.message).toBe("simulated Admin API outage");
    expect(result.sync).toBeUndefined();

    // The approval itself DID happen — decideIntent's own transaction
    // committed before the sync attempt began.
    const after = await prisma.priceSyncIntent.findUnique({ where: { id: intent.id } });
    expect(after?.decidedBy).toBe("staff-4");
    // But it is NOT synced — left mid-flight for T4's retry/failure path,
    // exactly where an Admin API failure during auto-apply also leaves it.
    expect(after?.status).toBe("syncing");

    const variantAfter = await prisma.masterVariant.findUnique({ where: { id: variant.id } });
    expect(variantAfter?.lastSyncedPriceCalculationId).toBeNull();
  });
});

describe("the D14 placeholder guard still applies to the manual approval path", () => {
  it("refuses to approve, and therefore never attempts to publish", async () => {
    const { intent } = await makeFixture({ bankPaymentPriceMinorUnits: 100_000n, isPlaceholder: true });
    const port = new FakePort();

    await expect(
      decideAndSyncIntent({ intentId: intent.id, status: "approved", actor: "staff-5" }, { port })
    ).rejects.toThrow(/PLACEHOLDER/);

    expect(port.calls).toHaveLength(0);
    const after = await prisma.priceSyncIntent.findUnique({ where: { id: intent.id } });
    expect(after?.status).toBe("pending_approval");
  });
});

describe("the transition table still governs — an already-terminal intent cannot be re-approved through this path either", () => {
  it("throws InvalidIntentTransitionError and never reaches the port", async () => {
    const { intent } = await makeFixture({ bankPaymentPriceMinorUnits: 100_000n });
    const port = new FakePort();
    await decideIntent({ intentId: intent.id, status: "rejected", actor: "staff-6", reason: "no" });

    await expect(
      decideAndSyncIntent({ intentId: intent.id, status: "approved", actor: "staff-6" }, { port })
    ).rejects.toBeInstanceOf(InvalidIntentTransitionError);
    expect(port.calls).toHaveLength(0);
  });
});

describe("source-level convergence — one publish function, two callers", () => {
  /**
   * The behavioural tests above prove the OUTPUT is identical; this proves
   * WHY: both callers import and invoke the literal same function rather than
   * two implementations that happen to agree today. Same style as
   * layering.test.ts's mechanical fences elsewhere in this suite.
   */
  it("decideAndSyncIntent.server.ts calls syncApprovedPriceSyncIntent from syncApprovedIntent.server, not a second implementation", () => {
    const source = readFileSync(
      join(process.cwd(), "app", "jobs", "pricing", "decideAndSyncIntent.server.ts"),
      "utf8"
    );
    expect(source).toMatch(/from\s+["']\.\/syncApprovedIntent\.server["']/);
    expect(source).toMatch(/syncApprovedPriceSyncIntent\(/);
    // No direct port call here — publishing is delegated entirely, never
    // duplicated at this layer.
    expect(source).not.toMatch(/\.applyVariantPrice\(/);
  });

  it("runRecalculation.server.ts's auto-apply branch calls the same import", () => {
    const source = readFileSync(
      join(process.cwd(), "app", "jobs", "pricing", "runRecalculation.server.ts"),
      "utf8"
    );
    expect(source).toMatch(/from\s+["']\.\/syncApprovedIntent\.server["']/);
    expect(source).toMatch(/syncApprovedPriceSyncIntent\(/);
  });
});
