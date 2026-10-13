import { describe, expect, it } from "vitest";

import { MoneyDecimal } from "~/domain/money/decimal";

import { deriveRegularCardPrice } from "./regularCardPrice";
import type { RegularCardPriceRuleId } from "./types";

/**
 * docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md §5 and §6, cross-referenced
 * against the locked tier table in docs/BANK-CARD-PRICING.md §3.
 *
 * PINS A RULE, NOT (YET) A PRODUCTION MODULE. No cart/order aggregation code
 * exists in this codebase as of Stage 2A — that lands in Stage 2B. `priceCartLine`
 * and `priceCart` below are a small LOCAL model of §5's aggregation rule, written
 * only to give these tests something to exercise. They are not exported, not
 * reused by any other file, and must not be mistaken for the real cart
 * implementation. `deriveRegularCardPrice` (this module's own production
 * function) remains the ONLY source of tier selection and $5-ceiling rounding —
 * the local model calls it once per line and does nothing more than multiply by
 * quantity and sum, which is exactly the boundary §5 draws.
 *
 * THE BUG THIS FILE GUARDS AGAINST IS SILENT. §5: "Bank/Card pricing is
 * determined per line item/configuration, not from the combined cart value."
 * A cart built the "obvious" way — sum the merchandise first, then price the
 * total — produces a plausible, cleanly-rounded dollar figure that is simply
 * the wrong price, with no exception, no type error and no failing sanity
 * check to catch it. Several tests below therefore compute BOTH the correct
 * per-line total and the naive combined-subtotal total side by side and assert
 * they differ, so the divergence itself — not just the correct answer — is
 * pinned. Whoever builds the Stage 2B cart has a failing test to satisfy here,
 * not a paragraph to interpret.
 */

const TIERED: RegularCardPriceRuleId = "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1";
// The tiered rule ignores configuredRate entirely (see regularCardPrice.ts);
// this value exists only to satisfy the function signature.
const UNUSED_RATE = new MoneyDecimal("0.050000");

interface CartLineInput {
  readonly label: string;
  /** The line's OWN unit Bank Payment Price — never a quantity-extended amount. */
  readonly unitBankPaymentPriceMinorUnits: bigint;
  readonly quantity: bigint;
}

interface CartLineResult {
  readonly label: string;
  readonly quantity: bigint;
  readonly unitBankPaymentPriceMinorUnits: bigint;
  readonly unitRegularCardPriceMinorUnits: bigint;
  readonly appliedUpliftRate: string;
  readonly appliedTierLabel: string;
  readonly lineBankPaymentTotalMinorUnits: bigint;
  readonly lineRegularCardTotalMinorUnits: bigint;
}

/**
 * §5, steps 1-3: derive the tier and the Regular/Card price from THIS line's
 * unit Bank Payment Price, then multiply by quantity. Quantity is applied
 * strictly AFTER derivation — it never participates in tier selection.
 */
function priceCartLine(line: CartLineInput): CartLineResult {
  const derived = deriveRegularCardPrice(line.unitBankPaymentPriceMinorUnits, UNUSED_RATE, TIERED);
  return {
    label: line.label,
    quantity: line.quantity,
    unitBankPaymentPriceMinorUnits: derived.bankPaymentPriceMinorUnits,
    unitRegularCardPriceMinorUnits: derived.regularCardPriceMinorUnits,
    appliedUpliftRate: derived.appliedUpliftRate,
    appliedTierLabel: derived.appliedTierLabel,
    lineBankPaymentTotalMinorUnits: derived.bankPaymentPriceMinorUnits * line.quantity,
    lineRegularCardTotalMinorUnits: derived.regularCardPriceMinorUnits * line.quantity,
  };
}

interface CartMerchandiseTotals {
  readonly lines: readonly CartLineResult[];
  readonly bankPaymentMerchandiseTotalMinorUnits: bigint;
  readonly regularCardMerchandiseTotalMinorUnits: bigint;
  readonly bankPaymentSavingsMinorUnits: bigint;
}

/** §5, "then": sum the already-priced lines. No re-tiering happens here. */
function priceCart(lines: readonly CartLineInput[]): CartMerchandiseTotals {
  const priced = lines.map(priceCartLine);
  const bankPaymentMerchandiseTotalMinorUnits = priced.reduce(
    (sum, l) => sum + l.lineBankPaymentTotalMinorUnits,
    0n
  );
  const regularCardMerchandiseTotalMinorUnits = priced.reduce(
    (sum, l) => sum + l.lineRegularCardTotalMinorUnits,
    0n
  );
  return {
    lines: priced,
    bankPaymentMerchandiseTotalMinorUnits,
    regularCardMerchandiseTotalMinorUnits,
    bankPaymentSavingsMinorUnits:
      regularCardMerchandiseTotalMinorUnits - bankPaymentMerchandiseTotalMinorUnits,
  };
}

/**
 * THE BUG, MODELED DELIBERATELY. What a cart built the "obvious" way would
 * do: sum the merchandise first, then run the combined subtotal through the
 * SAME derivation function once. Used only to prove the correct model produces
 * a different (and correct) number — never asserted as correct anywhere below.
 */
function priceCartByCombinedSubtotalWrongly(lines: readonly CartLineInput[]): bigint {
  const bankSubtotal = lines.reduce(
    (sum, l) => sum + l.unitBankPaymentPriceMinorUnits * l.quantity,
    0n
  );
  return deriveRegularCardPrice(bankSubtotal, UNUSED_RATE, TIERED).regularCardPriceMinorUnits;
}

describe("policy §5 — per-line tiering, never combined-cart tiering", () => {
  it("a $400 Bank Payment line resolves the 5.0% tier", () => {
    const line = priceCart([{ label: "A", unitBankPaymentPriceMinorUnits: 40_000n, quantity: 1n }])
      .lines[0]!;
    expect(line.appliedUpliftRate).toBe("0.050000");
    expect(line.unitRegularCardPriceMinorUnits).toBe(42_000n); // $420.00
  });

  it("a $700 Bank Payment line resolves the 4.5% tier", () => {
    const line = priceCart([{ label: "B", unitBankPaymentPriceMinorUnits: 70_000n, quantity: 1n }])
      .lines[0]!;
    expect(line.appliedUpliftRate).toBe("0.045000");
    expect(line.unitRegularCardPriceMinorUnits).toBe(73_500n); // $735.00
  });

  it("both lines in the same cart retain their own individual tiers", () => {
    const cart = priceCart([
      { label: "A", unitBankPaymentPriceMinorUnits: 40_000n, quantity: 1n },
      { label: "B", unitBankPaymentPriceMinorUnits: 70_000n, quantity: 1n },
    ]);
    const a = cart.lines[0]!;
    const b = cart.lines[1]!;
    expect(a.appliedUpliftRate).toBe("0.050000");
    expect(b.appliedUpliftRate).toBe("0.045000");
  });

  it("a combined $1,100 cart subtotal must NOT pull either line into the 4.0% tier", () => {
    const lines: CartLineInput[] = [
      { label: "A", unitBankPaymentPriceMinorUnits: 40_000n, quantity: 1n },
      { label: "B", unitBankPaymentPriceMinorUnits: 70_000n, quantity: 1n },
    ];
    const cart = priceCart(lines);

    // Bank subtotal is $1,100 — inside the $1,000-$2,499.99 / 4.0% band if (and
    // only if) someone wrongly re-tiers from the combined value.
    expect(cart.bankPaymentMerchandiseTotalMinorUnits).toBe(110_000n);
    for (const line of cart.lines) {
      expect(line.appliedUpliftRate, `${line.label} must not use the 4.0% tier`).not.toBe("0.040000");
    }

    // Correct: $420.00 + $735.00 = $1,155.00.
    expect(cart.regularCardMerchandiseTotalMinorUnits).toBe(115_500n);
    expect(cart.bankPaymentSavingsMinorUnits).toBe(5_500n);

    // The naive combined-subtotal approach gives a DIFFERENT, wrong number —
    // $1,100 x 1.04 = $1,144.00, ceil to next $5 = $1,145.00 — proving this is
    // a real divergence a buggy cart would produce silently, not a distinction
    // without a difference.
    const wrongly = priceCartByCombinedSubtotalWrongly(lines);
    expect(wrongly).toBe(114_500n);
    expect(cart.regularCardMerchandiseTotalMinorUnits).not.toBe(wrongly);
  });
});

describe("quantity multiplication must not re-tier the underlying unit price", () => {
  it("qty 3 of a $400 item is three units at the 5.0% tier, not one $1,200 line at 4.0%", () => {
    const line: CartLineInput = { label: "A", unitBankPaymentPriceMinorUnits: 40_000n, quantity: 3n };
    const priced = priceCart([line]).lines[0]!;

    expect(priced.appliedUpliftRate).toBe("0.050000");
    expect(priced.unitRegularCardPriceMinorUnits).toBe(42_000n); // $420.00 per unit
    expect(priced.lineBankPaymentTotalMinorUnits).toBe(120_000n); // $1,200.00
    // Correct: 3 x $420.00 = $1,260.00.
    expect(priced.lineRegularCardTotalMinorUnits).toBe(126_000n);

    // The mistake: tiering the quantity-extended $1,200 line value directly —
    // $1,200 sits in the 4.0% band, giving $1,200 x 1.04 = $1,248.00, ceil to
    // next $5 = $1,250.00. Different from, and less than, the correct $1,260.
    const wrongly = deriveRegularCardPrice(
      line.unitBankPaymentPriceMinorUnits * line.quantity,
      UNUSED_RATE,
      TIERED
    ).regularCardPriceMinorUnits;
    expect(wrongly).toBe(125_000n);
    expect(priced.lineRegularCardTotalMinorUnits).not.toBe(wrongly);
  });
});

describe("tier boundaries in cart context (BANK-CARD-PRICING §3)", () => {
  /**
   * Each pair puts one line just under a boundary and one line just at/over it,
   * in the SAME cart. If aggregation ever influenced tier selection, the
   * lower line would be dragged into the higher line's tier by co-occurring in
   * one cart. It must not be. Expected unit card prices/savings are the same
   * pinned values as regularCardPrice.test.ts's boundary table, exercised here
   * through cart aggregation rather than in isolation.
   */
  const BOUNDARY_PAIRS: ReadonlyArray<{
    label: string;
    under: { bank: bigint; rate: string; card: bigint };
    atOrOver: { bank: bigint; rate: string; card: bigint };
  }> = [
    {
      label: "$500 boundary",
      under: { bank: 49_999n, rate: "0.050000", card: 52_500n },
      atOrOver: { bank: 50_000n, rate: "0.045000", card: 52_500n },
    },
    {
      label: "$1,000 boundary",
      under: { bank: 99_999n, rate: "0.045000", card: 104_500n },
      atOrOver: { bank: 100_000n, rate: "0.040000", card: 104_000n },
    },
    {
      label: "$2,500 boundary",
      under: { bank: 249_999n, rate: "0.040000", card: 260_000n },
      atOrOver: { bank: 250_000n, rate: "0.035000", card: 259_000n },
    },
    {
      label: "$5,000 boundary",
      under: { bank: 499_999n, rate: "0.035000", card: 517_500n },
      atOrOver: { bank: 500_000n, rate: "0.030000", card: 515_000n },
    },
  ];

  for (const pair of BOUNDARY_PAIRS) {
    it(`${pair.label}: co-occurring lines each keep their own tier and the cart total is the exact sum`, () => {
      const cart = priceCart([
        { label: "under", unitBankPaymentPriceMinorUnits: pair.under.bank, quantity: 1n },
        { label: "atOrOver", unitBankPaymentPriceMinorUnits: pair.atOrOver.bank, quantity: 1n },
      ]);
      const under = cart.lines[0]!;
      const atOrOver = cart.lines[1]!;

      expect(under.appliedUpliftRate).toBe(pair.under.rate);
      expect(under.unitRegularCardPriceMinorUnits).toBe(pair.under.card);
      expect(atOrOver.appliedUpliftRate).toBe(pair.atOrOver.rate);
      expect(atOrOver.unitRegularCardPriceMinorUnits).toBe(pair.atOrOver.card);

      expect(cart.bankPaymentMerchandiseTotalMinorUnits).toBe(pair.under.bank + pair.atOrOver.bank);
      expect(cart.regularCardMerchandiseTotalMinorUnits).toBe(pair.under.card + pair.atOrOver.card);
      expect(cart.bankPaymentSavingsMinorUnits).toBe(
        pair.under.card + pair.atOrOver.card - (pair.under.bank + pair.atOrOver.bank)
      );
    });
  }
});

describe("a cart subtotal crossing a boundary that no individual line crosses must not re-tier", () => {
  it("three $400 lines cross $1,000 combined, but each stays at 5.0%", () => {
    const lines: CartLineInput[] = [
      { label: "A", unitBankPaymentPriceMinorUnits: 40_000n, quantity: 1n },
      { label: "B", unitBankPaymentPriceMinorUnits: 40_000n, quantity: 1n },
      { label: "C", unitBankPaymentPriceMinorUnits: 40_000n, quantity: 1n },
    ];
    const cart = priceCart(lines);

    expect(cart.bankPaymentMerchandiseTotalMinorUnits).toBe(120_000n); // $1,200 combined
    for (const line of cart.lines) {
      expect(line.appliedUpliftRate).toBe("0.050000");
    }
    expect(cart.regularCardMerchandiseTotalMinorUnits).toBe(126_000n); // 3 x $420.00
    expect(cart.bankPaymentSavingsMinorUnits).toBe(6_000n);

    const wrongly = priceCartByCombinedSubtotalWrongly(lines);
    expect(cart.regularCardMerchandiseTotalMinorUnits).not.toBe(wrongly);
  });

  it("eleven $499.99 lines cross both $2,500 and $5,000 combined, but each stays at 5.0%", () => {
    const lines: CartLineInput[] = Array.from({ length: 11 }, (_, i) => ({
      label: `line-${i}`,
      unitBankPaymentPriceMinorUnits: 49_999n,
      quantity: 1n,
    }));
    const cart = priceCart(lines);

    // $5,499.89 combined — past the $5,000 threshold that would apply 3.0% if
    // the cart wrongly re-tiered from the subtotal.
    expect(cart.bankPaymentMerchandiseTotalMinorUnits).toBe(549_989n);
    for (const line of cart.lines) {
      expect(line.appliedUpliftRate, line.label).toBe("0.050000");
      expect(line.unitRegularCardPriceMinorUnits, line.label).toBe(52_500n);
    }
    // 11 x $525.00 = $5,775.00.
    expect(cart.regularCardMerchandiseTotalMinorUnits).toBe(577_500n);
    expect(cart.bankPaymentSavingsMinorUnits).toBe(27_511n);

    // The naive combined-subtotal path lands in the 3.0% tier and produces a
    // materially different, wrong total.
    const wrongly = priceCartByCombinedSubtotalWrongly(lines);
    expect(wrongly).toBe(566_500n);
    expect(cart.regularCardMerchandiseTotalMinorUnits).not.toBe(wrongly);
  });
});

describe("cart totals do not depend on line order", () => {
  it("summing the same lines in a different order produces identical totals", () => {
    const lines: CartLineInput[] = [
      { label: "A", unitBankPaymentPriceMinorUnits: 40_000n, quantity: 1n },
      { label: "B", unitBankPaymentPriceMinorUnits: 70_000n, quantity: 2n },
      { label: "C", unitBankPaymentPriceMinorUnits: 499_999n, quantity: 1n },
    ];
    const forward = priceCart(lines);
    const reversed = priceCart([...lines].reverse());

    expect(reversed.bankPaymentMerchandiseTotalMinorUnits).toBe(
      forward.bankPaymentMerchandiseTotalMinorUnits
    );
    expect(reversed.regularCardMerchandiseTotalMinorUnits).toBe(
      forward.regularCardMerchandiseTotalMinorUnits
    );
    expect(reversed.bankPaymentSavingsMinorUnits).toBe(forward.bankPaymentSavingsMinorUnits);
  });
});

describe("policy §6 — Bank Payment savings are merchandise-only", () => {
  /**
   * Tax, shipping, separately charged insurance and duties are NOT part of the
   * merchandise total and must never enter the savings calculation, even when
   * they are charged on the same order. Modeled as a flat non-merchandise
   * charge added identically to both payment-basis grand totals, so any test
   * failure here would mean the charge leaked into `bankPaymentSavingsMinorUnits`
   * itself rather than merely appearing in a grand total.
   */
  const lines: CartLineInput[] = [
    { label: "A", unitBankPaymentPriceMinorUnits: 40_000n, quantity: 1n },
    { label: "B", unitBankPaymentPriceMinorUnits: 70_000n, quantity: 1n },
  ];

  it("savings are unchanged by the presence of tax, shipping, insurance and duties", () => {
    const cart = priceCart(lines);
    const withoutCharges = cart.bankPaymentSavingsMinorUnits;

    // Non-merchandise charges: tax + shipping + insurance + duties.
    const nonMerchandiseChargesMinorUnits = 1_234n + 1_500n + 900n + 300n;

    const cardGrandTotal = cart.regularCardMerchandiseTotalMinorUnits + nonMerchandiseChargesMinorUnits;
    const bankGrandTotal = cart.bankPaymentMerchandiseTotalMinorUnits + nonMerchandiseChargesMinorUnits;

    // The two grand totals differ by exactly the merchandise-only savings —
    // the non-merchandise charge is present in both and cancels out.
    expect(cardGrandTotal - bankGrandTotal).toBe(withoutCharges);
    // And the merchandise-only savings figure itself never changed.
    expect(cart.bankPaymentSavingsMinorUnits).toBe(withoutCharges);
    expect(cart.bankPaymentSavingsMinorUnits).toBe(5_500n);
  });
});
