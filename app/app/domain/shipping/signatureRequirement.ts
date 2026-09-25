/**
 * Shipment signature requirement — RECORDED, NEVER DERIVED (D-none;
 * README.md "Shipping, Insurance & Signature — MVP1 Locked Direction",
 * docs/specs/SLICE-11-SHIPMENT-EVIDENCE.md criteria 174-175,
 * docs/specs/SLICE-11-READINESS.md G1, task: slice 11 subset).
 *
 * THIS IS THE ENFORCEMENT BOUNDARY. Read this before adding anything to this
 * file.
 *
 * README states a real rule: any shipment with order value above $100
 * requires signature confirmation, non-waivable by the customer, and
 * orders at or below $100 may ship without one by default. That rule is
 * NOT implemented here, and is not implemented anywhere in this codebase.
 * `docs/specs/SLICE-11-READINESS.md` G1 found that "order value" — the
 * denominator the $100 figure is compared against — is undefined in every
 * document that governs this feature (merchandise subtotal? total including
 * tax/shipping/duties?), and it is now an open question with the owner.
 *
 * A function here that computed `signatureRequired` from an amount would
 * have to pick an answer to G1 to exist at all — silently, by the shape of
 * its own parameter list. That is exactly the invented default this task
 * was told not to produce. So there is no such function: no `$100`, no
 * `10000` (its minor-unit form), no `deriveSignatureRequired(orderTotal)`,
 * not even as a TODO. The absence is the decision, not an oversight — see
 * `docs/specs/SLICE-11-READINESS.md` for the full reasoning and the
 * question now in front of the owner.
 *
 * What this module DOES do: validate that a STAFF-RECORDED signature
 * decision is well-formed evidence — someone specific decided it, at a
 * specific time — before it's persisted. It never asks why they decided it,
 * and it never checks their answer against anything. That is `Shipment.
 * signatureRequired` (criterion 174): a fact about what was actually
 * arranged for one specific shipment, recorded by a person, not computed by
 * this codebase.
 */

export interface SignatureRequirementDecision {
  readonly signatureRequired: boolean;
  /** The staff member who decided this. Never a customer, never "system". */
  readonly decidedByActorRef: string;
  readonly decidedAt: Date;
}

export type SignatureRequirementValidationResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string };

/**
 * Validates that a signature-requirement decision carries the provenance
 * criterion 174 requires — a named decider and a timestamp — before it is
 * persisted. Deliberately does NOT accept an order amount as input: there is
 * nothing for this function to do with one (see module header).
 */
export function validateSignatureRequirementDecision(
  decision: SignatureRequirementDecision
): SignatureRequirementValidationResult {
  if (decision.decidedByActorRef.trim().length === 0) {
    return { ok: false, reason: "a signature-requirement decision must record who decided it" };
  }
  if (Number.isNaN(decision.decidedAt.getTime())) {
    return { ok: false, reason: "a signature-requirement decision must record a valid decidedAt timestamp" };
  }
  return { ok: true };
}
