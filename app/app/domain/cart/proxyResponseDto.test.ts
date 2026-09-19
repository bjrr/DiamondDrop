import { describe, expect, it } from "vitest";

import { priceCart } from "./pricing";
import { buildCartProxyResponseDto, buildUnpurchasableLineDto } from "./proxyResponseDto";
import type { PricedCart } from "./types";
import type { CartLineMerchandiseInput } from "./types";

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
      []
    );

    assertNoForbiddenFields(dto);
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
      [{ lineId: "B", shopifyVariantId: "gid://shopify/ProductVariant/2", quantity: 1n, reason: "unknown_variant" }]
    );

    assertNoForbiddenFields(dto);
    expect(dto.lines).toHaveLength(2);
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
        []
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

    const dto = buildCartProxyResponseDto(contaminatedCart, new Map([["A", "gid://shopify/ProductVariant/1"]]), []);

    assertNoForbiddenFields(dto);
    // And structurally: the built line has exactly the allowlisted keys, no more.
    expect(Object.keys(dto.lines[0]!).sort()).toEqual(
      [
        "activeUnitPriceMinorUnits",
        "bankPaymentDiscountEligible",
        "lineActiveTotalMinorUnits",
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
    expect(() => buildCartProxyResponseDto(priced, new Map(), [])).toThrow();
  });
});
