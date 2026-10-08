import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { recordIssuedUploadDestination } from "~/db/repositories/uploadDestinationRepository.server";
import { prisma } from "~/db/client.server";
import type { WarrantyUploadPortResolution } from "~/jobs/warranty/ports";
import { InvalidWarrantyUploadMetadataError, resolveWarrantyUploadPort } from "~/jobs/warranty/ports";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * POST /apps/carat/custom-jewelry-upload-destination — issues a presigned
 * destination for ONE Custom Jewelry inspiration file (Slice 9).
 *
 * A RESOURCE ROUTE — no default export. Same `allowedActionOrigins: []`
 * reasoning as every other `apps.carat.*` route, enforced by
 * `csrfResourceRouteFence.test.ts`.
 *
 * ============================================================================
 * THIS ROUTE REQUIRES AN ACCOUNT EVEN THOUGH THE ENQUIRY DOES NOT
 * ============================================================================
 * Owner decision 2026-10-05, and the asymmetry is the point:
 *
 *   enquiry  — open to signed-out visitors (README: "free and intentionally
 *              low-friction"). A visitor may submit with no files, and may
 *              paste reference links as plain text.
 *   uploads  — authenticated account required.
 *
 * Not a purchase requirement; an abuse and storage control. An endpoint that
 * mints presigned PUTs for anyone is a free file-hosting service on our
 * account, and the owner was explicit that this gate is about that rather
 * than about payment.
 *
 * ============================================================================
 * THE SECURITY IS NOT IMPLEMENTED HERE
 * ============================================================================
 * It lives in `uploadDestinationRepository.server.ts`, the single shared
 * service: the destination is persisted, bound to this authenticated customer,
 * bound to the `custom_jewelry_project` PURPOSE, single-use, and expiring. A
 * destination issued here cannot be spent on a warranty claim, because
 * `purpose` is part of the consumption match rather than something a caller
 * remembers to check.
 *
 * ============================================================================
 * WHY A NOT-YET-EXISTING PROJECT ID IS ALLOWED
 * ============================================================================
 * Inspiration is gathered WHILE the form is filled out, before the enquiry is
 * submitted, so the project usually does not exist yet. The client generates
 * the project's id up front, uses it for every destination request, and
 * submits it as `projectId` with the enquiry — the same handshake
 * `apps.carat.warranty-claim-upload-destination.tsx` documents in full.
 *
 * Safe for the same reason: a caller-supplied id can only ever create a BRAND
 * NEW project (primary-key uniqueness refuses reuse), so it cannot attach
 * files to someone else's enquiry, and the persisted destination's
 * `customerRef` still gates consumption to the identity that requested it.
 *
 * IF A PROJECT WITH THIS ID ALREADY EXISTS it must belong to the caller. A
 * project belonging to someone else is refused with the SAME generic response
 * as one that does not exist, so this cannot be used to enumerate project ids.
 *
 * ============================================================================
 * FAIL CLOSED WHEN STORAGE IS UNCONFIGURED, AND NEVER LOG THE URL
 * ============================================================================
 * An unconfigured bucket produces 503 `uploads_unavailable` rather than a
 * fabricated destination. And `uploadUrl` is a working bearer-style credential
 * until it expires: this route logs the storage key, never the URL, because
 * the sensitive part is a VALUE and key-name redaction cannot help.
 */

const bodySchema = z
  .object({
    projectId: z.string().uuid(),
    kind: z.enum(["photo", "video"]),
    contentType: z.string().min(1).max(200),
    sizeBytes: z.number().int().positive(),
  })
  .strict();

function badRequest(reason: string) {
  return Response.json({ error: "invalid_request", reason }, { status: 400 });
}

function authenticationRequired() {
  return Response.json(
    {
      error: "authentication_required",
      // docs/REQUIRED-CUSTOMER-ACCOUNTS.md §4's approved gate copy, verbatim —
      // reused rather than reworded so all gates read identically.
      message: "Please sign in or create a CaratForUs account to continue.",
    },
    { status: 401 }
  );
}

/** Deliberately the SAME response for "no such project" and "not your project". */
function projectUnresolved() {
  return Response.json({ error: "project_unresolved" }, { status: 422 });
}

function normalizeCustomerGid(rawId: string): string {
  return rawId.startsWith("gid://") ? rawId : `gid://shopify/Customer/${rawId}`;
}

let resolvePortOverrideForTests: (() => WarrantyUploadPortResolution) | null = null;
export function __setCustomJewelryUploadPortResolverForTests(
  resolver: (() => WarrantyUploadPortResolution) | null
): void {
  resolvePortOverrideForTests = resolver;
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const { verified, loggedInCustomerId } = verifyAppProxySignature(url.searchParams, getEnv().SHOPIFY_API_SECRET);
  if (!verified) {
    logger.warn("custom_jewelry_upload_destination.proxy_rejected", { reason: "invalid_or_missing_signature" });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // THE GATE. Checked before the body is parsed, so an anonymous caller learns
  // nothing about the contract either.
  if (!loggedInCustomerId) {
    logger.warn("custom_jewelry_upload_destination.anonymous_rejected", {});
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

  // IF a project with this id exists, it MUST be the caller's. A
  // not-yet-existing id is fine — see the module comment.
  const existing = await prisma.customJewelryProject.findUnique({
    where: { id: body.projectId },
    select: { customerRef: true },
  });
  if (existing && existing.customerRef !== customerRef) {
    logger.warn("custom_jewelry_upload_destination.project_unresolved", {});
    return projectUnresolved();
  }

  const resolution = resolvePortOverrideForTests ? resolvePortOverrideForTests() : resolveWarrantyUploadPort();
  if (!resolution.configured) {
    logger.warn("custom_jewelry_upload_destination.storage_unconfigured", { reason: resolution.reason });
    return Response.json({ error: "uploads_unavailable" }, { status: 503 });
  }

  let destination;
  try {
    destination = await resolution.port.createUploadDestination({
      // PURPOSE SHAPES BOTH the storage key prefix and the security boundary:
      // `custom-jewelry/<projectId>/...` in the bucket, and a destination that
      // a warranty submission cannot consume.
      purpose: "custom_jewelry_project",
      ownerId: body.projectId,
      kind: body.kind,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
    });
  } catch (error) {
    if (error instanceof InvalidWarrantyUploadMetadataError) {
      return badRequest(error.message);
    }
    throw error;
  }

  await recordIssuedUploadDestination({
    purpose: "custom_jewelry_project",
    ownerId: body.projectId,
    customerRef,
    kind: body.kind,
    contentType: body.contentType,
    storageKey: destination.storageKey,
    // From the port itself — the real presigned URL's own expiry — so the
    // persisted record and the signed URL can never disagree about when this
    // destination stops being usable.
    expiresAt: destination.expiresAt!,
  });

  logger.info("custom_jewelry_upload_destination.issued", {
    projectId: body.projectId,
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
