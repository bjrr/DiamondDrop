import { prisma } from "~/db/client.server";
import { isVariantWithdrawn as isVariantWithdrawnByCalculationFailure } from "~/domain/pricing/calculationFailure";
import { isVariantWithdrawn as isVariantWithdrawnBySyncFailure } from "~/domain/pricing/syncFailure";
import { getPublishedVariantPrice } from "~/db/repositories/publishedPriceRepository.server";
import type { VariantPriceFacts } from "~/domain/bankpayment/guaranteeDecision";

/**
 * Resolves `VariantPriceFacts` for one variant, against the REAL tables
 * (spec §13/D22; `guaranteeDecision.ts`'s own doc comment on why this is
 * historical, not current-state).
 *
 * WHAT COUNTS AS "PUBLISHED", AND THE GAP THIS FUNCTION DOES NOT PAPER OVER.
 * `getPublishedVariantPrice` (`~/db/repositories/publishedPriceRepository.
 * server.ts`) is, by its own header comment, "THE ONLY WAY a customer
 * -facing surface may learn a variant's price" — and it is exactly what
 * `apps.carat.bank-checkout.tsx` calls to quote a NEW order. This function
 * uses the identical resolver for the CURRENT price, so "has the price
 * changed since the quote" compares like with like: the same notion of
 * "published" a customer would be quoted today.
 *
 * A manual price override (`PriceOverride`) is NOT wired into
 * `getPublishedVariantPrice` anywhere in this codebase today — confirmed by
 * reading every caller of `resolveActiveOverride`
 * (`~/jobs/pricing/priceOverride.server.ts`), none of which feeds
 * `master_variant.lastSyncedPriceCalculationId` or any other read path a
 * customer-facing surface consults (architect-confirmed 2026-09-22).
 * `humanDrivenOverrideSinceQuote` below is still computed, per D22's
 * explicit instruction to treat an override as a human-approval signal, but
 * until override-publish wiring exists elsewhere in the system,
 * `publishedBankPaymentPriceMinorUnits` itself will never actually reflect
 * an override's price — so this flag alone cannot yet trigger a
 * cancellation (`decideGuaranteeOutcome` also requires the published price
 * to have moved). It will start doing so automatically, with no change
 * needed here, the moment that wiring lands.
 *
 * `kind: { in: ["set", "revoke"] }` — NOT `"expired"` (architect decision,
 * 2026-09-22). The line is human-initiated versus system-initiated: a human
 * revoking an override is a person deciding this customer's price should
 * move back to the calculated one, which is exactly what D22 cancels on.
 * `expired` is the SYSTEM automatically retiring an override on a material
 * recalculation (`~/domain/pricing/overrideExpiry.ts`) — nobody decided
 * anything, which is the case D22 protects the customer from. See
 * `VariantPriceFacts.humanDrivenOverrideSinceQuote`'s own doc comment.
 *
 * UNRESOLVABLE (D21/criterion 82) means the variant is currently WITHDRAWN
 * by either failure mode — `isVariantWithdrawn` applied to whichever of
 * `price_calculation_failure` / `price_sync_failure` has an open episode,
 * exactly the R2 availability predicate the rest of the system uses to
 * decide "can this variant currently be sold". A merely-retrying, NOT YET
 * suspended episode does not count: CLAUDE.md #16 keeps the last valid price
 * live for up to 48 hours, and that last valid price is still a real,
 * comparable answer to "what does this variant cost right now".
 */
export async function gatherVariantPriceFacts(masterVariantId: string, quotedAt: Date): Promise<VariantPriceFacts> {
  const [calcFailure, syncFailure, humanApprovedIntent, humanDrivenOverride] = await Promise.all([
    prisma.priceCalculationFailure.findFirst({
      where: { masterVariantId, resolvedAt: null },
      select: { id: true, suspendedAt: true, resolvedAt: true, firstFailedAt: true },
    }),
    prisma.priceSyncFailure.findFirst({
      where: { masterVariantId, resolvedAt: null },
      select: { id: true, suspendedAt: true, resolvedAt: true, firstFailedAt: true },
    }),
    prisma.priceSyncIntent.findFirst({
      where: {
        masterVariantId,
        decision: "needs_approval",
        status: "synced",
        syncedAt: { gt: quotedAt },
      },
      select: { id: true },
    }),
    prisma.priceOverride.findFirst({
      where: { masterVariantId, kind: { in: ["set", "revoke"] }, createdAt: { gt: quotedAt } },
      select: { id: true },
    }),
  ]);

  const withdrawnByCalculation =
    calcFailure !== null && isVariantWithdrawnByCalculationFailure(calcFailure);
  const withdrawnBySync = syncFailure !== null && isVariantWithdrawnBySyncFailure(syncFailure);
  const withdrawn = withdrawnByCalculation || withdrawnBySync;

  // The episode the alert is keyed on. Calculation failure is named first
  // when both are open, matching CLAUDE.md #24's insistence that the two
  // states stay distinct: a variant whose price cannot be COMPUTED has a
  // more fundamental problem than one that merely cannot be published, and
  // that is the one an admin should be pointed at first.
  let unresolvableEpisodeId: string | null = null;
  let unresolvableEpisodeFirstFailedAt: Date | null = null;
  if (withdrawnByCalculation) {
    unresolvableEpisodeId = calcFailure!.id;
    unresolvableEpisodeFirstFailedAt = calcFailure!.firstFailedAt;
  } else if (withdrawnBySync) {
    unresolvableEpisodeId = syncFailure!.id;
    unresolvableEpisodeFirstFailedAt = syncFailure!.firstFailedAt;
  }

  let publishedBankPaymentPriceMinorUnits: bigint | null = null;
  if (!withdrawn) {
    const published = await getPublishedVariantPrice(masterVariantId);
    publishedBankPaymentPriceMinorUnits =
      published.kind === "purchasable" ? published.price.bankPaymentPriceMinorUnits : null;
  }

  // A price that resolved to null WITHOUT a withdrawal episode (never
  // published at all) is still unresolvable, and still needs an alert key.
  // Falling back to the variant id keeps the alert addressable; it cannot
  // collide with an episode id, and a variant in this state has no episode
  // that could flap.
  if (publishedBankPaymentPriceMinorUnits === null && unresolvableEpisodeId === null) {
    unresolvableEpisodeId = masterVariantId;
  }

  return {
    publishedBankPaymentPriceMinorUnits,
    unresolvableEpisodeId,
    unresolvableEpisodeFirstFailedAt,
    humanApprovedPublicationSinceQuote: humanApprovedIntent !== null,
    humanDrivenOverrideSinceQuote: humanDrivenOverride !== null,
  };
}
