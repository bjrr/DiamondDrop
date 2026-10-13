import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { prisma } from "~/db/client.server";
import { createAcknowledgment } from "~/db/repositories/acknowledgmentRepository.server";
import {
  findApprovalPackageForCustomer,
  recordCustomerApproval,
} from "~/db/repositories/customJewelryApprovalRepository.server";
import { getLatestPolicyVersion } from "~/db/repositories/policyVersionRepository.server";
import {
  CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT,
  CUSTOM_JEWELRY_FINAL_APPROVAL_AFFIRMATIVE_ACTION_LABEL,
  CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG,
} from "~/domain/customjewelry/finalApprovalCopy";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * POST /apps/carat/custom-jewelry-approve — the customer's final approval.
 *
 * A RESOURCE ROUTE — no default export, same `allowedActionOrigins: []`
 * reasoning as every other `apps.carat.*` route.
 *
 * ============================================================================
 * THE REQUEST NAMES A PACKAGE AND AFFIRMS. IT DECIDES NOTHING.
 * ============================================================================
 * It carries a package id and the literal `true` affirmation. It does NOT
 * carry — and `.strict()` makes it a 400 to try — a price, a balance, a
 * deposit credit, a specification, a customer id, or the acknowledgment text.
 * Every one of those is read from the frozen package or from the authenticated
 * session:
 *
 *   the customer      the App Proxy's `logged_in_customer_id`
 *   the design        the package, frozen at issue
 *   the prices        the package, both bases, frozen at issue
 *   the exact words   the pinned copy module, and the `policy_version` row
 *
 * A customer who could post their own price would be setting the price of a
 * custom piece. A customer who could post the acknowledgment text would be
 * writing their own evidence.
 *
 * ============================================================================
 * THE AFFIRMATION IS A LITERAL `true`, NEVER A DEFAULT
 * ============================================================================
 * `z.literal(true)` — not `z.boolean()`, not `.default(true)`, not coerced
 * from a string. `CLAUDE.md` forbids pre-checking or silently inferring a
 * material acknowledgment, and this is the acknowledgment a final-sale purchase
 * rests on. An absent field is a 400, which is the correct answer to "did the
 * customer tick the box?" when the answer is "we do not know".
 *
 * ============================================================================
 * APPROVAL DOES NOT CREATE A PURCHASE
 * ============================================================================
 * Deliberately separate. The customer approves the design and the price; they
 * then choose a payment basis, and that choice creates the payable object. Two
 * reasons: the owner forbade choosing the basis for them, and a single endpoint
 * doing both would mean a failed Shopify call could lose a recorded approval.
 */

const approveRequestSchema = z
  .object({
    packageId: z.string().uuid(),
    /**
     * THE ONE REQUIRED AFFIRMATIVE ACTION. Must be the literal boolean `true`
     * — never a default, never inferred from absence, mirroring
     * `returnPolicyAcknowledgmentAccepted` in the RMA intake and
     * `cancellationAcknowledgmentAccepted` in Group Buy checkout.
     */
    finalApprovalAccepted: z.literal(true),
  })
  .strict();

function badRequest(reason: string) {
  return Response.json({ error: "invalid_request", reason }, { status: 400 });
}

function notFound() {
  // Same answer for a foreign package and a nonexistent one.
  return Response.json({ error: "not_found" }, { status: 404 });
}

function authenticationRequired() {
  return Response.json(
    {
      error: "authentication_required",
      message: "Please sign in or create a CaratForUs account to continue.",
    },
    { status: 401 }
  );
}

function normalizeCustomerGid(rawId: string): string {
  return rawId.startsWith("gid://") ? rawId : `gid://shopify/Customer/${rawId}`;
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const { verified, loggedInCustomerId } = verifyAppProxySignature(
    url.searchParams,
    getEnv().SHOPIFY_API_SECRET
  );
  if (!verified) {
    logger.warn("custom_jewelry_approve.proxy_rejected", { reason: "invalid_or_missing_signature" });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  // NO GUEST FINAL APPROVAL. Checked before the body is parsed.
  if (!loggedInCustomerId) {
    logger.warn("custom_jewelry_approve.anonymous_rejected", {});
    return authenticationRequired();
  }
  const customerRef = normalizeCustomerGid(loggedInCustomerId);

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return badRequest("body is not valid JSON");
  }
  const parsed = approveRequestSchema.safeParse(body);
  if (!parsed.success) {
    return badRequest("body does not match the final approval request contract");
  }
  const { packageId } = parsed.data;

  // OWNERSHIP, AS A JOINED QUERY. See
  // `findApprovalPackageForCustomer` — the check is the `where`, not a
  // comparison afterwards.
  const pkg = await findApprovalPackageForCustomer({ packageId, customerRef });
  if (!pkg) {
    logger.warn("custom_jewelry_approve.not_visible", { packageId, customerRef });
    return notFound();
  }

  if (pkg.status === "superseded") {
    // The customer was looking at a stale page. Told plainly, because the
    // alternative is binding them to a design that is no longer being made.
    return Response.json(
      {
        error: "superseded",
        message:
          "This version of your design has been replaced by a newer one. Please reload to review the current package.",
      },
      { status: 409 }
    );
  }

  // The policy row, fail-closed. An approval we cannot evidence is an approval
  // we must not accept — and this is the evidence a final-sale purchase rests
  // on.
  const policy = await getLatestPolicyVersion(CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG);
  if (!policy) {
    logger.error("custom_jewelry_approve.acknowledgment_copy_pending_approval", { packageId });
    return Response.json({ error: "acknowledgment_copy_pending_approval" }, { status: 503 });
  }

  // ALREADY APPROVED? Return the recorded approval rather than creating a
  // second acknowledgment row. A retried request must not leave two pieces of
  // evidence for one decision.
  if (pkg.status === "approved") {
    return Response.json(
      {
        outcome: "already_approved",
        packageId: pkg.id,
        version: pkg.version,
        approvedAt: pkg.approvedAt?.toISOString() ?? null,
      },
      { status: 200, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  // ONE TRANSACTION: the evidence and the approval it evidences. An
  // acknowledgment row with no approval beside it would be a customer's
  // consent to nothing, and an approval with no acknowledgment is refused by a
  // CHECK.
  const result = await prisma.$transaction(async () => {
    const ack = await createAcknowledgment({
      // THE EXACT TEXT FROM THE POLICY ROW, not from the constant and not from
      // the request. The row is what the customer's evidence will point at, so
      // if the two ever disagreed the row is the one that must win — and
      // `requiredPolicyVersionsMigrationFence` already proves they agree.
      exactText: policy.text,
      policyVersionId: policy.id,
      affirmativeActionLabel: CUSTOM_JEWELRY_FINAL_APPROVAL_AFFIRMATIVE_ACTION_LABEL,
      customerRef,
      acknowledgedAt: new Date(),
    });

    return recordCustomerApproval({
      packageId: pkg.id,
      customerRef,
      acknowledgmentId: ack.id,
      now: new Date(),
    });
  });

  switch (result.outcome) {
    case "approved":
      logger.info("custom_jewelry_approve.approved", {
        packageId: pkg.id,
        version: pkg.version,
        customerRef,
      });
      return Response.json(
        {
          outcome: "approved",
          packageId: result.package.id,
          version: result.package.version,
          approvedAt: result.package.approvedAt?.toISOString() ?? null,
          // What the customer pays next, on each basis. They choose; we do not.
          currency: result.package.currency,
          cardBalanceDueMinorUnits: result.package.regularCardBalanceDueMinorUnits.toString(),
          bankPaymentBalanceDueMinorUnits: result.package.bankPaymentBalanceDueMinorUnits.toString(),
        },
        { status: 201, headers: { "Cache-Control": "private, no-store" } }
      );
    case "already_approved":
      return Response.json(
        {
          outcome: "already_approved",
          packageId: result.package.id,
          version: result.package.version,
          approvedAt: result.package.approvedAt?.toISOString() ?? null,
        },
        { status: 200, headers: { "Cache-Control": "private, no-store" } }
      );
    case "superseded":
      return Response.json(
        {
          error: "superseded",
          message:
            "This version of your design has been replaced by a newer one. Please reload to review the current package.",
          currentVersion: result.currentVersion,
        },
        { status: 409 }
      );
    case "not_found":
      return notFound();
  }
}

/**
 * Exported so `csrfResourceRouteFence.test.ts` and the route tests can confirm
 * the acknowledgment constant and the pinned text have not drifted apart. The
 * route itself writes `policy.text` — see the comment at `createAcknowledgment`
 * for why the row wins over the constant.
 */
export const __pinnedAcknowledgmentTextForTests = CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT;
