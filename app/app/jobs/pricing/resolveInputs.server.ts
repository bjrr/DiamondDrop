import type { CostComponentType } from "@prisma/client";

import { prisma } from "~/db/client.server";
import { resolveCostComponentsOfType } from "~/db/repositories/costComponentRepository.server";
import { MissingCostInputError } from "~/db/repositories/effectiveDated.server";
import { resolveLaborRate } from "~/db/repositories/laborRateRepository.server";
import { resolveMetalPrice } from "~/db/repositories/metalPriceRepository.server";
import { resolveActivePricingProfile } from "~/db/repositories/pricingProfileRepository.server";
import { resolveStoneCost } from "~/db/repositories/stoneCostRepository.server";
import { MoneyDecimal } from "~/domain/money/decimal";
import type {
  BuyNowPricingInputs,
  ResolvedCostComponent,
  ResolvedStonePosition,
} from "~/domain/pricing/types";

/**
 * THE COMPOSITION MODULE (spec §4.0).
 *
 * This is the ONLY module permitted to hold a reference to both an L2
 * repository and the L3/L5 pure functions. It resolves every input, assembles
 * the JSON-safe `BuyNowPricingInputs`, and hands the result to the engine.
 *
 * If a second module starts doing this, the layering is gone regardless of
 * what the layer table says — so keep composition here.
 */

/**
 * EVERY component type, loaded on every calculation.
 *
 * This list previously did two jobs at once — "which types must exist" and
 * "which types to load" — and omitted four enum members (`cad`, `assembly`,
 * `supplier_fee`, `other`). The engine handles all four correctly; they simply
 * never arrived, so $30.00 of configured CAD and assembly labour was missing
 * from every price, invisibly. The two jobs are now separate: load all of
 * these, then assert the required subset below.
 *
 * Keep in step with the `CostComponentType` enum in schema.prisma. A type
 * present in the enum and absent here is silently free.
 */
/**
 * Cost component types that exist in the enum but are deliberately NOT cost
 * inputs. Declaring them explicitly is what lets componentCoverage.test.ts
 * distinguish "decided not to load this" from "forgot to load this" — the two
 * look identical in a price, and the second one silently under-prices.
 *
 * `payment_adjustment` is reserved, not live. It was added while implementing
 * D9 and left unused once the credit-card uplift moved onto the pricing profile
 * as a derived, versioned rate. It is kept because Postgres cannot drop an enum
 * value cheaply, and because it is the natural home for the open question
 * flagged with D9 (whether the cash-equivalent base should carry a cash
 * processing cost distinct from card processing). Nothing reads it today, and
 * data recorded under it would have no effect on any price.
 */
export const INERT_COMPONENT_TYPES: readonly CostComponentType[] = ["payment_adjustment"];

export const ALL_COMPONENT_TYPES: readonly CostComponentType[] = [
  "metal_loss",
  "cad",
  "casting",
  "setting",
  "polishing",
  "assembly",
  "qc",
  "packaging",
  "shipping",
  "insurance",
  "warranty_reserve",
  "supplier_fee",
  "other",
  "payment_processing",
];

/**
 * The subset whose absence is an ERROR rather than a zero (§4.5). A type not
 * listed here may legitimately have no row — the product simply does not incur
 * it — but one that is listed and missing means the cost library is incomplete
 * and the price would be silently too low.
 */
const REQUIRED_COMPONENT_TYPES: readonly CostComponentType[] = [
  "metal_loss",
  "casting",
  "setting",
  "polishing",
  "qc",
  "packaging",
  "shipping",
  "insurance",
  "warranty_reserve",
  "payment_processing",
];

export interface ResolveInputsResult {
  inputs: BuyNowPricingInputs;
  pricingProfileId: string;
  isPlaceholderProfile: boolean;
  bands: { id: string; label: string; sizeMin: string; sizeMax: string }[];
}

export async function resolveInputsForVariant(
  masterVariantId: string,
  asOf: Date
): Promise<ResolveInputsResult> {
  const variant = await prisma.masterVariant.findUnique({
    where: { id: masterVariantId },
    include: {
      masterProduct: { include: { bands: { orderBy: { sortOrder: "asc" } } } },
      stones: { orderBy: { position: "asc" } },
      weightOverrides: true,
    },
  });

  if (!variant) {
    throw new MissingCostInputError("master_variant", asOf, `id=${masterVariantId}`);
  }

  const product = variant.masterProduct;
  const profile = await resolveActivePricingProfile("buy_now", asOf);

  // Metal price is quoted per gram in MAJOR units; the engine works in minor
  // units (§4.1 rule 2). Converted exactly once, here, at ingestion.
  const metal = await resolveMetalPrice(variant.metal, variant.purity, asOf);
  const pricePerGramMinorUnits = toMinorUnits(metal.pricePerGramMajorUnits);

  // Manufacturing labour: grams x the rate for THIS variant's source. Resolved
  // effective-dated like every other cost input, and routed through the same
  // single major-to-minor conversion so it cannot drift from the metal path.
  const labor = await resolveLaborRate(variant.laborSource, asOf);
  const laborRatePerGramMinorUnits = toMinorUnits(labor.ratePerGramMajorUnits);

  const stones: ResolvedStonePosition[] = [];
  for (const stone of variant.stones) {
    const cost = await resolveStoneCost(
      {
        stoneType: stone.stoneType,
        shape: stone.shape,
        carat: stone.carat.toString(),
        color: stone.color,
        clarity: stone.clarity,
        cutGrade: stone.cutGrade,
        labStatus: stone.labStatus,
        // Slice 1 has no supplier dimension on a product, so every lookup is
        // supplier-agnostic and supplier-specific rows are inert (§4.7 Seam B).
        supplierRef: null,
      },
      asOf
    );

    stones.push(
      cost.kind === "per_stone"
        ? {
            position: stone.position,
            quantity: stone.quantity,
            unitCost: cost.cost.toJSON(),
            provenance: toInputProvenance(cost.provenance),
          }
        : {
            position: stone.position,
            quantity: stone.quantity,
            // MAJOR -> MINOR, exactly as the metal price above. The repository
            // returns per-carat cost in major units (dollars per carat) because
            // that is how it is quoted and stored; the engine works entirely in
            // minor units. Omitting this conversion under-priced every
            // per-carat stone by a factor of 100 — a $150/ct gem costing $1.50.
            perCaratCost: toMinorUnits(cost.costPerCaratMajorUnits),
            carat: stone.carat.toString(),
            provenance: toInputProvenance(cost.provenance),
          }
    );
  }

  const components: ResolvedCostComponent[] = [];
  for (const componentType of ALL_COMPONENT_TYPES) {
    const resolved = await resolveCostComponentsOfType(componentType, asOf);
    if (resolved.length === 0) {
      if (REQUIRED_COMPONENT_TYPES.includes(componentType)) {
        // §4.5: absent is an error, never zero. The difference between "we
        // decided this is free" and "we silently under-priced the product".
        throw new MissingCostInputError(`cost_component.${componentType}`, asOf);
      }
      continue;
    }
    for (const component of resolved) {
      components.push({
        componentType: component.componentType,
        basis: component.basis,
        valueKind: component.valueKind,
        amount: component.amount?.toJSON(),
        rate: component.rate ?? undefined,
        provenance: {
          sourceTable: component.provenance.sourceTable,
          sourceId: component.provenance.sourceId,
          effectiveFrom: component.provenance.effectiveFrom.toISOString(),
        },
      });
    }
  }

  const overrides: Record<string, string> = {};
  for (const override of variant.weightOverrides) {
    overrides[override.size.toString()] = override.weightGrams.toString();
  }

  const inputs: BuyNowPricingInputs = {
    asOf: asOf.toISOString(),
    currency: profile.minDollarProfit.toJSON().currency,
    size: product.baseSize.toString(),
    weight: {
      sizeAxis: product.sizeAxis,
      allowedSizeMin: product.allowedSizeMin.toString(),
      allowedSizeMax: product.allowedSizeMax.toString(),
      sizeIncrement: product.sizeIncrement.toString(),
      baseSize: product.baseSize.toString(),
      baseWeightGrams: variant.baseWeightGrams.toString(),
      weightPerFullSizeGrams: variant.weightPerFullSizeGrams.toString(),
      overrides,
    },
    metalPricePerGramMinorUnits: pricePerGramMinorUnits,
    laborSource: variant.laborSource,
    laborRatePerGramMinorUnits,
    stones,
    components,
    profile: {
      code: profile.code,
      version: profile.version,
      // Read from the profile rather than hard-coded. An earlier version wrote
      // the literal here while reading the column into an unused variable,
      // which would have silently ignored a MARKUP_ON_COST_V1 profile.
      marginModel: profile.marginModel as BuyNowPricingInputs["profile"]["marginModel"],
      targetGrossMarginRate: profile.targetGrossMarginRate ?? undefined,
      targetMarkupRate: profile.targetMarkupRate ?? undefined,
      minGrossMarginRate: profile.minGrossMarginRate,
      minDollarProfit: profile.minDollarProfit.toJSON(),
      roundingRuleId: profile.roundingRuleId as BuyNowPricingInputs["profile"]["roundingRuleId"],
      priceEndingRuleId:
        profile.priceEndingRuleId as BuyNowPricingInputs["profile"]["priceEndingRuleId"],
      autoApplyToleranceBps: profile.autoApplyToleranceBps,
      cardPriceRuleId: profile.cardPriceRuleId as BuyNowPricingInputs["profile"]["cardPriceRuleId"],
      cardUpliftRate: profile.cardUpliftRate,
      isPlaceholder: profile.isPlaceholder,
    },
    variantFloor:
      variant.minPriceMinorUnits !== null && variant.minPriceCurrency !== null
        ? { amountMinorUnits: variant.minPriceMinorUnits.toString(), currency: variant.minPriceCurrency }
        : undefined,
    provenance: [
      {
        sourceTable: metal.provenance.sourceTable,
        sourceId: metal.provenance.sourceId,
        effectiveFrom: metal.provenance.effectiveFrom.toISOString(),
      },
      {
        sourceTable: profile.provenance.sourceTable,
        sourceId: profile.provenance.sourceId,
        effectiveFrom: profile.provenance.effectiveFrom.toISOString(),
      },
    ],
  };

  return {
    inputs,
    pricingProfileId: profile.id,
    isPlaceholderProfile: profile.isPlaceholder,
    bands: product.bands.map((band) => ({
      id: band.id,
      label: band.label,
      sizeMin: band.sizeMin.toString(),
      sizeMax: band.sizeMax.toString(),
    })),
  };
}

/**
 * MAJOR -> MINOR units, the single conversion used by every rate this module
 * resolves.
 *
 * Cost libraries quote rates the way the market does — dollars per gram,
 * dollars per carat — while the engine works entirely in minor units (§4.1
 * rule 2). Doing that conversion inline at each call site is how the per-carat
 * stone cost came to be under-priced by a factor of 100 while the metal price
 * beside it was correct: same conversion, two sites, one of them missing.
 *
 * 100 is hard-coded because slice 1 is USD-only. A non-2-decimal currency
 * (JPY, or a 3-decimal currency) needs this to take the profile's
 * minorUnitsPerMajorUnit instead — Money.fromDecimalMajorUnits already models
 * that and is tested at 1 and 1000.
 */
function toMinorUnits(majorUnits: string): string {
  return new MoneyDecimal(majorUnits).times(100).toString();
}

/** Repository provenance (Date) -> engine provenance (ISO string, JSON-safe). */
function toInputProvenance(provenance: {
  sourceTable: string;
  sourceId: string;
  effectiveFrom: Date;
}) {
  return {
    sourceTable: provenance.sourceTable,
    sourceId: provenance.sourceId,
    effectiveFrom: provenance.effectiveFrom.toISOString(),
  };
}
