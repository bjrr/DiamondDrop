import { describe, expect, it } from "vitest";

import {
  WARRANTY_CLAIM_UPLOAD_MAX_SIZE_BYTES,
  validateWarrantyUploadMetadata,
} from "./uploadValidation";

/**
 * Slice 5 task 5-2 — pure metadata validation for warranty claim uploads
 * (spec §5). No database, no I/O.
 */
describe("validateWarrantyUploadMetadata", () => {
  it("accepts a well-formed photo", () => {
    expect(
      validateWarrantyUploadMetadata({
        kind: "photo",
        contentType: "image/jpeg",
        sizeBytes: 2_000_000,
        checksum: "sha256:abc123",
      })
    ).toEqual({ ok: true });
  });

  it("accepts a well-formed video", () => {
    expect(
      validateWarrantyUploadMetadata({
        kind: "video",
        contentType: "video/mp4",
        sizeBytes: 50_000_000,
        checksum: "sha256:def456",
      })
    ).toEqual({ ok: true });
  });

  it("rejects a content type not on the allowlist for the declared kind", () => {
    const result = validateWarrantyUploadMetadata({
      kind: "photo",
      contentType: "application/pdf",
      sizeBytes: 1_000,
      checksum: "sha256:abc",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a video content type declared as a photo (kind/content-type mismatch)", () => {
    const result = validateWarrantyUploadMetadata({
      kind: "photo",
      contentType: "video/mp4",
      sizeBytes: 1_000,
      checksum: "sha256:abc",
    });
    expect(result.ok).toBe(false);
  });

  it("rejects a photo over the size ceiling", () => {
    const ceiling = WARRANTY_CLAIM_UPLOAD_MAX_SIZE_BYTES.photo;
    const result = validateWarrantyUploadMetadata({
      kind: "photo",
      contentType: "image/jpeg",
      sizeBytes: ceiling + 1n,
      checksum: "sha256:abc",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toMatch(/ceiling/);
  });

  it("rejects a video over the size ceiling", () => {
    const ceiling = WARRANTY_CLAIM_UPLOAD_MAX_SIZE_BYTES.video;
    const result = validateWarrantyUploadMetadata({
      kind: "video",
      contentType: "video/mp4",
      sizeBytes: ceiling + 1n,
      checksum: "sha256:abc",
    });
    expect(result.ok).toBe(false);
  });

  it("accepts a size exactly at the ceiling (inclusive boundary)", () => {
    const ceiling = WARRANTY_CLAIM_UPLOAD_MAX_SIZE_BYTES.photo;
    expect(
      validateWarrantyUploadMetadata({
        kind: "photo",
        contentType: "image/jpeg",
        sizeBytes: ceiling,
        checksum: "sha256:abc",
      })
    ).toEqual({ ok: true });
  });

  it("rejects a zero or negative size", () => {
    expect(
      validateWarrantyUploadMetadata({ kind: "photo", contentType: "image/jpeg", sizeBytes: 0, checksum: "sha256:abc" }).ok
    ).toBe(false);
    expect(
      validateWarrantyUploadMetadata({ kind: "photo", contentType: "image/jpeg", sizeBytes: -5, checksum: "sha256:abc" }).ok
    ).toBe(false);
  });

  it("rejects a non-integer size", () => {
    expect(
      validateWarrantyUploadMetadata({ kind: "photo", contentType: "image/jpeg", sizeBytes: 100.5, checksum: "sha256:abc" }).ok
    ).toBe(false);
  });

  it("rejects an empty or whitespace-only checksum", () => {
    expect(
      validateWarrantyUploadMetadata({ kind: "photo", contentType: "image/jpeg", sizeBytes: 100, checksum: "" }).ok
    ).toBe(false);
    expect(
      validateWarrantyUploadMetadata({ kind: "photo", contentType: "image/jpeg", sizeBytes: 100, checksum: "   " }).ok
    ).toBe(false);
  });
});
