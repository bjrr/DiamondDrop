import { describe, expect, it } from "vitest";

import { buildBankCheckoutLineResultDto, buildBankCheckoutResultDto, type QuotedLineForResult } from "./checkoutResponseDto";

/**
 * THE RESPONSE FENCE — same discipline as ruling R10's
 * `~/domain/cart/proxyResponseDto.test.ts`. Asserts on the SERIALISED JSON
 * STRING, never an intermediate object, so a later edit that widens the
 * TYPE to include a forbidden field is caught even if this fixture happens
 * to leave it `undefined` (`JSON.stringify` drops `undefined`, but not a
 * present field of any other value).
 */

const FORBIDDEN_SUBSTRINGS = [
  "priceCalculationId",
  "masterVariantId",
  "appliedUpliftRate",
  "appliedTierLabel",
  "pricingProfile",
  "landedCost",
  "landed_cost",
  "cost",
  "margin",
  "supplier",
  "breakdown",
  // Criteria 97-99: the shipping address is sent to Shopify and never
  // persisted OR echoed back by this app — this DTO must never carry it.
  "shippingAddress",
  "address1",
  "address2",
  "provinceCode",
  "countryCode",
  "firstName",
  "lastName",
  "phone",
  "zip",
] as const;

function assertNoForbiddenFields(body: unknown): void {
  const json = JSON.stringify(body);
  for (const term of FORBIDDEN_SUBSTRINGS) {
    expect(json.toLowerCase(), `response JSON must never contain "${term}"`).not.toContain(term.toLowerCase());
  }
}

function line(overrides: Partial<QuotedLineForResult> = {}): QuotedLineForResult {
  return {
    shopifyVariantGid: "gid://shopify/ProductVariant/123",
    quantity: 2,
    quotedBankPaymentPriceMinorUnits: 100_000n,
    quotedRegularCardPriceMinorUnits: 104_000n,
    currency: "USD",
    eligibleAtQuoteTime: true,
    ...overrides,
  };
}

describe("R10-style fence — the Bank Payment Checkout result DTO never leaks internal pricing metadata or the address", () => {
  it("a normal result contains none of the forbidden fields", () => {
    const dto = buildBankCheckoutResultDto({
      bankPaymentOrderId: "order-1",
      draftOrderGid: "gid://shopify/DraftOrder/1",
      invoiceUrl: "https://example.myshopify.com/invoice/1",
      quotedAt: new Date("2026-09-21T00:00:00.000Z"),
      guaranteeExpiresAt: new Date("2026-09-22T00:00:00.000Z"),
      lines: [line(), line({ shopifyVariantGid: "gid://shopify/ProductVariant/456", eligibleAtQuoteTime: false })],
    });

    assertNoForbiddenFields(dto);
  });

  it("an ineligible line also carries no forbidden field", () => {
    const dto = buildBankCheckoutLineResultDto(line({ eligibleAtQuoteTime: false }));
    assertNoForbiddenFields(dto);
  });

  it("every bigint crosses to JSON as a decimal STRING, never a bigint or a lossy number", () => {
    const dto = buildBankCheckoutLineResultDto(
      line({
        quotedBankPaymentPriceMinorUnits: 123_456_789_012_345n,
        quotedRegularCardPriceMinorUnits: 123_456_789_012_350n,
      })
    );

    expect(dto.quotedBankPaymentPriceMinorUnits).toBe("123456789012345");
    expect(dto.quotedRegularCardPriceMinorUnits).toBe("123456789012350");
    expect(typeof dto.quotedBankPaymentPriceMinorUnits).toBe("string");
  });

  it("dates are serialised as ISO-8601 strings, not Date objects", () => {
    const dto = buildBankCheckoutResultDto({
      bankPaymentOrderId: "order-1",
      draftOrderGid: "gid://shopify/DraftOrder/1",
      invoiceUrl: null,
      quotedAt: new Date("2026-09-21T12:34:56.000Z"),
      guaranteeExpiresAt: new Date("2026-09-22T12:34:56.000Z"),
      lines: [line()],
    });

    expect(dto.quotedAt).toBe("2026-09-21T12:34:56.000Z");
    expect(dto.guaranteeExpiresAt).toBe("2026-09-22T12:34:56.000Z");
  });

  it("shopifyVariantId is populated from shopifyVariantGid, and the line's own quantity/currency/eligibility are preserved", () => {
    const dto = buildBankCheckoutLineResultDto(
      line({ shopifyVariantGid: "gid://shopify/ProductVariant/999", quantity: 7, currency: "USD", eligibleAtQuoteTime: false })
    );

    expect(dto).toEqual({
      shopifyVariantId: "gid://shopify/ProductVariant/999",
      quantity: 7,
      quotedBankPaymentPriceMinorUnits: "100000",
      quotedRegularCardPriceMinorUnits: "104000",
      currency: "USD",
      eligibleAtQuoteTime: false,
    });
  });

  it("a null invoiceUrl is preserved as null, not dropped or coerced", () => {
    const dto = buildBankCheckoutResultDto({
      bankPaymentOrderId: "order-1",
      draftOrderGid: "gid://shopify/DraftOrder/1",
      invoiceUrl: null,
      quotedAt: new Date("2026-09-21T00:00:00.000Z"),
      guaranteeExpiresAt: new Date("2026-09-22T00:00:00.000Z"),
      lines: [line()],
    });

    expect(dto.invoiceUrl).toBeNull();
    expect(JSON.stringify(dto)).toContain('"invoiceUrl":null');
  });
});

describe("guard the guard — the fence actually detects a real leak", () => {
  it("fails if a forbidden field were present", () => {
    const leaking = { ...line(), priceCalculationId: "calc-1" };
    expect(() => assertNoForbiddenFields(leaking)).toThrow();
  });
});
