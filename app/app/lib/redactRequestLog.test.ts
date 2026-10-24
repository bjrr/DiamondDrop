import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * D9 (Launch Blocker Register): the production request log printed Shopify
 * session tokens, HMACs and App Proxy customer ids, because react-router-serve
 * always installs morgan("tiny") and its `:url` token is the full originalUrl.
 *
 * These tests drive the REAL morgan "tiny" format through morgan's own
 * compiler — the same path react-router-serve's middleware takes — so they
 * prove what the log line would actually contain, not what a helper returns.
 */
// Loaded through CommonJS exactly as production does: react-router-serve's
// CJS build require()s morgan, and the preload require()s the same instance.
const load = createRequire(import.meta.url);
const morgan = load("morgan");
load("../../server/redactRequestLog.cjs");

function tinyLine(url: string): string {
  const format = morgan.compile(morgan.tiny);
  const req = { method: "GET", originalUrl: url, url, headers: {} };
  const res = { headersSent: true, statusCode: 200, getHeader: () => undefined };
  return format(morgan, req, res);
}

describe("request log redaction (D9)", () => {
  it("drops an embedded-admin query string: no id_token, hmac or session", () => {
    const line = tinyLine(
      "/app/pricing-settings?embedded=1&hmac=abc123&host=xyz&id_token=eyJhbGciOiJIUzI1NiJ9.payload.sig&session=deadbeef&shop=example.myshopify.com",
    );

    expect(line).toContain("GET /app/pricing-settings 200");
    expect(line).not.toContain("id_token");
    expect(line).not.toContain("eyJ");
    expect(line).not.toContain("hmac");
    expect(line).not.toContain("session=");
    expect(line).not.toContain("?");
  });

  it("drops an App Proxy signature and logged-in customer id", () => {
    const line = tinyLine(
      "/apps/carat/policies?shop=example.myshopify.com&logged_in_customer_id=1234567&path_prefix=%2Fapps%2Fcarat&timestamp=1&signature=f00d",
    );

    expect(line).toContain("GET /apps/carat/policies 200");
    expect(line).not.toContain("logged_in_customer_id");
    expect(line).not.toContain("1234567");
    expect(line).not.toContain("signature");
  });

  it("leaves a URL without a query string unchanged", () => {
    expect(tinyLine("/health")).toContain("GET /health 200");
  });

  it("is actually loaded by the production server command", () => {
    // The redaction only exists if the preload runs. A Dockerfile edit that
    // drops it would silently restore token logging, so pin it here.
    const dockerfile = readFileSync(
      fileURLToPath(new URL("../../Dockerfile", import.meta.url)),
      "utf8",
    );
    const cmd = dockerfile.split("\n").find((l) => l.startsWith("CMD "));

    expect(cmd).toBeDefined();
    expect(cmd).toContain('"--require", "./server/redactRequestLog.cjs"');
    expect(cmd).toContain("node_modules/@react-router/serve/bin.js");
    expect(dockerfile).toMatch(/COPY --from=build \/app\/server \.\/server/);
  });
});
