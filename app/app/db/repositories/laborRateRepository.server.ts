import type { LaborSource } from "@prisma/client";

import { prisma } from "../client.server";
import {
  MissingCostInputError,
  provenanceOf,
  selectMostSpecific,
  type CostInputProvenance,
} from "./effectiveDated.server";

/**
 * L2 — normalized manufacturing-labour library.
 *
 * Manufacturing labour is charged PER GRAM of finished weight, at a rate that
 * depends on where the item is made. Exactly one source per variant: a piece is
 * made in one place, and blending two rates would produce a cost no supplier
 * ever quoted.
 *
 * SEPARATE FROM STONE SETTING, deliberately. Setting charges are per-stone or
 * fixed and resolve through cost_component. Folding the two together would make
 * a heavy plain band and a light multi-stone piece indistinguishable in the
 * breakdown, and the breakdown is the point.
 *
 * Returns the rate as a DECIMAL STRING in MAJOR units (dollars per gram) —
 * how staff enter it and how a workshop quotes it. Conversion to minor units
 * happens once, in the engine's named conversion step (§4.1 rule 2), not here.
 * Repositories resolve; they do not convert or compute.
 */
export interface ResolvedLaborRate {
  source: LaborSource;
  /** Decimal string, MAJOR units per gram, e.g. "4.500000". Never a number. */
  ratePerGramMajorUnits: string;
  currency: string;
  enteredBy: string;
  provenance: CostInputProvenance;
}

export async function resolveLaborRate(
  source: LaborSource,
  asOf: Date
): Promise<ResolvedLaborRate> {
  const rows = await prisma.laborRate.findMany({
    where: { source, effectiveFrom: { lte: asOf } },
    orderBy: { effectiveFrom: "desc" },
  });

  if (rows.length === 0) {
    // Throws rather than defaulting to zero. A missing labour rate must stop
    // the calculation: a silently free item would price below cost and look
    // like a bargain rather than a bug.
    throw new MissingCostInputError("labor_rate", asOf, `source=${source}`);
  }

  // No nullable qualifiers on this table, so specificity reduces to "latest
  // effectiveFrom". Routed through the shared helper anyway so every
  // effective-dated table resolves by one rule and ambiguity still throws.
  const row = selectMostSpecific(rows, { source }, [], { asOf, component: "labor_rate" });

  return {
    source: row.source,
    ratePerGramMajorUnits: row.ratePerGram.toString(),
    currency: row.currency,
    enteredBy: row.enteredBy,
    provenance: provenanceOf("labor_rate", row),
  };
}
