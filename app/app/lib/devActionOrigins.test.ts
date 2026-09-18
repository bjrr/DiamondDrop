import { describe, expect, it } from "vitest";

import {
  describeAllowedActionOrigins,
  formatOriginDiagnostic,
  resolveAllowedActionOrigins,
} from "./devActionOrigins";

/**
 * This function decides which cross-origin submissions React Router will
 * accept, so the tests that matter most are the ones asserting it allows
 * nothing — and the ones asserting it does not stop at a placeholder.
 *
 * THE BUG THESE WERE WRITTEN AGAINST. The first version evaluated
 * `SHOPIFY_APP_URL ?? APP_URL ?? HOST` and stopped at the first value present.
 * `.env` sets SHOPIFY_APP_URL to a placeholder and vite.config.ts loads `.env`
 * into process.env, so the placeholder always won. It did not return [] — it
 * returned ["example.ngrok-free.app"], an allowlist that looked configured
 * while trusting a host that serves nothing.
 */

const REAL_TUNNEL = "https://abc-def-123.trycloudflare.com";

describe("falls through placeholders to the real tunnel", () => {
  it("prefers the CLI tunnel in APP_URL over a placeholder SHOPIFY_APP_URL", () => {
    // The exact reported failure.
    expect(
      resolveAllowedActionOrigins({
        SHOPIFY_APP_URL: "https://example.com",
        APP_URL: "https://real-tunnel.trycloudflare.com",
      })
    ).toEqual(["real-tunnel.trycloudflare.com"]);
  });

  it("skips the ngrok-shaped placeholder that actually sits in .env", () => {
    // example.ngrok-free.app is not example.com, which is why the first
    // implementation sailed past it. Its first label is "example".
    expect(
      resolveAllowedActionOrigins({
        SHOPIFY_APP_URL: "https://example.ngrok-free.app",
        APP_URL: REAL_TUNNEL,
      })
    ).toEqual(["abc-def-123.trycloudflare.com"]);
  });

  it("falls through a MALFORMED first candidate instead of giving up", () => {
    expect(
      resolveAllowedActionOrigins({ APP_URL: "not a url at all", HOST: REAL_TUNNEL })
    ).toEqual(["abc-def-123.trycloudflare.com"]);
  });

  it("falls through an EMPTY first candidate", () => {
    expect(resolveAllowedActionOrigins({ APP_URL: "", HOST: REAL_TUNNEL })).toEqual([
      "abc-def-123.trycloudflare.com",
    ]);
  });

  it("falls through several unusable candidates in a row", () => {
    expect(
      resolveAllowedActionOrigins({
        APP_URL: "",
        HOST: "https://example.com",
        SHOPIFY_APP_URL: REAL_TUNNEL,
      })
    ).toEqual(["abc-def-123.trycloudflare.com"]);
  });
});

describe("source preference", () => {
  it("prefers the CLI runtime values over the static .env one", () => {
    // APP_URL and HOST are injected by the Shopify CLI at runtime and are the
    // live tunnel; SHOPIFY_APP_URL is hand-edited and usually stale.
    const r = describeAllowedActionOrigins({
      SHOPIFY_APP_URL: "https://stale-but-valid.example.net",
      APP_URL: REAL_TUNNEL,
      HOST: "https://host-value.trycloudflare.com",
    });
    expect(r.source).toBe("APP_URL");
    expect(r.host).toBe("abc-def-123.trycloudflare.com");
  });

  it("uses HOST when APP_URL is absent", () => {
    const r = describeAllowedActionOrigins({ HOST: REAL_TUNNEL });
    expect(r.source).toBe("HOST");
  });

  it("uses SHOPIFY_APP_URL only when it is a real host and nothing else is set", () => {
    const r = describeAllowedActionOrigins({ SHOPIFY_APP_URL: "https://staging.caratforus.com" });
    expect(r.source).toBe("SHOPIFY_APP_URL");
    expect(r.host).toBe("staging.caratforus.com");
  });
});

describe("returns a bare host, never a pattern", () => {
  it("strips the scheme", () => {
    expect(resolveAllowedActionOrigins({ APP_URL: REAL_TUNNEL })).toEqual([
      "abc-def-123.trycloudflare.com",
    ]);
  });

  it("keeps the port, because origin comparison includes it", () => {
    expect(resolveAllowedActionOrigins({ APP_URL: "http://localhost:3000" })).toEqual([
      "localhost:3000",
    ]);
  });

  it("NEVER returns a wildcard, whatever the input", () => {
    for (const value of [REAL_TUNNEL, "https://*.trycloudflare.com", "**.example.com", "x.io"]) {
      for (const origin of resolveAllowedActionOrigins({ APP_URL: value })) {
        expect(origin).not.toMatch(/\*/);
      }
    }
  });

  it("returns at most one origin", () => {
    expect(
      resolveAllowedActionOrigins({ APP_URL: REAL_TUNNEL, HOST: "https://other.trycloudflare.com" })
    ).toHaveLength(1);
  });
});

describe("production returns nothing", () => {
  it("is empty when NODE_ENV is production, even with a live tunnel", () => {
    expect(
      resolveAllowedActionOrigins({ NODE_ENV: "production", APP_URL: REAL_TUNNEL })
    ).toEqual([]);
  });

  it("is empty when APP_ENV is production", () => {
    expect(resolveAllowedActionOrigins({ APP_ENV: "production", HOST: REAL_TUNNEL })).toEqual([]);
  });
});

describe("fails closed", () => {
  it("allows nothing when no source is set", () => {
    expect(resolveAllowedActionOrigins({ APP_ENV: "development" })).toEqual([]);
  });

  it("allows nothing when every source is a placeholder", () => {
    expect(
      resolveAllowedActionOrigins({
        SHOPIFY_APP_URL: "https://example.ngrok-free.app",
        APP_URL: "https://example.com",
        HOST: "https://sub.example.org",
      })
    ).toEqual([]);
  });

  it("allows nothing for an unreplaced template value", () => {
    expect(
      resolveAllowedActionOrigins({ APP_URL: "https://REPLACE_WITH_APP_URL.example.com" })
    ).toEqual([]);
  });
});

describe("the startup diagnostic", () => {
  it("names the winning host and where it came from", () => {
    // APP_URL is checked FIRST, so to see a skip in the trail the placeholder
    // has to sit there; SHOPIFY_APP_URL is last and is never reached once a
    // winner is found. An earlier version of this test asserted otherwise —
    // it was written against the old, broken precedence order.
    const line = formatOriginDiagnostic({
      APP_URL: "https://example.ngrok-free.app",
      HOST: REAL_TUNNEL,
    });
    expect(line).toMatch(/allowing abc-def-123.trycloudflare.com/);
    expect(line).toMatch(/from HOST/);
    // Shows the skip too, so "why was my value ignored?" is answerable.
    expect(line).toMatch(/APP_URL: skipped — placeholder/);
  });

  it("says plainly when nothing usable was found", () => {
    expect(formatOriginDiagnostic({ APP_ENV: "development" })).toMatch(/NO usable origin found/);
  });

  it("leaks nothing beyond hosts", () => {
    const line = formatOriginDiagnostic({
      APP_URL: REAL_TUNNEL,
      // Not part of OriginEnv, but prove it cannot appear even if passed.
      ...({ SHOPIFY_API_SECRET: "shpss_supersecret" } as Record<string, string>),
    });
    expect(line).not.toMatch(/shpss_/);
    expect(line).not.toMatch(/SECRET/i);
  });
});
