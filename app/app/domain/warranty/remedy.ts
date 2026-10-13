/**
 * Warranty claim remedy — money coherence (D-none; docs/WARRANTY-CLAIMS.md
 * §6, docs/specs/SLICE-5-WARRANTY-CLAIMS.md criteria 162-164, task 5-1).
 *
 * PURE — no database access, no I/O. Mirrors, at the application layer, the
 * exact rule `warranty_claim_remedy_refund_money_coherent` enforces in
 * `prisma/migrations/20260925010000_slice5_warranty_claims_schema` at the
 * database layer: refund money fields are present if and only if the remedy
 * kind is `refund`. Keeping both means a caller gets a clear, typed refusal
 * before ever reaching the database, while the CHECK constraint remains the
 * backstop against anything that bypasses this module (criterion 164: money
 * as integer minor units, never floating point — this module never performs
 * arithmetic on the amount, only presence/absence validation, so there is
 * nothing here for the money-safety scan to flag).
 *
 * REMEDY SELECTION ITSELF (criterion 162 — "the customer never selects it")
 * is enforced by what this module does NOT accept as input: there is no
 * parameter anywhere in this file for "customer's requested remedy". The
 * only caller of `WarrantyClaimRemedy`-writing code is task 5-2's staff/admin
 * repository path; nothing here reads from a customer-facing request body.
 *
 * IDEMPOTENCY (criterion 163) is a database-level guarantee
 * (`@@unique([claimId])` on `warranty_claim_remedy`), not something this
 * pure module can enforce — a uniqueness constraint is deliberately not a
 * read-then-write check, and a pure function has no "before" to compare
 * against. See that model's doc comment in `schema.prisma`.
 */

export const WARRANTY_REMEDY_KINDS = ["repair", "replacement", "refund", "other"] as const;
export type WarrantyRemedyKind = (typeof WARRANTY_REMEDY_KINDS)[number];

export interface WarrantyRemedyMoneyInput {
  readonly kind: WarrantyRemedyKind;
  /** Integer minor units — never a float, never a Number derived from one. */
  readonly refundAmountMinorUnits: bigint | null;
  readonly currency: string | null;
}

export type WarrantyRemedyMoneyValidationResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Validates the same coherence the database CHECK constraint enforces:
 * `kind === "refund"` requires both money fields present and positive;
 * any other kind requires both absent.
 */
export function validateWarrantyRemedyMoney(input: WarrantyRemedyMoneyInput): WarrantyRemedyMoneyValidationResult {
  if (input.kind === "refund") {
    if (input.refundAmountMinorUnits === null || input.currency === null) {
      return { ok: false, reason: "a refund remedy requires refundAmountMinorUnits and currency" };
    }
    if (input.refundAmountMinorUnits <= 0n) {
      return { ok: false, reason: "refundAmountMinorUnits must be a positive integer minor-unit amount" };
    }
    if (input.currency.length !== 3) {
      return { ok: false, reason: "currency must be an ISO-4217 3-letter code" };
    }
    return { ok: true };
  }

  if (input.refundAmountMinorUnits !== null || input.currency !== null) {
    return {
      ok: false,
      reason: `a "${input.kind}" remedy must not carry refund money fields`,
    };
  }
  return { ok: true };
}
