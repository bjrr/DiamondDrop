/**
 * Luxury Steal assignment — the decision layer (D27,
 * docs/specs/SLICE-3-LUXURY-STEALS.md §3/§5/§9, task 3-1).
 *
 * PURE — no database access, no I/O, no ambient clock. Same discipline as
 * `app/app/domain/pricing/calculationFailure.ts`: the repository
 * (`app/app/db/repositories/luxuryStealRepository.server.ts`) resolves the
 * real `MasterVariant` rows and calls the function below with explicit
 * inputs.
 *
 * THE AUTHORITATIVE GRAIN IS THE VARIANT, NOT THE PRODUCT (D27). The admin
 * UX may offer a product-level "apply to all variants" convenience action,
 * but that is a CONVENIENCE ONLY — it must not become a second storage
 * location (§5). This module's one function exists to make that convenience
 * safe: it validates and normalises the target variant id list the
 * repository is about to write N rows for, so the repository layer never has
 * to inline that validation itself, and a caller cannot accidentally send an
 * empty or duplicated write.
 */

/** Thrown when a bulk "apply to all variants" call is asked to target zero variants — e.g. a product with no variants yet. Writing nothing silently would look identical to success; refusing makes the caller notice. */
export class EmptyLuxuryStealBulkAssignmentError extends Error {
  constructor(masterProductId: string) {
    super(`master product ${masterProductId} has no variants to assign Luxury Steal status to`);
    this.name = "EmptyLuxuryStealBulkAssignmentError";
  }
}

/**
 * Normalises the variant id list a bulk "apply to all variants of this
 * product" action is about to write (§5's "convenience action" — writes N
 * variant rows, never a second storage location). Deduplicates (defends
 * against a caller accidentally passing the same id twice, which would
 * otherwise cost nothing at the database layer but is still worth catching
 * here) and preserves the original order for predictable, testable output.
 *
 * Throws `EmptyLuxuryStealBulkAssignmentError` rather than returning an
 * empty array — see that error's own doc comment.
 */
export function buildBulkAssignmentTargets(
  masterProductId: string,
  variantIds: readonly string[]
): string[] {
  const deduped = Array.from(new Set(variantIds));
  if (deduped.length === 0) {
    throw new EmptyLuxuryStealBulkAssignmentError(masterProductId);
  }
  return deduped;
}
