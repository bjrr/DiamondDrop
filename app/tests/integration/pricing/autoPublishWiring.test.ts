import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import type { ShopifyPriceSyncPort } from "~/jobs/pricing/ports";
import { runPriceRecalculation } from "~/jobs/pricing/runRecalculation.server";

/**
 * Spec §4.1 criteria 8-9 — the AUTO-PUBLISH GATE itself, as distinct from
 * `syncApprovedIntent.test.ts`'s coverage of the sync mechanics once an
 * `approved` intent exists. This file is specifically about whether
 * `runPriceRecalculation` reaches the port at all, and only when told to.
 *
 * EVERY ASSERTION IS SCOPED TO THE TEST'S OWN VARIANT. `runPriceRecalculation`
 * queries every `active` variant with no per-test isolation (this suite shares
 * one disposable database across all its tests, per `tests/integration/globalSetup.ts`),
 * so a run triggered by test N also reprocesses every variant a previous test
 * left behind. Asserting on a global `port.calls.length` would make each
 * test's result depend on execution order and on what other tests in this
 * file happen to do — filtering every check to `shopifyVariantGid ===
 * variant.shopifyVariantGid` is what makes each test's assertions true
 * regardless of what else is in the database.
 */

let fixtureSequence = 0;
const uniqueInt = (): number => (Date.now() % 900_000) + 1_000 + (fixtureSequence += 1);

const ASOF = new Date("2026-06-01T00:00:00Z");

/**
 * Every variant `priceableVariant()` creates, ARCHIVED after each test.
 *
 * `runPriceRecalculation` queries `status: "active"` with no per-test scope,
 * and this suite's disposable database is shared across every integration
 * test FILE in the run (`tests/integration/globalSetup.ts`), not just this
 * one. A variant this file leaves `active` — especially one this file has
 * deliberately given a real synced anchor — gets swept into every OTHER
 * test's recalculation run for the rest of the suite, which is exactly the
 * failure this caused in `autoApplyTolerance.test.ts` (its "first price"
 * assertions broke because a leftover anchored variant from this file was
 * silently included). Archiving removes it from `where: { status: "active" }`
 * without needing this file to know anything about what runs after it.
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

interface RecordedCall {
  shopifyVariantGid: string;
  regularCardPrice: { toJSON(): { amountMinorUnits: string; currency: string } };
  priceCalculationId: string;
}

class FakePort implements ShopifyPriceSyncPort {
  readonly calls: RecordedCall[] = [];
  async applyVariantPrice(input: RecordedCall): Promise<{ appliedAt: Date }> {
    this.calls.push(input);
    return { appliedAt: new Date("2026-09-19T00:00:00Z") };
  }
  callsFor(shopifyVariantGid: string): RecordedCall[] {
    return this.calls.filter((c) => c.shopifyVariantGid === shopifyVariantGid);
  }
}

/**
 * effectiveFrom GROWS on every call, always ahead of the previous one and
 * always inside the 2026-05-01..2026-06-01 window `ASOF` resolves within.
 * Without this, a later test's profile could be dated EARLIER than an
 * earlier test's and lose resolution to it — `resolveActivePricingProfile`
 * picks the greatest `effectiveFrom <= asOf` across the WHOLE database, not
 * scoped to one test, since nothing in this suite deletes rows between tests.
 */
function nextEffectiveFrom(): Date {
  const secondsIntoWindow = uniqueInt() % (28 * 24 * 60 * 60); // stays within May
  return new Date(new Date("2026-05-01T00:00:00Z").getTime() + secondsIntoWindow * 1000);
}

async function realisticProfile() {
  return prisma.pricingProfile.create({
    data: {
      code: "buy_now",
      version: uniqueInt(),
      marginModel: "TARGET_GROSS_MARGIN_V1",
      targetGrossMarginRate: "0.420000",
      minGrossMarginRate: "0.350000",
      minDollarProfitMinorUnits: 15000n,
      currency: "USD",
      roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
      regularCardPriceRuleId: "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1",
      fixedCardUpliftRate: "0.050000",
      priceEndingRuleId: "NONE_V1",
      autoApplyToleranceBps: 200,
      effectiveFrom: nextEffectiveFrom(),
      createdBy: "integration-test",
      isPlaceholder: false,
    },
  });
}

/**
 * A variant priceable purely from GLOBAL seeded cost/metal/labor data — same
 * gold/GOLD_14K/india combination `intentTransitions.test.ts` and
 * `cronRoute.test.ts` already rely on being resolvable, with no bands and no
 * stones so the engine takes the single-price path.
 */
async function priceableVariant() {
  const suffix = randomUUID().slice(0, 8);
  const product = await prisma.masterProduct.create({
    data: {
      name: `auto-publish fixture ${suffix}`,
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
  createdVariantIds.push(variant.id);
  return variant;
}

/**
 * Anchors the variant at a bank price 1% below whatever it will actually
 * compute to next run, so the next run's real computed price lands as an
 * `auto_apply`, CHANGED decision (within the 200 bps tolerance, but not
 * `unchanged` — the wiring under test only fires on that specific branch).
 */
async function anchorOnePercentBelow(variantId: string, profileId: string, profileVersion: number) {
  const computed = await prisma.priceCalculation.findFirstOrThrow({
    where: { masterVariantId: variantId, status: "computed" },
    orderBy: { createdAt: "desc" },
  });
  const anchorBank = (computed.bankPaymentPriceMinorUnits * 99n) / 100n; // -1%

  const snapshot = await prisma.snapshot.create({
    data: { kind: "pricing.it", payload: { anchor: true }, contentHash: `anchor-${randomUUID()}` },
  });
  const anchorCalc = await prisma.priceCalculation.create({
    data: {
      runId: randomUUID(),
      masterVariantId: variantId,
      pricingProfileId: profileId,
      profileVersion,
      engineVersion: computed.engineVersion,
      roundingRuleId: computed.roundingRuleId,
      priceEndingRuleId: computed.priceEndingRuleId,
      asOf: new Date("2026-05-15T00:00:00Z"),
      snapshotId: snapshot.id,
      landedCostMinorUnits: computed.landedCostMinorUnits,
      bankPaymentPriceMinorUnits: anchorBank,
      currency: computed.currency,
      status: "computed",
    },
  });
  await prisma.masterVariant.update({
    where: { id: variantId },
    data: { lastSyncedPriceCalculationId: anchorCalc.id },
  });
  return anchorCalc;
}

describe("criterion 8 — auto-publish OFF (the default) leaves an auto_apply decision at approved", () => {
  it("never calls the port when autoPublishEnabled is not set", async () => {
    const profile = await realisticProfile();
    const variant = await priceableVariant();

    // First run establishes a real computed price.
    await runPriceRecalculation({ asOf: ASOF, runId: randomUUID() });
    await anchorOnePercentBelow(variant.id, profile.id, profile.version);

    const port = new FakePort();
    // autoPublishEnabled deliberately omitted — must default to reading
    // PRICE_AUTO_PUBLISH_ENABLED from the environment, which is unset in
    // this test run (see app/.env), i.e. OFF.
    await runPriceRecalculation({ asOf: ASOF, runId: randomUUID(), syncPort: port });

    expect(port.callsFor(variant.shopifyVariantGid!)).toHaveLength(0);

    const intent = await prisma.priceSyncIntent.findFirst({
      where: { masterVariantId: variant.id },
      orderBy: { createdAt: "desc" },
    });
    expect(intent?.status).toBe("approved");
    expect(intent?.decision).toBe("auto_apply");
  });

  it("an explicit autoPublishEnabled: false behaves identically", async () => {
    const profile = await realisticProfile();
    const variant = await priceableVariant();

    await runPriceRecalculation({ asOf: ASOF, runId: randomUUID() });
    await anchorOnePercentBelow(variant.id, profile.id, profile.version);

    const port = new FakePort();
    await runPriceRecalculation({
      asOf: ASOF,
      runId: randomUUID(),
      syncPort: port,
      autoPublishEnabled: false,
    });

    expect(port.callsFor(variant.shopifyVariantGid!)).toHaveLength(0);
  });
});

describe("criterion 9 — auto-publish ON reaches the port for an auto_apply, changed decision", () => {
  it("calls the port exactly once for that variant, and the intent ends up synced with the anchor written", async () => {
    const profile = await realisticProfile();
    const variant = await priceableVariant();

    await runPriceRecalculation({ asOf: ASOF, runId: randomUUID() });
    await anchorOnePercentBelow(variant.id, profile.id, profile.version);

    const port = new FakePort();
    await runPriceRecalculation({
      asOf: ASOF,
      runId: randomUUID(),
      syncPort: port,
      autoPublishEnabled: true,
    });

    expect(port.callsFor(variant.shopifyVariantGid!)).toHaveLength(1);

    const intent = await prisma.priceSyncIntent.findFirst({
      where: { masterVariantId: variant.id },
      orderBy: { createdAt: "desc" },
    });
    expect(intent?.status).toBe("synced");

    const variantAfter = await prisma.masterVariant.findUnique({ where: { id: variant.id } });
    expect(variantAfter?.lastSyncedPriceCalculationId).toBe(intent?.priceCalculationId);
  });

  it("does NOT call the port for a genuinely unchanged price even with auto-publish on", async () => {
    // The `unchanged` branch was already routed straight to `synced` before
    // this slice (nothing to publish) and must stay that way — auto-publish
    // enabling must not turn a no-op into a real Admin API call.
    await realisticProfile();
    const variant = await priceableVariant();

    await runPriceRecalculation({ asOf: ASOF, runId: randomUUID() });
    const computed = await prisma.priceCalculation.findFirstOrThrow({
      where: { masterVariantId: variant.id, status: "computed" },
      orderBy: { createdAt: "desc" },
    });
    await prisma.masterVariant.update({
      where: { id: variant.id },
      data: { lastSyncedPriceCalculationId: computed.id },
    });

    const port = new FakePort();
    await runPriceRecalculation({
      asOf: ASOF,
      runId: randomUUID(),
      syncPort: port,
      autoPublishEnabled: true,
    });

    expect(port.callsFor(variant.shopifyVariantGid!)).toHaveLength(0);
    const intent = await prisma.priceSyncIntent.findFirst({
      where: { masterVariantId: variant.id },
      orderBy: { createdAt: "desc" },
    });
    expect(intent?.status).toBe("synced");
    expect(intent?.decision).toBe("auto_apply");
  });

  it("does not call the port for a needs_approval decision (first-ever price) even with auto-publish on", async () => {
    // A first-ever price for a variant is ALWAYS needs_approval (decideSync
    // has no prior price to compare against) — a much simpler and more
    // representative way to reach needs_approval than an unsolvable
    // placeholder profile, and one that does not risk poisoning this shared
    // ASOF's profile resolution for every other test in the file the way an
    // extra `buy_now` profile row would.
    await realisticProfile();
    const variant = await priceableVariant();

    const port = new FakePort();
    await runPriceRecalculation({ asOf: ASOF, runId: randomUUID(), syncPort: port, autoPublishEnabled: true });

    expect(port.callsFor(variant.shopifyVariantGid!)).toHaveLength(0);
    const intent = await prisma.priceSyncIntent.findFirst({
      where: { masterVariantId: variant.id },
      orderBy: { createdAt: "desc" },
    });
    expect(intent?.status).toBe("pending_approval");
    expect(intent?.decision).toBe("needs_approval");
  });
});

describe("a sync failure during auto-publish fails only that variant's publish, never the run", () => {
  it("the run completes, the failing variant is left in syncing, and its own computation is not counted as failed", async () => {
    const profile = await realisticProfile();
    const variant = await priceableVariant();

    await runPriceRecalculation({ asOf: ASOF, runId: randomUUID() });
    await anchorOnePercentBelow(variant.id, profile.id, profile.version);

    class ThrowingForThisVariantPort implements ShopifyPriceSyncPort {
      async applyVariantPrice(input: RecordedCall): Promise<{ appliedAt: Date }> {
        if (input.shopifyVariantGid === variant.shopifyVariantGid) {
          throw new Error("simulated Admin API outage");
        }
        return { appliedAt: new Date("2026-09-19T00:00:00Z") };
      }
    }

    const summary = await runPriceRecalculation({
      asOf: ASOF,
      runId: randomUUID(),
      syncPort: new ThrowingForThisVariantPort(),
      autoPublishEnabled: true,
    });

    // The CALCULATION succeeded for every variant, including this one — a
    // sync failure must never be counted as a calculation failure.
    expect(summary.failed).toBe(0);
    expect(summary.computed).toBeGreaterThan(0);

    const intent = await prisma.priceSyncIntent.findFirst({
      where: { masterVariantId: variant.id },
      orderBy: { createdAt: "desc" },
    });
    // Left mid-flight for the (not-yet-built) failure handler to pick up —
    // not silently marked synced, and not corrupting the calculation count.
    expect(intent?.status).toBe("syncing");

    // The anchor set up by anchorOnePercentBelow() above is UNCHANGED — the
    // failed sync must not advance the compare-and-set anchor to the new,
    // unpublished calculation.
    const variantAfter = await prisma.masterVariant.findUnique({ where: { id: variant.id } });
    expect(variantAfter?.lastSyncedPriceCalculationId).not.toBe(intent?.priceCalculationId);
  });
});
