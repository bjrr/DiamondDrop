import type { CostComponentType } from "@prisma/client";

import { prisma } from "~/db/client.server";
import { resolveCostComponentsOfType } from "~/db/repositories/costComponentRepository.server";
import { MissingCostInputError } from "~/db/repositories/effectiveDated.server";
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

/** Every component type the engine expects to find (§4.5: absent is an error). */
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
  bands: { label: string; sizeMin: string; sizeMax: string }[];
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
  const pricePerGramMinorUnits = new MoneyDecimal(metal.pricePerGramMajorUnits)
    .times(100)
    .toString();

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
        ? { position: stone.position, quantity: stone.quantity, unitCost: cost.cost.toJSON() }
        : {
            position: stone.position,
            quantity: stone.quantity,
            perCaratCost: cost.costPerCaratMajorUnits,
            carat: stone.carat.toString(),
          }
    );
  }

  const components: ResolvedCostComponent[] = [];
  for (const componentType of REQUIRED_COMPONENT_TYPES) {
    const resolved = await resolveCostComponentsOfType(componentType, asOf);
    if (resolved.length === 0) {
      // §4.5: absent is an error, never zero. The difference between "we
      // decided this is free" and "we silently under-priced the product".
      throw new MissingCostInputError(`cost_component.${componentType}`, asOf);
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
    stones,
    components,
    profile: {
      code: profile.code,
      version: profile.version,
      marginModel: "TARGET_GROSS_MARGIN_V1",
      targetGrossMarginRate: profile.targetGrossMarginRate,
      minGrossMarginRate: profile.minGrossMarginRate,
      minDollarProfit: profile.minDollarProfit.toJSON(),
      roundingRuleId: profile.roundingRuleId as BuyNowPricingInputs["profile"]["roundingRuleId"],
      priceEndingRuleId:
        profile.priceEndingRuleId as BuyNowPricingInputs["profile"]["priceEndingRuleId"],
      autoApplyToleranceBps: profile.autoApplyToleranceBps,
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
      label: band.label,
      sizeMin: band.sizeMin.toString(),
      sizeMax: band.sizeMax.toString(),
    })),
  };
}
