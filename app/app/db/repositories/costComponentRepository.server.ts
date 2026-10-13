import type { CostComponentBasis, CostComponentType, CostComponentValueKind } from "@prisma/client";

import { Money, type MoneyJSON } from "~/domain/money/money";

import { prisma } from "../client.server";
import {
  MissingCostInputError,
  selectMostSpecific,
  provenanceOf,
  type CostInputProvenance,
} from "./effectiveDated.server";

/**
 * L2 — normalized cost-component library (spec §4.0, §4.2, §4.4).
 *
 * §4.5 is the rule that matters here: an ABSENT row is an error, an explicit
 * zero is not. This repository never substitutes zero for a missing component
 * and never falls back to a previous calculation. The difference between "we
 * decided this is free" and "we silently under-priced the product" is the
 * whole reason the distinction exists.
 *
 * `basis` (cost_side | revenue_side) is returned as data, not branched on
 * here: §4.4 resolves the price/fee circularity by classification, and it is
 * the engine (L5) that puts revenue-side rates in the denominator. L2 only
 * says which row applies.
 */

export interface ResolvedCostComponent {
  componentType: CostComponentType;
  basis: CostComponentBasis;
  valueKind: CostComponentValueKind;
  /** Set when valueKind is `fixed` or `per_stone`. */
  amount: Money | null;
  /** Decimal string when valueKind is `percentage`, e.g. "0.029000". */
  rate: string | null;
  provenance: CostInputProvenance;
}

/**
 * Resolves one (componentType, valueKind) pair. The pair is the natural key
 * because a single concern can legitimately have two rows: payment processing
 * is "2.9% + $0.30", and the cost_component_value_kind_matches_value CHECK
 * permits exactly one of amount/rate per row, so that is two rows of the same
 * componentType distinguished by valueKind (§4.2, and the seed reflects it).
 */
export async function resolveCostComponent(
  componentType: CostComponentType,
  valueKind: CostComponentValueKind,
  asOf: Date
): Promise<ResolvedCostComponent> {
  const rows = await prisma.costComponent.findMany({
    where: { componentType, valueKind, effectiveFrom: { lte: asOf } },
    orderBy: { effectiveFrom: "desc" },
  });

  if (rows.length === 0) {
    throw new MissingCostInputError(
      `cost_component.${componentType}`,
      asOf,
      `valueKind=${valueKind}`
    );
  }

  const row = selectMostSpecific(rows, { componentType, valueKind }, [], {
    asOf,
    component: `cost_component.${componentType}`,
  });

  return toResolved(row);
}

/** Resolves every currently-effective row for a component type (both value kinds). */
export async function resolveCostComponentsOfType(
  componentType: CostComponentType,
  asOf: Date
): Promise<ResolvedCostComponent[]> {
  const rows = await prisma.costComponent.findMany({
    where: { componentType, effectiveFrom: { lte: asOf } },
    orderBy: { effectiveFrom: "desc" },
  });

  const byValueKind = new Map<CostComponentValueKind, typeof rows>();
  for (const row of rows) {
    const bucket = byValueKind.get(row.valueKind) ?? [];
    bucket.push(row);
    byValueKind.set(row.valueKind, bucket);
  }

  return [...byValueKind.entries()].map(([valueKind, bucket]) =>
    toResolved(
      selectMostSpecific(bucket, { componentType, valueKind }, [], {
        asOf,
        component: `cost_component.${componentType}`,
      })
    )
  );
}

/**
 * §4.6 — the D9 seam, and the only place it lives.
 *
 * D9 (which payment methods CaratForUs encourages as lower-cost) is an OPEN
 * owner decision. The engine never learns about payment *methods*: it consumes
 * one resolved (rate, fixedFee) pair from this one function. When D9 resolves,
 * this body becomes a weighted blend across a method mix and NOTHING in the
 * engine, its tests, its stored snapshots or its acceptance criteria changes.
 *
 * Do not anticipate the blend. Build the single-component version, keep the
 * seam here.
 */
export interface AssumedPaymentCost {
  /** Revenue-side rate as a decimal string, e.g. "0.029". */
  rate: string;
  fixedFee: MoneyJSON;
  provenance: readonly CostInputProvenance[];
}

export async function resolveAssumedPaymentCost(asOf: Date): Promise<AssumedPaymentCost> {
  const components = await resolveCostComponentsOfType("payment_processing", asOf);

  const percentage = components.find((c) => c.valueKind === "percentage");
  const fixed = components.find((c) => c.valueKind === "fixed");

  if (!percentage || percentage.rate === null) {
    throw new MissingCostInputError("cost_component.payment_processing", asOf, "valueKind=percentage");
  }
  if (!fixed || fixed.amount === null) {
    throw new MissingCostInputError("cost_component.payment_processing", asOf, "valueKind=fixed");
  }

  return {
    rate: percentage.rate,
    fixedFee: fixed.amount.toJSON(),
    provenance: [percentage.provenance, fixed.provenance],
  };
}

function toResolved(row: {
  id: string;
  componentType: CostComponentType;
  basis: CostComponentBasis;
  valueKind: CostComponentValueKind;
  amountMinorUnits: bigint | null;
  currency: string | null;
  rate: { toString(): string } | null;
  effectiveFrom: Date;
}): ResolvedCostComponent {
  return {
    componentType: row.componentType,
    basis: row.basis,
    valueKind: row.valueKind,
    amount:
      row.amountMinorUnits !== null && row.currency !== null
        ? Money.fromMinorUnits(row.amountMinorUnits, row.currency)
        : null,
    rate: row.rate === null ? null : row.rate.toString(),
    provenance: provenanceOf("cost_component", row),
  };
}
