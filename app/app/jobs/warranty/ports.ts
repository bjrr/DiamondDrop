import { randomUUID } from "node:crypto";

import type { WarrantyClaimUploadKind } from "@prisma/client";

import { getEnv, type Env } from "~/lib/env.server";
import { R2ObjectStorageClient } from "~/lib/storage/r2Client.server";
import { resolveR2Config } from "~/lib/storage/r2Config.server";

import { validateWarrantyUploadMetadata } from "./uploadValidation";

/**
 * Upload port for warranty claim evidence (Slice 5 task 5-2, spec §5).
 *
 * Mirrors `app/jobs/pricing/ports.ts` and `app/jobs/luxurysteals/ports.ts`'s
 * pattern deliberately: an interface the domain/route layer depends on, a
 * production adapter that talks to the real external system, and a
 * recording/in-memory implementation for tests.
 *
 * `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID` and
 * `STORAGE_SECRET_ACCESS_KEY` (`app/lib/env.server.ts`) are STILL empty in
 * every environment as of this writing — the Cloudflare R2 bucket D4 chose
 * (`docs/specs/R2-BUCKET-SETUP.md`) does not exist yet (spec §5, owner item
 * 1). `R2WarrantyUploadPort` below IS the production adapter, but it is
 * unreachable dead code until `resolveWarrantyUploadPort` finds all four
 * variables set — see that function. UPLOADS STAY FAIL-CLOSED until the
 * owner provisions the bucket AND the live gate under `tests/live/` proves it
 * is actually private. Never substitute Shopify Files, a public bucket, local
 * disk, or any other store when credentials are absent — see
 * `docs/specs/R2-BUCKET-SETUP.md`'s header.
 *
 * WHAT THIS PORT DOES NOT DO: it never receives or returns file bytes. Its
 * only two jobs are (1) deciding WHERE an upload should go — a storage key —
 * and (2) letting the metadata (never the bytes) be recorded afterward by
 * `warrantyClaimRepository.server.ts`'s `recordWarrantyClaimUpload`, which is
 * a separate, independently callable step, not part of this port. Keeping
 * "has an attachment" (Postgres) and "where the attachment lives" (this
 * port) separate is correct architecture regardless of whether the bucket
 * exists yet (spec §5).
 */

export interface WarrantyUploadDestinationRequest {
  /** `WarrantyClaim.id` — used only to shape the storage key, never persisted by this port. */
  readonly claimId: string;
  readonly kind: WarrantyClaimUploadKind;
  readonly contentType: string;
  readonly sizeBytes: number | bigint;
}

export interface WarrantyUploadDestination {
  /** The value that will end up in `WarrantyClaimUpload.storageKey` once the caller records it. */
  readonly storageKey: string;
  /**
   * A URL the client can upload directly to (e.g. a presigned PUT), or
   * `null` when no adapter can produce one — which is EVERY environment
   * today. A caller (task 5-3's route) must treat `null` as "uploads are not
   * yet available", not attempt to use it as a URL.
   */
  readonly uploadUrl: string | null;
  readonly expiresAt: Date | null;
}

export interface WarrantyUploadPort {
  /**
   * Validates the request's metadata (via `validateWarrantyUploadMetadata` —
   * the SAME check `recordWarrantyClaimUpload` re-applies before writing the
   * row, deliberately not trusted as "already checked by the port") and, if
   * valid, produces a destination for it. Throws
   * `InvalidWarrantyUploadMetadataError` on a request that fails validation
   * — refused before any destination is even considered, matching this
   * module's "attacker-supplied input" posture.
   */
  createUploadDestination(request: WarrantyUploadDestinationRequest): Promise<WarrantyUploadDestination>;
}

export class InvalidWarrantyUploadMetadataError extends Error {
  constructor(readonly reason: string) {
    super(`Invalid warranty claim upload metadata: ${reason}`);
    this.name = "InvalidWarrantyUploadMetadataError";
  }
}

function extensionForContentType(contentType: string): string {
  const subtype = contentType.split("/")[1] ?? "bin";
  // jpeg -> jpg is the only remapping worth bothering with; every other
  // subtype we allowlist is already a sane file extension.
  return subtype === "jpeg" ? "jpg" : subtype;
}

function buildStorageKey(claimId: string, kind: WarrantyClaimUploadKind, contentType: string): string {
  return `warranty/${claimId}/${kind}/${randomUUID()}.${extensionForContentType(contentType)}`;
}

/**
 * Shared by every `WarrantyUploadPort` implementation — throws
 * `InvalidWarrantyUploadMetadataError` on a request that fails
 * `validateWarrantyUploadMetadata`, refusing it BEFORE any destination
 * (recorded call, presigned URL, whatever the adapter produces) is even
 * considered. One place so the recording port and the real R2 adapter cannot
 * quietly drift apart on what counts as valid.
 */
function assertValidDestinationRequest(request: WarrantyUploadDestinationRequest): void {
  const validation = validateWarrantyUploadMetadata({
    kind: request.kind,
    contentType: request.contentType,
    sizeBytes: request.sizeBytes,
    // The port only knows the metadata offered BEFORE upload; a checksum is
    // only knowable once bytes exist, so it is not part of this request.
    // `recordWarrantyClaimUpload` performs the full (content type + size +
    // checksum) validation once the real object has landed and a checksum is
    // known — this earlier check exists so a caller cannot even be offered a
    // destination for a request that is already invalid on size/content-type
    // grounds alone.
    checksum: "pending",
  });
  if (!validation.ok) {
    throw new InvalidWarrantyUploadMetadataError(validation.reason);
  }
}

/**
 * Records calls instead of performing them. Tests only — this is NOT the
 * "unconfigured" production answer (see `resolveWarrantyUploadPort` for
 * that); it exists purely so domain/route tests can assert what was
 * requested without a real port. `uploadUrl`/`expiresAt` are always `null`.
 */
export class RecordingWarrantyUploadPort implements WarrantyUploadPort {
  readonly requests: WarrantyUploadDestinationRequest[] = [];

  async createUploadDestination(request: WarrantyUploadDestinationRequest): Promise<WarrantyUploadDestination> {
    assertValidDestinationRequest(request);

    this.requests.push(request);
    return {
      storageKey: buildStorageKey(request.claimId, request.kind, request.contentType),
      uploadUrl: null,
      expiresAt: null,
    };
  }
}

/**
 * THE PRODUCTION ADAPTER — Cloudflare R2 (D4), speaking the S3 API via
 * `R2ObjectStorageClient`. Only ever constructed by `resolveWarrantyUploadPort`
 * below, which is the sole gate on whether this class is reachable at all.
 *
 * Does not implement `WarrantyUploadPort` any differently from
 * `RecordingWarrantyUploadPort` in shape — same interface, same upfront
 * validation — the only difference is `uploadUrl`/`expiresAt` are real,
 * short-lived, single-object presigned values instead of `null`.
 */
export class R2WarrantyUploadPort implements WarrantyUploadPort {
  constructor(private readonly client: R2ObjectStorageClient) {}

  async createUploadDestination(request: WarrantyUploadDestinationRequest): Promise<WarrantyUploadDestination> {
    assertValidDestinationRequest(request);

    // The key is derived from `claimId` + a fresh `randomUUID()` (128 bits of
    // entropy) — knowing a claim/order reference does not let anyone
    // construct another customer's key by guessing it. The route that calls
    // this port (`apps.carat.warranty-claim-upload-destination.tsx`) is what
    // enforces that `claimId` itself belongs to the authenticated caller
    // BEFORE this is ever reached; this port has no notion of "customer".
    const storageKey = buildStorageKey(request.claimId, request.kind, request.contentType);
    const presigned = await this.client.createPresignedPutUrl({
      key: storageKey,
      contentType: request.contentType,
    });
    return { storageKey, uploadUrl: presigned.url, expiresAt: presigned.expiresAt };
  }
}

export type WarrantyUploadPortResolution =
  | { readonly configured: true; readonly port: WarrantyUploadPort }
  | { readonly configured: false; readonly reason: string };

/**
 * THE HONESTY BOUNDARY for warranty uploads — mirrors
 * `~/lib/email/configuredPort.server.ts`'s `resolveEmailPort` exactly. Every
 * caller (today: only the destination-issuing route) MUST treat
 * `configured: false` as "no upload is offered" and must never fall back to
 * `RecordingWarrantyUploadPort` or any other substitute in a request path —
 * that class exists for tests, not as a production "pretend it worked"
 * fallback. `env` is an explicit parameter purely for testability, mirroring
 * `loadEnv(source = process.env)`.
 */
export function resolveWarrantyUploadPort(env: Env = getEnv()): WarrantyUploadPortResolution {
  const configResolution = resolveR2Config(env);
  if (!configResolution.configured) {
    return { configured: false, reason: configResolution.reason };
  }
  return { configured: true, port: new R2WarrantyUploadPort(new R2ObjectStorageClient(configResolution.config)) };
}

/**
 * A short-lived presigned GET for an already-recorded `storageKey` — the
 * ONLY way this application ever reads an evidence object back (spec §5;
 * `docs/specs/R2-BUCKET-SETUP.md` §2: the bucket is private and stays
 * private). Returns `null` when storage is unconfigured, matching this
 * module's fail-closed posture rather than throwing.
 *
 * Not part of `WarrantyUploadPort` — that interface's job is destinations for
 * NEW uploads, keyed by a not-yet-existing object. Reads are keyed by an
 * ALREADY-RECORDED `WarrantyClaimUpload.storageKey`, which only makes sense
 * once that row exists, so this is a plain function rather than a port
 * method. Not yet wired into any staff-facing route (task 5-4's territory);
 * this is the capability, ready for that surface to call.
 */
export async function createWarrantyEvidenceReadUrl(storageKey: string, env: Env = getEnv()): Promise<{ readonly url: string; readonly expiresAt: Date } | null> {
  const configResolution = resolveR2Config(env);
  if (!configResolution.configured) return null;

  const client = new R2ObjectStorageClient(configResolution.config);
  return client.createPresignedGetUrl({ key: storageKey });
}
