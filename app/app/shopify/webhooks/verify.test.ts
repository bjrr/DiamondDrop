import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyShopifyWebhookHmac } from "./verify";

const SECRET = "test_shopify_secret";

function sign(body: string, secret: string = SECRET): string {
  return createHmac("sha256", secret).update(body, "utf8").digest("base64");
}

describe("verifyShopifyWebhookHmac", () => {
  it("accepts a valid HMAC over the exact raw body", () => {
    const body = JSON.stringify({ id: 1, note: "sample order" });
    expect(verifyShopifyWebhookHmac(body, sign(body), SECRET)).toBe(true);
  });

  it("rejects a missing HMAC header", () => {
    const body = JSON.stringify({ id: 1 });
    expect(verifyShopifyWebhookHmac(body, null, SECRET)).toBe(false);
    expect(verifyShopifyWebhookHmac(body, undefined, SECRET)).toBe(false);
    expect(verifyShopifyWebhookHmac(body, "", SECRET)).toBe(false);
  });

  it("rejects an HMAC signed with the wrong secret", () => {
    const body = JSON.stringify({ id: 1 });
    expect(verifyShopifyWebhookHmac(body, sign(body, "wrong_secret"), SECRET)).toBe(false);
  });

  it("rejects when the body is modified after signing", () => {
    const originalBody = JSON.stringify({ id: 1, amount: 100 });
    const hmac = sign(originalBody);
    const tamperedBody = JSON.stringify({ id: 1, amount: 999999 });
    expect(verifyShopifyWebhookHmac(tamperedBody, hmac, SECRET)).toBe(false);
  });

  it("rejects a garbage/non-matching HMAC header", () => {
    const body = JSON.stringify({ id: 1 });
    expect(verifyShopifyWebhookHmac(body, "not-a-real-hmac", SECRET)).toBe(false);
  });

  it("is exact over bytes: re-serialized JSON with different whitespace fails verification", () => {
    const compact = JSON.stringify({ id: 1, name: "Ring" });
    const hmac = sign(compact);
    const withWhitespace = JSON.stringify({ id: 1, name: "Ring" }, null, 2);
    expect(verifyShopifyWebhookHmac(withWhitespace, hmac, SECRET)).toBe(false);
  });
});
