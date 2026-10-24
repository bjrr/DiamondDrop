import { describe, expect, it } from "vitest";

import {
  buildBankCheckoutLineResultDto,
  buildBankCheckoutResponseDto,
  buildBankCheckoutResultDto,
  resolveFormattedAmountDue,
  type StoredBankCheckoutResult,
  type QuotedLineForResult,
} from "./checkoutResponseDto";

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
      quotedAt: new Date("2026-09-21T00:00:00.000Z"),
      guaranteeExpiresAt: new Date("2026-09-22T00:00:00.000Z"),
      formattedAmountDue: "2080.00 USD",
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
      quotedAt: new Date("2026-09-21T12:34:56.000Z"),
      guaranteeExpiresAt: new Date("2026-09-22T12:34:56.000Z"),
      formattedAmountDue: "2000.00 USD",
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

  it("the PERSISTED result carries formattedAmountDue, no invoiceUrl and no payment coordinate of any kind", () => {
    const dto = buildBankCheckoutResultDto({
      bankPaymentOrderId: "order-1",
      draftOrderGid: "gid://shopify/DraftOrder/1",
      quotedAt: new Date("2026-09-21T00:00:00.000Z"),
      guaranteeExpiresAt: new Date("2026-09-22T00:00:00.000Z"),
      formattedAmountDue: "2000.00 USD",
      lines: [line()],
    });

    expect(dto.formattedAmountDue).toBe("2000.00 USD");
    const json = JSON.stringify(dto);
    expect(json).not.toContain("invoiceUrl");
    expect(json).not.toContain("paymentInstructions");
    expect(json).not.toContain("zelle");
  });
});

const ZELLE = "test-pay@example.invalid";

function storedResult(): StoredBankCheckoutResult {
  return buildBankCheckoutResultDto({
    bankPaymentOrderId: "order-1",
    draftOrderGid: "gid://shopify/DraftOrder/1",
    quotedAt: new Date("2026-09-21T00:00:00.000Z"),
    guaranteeExpiresAt: new Date("2026-09-22T00:00:00.000Z"),
    formattedAmountDue: "2000.00 USD",
    lines: [line()],
  });
}

describe("buildBankCheckoutResponseDto — the customer-facing body, built per request and never persisted", () => {
  it("returns exactly the documented fields, with the Zelle recipient only under paymentInstructions", () => {
    const dto = buildBankCheckoutResponseDto(storedResult(), { zelleRecipient: ZELLE });
    expect(dto).not.toBeNull();
    expect(Object.keys(dto!).sort()).toEqual(
      [
        "bankPaymentOrderId",
        "draftOrderGid",
        "formattedAmountDue",
        "guaranteeExpiresAt",
        "lines",
        "paymentInstructions",
        "quotedAt",
      ].sort()
    );
    expect(dto!.paymentInstructions).toEqual({ zelleRecipient: ZELLE });
    expect(dto!.formattedAmountDue).toBe("2000.00 USD");
    assertNoForbiddenFields(dto);
  });

  it("contains no wire coordinate and no invoice URL", () => {
    const json = JSON.stringify(buildBankCheckoutResponseDto(storedResult(), { zelleRecipient: ZELLE }));
    for (const term of ["invoiceUrl", "routing", "accountNumber", "bankName", "accountName"]) {
      expect(json).not.toContain(term);
    }
  });

  it("the stored result itself is not mutated by building a response", () => {
    const stored = storedResult();
    const before = JSON.stringify(stored);
    buildBankCheckoutResponseDto(stored, { zelleRecipient: ZELLE });
    expect(JSON.stringify(stored)).toBe(before);
    expect(before).not.toContain(ZELLE);
  });
});

describe("replay of an OLD stored payload (pre-D12: has invoiceUrl, lacks formattedAmountDue)", () => {
  function oldPayload(lines: unknown): StoredBankCheckoutResult {
    return {
      bankPaymentOrderId: "order-old",
      draftOrderGid: "gid://shopify/DraftOrder/old",
      invoiceUrl: "https://example.myshopify.com/invoice/old",
      quotedAt: "2026-09-21T00:00:00.000Z",
      guaranteeExpiresAt: "2026-09-22T00:00:00.000Z",
      lines,
    } as unknown as StoredBankCheckoutResult;
  }

  const OLD_LINES = [
    // eligible: charged at the bank price -> 2 x 1000.00
    { shopifyVariantId: "v1", quantity: 2, quotedBankPaymentPriceMinorUnits: "100000", quotedRegularCardPriceMinorUnits: "104000", currency: "USD", eligibleAtQuoteTime: true },
    // ineligible: charged at the card price -> 1 x 2080.05
    { shopifyVariantId: "v2", quantity: 1, quotedBankPaymentPriceMinorUnits: "200000", quotedRegularCardPriceMinorUnits: "208005", currency: "USD", eligibleAtQuoteTime: false },
  ];

  it("does not crash and does not leak invoiceUrl", () => {
    const dto = buildBankCheckoutResponseDto(oldPayload(OLD_LINES), { zelleRecipient: ZELLE });
    expect(dto).not.toBeNull();
    expect(JSON.stringify(dto)).not.toContain("invoiceUrl");
    expect(JSON.stringify(dto)).not.toContain("example.myshopify.com/invoice");
  });

  it("recomputes the amount due from the stored lines using the CHARGED price (bank if eligible, card if not) in bigint", () => {
    const dto = buildBankCheckoutResponseDto(oldPayload(OLD_LINES), { zelleRecipient: ZELLE });
    expect(dto!.formattedAmountDue).toBe("4080.05 USD");
  });

  it("prefers a stored formattedAmountDue over recomputing", () => {
    expect(resolveFormattedAmountDue(storedResult())).toBe("2000.00 USD");
  });

  it("returns null (no half-built panel) when the lines are unusable", () => {
    expect(buildBankCheckoutResponseDto(oldPayload([]), { zelleRecipient: ZELLE })).toBeNull();
    expect(
      buildBankCheckoutResponseDto(
        oldPayload([{ ...OLD_LINES[0], quotedBankPaymentPriceMinorUnits: "not-a-number" }]),
        { zelleRecipient: ZELLE }
      )
    ).toBeNull();
    expect(
      buildBankCheckoutResponseDto(oldPayload([OLD_LINES[0], { ...OLD_LINES[1], currency: "EUR" }]), {
        zelleRecipient: ZELLE,
      })
    ).toBeNull();
  });
});

describe("guard the guard — the fence actually detects a real leak", () => {
  it("fails if a forbidden field were present", () => {
    const leaking = { ...line(), priceCalculationId: "calc-1" };
    expect(() => assertNoForbiddenFields(leaking)).toThrow();
  });
});
