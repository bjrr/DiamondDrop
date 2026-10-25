import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { getWarrantyClaimForCustomer } from "~/db/repositories/warrantyClaimRepository.server";
import { recordIssuedUploadDestination } from "~/db/repositories/uploadDestinationRepository.server";
import type { WarrantyUploadPortResolution } from "~/jobs/warranty/ports";
import { InvalidWarrantyUploadMetadataError, resolveWarrantyUploadPort } from "~/jobs/warranty/ports";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * POST /apps/carat/warranty-claim-upload-destination — issues a presigned
 * destination for ONE piece of warranty claim evidence (R2 adapter task,
 * `docs/specs/SLICE-5-WARRANTY-CLAIMS.md` §5).
 *
 * A RESOURCE ROUTE — no default export. Same `allowedActionOrigins: []`
 * reasoning as `apps.carat.warranty-claim.tsx` (see `csrfResourceRouteFence.
 * test.ts`, which enforces this mechanically for every `apps.carat.*` file).
 *
 * ============================================================================
 * WHY THIS ROUTE EXISTS SEPARATELY FROM THE INTAKE ROUTE
 * ============================================================================
 * `~/jobs/warranty/ports.ts`'s `WarrantyUploadPort.createUploadDestination`
 * needs a `claimId` to shape the storage key, but a claim's evidence is
 * gathered in the browser before/while the intake form is filled out — the
 * two happen over separate HTTP round-trips. This route is the ONLY caller of
 * `createUploadDestination` anywhere in the app; `apps.carat.warranty-claim.
 * tsx` never issues a destination itself, only records whatever metadata this
 * route already vetted (see that file's `uploadSchema` comment).
 *
 * ============================================================================
 * AUTHENTICATION + OWNERSHIP — THE PART THAT MATTERS MOST HERE
 * ============================================================================
 * "An endpoint that mints presigned PUTs for anyone is a free file-hosting
 * service on our account" (assigning message). This route:
 *   - Requires a signed App Proxy request carrying `logged_in_customer_id` —
 *     an anonymous caller is refused with 401 BEFORE the body is parsed,
 *     exactly like `apps.carat.warranty-claim.tsx` and `apps.carat.
 *     rma-intake.tsx` (docs/REQUIRED-CUSTOMER-ACCOUNTS.md).
 *   - Resolves `claimId` via `getWarrantyClaimForCustomer` (the customer-safe
 *     projection — never the staff view). A REAL claim belonging to someone
 *     ELSE is refused. A `claimId` that does not resolve to any claim yet is
 *     ALLOWED THROUGH — see "WHY A NOT-YET-EXISTING CLAIM ID IS ALLOWED"
 *     below. Both a real "not yours" claim and a genuinely-nonexistent one
 *     that turns out to belong to someone else by the time it is consumed
 *     are refused with the SAME generic response elsewhere in the pipeline
 *     (`apps.carat.warranty-claim.tsx`'s consumption step), so this endpoint
 *     cannot be used to enumerate claim ids.
 *   - Every issuance is PERSISTED (`WarrantyClaimUploadDestination`) with the
 *     authenticated `customerRef` on the row — that persisted identity, not
 *     this route's one-time check, is what the intake route verifies again
 *     at consumption time.
 *
 * ============================================================================
 * WHY A NOT-YET-EXISTING CLAIM ID IS ALLOWED
 * ============================================================================
 * A claim's evidence is gathered WHILE the form is filled out, before the
 * claim itself is submitted — so by the time a destination is requested, the
 * claim this evidence belongs to usually does not exist in Postgres yet. The
 * client generates the claim's id (`crypto.randomUUID()`) up front, uses that
 * same id both to request every destination it needs AND, later, as the
 * claim's actual `id` when it submits the full form
 * (`apps.carat.warranty-claim.tsx`'s module comment, `CreateWarrantyClaimInput.
 * id`'s comment). This is safe because a caller-supplied id can only ever
 * create a BRAND NEW claim — Postgres's primary-key uniqueness on
 * `warranty_claim` refuses an attempt to reuse an existing one — so nobody
 * can use this to attach evidence to a claim they did not just create, and
 * the persisted destination row's `customerRef` still gates consumption to
 * the exact identity that requested it.
 *
 * ============================================================================
 * FAIL-CLOSED WHEN STORAGE IS UNCONFIGURED
 * ============================================================================
 * `resolveWarrantyUploadPort` returns `{ configured: false }` in every
 * environment today (the R2 bucket does not exist yet, `docs/specs/
 * R2-BUCKET-SETUP.md`). This route turns that into a 503 `uploads_unavailable`
 * response — the honest "no upload is offered" answer — rather than ever
 * substituting another store or fabricating a destination.
 *
 * ============================================================================
 * NEVER LOG THE ISSUED URL
 * ============================================================================
 * `uploadUrl` is a working, bearer-style credential (anyone holding it can PUT
 * an object) until it expires. This route logs `claimId`/`kind`/`storageKey`
 * on success, never the URL itself — `~/lib/logger.server.ts`'s key-name
 * redaction does not help here since the sensitive part is a VALUE, not a key
 * matching its pattern.
 */

const bodySchema = z.object({
  claimId: z.string().uuid(),
  kind: z.enum(["photo", "video"]),
  contentType: z.string().min(1).max(200),
  sizeBytes: z.number().int().positive(),
});

function badRequest(reason: string) {
  return Response.json({ error: "invalid_request", reason }, { status: 400 });
}

function authenticationRequired() {
  return Response.json(
    {
      error: "authentication_required",
      // docs/REQUIRED-CUSTOMER-ACCOUNTS.md §4's approved gate copy, verbatim
      // — reused here, same as `apps.carat.warranty-claim.tsx`.
      message: "Please sign in or create a CaratForUs account to continue.",
    },
    { status: 401 }
  );
}

function claimUnresolved() {
  // Deliberately the SAME response for "no such claim" and "not your claim" —
  // see this file's module comment.
  return Response.json({ error: "claim_unresolved" }, { status: 422 });
}

/**
 * `gid://shopify/Customer/<id>` from the App Proxy's `logged_in_customer_id`.
 * Mirrors `apps.carat.warranty-claim.tsx`'s `normalizeCustomerGid` exactly —
 * duplicated rather than imported because that function is not exported from
 * a shared module today, and this route's auth gate never passes a `null`/
 * absent id past it (same as that file).
 */
function normalizeCustomerGid(rawId: string): string {
  return rawId.startsWith("gid://") ? rawId : `gid://shopify/Customer/${rawId}`;
}

// ---------------------------------------------------------------------------
// Upload port resolver wiring — mirrors `apps.carat.warranty-claim.tsx`'s
// `createOrderLookupPort`/`__setWarrantyClaimOrderLookupPortForTests`. A test
// override lets unit/integration tests exercise the "configured" branch
// (a real `R2WarrantyUploadPort`, dummy credentials, no network call — see
// `ports.test.ts`) or a controlled "unconfigured" branch without depending on
// process-wide env caching or a real bucket.
// ---------------------------------------------------------------------------

let resolvePortOverrideForTests: (() => WarrantyUploadPortResolution) | null = null;
export function __setWarrantyUploadPortResolverForTests(resolver: (() => WarrantyUploadPortResolution) | null): void {
  resolvePortOverrideForTests = resolver;
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const { verified, loggedInCustomerId, shop, reason } = verifyAppProxySignature(url.searchParams, getEnv().SHOPIFY_API_SECRET, getEnv().SHOPIFY_SHOP_DOMAIN);
  if (!verified) {
    logger.warn("warranty_claim_upload_destination.proxy_rejected", { reason, signedShop: shop });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // docs/REQUIRED-CUSTOMER-ACCOUNTS.md — checked before the body is parsed,
  // same as apps.carat.warranty-claim.tsx.
  if (!loggedInCustomerId) {
    logger.warn("warranty_claim_upload_destination.anonymous_rejected", {});
    return authenticationRequired();
  }
  const customerRef = normalizeCustomerGid(loggedInCustomerId);

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return badRequest("body is not valid JSON");
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return badRequest("body does not match the upload destination request contract");
  }
  const body = parsed.data;

  // OWNERSHIP — IF a claim with this id already exists, it MUST belong to
  // the authenticated caller. If none exists yet, that is fine — see this
  // file's "WHY A NOT-YET-EXISTING CLAIM ID IS ALLOWED" module comment. Only
  // a REAL claim belonging to someone else is refused.
  const existingClaim = await getWarrantyClaimForCustomer(body.claimId);
  if (existingClaim && existingClaim.customerRef !== customerRef) {
    logger.warn("warranty_claim_upload_destination.claim_unresolved", {});
    return claimUnresolved();
  }

  const resolution = resolvePortOverrideForTests ? resolvePortOverrideForTests() : resolveWarrantyUploadPort();
  if (!resolution.configured) {
    logger.warn("warranty_claim_upload_destination.storage_unconfigured", { reason: resolution.reason });
    return Response.json({ error: "uploads_unavailable" }, { status: 503 });
  }

  let destination;
  try {
    destination = await resolution.port.createUploadDestination({
      purpose: "warranty_claim",
      ownerId: body.claimId,
      kind: body.kind,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
    });
  } catch (error) {
    if (error instanceof InvalidWarrantyUploadMetadataError) {
      return Response.json({ error: "invalid_upload", reason: error.reason }, { status: 422 });
    }
    logger.error("warranty_claim_upload_destination.destination_failed", {
      claimId: body.claimId,
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return Response.json({ error: "destination_unavailable" }, { status: 502 });
  }

  // PERSIST THE ISSUED DESTINATION — the record `apps.carat.warranty-claim.
  // tsx` verifies+consumes before ever recording a `WarrantyClaimUpload`.
  // `destination.expiresAt` comes from the port itself (the real presigned
  // URL's own expiry, `R2_PUT_URL_EXPIRY_SECONDS`) rather than being computed
  // separately here, so the persisted record and the actual signed URL can
  // never disagree about when this destination stops being usable.
  await recordIssuedUploadDestination({
    // PURPOSE IS A SECURITY BOUNDARY: a destination issued here can only ever
    // be spent on a warranty claim submission, because `purpose` is part of
    // the consumption match rather than something a caller checks.
    purpose: "warranty_claim",
    ownerId: body.claimId,
    customerRef,
    kind: body.kind,
    contentType: body.contentType,
    storageKey: destination.storageKey,
    // `expiresAt` is `null` only for a port that cannot produce a real
    // expiry (`RecordingWarrantyUploadPort`, never reachable here since
    // `resolveWarrantyUploadPort`'s unconfigured branch already returned 503
    // above) — the non-null assertion documents that, it does not paper over
    // a real possibility on this code path.
    expiresAt: destination.expiresAt!,
  });

  // Never logs `destination.uploadUrl` — see this file's module comment.
  logger.info("warranty_claim_upload_destination.issued", {
    claimId: body.claimId,
    kind: body.kind,
    storageKey: destination.storageKey,
  });

  return Response.json(
    {
      storageKey: destination.storageKey,
      uploadUrl: destination.uploadUrl,
      expiresAt: destination.expiresAt ? destination.expiresAt.toISOString() : null,
    },
    { status: 201, headers: { "Cache-Control": "private, no-store" } }
  );
}
