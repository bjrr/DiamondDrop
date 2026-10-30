import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { recordIssuedUploadDestination } from "~/db/repositories/uploadDestinationRepository.server";
import { getBeatQuoteSubmissionForCustomer } from "~/db/repositories/beatQuoteSubmissionRepository.server";
import { InvalidWarrantyUploadMetadataError } from "~/jobs/warranty/ports";
import type { WarrantyUploadPortResolution } from "~/jobs/warranty/ports";
import { resolveWarrantyUploadPort } from "~/jobs/warranty/ports";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { verifyAppProxySignature } from "~/shopify/proxy/verify";

/**
 * POST /apps/carat/beat-quote-upload-destination — issues a presigned PUT for
 * a customer's quote document.
 *
 * ===========================================================================
 * WHY THIS EXISTS AT ALL
 * ===========================================================================
 * The whole point of Let Us Beat Your Quote is the customer handing us the
 * quote they want reviewed. Before this, they submitted, waited for a reply,
 * and emailed the evidence afterwards — friction in the middle of the one
 * thing the page is for.
 *
 * ===========================================================================
 * THIS REUSES THE WARRANTY UPLOAD ARCHITECTURE RATHER THAN ADDING ANOTHER
 * ===========================================================================
 * Same port, same shared destination table, same presigned-PUT lifecycle,
 * same validation module, same actor attribution, same append-only evidence
 * treatment. The only genuinely new pieces are a `document` upload kind, a
 * `beat_quote_submission` purpose, and the `beat_quote_upload` record.
 *
 * `purpose` is part of the consumption WHERE clause, so a destination issued
 * for a quote can never be redeemed against a warranty claim and vice versa.
 *
 * ===========================================================================
 * SIGN-IN IS REQUIRED TO ATTACH A FILE — BUT NOT TO SUBMIT A QUOTE
 * ===========================================================================
 * `apps.carat.beat-quote-submission` deliberately accepts ANONYMOUS
 * submissions: `customerRef` is nullable there, and a lead form that demands
 * an account is a lead form nobody fills in.
 *
 * This endpoint is different, and the warranty route states the reason
 * plainly: an endpoint that mints presigned PUTs for anyone is free file
 * hosting. `REQUIRED-CUSTOMER-ACCOUNTS.md` does not mandate an account here
 * — it covers purchases and warranty/RMA self-service — so this is a
 * security decision rather than a policy one, and it is made the
 * conservative way: identity before write access to our bucket.
 *
 * The practical consequence, which the storefront states rather than hides:
 * a signed-out customer can still submit a quote, they just cannot attach a
 * file to it. Allowing anonymous uploads would mean making `customerRef`
 * nullable on the SHARED destination table, weakening a constraint warranty
 * and custom jewelry both rely on. That is an owner decision, not one to
 * take in passing.
 */

const bodySchema = z
  .object({
    /**
     * Client-generated, and the SAME id the submission will carry. The
     * submission route is idempotent on it, so a destination issued while
     * the form is being filled in lines up with the submission that follows.
     */
    submissionId: z.string().uuid(),
    /**
     * `document` for a quote PDF, `photo` for a picture of a printed one.
     * Scoped here rather than in the validation module: the shared kind enum
     * also carries `video`, which has no meaning for a written quote.
     */
    kind: z.enum(["document", "photo"]),
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
      message: "Please sign in or create a CaratForUs account to attach a file.",
    },
    { status: 401 }
  );
}

function submissionUnresolved() {
  // The SAME response for "no such submission" and "not yours" — otherwise
  // this endpoint becomes an oracle for which submission ids exist.
  return Response.json({ error: "submission_unresolved" }, { status: 422 });
}

/** Mirrors the submission route's normaliser. */
function normalizeCustomerGid(rawId: string): string {
  return rawId.startsWith("gid://") ? rawId : `gid://shopify/Customer/${rawId}`;
}

let resolvePortOverrideForTests: (() => WarrantyUploadPortResolution) | null = null;
export function __setBeatQuoteUploadPortResolverForTests(
  resolver: (() => WarrantyUploadPortResolution) | null
): void {
  resolvePortOverrideForTests = resolver;
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const { verified, loggedInCustomerId, shop, reason } = verifyAppProxySignature(
    url.searchParams,
    getEnv().SHOPIFY_API_SECRET,
    getEnv().SHOPIFY_SHOP_DOMAIN
  );
  if (!verified) {
    logger.warn("beat_quote_upload_destination.proxy_rejected", { reason, signedShop: shop });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!loggedInCustomerId) {
    logger.warn("beat_quote_upload_destination.anonymous_rejected", {});
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

  // OWNERSHIP. A not-yet-existing submission id is fine — destinations are
  // requested WHILE the form is being filled in, before anything is
  // submitted. Only a REAL submission belonging to someone else is refused.
  const existing = await getBeatQuoteSubmissionForCustomer(body.submissionId);
  if (existing && existing.customerRef !== customerRef) {
    logger.warn("beat_quote_upload_destination.submission_unresolved", {});
    return submissionUnresolved();
  }

  const resolution = resolvePortOverrideForTests
    ? resolvePortOverrideForTests()
    : resolveWarrantyUploadPort();
  if (!resolution.configured) {
    logger.warn("beat_quote_upload_destination.storage_unconfigured", { reason: resolution.reason });
    return Response.json({ error: "uploads_unavailable" }, { status: 503 });
  }

  let destination;
  try {
    destination = await resolution.port.createUploadDestination({
      purpose: "beat_quote_submission",
      ownerId: body.submissionId,
      kind: body.kind,
      contentType: body.contentType,
      sizeBytes: body.sizeBytes,
    });
  } catch (error) {
    if (error instanceof InvalidWarrantyUploadMetadataError) {
      return Response.json({ error: "invalid_upload", reason: error.reason }, { status: 422 });
    }
    logger.error("beat_quote_upload_destination.destination_failed", {
      submissionId: body.submissionId,
      errorName: error instanceof Error ? error.name : "unknown",
    });
    return Response.json({ error: "destination_unavailable" }, { status: 502 });
  }

  await recordIssuedUploadDestination({
    purpose: "beat_quote_submission",
    ownerId: body.submissionId,
    customerRef,
    kind: body.kind,
    contentType: body.contentType,
    storageKey: destination.storageKey,
    expiresAt: destination.expiresAt!,
  });

  logger.info("beat_quote_upload_destination.issued", {
    submissionId: body.submissionId,
    kind: body.kind,
    storageKey: destination.storageKey,
  });

  return Response.json({
    uploadUrl: destination.uploadUrl,
    storageKey: destination.storageKey,
    expiresAt: destination.expiresAt ? destination.expiresAt.toISOString() : null,
  });
}
