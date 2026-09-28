import { describe, expect, it } from "vitest";

import type { Env } from "~/lib/env.server";

import {
  createWarrantyEvidenceReadUrl,
  InvalidWarrantyUploadMetadataError,
  R2WarrantyUploadPort,
  RecordingWarrantyUploadPort,
  resolveWarrantyUploadPort,
} from "./ports";

/**
 * Slice 5 task 5-2 — the upload port's recording/test implementation. No
 * production adapter exists yet (spec §5, owner item 1 — `STORAGE_*` is
 * empty in every environment); see `ports.ts`'s module comment.
 */
describe("RecordingWarrantyUploadPort", () => {
  it("produces a destination for a valid request and records the call", async () => {
    const port = new RecordingWarrantyUploadPort();
    const destination = await port.createUploadDestination({
      claimId: "11111111-1111-1111-1111-111111111111",
      kind: "photo",
      contentType: "image/jpeg",
      sizeBytes: 1_000_000,
    });

    expect(destination.storageKey).toContain("warranty/11111111-1111-1111-1111-111111111111/photo/");
    expect(destination.storageKey.endsWith(".jpg")).toBe(true);
    // No bucket exists in any environment yet — see ports.ts's module comment.
    expect(destination.uploadUrl).toBeNull();
    expect(destination.expiresAt).toBeNull();
    expect(port.requests).toHaveLength(1);
  });

  it("produces distinct storage keys for repeated requests against the same claim", async () => {
    const port = new RecordingWarrantyUploadPort();
    const request = { claimId: "claim-1", kind: "photo" as const, contentType: "image/jpeg", sizeBytes: 1_000 };
    const first = await port.createUploadDestination(request);
    const second = await port.createUploadDestination(request);
    expect(first.storageKey).not.toBe(second.storageKey);
  });

  it("refuses an invalid content type before offering a destination, and does not record the call", async () => {
    const port = new RecordingWarrantyUploadPort();
    await expect(
      port.createUploadDestination({
        claimId: "claim-1",
        kind: "photo",
        contentType: "application/pdf",
        sizeBytes: 1_000,
      })
    ).rejects.toThrow(InvalidWarrantyUploadMetadataError);
    expect(port.requests).toHaveLength(0);
  });

  it("refuses an oversized request before offering a destination", async () => {
    const port = new RecordingWarrantyUploadPort();
    await expect(
      port.createUploadDestination({
        claimId: "claim-1",
        kind: "photo",
        contentType: "image/jpeg",
        sizeBytes: 1_000_000_000,
      })
    ).rejects.toThrow(InvalidWarrantyUploadMetadataError);
    expect(port.requests).toHaveLength(0);
  });
});

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

const CONFIGURED_ENV = baseEnv({
  STORAGE_ENDPOINT: "https://acct123.r2.cloudflarestorage.com",
  STORAGE_BUCKET: "caratforus-evidence",
  STORAGE_ACCESS_KEY_ID: "AKIAEXAMPLE",
  STORAGE_SECRET_ACCESS_KEY: "shh-its-a-secret",
});

/**
 * `resolveWarrantyUploadPort` — the fail-closed boundary the R2 adapter task
 * exists to add. Every environment today has all four `STORAGE_*` variables
 * empty (`docs/specs/R2-BUCKET-SETUP.md`), so the "unconfigured" branch is
 * what production actually exercises; `CONFIGURED_ENV` above is the ONLY way
 * this test file reaches the R2-backed branch — no real bucket is ever
 * touched (presigning is pure local computation, see `r2Client.server.
 * test.ts`).
 */
describe("resolveWarrantyUploadPort — fail-closed when storage is unconfigured", () => {
  it("reports unconfigured, naming every missing variable, when none are set", () => {
    const result = resolveWarrantyUploadPort(baseEnv());
    expect(result.configured).toBe(false);
    if (result.configured) throw new Error("expected unconfigured");
    expect(result.reason).toContain("STORAGE_ENDPOINT");
    expect(result.reason).toContain("STORAGE_BUCKET");
    expect(result.reason).toContain("STORAGE_ACCESS_KEY_ID");
    expect(result.reason).toContain("STORAGE_SECRET_ACCESS_KEY");
  });

  it("never fabricates a port when unconfigured — no RecordingWarrantyUploadPort fallback, no null-uploadUrl port, nothing", () => {
    const result = resolveWarrantyUploadPort(baseEnv());
    expect(result).not.toHaveProperty("port");
  });

  it("stays unconfigured when only some variables are set", () => {
    const result = resolveWarrantyUploadPort(baseEnv({ STORAGE_ENDPOINT: "https://acct123.r2.cloudflarestorage.com" }));
    expect(result.configured).toBe(false);
  });
});

describe("resolveWarrantyUploadPort — configured", () => {
  it("returns a real R2WarrantyUploadPort once all four variables are set", () => {
    const result = resolveWarrantyUploadPort(CONFIGURED_ENV);
    expect(result.configured).toBe(true);
    if (!result.configured) throw new Error("expected configured");
    expect(result.port).toBeInstanceOf(R2WarrantyUploadPort);
  });
});

describe("R2WarrantyUploadPort — the production adapter", () => {
  it("produces a real presigned PUT URL and a matching storage key", async () => {
    const result = resolveWarrantyUploadPort(CONFIGURED_ENV);
    if (!result.configured) throw new Error("expected configured");

    const destination = await result.port.createUploadDestination({
      claimId: "11111111-1111-1111-1111-111111111111",
      kind: "photo",
      contentType: "image/jpeg",
      sizeBytes: 1_000_000,
    });

    expect(destination.storageKey).toContain("warranty/11111111-1111-1111-1111-111111111111/photo/");
    expect(destination.uploadUrl).not.toBeNull();
    // The presigned URL's path must be the EXACT storage key that was
    // returned to the caller — proves the two are not just coincidentally
    // similar but the same object.
    expect(new URL(destination.uploadUrl!).pathname).toBe(`/${destination.storageKey}`);
    expect(destination.expiresAt).not.toBeNull();
  });

  it("refuses an invalid content type before ever calling R2, exactly like the recording port", async () => {
    const result = resolveWarrantyUploadPort(CONFIGURED_ENV);
    if (!result.configured) throw new Error("expected configured");

    await expect(
      result.port.createUploadDestination({
        claimId: "claim-1",
        kind: "photo",
        contentType: "application/pdf",
        sizeBytes: 1_000,
      })
    ).rejects.toThrow(InvalidWarrantyUploadMetadataError);
  });

  it("refuses an oversized request before ever calling R2", async () => {
    const result = resolveWarrantyUploadPort(CONFIGURED_ENV);
    if (!result.configured) throw new Error("expected configured");

    await expect(
      result.port.createUploadDestination({
        claimId: "claim-1",
        kind: "video",
        contentType: "video/mp4",
        sizeBytes: 1_000_000_000_000,
      })
    ).rejects.toThrow(InvalidWarrantyUploadMetadataError);
  });

  it("produces distinct storage keys and distinct signed URLs for repeated requests against the same claim", async () => {
    const result = resolveWarrantyUploadPort(CONFIGURED_ENV);
    if (!result.configured) throw new Error("expected configured");

    const request = { claimId: "claim-1", kind: "photo" as const, contentType: "image/jpeg", sizeBytes: 1_000 };
    const first = await result.port.createUploadDestination(request);
    const second = await result.port.createUploadDestination(request);
    expect(first.storageKey).not.toBe(second.storageKey);
    expect(first.uploadUrl).not.toBe(second.uploadUrl);
  });
});

describe("createWarrantyEvidenceReadUrl", () => {
  it("returns null when storage is unconfigured — fail-closed, matches the port's own posture", async () => {
    const result = await createWarrantyEvidenceReadUrl("warranty/claim-1/photo/abc.jpg", baseEnv());
    expect(result).toBeNull();
  });

  it("returns a real short-lived presigned GET once configured", async () => {
    const result = await createWarrantyEvidenceReadUrl("warranty/claim-1/photo/abc.jpg", CONFIGURED_ENV);
    expect(result).not.toBeNull();
    expect(result!.url).toContain("warranty/claim-1/photo/abc.jpg");
    expect(result!.expiresAt).toBeInstanceOf(Date);
  });
});
