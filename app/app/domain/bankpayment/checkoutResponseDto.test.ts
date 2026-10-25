import { describe, expect, it } from "vitest";

import {
  buildBankCheckoutLineResultDto,
  buildBankCheckoutResultDto,
  resolveFormattedAmountDue,
  toCustomerResponse,
  type BankCheckoutResultDto,
  type StoredBankCheckoutResult,
  type QuotedLineForResult,
} from "./checkoutResponseDto";
import { buildPaymentInstructionsView } from "./paymentInstructionsView";

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

  /**
   * REGISTER D15. This test is the inverse of the one it replaced.
   *
   * The old test asserted that a null `invoiceUrl` survived serialisation —
   * it was guarding the field's presence. The field is gone: Shopify's
   * draft-order invoice exposes a **Confirm order** action, and handing it
   * to the customer let them advance a draft that must stay staff-controlled
   * until payment is verified.
   */
  it("carries NO invoice URL of any kind", () => {
    const dto = buildBankCheckoutResultDto({
      bankPaymentOrderId: "order-1",
      draftOrderGid: "gid://shopify/DraftOrder/1",
      quotedAt: new Date("2026-09-21T00:00:00.000Z"),
      guaranteeExpiresAt: new Date("2026-09-22T00:00:00.000Z"),
      formattedAmountDue: "2000.00 USD",
      lines: [line()],
    });

    expect(dto).not.toHaveProperty("invoiceUrl");
    const serialised = JSON.stringify(dto);
    expect(serialised).not.toContain("invoiceUrl");
    // Nor any other field that happens to hold a Shopify-hosted URL a
    // customer could follow — the defect was the navigation, not the name.
    expect(serialised).not.toMatch(/https?:\/\/[^"]*myshopify\.com/);
    expect(serialised).not.toMatch(/\/invoice/);
    expect(dto.formattedAmountDue).toBe("2000.00 USD");
    const json = JSON.stringify(dto);
    expect(json).not.toContain("invoiceUrl");
    expect(json).not.toContain("paymentInstructions");
    expect(json).not.toContain("zelle");
  });
});

const ZELLE = "test-pay@example.invalid";

/**
 * A CURRENT stored payload. Typed as the concrete result rather than the
 * `StoredBankCheckoutResult` union so it can feed `toCustomerResponse`
 * directly; the union exists for OLD payloads, which the replay tests below
 * construct explicitly.
 */
function storedResult(): BankCheckoutResultDto {
  return buildBankCheckoutResultDto({
    bankPaymentOrderId: "order-1",
    draftOrderGid: "gid://shopify/DraftOrder/1",
    quotedAt: new Date("2026-09-21T00:00:00.000Z"),
    guaranteeExpiresAt: new Date("2026-09-22T00:00:00.000Z"),
    formattedAmountDue: "2000.00 USD",
    lines: [line()],
  });
}

describe("toCustomerResponse — the customer-facing body, built per request and never persisted", () => {
  /**
   * RETARGETED from the parallel D12/D15 branch's `buildBankCheckoutResponseDto`.
   * That builder returned the Zelle recipient alone AND carried
   * `draftOrderGid`; this envelope carries the full instruction set and drops
   * the draft handle. The assertions below are the branch's own, pointed at
   * the surviving function — the intent (no leak, no mutation, no invoice)
   * was right and is kept.
   */
  const instructions = buildPaymentInstructionsView({
    flow: "buy_now",
    reference: "order-1",
    formattedAmountDue: "2000.00 USD",
    currency: "USD",
    paymentDeadline: new Date("2026-09-22T00:00:00.000Z"),
    coordinates: {
      zelle: { recipient: ZELLE },
      wire: {
        bankName: "TEST BANK",
        accountName: "TEST ACCOUNT",
        routingNumber: "000000000",
        accountNumber: "000000000000",
      },
    },
  });

  it("returns exactly the documented fields and NO draft order handle", () => {
    const dto = toCustomerResponse(storedResult(), instructions);
    expect(Object.keys(dto).sort()).toEqual(
      ["bankPaymentOrderId", "guaranteeExpiresAt", "instructions", "lines", "quotedAt"].sort()
    );
    // The whole point of the envelope: the Shopify handle stays server-side.
    expect(dto).not.toHaveProperty("draftOrderGid");
    assertNoForbiddenFields(dto);
  });

  it("carries BOTH payment methods, which is the D12 fix", () => {
    // The superseded builder exposed the Zelle recipient only and told the
    // customer their wire details had been emailed — the exact email
    // dependency D12 removes.
    const dto = toCustomerResponse(storedResult(), instructions);
    const kinds = dto.instructions.methods.map((m: { kind: string }) => m.kind).sort();
    expect(kinds).toEqual(["domestic_wire", "zelle"]);
  });

  it("contains no invoice URL", () => {
    const json = JSON.stringify(toCustomerResponse(storedResult(), instructions));
    expect(json).not.toContain("invoiceUrl");
    expect(json).not.toMatch(/myshopify\.com/);
  });

  it("the stored result itself is not mutated, and never gains a coordinate", () => {
    const stored = storedResult();
    const before = JSON.stringify(stored);
    toCustomerResponse(stored, instructions);
    expect(JSON.stringify(stored)).toBe(before);
    expect(before).not.toContain(ZELLE);
    expect(before).not.toContain("000000000000");
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

  it("recomputes the amount from the stored lines using the CHARGED price (bank if eligible, card if not)", () => {
    expect(resolveFormattedAmountDue(oldPayload(OLD_LINES))).toBe("4080.05 USD");
  });

  it("prefers a stored formattedAmountDue over recomputing", () => {
    expect(resolveFormattedAmountDue(storedResult())).toBe("2000.00 USD");
  });

  it("returns null (no half-built panel) when the lines are unusable", () => {
    expect(resolveFormattedAmountDue(oldPayload([]))).toBeNull();
    expect(
      resolveFormattedAmountDue(
        oldPayload([{ ...OLD_LINES[0], quotedBankPaymentPriceMinorUnits: "not-a-number" }])
      )
    ).toBeNull();
    expect(
      resolveFormattedAmountDue(oldPayload([OLD_LINES[0], { ...OLD_LINES[1], currency: "EUR" }]))
    ).toBeNull();
  });

  it("an old payload's invoiceUrl never reaches the customer envelope", () => {
    // The envelope names its fields by hand, so a stray stored field cannot
    // ride along even when the payload predates the field being removed.
    const amount = resolveFormattedAmountDue(oldPayload(OLD_LINES));
    const view = buildPaymentInstructionsView({
      flow: "buy_now",
      reference: "order-old",
      formattedAmountDue: amount!,
      currency: "USD",
      paymentDeadline: new Date("2026-09-22T00:00:00.000Z"),
      coordinates: {
        zelle: { recipient: ZELLE },
        wire: { bankName: "B", accountName: "A", routingNumber: "0", accountNumber: "0" },
      },
    });
    const json = JSON.stringify(toCustomerResponse(oldPayload(OLD_LINES) as never, view));
    expect(json).not.toContain("invoiceUrl");
    expect(json).not.toContain("example.myshopify.com/invoice");
  });
});

describe("guard the guard — the fence actually detects a real leak", () => {
  it("fails if a forbidden field were present", () => {
    const leaking = { ...line(), priceCalculationId: "calc-1" };
    expect(() => assertNoForbiddenFields(leaking)).toThrow();
  });
});
