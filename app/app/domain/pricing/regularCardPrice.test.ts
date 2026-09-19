import { describe, expect, it } from "vitest";

import { MoneyDecimal } from "~/domain/money/decimal";

import {
  BANK_TIERED_UPLIFT_TIERS_V1,
  deriveRegularCardPrice,
  getRegularCardPriceRule,
  selectCardUpliftTier,
  UnknownRegularCardPriceRuleError,
} from "./regularCardPrice";
import type { RegularCardPriceRuleId } from "./types";

/**
 * docs/BANK-CARD-PRICING.md — Bank Payment Price vs Regular/Card Price.
 *
 * Money is in MINOR UNITS throughout, so $499.99 is 49_999n. Written that way
 * rather than with a helper because the tier boundaries ARE the subject of most
 * of these tests, and a helper that converted dollars would be one more place
 * an off-by-one-cent could hide.
 */

const TIERED: RegularCardPriceRuleId = "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1";
const FIXED: RegularCardPriceRuleId = "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1";
const UNUSED_RATE = new MoneyDecimal("0.050000");

const tiered = (bankMinorUnits: bigint) =>
  deriveRegularCardPrice(bankMinorUnits, UNUSED_RATE, TIERED);

describe("the tier table (policy §3)", () => {
  it("selects the rate from the BANK PAYMENT price at every documented band", () => {
    expect(selectCardUpliftTier(30_000n).rate).toBe("0.050000"); //     $300
    expect(selectCardUpliftTier(75_000n).rate).toBe("0.045000"); //     $750
    expect(selectCardUpliftTier(200_000n).rate).toBe("0.040000"); //  $2,000
    expect(selectCardUpliftTier(400_000n).rate).toBe("0.035000"); //  $4,000
    expect(selectCardUpliftTier(1_000_000n).rate).toBe("0.030000"); // $10,000
  });

  it("never drops below the 3% minimum", () => {
    // Policy §3 states the floor as a rule, so it is asserted as one rather
    // than inferred from the five rows happening to be above it today.
    for (const tier of BANK_TIERED_UPLIFT_TIERS_V1) {
      expect(
        new MoneyDecimal(tier.rate).greaterThanOrEqualTo("0.03"),
        `tier "${tier.label}" is ${tier.rate}`
      ).toBe(true);
    }
  });

  it("covers every price with no gap, including zero", () => {
    // A price that matched no row would have to fall back to something, and
    // every possible fallback is wrong: 0% loses the uplift silently.
    for (const minorUnits of [0n, 1n, 49_999n, 50_000n, 999_999_999n]) {
      expect(() => selectCardUpliftTier(minorUnits)).not.toThrow();
    }
  });
});

describe("tier boundaries are exact to the cent (policy §3)", () => {
  /**
   * The four documented boundaries, each tested one cent below and exactly at.
   *
   * Each row states the bank price, the rate that applies, and the final card
   * price after the $5 ceiling — all three, because a test that only checked
   * the rate would pass while the rounding was wrong, and one that only checked
   * the price could pass for the wrong reason at a boundary.
   */
  const CASES: ReadonlyArray<{
    label: string;
    bank: bigint;
    rate: string;
    card: bigint;
    savings: bigint;
  }> = [
    // $499.99 x 1.05 = $524.9895 -> $525.00
    { label: "$499.99", bank: 49_999n, rate: "0.050000", card: 52_500n, savings: 2_501n },
    // $500.00 x 1.045 = $522.50   -> $525.00
    { label: "$500.00", bank: 50_000n, rate: "0.045000", card: 52_500n, savings: 2_500n },
    // $999.99 x 1.045 = $1,044.98955 -> $1,045.00
    { label: "$999.99", bank: 99_999n, rate: "0.045000", card: 104_500n, savings: 4_501n },
    // $1,000.00 x 1.04 = $1,040.00 exactly, already a multiple of $5
    { label: "$1,000.00", bank: 100_000n, rate: "0.040000", card: 104_000n, savings: 4_000n },
    // $2,499.99 x 1.04 = $2,599.9896 -> $2,600.00
    { label: "$2,499.99", bank: 249_999n, rate: "0.040000", card: 260_000n, savings: 10_001n },
    // $2,500.00 x 1.035 = $2,587.50 -> $2,590.00
    { label: "$2,500.00", bank: 250_000n, rate: "0.035000", card: 259_000n, savings: 9_000n },
    // $4,999.99 x 1.035 = $5,174.98965 -> $5,175.00
    { label: "$4,999.99", bank: 499_999n, rate: "0.035000", card: 517_500n, savings: 17_501n },
    // $5,000.00 x 1.03 = $5,150.00 exactly, already a multiple of $5
    { label: "$5,000.00", bank: 500_000n, rate: "0.030000", card: 515_000n, savings: 15_000n },
  ];

  for (const c of CASES) {
    it(`${c.label} takes ${c.rate} and lands on ${c.card} minor units`, () => {
      const result = tiered(c.bank);
      expect(result.appliedUpliftRate).toBe(c.rate);
      expect(result.regularCardPriceMinorUnits).toBe(c.card);
      expect(result.bankPaymentSavingsMinorUnits).toBe(c.savings);
    });
  }

  it("selects the tier from the BANK price, never from the card price", () => {
    // Policy §3 and example C. A $990 item produces a $1,035 card price, which
    // sits in the 4.0% band — but the item stays at 4.5% because the tier is
    // chosen from $990. Reading the tier off the output would make the
    // calculation depend on its own result.
    const result = tiered(99_000n);
    expect(result.appliedUpliftRate).toBe("0.045000");
    expect(result.regularCardPriceMinorUnits).toBe(103_500n); // $1,035, in the 4% band
    expect(selectCardUpliftTier(103_500n).rate).toBe("0.040000"); // what it would wrongly have been
  });

  it("CARD PRICE FALLS AS BANK PRICE RISES ACROSS A BOUNDARY — pinned deliberately", () => {
    // A real consequence of the locked schedule, not a defect in this code.
    //
    //   $999.99 bank -> 4.5% -> $1,045.00 card
    //   $1,000.00 bank -> 4.0% -> $1,040.00 card
    //
    // One more cent of Bank Payment Price gives the customer a card price $5
    // LOWER. The same inversion exists at $2,500 ($2,600 -> $2,590) and $5,000
    // ($5,175 -> $5,150).
    //
    // Pinned by a test so that (a) nobody "fixes" it by quietly making the tier
    // depend on the card price, which policy §3 forbids, and (b) if the owner
    // later decides the schedule should be monotonic, this test names the
    // decision that has to change rather than failing mysteriously.
    expect(tiered(99_999n).regularCardPriceMinorUnits).toBeGreaterThan(
      tiered(100_000n).regularCardPriceMinorUnits
    );
    expect(tiered(249_999n).regularCardPriceMinorUnits).toBeGreaterThan(
      tiered(250_000n).regularCardPriceMinorUnits
    );
    expect(tiered(499_999n).regularCardPriceMinorUnits).toBeGreaterThan(
      tiered(500_000n).regularCardPriceMinorUnits
    );
  });
});

describe("the $5 ceiling (policy §4)", () => {
  it("leaves a card price that is already a multiple of $5 unchanged", () => {
    // Policy §4 states this explicitly, with $2,080 -> $2,080 not $2,085. A
    // ceiling implemented as "add then round down" would fail exactly here.
    for (const bank of [200_000n, 400_000n, 1_000_000n, 100_000n, 500_000n]) {
      const result = tiered(bank);
      const exact = new MoneyDecimal(bank.toString()).times(
        new MoneyDecimal(1).plus(result.appliedUpliftRate)
      );
      expect(exact.modulo(500).isZero(), `${bank} should land exactly on a $5 multiple`).toBe(true);
      expect(result.regularCardPriceMinorUnits).toBe(BigInt(exact.toString()));
    }
  });

  it("rounds UP to the next $5 when the preliminary price is not a multiple", () => {
    // $750 x 1.045 = $783.75 -> $785.00 (policy example B).
    expect(tiered(75_000n).regularCardPriceMinorUnits).toBe(78_500n);
    // $990 x 1.045 = $1,034.55 -> $1,035.00 (example C).
    expect(tiered(99_000n).regularCardPriceMinorUnits).toBe(103_500n);
  });

  it("always lands on a $5 multiple, and never overshoots by $5 or more", () => {
    // The two halves of "ceiling": on the grid, and minimally so. Checked
    // across a spread that crosses every tier boundary, because a ceiling that
    // added a full increment when already on the grid would pass the first
    // assertion and fail the second.
    for (let bank = 1_000n; bank <= 1_200_000n; bank += 7_777n) {
      const result = tiered(bank);
      const exact = new MoneyDecimal(bank.toString()).times(
        new MoneyDecimal(1).plus(result.appliedUpliftRate)
      );
      expect(result.regularCardPriceMinorUnits % 500n, `bank ${bank}`).toBe(0n);

      const overshoot = new MoneyDecimal(result.regularCardPriceMinorUnits.toString()).minus(exact);
      expect(overshoot.greaterThanOrEqualTo(0), `bank ${bank} rounded DOWN`).toBe(true);
      expect(overshoot.lessThan(500), `bank ${bank} overshot by a full $5`).toBe(true);
    }
  });

  it("matches the policy's own rounding examples", () => {
    // §4 lists preliminary -> final pairs. Reproduced through the real rule by
    // choosing bank prices whose preliminary price hits those values, so the
    // examples are exercised end to end rather than against a private helper.
    //
    // $4,141.01-ish: $4,001 x 1.035 = $4,141.035 -> $4,145.
    expect(tiered(400_100n).regularCardPriceMinorUnits).toBe(414_500n);
    // $2,081.20-ish: $2,001 x 1.04 = $2,081.04 -> $2,085.
    expect(tiered(200_100n).regularCardPriceMinorUnits).toBe(208_500n);
  });
});

describe("the Bank Payment Price is never modified (policy §2)", () => {
  it("returns the exact bigint it was given, across every tier", () => {
    // The single most important property in this file. The Bank Payment Price
    // is what every floor, freeze and refund is pinned to, so a "harmless"
    // rounding here would silently disagree with all of them.
    for (const bank of [1n, 49_999n, 50_000n, 99_999n, 100_000n, 249_999n, 500_000n, 9_999_999n]) {
      const result = tiered(bank);
      expect(result.bankPaymentPriceMinorUnits, `bank ${bank}`).toBe(bank);
    }
  });

  it("does not round a bank price that is not a whole dollar", () => {
    // $123.45 — deliberately not a whole dollar and not a $5 multiple. The card
    // price is ceilinged; the bank price is not touched.
    const result = tiered(12_345n);
    expect(result.bankPaymentPriceMinorUnits).toBe(12_345n);
    expect(result.regularCardPriceMinorUnits % 500n).toBe(0n);
  });
});

describe("savings are computed from the ROUNDED card price (policy §9)", () => {
  it("equals final card price minus bank payment price, exactly", () => {
    for (const bank of [30_000n, 75_000n, 99_000n, 200_000n, 400_000n, 1_000_000n]) {
      const result = tiered(bank);
      expect(result.bankPaymentSavingsMinorUnits).toBe(
        result.regularCardPriceMinorUnits - result.bankPaymentPriceMinorUnits
      );
    }
  });

  it("is NOT the percentage applied to the bank price", () => {
    // Policy §9: "Do not calculate the displayed savings from the percentage
    // alone." At $750 the rate gives $33.75 but the rounded card price gives
    // $35.00 — and $35 is the number a customer can verify by subtracting the
    // two prices they were shown.
    const result = tiered(75_000n);
    expect(result.bankPaymentSavingsMinorUnits).toBe(3_500n);

    const fromRate = new MoneyDecimal("75000").times("0.045");
    expect(fromRate.toString()).toBe("3375");
    expect(result.bankPaymentSavingsMinorUnits).not.toBe(3_375n);
  });

  it("reproduces every worked example in policy §5", () => {
    const EXAMPLES: ReadonlyArray<[bigint, bigint, bigint]> = [
      [30_000n, 31_500n, 1_500n], //      A: $300    -> $315,     save $15
      [75_000n, 78_500n, 3_500n], //      B: $750    -> $785,     save $35
      [99_000n, 103_500n, 4_500n], //     C: $990    -> $1,035,   save $45
      [200_000n, 208_000n, 8_000n], //    D: $2,000  -> $2,080,   save $80
      [400_000n, 414_000n, 14_000n], //   E: $4,000  -> $4,140,   save $140
      [1_000_000n, 1_030_000n, 30_000n], // F: $10,000 -> $10,300, save $300
    ];

    for (const [bank, card, savings] of EXAMPLES) {
      const result = tiered(bank);
      expect(result.regularCardPriceMinorUnits, `bank ${bank} card`).toBe(card);
      expect(result.bankPaymentSavingsMinorUnits, `bank ${bank} savings`).toBe(savings);
      expect(result.bankPaymentPriceMinorUnits, `bank ${bank} unchanged`).toBe(bank);
    }
  });
});

describe("the superseded fixed rule is frozen (policy §12)", () => {
  it("still applies one profile rate with a WHOLE-DOLLAR ceiling", () => {
    // Historical calculations must keep reproducing. $750 x 1.05 = $787.50,
    // ceilinged to a whole dollar = $788.00 — NOT the $790 a $5 ceiling would
    // give, and not the $785 the tiered rule gives.
    const legacy = deriveRegularCardPrice(75_000n, new MoneyDecimal("0.050000"), FIXED);
    expect(legacy.regularCardPriceMinorUnits).toBe(78_800n);
    expect(legacy.appliedUpliftRate).toBe("0.05");
  });

  it("reads the profile rate, where the tiered rule ignores it", () => {
    // The clearest statement of the difference between the two rules: feed both
    // an absurd configured rate and only one of them reacts.
    const absurd = new MoneyDecimal("0.500000");
    expect(deriveRegularCardPrice(100_000n, absurd, FIXED).regularCardPriceMinorUnits).toBe(
      150_000n
    );
    expect(deriveRegularCardPrice(100_000n, absurd, TIERED).regularCardPriceMinorUnits).toBe(
      104_000n
    );
  });

  it("leaves the bank payment price alone too", () => {
    const legacy = deriveRegularCardPrice(12_345n, new MoneyDecimal("0.050000"), FIXED);
    expect(legacy.bankPaymentPriceMinorUnits).toBe(12_345n);
  });
});

describe("the registry", () => {
  it("resolves both ids", () => {
    expect(getRegularCardPriceRule(TIERED).id).toBe(TIERED);
    expect(getRegularCardPriceRule(FIXED).id).toBe(FIXED);
  });

  it("refuses an unregistered id rather than defaulting to one", () => {
    // Defaulting would price an item under a rule nobody chose, and the stored
    // rule id would then be a lie about how the price was produced.
    expect(() =>
      getRegularCardPriceRule("NOT_A_RULE" as RegularCardPriceRuleId)
    ).toThrow(UnknownRegularCardPriceRuleError);
  });
});
