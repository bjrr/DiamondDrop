/**
 * L2 — normalized cost libraries (spec §4.0). Effective-dated resolution and
 * qualifier specificity, implemented ONCE.
 *
 * §4.7 Seam B is explicit that this rule must not be duplicated: when a
 * supplier dimension is eventually added to stone lookups, the change is an
 * addition to the `qualifierKeys` ordering handed to `selectMostSpecific`,
 * not a second near-identical resolver in another repository. Two subtly
 * different answers to "which cost row applies" is how a pricing engine
 * starts producing prices nobody can explain.
 *
 * This module is L2: it resolves rows. It computes nothing, rounds nothing,
 * and applies no margin.
 */

/** Where a resolved value came from, carried into `price_calculation` (§5.6). */
export interface CostInputProvenance {
  sourceTable: string;
  sourceId: string;
  effectiveFrom: Date;
}

/** A required cost input had no applicable row at `asOf` (§4.5). */
export class MissingCostInputError extends Error {
  constructor(
    readonly component: string,
    readonly asOf: Date,
    detail?: string
  ) {
    super(
      `No applicable ${component} row effective at ${asOf.toISOString()}` +
        (detail ? ` (${detail})` : "") +
        ". An absent input is an error, never zero — seed an explicit zero row if the cost is genuinely nil."
    );
    this.name = "MissingCostInputError";
  }
}

/**
 * Two rows are equally specific and equally recent, so which one applies is
 * undefined. Never resolved by picking one: a silent arbitrary choice here
 * would make a price depend on row insertion order.
 */
export class AmbiguousCostInputError extends Error {
  constructor(
    readonly component: string,
    readonly candidateIds: readonly string[]
  ) {
    super(
      `Ambiguous ${component}: ${candidateIds.length} rows are equally specific with the same effectiveFrom ` +
        `(ids: ${candidateIds.join(", ")}). Refusing to choose arbitrarily.`
    );
    this.name = "AmbiguousCostInputError";
  }
}

/** The subset of a row this module needs; rows carry their own extra fields. */
export interface EffectiveDatedRow {
  id: string;
  effectiveFrom: Date;
}

/**
 * Picks the row that applies to `query` at `asOf`, per §4.3.
 *
 * Applicability: a row qualifier that is `null` is a WILDCARD and matches
 * anything. A non-null qualifier must equal the query's value for that key.
 * A query value of `null`/`undefined` therefore matches only wildcard rows —
 * which is exactly the slice 1 stone case, where no product carries a
 * supplier, so every lookup passes `supplierRef: null` and supplier-specific
 * rows are correctly inert (§4.7 Seam B).
 *
 * Ordering, in strict priority:
 *   1. greatest number of non-null matched qualifiers (most specific wins)
 *   2. latest `effectiveFrom`
 *   3. no third rule — a remaining tie throws.
 *
 * `asOf` filtering is inclusive of rows effective exactly at `asOf`.
 */
export function selectMostSpecific<TRow extends EffectiveDatedRow>(
  rows: readonly TRow[],
  query: Readonly<Record<string, unknown>>,
  qualifierKeys: readonly (keyof TRow & string)[],
  options: { asOf: Date; component: string }
): TRow {
  const { asOf, component } = options;

  const applicable = rows.filter((row) => {
    if (row.effectiveFrom.getTime() > asOf.getTime()) return false;
    return qualifierKeys.every((key) => {
      const rowValue = row[key];
      if (rowValue === null || rowValue === undefined) return true; // wildcard
      return rowValue === query[key];
    });
  });

  if (applicable.length === 0) {
    throw new MissingCostInputError(component, asOf, describeQuery(query, qualifierKeys));
  }

  const specificity = (row: TRow): number =>
    qualifierKeys.reduce((count, key) => {
      const value = row[key];
      return value === null || value === undefined ? count : count + 1;
    }, 0);

  let best = specificity(applicable[0]!);
  for (const row of applicable) {
    const s = specificity(row);
    if (s > best) best = s;
  }
  const mostSpecific = applicable.filter((row) => specificity(row) === best);

  let latest = mostSpecific[0]!.effectiveFrom.getTime();
  for (const row of mostSpecific) {
    const t = row.effectiveFrom.getTime();
    if (t > latest) latest = t;
  }
  const winners = mostSpecific.filter((row) => row.effectiveFrom.getTime() === latest);

  if (winners.length > 1) {
    throw new AmbiguousCostInputError(
      component,
      winners.map((row) => row.id)
    );
  }

  return winners[0]!;
}

/** Same as `selectMostSpecific` but returns null instead of throwing on a miss. */
export function selectMostSpecificOrNull<TRow extends EffectiveDatedRow>(
  rows: readonly TRow[],
  query: Readonly<Record<string, unknown>>,
  qualifierKeys: readonly (keyof TRow & string)[],
  options: { asOf: Date; component: string }
): TRow | null {
  try {
    return selectMostSpecific(rows, query, qualifierKeys, options);
  } catch (error) {
    if (error instanceof MissingCostInputError) return null;
    throw error; // an ambiguous tie is still a defect, never a soft miss
  }
}

export function provenanceOf(sourceTable: string, row: EffectiveDatedRow): CostInputProvenance {
  return { sourceTable, sourceId: row.id, effectiveFrom: row.effectiveFrom };
}

function describeQuery(query: Readonly<Record<string, unknown>>, keys: readonly string[]): string {
  const parts = keys
    .map((key) => (query[key] === null || query[key] === undefined ? null : `${key}=${String(query[key])}`))
    .filter((part): part is string => part !== null);
  return parts.length > 0 ? parts.join(", ") : "no qualifiers";
}
