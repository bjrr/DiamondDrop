/**
 * Shipment insured value — coherence only, not an equality enforcement
 * (D29/D30, docs/ARCHITECTURE-MVP1.md, resolved 2026-09-25; README.md
 * "Shipping, Insurance & Signature — MVP1 Locked Direction";
 * docs/specs/SLICE-11-SHIPMENT-EVIDENCE.md criterion 173).
 *
 * PURE — no database access, no I/O. Mirrors, at the application layer, the
 * `shipment_insured_value_coherent` / `shipment_insured_value_positive` CHECK
 * constraints in `prisma/migrations/20260925020000_slice11_shipment_evidence`
 * at the database layer: an insured value and its currency are present
 * together or absent together, and when present the amount is positive.
 *
 * D29/D30 RESOLVED WHAT "insured for the full order value" MEANS — SHIPMENT
 * MERCHANDISE VALUE (`merchandiseValue.ts`'s `computeShipmentMerchandiseValue`),
 * valued per package, never a split package insured for the whole original
 * order. This module still does NOT enforce `insuredValueMinorUnits` equal
 * to the computed merchandise value: `docs/specs/SLICE-11-READINESS.md` G2
 * (what insurance mechanism/provider can actually REACH that figure on a
 * high-value piece — standard carrier declared-value coverage commonly
 * caps well below fine-jewellery prices) is still unanswered, and forcing
 * exact equality would silently assume G2's answer is "always achievable."
 * `computeShipmentMerchandiseValue` is the RECOMMENDED basis a staff member
 * should reach for when deciding what to insure for; what this module
 * validates is that whatever they actually arranged is well-formed money —
 * never whether it is the theoretically correct amount.
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
