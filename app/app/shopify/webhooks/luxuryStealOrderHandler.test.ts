import { describe, expect, it } from "vitest";

import {
  extractAcknowledgmentPropertyValue,
  extractLineRef,
  extractLineVariantGid,
  extractOrderRef,
  parseOrderPayload,
  preserveShopifyBigIntIds,
  type OrderLineItem,
} from "./luxuryStealOrderHandler.server";

/**
 * Unit coverage for the PURE halves only (same split as
 * `inventoryPurchasabilityHandler.test.ts`) — no database, no network, no
 * email. `handleLuxuryStealOrderCreateWebhook` itself touches Prisma and the
 * email port and is integration-test territory — see
 * `tests/integration/luxurysteals/orderCreateWebhook.test.ts`.
 */

describe("preserveShopifyBigIntIds", () => {
  it("preserves a 64-bit id beyond Number.MAX_SAFE_INTEGER exactly, digit for digit", () => {
    const hugeId = "9007199254740993"; // MAX_SAFE_INTEGER + 2 — unrepresentable exactly as a JS number
    const rawBody = `{"id":${hugeId},"variant_id":${hugeId}}`;
    const doctored = preserveShopifyBigIntIds(rawBody);
    const parsed = JSON.parse(doctored) as { id: string; variant_id: string };
    expect(parsed.id).toBe(hugeId);
    expect(parsed.variant_id).toBe(hugeId);
  });

  it("proves the hazard is real: naive JSON.parse alone loses precision on the same body", () => {
    const hugeId = "9007199254740993";
    const rawBody = `{"variant_id":${hugeId}}`;
    const naive = JSON.parse(rawBody) as { variant_id: number };
    expect(String(naive.variant_id)).not.toBe(hugeId);
  });

  it("does not touch a value that is already a quoted string (e.g. admin_graphql_api_id)", () => {
    const rawBody = `{"admin_graphql_api_id":"gid://shopify/Order/123","id":123}`;
    const doctored = preserveShopifyBigIntIds(rawBody);
    expect(doctored).toContain(`"admin_graphql_api_id":"gid://shopify/Order/123"`);
    expect(doctored).toContain(`"id":"123"`);
  });

  it("rewrites every occurrence across a nested line_items array, not just the first", () => {
    // Built by hand, never via JSON.stringify(number) — a numeric literal
    // this large would itself lose precision at the source level, which is
    // exactly the hazard this module exists to avoid.
    const rawBody =
      '{"id":1,"line_items":[' +
      '{"id":111,"variant_id":9007199254740993},' +
      '{"id":222,"variant_id":9007199254740994}' +
      "]}";

    const doctored = preserveShopifyBigIntIds(rawBody);
    const parsed = JSON.parse(doctored) as {
      id: string;
      line_items: { id: string; variant_id: string }[];
    };
    expect(parsed.line_items[0]!.variant_id).toBe("9007199254740993");
    expect(parsed.line_items[1]!.variant_id).toBe("9007199254740994");
    expect(parsed.line_items[0]!.id).toBe("111");
    expect(parsed.line_items[1]!.id).toBe("222");
  });

  it("leaves a null variant_id (custom line item) untouched", () => {
    const rawBody = `{"id":1,"line_items":[{"id":2,"variant_id":null}]}`;
    const doctored = preserveShopifyBigIntIds(rawBody);
    const parsed = JSON.parse(doctored) as { line_items: { variant_id: null }[] };
    expect(parsed.line_items[0]!.variant_id).toBeNull();
  });
});

describe("parseOrderPayload", () => {
  it("parses a well-formed orders/create body with big ids preserved exactly", () => {
    const hugeOrderId = "9007199254740993";
    const hugeVariantId = "9007199254740995";
    const rawBody = `{"id":${hugeOrderId},"line_items":[{"id":1,"variant_id":${hugeVariantId},"properties":[{"name":"_carat_ls_ack","value":"abc"}]}]}`;

    const payload = parseOrderPayload(rawBody);
    expect(payload.id).toBe(hugeOrderId);
    expect(payload.line_items?.[0]?.variant_id).toBe(hugeVariantId);
  });

  it("throws (not silently swallows) on a body that does not match the documented shape", () => {
    expect(() => parseOrderPayload(`{"line_items":"not an array"}`)).toThrow();
  });

  it("throws SyntaxError on non-JSON text rather than returning a partial result", () => {
    expect(() => parseOrderPayload("not json at all")).toThrow();
  });
});

describe("extractOrderRef", () => {
  it("prefers admin_graphql_api_id when present", () => {
    expect(extractOrderRef({ id: "1", admin_graphql_api_id: "gid://shopify/Order/1" })).toBe(
      "gid://shopify/Order/1"
    );
  });

  it("falls back to constructing a gid from the (string-exact) legacy id", () => {
    expect(extractOrderRef({ id: "9007199254740993" })).toBe("gid://shopify/Order/9007199254740993");
  });

  it("throws when neither is present rather than returning a bogus ref", () => {
    expect(() => extractOrderRef({})).toThrow();
  });
});

function line(overrides: Partial<OrderLineItem> = {}): OrderLineItem {
  return { id: "1", ...overrides };
}

describe("extractLineRef", () => {
  it("prefers admin_graphql_api_id when present", () => {
    expect(extractLineRef(line({ admin_graphql_api_id: "gid://shopify/LineItem/1" }))).toBe(
      "gid://shopify/LineItem/1"
    );
  });

  it("falls back to constructing a gid from the legacy id", () => {
    expect(extractLineRef(line({ id: "9007199254740993" }))).toBe("gid://shopify/LineItem/9007199254740993");
  });
});

describe("extractLineVariantGid", () => {
  it("normalizes a bare numeric variant_id to a full gid", () => {
    expect(extractLineVariantGid(line({ variant_id: "39072856" }))).toBe(
      "gid://shopify/ProductVariant/39072856"
    );
  });

  it("passes through a variant_id already in gid form", () => {
    expect(extractLineVariantGid(line({ variant_id: "gid://shopify/ProductVariant/39072856" }))).toBe(
      "gid://shopify/ProductVariant/39072856"
    );
  });

  it("returns null for a custom/manual line item with no variant_id", () => {
    expect(extractLineVariantGid(line({ variant_id: null }))).toBeNull();
    expect(extractLineVariantGid(line({}))).toBeNull();
  });

  it("preserves a 64-bit variant id exactly", () => {
    expect(extractLineVariantGid(line({ variant_id: "9007199254740993" }))).toBe(
      "gid://shopify/ProductVariant/9007199254740993"
    );
  });
});

describe("extractAcknowledgmentPropertyValue", () => {
  it("returns the value of the _carat_ls_ack property", () => {
    expect(
      extractAcknowledgmentPropertyValue(
        line({ properties: [{ name: "_carat_ls_ack", value: "ack-id-123" }] })
      )
    ).toBe("ack-id-123");
  });

  it("returns null when no properties array is present at all (the no-property case)", () => {
    expect(extractAcknowledgmentPropertyValue(line({}))).toBeNull();
  });

  it("returns null when properties exist but none is named _carat_ls_ack", () => {
    expect(
      extractAcknowledgmentPropertyValue(line({ properties: [{ name: "gift_message", value: "hi" }] }))
    ).toBeNull();
  });

  it("returns null for an empty-string value", () => {
    expect(
      extractAcknowledgmentPropertyValue(line({ properties: [{ name: "_carat_ls_ack", value: "  " }] }))
    ).toBeNull();
  });

  it("trims whitespace around the value", () => {
    expect(
      extractAcknowledgmentPropertyValue(line({ properties: [{ name: "_carat_ls_ack", value: "  abc  " }] }))
    ).toBe("abc");
  });

  it("coerces a non-string property value rather than throwing", () => {
    expect(
      extractAcknowledgmentPropertyValue(line({ properties: [{ name: "_carat_ls_ack", value: 12345 }] }))
    ).toBe("12345");
  });

  it("finds the right property among several, regardless of position", () => {
    expect(
      extractAcknowledgmentPropertyValue(
        line({
          properties: [
            { name: "gift_message", value: "hi" },
            { name: "_carat_ls_ack", value: "ack-id-456" },
            { name: "engraving", value: "JS" },
          ],
        })
      )
    ).toBe("ack-id-456");
  });
});
