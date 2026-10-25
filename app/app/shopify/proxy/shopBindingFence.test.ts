import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * REGISTER D4 — every App Proxy route must bind to the configured shop.
 *
 * ============================================================================
 * WHY A FENCE AND NOT ONLY verify.test.ts
 * ============================================================================
 * `verify.test.ts` proves the verifier refuses a foreign shop. It cannot
 * prove that the 22 routes actually ASK it to. TypeScript gets most of the
 * way — `expectedShop` is a required parameter, so a route cannot omit it —
 * but a required parameter can still be satisfied by the wrong thing:
 * `undefined`, a hardcoded domain, or a value read from the request.
 *
 * Each of those compiles. Each of those is the control quietly switched off
 * for one route, which is how a boundary enforced in 22 places decays.
 *
 * So this asserts the one correct spelling: every call passes
 * `getEnv().SHOPIFY_SHOP_DOMAIN`. Environment-driven on purpose — dev and
 * production run identical code with different configured shops, so a
 * hardcoded production domain would be wrong even when it looks right.
 *
 * COMMENTS ARE STRIPPED BEFORE SCANNING. This project has repeatedly had
 * fences match their own prose.
 */

const ROUTES_DIR = join(process.cwd(), "app", "routes");

function codeOf(file: string): string {
  return readFileSync(join(ROUTES_DIR, file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/^\s*\/\/.*$/gm, " ");
}

/** Every route file that calls the proxy verifier at all. */
const PROXY_ROUTES = readdirSync(ROUTES_DIR)
  .filter((f) => f.endsWith(".tsx") || f.endsWith(".ts"))
  .filter((f) => !f.includes(".test."))
  .filter((f) => codeOf(f).includes("verifyAppProxySignature("));

describe("App Proxy shop binding is applied by every route", () => {
  it("GUARDS THE GUARD: the route list is non-empty and includes the money-critical routes", () => {
    // A fence over an empty list passes vacuously. These four are the ones
    // D4 was raised about — they reach the Shopify Admin API.
    expect(PROXY_ROUTES.length).toBeGreaterThan(15);
    for (const required of [
      "apps.carat.bank-checkout.tsx",
      "apps.carat.group-buy-bank-checkout.tsx",
      "apps.carat.rma-intake.tsx",
      "apps.carat.beat-quote-redeem.tsx",
      "apps.carat.bank-payment-orders.tsx",
    ]) {
      expect(PROXY_ROUTES).toContain(required);
    }
  });

  it.each(PROXY_ROUTES)("%s passes getEnv().SHOPIFY_SHOP_DOMAIN as the expected shop", (file) => {
    const source = codeOf(file);

    // The call must name the env-derived shop. Whitespace-tolerant because
    // the call is formatted both on one line and across four.
    expect(
      /verifyAppProxySignature\([\s\S]{0,200}?getEnv\(\)\.SHOPIFY_SHOP_DOMAIN[\s\S]{0,40}?\)/.test(source),
      `${file} must pass getEnv().SHOPIFY_SHOP_DOMAIN to verifyAppProxySignature`
    ).toBe(true);
  });

  it.each(PROXY_ROUTES)("%s does not hardcode a shop domain or read one from the request", (file) => {
    const source = codeOf(file);

    // A literal domain would pin dev and production to the same shop.
    expect(source).not.toMatch(/verifyAppProxySignature\([\s\S]{0,200}?["'][\w-]+\.myshopify\.com["']/);

    // Headers are not signed. Fly terminates TLS and rewrites them, so
    // trusting one here would reintroduce exactly the attacker-influenceable
    // input the signed `shop` parameter exists to replace.
    expect(source).not.toMatch(/verifyAppProxySignature\([\s\S]{0,200}?x-forwarded-host/i);
    expect(source).not.toMatch(/verifyAppProxySignature\([\s\S]{0,200}?headers\.get/);
  });

  it("no route destructures a customer id without also checking `verified`", () => {
    // The verifier already nulls `loggedInCustomerId` on every refusal, so
    // this is belt-and-braces — but a route that read the id and forgot the
    // `verified` check would be reading `null` and failing closed by luck
    // rather than by design.
    for (const file of PROXY_ROUTES) {
      const source = codeOf(file);
      if (!source.includes("loggedInCustomerId")) continue;
      expect(source, `${file} must check verified`).toMatch(/if\s*\(\s*!\s*verified\s*\)/);
    }
  });
});
