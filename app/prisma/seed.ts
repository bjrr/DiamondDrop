// Slice 0 seed (policy_version) plus Slice 1 pricing fixtures
// (docs/specs/SLICE-1-PRICING.md §11 "Fixtures", §7.2, T4).
//
// IDEMPOTENCY UNDER APPEND-ONLY TABLES (§4.0 L1: metal_price, stone_cost,
// cost_component, pricing_profile — all append-only at the database level,
// see the append_only_evidence_triggers migrations). `upsert` is wrong for
// these: an existing row would take the UPDATE branch, and the append-only
// trigger rejects any UPDATE outright, so `npm run db:seed` run twice would
// crash on the second run. Instead, each L1 row is looked up by its natural
// key (the same key its DB unique constraint enforces) and only created if
// absent — a no-op on the second run, never an edit.
//
// Design/definition tables (master_product, master_variant, ring_size_band,
// variant_weight_override, master_variant_stone) are mutable, so ordinary
// `upsert` against a fixed, deterministic seed id is safe and idempotent.
//
// All decimal-shaped values are passed as STRINGS and all money-shaped
// values as native `bigint` literals — never a JS `number` — matching the
// F-9/F-10/F-16 conventions the rest of the codebase enforces at the
// domain boundary (app/domain/money). This file has no arithmetic at all:
// every value below is a literal.
import { createHash } from "node:crypto";

import "dotenv/config";
import {
  CostComponentBasis,
  CostComponentType,
  CostComponentValueKind,
  MasterProductStatus,
  LaborSource,
  MasterVariantStatus,
  Metal,
  MetalPriceSource,
  PricingProfileCode,
  PrismaClient,
  Purity,
  SizeAxis,
  StoneCostKind,
  StoneType,
} from "@prisma/client";

const prisma = new PrismaClient();

// Fixed, obviously-synthetic effective date shared by every L1 row seeded
// here, so re-running this script always resolves to the same natural key.
const SEED_EFFECTIVE_FROM = new Date("2026-01-01T00:00:00.000Z");
const SEED_CURRENCY = "USD";
/**
 * When the owner s real pricing controls took effect (D14, resolved
 * 2026-09-17). Later than SEED_EFFECTIVE_FROM so effective-dated resolution
 * picks v2 over the v1 placeholder for any as-of date from this point on.
 */
const D14_EFFECTIVE_FROM = new Date("2026-09-17T00:00:00.000Z");
/**
 * When the owner's auto-apply tolerance and the inverted cash-discount model
 * took effect. Later than D14_EFFECTIVE_FROM so effective-dated resolution
 * picks v3 over v2.
 */
const D9_REVISION_EFFECTIVE_FROM = new Date("2026-09-17T18:00:00.000Z");
const SEED_ENTERED_BY = "seed-script";

// Fixed, deterministic ids for the mutable design/definition rows, so
// `upsert` is stable across runs. Deliberately in an obviously-fake
// namespace (all-zero prefix) — see docs/specs/SLICE-1-PRICING.md §11:
// "No real supplier data; representative placeholder values only, clearly
// marked as such."
const SEED_PRODUCT_ID = "00000000-0000-4000-8000-000000000001";
const SEED_BAND_LOW_ID = "00000000-0000-4000-8000-000000000011"; // 2–6
const SEED_BAND_MID_ID = "00000000-0000-4000-8000-000000000012"; // 6.5–8
const SEED_BAND_HIGH_ID = "00000000-0000-4000-8000-000000000013"; // 8.5–11
const SEED_VARIANT_GOLD_LOW_ID = "00000000-0000-4000-8000-000000000021";
const SEED_VARIANT_GOLD_MID_ID = "00000000-0000-4000-8000-000000000022";
const SEED_VARIANT_GOLD_HIGH_ID = "00000000-0000-4000-8000-000000000023";
const SEED_VARIANT_PLATINUM_MID_ID = "00000000-0000-4000-8000-000000000024";

/** Creates an L1 append-only row only if no row already matches its natural key. */
async function createIfAbsent<T>(label: string, find: () => Promise<T | null>, create: () => Promise<T>): Promise<void> {
  const existing = await find();
  if (existing) {
    console.log(`  (unchanged) ${label}`);
    return;
  }
  await create();
  console.log(`  (created)   ${label}`);
}

async function seedPolicyVersion(): Promise<void> {
  const slug = "sample-policy";
  const version = 1;
  const text = "This is a placeholder policy version created by the Slice 0 seed script.";
  const contentHash = createHash("sha256").update(text, "utf8").digest("hex");

  await prisma.policyVersion.upsert({
    where: { slug_version: { slug, version } },
    update: {},
    create: {
      slug,
      version,
      effectiveFrom: new Date(),
      text,
      contentHash,
    },
  });

  console.log(`Seeded policy_version "${slug}" v${version}.`);
}

async function seedMetalPrices(): Promise<void> {
  console.log("Seeding metal_reference_price...");

  // PURE metal, per gram. The alloyed price is derived as pure x fineness (see
  // app/domain/pricing/purity.ts) — do NOT add per-karat rows here.
  //
  // These are back-derived from the previous per-karat fixtures so prices stay
  // in the same region: 14k was $48.25/g, and 48.25 / 0.583333 = 82.70. Doing
  // that arithmetic exposed exactly the drift this model prevents — 10k had
  // been seeded at $29.50/g, implying $70.80/g pure, a 17% disagreement with
  // the other two karats that nothing could detect.
  const references: { metal: Metal; pricePerGram: string }[] = [
    { metal: Metal.gold, pricePerGram: "82.700000" },
    { metal: Metal.platinum, pricePerGram: "36.580000" },
    { metal: Metal.sterling_silver, pricePerGram: "0.918900" },
  ];

  for (const { metal, pricePerGram } of references) {
    await createIfAbsent(
      `metal_reference_price ${metal}`,
      () =>
        prisma.metalReferencePrice.findFirst({
          where: { metal, effectiveFrom: SEED_EFFECTIVE_FROM },
        }),
      () =>
        prisma.metalReferencePrice.create({
          data: {
            metal,
            pricePerGram,
            currency: SEED_CURRENCY,
            effectiveFrom: SEED_EFFECTIVE_FROM,
            source: MetalPriceSource.manual,
            enteredBy: SEED_ENTERED_BY,
            note: "Seed fixture reference — not a real market quote.",
          },
        })
    );
  }
}
async function seedStoneCosts(): Promise<void> {
  console.log("Seeding stone_cost...");

  type StoneRow = {
    stoneType: StoneType;
    shape: string;
    caratMin: string;
    caratMax: string;
    color: string | null;
    clarity: string | null;
    cutGrade: string | null;
    labStatus: string | null;
    supplierRef: string | null;
  } & ({ costKind: "per_stone"; costMinorUnits: bigint; costPerCarat: null } | { costKind: "per_carat"; costMinorUnits: null; costPerCarat: string });

  const rows: StoneRow[] = [
    // Round vs. princess at the SAME carat band, different cost — the R4
    // fixture (§11): "shapes must not be assumed to cost the same."
    // Round also matches the §5.8 worked example ($420.00 for a 1.00 ct
    // round lab diamond).
    {
      stoneType: StoneType.lab_diamond,
      shape: "round",
      caratMin: "0.900",
      caratMax: "1.100",
      color: null,
      clarity: null,
      cutGrade: null,
      labStatus: null,
      supplierRef: null,
      costKind: "per_stone",
      costMinorUnits: 42000n,
      costPerCarat: null,
    },
    {
      stoneType: StoneType.lab_diamond,
      shape: "princess",
      caratMin: "0.900",
      caratMax: "1.100",
      color: null,
      clarity: null,
      cutGrade: null,
      labStatus: null,
      supplierRef: null,
      costKind: "per_stone",
      costMinorUnits: 39000n,
      costPerCarat: null,
    },
    // Accent melee — matches the §5.8 worked example ($3.25/stone).
    {
      stoneType: StoneType.accent_melee,
      shape: "round",
      caratMin: "0.000",
      caratMax: "0.100",
      color: null,
      clarity: null,
      cutGrade: null,
      labStatus: null,
      supplierRef: null,
      costKind: "per_stone",
      costMinorUnits: 325n,
      costPerCarat: null,
    },
    // Moissanite — required cost library per R3, exercised with its own row.
    {
      stoneType: StoneType.moissanite,
      shape: "round",
      caratMin: "0.900",
      caratMax: "1.100",
      color: null,
      clarity: null,
      cutGrade: null,
      labStatus: null,
      supplierRef: null,
      costKind: "per_stone",
      costMinorUnits: 8000n,
      costPerCarat: null,
    },
    // Colored gemstone, per-carat costKind — exercises the OTHER branch of
    // stone_cost's CHECK constraint (per_stone rows above only exercise one).
    {
      stoneType: StoneType.colored_gemstone,
      shape: "oval",
      caratMin: "0.500",
      caratMax: "1.500",
      color: null,
      clarity: null,
      cutGrade: null,
      labStatus: null,
      supplierRef: null,
      costKind: "per_carat",
      costMinorUnits: null,
      costPerCarat: "150.000000",
    },
  ];

  for (const row of rows) {
    await createIfAbsent(
      `stone_cost ${row.stoneType}/${row.shape} [${row.caratMin},${row.caratMax})`,
      // NOTE: Prisma's generated compound-unique `findUnique` input types a
      // nullable key column as non-nullable `string` (it cannot express an
      // exact-NULL match through that special input shape), so a natural
      // key with wildcard NULLs — exactly what most of these fixture rows
      // have — cannot go through `stone_cost_natural_key`. `findFirst`
      // with ordinary field filters accepts `null` normally.
      () =>
        prisma.stoneCost.findFirst({
          where: {
            stoneType: row.stoneType,
            shape: row.shape,
            caratMin: row.caratMin,
            caratMax: row.caratMax,
            color: row.color,
            clarity: row.clarity,
            cutGrade: row.cutGrade,
            labStatus: row.labStatus,
            supplierRef: row.supplierRef,
            effectiveFrom: SEED_EFFECTIVE_FROM,
          },
        }),
      () =>
        prisma.stoneCost.create({
          data: {
            stoneType: row.stoneType,
            shape: row.shape,
            caratMin: row.caratMin,
            caratMax: row.caratMax,
            color: row.color,
            clarity: row.clarity,
            cutGrade: row.cutGrade,
            labStatus: row.labStatus,
            supplierRef: row.supplierRef,
            costKind: row.costKind === "per_stone" ? StoneCostKind.per_stone : StoneCostKind.per_carat,
            costMinorUnits: row.costKind === "per_stone" ? row.costMinorUnits : null,
            costPerCarat: row.costKind === "per_carat" ? row.costPerCarat : null,
            currency: SEED_CURRENCY,
            effectiveFrom: SEED_EFFECTIVE_FROM,
          },
        })
    );
  }
}

type CostComponentRow = {
  componentType: CostComponentType;
  basis: CostComponentBasis;
} & (
  | { valueKind: "fixed" | "per_stone"; amountMinorUnits: bigint; rate: null }
  | { valueKind: "percentage"; amountMinorUnits: null; rate: string }
);

async function seedCostComponents(): Promise<void> {
  console.log("Seeding cost_component...");

  const rows: CostComponentRow[] = [
    // Explicit zero (§4.5): configurable without inventing a scrap-loss
    // number. An absent row would be a MissingCostInputError; this zero is
    // a legitimate, auditable statement.
    { componentType: CostComponentType.metal_loss, basis: CostComponentBasis.cost_side, valueKind: "percentage", amountMinorUnits: null, rate: "0.000000" },

    // Labour — CAD/casting/setting/polishing/assembly/QC, all cost_side
    // (§4.2). casting/polishing/qc/setting match the §5.8 worked example.
    { componentType: CostComponentType.cad, basis: CostComponentBasis.cost_side, valueKind: "fixed", amountMinorUnits: 2000n, rate: null },
    { componentType: CostComponentType.casting, basis: CostComponentBasis.cost_side, valueKind: "fixed", amountMinorUnits: 2500n, rate: null },
    { componentType: CostComponentType.setting, basis: CostComponentBasis.cost_side, valueKind: "per_stone", amountMinorUnits: 400n, rate: null },
    { componentType: CostComponentType.polishing, basis: CostComponentBasis.cost_side, valueKind: "fixed", amountMinorUnits: 800n, rate: null },
    { componentType: CostComponentType.assembly, basis: CostComponentBasis.cost_side, valueKind: "fixed", amountMinorUnits: 1000n, rate: null },
    { componentType: CostComponentType.qc, basis: CostComponentBasis.cost_side, valueKind: "fixed", amountMinorUnits: 500n, rate: null },

    // Overhead — packaging/shipping/insurance/warranty_reserve, in the
    // §5.2 step-5 fixed order. insurance here is cost_side + fixed (the
    // §5.8 example's choice); §4.4's revenue_side alternative is exercised
    // by unit tests directly, not by seed data, to avoid double-counting
    // insurance in the same fixture.
    { componentType: CostComponentType.packaging, basis: CostComponentBasis.cost_side, valueKind: "fixed", amountMinorUnits: 600n, rate: null },
    { componentType: CostComponentType.shipping, basis: CostComponentBasis.cost_side, valueKind: "fixed", amountMinorUnits: 1200n, rate: null },
    { componentType: CostComponentType.insurance, basis: CostComponentBasis.cost_side, valueKind: "fixed", amountMinorUnits: 300n, rate: null },
    { componentType: CostComponentType.warranty_reserve, basis: CostComponentBasis.cost_side, valueKind: "percentage", amountMinorUnits: null, rate: "0.020000" },

    // Explicit zeros (§4.5) rather than omitted rows, so a resolver that
    // requires every componentType present does not fail this fixture.
    { componentType: CostComponentType.supplier_fee, basis: CostComponentBasis.cost_side, valueKind: "fixed", amountMinorUnits: 0n, rate: null },
    { componentType: CostComponentType.other, basis: CostComponentBasis.cost_side, valueKind: "fixed", amountMinorUnits: 0n, rate: null },

    // Payment processing (§4.2, §4.6): revenue_side, percentage rate PLUS a
    // separate fixed fee row — the CHECK constraint requires exactly one of
    // amount/rate per row, so "2.9% + $0.30" is two rows of the same
    // componentType distinguished by valueKind, matching the §5.8 example.
    { componentType: CostComponentType.payment_processing, basis: CostComponentBasis.revenue_side, valueKind: "percentage", amountMinorUnits: null, rate: "0.029000" },
    { componentType: CostComponentType.payment_processing, basis: CostComponentBasis.revenue_side, valueKind: "fixed", amountMinorUnits: 30n, rate: null },
  ];

  for (const row of rows) {
    await createIfAbsent(
      `cost_component ${row.componentType}/${row.valueKind}`,
      () =>
        prisma.costComponent.findUnique({
          where: {
            componentType_valueKind_effectiveFrom: {
              componentType: row.componentType,
              valueKind:
                row.valueKind === "fixed"
                  ? CostComponentValueKind.fixed
                  : row.valueKind === "per_stone"
                    ? CostComponentValueKind.per_stone
                    : CostComponentValueKind.percentage,
              effectiveFrom: SEED_EFFECTIVE_FROM,
            },
          },
        }),
      () =>
        prisma.costComponent.create({
          data: {
            componentType: row.componentType,
            basis: row.basis,
            valueKind:
              row.valueKind === "fixed"
                ? CostComponentValueKind.fixed
                : row.valueKind === "per_stone"
                  ? CostComponentValueKind.per_stone
                  : CostComponentValueKind.percentage,
            amountMinorUnits: row.amountMinorUnits,
            currency: row.amountMinorUnits !== null ? SEED_CURRENCY : null,
            rate: row.rate,
            effectiveFrom: SEED_EFFECTIVE_FROM,
            enteredBy: SEED_ENTERED_BY,
            note: "Seed fixture value — not a real cost assumption.",
          },
        })
    );
  }
}

async function seedPricingProfile(): Promise<void> {
  console.log("Seeding pricing_profile...");

  // v1 — the original D14 placeholder. RETAINED, not edited: pricing_profile is
  // append-only, and calculations already reference this version. Its absurd
  // values (99.99% margin, $9,999,999.00 minimum profit) exist so placeholder
  // data could never be mistaken for business data.
  await createIfAbsent(
    "pricing_profile buy_now v1 (superseded D14 placeholder)",
    () =>
      prisma.pricingProfile.findUnique({
        where: { code_version: { code: PricingProfileCode.buy_now, version: 1 } },
      }),
    () =>
      prisma.pricingProfile.create({
        data: {
          code: PricingProfileCode.buy_now,
          version: 1,
          marginModel: "TARGET_GROSS_MARGIN_V1",
          targetGrossMarginRate: "0.999900",
          minGrossMarginRate: "0.999800",
          minDollarProfitMinorUnits: 999999900n,
          currency: SEED_CURRENCY,
          roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
          creditCardPriceRuleId: "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1",
          creditCardUpliftRate: "0.050000",
          priceEndingRuleId: "NONE_V1",
          autoApplyToleranceBps: 0,
          effectiveFrom: SEED_EFFECTIVE_FROM,
          createdBy:
            "seed-script (D14 PLACEHOLDER — superseded by v2; see docs/ARCHITECTURE-MVP1.md D14)",
          isPlaceholder: true,
        },
      })
  );

  // v2 — REAL BUSINESS DATA. Owner decision D14, resolved 2026-09-17.
  //
  //   target markup           40% ON COST  -> price = cost x 1.40
  //   minimum gross margin    20% OF PRICE (hard floor)
  //   minimum dollar profit   $100.00      (hard floor)
  //   price ending            whole dollars, rounded up
  //
  // Markup and margin are different bases and are NOT interchangeable: 40%
  // markup on cost is a 28.6% gross margin. Both numbers are the owner s, and
  // each is stored against the model that reads it.
  //
  // autoApplyToleranceBps is NULL on purpose. The owner has not yet supplied
  // the tolerance, and per their instruction the engine may calculate and
  // display real prices while AUTOMATIC Shopify publication stays disabled.
  // NULL is what disables it; a defaulted number here would silently enable
  // automatic publication of prices no one had agreed a threshold for.
  //
  // isPlaceholder is FALSE: these are real approved numbers, so the T8 review
  // CLI will allow approvals against this profile.
  await createIfAbsent(
    "pricing_profile buy_now v2 (D14 resolved — real business data)",
    () =>
      prisma.pricingProfile.findUnique({
        where: { code_version: { code: PricingProfileCode.buy_now, version: 2 } },
      }),
    () =>
      prisma.pricingProfile.create({
        data: {
          code: PricingProfileCode.buy_now,
          version: 2,
          marginModel: "MARKUP_ON_COST_V1",
          targetMarkupRate: "0.400000",
          minGrossMarginRate: "0.200000",
          minDollarProfitMinorUnits: 10000n,
          currency: SEED_CURRENCY,
          roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
          creditCardPriceRuleId: "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1",
          creditCardUpliftRate: "0.050000",
          priceEndingRuleId: "WHOLE_DOLLAR_UP_V1",
          autoApplyToleranceBps: null,
          effectiveFrom: D14_EFFECTIVE_FROM,
          createdBy: "seed-script (owner decision D14, resolved 2026-09-17)",
          isPlaceholder: false,
        },
      })
  );

  // v3 — the owner's two remaining decisions, 2026-09-17.
  //
  //   auto-apply tolerance   200 bps (2%)
  //   card uplift            5% above the calculated cash price
  //
  // The tolerance closes D14: price changes within 2% of the last published
  // price may publish automatically, and anything larger queues for approval.
  // A 1% move in landed cost produces a 100 bps move in price, so 2% absorbs
  // ordinary daily metal movement while still catching a mistyped metal price.
  // It is symmetric: a 3% DROP queues exactly as a 3% rise does.
  //
  // D9 in its final shape, clarified 2026-09-18. The CALCULATED price is the
  // CASH-EQUIVALENT price (ACH, wire, Zelle, check): it is the authoritative
  // business price, the floors bind it,
  // and profit is measured on it. The DISPLAYED price is cash x 1.05, and that
  // is what gets published; cash is presented to the customer as a discount
  // off it.
  //
  // Because the floors bind the lower cash price, both displayed prices clear
  // those floors by construction. Card-processing expense is NOT subtracted
  // from the cash margin/profit floors; the 5% uplift is a separate derived
  // payment/display layer. See docs/CASH-CARD-PRICING.md.
  //
  // Note a 5% UPLIFT is not a 5% DISCOUNT: $400 cash becomes $420 card, and
  // $400 is 4.76% off $420. Advertising a flat "5% cash discount" on this rate
  // would overstate it — see cardPrice.ts.
  await createIfAbsent(
    "pricing_profile buy_now v3 (tolerance 200 bps; 5% cash discount)",
    () =>
      prisma.pricingProfile.findUnique({
        where: { code_version: { code: PricingProfileCode.buy_now, version: 3 } },
      }),
    () =>
      prisma.pricingProfile.create({
        data: {
          code: PricingProfileCode.buy_now,
          version: 3,
          marginModel: "MARKUP_ON_COST_V1",
          targetMarkupRate: "0.400000",
          minGrossMarginRate: "0.200000",
          minDollarProfitMinorUnits: 10000n,
          currency: SEED_CURRENCY,
          roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
          priceEndingRuleId: "WHOLE_DOLLAR_UP_V1",
          autoApplyToleranceBps: 200,
          creditCardPriceRuleId: "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1",
          creditCardUpliftRate: "0.050000",
          effectiveFrom: D9_REVISION_EFFECTIVE_FROM,
          createdBy: "seed-script (owner decisions D14 tolerance + D9 revision, 2026-09-17)",
          isPlaceholder: false,
        },
      })
  );
}

async function seedLaborRates(): Promise<void> {
  console.log("Seeding labor_rate...");

  // FIXTURE VALUES, not business data. The real per-gram rates are supplier
  // quotes the owner has not yet supplied, so these are plausible-but-invented
  // and are here only so the engine has something to resolve. They are NOT
  // marked placeholder the way the pricing profile was, because a labour rate
  // has no "obviously absurd" form — a wrong-but-reasonable number is exactly
  // the hazard, which is why this comment exists instead.
  const rates: { source: "india" | "china" | "usa"; ratePerGram: string }[] = [
    { source: "india", ratePerGram: "4.500000" },
    { source: "china", ratePerGram: "5.250000" },
    { source: "usa", ratePerGram: "12.000000" },
  ];

  for (const { source, ratePerGram } of rates) {
    await createIfAbsent(
      `labor_rate ${source}`,
      () =>
        prisma.laborRate.findFirst({
          where: { source, effectiveFrom: SEED_EFFECTIVE_FROM },
        }),
      () =>
        prisma.laborRate.create({
          data: {
            source,
            ratePerGram,
            currency: SEED_CURRENCY,
            effectiveFrom: SEED_EFFECTIVE_FROM,
            enteredBy: SEED_ENTERED_BY,
            note: "Seed fixture rate — not a real supplier quote.",
          },
        })
    );
  }
}

async function seedRingFixture(): Promise<void> {
  console.log("Seeding master_product/master_variant fixture (Buy Now ring)...");

  await prisma.masterProduct.upsert({
    where: { id: SEED_PRODUCT_ID },
    update: {},
    create: {
      id: SEED_PRODUCT_ID,
      name: "Seed Fixture Solitaire Ring",
      category: "ring",
      description: "Synthetic seed fixture for exercising the Slice 1 pricing engine. Not a real catalog item.",
      sizeAxis: SizeAxis.ring_size_us,
      allowedSizeMin: "2.00",
      allowedSizeMax: "11.00",
      sizeIncrement: "0.50",
      baseSize: "6.00",
      offeredMetals: [Metal.gold, Metal.platinum],
      isLuxurySteal: false,
      status: MasterProductStatus.active,
    },
  });

  await prisma.ringSizeBand.upsert({
    where: { id: SEED_BAND_LOW_ID },
    update: {},
    create: { id: SEED_BAND_LOW_ID, masterProductId: SEED_PRODUCT_ID, label: "2–6", sizeMin: "2.00", sizeMax: "6.00", sortOrder: 1 },
  });
  await prisma.ringSizeBand.upsert({
    where: { id: SEED_BAND_MID_ID },
    update: {},
    create: { id: SEED_BAND_MID_ID, masterProductId: SEED_PRODUCT_ID, label: "6.5–8", sizeMin: "6.50", sizeMax: "8.00", sortOrder: 2 },
  });
  await prisma.ringSizeBand.upsert({
    where: { id: SEED_BAND_HIGH_ID },
    update: {},
    create: { id: SEED_BAND_HIGH_ID, masterProductId: SEED_PRODUCT_ID, label: "8.5–11", sizeMin: "8.50", sizeMax: "11.00", sortOrder: 3 },
  });

  // 14k gold base weight/increment matches the §5.8 worked example exactly
  // (base 3.2000 g at size 6, +0.1500 g per full size).
  await prisma.masterVariant.upsert({
    where: { id: SEED_VARIANT_GOLD_LOW_ID },
    update: {},
    create: {
      id: SEED_VARIANT_GOLD_LOW_ID,
      masterProductId: SEED_PRODUCT_ID,
      metal: Metal.gold,
      purity: Purity.GOLD_14K,
      bandId: SEED_BAND_LOW_ID,
      baseWeightGrams: "3.2000",
      weightPerFullSizeGrams: "0.1500",
      status: MasterVariantStatus.active,
      laborSource: LaborSource.india,
    },
  });
  await prisma.masterVariant.upsert({
    where: { id: SEED_VARIANT_GOLD_MID_ID },
    update: {},
    create: {
      id: SEED_VARIANT_GOLD_MID_ID,
      masterProductId: SEED_PRODUCT_ID,
      metal: Metal.gold,
      purity: Purity.GOLD_14K,
      bandId: SEED_BAND_MID_ID,
      baseWeightGrams: "3.2000",
      weightPerFullSizeGrams: "0.1500",
      status: MasterVariantStatus.active,
      laborSource: LaborSource.india,
    },
  });
  await prisma.masterVariant.upsert({
    where: { id: SEED_VARIANT_GOLD_HIGH_ID },
    update: {},
    create: {
      id: SEED_VARIANT_GOLD_HIGH_ID,
      masterProductId: SEED_PRODUCT_ID,
      metal: Metal.gold,
      purity: Purity.GOLD_14K,
      bandId: SEED_BAND_HIGH_ID,
      baseWeightGrams: "3.2000",
      weightPerFullSizeGrams: "0.1500",
      status: MasterVariantStatus.active,
      laborSource: LaborSource.india,
    },
  });
  await prisma.masterVariant.upsert({
    where: { id: SEED_VARIANT_PLATINUM_MID_ID },
    update: {},
    create: {
      id: SEED_VARIANT_PLATINUM_MID_ID,
      masterProductId: SEED_PRODUCT_ID,
      metal: Metal.platinum,
      purity: Purity.PLATINUM_950,
      bandId: SEED_BAND_MID_ID,
      baseWeightGrams: "5.5000",
      weightPerFullSizeGrams: "0.2500",
      status: MasterVariantStatus.active,
      laborSource: LaborSource.india,
    },
  });

  // Exact finished-weight override (R8) on the gold/6.5–8 variant, at an
  // INTERIOR size of the band, heavier than the linear model would predict
  // (3.2 + (7.5-6)*0.15 = 3.425 g). Exercises override precedence and gives
  // T7/T9 a ready-made case for criterion 11's "interior size is the band's
  // true maximum" scenario, which a band.max shortcut would get wrong.
  await prisma.variantWeightOverride.upsert({
    where: { masterVariantId_size: { masterVariantId: SEED_VARIANT_GOLD_MID_ID, size: "7.50" } },
    update: {},
    create: {
      masterVariantId: SEED_VARIANT_GOLD_MID_ID,
      size: "7.50",
      weightGrams: "5.0000",
      reason: "Seed fixture override — exercises R8 precedence and the interior-maximum band case (criterion 11). Not a real production weight.",
    },
  });

  // Stone composition on the gold/6.5–8 variant, matching the §5.8 worked
  // example exactly: one 1.00 ct round lab diamond centre stone, 12 round
  // accent melee.
  await prisma.masterVariantStone.upsert({
    where: { masterVariantId_position: { masterVariantId: SEED_VARIANT_GOLD_MID_ID, position: 1 } },
    update: {},
    create: {
      masterVariantId: SEED_VARIANT_GOLD_MID_ID,
      position: 1,
      stoneType: StoneType.lab_diamond,
      shape: "round",
      carat: "1.000",
      quantity: 1,
    },
  });
  await prisma.masterVariantStone.upsert({
    where: { masterVariantId_position: { masterVariantId: SEED_VARIANT_GOLD_MID_ID, position: 2 } },
    update: {},
    create: {
      masterVariantId: SEED_VARIANT_GOLD_MID_ID,
      position: 2,
      stoneType: StoneType.accent_melee,
      shape: "round",
      carat: "0.020",
      quantity: 12,
    },
  });
}

async function main() {
  await seedPolicyVersion();
  await seedMetalPrices();
  await seedStoneCosts();
  await seedCostComponents();
  await seedPricingProfile();
  await seedLaborRates();
  await seedRingFixture();
  console.log("\nSeed complete.");
}

main()
  .catch((error) => {
    console.error("Seed failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
