import type { Metal, Purity } from "@prisma/client";

import { MoneyDecimal } from "~/domain/money/decimal";
import { alloyedPricePerGram, purityFineness } from "~/domain/pricing/purity";

import { prisma } from "../client.server";
import {
  MissingCostInputError,
  provenanceOf,
  selectMostSpecific,
  type CostInputProvenance,
} from "./effectiveDated.server";

/**
 * L2 — normalized metal-price library (spec §4.0, §4.2).
 *
 * THE MODEL. Staff enter ONE reference price per gram for each PURE metal. The
 * price of an alloy is DERIVED:
 *
 *     alloyed_price_per_gram = pure_reference x fineness
 *
 * with fineness from the versioned registry in app/domain/pricing/purity.ts.
 *
 * This replaced a table of per-karat prices, which allowed karats to drift out
 * of step with each other silently — the seeded data had 14k and 18k implying
 * pure gold near $82.7/g while 10k implied $70.80/g, a 17% error that nothing
 * could detect. One reference makes that unrepresentable.
 *
 * Returns MAJOR units (dollars per gram), which is how staff enter it and how
 * the market quotes it. Conversion to minor units happens once, in the engine's
 * named conversion step (§4.1 rule 2). Repositories resolve; the multiplication
 * by fineness is the one derivation done here, because the alloyed price is
 * what every caller actually wants and recomputing it per caller would invite
 * one of them to forget.
 *
 * SEAM A (§4.7): `source` is PROVENANCE — recorded and returned, never selected
 * on. Resolution is purely "greatest effectiveFrom <= asOf". When an automated
 * feed lands it writes rows with source='feed' and nothing here changes.
 */
export interface ResolvedMetalPrice {
  metal: Metal;
  purity: Purity;
  /** PURE metal, decimal string, MAJOR units per gram. Never a number. */
  pureReferencePerGramMajorUnits: string;
  /** The fineness applied, e.g. "0.583333" for 14k. Recorded for audit. */
  purityFineness: string;
  /** pure x fineness. What the cost calculation multiplies by weight. */
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
  const rows = await prisma.metalReferencePrice.findMany({
    where: { metal, effectiveFrom: { lte: asOf } },
    orderBy: { effectiveFrom: "desc" },
  });

  if (rows.length === 0) {
    throw new MissingCostInputError("metal_reference_price", asOf, `metal=${metal}`);
  }

  // No nullable qualifiers on this table: specificity reduces to "latest
  // effectiveFrom". Routed through the shared helper anyway so every
  // effective-dated table resolves by one rule and ambiguity still throws.
  const row = selectMostSpecific(rows, { metal }, [], {
    asOf,
    component: "metal_reference_price",
  });

  const pure = row.pricePerGram.toString();

  return {
    metal: row.metal,
    purity,
    pureReferencePerGramMajorUnits: pure,
    // Throws on an unrecognised purity rather than assuming 1.0, which would
    // price an alloy as if it were pure metal.
    purityFineness: purityFineness(purity),
    pricePerGramMajorUnits: alloyedPricePerGram(new MoneyDecimal(pure), purity).toString(),
    currency: row.currency,
    source: row.source,
    enteredBy: row.enteredBy,
    provenance: provenanceOf("metal_reference_price", row),
  };
}
