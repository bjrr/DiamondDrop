import { describe, expect, it } from "vitest";

import { R2_GET_URL_EXPIRY_SECONDS, R2_PUT_URL_EXPIRY_SECONDS, R2ObjectStorageClient } from "./r2Client.server";

/**
 * Presigning (SigV4 query-string signing) is pure local computation — no
 * network call is made. That means these tests exercise the REAL AWS SDK
 * signing logic against dummy, non-functional credentials/endpoint rather
 * than a hand-built fake, which is more faithful than mocking the SDK: a
 * bug in how this class calls the SDK (wrong bucket, wrong key, wrong
 * expiry, an unpinned content type) shows up in the actual computed URL.
 * Never a real network request, so this needs no bucket to exist.
 */
function testClient(): R2ObjectStorageClient {
  return new R2ObjectStorageClient({
    endpoint: "https://acct123.r2.cloudflarestorage.com",
    bucket: "caratforus-evidence",
    accessKeyId: "AKIAEXAMPLE",
    secretAccessKey: "shh-its-a-secret",
  });
}

describe("R2ObjectStorageClient.createPresignedPutUrl", () => {
  it("addresses the configured bucket and the exact key, virtual-hosted style", async () => {
    const client = testClient();
    const { url } = await client.createPresignedPutUrl({ key: "warranty/claim-1/photo/abc123.jpg", contentType: "image/jpeg" });
    const parsed = new URL(url);
    expect(parsed.hostname).toBe("caratforus-evidence.acct123.r2.cloudflarestorage.com");
    expect(parsed.pathname).toBe("/warranty/claim-1/photo/abc123.jpg");
  });

  it("pins the content type into the signature via SignedHeaders", async () => {
    const client = testClient();
    const { url } = await client.createPresignedPutUrl({ key: "warranty/claim-1/photo/abc123.jpg", contentType: "image/jpeg" });
    const signedHeaders = new URL(url).searchParams.get("X-Amz-SignedHeaders");
    expect(signedHeaders).toContain("content-type");
  });

  it("defaults to the 15-minute expiry constant", async () => {
    const client = testClient();
    const before = Date.now();
    const { url, expiresAt } = await client.createPresignedPutUrl({ key: "warranty/claim-1/photo/abc123.jpg", contentType: "image/jpeg" });
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe(String(R2_PUT_URL_EXPIRY_SECONDS));
    expect(expiresAt.getTime()).toBeGreaterThanOrEqual(before + R2_PUT_URL_EXPIRY_SECONDS * 1000);
    expect(expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + R2_PUT_URL_EXPIRY_SECONDS * 1000);
  });

  it("honours an explicit shorter expiry", async () => {
    const client = testClient();
    const { url } = await client.createPresignedPutUrl({ key: "k", contentType: "image/png", expiresInSeconds: 30 });
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe("30");
  });

  it("never attaches an auto-computed checksum query param (would break any non-empty real upload — see this class's constructor comment)", async () => {
    const client = testClient();
    const { url } = await client.createPresignedPutUrl({ key: "warranty/claim-1/photo/abc123.jpg", contentType: "image/jpeg" });
    const params = new URL(url).searchParams;
    expect(params.has("x-amz-checksum-crc32")).toBe(false);
    expect(params.has("x-amz-sdk-checksum-algorithm")).toBe(false);
  });

  it("produces a distinct signature for a different key (proves the key is actually bound into the signed request, not decorative)", async () => {
    const client = testClient();
    const first = await client.createPresignedPutUrl({ key: "warranty/claim-1/photo/a.jpg", contentType: "image/jpeg" });
    const second = await client.createPresignedPutUrl({ key: "warranty/claim-2/photo/a.jpg", contentType: "image/jpeg" });
    expect(new URL(first.url).searchParams.get("X-Amz-Signature")).not.toBe(new URL(second.url).searchParams.get("X-Amz-Signature"));
  });
});

describe("R2ObjectStorageClient.createPresignedGetUrl", () => {
  it("addresses the configured bucket and the exact key", async () => {
    const client = testClient();
    const { url } = await client.createPresignedGetUrl({ key: "warranty/claim-1/photo/abc123.jpg" });
    const parsed = new URL(url);
    expect(parsed.hostname).toBe("caratforus-evidence.acct123.r2.cloudflarestorage.com");
    expect(parsed.pathname).toBe("/warranty/claim-1/photo/abc123.jpg");
  });

  it("defaults to the 5-minute expiry constant, shorter than a PUT's", async () => {
    const client = testClient();
    const { url } = await client.createPresignedGetUrl({ key: "k" });
    expect(new URL(url).searchParams.get("X-Amz-Expires")).toBe(String(R2_GET_URL_EXPIRY_SECONDS));
    expect(R2_GET_URL_EXPIRY_SECONDS).toBeLessThan(R2_PUT_URL_EXPIRY_SECONDS);
  });

  it("does not pin a content type (a GET has no request body to pin one against)", async () => {
    const client = testClient();
    const { url } = await client.createPresignedGetUrl({ key: "k" });
    const signedHeaders = new URL(url).searchParams.get("X-Amz-SignedHeaders") ?? "";
    expect(signedHeaders).not.toContain("content-type");
  });
});
