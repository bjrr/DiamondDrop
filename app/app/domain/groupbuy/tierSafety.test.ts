import { describe, expect, it } from "vitest";

import { MoneyDecimal } from "~/domain/money/decimal";

import { evaluateTierSafety, type TierSafetyVariantInput } from "./tierSafety";
import type { TierDefinition } from "./tiers";

/**
 * Pre-publication tier safety — README: "Before publication, validate every
 * allowed variant against configured minimum gross-margin percentage, minimum
 * dollar profit, and any variant-specific floor. Unsafe tiers must be blocked
 * or require an explicit authorized override."
 */

const TIERS: TierDefinition[] = [
  { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
  { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.900000" },
  { tierNumber: 3, minQualifyingUnits: 25, priceMultiplier: "0.800000" },
];

const PROFILE = {
  minGrossMarginRate: "0.200000",
  minDollarProfit: { amountMinorUnits: "10000", currency: "USD" },
};

function variant(overrides: Partial<TierSafetyVariantInput> = {}): TierSafetyVariantInput {
  return {
    masterVariantId: "v1",
    frozenBaseBankPaymentMinorUnits: 100_000n, // $1,000
    landedCostMinorUnits: new MoneyDecimal("50000"), // $500
    ...overrides,
  };
}

function run(variants: TierSafetyVariantInput[], tiers = TIERS) {
  return evaluateTierSafety({
    variants,
    tiers,
    profile: PROFILE,
    roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
    priceEndingRuleId: "WHOLE_DOLLAR_UP_V1",
    regularCardPriceRuleId: "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1",
    fixedCardUpliftRate: "0.050000",
    currency: "USD",
  });
}

describe("coverage", () => {
  it("evaluates EVERY variant against EVERY tier", () => {
    const report = run([variant({ masterVariantId: "a" }), variant({ masterVariantId: "b" })]);
    expect(report.results).toHaveLength(6); // 2 variants x 3 tiers
  });

  it("passes a campaign with comfortable margins at every tier", () => {
    const report = run([variant()]);
    expect(report.allSafe).toBe(true);
    expect(report.unsafe).toHaveLength(0);
  });
});

describe("floor breaches", () => {
  it("catches a deep tier that falls under the margin floor", () => {
    // Cost $850 against a $1,000 base: tier 3 at 80% is $800, below cost.
    const report = run([variant({ landedCostMinorUnits: new MoneyDecimal("85000") })]);

    expect(report.allSafe).toBe(false);
    const tier3 = report.unsafe.find((r) => r.tierNumber === 3);
    expect(tier3).toBeDefined();
    expect(tier3!.evaluation.failing).toContain("min_gross_margin");
  });

  it("catches an INTERMEDIATE tier via a variant floor, not just the deepest", () => {
    // The reason this checks every tier rather than only the last one. A
    // variant floor of $950 is cleared at tier 1 ($1,000) and breached at
    // tier 2 ($900) — so the FIRST unsafe tier is the middle one, and a
    // check that looked only at tier 3 would still have reported it, but a
    // check that assumed "only the deepest tier can fail" would mis-attribute
    // where the campaign actually stops being publishable.
    const report = run([
      variant({ variantFloorMinorUnits: new MoneyDecimal("95000") }),
    ]);

    const byTier = Object.fromEntries(report.results.map((r) => [r.tierNumber, r.safe]));
    expect(byTier[1]).toBe(true);
    expect(byTier[2]).toBe(false);
    expect(byTier[3]).toBe(false);

    const tier2 = report.unsafe.find((r) => r.tierNumber === 2)!;
    expect(tier2.evaluation.failing).toContain("variant_floor");
  });

  it("catches one unsafe variant among several safe ones", () => {
    const report = run([
      variant({ masterVariantId: "cheap-to-make" }),
      variant({ masterVariantId: "expensive", landedCostMinorUnits: new MoneyDecimal("85000") }),
    ]);

    expect(report.allSafe).toBe(false);
    expect(report.unsafe.every((r) => r.masterVariantId === "expensive")).toBe(true);
  });

  it("catches the minimum-dollar-profit floor independently of margin", () => {
    // A low-value item can clear 20% margin while never reaching $100 of
    // profit. Checking margin alone would pass it.
    const report = run([
      variant({
        frozenBaseBankPaymentMinorUnits: 20_000n, // $200
        landedCostMinorUnits: new MoneyDecimal("14000"), // $140
      }),
    ]);

    const tier3 = report.results.find((r) => r.tierNumber === 3)!;
    expect(tier3.evaluation.failing).toContain("min_dollar_profit");
  });
});

describe("it validates the price a customer would actually pay", () => {
  it("applies the rounding and price-ending rules before checking floors", () => {
    // $1,000 x 0.90 = $900 exactly; with whole-dollar-up the price is $900.
    // Checking an unrounded value would answer a question about a price nobody
    // is charged.
    const report = run([variant()]);
    const tier2 = report.results.find((r) => r.tierNumber === 2)!;

    expect(tier2.groupBuyBankPaymentPriceMinorUnits).toBe(90_000n);
    expect(tier2.groupBuyBankPaymentPriceMinorUnits % 100n).toBe(0n);
  });

  it("rounds a fractional tier price up to a whole dollar", () => {
    // 33333 x 0.80 = 26666.4 -> $267.00 under WHOLE_DOLLAR_UP_V1.
    const report = run([
      variant({ frozenBaseBankPaymentMinorUnits: 33_333n, landedCostMinorUnits: new MoneyDecimal("1000") }),
    ]);
    const tier3 = report.results.find((r) => r.tierNumber === 3)!;
    expect(tier3.groupBuyBankPaymentPriceMinorUnits).toBe(26_700n);
  });
});

describe("it reports rather than decides", () => {
  it("returns the breaches without throwing", () => {
    // Whether an unsafe tier is blocked or proceeds under an authorized
    // override is a publication decision; burying it in arithmetic would put
    // it out of reach of the person making it.
    expect(() => run([variant({ landedCostMinorUnits: new MoneyDecimal("99000") })])).not.toThrow();
  });

  it("gives the margin and contribution for each tier, so a human can judge", () => {
    const report = run([variant()]);
    for (const result of report.results) {
      expect(result.evaluation.bankPaymentGrossMarginRate).toMatch(/^-?[0-9.]+$/);
      expect(result.evaluation.bankPaymentContributionMinorUnits).toMatch(/^-?[0-9.]+$/);
    }
  });
});

describe("the 40% markup / 20% floor arithmetic, on the Bank Payment Price (owner-locked 2026-09-18)", () => {
  /**
   * The correction, asserted rather than described.
   *
   * These are the owner's actual rules — a 40% markup on cost, a 20% gross
   * margin floor and a $100 minimum profit — applied to a cost round enough
   * that the arithmetic can be checked by hand.
   */
  const COST = 100_000n; // $1,000
  const BANK_BASE = 140_000n; // $1,400 = cost x 1.40
  const OWNER_PROFILE = {
    minGrossMarginRate: "0.200000",
    minDollarProfit: { amountMinorUnits: "10000", currency: "USD" }, // $100
  };

  function ownerRun(tiers: TierDefinition[]) {
    return evaluateTierSafety({
      variants: [
        {
          masterVariantId: "v1",
          frozenBaseBankPaymentMinorUnits: BANK_BASE,
          landedCostMinorUnits: new MoneyDecimal(COST.toString()),
        },
      ],
      tiers,
      profile: OWNER_PROFILE,
      roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
      priceEndingRuleId: "WHOLE_DOLLAR_UP_V1",
      regularCardPriceRuleId: "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1",
      fixedCardUpliftRate: "0.050000",
      currency: "USD",
    });
  }

  it("PUBLISHES a 10% second tier — the case the old rule wrongly refused", () => {
    // bank tier price = 1400 x 0.90 = 1260
    // margin          = (1260 − 1000) / 1260 = 20.63%  -> clears the 20% floor
    // profit          = 260                            -> clears the $100 floor
    //
    // Deducting 2.9% + $0.30 of payment processing measured this at 17.8% and
    // blocked publication. That was the gate being wrong, not the tier.
    const report = ownerRun([
      { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
      { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.900000" },
    ]);

    expect(report.allSafe).toBe(true);
    expect(report.unsafe).toHaveLength(0);

    const tier2 = report.results.find((r) => r.tierNumber === 2)!;
    expect(tier2.groupBuyBankPaymentPriceMinorUnits).toBe(126_000n);
    expect(tier2.evaluation.bankPaymentGrossMarginRate.startsWith("0.2063")).toBe(true);
  });

  it("still REFUSES a tier that genuinely breaches the 20% floor", () => {
    // The rule was made less strict, not toothless. At 0.88 the margin is
    // (1232 − 1000) / 1232 = 18.83%, which is a real breach on this basis
    // and must still block.
    const report = ownerRun([
      { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
      { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.880000" },
    ]);

    expect(report.allSafe).toBe(false);
    const tier2 = report.unsafe.find((r) => r.tierNumber === 2)!;
    expect(tier2.evaluation.failing).toContain("min_gross_margin");
    expect(tier2.evaluation.bankPaymentGrossMarginRate.startsWith("0.1883")).toBe(true);
  });

  it("puts the deepest publishable discount near 1 / ((1 + markup) x (1 − floor))", () => {
    // The continuous answer is 1 / (1.40 x 0.80) = 0.892857..., i.e. roughly an
    // 10.7% discount — which is why a round 10% fits and 12% does not.
    //
    // THE ACTUAL BOUNDARY SITS SLIGHTLY LOWER, because WHOLE_DOLLAR_UP rounds
    // the tier price up before the floor sees it. At 0.8928 the exact price is
    // $1,249.92, which rounds to $1,250.00 and clears 20% exactly — so the
    // continuous formula would have called that a breach and been wrong.
    //
    // Asserted at the discrete boundary rather than the algebraic one. The
    // formula is the estimate; the rounding is what a campaign is judged on.
    const safeAt = (multiplier: string) =>
      ownerRun([
        { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
        { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: multiplier },
      ]).allSafe;

    // 1400 x 0.8922 = 1249.08 -> $1,250.00 -> (1250−1000)/1250 = 20.00% exactly.
    expect(safeAt("0.892200")).toBe(true);
    // 1400 x 0.8921 = 1248.94 -> $1,249.00 -> 19.94%, a genuine breach.
    expect(safeAt("0.892100")).toBe(false);
    // And the algebraic estimate is inside the safe region, as it must be.
    expect(safeAt("0.892857")).toBe(true);
  });

  it("lets the $100 profit floor bind before the margin floor on a light piece", () => {
    // Margin is scale-free; the dollar floor is not. On a $300 bank base a 10%
    // tier still makes 20.6% but only $55.71 — so the two floors disagree, and
    // checking margin alone would publish it.
    const report = evaluateTierSafety({
      variants: [
        {
          masterVariantId: "light",
          frozenBaseBankPaymentMinorUnits: 30_000n, // $300 = cost x 1.40
          landedCostMinorUnits: new MoneyDecimal("21429"), // ~$214.29
        },
      ],
      tiers: [
        { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
        { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.900000" },
      ],
      profile: OWNER_PROFILE,
      roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
      priceEndingRuleId: "WHOLE_DOLLAR_UP_V1",
      regularCardPriceRuleId: "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1",
      fixedCardUpliftRate: "0.050000",
      currency: "USD",
    });

    const tier2 = report.results.find((r) => r.tierNumber === 2)!;
    expect(tier2.evaluation.failing).toContain("min_dollar_profit");
    expect(tier2.evaluation.failing).not.toContain("min_gross_margin");
  });
});

describe("the credit-card uplift plays no part in tier safety", () => {
  it("judges the BANK PAYMENT price, which is below what the shopper is shown", () => {
    // If the uplift ever leaked into this check it would inflate every margin
    // by roughly five points and pass tiers that sell below the floor. The
    // clearest assertion is the number: safety is measured on 1400 x 0.90, not
    // on the 1470 x 0.90 a card customer pays.
    const report = evaluateTierSafety({
      variants: [
        {
          masterVariantId: "v1",
          frozenBaseBankPaymentMinorUnits: 140_000n,
          landedCostMinorUnits: new MoneyDecimal("100000"),
        },
      ],
      tiers: [
        { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
        { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.900000" },
      ],
      profile: {
        minGrossMarginRate: "0.200000",
        minDollarProfit: { amountMinorUnits: "10000", currency: "USD" },
      },
      roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
      priceEndingRuleId: "WHOLE_DOLLAR_UP_V1",
      regularCardPriceRuleId: "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1",
      fixedCardUpliftRate: "0.050000",
      currency: "USD",
    });

    const tier2 = report.results.find((r) => r.tierNumber === 2)!;
    expect(tier2.groupBuyBankPaymentPriceMinorUnits).toBe(126_000n);
    expect(tier2.groupBuyBankPaymentPriceMinorUnits).not.toBe(132_300n); // the card price
  });
});

describe("the price ladder must fall STRICTLY on BOTH prices", () => {
  /**
   * Owner decision, 2026-09-19: "A newly unlocked tier must produce a real
   * decrease in the primary customer-facing Regular/Card Price."
   *
   * Both prices, strictly, for every variant and every adjacent pair. The rule
   * was `<=` on the card price for a day; a tie is now rejected outright rather
   * than merely left undisplayed, because reaching a threshold and seeing the
   * advertised price not move is a promise the campaign made and did not keep.
   *
   * Validated on the ACTUAL RESULTING PRICES, never inferred from a minimum
   * percentage gap between multipliers. A gap would be both too strict — it
   * would reject wide tiers that are fine — and too loose, since whether a
   * narrow tier survives the $5 ceiling depends on where the variant's price
   * happens to sit.
   */
  const ladder = (
    frozenBaseBankPaymentMinorUnits: bigint,
    multipliers: readonly string[],
    landedCost = "1000"
  ) =>
    evaluateTierSafety({
      variants: [
        {
          masterVariantId: "v1",
          frozenBaseBankPaymentMinorUnits,
          landedCostMinorUnits: new MoneyDecimal(landedCost),
        },
      ],
      tiers: multipliers.map((priceMultiplier, index) => ({
        tierNumber: index + 1,
        minQualifyingUnits: index === 0 ? 1 : index * 10,
        priceMultiplier,
      })),
      profile: {
        minGrossMarginRate: "0.000000",
        minDollarProfit: { amountMinorUnits: "0", currency: "USD" },
      },
      roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
      priceEndingRuleId: "WHOLE_DOLLAR_UP_V1",
      regularCardPriceRuleId: "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1",
      fixedCardUpliftRate: "0.050000",
      currency: "USD",
    });

  // ---------------------------------------------------------------------
  // The three cases the owner named, in their words.
  // ---------------------------------------------------------------------

  it("VALID — bank lower AND card lower", () => {
    // $2,000 -> $2,080 card; $1,800 -> x1.04 = $1,872 -> ceil $5 = $1,875.
    // Both fall, so the tier delivers a real decrease to both kinds of customer.
    const report = ladder(200_000n, ["1.000000", "0.900000"]);

    expect(report.results[0]!.groupBuyBankPaymentPriceMinorUnits).toBe(200_000n);
    expect(report.results[0]!.groupBuyRegularCardPriceMinorUnits).toBe(208_000n);
    expect(report.results[1]!.groupBuyBankPaymentPriceMinorUnits).toBe(180_000n);
    expect(report.results[1]!.groupBuyRegularCardPriceMinorUnits).toBe(187_500n);

    expect(report.priceLadderProblems).toHaveLength(0);
    expect(report.allSafe).toBe(true);
  });

  it("INVALID — bank lower, card EQUAL because of the $5 rounding", () => {
    // $2,000.00 -> $2,080.00 card. $1,999.00 -> x1.04 = $2,078.96 -> ceil $5 =
    // $2,080.00. The bank price fell by a dollar and the advertised price did
    // not move at all: the ceiling absorbed the whole tier.
    const report = ladder(200_000n, ["1.000000", "0.999500"]);

    expect(report.results[0]!.groupBuyRegularCardPriceMinorUnits).toBe(208_000n);
    expect(report.results[1]!.groupBuyRegularCardPriceMinorUnits).toBe(208_000n);
    expect(report.results[1]!.groupBuyBankPaymentPriceMinorUnits).toBeLessThan(
      report.results[0]!.groupBuyBankPaymentPriceMinorUnits
    );

    expect(report.allSafe).toBe(false);
    const problem = report.priceLadderProblems.find((p) => p.basis === "regular_card")!;
    expect(problem).toBeDefined();
    expect(problem.priorRegularCardPriceMinorUnits).toBe(problem.regularCardPriceMinorUnits);
    expect(problem.detail).toMatch(/\$5 rounding absorbed this tier entirely/);
  });

  it("INVALID — bank lower, card HIGHER from a Bank/Card boundary crossing", () => {
    // $1,000.00 bank -> 4.0% -> $1,040.00 card
    //   $999.00 bank -> 4.5% -> $1,043.955 -> ceil $5 -> $1,045.00
    // One dollar cheaper to a bank customer, five dollars DEARER to a card one.
    const report = ladder(100_000n, ["1.000000", "0.999000"]);

    expect(report.allSafe).toBe(false);
    const problem = report.priceLadderProblems.find((p) => p.basis === "regular_card")!;
    expect(problem.regularCardPriceMinorUnits).toBeGreaterThan(
      problem.priorRegularCardPriceMinorUnits
    );
    expect(problem.detail).toMatch(/crossed a Bank\/Card pricing threshold/);
  });

  // ---------------------------------------------------------------------

  it("reports variant, both tiers and ALL FOUR prices on every problem", () => {
    // The owner's reporting requirement, itemised. Both bank prices appear on a
    // CARD failure too: the card price is derived from them, so a boundary
    // crossing is only legible with the pair in view.
    const problem = ladder(100_000n, ["1.000000", "0.999000"]).priceLadderProblems.find(
      (p) => p.basis === "regular_card"
    )!;

    expect(problem.masterVariantId).toBe("v1");
    expect(problem.priorTierNumber).toBe(1);
    expect(problem.tierNumber).toBe(2);
    expect(problem.priorBankPaymentPriceMinorUnits).toBe(100_000n);
    expect(problem.bankPaymentPriceMinorUnits).toBe(99_900n);
    expect(problem.priorRegularCardPriceMinorUnits).toBe(104_000n);
    expect(problem.regularCardPriceMinorUnits).toBe(104_500n);

    // And all four are in the human-readable line, not only the structured fields.
    for (const money of ["$1000.00", "$999.00", "$1040.00", "$1045.00"]) {
      expect(problem.detail, `detail must quote ${money}`).toContain(money);
    }
    expect(problem.detail).toContain("v1");
    expect(problem.detail).toContain("tier 1 -> tier 2");
  });

  it("distinguishes a TIE from a RISE, because the fixes differ", () => {
    // A tie wants a deeper multiplier; a rise may want the tier moved to one
    // side of the band boundary. An operator told only "the card price did not
    // fall" would have to work out which.
    const tie = ladder(200_000n, ["1.000000", "0.999500"]).priceLadderProblems.find(
      (p) => p.basis === "regular_card"
    )!;
    const rise = ladder(100_000n, ["1.000000", "0.999000"]).priceLadderProblems.find(
      (p) => p.basis === "regular_card"
    )!;

    expect(tie.detail).toMatch(/does not fall/);
    expect(tie.detail).not.toMatch(/RISES/);
    expect(rise.detail).toMatch(/RISES/);
  });

  it("BLOCKS a bank price that fails to fall at all", () => {
    // $500.00 x 0.9999 = $499.95, which whole-dollar-UP returns to $500.00.
    // Rounding can collapse a shallow tier to nothing without anyone
    // configuring two identical ones.
    const report = ladder(50_000n, ["1.000000", "0.999900"]);

    const bank = report.priceLadderProblems.filter((p) => p.basis === "bank_payment");
    expect(bank).toHaveLength(1);
    expect(bank[0]!.priorBankPaymentPriceMinorUnits).toBe(50_000n);
    expect(bank[0]!.bankPaymentPriceMinorUnits).toBe(50_000n);
    expect(bank[0]!.detail).toMatch(/Bank Payment Price does not fall/);
  });

  it("passes the ordinary campaign shapes untouched", () => {
    // The check must not become an obstacle to normal configuration.
    for (const multipliers of [
      ["1.000000", "0.900000"],
      ["1.000000", "0.950000", "0.900000"],
      ["1.000000", "0.930000", "0.880000", "0.850000"],
    ]) {
      const report = ladder(238_700n, multipliers);
      expect(report.priceLadderProblems, multipliers.join("/")).toHaveLength(0);
    }
  });

  it("checks EVERY variant, not just the first", () => {
    // Two variants share one tier set, and which boundary a tier crosses
    // depends on each variant's own frozen base. A campaign can be sound for
    // one piece and broken for another.
    const report = evaluateTierSafety({
      variants: [
        {
          // $10,000 base. A 0.1% tier is $10 here, twice the $5 increment, so
          // the card price genuinely moves: $10,300 -> $10,290, both in the 3%
          // band. Chosen deliberately — on a $2,387 base the same multiplier is
          // worth $2.39, the ceiling swallows it, and the STRICT rule rejects
          // it. Whether a shallow tier survives depends on the variant's price,
          // which is the whole reason this is checked per variant.
          masterVariantId: "safe-variant",
          frozenBaseBankPaymentMinorUnits: 1_000_000n,
          landedCostMinorUnits: new MoneyDecimal("1000"),
        },
        {
          masterVariantId: "crosses-a-threshold",
          frozenBaseBankPaymentMinorUnits: 100_000n,
          landedCostMinorUnits: new MoneyDecimal("1000"),
        },
      ],
      tiers: [
        { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
        { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.999000" },
      ],
      profile: {
        minGrossMarginRate: "0.000000",
        minDollarProfit: { amountMinorUnits: "0", currency: "USD" },
      },
      roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
      priceEndingRuleId: "WHOLE_DOLLAR_UP_V1",
      regularCardPriceRuleId: "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1",
      fixedCardUpliftRate: "0.050000",
      currency: "USD",
    });

    const variants = new Set(report.priceLadderProblems.map((p) => p.masterVariantId));
    expect(variants.has("crosses-a-threshold")).toBe(true);
    expect(variants.has("safe-variant")).toBe(false);
  });

  it("is INDEPENDENT of the floors — a ladder fault with every floor cleared", () => {
    // The two gates answer different questions and must not be conflated: this
    // campaign is comfortably profitable at both tiers and still unpublishable.
    const report = ladder(100_000n, ["1.000000", "0.999000"], "1000");

    expect(report.results.every((r) => r.evaluation.satisfied)).toBe(true);
    expect(report.unsafe).toHaveLength(0);
    expect(report.allSafe).toBe(false);
  });

  it("derives the ladder under the rule it is GIVEN, not a hardcoded one", () => {
    // Under the superseded fixed rule the same tiers are fine, because a single
    // rate with a whole-dollar ceiling IS monotonic. The check must follow the
    // rule the campaign will freeze rather than assume today's.
    const legacy = evaluateTierSafety({
      variants: [
        {
          masterVariantId: "v1",
          frozenBaseBankPaymentMinorUnits: 100_000n,
          landedCostMinorUnits: new MoneyDecimal("1000"),
        },
      ],
      tiers: [
        { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
        { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.999000" },
      ],
      profile: {
        minGrossMarginRate: "0.000000",
        minDollarProfit: { amountMinorUnits: "0", currency: "USD" },
      },
      roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
      priceEndingRuleId: "WHOLE_DOLLAR_UP_V1",
      regularCardPriceRuleId: "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1",
      fixedCardUpliftRate: "0.050000",
      currency: "USD",
    });

    expect(legacy.priceLadderProblems).toHaveLength(0);
    expect(legacy.allSafe).toBe(true);
  });

  it("uses NO minimum percentage gap between multipliers", () => {
    // Explicitly not the rule the owner rejected. A 0.2% tier is fine on a base
    // where it clears the ceiling, and a 0.2% tier is rejected on a base where
    // it does not — the difference is the resulting price, not the multiplier.
    const wideBase = ladder(1_000_000n, ["1.000000", "0.998000"]); // $10,000 -> $9,980
    const narrowBase = ladder(20_000n, ["1.000000", "0.998000"]); //    $200 -> $200

    expect(wideBase.priceLadderProblems).toHaveLength(0);
    expect(narrowBase.priceLadderProblems.length).toBeGreaterThan(0);
  });
});
