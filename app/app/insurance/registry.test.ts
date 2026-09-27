import { describe, expect, it } from "vitest";

import { getInsuranceProvider, isKnownInsuranceProviderId, listInsuranceProviders } from "./registry";
import { JEWELERS_MUTUAL_PROVIDER_ID } from "./providers/jewelersMutual";

describe("insurance provider registry (D32)", () => {
  it("registers Jewelers Mutual as a known provider", () => {
    expect(isKnownInsuranceProviderId(JEWELERS_MUTUAL_PROVIDER_ID)).toBe(true);
    const provider = getInsuranceProvider(JEWELERS_MUTUAL_PROVIDER_ID);
    expect(provider).not.toBeNull();
    expect(provider!.displayName).toContain("Jewelers Mutual");
  });

  it("returns null for an unregistered provider id, never throws", () => {
    expect(getInsuranceProvider("acme_insurance")).toBeNull();
    expect(isKnownInsuranceProviderId("acme_insurance")).toBe(false);
  });

  it("lists at least the one initial provider, for a staff-facing picker", () => {
    const providers = listInsuranceProviders();
    expect(providers.length).toBeGreaterThanOrEqual(1);
    expect(providers.some((p) => p.id === JEWELERS_MUTUAL_PROVIDER_ID)).toBe(true);
  });
});
