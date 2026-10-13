import { describe, expect, it } from "vitest";

import type { Env } from "~/lib/env.server";

import { resolveR2Config } from "./r2Config.server";

function baseEnv(overrides: Partial<Env> = {}): Env {
  return {
    APP_ENV: "test",
    DATABASE_URL: "postgresql://example",
    SESSION_SECRET: "a".repeat(16),
    CRON_SECRET: "b".repeat(16),
    SHOPIFY_API_SECRET: "secret",
    SHOPIFY_APP_PROXY_SUBPATH: "apps/carat",
    ...overrides,
  };
}

/**
 * `resolveR2Config` mirrors `resolveEmailPort`'s honesty contract exactly
 * (`~/lib/email/configuredPort.server.test.ts`) — the R2 bucket does not
 * exist yet in any environment (`docs/specs/R2-BUCKET-SETUP.md`), so this is
 * the boundary that must stay `configured: false` until an owner sets all
 * four Fly secrets.
 */
describe("resolveR2Config — honest when unconfigured", () => {
  it("is unconfigured, naming every missing variable, when none are set", () => {
    const result = resolveR2Config(baseEnv());
    expect(result.configured).toBe(false);
    if (result.configured) throw new Error("expected unconfigured");
    expect(result.reason).toContain("STORAGE_ENDPOINT");
    expect(result.reason).toContain("STORAGE_BUCKET");
    expect(result.reason).toContain("STORAGE_ACCESS_KEY_ID");
    expect(result.reason).toContain("STORAGE_SECRET_ACCESS_KEY");
  });

  it("is unconfigured when only some variables are set", () => {
    const result = resolveR2Config(baseEnv({ STORAGE_ENDPOINT: "https://acct.r2.cloudflarestorage.com", STORAGE_BUCKET: "caratforus-evidence" }));
    expect(result.configured).toBe(false);
    if (result.configured) throw new Error("expected unconfigured");
    expect(result.reason).not.toContain("STORAGE_ENDPOINT");
    expect(result.reason).not.toContain("STORAGE_BUCKET,");
    expect(result.reason).toContain("STORAGE_ACCESS_KEY_ID");
    expect(result.reason).toContain("STORAGE_SECRET_ACCESS_KEY");
  });

  it("never fabricates a config when unconfigured", () => {
    const result = resolveR2Config(baseEnv());
    expect(result).not.toHaveProperty("config");
  });
});

describe("resolveR2Config — configured", () => {
  it("returns the four values verbatim once all are set", () => {
    const result = resolveR2Config(
      baseEnv({
        STORAGE_ENDPOINT: "https://acct123.r2.cloudflarestorage.com",
        STORAGE_BUCKET: "caratforus-evidence",
        STORAGE_ACCESS_KEY_ID: "AKIAEXAMPLE",
        STORAGE_SECRET_ACCESS_KEY: "shh-its-a-secret",
      })
    );
    expect(result.configured).toBe(true);
    if (!result.configured) throw new Error("expected configured");
    expect(result.config).toEqual({
      endpoint: "https://acct123.r2.cloudflarestorage.com",
      bucket: "caratforus-evidence",
      accessKeyId: "AKIAEXAMPLE",
      secretAccessKey: "shh-its-a-secret",
    });
  });
});
