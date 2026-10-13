/**
 * The 24-hour Bank Payment guarantee — the decision layer (owner D21/D22,
 * `docs/specs/SLICE-2C-BANK-PAYMENT-CHECKOUT.md` §13; acceptance criteria
 * 77-82, 96).
 *
 * PURE — no database access, no I/O, no ambient clock (every "now" is a
 * parameter). Mirrors `~/domain/pricing/syncFailure.ts`'s discipline: the
 * job side (`app/jobs/bankpayment/guaranteeSweep.server.ts`) resolves the
 * real `bank_payment_order` row, gathers `VariantPriceFacts` per line, and
 * calls `decideGuaranteeOutcome` with explicit inputs. Nothing here queries
 * anything, which is what makes the ordering below exhaustively table
 * -testable without a database.
 *
 * ============================================================================
 * THE PRECISION THAT MATTERS (D22, §13) — read this before touching step 4.
 * ============================================================================
 * The naive implementation asks "was the CURRENT published calculation
 * published by a human". That question is answered wrong by a very ordinary
 * sequence: a human approves a 6% rise, gold drifts 0.3% overnight and
 * auto-publishes ON TOP of it, and the current published calculation is now
 * an automatic one — so the naive check says "keep", and the order survives
 * a repricing a human explicitly approved.
 *
 * `VariantPriceFacts.humanApprovedPublicationSinceQuote` and
 * `.humanDrivenOverrideSinceQuote` are therefore HISTORICAL facts —
 * "did a human-driven publication happen for this variant at any point
 * between the quote and now" — not "how was the price published that
 * happens to be live right now". Computing them that way is the caller's
 * job (see the doc comment on `VariantPriceFacts`); this module only
 * combines them with whether the price actually moved.
 *
 * THE PRICE-DIFFERENCE HALF IS EQUALLY REQUIRED. A human can approve a
 * republication that lands on the SAME price (e.g. re-confirming a pending
 * calculation after a review delay). Cancelling on the historical fact alone
 * would punish a customer for a change that never actually moved their
 * price. Cancellation requires BOTH halves: a human-driven publication
 * happened since the quote, AND the published price actually differs from
 * what was quoted.
 */

/** Matches the Prisma `BankPaymentOrderStatus` enum's own values exactly — kept as a plain string union so this module never imports `@prisma/client` (same discipline as `~/domain/alerts/types.ts`). */
export type GuaranteeOrderStatus = "open" | "cancelled" | "completed";

/**
 * What the caller was able to establish about a variant's CURRENTLY
 * published Bank Payment Price, as of "now" — gathered historically where
 * noted. See `guaranteeFacts.server.ts` for how each field is actually
 * resolved against the real tables.
 */
export interface VariantPriceFacts {
  /**
   * The variant's current authoritative Bank Payment Price, or `null` when
   * UNRESOLVABLE — the variant is currently withdrawn by either failure
   * mode (`~/domain/pricing/syncFailure.ts` / `~/domain/pricing/
   * calculationFailure.ts`'s `isVariantWithdrawn`), or has otherwise lost
   * its published price. D21: an unresolvable price counts as UNCHANGED for
   * cancellation purposes, but is never treated as confirmed-unchanged
   * either — see criterion 82 and step 3 below.
   */
  publishedBankPaymentPriceMinorUnits: bigint | null;
  /**
   * The id of the failure episode that made this variant unresolvable —
   * a `price_calculation_failure` or `price_sync_failure` row — or `null`
   * when the price resolved normally. Non-null exactly when
   * `publishedBankPaymentPriceMinorUnits` is `null`.
   *
   * WHY THE DECISION LAYER CARRIES AN ID IT NEVER READS. It does not affect
   * any outcome here; it exists so the sweep can key its admin alert on the
   * EPISODE rather than on the order. `admin_alert_notification` is unique
   * on `(sourceKind, sourceId, event)`, so an order id — which outlives
   * every episode — permits exactly one `opened` and one `resolved` for all
   * time: flag, resolve, then flag again, and the second flag is silently
   * refused by the index and nobody is ever told. An episode id is created
   * fresh per episode, which is precisely why the calculation- and
   * sync-failure alerts already key on theirs.
   */
  unresolvableEpisodeId: string | null;
  /**
   * The episode's own `firstFailedAt`, or `null` when `unresolvableEpisodeId`
   * is falling back to the variant id itself (no real episode row backs it —
   * see `guaranteeFacts.server.ts`). Carried alongside the id for the exact
   * same alerting reason: naming the true moment an admin's problem began is
   * more honest than substituting an arbitrary affected order's own
   * `guaranteeExpiresAt`, which would differ across orders sharing one
   * episode and mean nothing about when the episode itself started.
   */
  unresolvableEpisodeFirstFailedAt: Date | null;
  /**
   * HISTORICAL: at least one `price_sync_intent` for this variant reached
   * `synced` with `decision: "needs_approval"` at some instant AFTER
   * `quotedAt` — regardless of what has published since. An admin approving
   * a queued repricing is a human deciding to change the price; that fact
   * does not stop being true because an automatic publication landed on top
   * of it later.
   */
  humanApprovedPublicationSinceQuote: boolean;
  /**
   * HISTORICAL: a `PriceOverride` of kind `set` OR `revoke` for this variant
   * took effect AFTER `quotedAt` — a human setting a price deliberately
   * (D22 calls `set` "the strongest form of the signal"), OR a human
   * deliberately REVOKING one, returning the variant to its calculated
   * price. Both count for the identical reason: the line that matters is
   * HUMAN-INITIATED versus SYSTEM-INITIATED, not "carries a price of its
   * own versus doesn't". A person choosing to revoke an override is a
   * person deciding this customer's price should move, exactly the case
   * D22 cancels on.
   *
   * `kind: "expired"` does NOT count, and must never be added here. An
   * expiry is the SYSTEM automatically retiring an override on a material
   * recalculation (`~/domain/pricing/overrideExpiry.ts`) — nobody decided
   * anything, which is precisely the case D22 protects the customer from
   * (an automatic change should not cancel their order). Reusing this
   * field's name or reasoning to justify including `expired` here would be
   * the exact mistake the human-approval historical check exists to avoid.
   */
  humanDrivenOverrideSinceQuote: boolean;
}

export interface GuaranteeDecisionLine {
  masterVariantId: string;
  /** What THIS customer was actually quoted and charged for this line (criterion 44/77). */
  quotedBankPaymentPriceMinorUnits: bigint;
  facts: VariantPriceFacts;
}

export interface GuaranteeDecisionInput {
  status: GuaranteeOrderStatus;
  /** True once an admin has recorded payment receipt (`bank_payment_order.verifiedAt IS NOT NULL`) — independent of `status`, which may still read `open` while completion is pending. */
  paymentVerified: boolean;
  quotedAt: Date;
  guaranteeExpiresAt: Date;
  now: Date;
  /** Every line on the order. Never empty in practice — an order with no lines could not have been created — but this function does not assume that; zero lines simply cannot trigger a cancellation. */
  lines: readonly GuaranteeDecisionLine[];
}

export type GuaranteeAction = "keep" | "cancel" | "flag";

/** Named per line so the persisted `cancellationReason` (criterion "which variant and which price moved") can be built directly from this, with no second lookup. */
export interface GuaranteeCancellingLine {
  masterVariantId: string;
  quotedPriceMinorUnits: bigint;
  publishedPriceMinorUnits: bigint;
}

export interface GuaranteeDecision {
  action: GuaranteeAction;
  reason: string;
  /** Populated only when `action === "cancel"` — every line whose human-approved published price differs from its quote, not merely the first found. */
  cancellingLines?: readonly GuaranteeCancellingLine[];
}

/**
 * The full decision, evaluated in the fixed order the spec requires. Once a
 * step fires, later steps are never reached — in particular, step 3
 * (unresolvable) is checked BEFORE step 4 (human-approved change), so a
 * single unresolvable line on an otherwise-clearly-repriced order still
 * flags rather than cancels (D21: "auto-cancelling on an unanswerable
 * question converts an outage into a lost sale").
 */
export function decideGuaranteeOutcome(input: GuaranteeDecisionInput): GuaranteeDecision {
  // Step 1 — already settled, one way or the other. A cancelled/completed
  // order is not this sweep's concern again, and a verified-but-not-yet
  // -completed order (status may still read "open") must never be cancelled
  // out from under a payment an admin has already recorded.
  if (input.status !== "open" || input.paymentVerified) {
    return {
      action: "keep",
      reason: input.paymentVerified
        ? "payment already verified — the guarantee no longer governs this order"
        : `order status is "${input.status}", not "open" — nothing for the guarantee sweep to decide`,
    };
  }

  // Step 2 — boundary INCLUSIVE, mirroring `decideSuspension`'s own 48-hour
  // trap: elapsed >= 24h is "after 24 hours" (criteria 78-80 all read that
  // way), so the exact instant of expiry is already past-guarantee, not
  // still-within-guarantee.
  const stillWithinGuarantee = input.now.getTime() < input.guaranteeExpiresAt.getTime();
  if (stillWithinGuarantee) {
    return {
      action: "keep",
      reason: "still within the 24-hour guarantee — the quoted price is honoured regardless of the current price",
    };
  }

  // Step 3 — D21/criterion 82. ANY unresolvable line stops a cancellation
  // outright, even if another line on the same order shows a clear,
  // human-approved change: we cannot fully answer "has the price changed"
  // for this order, so we do not answer "yes" by omission.
  const hasUnresolvableLine = input.lines.some(
    (line) => line.facts.publishedBankPaymentPriceMinorUnits === null
  );
  if (hasUnresolvableLine) {
    return {
      action: "flag",
      reason:
        "at least one line's published price is unresolvable (suspended or failed) — " +
        "the guarantee cannot be evaluated, so the order stays open and is flagged for admin (D21)",
    };
  }

  // Step 4 — cancel only where BOTH halves hold for the same line: the
  // price actually moved, AND a human-driven publication happened for that
  // variant since the quote. Collected across every qualifying line, not
  // just the first, so the persisted reason can name all of them.
  const cancellingLines: GuaranteeCancellingLine[] = [];
  for (const line of input.lines) {
    const published = line.facts.publishedBankPaymentPriceMinorUnits;
    // Narrowed already by step 3 above, but TypeScript does not know that
    // across the loop body — asserted defensively rather than with `!`.
    if (published === null) continue;

    const priceChanged = published !== line.quotedBankPaymentPriceMinorUnits;
    const humanDriven = line.facts.humanApprovedPublicationSinceQuote || line.facts.humanDrivenOverrideSinceQuote;
    if (priceChanged && humanDriven) {
      cancellingLines.push({
        masterVariantId: line.masterVariantId,
        quotedPriceMinorUnits: line.quotedBankPaymentPriceMinorUnits,
        publishedPriceMinorUnits: published,
      });
    }
  }

  if (cancellingLines.length > 0) {
    return {
      action: "cancel",
      reason:
        "at least one line's price changed through a human-approved publication or override since the quote " +
        "— no tolerance band, one cent of human-approved change qualifies (D22)",
      cancellingLines,
    };
  }

  // Step 5 — criterion 96: only automatic publications (or no change at
  // all) since the quote. The order stays open at the quoted price and the
  // customer is not emailed.
  return {
    action: "keep",
    reason:
      "past the 24-hour guarantee, but every published change since the quote (if any) was automatic — " +
      "D22 exempts automatic publication from cancellation",
  };
}
