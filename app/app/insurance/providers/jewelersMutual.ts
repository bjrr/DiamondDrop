/**
 * JM Shipping Solution / Jewelers Mutual adapter (D32, docs/ARCHITECTURE-
 * MVP1.md, resolved 2026-09-25 — "JM Shipping Solution / Jewelers Mutual as
 * the initial provider... keep the architecture provider-adapter based —
 * do NOT bake Jewelers Mutual concepts into the shipping evidence domain").
 *
 * THE ONLY FILE IN THIS CODEBASE THAT KNOWS THIS PROVIDER'S NAME. Every
 * caller — the repository, the staff route, the registry — reaches this
 * provider only through `../port`'s `ShippingInsuranceProvider` interface
 * and `../registry`'s lookup; none of them import this module directly or
 * branch on `JEWELERS_MUTUAL_PROVIDER_ID`'s value.
 *
 * No format is documented anywhere for a JM policy/certificate reference, so
 * this adapter does not invent one — inventing a format the provider does
 * not actually require would reject legitimate references. It requires only
 * that a reference was actually entered (an empty reference cannot verify
 * anything). D32: MVP1 records and verifies an externally purchased
 * certificate rather than integrating JM's API — nothing here calls out to
 * Jewelers Mutual over a network.
 */

import type { ReferenceValidationResult, ShippingInsuranceProvider } from "../port";

export const JEWELERS_MUTUAL_PROVIDER_ID = "jewelers_mutual";

function validateReference(reference: string): ReferenceValidationResult {
  if (reference.trim().length === 0) {
    return { ok: false, reason: "a Jewelers Mutual policy or certificate reference is required." };
  }
  return { ok: true };
}

export const JEWELERS_MUTUAL_PROVIDER: ShippingInsuranceProvider = {
  id: JEWELERS_MUTUAL_PROVIDER_ID,
  displayName: "JM Shipping Solution / Jewelers Mutual",
  validateReference,
};
