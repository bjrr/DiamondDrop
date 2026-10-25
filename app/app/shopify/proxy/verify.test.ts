import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { verifyAppProxySignature } from "./verify";

const SECRET = "test_app_secret";
/** The canonical `myshopifyDomain` this deployment is configured for. */
const SHOP = "carat-for-us.myshopify.com";
/** A DIFFERENT shop that also has this app installed — same secret, same signing. */
const OTHER_SHOP = "carat-for-us-dev.myshopify.com";

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

/** A genuinely, correctly signed request from `params`' own shop. */
function genuine(params: Record<string, string>): URLSearchParams {
  return buildSearchParams(params, sign(params));
}

describe("verifyAppProxySignature — signature", () => {
  it("accepts a correctly signed request and exposes logged_in_customer_id", () => {
    const params = {
      shop: SHOP,
      path_prefix: "/apps/carat",
      logged_in_customer_id: "123",
      timestamp: "1700000000",
    };
    const result = verifyAppProxySignature(genuine(params), SECRET, SHOP);

    expect(result.verified).toBe(true);
    expect(result.loggedInCustomerId).toBe("123");
    expect(result.reason).toBe("ok");
    expect(result.shop).toBe(SHOP);
  });

  it("verifies correctly regardless of the order params were inserted into the URL", () => {
    const params = { shop: SHOP, b: "2", a: "1", c: "3" };
    const signature = sign(params);

    // Deliberately insert keys out of sorted order — verification must not
    // depend on insertion/iteration order, only on the sorted message.
    const sp = new URLSearchParams();
    sp.set("c", "3");
    sp.set("a", "1");
    sp.set("shop", SHOP);
    sp.set("b", "2");
    sp.set("signature", signature);

    expect(verifyAppProxySignature(sp, SECRET, SHOP).verified).toBe(true);
  });

  it("rejects a request with no signature parameter", () => {
    const sp = new URLSearchParams({ shop: SHOP });
    const result = verifyAppProxySignature(sp, SECRET, SHOP);
    expect(result.verified).toBe(false);
    expect(result.loggedInCustomerId).toBeNull();
    expect(result.reason).toBe("invalid_or_missing_signature");
  });

  it("rejects a tampered query parameter", () => {
    const params = { shop: SHOP, logged_in_customer_id: "123" };
    const signature = sign(params);
    const tampered = buildSearchParams({ ...params, logged_in_customer_id: "456" }, signature);

    const result = verifyAppProxySignature(tampered, SECRET, SHOP);
    expect(result.verified).toBe(false);
    expect(result.loggedInCustomerId).toBeNull();
    expect(result.reason).toBe("invalid_or_missing_signature");
  });

  it("rejects a signature computed with the wrong secret", () => {
    const params = { shop: SHOP };
    const result = verifyAppProxySignature(buildSearchParams(params, sign(params, "wrong-secret")), SECRET, SHOP);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("invalid_or_missing_signature");
  });

  it("rejects a garbage signature value", () => {
    const sp = new URLSearchParams({ shop: SHOP, signature: "not-a-real-signature" });
    expect(verifyAppProxySignature(sp, SECRET, SHOP).verified).toBe(false);
  });

  it("verifies a guest (no logged_in_customer_id) request without exposing a customer id", () => {
    const params = { shop: SHOP };
    const result = verifyAppProxySignature(genuine(params), SECRET, SHOP);
    expect(result.verified).toBe(true);
    expect(result.loggedInCustomerId).toBeNull();
  });
});

/**
 * REGISTER D4 — SHOP BINDING.
 *
 * A valid signature proves Shopify sent the request. It does NOT prove WHICH
 * shop sent it: every store with this app installed signs with the SAME app
 * secret. This app is installed on two shops that share one database, and
 * Shopify customer ids are unique per shop, not globally — so without this
 * check a genuine request from the dev store reaches production's data under
 * a colliding customer id.
 *
 * Every request below is GENUINELY SIGNED. None of these are forgeries; that
 * is exactly what makes the check necessary.
 */
describe("verifyAppProxySignature — shop binding (register D4)", () => {
  it("ACCEPTS a valid signature from the configured shop", () => {
    const params = { shop: SHOP, logged_in_customer_id: "123" };
    const result = verifyAppProxySignature(genuine(params), SECRET, SHOP);

    expect(result.verified).toBe(true);
    expect(result.reason).toBe("ok");
    expect(result.loggedInCustomerId).toBe("123");
  });

  it("REJECTS a valid signature from a DIFFERENT Shopify shop", () => {
    // The whole point: correctly signed, genuinely from Shopify, and still
    // refused because it is not this deployment's shop.
    const params = { shop: OTHER_SHOP, logged_in_customer_id: "123" };
    const result = verifyAppProxySignature(genuine(params), SECRET, SHOP);

    expect(result.verified).toBe(false);
    expect(result.reason).toBe("shop_mismatch");
    // And the customer id does NOT survive the refusal.
    expect(result.loggedInCustomerId).toBeNull();
    // The signed value is reported for diagnostics — a mismatch is
    // undiagnosable without knowing what actually arrived.
    expect(result.shop).toBe(OTHER_SHOP);
  });

  it("REJECTS a valid signature with no shop parameter at all", () => {
    const params = { logged_in_customer_id: "123", timestamp: "1700000000" };
    const result = verifyAppProxySignature(genuine(params), SECRET, SHOP);

    expect(result.verified).toBe(false);
    expect(result.reason).toBe("missing_shop");
    expect(result.loggedInCustomerId).toBeNull();
  });

  it("REJECTS a valid signature with an empty shop parameter", () => {
    const params = { shop: "", logged_in_customer_id: "123" };
    const result = verifyAppProxySignature(genuine(params), SECRET, SHOP);

    expect(result.verified).toBe(false);
    expect(result.reason).toBe("missing_shop");
  });

  it("FAILS CLOSED when the deployment has no configured shop", () => {
    // An unconfigured expectation is a deployment fault. Treating it as
    // "allow everything" would silently disable this control at exactly the
    // moment nobody is looking.
    const params = { shop: SHOP, logged_in_customer_id: "123" };
    for (const unconfigured of [undefined, "", "   "]) {
      const result = verifyAppProxySignature(genuine(params), SECRET, unconfigured);
      expect(result.verified).toBe(false);
      expect(result.reason).toBe("expected_shop_unconfigured");
      expect(result.loggedInCustomerId).toBeNull();
    }
  });

  it("checks the SIGNED shop — a mismatched shop cannot be swapped in without breaking the signature", () => {
    // Sign for the dev store, then rewrite `shop` to the production value
    // hoping the binding passes. The signature check catches it first, so
    // this never even reaches the shop comparison.
    const signedForOther = { shop: OTHER_SHOP, logged_in_customer_id: "123" };
    const swapped = buildSearchParams({ ...signedForOther, shop: SHOP }, sign(signedForOther));

    const result = verifyAppProxySignature(swapped, SECRET, SHOP);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("invalid_or_missing_signature");
  });

  it("compares hostnames case-insensitively, but does not match on substrings", () => {
    const upper = { shop: SHOP.toUpperCase(), logged_in_customer_id: "1" };
    expect(verifyAppProxySignature(genuine(upper), SECRET, SHOP).verified).toBe(true);

    // A shop whose name merely CONTAINS the configured one must not pass.
    // Suffix/substring matching is how this class of check gets defeated.
    const lookalike = { shop: `evil-${SHOP}`, logged_in_customer_id: "1" };
    const result = verifyAppProxySignature(genuine(lookalike), SECRET, SHOP);
    expect(result.verified).toBe(false);
    expect(result.reason).toBe("shop_mismatch");
  });

  it("the customer id is trusted ONLY after both signature and shop binding pass", () => {
    // Stated as one table because it is the single property that matters:
    // there is no combination in which a customer identity escapes a failed
    // check.
    const cases: Array<{ label: string; params: URLSearchParams; expected: string | null }> = [
      { label: "all good", params: genuine({ shop: SHOP, logged_in_customer_id: "777" }), expected: "777" },
      { label: "wrong shop", params: genuine({ shop: OTHER_SHOP, logged_in_customer_id: "777" }), expected: null },
      { label: "no shop", params: genuine({ logged_in_customer_id: "777" }), expected: null },
      {
        label: "bad signature",
        params: buildSearchParams({ shop: SHOP, logged_in_customer_id: "777" }, "deadbeef"),
        expected: null,
      },
    ];

    for (const { label, params, expected } of cases) {
      expect(verifyAppProxySignature(params, SECRET, SHOP).loggedInCustomerId, label).toBe(expected);
    }
  });
});
