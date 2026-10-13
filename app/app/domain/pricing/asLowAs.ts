/**
 * The PURE half of the "as low as" aggregator (Stage 2B / R13, spec §4.5
 * criteria 28-31).
 *
 * WHAT THIS FILE DOES AND DOES NOT DECIDE. Everything about WHETHER a
 * variant is currently purchasable — synced at all, not `draft`/`archived`,
 * not suspended under the 48-hour sync or calculation failure rules, not
 * out of stock — is decided by the orchestration layer in
 * `~/shopify/metafields/asLowAsAggregator.server.ts`, which is the only
 * place that may touch Prisma or the Shopify Admin API. This file receives
 * an already-filtered list of PURCHASABLE candidates and answers exactly one
 * question: which one sets the headline price. That split is what criterion
 * 34's layering fence (`layering.test.ts`) enforces mechanically — a pure
 * money decision must not depend on the database or the network to be
 * exercised by a test.
 *
 * CRITERION 29's REASON THIS FILE EXISTS AT ALL: "a variant nobody can buy
 * must never set the headline price." Once a caller has done the filtering,
 * the remaining decision — lowest price wins — is trivial, but a trivial
 * decision with money on both sides of it is still worth naming, testing and
 * making deterministic, rather than inlining a `.reduce` at the call site
 * where a future edit could change the comparison without anyone noticing.
 */

export interface AsLowAsCandidate {
  readonly masterVariantId: string;
  readonly bankPaymentPriceMinorUnits: bigint;
}

/**
 * The lowest Bank Payment Price among already-purchasable candidates.
 *
 * Returns `null` for an empty list — criterion 31: "if no variant is
 * currently purchasable, the card shows the product's unavailable state,
 * never a stale or fabricated 'As low as'." There is deliberately no
 * fallback value this function could return instead; `null` is the only
 * answer that cannot be mistaken for a real price.
 *
 * DETERMINISTIC ON A TIE. Two variants at the exact same Bank Payment Price
 * both pick out a valid answer; without a tie-break the winner would depend
 * on array order, which depends on however the caller happened to query the
 * database. Lowest `masterVariantId` (plain string comparison) wins ties, so
 * recomputing this against the same underlying data always names the same
 * winner — required for the metafield's `priceCalculationId` staleness check
 * to mean anything (re-running this must not flip the winner for no reason).
 */
export function selectLowestPurchasablePrice<T extends AsLowAsCandidate>(
  candidates: readonly T[]
): T | null {
  if (candidates.length === 0) return null;

  return candidates.reduce((lowest, candidate) => {
    if (candidate.bankPaymentPriceMinorUnits < lowest.bankPaymentPriceMinorUnits) {
      return candidate;
    }
    if (
      candidate.bankPaymentPriceMinorUnits === lowest.bankPaymentPriceMinorUnits &&
      candidate.masterVariantId < lowest.masterVariantId
    ) {
      return candidate;
    }
    return lowest;
  });
}
