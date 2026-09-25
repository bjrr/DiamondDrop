import { randomUUID } from "node:crypto";

import type { WarrantyClaimUploadKind } from "@prisma/client";

import { validateWarrantyUploadMetadata } from "./uploadValidation";

/**
 * Upload port for warranty claim evidence (Slice 5 task 5-2, spec §5).
 *
 * Mirrors `app/jobs/pricing/ports.ts` and `app/jobs/luxurysteals/ports.ts`'s
 * pattern deliberately: an interface the domain/route layer depends on, a
 * production adapter that talks to the real external system, and a
 * recording/in-memory implementation for tests. THIS module differs from
 * those two in one respect — there is no production adapter here, and that
 * is intentional, not an oversight:
 *
 * `STORAGE_ENDPOINT`, `STORAGE_BUCKET`, `STORAGE_ACCESS_KEY_ID` and
 * `STORAGE_SECRET_ACCESS_KEY` (`app/lib/env.server.ts`) are empty in every
 * environment today — the Cloudflare R2 bucket D4 chose does not exist yet
 * (spec §5, owner item 1). Writing a production adapter against credentials
 * that do not exist would be untestable dead code at best and a false sense
 * of "uploads work" at worst. When the bucket exists, its adapter lands
 * here as an additional class implementing `WarrantyUploadPort` — the seam
 * below is exactly what it needs and nothing else changes.
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
 * Records calls instead of performing them. Tests only — and, until a
 * production adapter exists, the only implementation of this port
 * available to wire anywhere. `uploadUrl`/`expiresAt` are always `null`,
 * matching the honest "no bucket" answer a production adapter would also
 * have to give today if one existed.
 */
export class RecordingWarrantyUploadPort implements WarrantyUploadPort {
  readonly requests: WarrantyUploadDestinationRequest[] = [];

  async createUploadDestination(request: WarrantyUploadDestinationRequest): Promise<WarrantyUploadDestination> {
    const validation = validateWarrantyUploadMetadata({
      kind: request.kind,
      contentType: request.contentType,
      sizeBytes: request.sizeBytes,
      // The port only knows the metadata offered BEFORE upload; a checksum
      // is only knowable once bytes exist, so it is not part of this
      // request. `recordWarrantyClaimUpload` performs the full
      // (content type + size + checksum) validation once the real object
      // has landed and a checksum is known — this earlier check exists so a
      // caller cannot even be offered a destination for a request that is
      // already invalid on size/content-type grounds alone.
      checksum: "pending",
    });
    if (!validation.ok) {
      throw new InvalidWarrantyUploadMetadataError(validation.reason);
    }

    this.requests.push(request);
    return {
      storageKey: buildStorageKey(request.claimId, request.kind, request.contentType),
      uploadUrl: null,
      expiresAt: null,
    };
  }
}
