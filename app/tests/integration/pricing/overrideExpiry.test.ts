import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { expireOverrideIfMaterial } from "~/db/repositories/priceOverrideExpiryRepository.server";
import { OverrideExpiryCurrencyMismatchError } from "~/domain/pricing/overrideExpiry";

/**
 * Owner §2.4, spec criteria 15/16, definition locked at
 * docs/specs/SLICE-2-BUY-NOW-STOREFRONT-AND-SYNC.md §13.1/§16.1.
 *
 * Uses a self-contained minimal fixture (same shape as
 * `tests/integration/pricing/persistence.test.ts`) rather than the real
 * pricing engine, so every test controls the exact Bank Payment Price on
 * both sides of the comparison instead of depending on seeded catalogue
 * data or engine arithmetic. `price_override` rows are created directly via
 * Prisma, not through `applyPriceOverride`
 * (`app/app/jobs/pricing/priceOverride.server.ts`) — that function evaluates
 * floors against a full `snapshot.payload.inputs` shape this minimal
 * fixture does not populate, and it is owned by another agent this task is
 * scoped around not touching. `priceOverrideChain.test.ts` establishes the
 * same direct-create pattern for its own forking test.
 */

let fixtureSequence = 0;
const uniqueInt = (): number => (Date.now() % 900_000) + 1_000 + (fixtureSequence += 1);

async function fixture() {
  const suffix = randomUUID().slice(0, 8);

  const product = await prisma.masterProduct.create({
    data: {
      name: `override-expiry fixture ${suffix}`,
      category: "ring",
      sizeAxis: "ring_size_us",
      allowedSizeMin: "2",
      allowedSizeMax: "11",
      sizeIncrement: "0.5",
      baseSize: "6",
      offeredMetals: ["gold"],
      status: "active",
    },
  });

  const variant = await prisma.masterVariant.create({
    data: {
      masterProductId: product.id,
      metal: "gold",
      purity: "GOLD_14K",
      baseWeightGrams: "3.2000",
      weightPerFullSizeGrams: "0.1500",
      status: "active",
      laborSource: "india",
    },
  });

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
      regularCardPriceRuleId: "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1",
      fixedCardUpliftRate: "0.050000",
      priceEndingRuleId: "NONE_V1",
      autoApplyToleranceBps: 50,
      effectiveFrom: new Date("2026-01-01T00:00:00Z"),
      createdBy: "integration-test",
      isPlaceholder: false,
    },
  });

  const snapshot = await prisma.snapshot.create({
    data: { kind: "pricing.it", payload: { fixture: suffix }, contentHash: `it-${suffix}` },
  });

  return { product, variant, profile, snapshot };
}

async function calculation(
  ids: Awaited<ReturnType<typeof fixture>>,
  priceMinorUnits: bigint,
  currency = "USD"
) {
  return prisma.priceCalculation.create({
    data: {
      runId: randomUUID(),
      masterVariantId: ids.variant.id,
      pricingProfileId: ids.profile.id,
      profileVersion: ids.profile.version,
      engineVersion: "BUY_NOW_PRICING_V1",
      roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
      priceEndingRuleId: "NONE_V1",
      asOf: new Date("2026-06-01T00:00:00Z"),
      snapshotId: ids.snapshot.id,
      landedCostMinorUnits: 75365n,
      bankPaymentPriceMinorUnits: priceMinorUnits,
      currency,
      status: "computed",
    },
  });
}

async function setOverride(
  ids: Awaited<ReturnType<typeof fixture>>,
  departedFromCalculationId: string,
  overridePriceMinorUnits: bigint,
  options?: { neverExpire?: boolean }
) {
  return prisma.priceOverride.create({
    data: {
      masterVariantId: ids.variant.id,
      kind: "set",
      priceCalculationId: departedFromCalculationId,
      overrideBankPaymentPriceMinorUnits: overridePriceMinorUnits,
      currency: "USD",
      neverExpire: options?.neverExpire ?? false,
      breachedFloors: [],
      reason: "test fixture",
      overriddenBy: "integration-test",
    },
  });
}

describe("expireOverrideIfMaterial — no override in force", () => {
  it("is a no-op when nothing is currently overridden", async () => {
    const ids = await fixture();
    const departed = await calculation(ids, 40_000n);
    const recalculated = await calculation(ids, 41_000n);
    void departed;

    const result = await expireOverrideIfMaterial({
      masterVariantId: ids.variant.id,
      newPriceCalculationId: recalculated.id,
    });

    expect(result.expired).toBe(false);
    expect(result.reason).toMatch(/no override is currently in force/);
  });

  it("is a no-op when the head of the chain is a revoke row", async () => {
    const ids = await fixture();
    const departed = await calculation(ids, 40_000n);
    const set = await setOverride(ids, departed.id, 80_000n);
    await prisma.priceOverride.create({
      data: {
        masterVariantId: ids.variant.id,
        kind: "revoke",
        supersedesId: set.id,
        currency: "USD",
        breachedFloors: [],
        reason: "revoked before expiry could apply",
        overriddenBy: "integration-test",
      },
    });
    const recalculated = await calculation(ids, 41_000n);

    const result = await expireOverrideIfMaterial({
      masterVariantId: ids.variant.id,
      newPriceCalculationId: recalculated.id,
    });

    expect(result.expired).toBe(false);
    expect(result.reason).toMatch(/no override is currently in force/);
  });
});

describe("expireOverrideIfMaterial — the daily no-change trap", () => {
  it("does NOT expire an override when the recalculation reproduces the exact same price", async () => {
    const ids = await fixture();
    const departed = await calculation(ids, 40_000n);
    const set = await setOverride(ids, departed.id, 80_000n);
    // Same price as `departed` — an immaterial (e.g. scheduled, no-op) run.
    const recalculated = await calculation(ids, 40_000n);

    const result = await expireOverrideIfMaterial({
      masterVariantId: ids.variant.id,
      newPriceCalculationId: recalculated.id,
    });

    expect(result.expired).toBe(false);
    expect(result.reason).toMatch(/immaterial/);

    // No row appended — this is the whole point of the trap test. If this
    // ever fires, every override in the system dies within 24 hours to the
    // next scheduled (D15) run.
    expect(await prisma.priceOverride.count({ where: { masterVariantId: ids.variant.id } })).toBe(1);
    const head = await prisma.priceOverride.findFirst({
      where: { masterVariantId: ids.variant.id, supersededBy: null },
    });
    expect(head!.id).toBe(set.id);
  });

  it("still does not expire after several identical recalculations in a row", async () => {
    const ids = await fixture();
    const departed = await calculation(ids, 40_000n);
    await setOverride(ids, departed.id, 80_000n);

    for (let i = 0; i < 3; i++) {
      const recalculated = await calculation(ids, 40_000n);
      const result = await expireOverrideIfMaterial({
        masterVariantId: ids.variant.id,
        newPriceCalculationId: recalculated.id,
      });
      expect(result.expired).toBe(false);
    }

    expect(await prisma.priceOverride.count({ where: { masterVariantId: ids.variant.id } })).toBe(1);
  });
});

describe("expireOverrideIfMaterial — materiality retires the override", () => {
  it("appends an `expired` row, chained onto the override it retires", async () => {
    const ids = await fixture();
    const departed = await calculation(ids, 40_000n);
    const set = await setOverride(ids, departed.id, 80_000n);
    const recalculated = await calculation(ids, 41_000n);

    const result = await expireOverrideIfMaterial({
      masterVariantId: ids.variant.id,
      newPriceCalculationId: recalculated.id,
    });

    expect(result.expired).toBe(true);
    if (!result.expired) throw new Error("unreachable");

    const row = await prisma.priceOverride.findUniqueOrThrow({
      where: { id: result.expiredOverrideId },
    });
    expect(row.kind).toBe("expired");
    expect(row.supersedesId).toBe(set.id);
    // Points at the NEW calculation that caused the expiry, not a copy of
    // the retired row's own reference — see the repository's doc comment.
    expect(row.priceCalculationId).toBe(recalculated.id);
    // No price: the CHECK constraint would refuse this row otherwise.
    expect(row.overrideBankPaymentPriceMinorUnits).toBeNull();
    expect(row.overriddenBy).toBe("system:price-recalculation");
  });

  it("leaves the RETIRED override itself untouched — append-only", async () => {
    const ids = await fixture();
    const departed = await calculation(ids, 40_000n);
    const set = await setOverride(ids, departed.id, 80_000n);
    const recalculated = await calculation(ids, 41_000n);

    await expireOverrideIfMaterial({
      masterVariantId: ids.variant.id,
      newPriceCalculationId: recalculated.id,
    });

    const original = await prisma.priceOverride.findUniqueOrThrow({ where: { id: set.id } });
    expect(original.kind).toBe("set");
    expect(original.overrideBankPaymentPriceMinorUnits).toBe(80_000n);
    expect(original.reason).toBe("test fixture");
  });

  it("expires on a price DECREASE too — 'differs', not 'increases'", async () => {
    const ids = await fixture();
    const departed = await calculation(ids, 40_000n);
    await setOverride(ids, departed.id, 80_000n);
    const recalculated = await calculation(ids, 39_000n);

    const result = await expireOverrideIfMaterial({
      masterVariantId: ids.variant.id,
      newPriceCalculationId: recalculated.id,
    });

    expect(result.expired).toBe(true);
  });

  it("accepts a caller-supplied attribution for the expired row", async () => {
    const ids = await fixture();
    const departed = await calculation(ids, 40_000n);
    await setOverride(ids, departed.id, 80_000n);
    const recalculated = await calculation(ids, 41_000n);

    const result = await expireOverrideIfMaterial({
      masterVariantId: ids.variant.id,
      newPriceCalculationId: recalculated.id,
      expiredBy: "system:recalculation-run-abc123",
    });

    expect(result.expired).toBe(true);
    if (!result.expired) throw new Error("unreachable");
    const row = await prisma.priceOverride.findUniqueOrThrow({
      where: { id: result.expiredOverrideId },
    });
    expect(row.overriddenBy).toBe("system:recalculation-run-abc123");
  });

  it("a subsequent call finds nothing in force — the expired row is not itself 'in force'", async () => {
    const ids = await fixture();
    const departed = await calculation(ids, 40_000n);
    await setOverride(ids, departed.id, 80_000n);
    const first = await calculation(ids, 41_000n);
    await expireOverrideIfMaterial({
      masterVariantId: ids.variant.id,
      newPriceCalculationId: first.id,
    });

    const second = await calculation(ids, 42_000n);
    const result = await expireOverrideIfMaterial({
      masterVariantId: ids.variant.id,
      newPriceCalculationId: second.id,
    });

    expect(result.expired).toBe(false);
    expect(result.reason).toMatch(/no override is currently in force/);
  });
});

describe("expireOverrideIfMaterial — neverExpire survives materiality", () => {
  it("does NOT expire even when the recalculation is material", async () => {
    const ids = await fixture();
    const departed = await calculation(ids, 40_000n);
    const set = await setOverride(ids, departed.id, 80_000n, { neverExpire: true });
    const recalculated = await calculation(ids, 999_999n);

    const result = await expireOverrideIfMaterial({
      masterVariantId: ids.variant.id,
      newPriceCalculationId: recalculated.id,
    });

    expect(result.expired).toBe(false);
    expect(result.reason).toMatch(/neverExpire/);
    expect(await prisma.priceOverride.count({ where: { masterVariantId: ids.variant.id } })).toBe(1);
    const head = await prisma.priceOverride.findFirst({
      where: { masterVariantId: ids.variant.id, supersededBy: null },
    });
    expect(head!.id).toBe(set.id);
  });

  it("survives repeated material recalculations, not just one", async () => {
    const ids = await fixture();
    const departed = await calculation(ids, 40_000n);
    await setOverride(ids, departed.id, 80_000n, { neverExpire: true });

    for (const price of [41_000n, 42_000n, 100_000n]) {
      const recalculated = await calculation(ids, price);
      const result = await expireOverrideIfMaterial({
        masterVariantId: ids.variant.id,
        newPriceCalculationId: recalculated.id,
      });
      expect(result.expired).toBe(false);
    }

    expect(await prisma.priceOverride.count({ where: { masterVariantId: ids.variant.id } })).toBe(1);
  });

  it("is removable only by an explicit human revoke — expiry cannot touch it", async () => {
    const ids = await fixture();
    const departed = await calculation(ids, 40_000n);
    const set = await setOverride(ids, departed.id, 80_000n, { neverExpire: true });
    const recalculated = await calculation(ids, 999_999n);

    await expireOverrideIfMaterial({
      masterVariantId: ids.variant.id,
      newPriceCalculationId: recalculated.id,
    });

    // Still exactly the human-set override, untouched — a revoke is the only
    // way this chain moves.
    const head = await prisma.priceOverride.findFirst({
      where: { masterVariantId: ids.variant.id, supersededBy: null },
    });
    expect(head!.id).toBe(set.id);
    expect(head!.kind).toBe("set");

    const revoke = await prisma.priceOverride.create({
      data: {
        masterVariantId: ids.variant.id,
        kind: "revoke",
        supersedesId: set.id,
        currency: "USD",
        breachedFloors: [],
        reason: "explicit human revoke",
        overriddenBy: "owner:brian",
      },
    });
    const newHead = await prisma.priceOverride.findFirst({
      where: { masterVariantId: ids.variant.id, supersededBy: null },
    });
    expect(newHead!.id).toBe(revoke.id);
  });
});

describe("expireOverrideIfMaterial — currency safety propagates", () => {
  it("throws rather than silently comparing across currencies", async () => {
    const ids = await fixture();
    const departed = await calculation(ids, 40_000n, "USD");
    await setOverride(ids, departed.id, 80_000n);
    const recalculated = await calculation(ids, 41_000n, "EUR");

    await expect(
      expireOverrideIfMaterial({
        masterVariantId: ids.variant.id,
        newPriceCalculationId: recalculated.id,
      })
    ).rejects.toThrow(OverrideExpiryCurrencyMismatchError);
  });
});

describe("expireOverrideIfMaterial — the coherence CHECK and the partial unique index", () => {
  it("the coherence CHECK refuses an expired row carrying a price — proven against a raw insert, not just this function", async () => {
    const ids = await fixture();
    const departed = await calculation(ids, 40_000n);
    const set = await setOverride(ids, departed.id, 80_000n);

    await expect(
      prisma.priceOverride.create({
        data: {
          masterVariantId: ids.variant.id,
          kind: "expired",
          supersedesId: set.id,
          overrideBankPaymentPriceMinorUnits: 12345n,
          currency: "USD",
          breachedFloors: [],
          reason: "incoherent",
          overriddenBy: "integration-test",
        },
      })
    ).rejects.toThrow(/price_override_kind_bank_payment_price_coherent/);
  });

  it("the partial unique index refuses two rows superseding the same predecessor", async () => {
    const ids = await fixture();
    const departed = await calculation(ids, 40_000n);
    const set = await setOverride(ids, departed.id, 80_000n);
    const recalculated = await calculation(ids, 41_000n);

    await expireOverrideIfMaterial({
      masterVariantId: ids.variant.id,
      newPriceCalculationId: recalculated.id,
    });

    // A second row explicitly forking the same predecessor is refused at
    // the database, independent of this repository's own idempotent
    // handling (exercised separately below).
    await expect(
      prisma.priceOverride.create({
        data: {
          masterVariantId: ids.variant.id,
          kind: "expired",
          supersedesId: set.id,
          currency: "USD",
          breachedFloors: [],
          reason: "forking the chain",
          overriddenBy: "integration-test",
        },
      })
    ).rejects.toThrow();
  });

  it("is idempotent under two CONCURRENT callers — exactly one expiry wins, the chain never forks", async () => {
    const ids = await fixture();
    const departed = await calculation(ids, 40_000n);
    const set = await setOverride(ids, departed.id, 80_000n);
    const recalculated = await calculation(ids, 41_000n);

    const [a, b] = await Promise.all([
      expireOverrideIfMaterial({
        masterVariantId: ids.variant.id,
        newPriceCalculationId: recalculated.id,
      }),
      expireOverrideIfMaterial({
        masterVariantId: ids.variant.id,
        newPriceCalculationId: recalculated.id,
      }),
    ]);

    // Neither call threw — the loser's unique-constraint violation was
    // caught and reinterpreted, never surfaced as a crash.
    const results = [a, b];
    expect(results.filter((r) => r.expired)).toHaveLength(1);

    // Exactly one row supersedes `set`, whichever caller "won".
    expect(await prisma.priceOverride.count({ where: { supersedesId: set.id } })).toBe(1);
  });
});
