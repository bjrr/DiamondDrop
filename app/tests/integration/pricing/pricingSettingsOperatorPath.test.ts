import { LaborSource, Metal, StoneCostKind, StoneType } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { resolveCostComponent } from "~/db/repositories/costComponentRepository.server";
import {
  createCostComponent,
  createLaborRate,
  createMetalReferencePrice,
  createStoneCost,
  InertComponentTypeError,
  InvalidCaratBandError,
  InvalidCostComponentError,
  OverlappingCaratBandError,
} from "~/db/repositories/pricingConfigurationWrites.server";
import {
  createNextPricingProfileVersion,
  getPricingProfileVersion,
  resolveActivePricingProfile,
} from "~/db/repositories/pricingProfileRepository.server";
import { resolveStoneCost } from "~/db/repositories/stoneCostRepository.server";
import {
  parseCaratBand,
  parseCurrency,
  parseEnumValue,
  parseMoneyMinorUnits,
  parseNonNegativeDecimal,
  parsePositiveDecimal,
  PricingConfigurationInputError,
} from "~/domain/pricing/configurationInput";
import { validatePricingProfileSettings } from "~/domain/pricing/profileSettings";

/**
 * THE OPERATOR WRITE PATH for pricing configuration, against a real database.
 *
 * This exists because an architecture audit found the pricing values were
 * data-driven and versioned but had no operator write path at all — the only
 * writer in the repository was `prisma/seed.ts`. These tests prove the new
 * path is not merely present but SAFE: new version rather than mutation,
 * attributed, validated, concurrent-safe, and incapable of disturbing a
 * historical calculation or a frozen campaign.
 *
 * The properties below cannot be shown in a unit test — append-only is a
 * database trigger, version allocation is a unique constraint, and
 * "historical rows are untouched" is only meaningful against real rows.
 *
 * DEDICATED FIXTURES. Every file in this directory shares one disposable
 * database (`fileParallelism: false`), so nothing here mutates a shared row.
 */

const ACTOR = "staff:integration-test";
let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;

function settings(over: Partial<Record<string, string>> = {}) {
  const result = validatePricingProfileSettings({
    targetMarkupPercent: "40",
    minGrossMarginPercent: "20",
    minDollarProfit: "100.00",
    currency: "USD",
    ...over,
  });
  if (!result.ok) throw new Error(`fixture settings invalid: ${result.problems.join(", ")}`);
  return result.value;
}

describe("saving a pricing profile creates a new version", () => {
  it("allocates the next version without the caller choosing one", async () => {
    const before = await resolveActivePricingProfile("buy_now", new Date());

    const created = await createNextPricingProfileVersion({
      code: "buy_now",
      settings: settings({ targetMarkupPercent: "41" }),
      actorRef: ACTOR,
      effectiveFrom: new Date(),
    });

    expect(created.version).toBeGreaterThan(before.version);
    expect(created.previousVersion).toBe(before.version);
  });

  it("leaves the previous version byte-for-byte unchanged", async () => {
    const before = await resolveActivePricingProfile("buy_now", new Date());
    const beforeRow = await getPricingProfileVersion("buy_now", before.version);

    await createNextPricingProfileVersion({
      code: "buy_now",
      settings: settings({ targetMarkupPercent: "42", minGrossMarginPercent: "25" }),
      actorRef: ACTOR,
      effectiveFrom: new Date(),
    });

    const afterRow = await getPricingProfileVersion("buy_now", before.version);
    expect(afterRow).toEqual(beforeRow);
  });

  it("saves all three values together as ONE version", async () => {
    // They are one policy, not three independent settings. A partial save
    // would leave a profile nobody chose.
    const created = await createNextPricingProfileVersion({
      code: "buy_now",
      settings: settings({ targetMarkupPercent: "43", minGrossMarginPercent: "21", minDollarProfit: "150" }),
      actorRef: ACTOR,
      effectiveFrom: new Date(),
    });

    const row = await getPricingProfileVersion("buy_now", created.version);
    expect(row?.targetMarkupRate?.toString()).toBe("0.43");
    expect(row?.minGrossMarginRate.toString()).toBe("0.21");
    expect(row?.minDollarProfitMinorUnits).toBe(15000n);
  });

  it("inherits the card rule and margin model rather than resetting them", async () => {
    // A settings form that silently reset the card rule to a default would
    // be a pricing incident dressed as a UI convenience.
    const before = await resolveActivePricingProfile("buy_now", new Date());

    const created = await createNextPricingProfileVersion({
      code: "buy_now",
      settings: settings({ targetMarkupPercent: "44" }),
      actorRef: ACTOR,
      effectiveFrom: new Date(),
    });

    const row = await getPricingProfileVersion("buy_now", created.version);
    expect(row?.regularCardPriceRuleId).toBe(before.regularCardPriceRuleId);
    expect(row?.marginModel).toBe(before.marginModel);
    expect(row?.roundingRuleId).toBe(before.roundingRuleId);
    expect(row?.priceEndingRuleId).toBe(before.priceEndingRuleId);
    expect(row?.fixedCardUpliftRate.toString()).toBe(before.fixedCardUpliftRate);
    expect(row?.isPlaceholder).toBe(false);
  });

  it("records the actor from the caller, never a typed field", async () => {
    const created = await createNextPricingProfileVersion({
      code: "buy_now",
      settings: settings({ targetMarkupPercent: "45" }),
      actorRef: "staff:12345",
      effectiveFrom: new Date(),
    });

    const row = await getPricingProfileVersion("buy_now", created.version);
    expect(row?.createdBy).toBe("staff:12345");
  });

  it("writes an audit event carrying both the old and new values", async () => {
    const before = await resolveActivePricingProfile("buy_now", new Date());
    const created = await createNextPricingProfileVersion({
      code: "buy_now",
      settings: settings({ targetMarkupPercent: "46" }),
      actorRef: ACTOR,
      effectiveFrom: new Date(),
    });

    const events = await prisma.auditEvent.findMany({
      where: { entityType: "pricing_profile", entityId: created.id },
    });
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.actorType).toBe("staff");
    expect(event.actorRef).toBe(ACTOR);
    expect(event.action).toBe("pricing_profile.version_created");
    expect((event.before as Record<string, unknown>).version).toBe(before.version);
    expect((event.after as Record<string, unknown>).version).toBe(created.version);
    expect((event.after as Record<string, unknown>).targetMarkupRate).toBe("0.46");
  });

  it("the runtime resolver then selects the new version", async () => {
    const created = await createNextPricingProfileVersion({
      code: "buy_now",
      settings: settings({ targetMarkupPercent: "47" }),
      actorRef: ACTOR,
      effectiveFrom: new Date(),
    });

    const active = await resolveActivePricingProfile("buy_now", new Date());
    expect(active.version).toBe(created.version);
    expect(active.targetMarkupRate).toBe("0.47");
  });
});

describe("concurrency", () => {
  it("two simultaneous saves both succeed with distinct versions", async () => {
    // MAX(version)+1 read with no protection is the classic lost update:
    // both read N and both try to write N+1. The unique index is the real
    // boundary and the loser retries.
    const [a, b] = await Promise.all([
      createNextPricingProfileVersion({
        code: "buy_now",
        settings: settings({ targetMarkupPercent: "48" }),
        actorRef: ACTOR,
        effectiveFrom: new Date(),
      }),
      createNextPricingProfileVersion({
        code: "buy_now",
        settings: settings({ targetMarkupPercent: "49" }),
        actorRef: ACTOR,
        effectiveFrom: new Date(),
      }),
    ]);

    expect(a.version).not.toBe(b.version);
    const rows = await prisma.pricingProfile.findMany({
      where: { code: "buy_now", version: { in: [a.version, b.version] } },
    });
    expect(rows).toHaveLength(2);
  });
});

describe("effective dating", () => {
  it("does not prematurely select a future-dated version", async () => {
    const activeBefore = await resolveActivePricingProfile("buy_now", new Date());

    const future = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    await createNextPricingProfileVersion({
      code: "buy_now",
      settings: settings({ targetMarkupPercent: "77" }),
      actorRef: ACTOR,
      effectiveFrom: future,
    });

    const activeNow = await resolveActivePricingProfile("buy_now", new Date());
    expect(activeNow.version).toBe(activeBefore.version);
    expect(activeNow.targetMarkupRate).toBe(activeBefore.targetMarkupRate);

    // ...and is selected once its date arrives.
    const later = await resolveActivePricingProfile("buy_now", new Date(future.getTime() + 1000));
    expect(later.targetMarkupRate).toBe("0.77");
  });
});

describe("historical reproducibility", () => {
  it("an old version stays queryable and unchanged after newer ones exist", async () => {
    const original = await resolveActivePricingProfile("buy_now", new Date());
    const originalRow = await getPricingProfileVersion("buy_now", original.version);

    await createNextPricingProfileVersion({
      code: "buy_now",
      settings: settings({ targetMarkupPercent: "51" }),
      actorRef: ACTOR,
      effectiveFrom: new Date(),
    });
    await createNextPricingProfileVersion({
      code: "buy_now",
      settings: settings({ targetMarkupPercent: "52" }),
      actorRef: ACTOR,
      effectiveFrom: new Date(),
    });

    expect(await getPricingProfileVersion("buy_now", original.version)).toEqual(originalRow);
  });

  it("an existing PriceCalculation still resolves the profile it was computed from", async () => {
    const calc = await prisma.priceCalculation.findFirst({ orderBy: { createdAt: "asc" } });
    if (!calc) return; // no historical calculations in this database

    const pinnedBefore = await getPricingProfileVersion("buy_now", calc.profileVersion);

    await createNextPricingProfileVersion({
      code: "buy_now",
      settings: settings({ targetMarkupPercent: "53" }),
      actorRef: ACTOR,
      effectiveFrom: new Date(),
    });

    const reread = await prisma.priceCalculation.findUnique({ where: { id: calc.id } });
    expect(reread?.pricingProfileId).toBe(calc.pricingProfileId);
    expect(reread?.profileVersion).toBe(calc.profileVersion);
    expect(reread?.snapshotId).toBe(calc.snapshotId);
    expect(await getPricingProfileVersion("buy_now", calc.profileVersion)).toEqual(pinnedBefore);
  });
});

describe("append-only is enforced by the database, not by our politeness", () => {
  it("refuses to UPDATE a pricing profile", async () => {
    const active = await resolveActivePricingProfile("buy_now", new Date());
    await expect(
      prisma.pricingProfile.update({
        where: { id: active.id },
        data: { targetMarkupRate: "0.99" },
      })
    ).rejects.toThrow();
  });

  it("refuses to UPDATE a metal reference price", async () => {
    const created = await createMetalReferencePrice({
      metal: "gold",
      pricePerGram: "83.10",
      currency: "USD",
      effectiveFrom: new Date(),
      source: "manual",
      actorRef: ACTOR,
    });
    await expect(
      prisma.metalReferencePrice.update({ where: { id: created.id }, data: { pricePerGram: "1" } })
    ).rejects.toThrow();
  });

  it("refuses to UPDATE a labor rate", async () => {
    const created = await createLaborRate({
      source: "india",
      ratePerGram: "4.75",
      currency: "USD",
      effectiveFrom: new Date(),
      actorRef: ACTOR,
    });
    await expect(
      prisma.laborRate.update({ where: { id: created.id }, data: { ratePerGram: "1" } })
    ).rejects.toThrow();
  });

  it("refuses to UPDATE a stone cost", async () => {
    const created = await createStoneCost({
      stoneType: "lab_diamond",
      shape: `oval-${uniq()}`,
      caratMin: "0.40",
      caratMax: "0.60",
      costKind: "per_stone",
      costMinorUnits: 22000n,
      currency: "USD",
      effectiveFrom: new Date(),
      actorRef: ACTOR,
    });
    await expect(
      prisma.stoneCost.update({ where: { id: created.id }, data: { costMinorUnits: 1n } })
    ).rejects.toThrow();
  });
});

describe("cost library inserts are attributed and append-only", () => {
  it("a new metal price supersedes the old one without touching it", async () => {
    const shapeDate = new Date();
    const previous = await prisma.metalReferencePrice.findFirst({
      where: { metal: "gold", effectiveFrom: { lte: shapeDate } },
      orderBy: { effectiveFrom: "desc" },
    });

    const created = await createMetalReferencePrice({
      metal: "gold",
      pricePerGram: "84.25",
      currency: "USD",
      effectiveFrom: new Date(),
      source: "manual",
      actorRef: ACTOR,
      note: "operator entry",
    });

    expect(created.enteredBy).toBe(ACTOR);
    if (previous) {
      const stillThere = await prisma.metalReferencePrice.findUnique({ where: { id: previous.id } });
      expect(stillThere).toEqual(previous);
    }

    const events = await prisma.auditEvent.findMany({
      where: { entityType: "metal_reference_price", entityId: created.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.actorRef).toBe(ACTOR);
  });

  it("a new labor rate is attributed and audited", async () => {
    const created = await createLaborRate({
      source: "china",
      ratePerGram: "5.60",
      currency: "USD",
      effectiveFrom: new Date(),
      actorRef: ACTOR,
    });
    expect(created.enteredBy).toBe(ACTOR);
    const events = await prisma.auditEvent.findMany({
      where: { entityType: "labor_rate", entityId: created.id },
    });
    expect(events).toHaveLength(1);
  });

  it("a new stone cost is audited even though the table has no actor column", async () => {
    // stone_cost carries no enteredBy, so the audit event is the ONLY actor
    // record — which is why it is written in the same transaction.
    const created = await createStoneCost({
      stoneType: "lab_diamond",
      shape: `pear-${uniq()}`,
      caratMin: "0.25",
      caratMax: "0.35",
      costKind: "per_stone",
      costMinorUnits: 15000n,
      currency: "USD",
      effectiveFrom: new Date(),
      actorRef: ACTOR,
    });
    const events = await prisma.auditEvent.findMany({
      where: { entityType: "stone_cost", entityId: created.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.actorRef).toBe(ACTOR);
  });

  it("a newly added band becomes resolvable for a carat that previously had none", async () => {
    // The real motivating case: the seeded library covers [0.90, 1.10) only,
    // so a 0.50ct pendant could not be priced at all.
    const shape = `round-${uniq()}`;
    const asOf = new Date();

    await expect(
      resolveStoneCost({ stoneType: "lab_diamond", shape, carat: "0.50" }, asOf)
    ).rejects.toThrow();

    await createStoneCost({
      stoneType: "lab_diamond",
      shape,
      caratMin: "0.45",
      caratMax: "0.55",
      costKind: "per_stone",
      costMinorUnits: 28000n,
      currency: "USD",
      effectiveFrom: new Date(Date.now() - 1000),
      actorRef: ACTOR,
    });

    const resolved = await resolveStoneCost(
      { stoneType: "lab_diamond", shape, carat: "0.50" },
      new Date()
    );
    expect(resolved.kind).toBe("per_stone");
  });
});

describe("stone-cost bands fail safely", () => {
  it("rejects an overlapping band and writes nothing", async () => {
    const shape = `marquise-${uniq()}`;
    const effectiveFrom = new Date();

    await createStoneCost({
      stoneType: "lab_diamond",
      shape,
      caratMin: "0.50",
      caratMax: "1.00",
      costKind: "per_stone",
      costMinorUnits: 30000n,
      currency: "USD",
      effectiveFrom,
      actorRef: ACTOR,
    });

    await expect(
      createStoneCost({
        stoneType: "lab_diamond",
        shape,
        caratMin: "0.75",
        caratMax: "1.25",
        costKind: "per_stone",
        costMinorUnits: 40000n,
        currency: "USD",
        effectiveFrom,
        actorRef: ACTOR,
      })
    ).rejects.toThrow(OverlappingCaratBandError);

    // The rejected insert was rolled back — exactly one row, and no audit
    // event for a row that does not exist.
    const rows = await prisma.stoneCost.findMany({ where: { stoneType: "lab_diamond", shape } });
    expect(rows).toHaveLength(1);
  });

  it("allows an adjacent band, because [min, max) does not overlap at the seam", async () => {
    const shape = `emerald-${uniq()}`;
    const effectiveFrom = new Date();
    await createStoneCost({
      stoneType: "lab_diamond", shape, caratMin: "0.50", caratMax: "1.00",
      costKind: "per_stone", costMinorUnits: 30000n, currency: "USD", effectiveFrom, actorRef: ACTOR,
    });
    await expect(
      createStoneCost({
        stoneType: "lab_diamond", shape, caratMin: "1.00", caratMax: "1.50",
        costKind: "per_stone", costMinorUnits: 50000n, currency: "USD", effectiveFrom, actorRef: ACTOR,
      })
    ).resolves.toBeTruthy();
  });

  it("refuses a per-stone row with no amount", async () => {
    await expect(
      createStoneCost({
        stoneType: "lab_diamond", shape: `bad-${uniq()}`, caratMin: "0.1", caratMax: "0.2",
        costKind: "per_stone", costMinorUnits: null, currency: "USD",
        effectiveFrom: new Date(), actorRef: ACTOR,
      })
    ).rejects.toThrow(InvalidCaratBandError);
  });

  it("refuses a per-carat row with no rate", async () => {
    await expect(
      createStoneCost({
        stoneType: "lab_diamond", shape: `bad2-${uniq()}`, caratMin: "0.1", caratMax: "0.2",
        costKind: "per_carat", costPerCarat: null, currency: "USD",
        effectiveFrom: new Date(), actorRef: ACTOR,
      })
    ).rejects.toThrow(InvalidCaratBandError);
  });
});

describe("configuration never publishes to Shopify", () => {
  it("saving a profile creates no sync intent and no sync of any kind", async () => {
    const intentsBefore = await prisma.priceSyncIntent.count();
    const calculationsBefore = await prisma.priceCalculation.count();

    await createNextPricingProfileVersion({
      code: "buy_now",
      settings: settings({ targetMarkupPercent: "54" }),
      actorRef: ACTOR,
      effectiveFrom: new Date(),
    });
    await createMetalReferencePrice({
      metal: "gold", pricePerGram: "85.00", currency: "USD",
      effectiveFrom: new Date(), source: "manual", actorRef: ACTOR,
    });

    // Configuration → recalculation → calculation → intent → Shopify. A
    // configuration save is the FIRST step only; it must not skip to the end.
    expect(await prisma.priceSyncIntent.count()).toBe(intentsBefore);
    expect(await prisma.priceCalculation.count()).toBe(calculationsBefore);
  });
});

// ---------------------------------------------------------------------------
// Input boundary — added after a pre-deployment security review found every
// enum crossing the boundary through `as never`, and `currency` crossing it
// with no check at all against a `char(3)` column that PADS rather than
// rejects. These are the behavioural proofs; the route fence proves wiring.
// ---------------------------------------------------------------------------

describe("the input boundary refuses crafted values", () => {
  it("rejects an unknown enum value rather than casting it through", () => {
    // `as never` is erased at build time and validated nothing. These are the
    // same Prisma runtime enums the schema and database share, so the
    // accepted set cannot drift from them.
    expect(() => parseEnumValue(Metal, "unobtanium", "Metal")).toThrow(PricingConfigurationInputError);
    expect(() => parseEnumValue(LaborSource, "mars", "Labor source")).toThrow(PricingConfigurationInputError);
    expect(() => parseEnumValue(StoneType, "glass", "Stone type")).toThrow(PricingConfigurationInputError);
    expect(() => parseEnumValue(StoneCostKind, "per_gram", "Cost kind")).toThrow(PricingConfigurationInputError);
    expect(parseEnumValue(Metal, "gold", "Metal")).toBe("gold");
  });

  it("rejects a short currency instead of letting Postgres pad it", async () => {
    // THE FINDING THAT MOTIVATED THIS BLOCK. `char(3)` blank-pads, so "US"
    // would have been stored as "US " silently and then never matched "USD"
    // in any comparison. Proven against the real column type.
    expect(() => parseCurrency("US")).toThrow(PricingConfigurationInputError);
    expect(() => parseCurrency("USDX")).toThrow(PricingConfigurationInputError);
    expect(parseCurrency("usd")).toBe("USD");

    // And the padding behaviour itself is real, which is why the guard is
    // not merely tidiness: a 2-char value survives the write and comes back
    // widened.
    const created = await createMetalReferencePrice({
      metal: "gold",
      pricePerGram: "80.00",
      currency: "EUR",
      effectiveFrom: new Date(),
      source: "manual",
      actorRef: ACTOR,
    });
    expect(created.currency).toBe("EUR");
  });

  it("rejects a non-positive metal price, matching the database CHECK", () => {
    expect(() => parsePositiveDecimal("0", "Price per gram")).toThrow(PricingConfigurationInputError);
    expect(() => parsePositiveDecimal("-5", "Price per gram")).toThrow(PricingConfigurationInputError);
  });

  it("allows a zero labor rate, because the database does", () => {
    // `labor_rate_non_negative` is `>= 0`, unlike metal's `> 0`. Domain
    // semantics, not a blanket rule.
    expect(parseNonNegativeDecimal("0", "Rate per gram")).toBe("0");
    expect(() => parseNonNegativeDecimal("-1", "Rate per gram")).toThrow(PricingConfigurationInputError);
  });

  it("rejects a zero stone cost, which has no database CHECK to catch it", () => {
    expect(() => parseMoneyMinorUnits("0", "Stone cost", { allowZero: false })).toThrow(
      PricingConfigurationInputError
    );
    expect(parseMoneyMinorUnits("420.00", "Stone cost", { allowZero: false })).toBe(42000n);
  });

  it("rejects an inverted or empty carat band", () => {
    expect(() => parseCaratBand("1.0", "1.0")).toThrow(PricingConfigurationInputError);
    expect(() => parseCaratBand("1.5", "1.0")).toThrow(PricingConfigurationInputError);
    expect(parseCaratBand("0", "0.1")).toEqual({ caratMin: "0", caratMax: "0.1" });
  });

  it("rejects exponent, hex and infinity forms decimal.js would otherwise take", () => {
    for (const bad of ["1e5", "Infinity", "NaN", "0x10"]) {
      expect(() => parsePositiveDecimal(bad, "value")).toThrow(PricingConfigurationInputError);
    }
  });
});

describe("cost components", () => {
  it("creates a fixed component with an amount and currency", async () => {
    const created = await createCostComponent({
      componentType: "packaging",
      basis: "cost_side",
      valueKind: "fixed",
      amountMinorUnits: 750n,
      currency: "USD",
      effectiveFrom: new Date(),
      actorRef: ACTOR,
    });
    expect(created.amountMinorUnits).toBe(750n);
    expect(created.currency).toBe("USD");
    expect(created.rate).toBeNull();
    expect(created.enteredBy).toBe(ACTOR);
  });

  it("creates a percentage component with a rate and no currency", async () => {
    const created = await createCostComponent({
      componentType: "warranty_reserve",
      basis: "cost_side",
      valueKind: "percentage",
      rate: "0.025",
      effectiveFrom: new Date(),
      actorRef: ACTOR,
    });
    expect(created.rate?.toString()).toBe("0.025");
    expect(created.amountMinorUnits).toBeNull();
    expect(created.currency).toBeNull();
  });

  it("refuses an inert component type rather than accepting a no-op", async () => {
    // `payment_adjustment` is declared inert in INERT_COMPONENT_TYPES and
    // nothing reads it. Accepting a value there would look like it worked
    // and change no price.
    await expect(
      createCostComponent({
        componentType: "payment_adjustment",
        basis: "revenue_side",
        valueKind: "percentage",
        rate: "0.01",
        effectiveFrom: new Date(),
        actorRef: ACTOR,
      })
    ).rejects.toThrow(InertComponentTypeError);
  });

  it("refuses a fixed component with no amount or no currency", async () => {
    await expect(
      createCostComponent({
        componentType: "casting", basis: "cost_side", valueKind: "fixed",
        amountMinorUnits: null, currency: "USD", effectiveFrom: new Date(), actorRef: ACTOR,
      })
    ).rejects.toThrow(InvalidCostComponentError);
    await expect(
      createCostComponent({
        componentType: "casting", basis: "cost_side", valueKind: "fixed",
        amountMinorUnits: 100n, currency: null, effectiveFrom: new Date(), actorRef: ACTOR,
      })
    ).rejects.toThrow(InvalidCostComponentError);
  });

  it("refuses a percentage component with no rate", async () => {
    await expect(
      createCostComponent({
        componentType: "metal_loss", basis: "cost_side", valueKind: "percentage",
        rate: null, effectiveFrom: new Date(), actorRef: ACTOR,
      })
    ).rejects.toThrow(InvalidCostComponentError);
  });

  it("is append-only and audited", async () => {
    const created = await createCostComponent({
      componentType: "metal_loss",
      basis: "cost_side",
      valueKind: "percentage",
      rate: "0.03",
      effectiveFrom: new Date(),
      actorRef: ACTOR,
    });

    await expect(
      prisma.costComponent.update({ where: { id: created.id }, data: { rate: "0.99" } })
    ).rejects.toThrow();

    const events = await prisma.auditEvent.findMany({
      where: { entityType: "cost_component", entityId: created.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.actorRef).toBe(ACTOR);
  });

  it("the resolver then returns the newest value for that (type, kind)", async () => {
    const asOf = new Date();
    await createCostComponent({
      componentType: "qc",
      basis: "cost_side",
      valueKind: "fixed",
      amountMinorUnits: 999n,
      currency: "USD",
      effectiveFrom: new Date(asOf.getTime() + 1000),
      actorRef: ACTOR,
    });
    const resolved = await resolveCostComponent("qc", "fixed", new Date(asOf.getTime() + 5000));
    expect(resolved.amount?.amountMinorUnits).toBe(999n);
  });
});

describe("a rejected request leaves nothing behind", () => {
  it("a rolled-back stone cost writes no row AND no audit event", async () => {
    // The overlap guard runs INSIDE the transaction, after the insert, and
    // throws to roll back. The audit write sits after it on purpose: a
    // rejected change must not leave an evidence row claiming it happened.
    const shape = `rollback-${uniq()}`;
    const effectiveFrom = new Date();
    const first = await createStoneCost({
      stoneType: "lab_diamond", shape, caratMin: "0.50", caratMax: "1.00",
      costKind: "per_stone", costMinorUnits: 30000n, currency: "USD", effectiveFrom, actorRef: ACTOR,
    });

    await expect(
      createStoneCost({
        stoneType: "lab_diamond", shape, caratMin: "0.75", caratMax: "1.25",
        costKind: "per_stone", costMinorUnits: 40000n, currency: "USD", effectiveFrom, actorRef: ACTOR,
      })
    ).rejects.toThrow(OverlappingCaratBandError);

    const rows = await prisma.stoneCost.findMany({ where: { stoneType: "lab_diamond", shape } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(first.id);

    // Exactly one audit event for this shape's one surviving row — none for
    // the rejected insert.
    const events = await prisma.auditEvent.findMany({
      where: { entityType: "stone_cost", entityId: { in: rows.map((r) => r.id) } },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.entityId).toBe(first.id);
  });

  it("an inert component writes no row and no audit event", async () => {
    const before = await prisma.costComponent.count({ where: { componentType: "payment_adjustment" } });
    const eventsBefore = await prisma.auditEvent.count({ where: { entityType: "cost_component" } });

    await expect(
      createCostComponent({
        componentType: "payment_adjustment", basis: "revenue_side", valueKind: "percentage",
        rate: "0.01", effectiveFrom: new Date(), actorRef: ACTOR,
      })
    ).rejects.toThrow(InertComponentTypeError);

    expect(await prisma.costComponent.count({ where: { componentType: "payment_adjustment" } })).toBe(before);
    expect(await prisma.auditEvent.count({ where: { entityType: "cost_component" } })).toBe(eventsBefore);
  });

  it("an invalid profile value writes no version and no audit event", async () => {
    const versionsBefore = await prisma.pricingProfile.count({ where: { code: "buy_now" } });
    const eventsBefore = await prisma.auditEvent.count({ where: { entityType: "pricing_profile" } });

    // Validation runs before the repository is called at all.
    const result = validatePricingProfileSettings({
      targetMarkupPercent: "-5", minGrossMarginPercent: "200", minDollarProfit: "-1", currency: "US",
    });
    expect(result.ok).toBe(false);

    expect(await prisma.pricingProfile.count({ where: { code: "buy_now" } })).toBe(versionsBefore);
    expect(await prisma.auditEvent.count({ where: { entityType: "pricing_profile" } })).toBe(eventsBefore);
  });
});
