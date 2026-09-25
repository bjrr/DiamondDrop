import { describe, expect, it } from "vitest";

import { InvalidWarrantyUploadMetadataError, RecordingWarrantyUploadPort } from "./ports";

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
