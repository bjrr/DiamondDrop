import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { isVariantCurrentlyWithdrawn } from "~/db/repositories/priceSyncFailureRepository.server";
import type { ShopifyPriceSyncPort } from "~/jobs/pricing/ports";
import { InvalidIntentTransitionError } from "~/jobs/pricing/intentTransitions.server";
import { syncApprovedPriceSyncIntent } from "~/jobs/pricing/syncApprovedIntent.server";

/**
 * Team-lead finding (2026-09-19): `recordSyncFailure`/`recordSyncSuccess`
 * (owner §4/§15) and `recordPricingInputChangeIfPriceAffecting` (owner §16)
 * were fully built and tested at the domain/repository layer with ZERO
 * callers anywhere in `app/jobs`, `app/routes` or `scripts`. This file proves
 * the wiring added to `syncApprovedIntent.server.ts` reaches both, with
 * assertions that would fail if the calls were removed — and, for the
 * input-change wiring specifically, a source-level fence pinning the exact
 * changed-column set, because a CORRECT call at that site is deliberately
 * inert (no observable row) and only a source assertion can catch it being
 * quietly widened into the catalogue-wide trigger loop criterion 58 warns
 * against.
 */

let fixtureSequence = 0;
const uniqueInt = (): number => (Date.now() % 900_000) + 1_000 + (fixtureSequence += 1);

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
  failNextWith: Error | null = null;
  calls = 0;
  async applyVariantPrice(): Promise<{ appliedAt: Date }> {
    if (this.failNextWith) {
      const err = this.failNextWith;
      this.failNextWith = null;
      throw err;
    }
    this.calls += 1;
    return { appliedAt: new Date("2026-09-19T12:00:00Z") };
  }
}

/** Same shape as syncApprovedIntent.test.ts's makeFixture, trimmed to what this file needs. */
async function makeFixture(opts: { bankPaymentPriceMinorUnits: bigint; intentStatus?: "approved" }) {
  const suffix = randomUUID().slice(0, 8);
  const product = await prisma.masterProduct.create({
    data: {
      name: `sync-failure-wiring fixture ${suffix}`,
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
  const profile = await prisma.pricingProfile.create({
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
      effectiveFrom: new Date("2020-01-01T00:00:00Z"),
      createdBy: "integration-test",
      isPlaceholder: false,
    },
  });
  const snapshot = await prisma.snapshot.create({
    data: { kind: "pricing.it", payload: {}, contentHash: `sync-failure-wiring-${suffix}` },
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
      decision: "auto_apply",
      status: opts.intentStatus ?? "approved",
      attemptCount: 0,
    },
  });
  return { product, variant, profile, snapshot, calc, intent };
}

/** A second approved intent for an EXISTING variant — the shape a later recalculation run produces. */
async function additionalApprovedIntent(
  variant: { id: string },
  profile: { id: string; version: number },
  bankPaymentPriceMinorUnits: bigint
) {
  const snapshot = await prisma.snapshot.create({
    data: { kind: "pricing.it", payload: { v: 2 }, contentHash: `sync-failure-wiring-2-${randomUUID()}` },
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
      bankPaymentPriceMinorUnits,
      currency: "USD",
      status: "computed",
    },
  });
  return prisma.priceSyncIntent.create({
    data: {
      masterVariantId: variant.id,
      priceCalculationId: calc.id,
      decision: "auto_apply",
      status: "approved",
      attemptCount: 0,
    },
  });
}

describe("owner §4/§15 — sync-failure wiring", () => {
  it("a failing sync opens a sync-failure episode, and the original error still propagates unchanged", async () => {
    const { variant, intent } = await makeFixture({ bankPaymentPriceMinorUnits: 100_000n });
    const port = new FakePort();
    port.failNextWith = new Error("simulated Admin API outage");

    // The existing contract (syncApprovedIntent.test.ts's own boundary test)
    // must be unchanged: the error still propagates, the intent is still
    // left `syncing`.
    await expect(syncApprovedPriceSyncIntent(intent.id, { port })).rejects.toThrow(
      "simulated Admin API outage"
    );
    const after = await prisma.priceSyncIntent.findUnique({ where: { id: intent.id } });
    expect(after?.status).toBe("syncing");

    // BEFORE this wiring existed, nothing wrote this row at all — false
    // without the `recordSyncFailure` call.
    const failure = await prisma.priceSyncFailure.findFirst({
      where: { masterVariantId: variant.id, resolvedAt: null },
    });
    expect(failure).not.toBeNull();
    expect(failure!.attemptCount).toBe(1);
    expect(failure!.lastError).toContain("simulated Admin API outage");

    // R2 — the ONLY correct availability predicate for this table.
    expect(await isVariantCurrentlyWithdrawn(variant.id)).toBe(false); // well under 48h
  });

  it("a later successful sync for the same variant resolves the episode with no human action", async () => {
    const { variant, profile, intent } = await makeFixture({ bankPaymentPriceMinorUnits: 100_000n });
    const failingPort = new FakePort();
    failingPort.failNextWith = new Error("simulated Admin API outage");
    await expect(syncApprovedPriceSyncIntent(intent.id, { port: failingPort })).rejects.toThrow();

    const openBefore = await prisma.priceSyncFailure.findFirst({
      where: { masterVariantId: variant.id, resolvedAt: null },
    });
    expect(openBefore).not.toBeNull();

    // The first intent is left `syncing` (non-terminal) by the failed
    // attempt, and `price_sync_intent_one_non_terminal_per_variant` allows at
    // most one non-terminal intent per variant — so it must be moved to a
    // TERMINAL status before a second one can exist, exactly as T4's
    // (not-yet-built) retry path will eventually do on a final failure.
    // Written directly rather than through `decideIntent`/`assertTransitionAllowed`
    // because this is test fixture setup standing in for future work, not a
    // claim about what this slice's own code does today.
    await prisma.priceSyncIntent.update({ where: { id: intent.id }, data: { status: "failed" } });

    // A fresh approved intent for the SAME variant — the shape the next
    // recalculation run (or T4's retry, once built) produces. A genuinely
    // successful publish this time.
    const secondIntent = await additionalApprovedIntent(variant, profile, 101_000n);
    const okPort = new FakePort();
    const outcome = await syncApprovedPriceSyncIntent(secondIntent.id, { port: okPort });
    expect(outcome.kind).toBe("synced");

    // BEFORE this wiring existed, this row would still show `resolvedAt: null`
    // forever — false without the `recordSyncSuccess` call.
    const resolved = await prisma.priceSyncFailure.findFirst({
      where: { masterVariantId: variant.id },
      orderBy: { createdAt: "desc" },
    });
    expect(resolved?.resolvedAt).not.toBeNull();
    expect(await isVariantCurrentlyWithdrawn(variant.id)).toBe(false);
  });

  it("throws InvalidIntentTransitionError untouched when the intent is not approved — no failure episode opens for a routine refusal", async () => {
    const { variant, intent } = await makeFixture({ bankPaymentPriceMinorUnits: 100_000n });
    await prisma.priceSyncIntent.update({ where: { id: intent.id }, data: { status: "pending_approval" } });
    const port = new FakePort();

    await expect(syncApprovedPriceSyncIntent(intent.id, { port })).rejects.toBeInstanceOf(
      InvalidIntentTransitionError
    );
    // Never reached the Admin API call, so never reached the failure wiring either.
    const failure = await prisma.priceSyncFailure.findFirst({ where: { masterVariantId: variant.id } });
    expect(failure).toBeNull();
  });
});

describe("owner §16 / criterion 58 — input-change wiring at the sync stamp, proven inert by construction", () => {
  it("a successful sync creates zero pricing_input_change rows — the anti-loop guarantee", async () => {
    const { variant, intent } = await makeFixture({ bankPaymentPriceMinorUnits: 100_000n });
    const before = await prisma.pricingInputChange.count();

    const port = new FakePort();
    const outcome = await syncApprovedPriceSyncIntent(intent.id, { port });
    expect(outcome.kind).toBe("synced");

    // If this call were ever "fixed" to pass the WHOLE column set of the
    // MasterVariant write instead of the real one, this would fail — a
    // price-affecting column (e.g. baseWeightGrams) is always present in
    // "every column of MasterVariant", and this assertion would go from 0 to
    // 1. That is exactly the catalogue-wide loop criterion 58 warns about.
    expect(await prisma.pricingInputChange.count()).toBe(before);
    const rowsForThisVariant = await prisma.pricingInputChange.findMany({
      where: { entityId: variant.id },
    });
    expect(rowsForThisVariant).toHaveLength(0);
  });

  it("source fence: the wiring exists and passes the exact real changed-column set, never a wider one", () => {
    // Proves the CALL exists (this assertion fails if it is removed) and
    // pins the literal it is called with — the behavioural test above
    // cannot distinguish "wired correctly" from "not wired at all", because
    // a correct call at this site is deliberately a no-op either way.
    const source = readFileSync(
      join(process.cwd(), "app", "jobs", "pricing", "syncApprovedIntent.server.ts"),
      "utf8"
    );
    expect(source).toMatch(
      /from\s+["']~\/db\/repositories\/pricingInputChangeRepository\.server["']/
    );
    expect(source).toMatch(/recordPricingInputChangeIfPriceAffecting\(/);
    // The exact literal, not a computed/spread column list.
    expect(source).toMatch(/changedColumns:\s*\[\s*["']lastSyncedPriceCalculationId["']\s*\]/);
    expect(source).toContain('model: "MasterVariant"');
  });
});
