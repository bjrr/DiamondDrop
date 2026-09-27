/**
 * The provider-adapter registry (D32). Adding a second provider later means
 * adding one file under `./providers/` and one line here — no change to any
 * caller (repository, route), and still no provider-specific concept leaking
 * outside `app/app/insurance/**`.
 */

import { JEWELERS_MUTUAL_PROVIDER } from "./providers/jewelersMutual";
import type { InsuranceProviderId, ShippingInsuranceProvider } from "./port";

const REGISTERED_PROVIDERS: readonly ShippingInsuranceProvider[] = [JEWELERS_MUTUAL_PROVIDER];

const PROVIDERS_BY_ID: ReadonlyMap<InsuranceProviderId, ShippingInsuranceProvider> = new Map(
  REGISTERED_PROVIDERS.map((provider) => [provider.id, provider])
);

/** For a staff-facing provider picker — never for branching on a specific provider's identity. */
export function listInsuranceProviders(): readonly ShippingInsuranceProvider[] {
  return REGISTERED_PROVIDERS;
}

export function getInsuranceProvider(id: InsuranceProviderId): ShippingInsuranceProvider | null {
  return PROVIDERS_BY_ID.get(id) ?? null;
}

export function isKnownInsuranceProviderId(id: string): boolean {
  return PROVIDERS_BY_ID.has(id);
}
