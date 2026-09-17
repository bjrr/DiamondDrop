import type { PricingProfileCode } from "@prisma/client";

import { Money } from "~/domain/money/money";

import { prisma } from "../client.server";
import {
  MissingCostInputError,
  provenanceOf,
  type CostInputProvenance,
} from "./effectiveDated.server";

/**
 * L2 — pricing profile retrieval (spec §4.0 L4, retrieved via L2).
 *
 * A profile is POLICY: margin objective, hard floors, tolerance, and the
 * rounding/price-ending rule ids. It holds nothing product-, variant- or
 * supplier-specific — a rule that applies to one product is a cost input or a
 * variant floor, not a policy (§4.0 L4).
 *
 * The table is append-only and versioned: a change is a new version, never an
 * edit, so a stored price_calculation's (profileId, profileVersion) always
 * resolves to exactly the values it was computed from.
 */

export interface ResolvedPricingProfile {
  id: string;
  code: PricingProfileCode;
  version: number;
  marginModel: string;
  /** Decimal strings, never numbers (§4.1). */
  targetGrossMarginRate: string | null;
  targetMarkupRate: string | null;
  minGrossMarginRate: string;
  minDollarProfit: Money;
  roundingRuleId: string;
  priceEndingRuleId: string;
  autoApplyToleranceBps: number | null;
  cashPriceRuleId: string;
  cashDiscountRate: string;
  /**
   * D14 is unresolved, so the seeded profile carries deliberately absurd
   * placeholder values behind this flag. The T8 review CLI MUST refuse to
   * approve or sync a price computed from a profile where this is true —
   * that check is the only thing standing between a placeholder margin and a
   * real storefront price.
   */
  isPlaceholder: boolean;
  provenance: CostInputProvenance;
}

export async function resolveActivePricingProfile(
  code: PricingProfileCode,
  asOf: Date
): Promise<ResolvedPricingProfile> {
  const rows = await prisma.pricingProfile.findMany({
    where: { code, effectiveFrom: { lte: asOf } },
    orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
  });

  if (rows.length === 0) {
    throw new MissingCostInputError("pricing_profile", asOf, `code=${code}`);
  }

  // Resolution is by effective date, with VERSION as the tie-break.
  //
  // pricing_profile is unique on (code, version), NOT on (code, effectiveFrom),
  // so two versions may legitimately share an effective date — an operator
  // correcting a profile the same day they created it is the obvious case.
  // selectMostSpecific would treat that as an unresolvable tie and refuse to
  // price anything, which is the wrong answer here: unlike a cost row, a
  // profile version is a deliberate monotonic sequence, so at the same
  // effective date the higher version is unambiguously the later intent.
  //
  // Rows arrive ordered (effectiveFrom desc, version desc), so the first
  // eligible row is already the winner.
  const eligible = rows.filter((row) => row.effectiveFrom.getTime() <= asOf.getTime());
  const row = eligible[0];
  if (!row) {
    throw new MissingCostInputError("pricing_profile", asOf, `code=${code}`);
  }

  return {
    id: row.id,
    code: row.code,
    version: row.version,
    marginModel: row.marginModel,
    targetGrossMarginRate: row.targetGrossMarginRate?.toString() ?? null,
    targetMarkupRate: row.targetMarkupRate?.toString() ?? null,
    minGrossMarginRate: row.minGrossMarginRate.toString(),
    minDollarProfit: Money.fromMinorUnits(row.minDollarProfitMinorUnits, row.currency),
    roundingRuleId: row.roundingRuleId,
    priceEndingRuleId: row.priceEndingRuleId,
    autoApplyToleranceBps: row.autoApplyToleranceBps,
    cashPriceRuleId: row.cashPriceRuleId,
    cashDiscountRate: row.cashDiscountRate.toString(),
    isPlaceholder: row.isPlaceholder,
    provenance: provenanceOf("pricing_profile", row),
  };
}

/** Resolves the exact version a stored calculation was computed from. */
export async function getPricingProfileVersion(code: PricingProfileCode, version: number) {
  return prisma.pricingProfile.findUnique({ where: { code_version: { code, version } } });
}
