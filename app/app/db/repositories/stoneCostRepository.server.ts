import type { StoneType } from "@prisma/client";

import { Money } from "~/domain/money/money";

import { prisma } from "../client.server";
import {
  MissingCostInputError,
  selectMostSpecific,
  provenanceOf,
  type CostInputProvenance,
} from "./effectiveDated.server";

/**
 * L2 — normalized stone-cost library (spec §4.0, §4.3).
 *
 * The lookup key is (stone_type, shape, carat band, color, clarity, cut_grade,
 * lab_status, supplier_ref). `shape` is REQUIRED and part of the key (R4): a
 * row for the right carat but the wrong shape is a MISS, not a fallback —
 * shapes do not cost the same and silently substituting one for another
 * under-prices the product.
 *
 * Carat banding is `carat_min` inclusive, `carat_max` EXCLUSIVE, so adjacent
 * bands meet without overlapping and a stone exactly on a boundary belongs to
 * the upper band. Filtered in SQL; the wildcard qualifiers are then resolved
 * by the one shared specificity rule.
 *
 * SEAM B (§4.7): slice 1 has no supplier dimension on a product, so every
 * lookup passes `supplierRef: null` and a row carrying a non-null
 * `supplier_ref` is inert — correctly, since a non-null row qualifier must
 * equal the query value to be applicable. Do not build a supplier hierarchy
 * here; when one arrives it is a new argument plus an ordering decision in
 * `qualifierKeys`.
 */

/** Wildcard-capable qualifiers, in the fixed order §4.3 states. */
const STONE_QUALIFIER_KEYS = ["color", "clarity", "cutGrade", "labStatus", "supplierRef"] as const;

export interface StoneCostQuery {
  stoneType: StoneType;
  shape: string;
  /** Decimal string, e.g. "1.000". Never a JS number (§4.1). */
  carat: string;
  color?: string | null;
  clarity?: string | null;
  cutGrade?: string | null;
  labStatus?: string | null;
  supplierRef?: string | null;
}

export type ResolvedStoneCost =
  | {
      kind: "per_stone";
      cost: Money;
      provenance: CostInputProvenance;
      matchedQualifiers: Readonly<Record<string, string | null>>;
    }
  | {
      kind: "per_carat";
      /** Decimal string, MAJOR units per carat. The engine multiplies; L2 does not. */
      costPerCaratMajorUnits: string;
      currency: string;
      provenance: CostInputProvenance;
      matchedQualifiers: Readonly<Record<string, string | null>>;
    };

export async function resolveStoneCost(
  query: StoneCostQuery,
  asOf: Date
): Promise<ResolvedStoneCost> {
  const rows = await prisma.stoneCost.findMany({
    where: {
      stoneType: query.stoneType,
      shape: query.shape,
      caratMin: { lte: query.carat },
      caratMax: { gt: query.carat },
      effectiveFrom: { lte: asOf },
    },
  });

  if (rows.length === 0) {
    throw new MissingCostInputError(
      "stone_cost",
      asOf,
      `stoneType=${query.stoneType}, shape=${query.shape}, carat=${query.carat}`
    );
  }

  const row = selectMostSpecific(
    rows,
    {
      color: query.color ?? null,
      clarity: query.clarity ?? null,
      cutGrade: query.cutGrade ?? null,
      labStatus: query.labStatus ?? null,
      supplierRef: query.supplierRef ?? null,
    },
    [...STONE_QUALIFIER_KEYS],
    { asOf, component: "stone_cost" }
  );

  const matchedQualifiers = Object.fromEntries(
    STONE_QUALIFIER_KEYS.map((key) => [key, row[key]])
  );
  const provenance = provenanceOf("stone_cost", row);

  if (row.costKind === "per_carat") {
    if (row.costPerCarat === null) {
      // Unreachable while the stone_cost_kind_matches_value CHECK holds;
      // asserted rather than assumed, because a silent null here would
      // become a zero-cost stone.
      throw new MissingCostInputError("stone_cost.cost_per_carat", asOf, `row ${row.id}`);
    }
    return {
      kind: "per_carat",
      costPerCaratMajorUnits: row.costPerCarat.toString(),
      currency: row.currency,
      provenance,
      matchedQualifiers,
    };
  }

  if (row.costMinorUnits === null) {
    throw new MissingCostInputError("stone_cost.cost_minor_units", asOf, `row ${row.id}`);
  }
  return {
    kind: "per_stone",
    cost: Money.fromMinorUnits(row.costMinorUnits, row.currency),
    provenance,
    matchedQualifiers,
  };
}

/**
 * Validates that carat bands for one key prefix do not overlap (§4.3).
 * Overlapping bands make two rows applicable at the same specificity, which
 * surfaces later as an ambiguity error at pricing time — this catches it at
 * the point someone can still fix the data.
 */
export async function findOverlappingCaratBands(stoneType: StoneType, shape: string) {
  const rows = await prisma.stoneCost.findMany({
    where: { stoneType, shape },
    orderBy: [{ caratMin: "asc" }, { effectiveFrom: "asc" }],
  });

  const overlaps: { a: string; b: string }[] = [];
  for (let i = 0; i < rows.length; i += 1) {
    for (let j = i + 1; j < rows.length; j += 1) {
      const a = rows[i]!;
      const b = rows[j]!;
      if (a.effectiveFrom.getTime() !== b.effectiveFrom.getTime()) continue;
      if (qualifiersDiffer(a, b)) continue;
      // Half-open bands: [min, max). They overlap iff a.min < b.max && b.min < a.max.
      if (a.caratMin.lessThan(b.caratMax) && b.caratMin.lessThan(a.caratMax)) {
        overlaps.push({ a: a.id, b: b.id });
      }
    }
  }
  return overlaps;
}

function qualifiersDiffer(
  a: Record<string, unknown>,
  b: Record<string, unknown>
): boolean {
  return STONE_QUALIFIER_KEYS.some((key) => a[key] !== b[key]);
}
