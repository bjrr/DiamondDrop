/**
 * Shared literal types for the admin-alert view model (Slice 2 stage 2A,
 * owner §7/§15 in docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md).
 *
 * These are plain string unions, not imports of the Prisma-generated enums
 * (`AdminAlertSourceKind`/`AdminAlertEvent` in `@prisma/client`) — this
 * module stays pure (see `viewModel.ts`'s own doc comment) and must not
 * import from `@prisma/client` or anything `.server`. The string values are
 * kept identical to the Prisma enum's own values on purpose, so a Prisma
 * enum value is assignable here with no conversion at the repository
 * boundary.
 */

/**
 * Which failure table (or, for `bank_payment_guarantee`, which OTHER
 * evidence table) an alert is about. Calculation and sync failures stay
 * textually and structurally distinct everywhere downstream of this type —
 * in the view model, the rendered email, and (per the admin-route owner) the
 * embedded-admin surface — because they name different problems requiring
 * different fixes: no price could be computed at all, versus a price WAS
 * computed and Shopify refused to accept it.
 *
 * `bank_payment_guarantee` (Slice 2C-b, spec §13/§14 criterion 102) is a
 * third, structurally different kind: it has no dedicated episode table of
 * its own (see the `AdminAlertSourceKind` enum's own doc comment in
 * `schema.prisma`), so its view model is built directly from context the
 * caller already resolved (`buildBankPaymentGuaranteeAlertViewModel` in
 * `viewModel.ts`), not loaded by id the way the other two are.
 */
export type AlertSourceKind = "calculation_failure" | "sync_failure" | "bank_payment_guarantee";

/**
 * The closed set of meaningful episode transitions a notification fires on.
 * Deliberately excludes "retry" — see `dispatchAdminAlert`'s own doc
 * comment for why a retry within an already-open episode is not one of
 * these.
 */
export type AlertEvent = "opened" | "suspended" | "resolved";

/** Current standing of an episode, independent of which event triggered a notification. */
export type AlertStatus = "open" | "suspended" | "resolved";
