import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import {
  createCustomJewelryProject,
  toCustomJewelryProjectConfirmation,
} from "~/db/repositories/customJewelryProjectRepository.server";
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
  })
  .strict();

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
  const { verified, loggedInCustomerId } = verifyAppProxySignature(url.searchParams, getEnv().SHOPIFY_API_SECRET);
  if (!verified) {
    logger.warn("custom_jewelry_intake.proxy_rejected", { reason: "invalid_or_missing_signature" });
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
  });

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
