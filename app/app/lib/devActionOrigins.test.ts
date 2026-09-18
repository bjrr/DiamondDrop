import { describe, expect, it } from "vitest";

import { resolveAllowedActionOrigins } from "./devActionOrigins";

/**
 * This function decides which cross-origin submissions React Router will
 * accept, so the tests that matter most are the ones asserting it allows
 * NOTHING. A permissive bug here would not break anything visibly — it would
 * quietly widen what the app trusts.
 */

describe("production", () => {
  it("allows no origins when NODE_ENV is production", () => {
    expect(
      resolveAllowedActionOrigins({
        NODE_ENV: "production",
        APP_URL: "https://real-tunnel.trycloudflare.com",
      })
    ).toEqual([]);
  });

  it("allows no origins when APP_ENV is production, even in a dev NODE_ENV", () => {
    // Belt and braces: a build could plausibly run with NODE_ENV unset while
    // APP_ENV says production. Either one alone closes the allowlist.
    expect(
      resolveAllowedActionOrigins({ APP_ENV: "production", HOST: "https://x.trycloudflare.com" })
    ).toEqual([]);
  });
});

describe("development behind the Shopify CLI tunnel", () => {
  it("allows exactly the tunnel host, not a wildcard", () => {
    const origins = resolveAllowedActionOrigins({
      APP_ENV: "development",
      APP_URL: "https://abc-def-123.trycloudflare.com",
    });

    expect(origins).toEqual(["abc-def-123.trycloudflare.com"]);
    // The distinction that matters: a pattern would trust every quick tunnel
    // on the internet, not just the one serving this app.
    expect(origins.some((o) => o.includes("*"))).toBe(false);
  });

  it("prefers SHOPIFY_APP_URL, then APP_URL, then HOST", () => {
    expect(
      resolveAllowedActionOrigins({
        SHOPIFY_APP_URL: "https://ours.example.net",
        APP_URL: "https://cli.trycloudflare.com",
        HOST: "https://host.trycloudflare.com",
      })
    ).toEqual(["ours.example.net"]);

    expect(
      resolveAllowedActionOrigins({ APP_URL: "https://cli.trycloudflare.com", HOST: "https://h.io" })
    ).toEqual(["cli.trycloudflare.com"]);

    expect(resolveAllowedActionOrigins({ HOST: "https://h.trycloudflare.com" })).toEqual([
      "h.trycloudflare.com",
    ]);
  });

  it("keeps the port, because origin comparison includes it", () => {
    expect(resolveAllowedActionOrigins({ APP_URL: "http://localhost:3000" })).toEqual([
      "localhost:3000",
    ]);
  });

  it("accepts a bare host with no scheme", () => {
    expect(resolveAllowedActionOrigins({ APP_URL: "abc.trycloudflare.com" })).toEqual([
      "abc.trycloudflare.com",
    ]);
  });
});

describe("fails closed", () => {
  it("allows nothing when no tunnel is configured", () => {
    expect(resolveAllowedActionOrigins({ APP_ENV: "development" })).toEqual([]);
  });

  it("allows nothing for an unparseable value", () => {
    // A broken tunnel must make form posts fail loudly in development, not
    // silently widen what is trusted.
    expect(resolveAllowedActionOrigins({ APP_URL: "not a url at all" })).toEqual([]);
    expect(resolveAllowedActionOrigins({ APP_URL: "" })).toEqual([]);
  });

  it("REFUSES the example.com placeholder", () => {
    // application_url is still "https://example.com" in the app .toml until a
    // real deployment exists. Trusting it would mean shipping a config that
    // allows a domain we do not own.
    expect(resolveAllowedActionOrigins({ APP_URL: "https://example.com" })).toEqual([]);
    expect(resolveAllowedActionOrigins({ APP_URL: "https://sub.example.com" })).toEqual([]);
  });
});
