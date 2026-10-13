/**
 * Validates a staff-recorded "we purchased/hold this coverage externally"
 * claim BEFORE it is persisted (D32). PURE — no database access, no I/O, no
 * ambient clock.
 *
 * Composes two independent checks and never re-derives either: provider
 * recognition + provider-specific reference format (`../registry`,
 * `../port` — the ONLY provider-specific knowledge involved) and money
 * coherence (`app/domain/shipping/insuredValue.ts`'s
 * `validateInsuredValue`, imported and reused rather than reimplemented —
 * this module is not the shipping evidence domain and must not restate its
 * money rule). Recording a purchase never enforces the covered value equals
 * any computed shipment merchandise value — D30/G2 leaves that unanswered;
 * see `insuredValue.ts`'s own header.
 */

import { validateInsuredValue } from "~/domain/shipping/insuredValue";

import { getInsuranceProvider } from "./registry";
import type { PurchasedInsuranceCoverage } from "./port";

export type ValidatePurchasedCoverageResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

export function validatePurchasedCoverage(input: PurchasedInsuranceCoverage): ValidatePurchasedCoverageResult {
  const provider = getInsuranceProvider(input.providerId);
  if (!provider) {
    return { ok: false, reason: `"${input.providerId}" is not a recognized insurance provider.` };
  }

  const referenceCheck = provider.validateReference(input.policyOrCertificateReference);
  if (!referenceCheck.ok) {
    return referenceCheck;
  }

  const moneyCheck = validateInsuredValue({
    insuredValueMinorUnits: input.coveredValueMinorUnits,
    currency: input.coveredValueCurrency,
  });
  if (!moneyCheck.ok) {
    return moneyCheck;
  }

  return { ok: true };
}
