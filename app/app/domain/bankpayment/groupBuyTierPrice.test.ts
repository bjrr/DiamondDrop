import { describe, expect, it } from "vitest";

import type { TierDefinition } from "~/domain/groupbuy/tiers";

import { computeGroupBuyTierLinePrice, type GroupBuyTierPricingProfile } from "./groupBuyTierPrice";

const PROFILE: GroupBuyTierPricingProfile = {
  roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
  priceEndingRuleId: "NONE_V1",
  regularCardPriceRuleId: "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1",
  // Ignored by the tiered rule (it selects its own rate from the Bank
  // Payment Price) — present only because the profile shape always carries
  // one, exactly as the real frozen campaign profile does.
  fixedCardUpliftRate: "0.040000",
};

const TIER_1: TierDefinition = { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" };
const TIER_2: TierDefinition = { tierNumber: 2, minQualifyingUnits: 5, priceMultiplier: "0.900000" };

describe("computeGroupBuyTierLinePrice", () => {
  it("at tier 1 (no discount), matches the known bank-checkout fixture's $2,000 -> $2,080 (4.0% band) derivation exactly", () => {
    const result = computeGroupBuyTierLinePrice(200_000n, TIER_1, PROFILE, "USD");
    expect(result.bankPaymentPriceMinorUnits).toBe(200_000n);
    expect(result.regularCardPriceMinorUnits).toBe(208_000n);
  });

  it("at a discounted tier, the multiplier applies to the FROZEN base before card derivation", () => {
    const result = computeGroupBuyTierLinePrice(200_000n, TIER_2, PROFILE, "USD");
    // $2,000 * 0.90 = $1,800.00
    expect(result.bankPaymentPriceMinorUnits).toBe(180_000n);
    // $1,800 * 1.04 (still the $1,000-$2,499.99 band) = $1,872.00 -> ceil to
    // the next $5 = $1,875.00.
    expect(result.regularCardPriceMinorUnits).toBe(187_500n);
  });

  it("rounds a fractional exact tier result under the configured rounding rule (the single rounding boundary)", () => {
    const fractionalTier: TierDefinition = { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "0.333335" };
    // $1,000.00 * 0.333335 = $333.335 exactly -> HALF_UP -> $333.34.
    const result = computeGroupBuyTierLinePrice(100_000n, fractionalTier, PROFILE, "USD");
    expect(result.bankPaymentPriceMinorUnits).toBe(33_334n);
  });

  it("a lower tier's bank price can cross a Bank/Card uplift band boundary — the card rate is re-selected, not carried over", () => {
    // $1,000.00 base; tier 2 (10% off) -> $900.00, which drops from the
    // $1,000-$2,499.99 4.0% band into the $500-$999.99 4.5% band.
    const result = computeGroupBuyTierLinePrice(100_000n, TIER_2, PROFILE, "USD");
    expect(result.bankPaymentPriceMinorUnits).toBe(90_000n);
    // $900 * 1.045 = $940.50 -> ceil to next $5 = $945.00.
    expect(result.regularCardPriceMinorUnits).toBe(94_500n);
  });
});
