import type { ActionFunctionArgs } from "react-router";
import { z } from "zod";

import { prisma } from "~/db/client.server";
import { createAcknowledgment } from "~/db/repositories/acknowledgmentRepository.server";
import { recordCustomJewelryDepositAcceptance } from "~/db/repositories/customJewelryProjectRepository.server";
import { getLatestPolicyVersion } from "~/db/repositories/policyVersionRepository.server";
import {
  CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT,
  CUSTOM_JEWELRY_DEPOSIT_AFFIRMATIVE_ACTION_LABEL,
  CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS,
  CUSTOM_JEWELRY_DEPOSIT_CURRENCY,
  CUSTOM_JEWELRY_DEPOSIT_POLICY_SLUG,
} from "~/domain/customjewelry/designDepositAcknowledgmentText";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * POST /apps/carat/custom-jewelry-deposit-acceptance — records the
 * customer's affirmative acceptance of the $49 Design Deposit terms (Slice 9,
 * owner decision 2026-10-05).
 *
 * A RESOURCE ROUTE — no default export. Same `allowedActionOrigins: []`
 * reasoning as every other `apps.carat.*` route, enforced by
 * `csrfResourceRouteFence.test.ts`.
 *
 * ============================================================================
 * THIS RECORDS AUTHORIZATION. IT DOES NOT CHARGE ANYTHING.
 * ============================================================================
 * Deliberately separate, and the separation is the safety property. This
 * route's only job is to make the acceptance an auditable fact BEFORE money
 * can move. Collection is a distinct step with its own record, because
 * conflating "agreed to pay" with "paid" is how design work starts against
 * money that never arrived — the same distinction the Group Buy Bank Payment
 * path draws between a placed order and verified funds.
 *
 * Nothing here creates a draft order, touches a payment provider, or advances
 * the project past `deposit_charged`'s predecessor. The project status moves
 * only when the money is actually collected.
 *
 * ============================================================================
 * AN ACCOUNT IS REQUIRED HERE, UNLIKE THE ENQUIRY
 * ============================================================================
 * The enquiry is deliberately open to signed-out visitors. Authorizing a
 * charge is not: `docs/REQUIRED-CUSTOMER-ACCOUNTS.md` requires an
 * authenticated account for every payment path, and the owner restated it for
 * this surface specifically — "Deposit/payment and final design
 * approval/purchase = authenticated account required."
 *
 * The identity comes from the App Proxy's SIGNED `logged_in_customer_id` and
 * nothing else. The project must belong to that identity, and a project
 * belonging to someone else is refused with the SAME generic response as one
 * that does not exist, so this cannot enumerate project ids.
 *
 * ============================================================================
 * WHAT IS STORED, AND WHY IT IS NOT RECOMPUTED LATER
 * ============================================================================
 * The acceptance row freezes the exact text (via the `Acknowledgment` row),
 * the policy version it came from, the label the customer actually clicked,
 * the timestamp, and THE AMOUNT. The amount is frozen rather than read from
 * the constant at display time: if the deposit price ever changes, this row
 * must still say what THIS customer authorized. A disclosure saying $49
 * beside a charge of something else is the worst failure this surface can
 * have, and a frozen amount is what makes the two provably agree afterwards.
 *
 * ============================================================================
 * NO POLICY ROW MEANS NO CHARGE — 503, NEVER A SILENT ACCEPTANCE
 * ============================================================================
 * If `custom-jewelry-design-deposit` has no provisioned `policy_version`, this
 * route refuses with 503 rather than recording an acceptance that cannot name
 * the text it accepted. That is a total outage of the deposit step, and it is
 * the correct outcome: an acknowledgment whose text cannot be identified is
 * not evidence of anything.
 *
 * The row is provisioned by migration
 * `20261008020000_custom_jewelry_deposit_policy_version` and registered in
 * `~/domain/evidence/requiredPolicyVersions.ts`, so a missing one is visible
 * at `/health` the moment a deploy finishes rather than at the first
 * customer's attempt to pay. That gap is not hypothetical — the Luxury Steals
 * acknowledgment endpoint returned 500 `policy_unavailable` on its first real
 * production request for exactly this reason.
 *
 * ============================================================================
 * ACCEPTING TWICE IS NOT AN ERROR THE CUSTOMER SHOULD SEE
 * ============================================================================
 * One acceptance per project, enforced by a UNIQUE index rather than by this
 * route checking first — a double-submitted form, a retried request or two
 * open tabs must not produce two rows for one deposit. A repeat is answered
 * with the EXISTING acceptance and 200, not a 409: the customer did what was
 * asked and the system already has what it needs.
 */

const bodySchema = z
  .object({
    projectId: z.string().uuid(),
    /**
     * Must be the LITERAL `true`. Zod's `z.boolean()` would accept `false`
     * and leave "did they actually agree?" to a later `if` — the same
     * reasoning the warranty claim route documents for its own
     * acknowledgment flag. Never pre-checked, never inferred.
     */
    depositTermsAccepted: z.literal(true),
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
      // reused rather than reworded so every gate reads identically.
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

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const { verified, loggedInCustomerId, shop, reason } = verifyAppProxySignature(url.searchParams, getEnv().SHOPIFY_API_SECRET, getEnv().SHOPIFY_SHOP_DOMAIN);
  if (!verified) {
    logger.warn("custom_jewelry_deposit_acceptance.proxy_rejected", { reason, signedShop: shop });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  // Checked before the body is parsed, so an anonymous caller learns nothing
  // about the contract either.
  if (!loggedInCustomerId) {
    logger.warn("custom_jewelry_deposit_acceptance.anonymous_rejected", {});
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
    // Covers a missing or `false` acceptance flag too. There is no separate
    // "you must accept" branch because the schema will not produce a parsed
    // body without it — the acceptance cannot be forgotten downstream.
    return badRequest("body does not match the deposit acceptance contract");
  }
  const body = parsed.data;

  const project = await prisma.customJewelryProject.findUnique({
    where: { id: body.projectId },
    select: { id: true, projectReference: true, customerRef: true, depositAcceptance: { select: { id: true, acceptedAt: true } } },
  });
  // A project that does not exist and one belonging to someone else are
  // indistinguishable from here, on purpose.
  if (!project || project.customerRef !== customerRef) {
    logger.warn("custom_jewelry_deposit_acceptance.project_unresolved", {});
    return projectUnresolved();
  }

  // ALREADY ACCEPTED — answer with what exists. See the module comment.
  if (project.depositAcceptance) {
    logger.info("custom_jewelry_deposit_acceptance.already_accepted", {
      projectReference: project.projectReference,
    });
    return Response.json(
      {
        projectReference: project.projectReference,
        acceptedAt: project.depositAcceptance.acceptedAt.toISOString(),
        alreadyAccepted: true,
      },
      { status: 200, headers: { "Cache-Control": "private, no-store" } }
    );
  }

  const policyVersion = await getLatestPolicyVersion(CUSTOM_JEWELRY_DEPOSIT_POLICY_SLUG);
  if (!policyVersion) {
    // Refuse rather than record an acceptance that cannot name its own text.
    logger.error("custom_jewelry_deposit_acceptance.policy_unavailable", {
      slug: CUSTOM_JEWELRY_DEPOSIT_POLICY_SLUG,
    });
    return Response.json({ error: "acknowledgment_copy_unavailable" }, { status: 503 });
  }

  // ONE TRANSACTION. The acknowledgment and the acceptance that references it
  // are one fact; an acknowledgment row with no acceptance would be an
  // orphan, and an acceptance without its acknowledgment is impossible by the
  // NOT NULL FK — so the only state worth preventing is the former.
  const acceptedAt = new Date();
  try {
    const acceptance = await prisma.$transaction(async (tx) => {
      const acknowledgment = await createAcknowledgment(
        {
          // The LITERAL pinned constant, never a value from the request. What
          // the customer agreed to is decided here, not claimed by a browser.
          exactText: CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT,
          policyVersionId: policyVersion.id,
          acknowledgedAt: acceptedAt,
          affirmativeActionLabel: CUSTOM_JEWELRY_DEPOSIT_AFFIRMATIVE_ACTION_LABEL,
          customerRef,
          submissionRef: project.id,
        },
        tx
      );

      return recordCustomJewelryDepositAcceptance(
        {
          projectId: project.id,
          acknowledgmentId: acknowledgment.id,
          // FROZEN from the pinned constants — see the module comment.
          amountMinorUnits: CUSTOM_JEWELRY_DEPOSIT_AMOUNT_MINOR_UNITS,
          currency: CUSTOM_JEWELRY_DEPOSIT_CURRENCY,
          customerRef,
          acceptedAt,
        },
        tx
      );
    });

    logger.info("custom_jewelry_deposit_acceptance.recorded", {
      projectReference: project.projectReference,
      policyVersion: policyVersion.version,
    });

    return Response.json(
      {
        projectReference: project.projectReference,
        acceptedAt: acceptance.acceptedAt.toISOString(),
        alreadyAccepted: false,
      },
      { status: 201, headers: { "Cache-Control": "private, no-store" } }
    );
  } catch (error) {
    // THE UNIQUE INDEX, not the check above, is the authority on "once". Two
    // concurrent requests both pass the earlier read; one loses here. The
    // loser is told the same thing as a sequential repeat, because from the
    // customer's side the outcome is identical: their acceptance is recorded.
    if (isUniqueViolation(error)) {
      logger.info("custom_jewelry_deposit_acceptance.concurrent_duplicate", {
        projectReference: project.projectReference,
      });
      const existing = await prisma.customJewelryDepositAcceptance.findUnique({
        where: { projectId: project.id },
        select: { acceptedAt: true },
      });
      if (existing) {
        return Response.json(
          {
            projectReference: project.projectReference,
            acceptedAt: existing.acceptedAt.toISOString(),
            alreadyAccepted: true,
          },
          { status: 200, headers: { "Cache-Control": "private, no-store" } }
        );
      }
    }
    throw error;
  }
}

/**
 * Prisma's unique-constraint code. Matched structurally rather than on the
 * message text, which is not a stable contract.
 */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
