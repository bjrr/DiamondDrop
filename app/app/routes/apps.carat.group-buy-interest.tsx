import type { ActionFunctionArgs } from "react-router";

import { recordGroupBuyDemandSignal } from "~/db/repositories/groupBuyDemandSignalRepository.server";
import { getLatestPolicyVersion } from "~/db/repositories/policyVersionRepository.server";
import {
  BRING_IT_BACK_POLICY_SLUG,
  DEMAND_CAPTURE_AFFIRMATIVE_ACTION_LABEL,
  NEW_CAMPAIGN_REQUEST_POLICY_SLUG,
} from "~/domain/groupbuy/demandCaptureCopy";
import { parseDemandSignal } from "~/domain/groupbuy/demandSignal";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * POST /apps/carat/group-buy-interest
 *
 * "Bring It Back / Notify Me If It Returns" and "Request a New Group Buy".
 * README: low-friction interest capture, and explicitly "do not turn either
 * into a custom-design questionnaire".
 *
 * A RESOURCE ROUTE — no default export. Same reasoning as every other
 * `apps.carat.*` route.
 *
 * ============================================================================
 * THE COPY IS NOT APPROVED, SO THIS ENDPOINT REFUSES TO RUN
 * ============================================================================
 * `demandCaptureCopy.ts` explains why in full. Until the owner approves the
 * disclosure text (a `policy_version` row) and the affirmative-action label,
 * this returns 503 `copy_pending_approval`. Everything else here is finished
 * and tested: the two kinds, the deduplication, the normalisation, the
 * evidence trail. Only the words are missing.
 *
 * Failing closed rather than shipping placeholder text is the same guard
 * `apps.carat.custom-jewelry-approval` uses — a form that invites someone to
 * accept something we cannot record is a form that loses their acceptance.
 *
 * ============================================================================
 * THE RESPONSE NEVER REVEALS WHETHER AN ADDRESS IS ALREADY ON FILE
 * ============================================================================
 * Anyone can POST here about anyone. A response that distinguished "recorded"
 * from "already registered" would be a free lookup for "is this person
 * watching this campaign", so both return the identical body. The distinction
 * is logged, never served.
 *
 * For the same reason there is no GET: a read endpoint would have to decide
 * who may ask about an address, and the answer is nobody.
 */

const PENDING_COPY_RESPONSE = {
  error: "copy_pending_approval",
} as const;

function badRequest(problems: readonly string[]) {
  // The problems are enumerated rather than collapsed, so the theme can mark
  // the offending field instead of printing one vague sentence.
  return Response.json({ error: "invalid_submission", problems }, { status: 400 });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const { verified } = verifyAppProxySignature(url.searchParams, getEnv().SHOPIFY_API_SECRET);
  if (!verified) {
    logger.warn("groupbuy.interest_proxy_rejected", { reason: "invalid_or_missing_signature" });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const formData = await request.formData();
  const parsed = parseDemandSignal({
    kind: String(formData.get("kind") ?? ""),
    email: String(formData.get("email") ?? ""),
    campaignRef: formData.get("campaignRef") === null ? null : String(formData.get("campaignRef")),
    note: formData.get("note") === null ? null : String(formData.get("note")),
  });
  if (!parsed.ok) return badRequest(parsed.problems);

  // ==========================================================================
  // THE COPY GATE. Checked AFTER validation so a malformed submission still
  // gets a useful answer, and BEFORE any write so nothing is captured without
  // a record of what the person was shown.
  // ==========================================================================
  const slug =
    parsed.value.kind === "bring_it_back" ? BRING_IT_BACK_POLICY_SLUG : NEW_CAMPAIGN_REQUEST_POLICY_SLUG;
  const policy = await getLatestPolicyVersion(slug);
  const label = DEMAND_CAPTURE_AFFIRMATIVE_ACTION_LABEL;

  if (!policy || !label) {
    logger.error("groupbuy.interest_copy_pending_approval", {
      kind: parsed.value.kind,
      slug,
      policyPresent: Boolean(policy),
      labelPresent: Boolean(label),
    });
    return Response.json(PENDING_COPY_RESPONSE, { status: 503 });
  }

  const { outcome } = await recordGroupBuyDemandSignal({
    submission: parsed.value,
    acknowledgment: {
      // THE EXACT TEXT FROM THE VERSIONED ROW, not a constant in this file.
      // A copy change is then a new policy_version with its own
      // acknowledgments, rather than a deploy that silently restates what
      // earlier customers were told.
      exactText: policy.text,
      policyVersionId: policy.id,
      acknowledgedAt: new Date(),
      affirmativeActionLabel: label,
      ...(parsed.value.campaignRef ? { campaignRef: parsed.value.campaignRef } : {}),
      // NO sourceIp, NO userAgent. The columns exist, and populating them
      // here would be collecting more about someone than the thing they asked
      // for needs — CLAUDE.md "Minimize PII". A notification request is not a
      // transaction under dispute.
    },
  });

  logger.info("groupbuy.interest_captured", {
    kind: parsed.value.kind,
    campaignRef: parsed.value.campaignRef,
    // THE OUTCOME IS LOGGED AND NOT SERVED. See this route's header.
    outcome,
  });

  // IDENTICAL FOR BOTH OUTCOMES.
  return Response.json({ ok: true }, { status: 200 });
}
