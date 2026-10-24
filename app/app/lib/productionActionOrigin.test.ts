import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { PRODUCTION_APP_HOST } from "./productionActionOrigin";

const toml = readFileSync(
  fileURLToPath(new URL("../../shopify.app.caratforus-development.toml", import.meta.url)),
  "utf8"
);

function tomlUrl(key: string): string {
  const match = toml.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]+)"`, "m"));
  if (!match?.[1]) throw new Error(`${key} not found in the app TOML`);
  return match[1];
}

describe("production action origin (D11)", () => {
  it("is exactly the host the Shopify app is served from", () => {
    // If the app moves host, the allowlist must move with it — otherwise every
    // embedded-admin save fails again with a bare "Bad Request".
    expect(PRODUCTION_APP_HOST).toBe(new URL(tomlUrl("application_url")).host);
  });

  it("is a single concrete host, never a pattern or a URL", () => {
    expect(PRODUCTION_APP_HOST).not.toContain("*");
    expect(PRODUCTION_APP_HOST).not.toContain("/");
    expect(PRODUCTION_APP_HOST).toMatch(/^[a-z0-9.-]+$/);
  });
});
