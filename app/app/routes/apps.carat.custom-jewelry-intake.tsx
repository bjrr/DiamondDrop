import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { prisma } from "~/db/client.server";
import {
  createCustomJewelryProject,
  recordCustomJewelryUpload,
  toCustomJewelryProjectConfirmation,
} from "~/db/repositories/customJewelryProjectRepository.server";
import { consumeUploadDestination } from "~/db/repositories/uploadDestinationRepository.server";
import { buildCustomJewelryIntakeConfirmationEmail } from "~/domain/customjewelry/intakeConfirmationEmail";
import { resolveEmailPort } from "~/lib/email/configuredPort.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * POST /apps/carat/custom-jewelry-intake — the free Custom Jewelry enquiry
 * (Slice 9, README "Custom Jewelry — MVP1 Locked Direction").
 *
 * A RESOURCE ROUTE — no default export. Same `allowedActionOrigins: []`
 * reasoning as every other `apps.carat.*` route, mechanically enforced by
 * `csrfResourceRouteFence.test.ts`.
 *
 * ============================================================================
 * THIS ROUTE IS DELIBERATELY OPEN TO SIGNED-OUT VISITORS
 * ============================================================================
 * It is the one customer-facing `apps.carat.*` action that does NOT require
 * `logged_in_customer_id`, and that is a decision rather than an omission.
 *
 * The README makes the initial request "free and intentionally low-friction".
 * `docs/REQUIRED-CUSTOMER-ACCOUNTS.md` requires an authenticated account for
 * every PURCHASE path and names "Custom Jewelry final approval/purchase"
 * specifically — a pre-purchase enquiry is neither a purchase nor
 * post-purchase self-service. Owner-confirmed 2026-10-05: intake is account
 * optional; uploading private files, the deposit, and final approval all
 * require an account.
 *
 * THE APP PROXY SIGNATURE IS STILL REQUIRED. "No account" is not "no
 * authentication of the caller": an unsigned request is refused exactly as it
 * is everywhere else, so this endpoint is reachable only through the
 * storefront, not from the open internet.
 *
 * WHEN A CUSTOMER *IS* SIGNED IN, the project is linked to them — from the
 * SIGNED `logged_in_customer_id` only, never from anything the body claims.
 * That link is what later lets them see the project in their account.
 *
 * ============================================================================
 * UPLOADS ARE NOT ACCEPTED HERE
 * ============================================================================
 * File uploads require an authenticated account and go through the issued-
 * destination architecture (persisted destination, bound to customer and
 * owner, single-use, expiring) — the same one the warranty path uses and that
 * is live-proven in production. An anonymous endpoint minting presigned PUTs
 * is a free file-hosting service on our account, which is why that path is
 * gated even though this one is not.
 *
 * A signed-out visitor can still convey references via `inspirationLinks`,
 * which is plain text. NOTHING SERVER-SIDE EVER FETCHES THOSE: a server that
 * retrieves a customer-supplied URL is an SSRF primitive. Staff open them in a
 * browser, where they are ordinary untrusted links.
 *
 * ============================================================================
 * NO MONEY MOVES
 * ============================================================================
 * The README is explicit that intake must "not charge the Design Deposit
 * yet". This route takes no payment input, creates no draft order, and the
 * table it writes to has no payment columns.
 */

const bodySchema = z
  .object({
    firstName: z.string().trim().min(1).max(200),
    lastName: z.string().trim().min(1).max(200),
    email: z.string().trim().email().max(320),
    phone: z.string().trim().min(1).max(50),

    startingPoint: z.enum(["existing_design", "from_scratch"]),
    promptText: z.string().trim().min(1).max(5000),

    jewelryType: z.string().trim().min(1).max(200).optional(),
    inspirationLinks: z.string().trim().min(1).max(2000).optional(),

    /**
     * Minor units as a STRING, parsed to bigint below — never a JSON number.
     * A JSON number is an IEEE double, and a budget is money
     * (CLAUDE.md rule 6). Accepting `350000` as a number would work until the
     * day somebody enters a figure past 2^53.
     */
    approximateBudgetMinorUnits: z.string().regex(/^\d{1,15}$/).optional(),
    approximateBudgetCurrency: z.string().trim().length(3).optional(),

    /** `YYYY-MM-DD`, or omitted. Mutually exclusive with `hasNoDeadline`. */
    desiredCompletionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    hasNoDeadline: z.boolean().optional(),

    followUpPreference: z.enum(["schedule_consultation", "contact_me"]),

    /**
     * The client-minted project id. Required ONLY when `uploads` is
     * non-empty, and honoured only then — see the uploads comment below.
     */
    projectId: z.string().uuid().optional(),

    /**
     * Files already PUT to R2 against destinations issued by
     * `apps.carat.custom-jewelry-upload-destination.tsx`. Metadata only; every
     * one is verified and consumed before the project is created.
     */
    uploads: z
      .array(
        z
          .object({
            kind: z.enum(["photo", "video"]),
            storageKey: z.string().min(1).max(500),
            contentType: z.string().min(1).max(200),
            sizeBytes: z.number().int().positive(),
            checksum: z.string().min(1).max(200),
          })
          .strict()
      )
      .max(10)
      .optional(),
  })
  .strict();

/** Thrown INSIDE the transaction so Prisma actually rolls it back. */
class UnverifiableUploadReferenceError extends Error {}

function badRequest(reason: string) {
  return Response.json({ error: "invalid_request", reason }, { status: 400 });
}

/** `gid://shopify/Customer/<id>` from the proxy's `logged_in_customer_id`. */
function normalizeCustomerGid(rawId: string): string {
  return rawId.startsWith("gid://") ? rawId : `gid://shopify/Customer/${rawId}`;
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const { verified, loggedInCustomerId, shop, reason } = verifyAppProxySignature(url.searchParams, getEnv().SHOPIFY_API_SECRET, getEnv().SHOPIFY_SHOP_DOMAIN);
  if (!verified) {
    logger.warn("custom_jewelry_intake.proxy_rejected", { reason, signedShop: shop });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // NOTE THE ABSENCE of a `logged_in_customer_id` requirement here — see the
  // module comment. Signed in or not, the enquiry is accepted; the identity is
  // recorded only when the proxy actually asserts one.
  const customerRef = loggedInCustomerId ? normalizeCustomerGid(loggedInCustomerId) : null;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return badRequest("body is not valid JSON");
  }

  const parsed = bodySchema.safeParse(rawBody);
  if (!parsed.success) {
    return badRequest("body does not match the custom jewelry intake contract");
  }
  const body = parsed.data;

  // Both halves of a budget or neither — refused here with a readable reason
  // rather than surfacing the database CHECK, which would reach the customer
  // as an opaque constraint name.
  const hasBudgetAmount = body.approximateBudgetMinorUnits !== undefined;
  const hasBudgetCurrency = body.approximateBudgetCurrency !== undefined;
  if (hasBudgetAmount !== hasBudgetCurrency) {
    return badRequest("an approximate budget needs both an amount and a currency");
  }

  // "No deadline" and a date are two answers to one question.
  if (body.hasNoDeadline && body.desiredCompletionDate) {
    return badRequest("choose either a desired completion date or no deadline, not both");
  }

  const uploads = body.uploads ?? [];

  // UPLOADS REQUIRE AN ACCOUNT EVEN THOUGH THE ENQUIRY DOES NOT.
  // Owner decision 2026-10-05: an endpoint accepting anonymous file
  // references is the same abuse surface as one minting anonymous presigned
  // PUTs. A signed-out visitor may still submit — just without files, using
  // `inspirationLinks` instead.
  if (uploads.length > 0 && customerRef === null) {
    logger.warn("custom_jewelry_intake.uploads_require_account", {});
    return Response.json(
      {
        error: "authentication_required_for_uploads",
        message: "Please sign in or create a CaratForUs account to continue.",
      },
      { status: 401 }
    );
  }
  if (uploads.length > 0 && !body.projectId) {
    return badRequest("projectId is required when uploads are provided");
  }

  // VERIFY AND CONSUME EVERY UPLOAD BEFORE THE PROJECT EXISTS.
  //
  // One transaction across the whole batch: if ANY key fails, destinations
  // already consumed earlier in the same loop roll back with it, and NO
  // project is created. A submission that succeeded minus some of its
  // inspiration would look complete and be wrong — the same reasoning the
  // warranty route documents, and the reason a sentinel return value is not
  // enough here (returning from a Prisma transaction callback does NOT roll
  // it back; only a throw does).
  if (uploads.length > 0) {
    try {
      await prisma.$transaction(async (tx) => {
        for (const upload of uploads) {
          const consumed = await consumeUploadDestination(
            {
              purpose: "custom_jewelry_project",
              ownerId: body.projectId!,
              customerRef: customerRef!,
              storageKey: upload.storageKey,
            },
            tx
          );
          if (!consumed) throw new UnverifiableUploadReferenceError();
        }
      });
    } catch (error) {
      if (error instanceof UnverifiableUploadReferenceError) {
        // Deliberately generic. A key issued for someone else, for a warranty
        // claim, or never issued at all are indistinguishable from here — the
        // shared service collapses every failure into one value by design, so
        // this cannot become an oracle for guessing another customer’s key.
        logger.warn("custom_jewelry_intake.invalid_upload_reference", {});
        return Response.json({ error: "invalid_upload_reference" }, { status: 422 });
      }
      throw error;
    }
  }

  const project = await createCustomJewelryProject({
    customerRef,
    firstName: body.firstName,
    lastName: body.lastName,
    email: body.email,
    phone: body.phone,
    startingPoint: body.startingPoint,
    promptText: body.promptText,
    jewelryType: body.jewelryType ?? null,
    inspirationLinks: body.inspirationLinks ?? null,
    approximateBudget: hasBudgetAmount
      ? {
          amountMinorUnits: BigInt(body.approximateBudgetMinorUnits!),
          currency: body.approximateBudgetCurrency!.toUpperCase(),
        }
      : null,
    // Parsed as UTC midnight rather than through local time: a `DATE` column
    // holding "the day before" because the server sits west of the customer
    // is a classic and very quiet bug.
    desiredCompletionDate: body.desiredCompletionDate ? new Date(`${body.desiredCompletionDate}T00:00:00.000Z`) : null,
    hasNoDeadline: body.hasNoDeadline ?? false,
    followUpPreference: body.followUpPreference,
    // Keyed on uploads.length, NOT on whether projectId happens to be
    // present. A client-chosen primary key is accepted for exactly one
    // reason — binding files uploaded before the project existed — so with no
    // files there is nothing to bind and the column default generates the id.
    // Honouring a bare projectId would make project creation a weak existence
    // oracle for a guessed id; the identical mistake was shipped once on the
    // warranty claim route and caught there.
    id: uploads.length > 0 ? body.projectId : undefined,
  });

  // Metadata recorded AFTER the project row exists, and only for keys the
  // shared service already verified and consumed above.
  for (const upload of uploads) {
    await recordCustomJewelryUpload({
      projectId: project.id,
      kind: upload.kind,
      storageKey: upload.storageKey,
      contentType: upload.contentType,
      sizeBytes: BigInt(upload.sizeBytes),
      checksum: upload.checksum,
      uploadedByActorRef: customerRef!,
    });
  }

  logger.info("custom_jewelry_intake.submitted", {
    projectReference: project.projectReference,
    authenticated: customerRef !== null,
  });

  // CONFIRMATION EMAIL — BEST EFFORT, AFTER THE PROJECT EXISTS.
  //
  // A mail-provider outage must not turn an accepted enquiry into an error the
  // customer retries, producing a second project for the same request. The
  // enquiry is recorded; the email is how we follow up. Logged at error so
  // staff can reach out by hand.
  try {
    const emailResolution = resolveEmailPort();
    if (!emailResolution.configured) {
      logger.error("custom_jewelry_intake.confirmation_email_unconfigured", { reason: emailResolution.reason });
    } else {
      const content = buildCustomJewelryIntakeConfirmationEmail({ projectReference: project.projectReference });
      await emailResolution.port.send({
        from: emailResolution.from,
        to: [project.email],
        subject: content.subject,
        text: content.text,
      });
      logger.info("custom_jewelry_intake.confirmation_email_sent", {
        projectReference: project.projectReference,
      });
    }
  } catch (error) {
    logger.error("custom_jewelry_intake.confirmation_email_failed", {
      projectReference: project.projectReference,
      errorName: error instanceof Error ? error.name : "unknown",
    });
  }

  return Response.json(toCustomJewelryProjectConfirmation(project), {
    status: 201,
    headers: { "Cache-Control": "private, no-store" },
  });
}
