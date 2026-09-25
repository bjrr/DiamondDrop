/**
 * Shipment insured value — coherence only, never a threshold (D-none;
 * README.md "Shipping, Insurance & Signature — MVP1 Locked Direction",
 * docs/specs/SLICE-11-SHIPMENT-EVIDENCE.md criterion 173,
 * docs/specs/SLICE-11-READINESS.md G1/G2, task: slice 11 subset).
 *
 * PURE — no database access, no I/O. Mirrors, at the application layer, the
 * `shipment_insured_value_coherent` / `shipment_insured_value_positive` CHECK
 * constraints in `prisma/migrations/20260925020000_slice11_shipment_evidence`
 * at the database layer: an insured value and its currency are present
 * together or absent together, and when present the amount is positive.
 *
 * WHAT THIS MODULE DELIBERATELY DOES NOT DO: compare the insured amount
 * against an order total. README says "every outbound customer shipment is
 * insured for the full order value" — a real rule — but `docs/specs/
 * SLICE-11-READINESS.md` G1 (what "order value" means) and G2 (what
 * insurance mechanism/provider can even reach that figure on a high-value
 * piece) are both open owner questions. A function here that took an order
 * amount and validated the insured value against it would have to invent
 * answers to both to exist. This module only checks that whatever amount
 * staff recorded is well-formed money — never whether it is the RIGHT
 * amount.
 */

export type InsuredValueInput =
  | { readonly insuredValueMinorUnits: null; readonly currency: null }
  | { readonly insuredValueMinorUnits: bigint; readonly currency: string };

export type InsuredValueValidationResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * Validates the same coherence the database CHECK constraints enforce:
 * amount and currency present together or absent together, and a present
 * amount is a positive integer minor-unit value with a well-formed
 * ISO-4217 currency code. No comparison to any order figure — see module
 * header.
 */
export function validateInsuredValue(input: InsuredValueInput): InsuredValueValidationResult {
  if (input.insuredValueMinorUnits === null) {
    // input.currency === null too, by the discriminated union — nothing more to check.
    return { ok: true };
  }

  if (input.insuredValueMinorUnits <= 0n) {
    return { ok: false, reason: "insuredValueMinorUnits must be a positive integer minor-unit amount" };
  }
  if (input.currency.length !== 3) {
    return { ok: false, reason: "currency must be an ISO-4217 3-letter code" };
  }
  return { ok: true };
}
