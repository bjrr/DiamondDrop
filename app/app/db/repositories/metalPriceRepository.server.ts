import type { Metal, Purity } from "@prisma/client";

import { prisma } from "../client.server";
import {
  MissingCostInputError,
  selectMostSpecific,
  provenanceOf,
  type CostInputProvenance,
} from "./effectiveDated.server";

/**
 * L2 — normalized metal-price library (spec §4.0, §4.2).
 *
 * Returns the price per gram as a DECIMAL STRING in MAJOR units (dollars per
 * gram), which is how staff enter it and how the market quotes it. Conversion
 * to minor units happens once, in the engine's named conversion step (§4.1
 * rule 2) — not here. Repositories resolve; they do not convert or compute.
 *
 * SEAM A (§4.7): `source` (`manual` | `feed`) is PROVENANCE — recorded and
 * returned, never selected on. Resolution is purely "greatest effectiveFrom
 * <= asOf", regardless of source. Do not add a priority column, do not prefer
 * feed over manual, do not branch on `source` here or anywhere downstream.
 * When an automated feed lands it writes rows with source='feed' and nothing
 * in this function changes.
 */
export interface ResolvedMetalPrice {
  metal: Metal;
  purity: Purity;
  /** Decimal string, MAJOR units per gram, e.g. "48.250000". Never a number. */
  pricePerGramMajorUnits: string;
  currency: string;
  /** Provenance only — never a resolution input. */
  source: string;
  enteredBy: string | null;
  provenance: CostInputProvenance;
}

export async function resolveMetalPrice(
  metal: Metal,
  purity: Purity,
  asOf: Date
): Promise<ResolvedMetalPrice> {
  const rows = await prisma.metalPrice.findMany({
    where: { metal, purity, effectiveFrom: { lte: asOf } },
    orderBy: { effectiveFrom: "desc" },
  });

  if (rows.length === 0) {
    throw new MissingCostInputError("metal_price", asOf, `metal=${metal}, purity=${purity}`);
  }

  // No nullable qualifiers on this table: specificity is trivial and the
  // helper reduces to "latest effectiveFrom, ambiguity still throws". Routed
  // through it anyway so every effective-dated table resolves by one rule.
  const row = selectMostSpecific(rows, { metal, purity }, [], {
    asOf,
    component: "metal_price",
  });

  return {
    metal: row.metal,
    purity: row.purity,
    pricePerGramMajorUnits: row.pricePerGram.toString(),
    currency: row.currency,
    source: row.source,
    enteredBy: row.enteredBy,
    provenance: provenanceOf("metal_price", row),
  };
}

/** Staff/admin read surface. Append-only, so this is the full audit history. */
export async function listMetalPriceHistory(metal: Metal, purity: Purity) {
  return prisma.metalPrice.findMany({
    where: { metal, purity },
    orderBy: { effectiveFrom: "desc" },
  });
}

