import { describe, expect, it } from "vitest";

import { priceCart } from "./pricing";
import { summarisePricedCart } from "./pricingSource";
import { buildCartProxyResponseDto, buildUnpurchasableLineDto } from "./proxyResponseDto";
import type { CartProxyPricedLineDto } from "./proxyResponseDto";
import type { PricedCart } from "./types";
import type { CartLineMerchandiseInput } from "./types";

/**
 * The summary for a fully priced cart.
 *
 * Every pre-existing case in this file describes a cart whose lines all
 * priced, so they all pass this. The cases that do NOT -- where a line failed
 * to resolve -- assert the null-totals guard explicitly further down, because
 * that is the behaviour worth stating rather than inheriting.
 */
const COMPLETE = summarisePricedCart(1, 0);

/**
 * THE RESPONSE FENCE — ruling R10
 * (docs/specs/SLICE-2B-CART-SURFACE-INVENTORY.md), Stage 2B task 2B-1.
 *
 * Asserts on the SERIALISED JSON STRING, never an intermediate object — per
 * the ruling, "the whole class of bug is a correct-looking object
 * serialising to something wider than intended." A test that only inspected
 * `dto.lines[0]` as a JS object could pass even if a later edit widened the
 * TYPE to include a forbidden field while this particular fixture happened
 * to leave it undefined; `JSON.stringify` + substring search catches that
 * too, because `undefined` values are dropped by JSON.stringify while a
 * PRESENT forbidden field of any other value is not.
 */

const FORBIDDEN_SUBSTRINGS = [
  "appliedUpliftRate",
  "appliedTierLabel",
  "priceCalculationId",
  "pricingProfile",
  "profileVersion",
  "engineVersion",
  "regularCardPriceRuleId",
  "roundingRuleId",
  "priceEndingRuleId",
  "marginModel",
  "landedCost",
  "landed_cost",
  "masterVariantId",
  "cost",
  "margin",
  "supplier",
  "breakdown",
  "fixedCardUpliftRate",
] as const;

function assertNoForbiddenFields(body: unknown): void {
  const json = JSON.stringify(body);
  for (const term of FORBIDDEN_SUBSTRINGS) {
    expect(json.toLowerCase(), `response JSON must never contain "${term}"`).not.toContain(term.toLowerCase());
  }
}

const USD = "USD";

function line(overrides: Partial<CartLineMerchandiseInput> & { lineId: string }): CartLineMerchandiseInput {
  return {
    masterVariantId: `mv-${overrides.lineId}`,
    quantity: 1n,
    currency: USD,
    bankPaymentDiscountEligible: true,
    unitBankPaymentPriceMinorUnits: 40_000n,
    unitRegularCardPriceMinorUnits: 42_000n,
    ...overrides,
  };
}

describe("R10 fence — the App Proxy response DTO never leaks internal pricing metadata", () => {
  it("a normal priced cart response contains none of the forbidden fields", () => {
    const priced = priceCart({
      mode: "bank",
      currency: USD,
      lines: [
        line({ lineId: "A" }),
        line({ lineId: "B", bankPaymentDiscountEligible: false, unitBankPaymentPriceMinorUnits: 70_000n, unitRegularCardPriceMinorUnits: 73_500n }),
      ],
    });

    const dto = buildCartProxyResponseDto(
      priced,
      new Map([
        ["A", "gid://shopify/ProductVariant/1"],
        ["B", "gid://shopify/ProductVariant/2"],
      ]),
      [],
      COMPLETE
    );

    assertNoForbiddenFields(dto);
  });

  it("a purchasable line's DTO carries the correct per-line Bank Payment saving as a string, zero for an ineligible line", () => {
    const priced = priceCart({
      mode: "bank",
      currency: USD,
      lines: [
        line({ lineId: "A" }), // eligible: $420 - $400 = $20 saving
        line({ lineId: "B", bankPaymentDiscountEligible: false, unitBankPaymentPriceMinorUnits: 70_000n, unitRegularCardPriceMinorUnits: 73_500n }),
      ],
    });
    const dto = buildCartProxyResponseDto(
      priced,
      new Map([
        ["A", "gid://shopify/ProductVariant/1"],
        ["B", "gid://shopify/ProductVariant/2"],
      ]),
      [],
      COMPLETE
    );

    const [lineA, lineB] = dto.lines as [CartProxyPricedLineDto, CartProxyPricedLineDto];
    expect(lineA.lineBankPaymentSavingsMinorUnits).toBe("2000");
    expect(lineB.lineBankPaymentSavingsMinorUnits).toBe("0");
  });

  it("a purchasable line's DTO carries per-line Card-basis and Bank-basis totals that reconcile with the saving and the cart totals", () => {
    const priced = priceCart({
      mode: "bank",
      currency: USD,
      lines: [
        // eligible, quantity 10: card basis $420 x 10 = $4200, bank basis $400 x 10 = $4000, saving $200
        line({ lineId: "A", quantity: 10n }),
        // ineligible, quantity 3: both bases equal, saving zero
        line({
          lineId: "B",
          quantity: 3n,
          bankPaymentDiscountEligible: false,
          unitBankPaymentPriceMinorUnits: 70_000n,
          unitRegularCardPriceMinorUnits: 73_500n,
        }),
      ],
    });
    const dto = buildCartProxyResponseDto(
      priced,
      new Map([
        ["A", "gid://shopify/ProductVariant/1"],
        ["B", "gid://shopify/ProductVariant/2"],
      ]),
      [],
      COMPLETE
    );
    const [lineA, lineB] = dto.lines as [CartProxyPricedLineDto, CartProxyPricedLineDto];

    // Property 1: card basis minus bank basis equals the saving, on the DTO as serialised, for quantity > 1.
    expect(
      BigInt(lineA.lineCardBasisTotalMinorUnits) - BigInt(lineA.lineBankBasisTotalMinorUnits)
    ).toBe(BigInt(lineA.lineBankPaymentSavingsMinorUnits));
    expect(lineA.lineCardBasisTotalMinorUnits).toBe("420000");
    expect(lineA.lineBankBasisTotalMinorUnits).toBe("400000");
    expect(lineA.lineBankPaymentSavingsMinorUnits).toBe("20000");

    // Property 2: an ineligible line's two basis totals are equal and its saving is "0".
    expect(lineB.lineCardBasisTotalMinorUnits).toBe(lineB.lineBankBasisTotalMinorUnits);
    expect(lineB.lineCardBasisTotalMinorUnits).toBe("220500");
    expect(lineB.lineBankPaymentSavingsMinorUnits).toBe("0");

    // Property 3: the per-line basis totals sum to the cart-level merchandise totals.
    const cardSum = dto.lines.reduce(
      (sum, l) => sum + BigInt((l as CartProxyPricedLineDto).lineCardBasisTotalMinorUnits),
      0n
    );
    const bankSum = dto.lines.reduce(
      (sum, l) => sum + BigInt((l as CartProxyPricedLineDto).lineBankBasisTotalMinorUnits),
      0n
    );
    // Non-null because this cart is fully priced. The totals are nullable
    // precisely so that an INCOMPLETE cart cannot state one; a complete cart
    // always does.
    expect(dto.totalsArePublishable).toBe(true);
    expect(cardSum).toBe(BigInt(dto.cardMerchandiseTotalMinorUnits as string));
    expect(bankSum).toBe(BigInt(dto.bankMerchandiseTotalMinorUnits as string));
  });

  it("an unpurchasable line's DTO never carries a price field", () => {
    const dto = buildUnpurchasableLineDto({
      lineId: "X",
      shopifyVariantId: "gid://shopify/ProductVariant/999",
      quantity: 2n,
      reason: "unsynced",
    });

    expect(dto).not.toHaveProperty("unitBankPaymentPriceMinorUnits");
    expect(dto).not.toHaveProperty("unitRegularCardPriceMinorUnits");
    expect(dto).not.toHaveProperty("activeUnitPriceMinorUnits");
    assertNoForbiddenFields(dto);
  });

  it("a mixed cart of purchasable and unpurchasable lines still has no forbidden fields anywhere in the serialised body", () => {
    const priced = priceCart({ mode: "card", currency: USD, lines: [line({ lineId: "A" })] });
    const dto = buildCartProxyResponseDto(
      priced,
      new Map([["A", "gid://shopify/ProductVariant/1"]]),
      [{ lineId: "B", shopifyVariantId: "gid://shopify/ProductVariant/2", quantity: 1n, reason: "unknown_variant" }],
      // Two lines requested, one of them unpriced. Describing this cart as
      // complete would be the exact falsehood the guard exists to stop.
      summarisePricedCart(2, 1)
    );

    assertNoForbiddenFields(dto);
    expect(dto.lines).toHaveLength(2);
  });

  describe("the $0.00 guard", () => {
    /**
     * THE DEFECT THIS CLOSES, STATED AS A TEST.
     *
     * A live cart held a $520 mounting and a $50 service. Neither resolved, so
     * the totals summed to zero and the storefront showed $0.00 on a $570
     * cart, with a Bank Payment button that silently did nothing. A zero
     * total is only ever correct for a cart that is genuinely empty.
     */
    it("never states a total for a cart with an unpriced line", () => {
      const priced = priceCart({ mode: "card", currency: USD, lines: [line({ lineId: "A" })] });
      const dto = buildCartProxyResponseDto(
        priced,
        new Map([["A", "gid://shopify/ProductVariant/1"]]),
        [{ lineId: "B", shopifyVariantId: "gid://shopify/ProductVariant/2", quantity: 1n, reason: "unknown_variant" }],
        summarisePricedCart(2, 1)
      );

      expect(dto.cardMerchandiseTotalMinorUnits).toBeNull();
      expect(dto.bankMerchandiseTotalMinorUnits).toBeNull();
      expect(dto.bankPaymentSavingsMinorUnits).toBeNull();
      expect(dto.activeMerchandiseTotalMinorUnits).toBeNull();
      expect(dto.totalsArePublishable).toBe(false);
    });

    it("emits no zero anywhere in the body for an incomplete cart", () => {
      // Not just the typed fields: the SERIALISED body must contain no
      // cart-level "0" for a client to pick up by ignoring the flag.
      const priced = priceCart({ mode: "bank", currency: USD, lines: [] });
      const dto = buildCartProxyResponseDto(
        priced,
        new Map(),
        [{ lineId: "B", shopifyVariantId: "gid://shopify/ProductVariant/2", quantity: 1n, reason: "unsynced" }],
        summarisePricedCart(1, 1)
      );
      const json = JSON.stringify(dto);
      expect(json).toContain('"cardMerchandiseTotalMinorUnits":null');
      expect(json).toContain('"bankMerchandiseTotalMinorUnits":null');
      expect(json).not.toContain('"cardMerchandiseTotalMinorUnits":"0"');
      expect(json).not.toContain('"activeMerchandiseTotalMinorUnits":"0"');
    });

    it("refuses Bank Payment for a cart it could not fully price", () => {
      const priced = priceCart({ mode: "bank", currency: USD, lines: [line({ lineId: "A" })] });
      const dto = buildCartProxyResponseDto(
        priced,
        new Map([["A", "gid://shopify/ProductVariant/1"]]),
        [{ lineId: "B", shopifyVariantId: "gid://shopify/ProductVariant/2", quantity: 1n, reason: "unverified_price" }],
        summarisePricedCart(2, 1)
      );
      expect(dto.bankPaymentAvailable).toBe(false);
    });

    it("still states zero for a genuinely empty cart", () => {
      // An empty cart IS fully priced, so its zero is a fact. Withholding it
      // here would make an ordinary empty cart look broken.
      const priced = priceCart({ mode: "card", currency: USD, lines: [] });
      const dto = buildCartProxyResponseDto(priced, new Map(), [], {
        totalsArePublishable: true,
        bankPaymentAvailable: true,
        unpurchasableLineCount: 0,
      });
      expect(dto.cardMerchandiseTotalMinorUnits).toBe("0");
      expect(dto.totalsArePublishable).toBe(true);
    });
  });

  it("both payment modes and boundary-tier prices produce a clean response", () => {
    for (const mode of ["card", "bank"] as const) {
      const priced = priceCart({
        mode,
        currency: USD,
        lines: [
          line({ lineId: "A", unitBankPaymentPriceMinorUnits: 499_999n, unitRegularCardPriceMinorUnits: 517_500n }),
          line({ lineId: "B", unitBankPaymentPriceMinorUnits: 500_000n, unitRegularCardPriceMinorUnits: 515_000n }),
        ],
      });
      const dto = buildCartProxyResponseDto(
        priced,
        new Map([
          ["A", "gid://shopify/ProductVariant/1"],
          ["B", "gid://shopify/ProductVariant/2"],
        ]),
        [],
        COMPLETE
      );
      assertNoForbiddenFields(dto);
    }
  });

  /**
   * THE ADVERSARIAL CASE. Simulates a future maintenance mistake one layer
   * upstream: a `PricedCart` whose lines carry EXTRA internal fields that do
   * not belong to the `PricedCartLine` type at all (as if someone had
   * spread a raw `PublishedVariantPrice` into cart construction). Because
   * `buildCartProxyResponseDto` copies fields BY NAME rather than spreading,
   * the extra fields must not survive into the response even though they
   * are genuinely present on the input object at runtime — proving the fence
   * holds on the object shape, not merely on today's TypeScript types.
   */
  it("extra fields smuggled onto a PricedCart input do not leak into the response, even though TypeScript would not catch this at the call site", () => {
    const contaminatedLine = {
      lineId: "A",
      masterVariantId: "mv-A",
      quantity: 1n,
      currency: USD,
      bankPaymentDiscountEligible: true,
      unitBankPaymentPriceMinorUnits: 40_000n,
      unitRegularCardPriceMinorUnits: 42_000n,
      activeUnitPriceMinorUnits: 40_000n,
      lineCardBasisTotalMinorUnits: 42_000n,
      lineBankBasisTotalMinorUnits: 40_000n,
      lineActiveTotalMinorUnits: 40_000n,
      lineBankPaymentSavingsMinorUnits: 2_000n,
      // The contamination:
      appliedUpliftRate: "0.050000",
      appliedTierLabel: "Under $500",
      priceCalculationId: "11111111-1111-1111-1111-111111111111",
      landedCostMinorUnits: "12345",
      supplierCostMinorUnits: "9999",
    };

    const contaminatedCart = {
      mode: "bank",
      currency: USD,
      lines: [contaminatedLine],
      cardMerchandiseTotalMinorUnits: 42_000n,
      bankMerchandiseTotalMinorUnits: 40_000n,
      bankPaymentSavingsMinorUnits: 2_000n,
      activeMerchandiseTotalMinorUnits: 40_000n,
    } as unknown as PricedCart;

    const dto = buildCartProxyResponseDto(contaminatedCart, new Map([["A", "gid://shopify/ProductVariant/1"]]), [], COMPLETE);

    assertNoForbiddenFields(dto);
    // And structurally: the built line has exactly the allowlisted keys, no more.
    expect(Object.keys(dto.lines[0]!).sort()).toEqual(
      [
        "activeUnitPriceMinorUnits",
        "bankPaymentDiscountEligible",
        "lineActiveTotalMinorUnits",
        "lineBankBasisTotalMinorUnits",
        "lineBankPaymentSavingsMinorUnits",
        "lineCardBasisTotalMinorUnits",
        "lineId",
        "purchasable",
        "quantity",
        "shopifyVariantId",
        "unitBankPaymentPriceMinorUnits",
        "unitRegularCardPriceMinorUnits",
      ].sort()
    );
  });

  it("throws rather than silently omitting a line when no shopifyVariantId was supplied for a priced line", () => {
    const priced = priceCart({ mode: "card", currency: USD, lines: [line({ lineId: "A" })] });
    expect(() => buildCartProxyResponseDto(priced, new Map(), [], COMPLETE)).toThrow();
  });
});
