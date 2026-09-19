import { describe, expect, it } from "vitest";

import { MoneyDecimal } from "~/domain/money/decimal";
import { deriveRegularCardPrice } from "~/domain/pricing/regularCardPrice";
import type { RegularCardPriceRuleId } from "~/domain/pricing/types";

import { CartCurrencyMismatchError, InvalidCartLineQuantityError, priceCart, priceCartLine } from "./pricing";
import type { CartLineMerchandiseInput } from "./types";

/**
 * docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md §5, §6, §18, §19, and
 * docs/specs/SLICE-2B-CART-SURFACE-INVENTORY.md L1.
 *
 * THIS IS THE REAL PRODUCTION MODULE, not a local model. Unlike
 * `~/domain/pricing/perLineTiering.test.ts` (which pins the rule with a
 * throwaway LOCAL aggregation function because no cart code existed yet),
 * this file exercises `priceCart`/`priceCartLine` from `./pricing.ts`
 * directly — the same functions the App Proxy route calls.
 *
 * `deriveRegularCardPrice` is used ONLY inside this test file, to build
 * realistic already-tiered fixture unit prices exactly the way
 * `getPublishedVariantPrice` would have produced them upstream. `priceCart`
 * itself never imports it — see the header comment in ./types.ts.
 */

const TIERED: RegularCardPriceRuleId = "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1";
const UNUSED_RATE = new MoneyDecimal("0.050000");
const USD = "USD";

function fixtureLine(
  overrides: Partial<CartLineMerchandiseInput> & {
    lineId: string;
    unitBankPaymentPriceMinorUnits: bigint;
    quantity?: bigint;
  }
): CartLineMerchandiseInput {
  const derived = deriveRegularCardPrice(overrides.unitBankPaymentPriceMinorUnits, UNUSED_RATE, TIERED);
  return {
    lineId: overrides.lineId,
    masterVariantId: overrides.masterVariantId ?? `mv-${overrides.lineId}`,
    quantity: overrides.quantity ?? 1n,
    currency: overrides.currency ?? USD,
    bankPaymentDiscountEligible: overrides.bankPaymentDiscountEligible ?? true,
    unitBankPaymentPriceMinorUnits: derived.bankPaymentPriceMinorUnits,
    unitRegularCardPriceMinorUnits: derived.regularCardPriceMinorUnits,
  };
}

describe("owner §5 — per-line tiering carried through unchanged, never re-tiered from a combined subtotal", () => {
  it("a $400 line keeps its 5.0%-tier card price and a $700 line keeps its 4.5%-tier card price in the same cart", () => {
    const cart = priceCart({
      mode: "card",
      currency: USD,
      lines: [
        fixtureLine({ lineId: "A", unitBankPaymentPriceMinorUnits: 40_000n }),
        fixtureLine({ lineId: "B", unitBankPaymentPriceMinorUnits: 70_000n }),
      ],
    });

    expect(cart.lines[0]!.unitRegularCardPriceMinorUnits).toBe(42_000n); // $420.00
    expect(cart.lines[1]!.unitRegularCardPriceMinorUnits).toBe(73_500n); // $735.00
    // Correct combined total: $420 + $735 = $1,155.00 — NOT the $1,145.00 a
    // naive re-tier-from-$1,100-subtotal approach would produce (pinned in
    // perLineTiering.test.ts).
    expect(cart.cardMerchandiseTotalMinorUnits).toBe(115_500n);
  });

  it("three $400 lines cross $1,000 combined, but each stays at the 5.0% tier", () => {
    const cart = priceCart({
      mode: "card",
      currency: USD,
      lines: [
        fixtureLine({ lineId: "A", unitBankPaymentPriceMinorUnits: 40_000n }),
        fixtureLine({ lineId: "B", unitBankPaymentPriceMinorUnits: 40_000n }),
        fixtureLine({ lineId: "C", unitBankPaymentPriceMinorUnits: 40_000n }),
      ],
    });

    expect(cart.bankMerchandiseTotalMinorUnits).toBe(120_000n); // $1,200 combined bank basis
    for (const line of cart.lines) {
      expect(line.unitRegularCardPriceMinorUnits).toBe(42_000n);
    }
    expect(cart.cardMerchandiseTotalMinorUnits).toBe(126_000n); // 3 x $420.00
  });

  it("qty 3 of a $400 item is three units at the 5.0% tier, not one $1,200 line re-tiered at 4.0%", () => {
    const cart = priceCart({
      mode: "card",
      currency: USD,
      lines: [fixtureLine({ lineId: "A", unitBankPaymentPriceMinorUnits: 40_000n, quantity: 3n })],
    });
    const line = cart.lines[0]!;

    expect(line.unitRegularCardPriceMinorUnits).toBe(42_000n); // per-unit, unchanged by quantity
    expect(line.lineCardBasisTotalMinorUnits).toBe(126_000n); // 3 x $420.00 = $1,260.00

    // The mistake this guards against: tiering the quantity-extended $1,200
    // value directly lands in the 4.0% band and produces $1,250.00 instead.
    const wrongly = deriveRegularCardPrice(120_000n, UNUSED_RATE, TIERED).regularCardPriceMinorUnits;
    expect(wrongly).toBe(125_000n);
    expect(line.lineCardBasisTotalMinorUnits).not.toBe(wrongly);
  });

  it("cart totals do not depend on line order", () => {
    const lines = [
      fixtureLine({ lineId: "A", unitBankPaymentPriceMinorUnits: 40_000n }),
      fixtureLine({ lineId: "B", unitBankPaymentPriceMinorUnits: 70_000n, quantity: 2n }),
      fixtureLine({ lineId: "C", unitBankPaymentPriceMinorUnits: 499_999n }),
    ];
    const forward = priceCart({ mode: "bank", currency: USD, lines });
    const reversed = priceCart({ mode: "bank", currency: USD, lines: [...lines].reverse() });

    expect(reversed.cardMerchandiseTotalMinorUnits).toBe(forward.cardMerchandiseTotalMinorUnits);
    expect(reversed.bankMerchandiseTotalMinorUnits).toBe(forward.bankMerchandiseTotalMinorUnits);
    expect(reversed.bankPaymentSavingsMinorUnits).toBe(forward.bankPaymentSavingsMinorUnits);
  });
});

describe("owner §19 — cart payment mode determines the active unit/line price", () => {
  const lines = [
    fixtureLine({ lineId: "A", unitBankPaymentPriceMinorUnits: 40_000n }),
    fixtureLine({ lineId: "B", unitBankPaymentPriceMinorUnits: 70_000n, quantity: 2n }),
  ];

  it("Card mode charges the Regular/Card Price on every eligible line", () => {
    const cart = priceCart({ mode: "card", currency: USD, lines });
    for (const line of cart.lines) {
      expect(line.activeUnitPriceMinorUnits).toBe(line.unitRegularCardPriceMinorUnits);
    }
    expect(cart.activeMerchandiseTotalMinorUnits).toBe(cart.cardMerchandiseTotalMinorUnits);
  });

  it("Bank mode charges the Bank Payment Price on every eligible line", () => {
    const cart = priceCart({ mode: "bank", currency: USD, lines });
    for (const line of cart.lines) {
      expect(line.activeUnitPriceMinorUnits).toBe(line.unitBankPaymentPriceMinorUnits);
    }
    expect(cart.activeMerchandiseTotalMinorUnits).toBe(cart.bankMerchandiseTotalMinorUnits);
  });

  it("switching Card -> Bank -> Card repeatedly on the same inputs never compounds or drifts", () => {
    const card1 = priceCart({ mode: "card", currency: USD, lines });
    const bank = priceCart({ mode: "bank", currency: USD, lines });
    const card2 = priceCart({ mode: "card", currency: USD, lines });

    expect(card2.activeMerchandiseTotalMinorUnits).toBe(card1.activeMerchandiseTotalMinorUnits);
    expect(bank.activeMerchandiseTotalMinorUnits).not.toBe(card1.activeMerchandiseTotalMinorUnits);
    // Neither mode's derivation mutates the shared fixture inputs.
    expect(lines[0]!.unitBankPaymentPriceMinorUnits).toBe(deriveRegularCardPrice(40_000n, UNUSED_RATE, TIERED).bankPaymentPriceMinorUnits);
  });
});

describe("owner §18 — Bank Payment Discount eligibility is per line, not per cart", () => {
  it("an ineligible line stays at Regular/Card Price even while the cart mode is Bank", () => {
    const eligible = fixtureLine({ lineId: "eligible", unitBankPaymentPriceMinorUnits: 40_000n });
    const ineligible = fixtureLine({
      lineId: "ineligible",
      unitBankPaymentPriceMinorUnits: 70_000n,
      bankPaymentDiscountEligible: false,
    });

    const cart = priceCart({ mode: "bank", currency: USD, lines: [eligible, ineligible] });
    const eligibleLine = cart.lines.find((l) => l.lineId === "eligible")!;
    const ineligibleLine = cart.lines.find((l) => l.lineId === "ineligible")!;

    expect(eligibleLine.activeUnitPriceMinorUnits).toBe(eligibleLine.unitBankPaymentPriceMinorUnits);
    expect(ineligibleLine.activeUnitPriceMinorUnits).toBe(ineligibleLine.unitRegularCardPriceMinorUnits);
    expect(ineligibleLine.activeUnitPriceMinorUnits).not.toBe(ineligibleLine.unitBankPaymentPriceMinorUnits);
  });

  it("an ineligible line does not prevent the rest of the cart from pricing in Bank mode", () => {
    const eligible = fixtureLine({ lineId: "eligible", unitBankPaymentPriceMinorUnits: 40_000n });
    const ineligible = fixtureLine({
      lineId: "ineligible",
      unitBankPaymentPriceMinorUnits: 70_000n,
      bankPaymentDiscountEligible: false,
    });
    const cart = priceCart({ mode: "bank", currency: USD, lines: [eligible, ineligible] });
    expect(cart.lines).toHaveLength(2);
  });

  it("bankPaymentDiscountEligible defaulting ON is the caller's contract, not this module's — an ineligible flag is honored exactly as supplied", () => {
    const line = fixtureLine({
      lineId: "off",
      unitBankPaymentPriceMinorUnits: 40_000n,
      bankPaymentDiscountEligible: false,
    });
    const priced = priceCartLine("bank", line);
    expect(priced.lineBankBasisTotalMinorUnits).toBe(priced.lineCardBasisTotalMinorUnits);
  });
});

describe("owner §6 — Bank Payment savings are merchandise-only and eligible-lines-only", () => {
  it("savings equal the sum of only the eligible lines' card-minus-bank differences", () => {
    const eligibleA = fixtureLine({ lineId: "A", unitBankPaymentPriceMinorUnits: 40_000n }); // $420 - $400 = $20 saving
    const eligibleB = fixtureLine({ lineId: "B", unitBankPaymentPriceMinorUnits: 70_000n }); // $735 - $700 = $35 saving
    const ineligible = fixtureLine({
      lineId: "C",
      unitBankPaymentPriceMinorUnits: 100_000n,
      bankPaymentDiscountEligible: false,
    });

    const cart = priceCart({ mode: "bank", currency: USD, lines: [eligibleA, eligibleB, ineligible] });

    expect(cart.bankPaymentSavingsMinorUnits).toBe(2_000n + 3_500n);
  });

  it("savings are unaffected by non-merchandise charges, because this module never receives them", () => {
    const lines = [
      fixtureLine({ lineId: "A", unitBankPaymentPriceMinorUnits: 40_000n }),
      fixtureLine({ lineId: "B", unitBankPaymentPriceMinorUnits: 70_000n }),
    ];
    const cart = priceCart({ mode: "bank", currency: USD, lines });
    // There is no tax/shipping/insurance/duties field anywhere on
    // CartLineMerchandiseInput or PricedCart — the type system itself
    // forecloses the leak, this assertion just pins the expected figure.
    expect(cart.bankPaymentSavingsMinorUnits).toBe(5_500n);
  });

  it("savings are zero when every line is ineligible", () => {
    const lines = [
      fixtureLine({ lineId: "A", unitBankPaymentPriceMinorUnits: 40_000n, bankPaymentDiscountEligible: false }),
      fixtureLine({ lineId: "B", unitBankPaymentPriceMinorUnits: 70_000n, bankPaymentDiscountEligible: false }),
    ];
    const cart = priceCart({ mode: "bank", currency: USD, lines });
    expect(cart.bankPaymentSavingsMinorUnits).toBe(0n);
    expect(cart.activeMerchandiseTotalMinorUnits).toBe(cart.cardMerchandiseTotalMinorUnits);
  });
});

describe("owner §3 'Cart' + §18 — per-line Bank Payment saving", () => {
  it("an eligible line's saving is its Regular/Card line total minus its Bank Payment line total, quantity already applied", () => {
    const line = fixtureLine({ lineId: "A", unitBankPaymentPriceMinorUnits: 40_000n, quantity: 3n }); // $420/unit card, $400/unit bank
    const priced = priceCartLine("bank", line);

    expect(priced.lineCardBasisTotalMinorUnits).toBe(126_000n); // 3 x $420.00
    expect(priced.lineBankBasisTotalMinorUnits).toBe(120_000n); // 3 x $400.00
    expect(priced.lineBankPaymentSavingsMinorUnits).toBe(6_000n); // 3 x $20.00 saving
  });

  it("an ineligible line's saving is exactly zero, not null or absent", () => {
    const line = fixtureLine({
      lineId: "A",
      unitBankPaymentPriceMinorUnits: 70_000n,
      quantity: 2n,
      bankPaymentDiscountEligible: false,
    });
    const priced = priceCartLine("bank", line);

    expect(priced.lineBankPaymentSavingsMinorUnits).toBe(0n);
    expect(priced.lineBankPaymentSavingsMinorUnits).not.toBeNull();
    expect(priced.lineBankPaymentSavingsMinorUnits).not.toBeUndefined();
  });

  it("the per-line saving does not depend on the cart's active mode — it is a basis comparison, not the active price", () => {
    const line = fixtureLine({ lineId: "A", unitBankPaymentPriceMinorUnits: 40_000n });
    const inCard = priceCartLine("card", line);
    const inBank = priceCartLine("bank", line);

    expect(inCard.lineBankPaymentSavingsMinorUnits).toBe(inBank.lineBankPaymentSavingsMinorUnits);
  });

  it("the cart-level bankPaymentSavingsMinorUnits equals the sum of the per-line savings, mixed eligibility and quantities", () => {
    const lines = [
      fixtureLine({ lineId: "A", unitBankPaymentPriceMinorUnits: 40_000n, quantity: 3n }),
      fixtureLine({ lineId: "B", unitBankPaymentPriceMinorUnits: 70_000n, quantity: 2n }),
      fixtureLine({
        lineId: "C",
        unitBankPaymentPriceMinorUnits: 100_000n,
        quantity: 4n,
        bankPaymentDiscountEligible: false,
      }),
    ];

    const cart = priceCart({ mode: "bank", currency: USD, lines });

    const summedPerLineSavings = cart.lines.reduce((sum, line) => sum + line.lineBankPaymentSavingsMinorUnits, 0n);
    expect(summedPerLineSavings).toBe(cart.bankPaymentSavingsMinorUnits);
    // And pinned to a concrete figure so a future change that breaks the
    // agreement above cannot compensate by drifting both sides together.
    expect(cart.bankPaymentSavingsMinorUnits).toBe(6_000n + 7_000n + 0n);
  });

  it("an empty cart's summed per-line savings is zero, agreeing with the cart-level figure", () => {
    const cart = priceCart({ mode: "bank", currency: USD, lines: [] });
    const summedPerLineSavings = cart.lines.reduce((sum, line) => sum + line.lineBankPaymentSavingsMinorUnits, 0n);
    expect(summedPerLineSavings).toBe(cart.bankPaymentSavingsMinorUnits);
    expect(summedPerLineSavings).toBe(0n);
  });
});

describe("tier boundaries in cart context (BANK-CARD-PRICING §3), co-occurring lines", () => {
  const BOUNDARY_PAIRS: ReadonlyArray<{
    label: string;
    under: { bank: bigint; card: bigint };
    atOrOver: { bank: bigint; card: bigint };
  }> = [
    { label: "$500", under: { bank: 49_999n, card: 52_500n }, atOrOver: { bank: 50_000n, card: 52_500n } },
    { label: "$1,000", under: { bank: 99_999n, card: 104_500n }, atOrOver: { bank: 100_000n, card: 104_000n } },
    { label: "$2,500", under: { bank: 249_999n, card: 260_000n }, atOrOver: { bank: 250_000n, card: 259_000n } },
    { label: "$5,000", under: { bank: 499_999n, card: 517_500n }, atOrOver: { bank: 500_000n, card: 515_000n } },
  ];

  for (const pair of BOUNDARY_PAIRS) {
    it(`${pair.label} boundary: co-occurring lines each keep their own tier and the cart total is the exact sum`, () => {
      const cart = priceCart({
        mode: "card",
        currency: USD,
        lines: [
          fixtureLine({ lineId: "under", unitBankPaymentPriceMinorUnits: pair.under.bank }),
          fixtureLine({ lineId: "atOrOver", unitBankPaymentPriceMinorUnits: pair.atOrOver.bank }),
        ],
      });

      expect(cart.lines[0]!.unitRegularCardPriceMinorUnits).toBe(pair.under.card);
      expect(cart.lines[1]!.unitRegularCardPriceMinorUnits).toBe(pair.atOrOver.card);
      expect(cart.cardMerchandiseTotalMinorUnits).toBe(pair.under.card + pair.atOrOver.card);
    });
  }
});

describe("input validation — hostile/malformed cart lines are rejected, not silently priced", () => {
  it("throws on zero quantity", () => {
    const line = fixtureLine({ lineId: "A", unitBankPaymentPriceMinorUnits: 40_000n, quantity: 0n });
    expect(() => priceCartLine("card", line)).toThrow(InvalidCartLineQuantityError);
  });

  it("throws on negative quantity", () => {
    const line = fixtureLine({ lineId: "A", unitBankPaymentPriceMinorUnits: 40_000n, quantity: -1n });
    expect(() => priceCartLine("card", line)).toThrow(InvalidCartLineQuantityError);
  });

  it("throws on a currency mismatch between the cart and a line", () => {
    const line = fixtureLine({ lineId: "A", unitBankPaymentPriceMinorUnits: 40_000n, currency: "EUR" });
    expect(() => priceCart({ mode: "card", currency: USD, lines: [line] })).toThrow(CartCurrencyMismatchError);
  });

  it("an empty cart prices to zero totals without error", () => {
    const cart = priceCart({ mode: "bank", currency: USD, lines: [] });
    expect(cart.lines).toHaveLength(0);
    expect(cart.cardMerchandiseTotalMinorUnits).toBe(0n);
    expect(cart.bankMerchandiseTotalMinorUnits).toBe(0n);
    expect(cart.bankPaymentSavingsMinorUnits).toBe(0n);
    expect(cart.activeMerchandiseTotalMinorUnits).toBe(0n);
  });
});
