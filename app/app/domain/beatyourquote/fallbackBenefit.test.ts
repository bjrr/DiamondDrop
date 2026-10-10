import { describe, expect, it } from "vitest";

import { Money } from "~/domain/money/money";

import {
  BEAT_QUOTE_FALLBACK_MAX_DISCOUNT_MINOR_UNITS,
  BEAT_QUOTE_FALLBACK_PERCENT,
  BEAT_QUOTE_FALLBACK_VALIDITY_DAYS,
  computeFallbackDiscount,
  evaluateFallbackRedeemability,
  fallbackExpiresAt,
  isFallbackEligibleSurface,
  type BeatQuoteRedemptionSurface,
  type FallbackRedeemabilityInput,
} from "./fallbackBenefit";

const usd = (minor: bigint) => Money.fromMinorUnits(minor, "USD");

describe("the discount: 10%, capped at $100 — amendment §3", () => {
  it("is 10% below the cap", () => {
    expect(computeFallbackDiscount(usd(50_000n)).amountMinorUnits).toBe(5_000n); // $500 -> $50
    expect(computeFallbackDiscount(usd(10_000n)).amountMinorUnits).toBe(1_000n); // $100 -> $10
  });

  it("caps at exactly $100, and the cap binds from $1000 upward", () => {
    // $1,000 is where 10% first reaches the cap, so it is the boundary worth
    // pinning from both sides.
    expect(computeFallbackDiscount(usd(99_999n)).amountMinorUnits).toBe(9_999n);
    expect(computeFallbackDiscount(usd(100_000n)).amountMinorUnits).toBe(BEAT_QUOTE_FALLBACK_MAX_DISCOUNT_MINOR_UNITS);
    expect(computeFallbackDiscount(usd(100_100n)).amountMinorUnits).toBe(BEAT_QUOTE_FALLBACK_MAX_DISCOUNT_MINOR_UNITS);
    expect(computeFallbackDiscount(usd(5_000_000n)).amountMinorUnits).toBe(
      BEAT_QUOTE_FALLBACK_MAX_DISCOUNT_MINOR_UNITS
    );
  });

  it("NEVER exceeds the cap, swept across a wide range", () => {
    // "maximum discount $100" is the term most likely to be violated by a
    // rounding change, so it is asserted as an invariant rather than at a few
    // points.
    for (let dollars = 0; dollars <= 20_000; dollars += 137) {
      const discount = computeFallbackDiscount(usd(BigInt(dollars) * 100n)).amountMinorUnits;
      expect(discount, `$${dollars}`).toBeLessThanOrEqual(BEAT_QUOTE_FALLBACK_MAX_DISCOUNT_MINOR_UNITS);
      expect(discount).toBeLessThanOrEqual((BigInt(dollars) * 100n) / 10n);
    }
  });

  it("rounds DOWN to the cent, never up", () => {
    // $19.99 -> $1.99, not $2.00. A discount is money leaving the business,
    // and rounding a cap upward is how "maximum $100" becomes $100.01.
    expect(computeFallbackDiscount(usd(1_999n)).amountMinorUnits).toBe(199n);
    expect(computeFallbackDiscount(usd(9n)).amountMinorUnits).toBe(0n);
    expect(computeFallbackDiscount(usd(19n)).amountMinorUnits).toBe(1n);
  });

  it("is zero for a zero subtotal, and refuses a negative one", () => {
    expect(computeFallbackDiscount(usd(0n)).amountMinorUnits).toBe(0n);
    expect(() => computeFallbackDiscount(usd(-100n))).toThrow(/negative/i);
  });

  it("refuses a currency the benefit is not denominated in", () => {
    // Silently discounting 10% of a CAD subtotal as though it were USD would
    // give away a different amount than the policy states.
    expect(() => computeFallbackDiscount(Money.fromMinorUnits(50_000n, "CAD"))).toThrow(/USD/);
  });

  it("uses integer minor units throughout", () => {
    expect(typeof computeFallbackDiscount(usd(12_345n)).amountMinorUnits).toBe("bigint");
    expect(BEAT_QUOTE_FALLBACK_PERCENT).toBe(10);
    expect(BEAT_QUOTE_FALLBACK_MAX_DISCOUNT_MINOR_UNITS).toBe(10_000n);
  });
});

describe("90-day validity — amendment §3", () => {
  it("expires 90 days after issuance", () => {
    const issued = new Date("2026-10-09T15:00:00.000Z");
    expect(BEAT_QUOTE_FALLBACK_VALIDITY_DAYS).toBe(90);
    expect(fallbackExpiresAt(issued).toISOString()).toBe("2027-01-07T15:00:00.000Z");
  });

  it("spans a year boundary and a leap day correctly", () => {
    // 2028 is a leap year, so a 90-day window crossing 29 February must still
    // be 90×24h and not 89 or 91.
    const issued = new Date("2027-12-15T00:00:00.000Z");
    expect(fallbackExpiresAt(issued).toISOString()).toBe("2028-03-14T00:00:00.000Z");
    const elapsed = fallbackExpiresAt(issued).getTime() - issued.getTime();
    expect(elapsed / 86_400_000).toBe(90);
  });
});

function redeemable(overrides: Partial<FallbackRedeemabilityInput> = {}): FallbackRedeemabilityInput {
  const issuedAt = new Date("2026-10-09T12:00:00.000Z");
  return {
    issuedAt,
    expiresAt: fallbackExpiresAt(issuedAt),
    redeemedAt: null,
    revokedAt: null,
    attemptingCustomerRef: "gid://shopify/Customer/1",
    issuedToCustomerRef: "gid://shopify/Customer/1",
    surface: "buy_now",
    otherPromotionApplied: false,
    stackingExpresslyAuthorized: false,
    now: new Date("2026-11-01T12:00:00.000Z"),
    ...overrides,
  };
}

describe("redemption — case 7: not after expiry, not twice, not transferred, not on Group Buy/Luxury Steals", () => {
  it("is redeemable on the happy path", () => {
    // Without this, every refusal below could pass against a function that
    // always refuses.
    expect(evaluateFallbackRedeemability(redeemable())).toEqual({ redeemable: true });
  });

  it("refuses after expiry, including AT the expiry instant", () => {
    const base = redeemable();
    expect(evaluateFallbackRedeemability({ ...base, now: base.expiresAt })).toEqual({
      redeemable: false,
      refusal: "expired",
    });
    expect(
      evaluateFallbackRedeemability({ ...base, now: new Date(base.expiresAt.getTime() + 1) }).redeemable
    ).toBe(false);
    // And still valid one millisecond before.
    expect(
      evaluateFallbackRedeemability({ ...base, now: new Date(base.expiresAt.getTime() - 1) })
    ).toEqual({ redeemable: true });
  });

  it("refuses a second use", () => {
    expect(
      evaluateFallbackRedeemability(redeemable({ redeemedAt: new Date("2026-10-20T00:00:00.000Z") }))
    ).toEqual({ redeemable: false, refusal: "already_redeemed" });
  });

  it("refuses a different customer — holding the code is not entitlement", () => {
    expect(
      evaluateFallbackRedeemability(redeemable({ attemptingCustomerRef: "gid://shopify/Customer/999" }))
    ).toEqual({ redeemable: false, refusal: "not_transferable" });
  });

  it.each<[BeatQuoteRedemptionSurface, boolean]>([
    ["buy_now", true],
    ["custom_jewelry", true],
    ["group_buy", false],
    ["luxury_steals", false],
  ])("surface %s eligible=%s", (surface, expected) => {
    expect(isFallbackEligibleSurface(surface)).toBe(expected);
    expect(evaluateFallbackRedeemability(redeemable({ surface })).redeemable).toBe(expected);
  });

  it("refuses stacking unless expressly authorized, and allows it when it is", () => {
    expect(
      evaluateFallbackRedeemability(redeemable({ otherPromotionApplied: true }))
    ).toEqual({ redeemable: false, refusal: "stacking_not_authorized" });
    expect(
      evaluateFallbackRedeemability(
        redeemable({ otherPromotionApplied: true, stackingExpresslyAuthorized: true })
      )
    ).toEqual({ redeemable: true });
  });

  it("refuses a revoked benefit", () => {
    expect(
      evaluateFallbackRedeemability(redeemable({ revokedAt: new Date("2026-10-15T00:00:00.000Z") }))
    ).toEqual({ redeemable: false, refusal: "revoked" });
  });
});

describe("the refusal reported is the most fundamental one", () => {
  it("an expired benefit on an ineligible surface reports expired, not the surface", () => {
    // Telling a customer "wrong cart" about a dead code sends them to try
    // another cart with a code that will never work anywhere.
    const base = redeemable({ surface: "group_buy" });
    const result = evaluateFallbackRedeemability({ ...base, now: new Date("2027-06-01T00:00:00.000Z") });
    expect(result).toEqual({ redeemable: false, refusal: "expired" });
  });

  it("a revoked benefit reports revoked even when also spent and expired", () => {
    const base = redeemable({
      revokedAt: new Date("2026-10-15T00:00:00.000Z"),
      redeemedAt: new Date("2026-10-14T00:00:00.000Z"),
    });
    const result = evaluateFallbackRedeemability({ ...base, now: new Date("2027-06-01T00:00:00.000Z") });
    expect(result).toEqual({ redeemable: false, refusal: "revoked" });
  });
});
