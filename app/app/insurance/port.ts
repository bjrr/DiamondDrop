/**
 * Shipping-insurance PROVIDER-ADAPTER PORT (D32, docs/ARCHITECTURE-MVP1.md,
 * resolved 2026-09-25).
 *
 * LIVES OUTSIDE `app/app/domain/shipping/**` ON PURPOSE. D32 named JM
 * Shipping Solution / Jewelers Mutual as the initial provider, but was
 * explicit that the architecture must stay provider-adapter based and must
 * NOT bake Jewelers Mutual (or any other provider's) concepts into the
 * shipping evidence domain. `app/app/domain/shipping/insuredValue.ts`
 * already validates that a recorded insured value is coherent MONEY — that
 * is provider-agnostic and correctly stays where it is. What is
 * provider-SPECIFIC (which providers exist, what a reference from that
 * provider looks like) lives entirely under this directory instead, so a
 * reviewer can tell the two apart by where the code lives, not by a comment.
 *
 * MVP1 SCOPE — RECORD AND VERIFY, NOT A LIVE INTEGRATION (D32). No provider
 * adapter here calls out to a real insurer API. "Purchasing" coverage
 * happens outside this app (a human buys a policy/certificate from the
 * provider); this port's job is to validate and shape what staff record
 * about that external purchase, and later its verification, so a specific
 * provider can be swapped or added without touching `app/app/domain/shipping/**`
 * or the shipment repository's calling code.
 */

/** An opaque identifier for a registered provider (e.g. "jewelers_mutual"). Never compared against or branched on outside `app/app/insurance/**`. */
export type InsuranceProviderId = string;

export type ReferenceValidationResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

/**
 * One adapter per provider. Every provider-specific notion (display name,
 * what a well-formed reference looks like) is a member of THIS interface,
 * implemented under `./providers/*` — never inlined into a repository,
 * route, or the shipping domain.
 */
export interface ShippingInsuranceProvider {
  readonly id: InsuranceProviderId;
  readonly displayName: string;
  /**
   * Format-only sanity check on a reference staff typed in (a policy or
   * certificate number) — never a network call, never a live coverage
   * lookup (MVP1 records and verifies externally purchased coverage; see
   * module header). A provider with no special format simply accepts any
   * non-blank string.
   */
  validateReference(reference: string): ReferenceValidationResult;
}

/** What staff record about an externally purchased policy/certificate for one shipment. */
export interface PurchasedInsuranceCoverage {
  readonly providerId: InsuranceProviderId;
  readonly policyOrCertificateReference: string;
  readonly coveredValueMinorUnits: bigint;
  readonly coveredValueCurrency: string;
}

/** What staff record when they have confirmed, with the provider, that the coverage above is real and adequate. Evidence of an attestation, never a computed fact. */
export interface VerifiedInsuranceCoverage {
  readonly verifiedByActorRef: string;
  readonly verifiedAt: Date;
}
