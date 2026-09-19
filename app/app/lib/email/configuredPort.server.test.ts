import { describe, expect, it } from "vitest";

import type { Env } from "~/lib/env.server";

import { resolveEmailPort } from "./configuredPort.server";
import { ResendEmailPort } from "./resendAdapter.server";

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

describe("resolveEmailPort — honest when unconfigured", () => {
  it("is unconfigured, naming every missing variable, when none are set", () => {
    const result = resolveEmailPort(baseEnv());
    expect(result.configured).toBe(false);
    if (result.configured) throw new Error("expected unconfigured");
    expect(result.reason).toContain("EMAIL_API_KEY");
    expect(result.reason).toContain("EMAIL_FROM");
    expect(result.reason).toContain("STAFF_EMAIL_ALLOWLIST");
  });

  it("is unconfigured when only some variables are set", () => {
    const result = resolveEmailPort(baseEnv({ EMAIL_API_KEY: "re_123" }));
    expect(result.configured).toBe(false);
    if (result.configured) throw new Error("expected unconfigured");
    expect(result.reason).not.toContain("EMAIL_API_KEY");
    expect(result.reason).toContain("EMAIL_FROM");
    expect(result.reason).toContain("STAFF_EMAIL_ALLOWLIST");
  });

  it("is unconfigured when the allowlist is set but empty after parsing", () => {
    const result = resolveEmailPort(
      baseEnv({
        EMAIL_API_KEY: "re_123",
        EMAIL_FROM: "alerts@caratforus.example",
        STAFF_EMAIL_ALLOWLIST: " , ,  ",
      })
    );
    expect(result.configured).toBe(false);
    if (result.configured) throw new Error("expected unconfigured");
    expect(result.reason).toContain("STAFF_EMAIL_ALLOWLIST is empty");
  });

  it("never fabricates a port when unconfigured", () => {
    const result = resolveEmailPort(baseEnv());
    expect(result).not.toHaveProperty("port");
  });
});

describe("resolveEmailPort — configured", () => {
  it("returns a real ResendEmailPort, the parsed sender and the trimmed, non-empty recipient list", () => {
    const result = resolveEmailPort(
      baseEnv({
        EMAIL_API_KEY: "re_123",
        EMAIL_FROM: "alerts@caratforus.example",
        STAFF_EMAIL_ALLOWLIST: " staff1@example.com, staff2@example.com ,,",
      })
    );
    expect(result.configured).toBe(true);
    if (!result.configured) throw new Error("expected configured");
    expect(result.port).toBeInstanceOf(ResendEmailPort);
    expect(result.from).toBe("alerts@caratforus.example");
    expect(result.recipients).toEqual(["staff1@example.com", "staff2@example.com"]);
  });
});
