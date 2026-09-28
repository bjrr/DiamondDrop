import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

import type { R2Config } from "./r2Config.server";

/**
 * Thin wrapper around the AWS S3 SDK, pointed at Cloudflare R2 (D4). R2
 * speaks the S3 API, so `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`
 * are used rather than hand-rolled SigV4 signing (easy to get subtly wrong).
 * Neither package existed in this project's dependency tree before this file
 * — added specifically for this adapter (`package.json`).
 *
 * `region: "auto"` and an endpoint with NO bucket segment matches R2's own
 * quickstart shape and `docs/specs/R2-BUCKET-SETUP.md` §5's note that
 * `STORAGE_ENDPOINT` is "the account-level S3 endpoint without the bucket
 * name appended" — the SDK addresses the bucket via virtual-hosted-style
 * (`<bucket>.<accountid>.r2.cloudflarestorage.com`), which is what R2
 * documents for aws-sdk-js v3. THIS IS UNVERIFIED AGAINST A REAL BUCKET —
 * no bucket exists yet. The live gate under `tests/live/` proves or disproves
 * it the day credentials exist; if it fails with a hostname/DNS error rather
 * than an auth error, flip to `forcePathStyle: true` here first.
 *
 * Presigning (`getSignedUrl`) is pure local computation (SigV4 over the
 * request + credentials + a clock) — it makes NO network call. That is what
 * makes this class unit-testable with real signing logic and dummy
 * credentials (see `r2Client.server.test.ts`): no fake/mock S3 client is
 * needed to prove key/expiry/content-type-pinning behaviour, only care not to
 * exercise `send()` (the one method that actually reaches the network).
 */
export const R2_PUT_URL_EXPIRY_SECONDS = 15 * 60; // 15 minutes — generous enough for a slow mobile upload near the 300MB video ceiling, short enough that a leaked URL is worthless soon after.
export const R2_GET_URL_EXPIRY_SECONDS = 5 * 60; // 5 minutes — a staff review read, never a durable/shareable link.

export interface PresignedUrl {
  readonly url: string;
  readonly expiresAt: Date;
}

export class R2ObjectStorageClient {
  private readonly s3: S3Client;
  private readonly bucket: string;

  constructor(config: R2Config) {
    this.bucket = config.bucket;
    this.s3 = new S3Client({
      region: "auto",
      endpoint: config.endpoint,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
      // WITHOUT THIS, EVERY PRESIGNED PUT IS BROKEN. `@aws-sdk/client-s3`
      // defaults `requestChecksumCalculation` to `WHEN_SUPPORTED`, which
      // silently attaches `x-amz-checksum-crc32` / `x-amz-sdk-checksum-
      // algorithm` query params to the presigned URL, computed against an
      // EMPTY body (no `Body` exists yet at presign time — the whole point of
      // a PUT destination is that the bytes arrive later, from the browser).
      // Confirmed by hand: presigning identically without this option
      // produces `x-amz-checksum-crc32=AAAAAA%3D%3D` (CRC32 of zero bytes) in
      // the URL. R2 is checksum-validating against that param, so ANY
      // non-empty upload — i.e. every real one — would fail with a checksum
      // mismatch the SDK itself silently set up. `WHEN_REQUIRED` (only
      // compute/require a checksum when the operation demands one, which
      // PutObject does not) removes those params entirely. Reproduce by
      // presigning with and without this line and diffing the query string.
      requestChecksumCalculation: "WHEN_REQUIRED",
    });
  }

  /**
   * A presigned PUT scoped to a single object key and pinned to a single
   * content type — `signableHeaders` forces `content-type` into the SigV4
   * signature, so a client cannot swap the declared type after the fact by
   * sending a different `Content-Type` header than the one this destination
   * was issued for. `docs/specs/R2-BUCKET-SETUP.md` §4's CORS policy allows
   * exactly the `content-type` request header for this reason.
   */
  async createPresignedPutUrl(params: { readonly key: string; readonly contentType: string; readonly expiresInSeconds?: number }): Promise<PresignedUrl> {
    const expiresInSeconds = params.expiresInSeconds ?? R2_PUT_URL_EXPIRY_SECONDS;
    const command = new PutObjectCommand({ Bucket: this.bucket, Key: params.key, ContentType: params.contentType });
    const url = await getSignedUrl(this.s3, command, {
      expiresIn: expiresInSeconds,
      signableHeaders: new Set(["content-type"]),
    });
    return { url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
  }

  /** A short-lived presigned GET. The bucket stays private; this is the only way the application ever reads an object back. */
  async createPresignedGetUrl(params: { readonly key: string; readonly expiresInSeconds?: number }): Promise<PresignedUrl> {
    const expiresInSeconds = params.expiresInSeconds ?? R2_GET_URL_EXPIRY_SECONDS;
    const command = new GetObjectCommand({ Bucket: this.bucket, Key: params.key });
    const url = await getSignedUrl(this.s3, command, { expiresIn: expiresInSeconds });
    return { url, expiresAt: new Date(Date.now() + expiresInSeconds * 1000) };
  }
}
