import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyAppProxySignature } from "./verify";

const SECRET = "test_app_secret";

function sign(params: Record<string, string>, secret: string = SECRET): string {
  const message = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("");
  return createHmac("sha256", secret).update(message, "utf8").digest("hex");
}

function buildSearchParams(params: Record<string, string>, signature: string): URLSearchParams {
  const sp = new URLSearchParams(params);
  sp.set("signature", signature);
  return sp;
}

describe("verifyAppProxySignature", () => {
  it("accepts a correctly signed request and exposes logged_in_customer_id", () => {
    const params = {
      shop: "carat-for-us.myshopify.com",
      path_prefix: "/apps/carat",
      logged_in_customer_id: "123",
      timestamp: "1700000000",
    };
    const result = verifyAppProxySignature(buildSearchParams(params, sign(params)), SECRET);

    expect(result.verified).toBe(true);
    expect(result.loggedInCustomerId).toBe("123");
  });

  it("verifies correctly regardless of the order params were inserted into the URL", () => {
    const params = { b: "2", a: "1", c: "3" };
    const signature = sign(params);

    // Deliberately insert keys out of sorted order — verification must not
    // depend on insertion/iteration order, only on the sorted message.
    const sp = new URLSearchParams();
    sp.set("c", "3");
    sp.set("a", "1");
    sp.set("b", "2");
    sp.set("signature", signature);

    expect(verifyAppProxySignature(sp, SECRET).verified).toBe(true);
  });

  it("rejects a request with no signature parameter", () => {
    const sp = new URLSearchParams({ shop: "carat-for-us.myshopify.com" });
    const result = verifyAppProxySignature(sp, SECRET);
    expect(result.verified).toBe(false);
    expect(result.loggedInCustomerId).toBeNull();
  });

  it("rejects a tampered query parameter", () => {
    const params = { shop: "carat-for-us.myshopify.com", logged_in_customer_id: "123" };
    const signature = sign(params);
    const tampered = buildSearchParams({ ...params, logged_in_customer_id: "456" }, signature);

    const result = verifyAppProxySignature(tampered, SECRET);
    expect(result.verified).toBe(false);
    expect(result.loggedInCustomerId).toBeNull();
  });

  it("rejects a signature computed with the wrong secret", () => {
    const params = { shop: "carat-for-us.myshopify.com" };
    const result = verifyAppProxySignature(buildSearchParams(params, sign(params, "wrong-secret")), SECRET);
    expect(result.verified).toBe(false);
  });

  it("rejects a garbage signature value", () => {
    const sp = new URLSearchParams({
      shop: "carat-for-us.myshopify.com",
      signature: "not-a-real-signature",
    });
    expect(verifyAppProxySignature(sp, SECRET).verified).toBe(false);
  });

  it("verifies a guest (no logged_in_customer_id) request without exposing a customer id", () => {
    const params = { shop: "carat-for-us.myshopify.com" };
    const result = verifyAppProxySignature(buildSearchParams(params, sign(params)), SECRET);
    expect(result.verified).toBe(true);
    expect(result.loggedInCustomerId).toBeNull();
  });
});
