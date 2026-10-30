import type { WarrantyClaimUploadKind } from "@prisma/client";

/**
 * Warranty claim upload metadata validation (Slice 5 task 5-2, spec §5,
 * docs/WARRANTY-CLAIMS.md §2 "photo uploads"/"video upload where
 * practical/useful").
 *
 * PURE — no I/O, no storage dependency. Deliberately lives under
 * `app/jobs/warranty/` rather than `app/domain/warranty/` (task 5-1's
 * territory, out of this task's scope) even though it has no side effects,
 * because it is boundary/attacker-input validation for the upload PORT
 * (spec §5), not a business rule about claim status or money.
 *
 * A claim photo/video is attacker-supplied input arriving from a public
 * form (task 5-3's eventual intake route) before any authenticated staff
 * review happens, so every field here is validated independently and
 * strictly — no bucket exists to reject anything on our behalf (spec §5,
 * owner item 1: all four `STORAGE_*` variables are empty in every
 * environment).
 *
 * Used by BOTH `ports.ts`'s `createUploadDestination` (before a destination
 * is even offered) and `warrantyClaimRepository.server.ts`'s
 * `recordWarrantyClaimUpload` (again, immediately before the metadata row is
 * written) — one allowlist/ceiling, checked at both the "where do I put
 * this" step and the "record what actually landed" step, rather than two
 * lists that could quietly drift apart.
 *
 * SIZE CEILINGS ARE MVP1 OPERATIONAL DEFAULTS, NOT LOCKED POLICY.
 * `WARRANTY-CLAIMS.md` specifies no exact byte limits — these are a
 * reasonable, generous starting point for phone-captured photos/video
 * (`WARRANTY_CLAIM_UPLOAD_MAX_SIZE_BYTES`, exported so a future admin
 * setting or owner-approved change can move them without touching call
 * sites that only need "is this within the current ceiling").
 */

export const WARRANTY_CLAIM_UPLOAD_MAX_SIZE_BYTES: Readonly<Record<WarrantyClaimUploadKind, bigint>> = {
  photo: 20_000_000n, // 20 MB — comfortably above a typical phone photo.
  video: 300_000_000n, // 300 MB — a few minutes of phone video at high resolution.
  // 25 MB — a jeweller's quote is a few pages; anything larger is a scan at
  // a resolution nobody needs, not a document we are refusing to read.
  document: 25_000_000n,
};

/**
 * Content types accepted per upload kind. Deliberately an allowlist, not a
 * denylist: an unrecognised or attacker-crafted content type is refused by
 * default rather than let through because it wasn't on a blocklist.
 */
export const WARRANTY_CLAIM_UPLOAD_ALLOWED_CONTENT_TYPES: Readonly<Record<WarrantyClaimUploadKind, readonly string[]>> = {
  photo: ["image/jpeg", "image/png", "image/webp", "image/heic", "image/heif"],
  video: ["video/mp4", "video/quicktime", "video/webm"],
  /**
   * PDF only.
   *
   * A written jewelry quote arrives as a PDF or as a photograph of a printed
   * one — and the photograph case is already served by `photo`, which is why
   * this list stays at one entry instead of duplicating the image types.
   *
   * Word documents are deliberately absent. A .doc/.docx is an executable
   * container as far as macros are concerned, and accepting one would mean
   * taking on a malware-handling problem for a format no jeweller issues a
   * quote in. If a customer only has a Word file they can print it to PDF or
   * photograph it.
   */
  document: ["application/pdf"],
};

export interface WarrantyUploadMetadataInput {
  readonly kind: WarrantyClaimUploadKind;
  readonly contentType: string;
  /** Accepts `number` or `bigint` — callers off a multipart/form parser typically hand back a `number`; the repository's Prisma column is `BigInt`. */
  readonly sizeBytes: number | bigint;
  readonly checksum: string;
}

export type WarrantyUploadValidationResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

function fail(reason: string): WarrantyUploadValidationResult {
  return { ok: false, reason };
}

/**
 * Validates exactly what spec §5 says is checkable without a bucket:
 * content type against the allowlist for the declared `kind`, a size
 * ceiling, and a non-empty checksum. Does NOT verify the checksum actually
 * matches the bytes (there are no bytes here to hash against — this module
 * never touches them) — that remains a property the storage adapter and/or
 * client-side capture flow must uphold once credentials exist.
 */
export function validateWarrantyUploadMetadata(input: WarrantyUploadMetadataInput): WarrantyUploadValidationResult {
  const allowedContentTypes = WARRANTY_CLAIM_UPLOAD_ALLOWED_CONTENT_TYPES[input.kind];
  if (!allowedContentTypes) {
    return fail(`unrecognised upload kind "${input.kind}"`);
  }
  if (!allowedContentTypes.includes(input.contentType)) {
    return fail(
      `content type "${input.contentType}" is not allowed for a "${input.kind}" upload (allowed: ${allowedContentTypes.join(", ")})`
    );
  }

  // Not a money value — `sizeBytes` is a byte count — but a plain
  // `Number.isInteger` check (no `Math.trunc`/`round`/`floor`/`ceil`) keeps
  // this file clean of every operator the money-safety lint rule forbids,
  // so a reviewer scanning for a stray rounding call never has to stop and
  // check whether this one is actually money.
  if (typeof input.sizeBytes === "number" && !Number.isInteger(input.sizeBytes)) {
    return fail(`sizeBytes "${input.sizeBytes}" is not a valid integer`);
  }
  let sizeBytes: bigint;
  try {
    sizeBytes = typeof input.sizeBytes === "bigint" ? input.sizeBytes : BigInt(input.sizeBytes);
  } catch {
    return fail(`sizeBytes "${String(input.sizeBytes)}" is not a valid integer`);
  }
  if (sizeBytes <= 0n) {
    return fail("sizeBytes must be a positive integer");
  }
  const ceiling = WARRANTY_CLAIM_UPLOAD_MAX_SIZE_BYTES[input.kind];
  if (sizeBytes > ceiling) {
    return fail(`sizeBytes ${sizeBytes} exceeds the ${ceiling}-byte ceiling for a "${input.kind}" upload`);
  }

  if (input.checksum.trim().length === 0) {
    return fail("checksum must not be empty");
  }

  return { ok: true };
}
