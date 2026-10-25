import type { ActionFunctionArgs } from "react-router";

import { recordGroupBuyDemandSignal } from "~/db/repositories/groupBuyDemandSignalRepository.server";
import { getLatestPolicyVersion } from "~/db/repositories/policyVersionRepository.server";
import {
  BRING_IT_BACK_AFFIRMATIVE_ACTION_LABEL,
  BRING_IT_BACK_POLICY_SLUG,
  DEMAND_CAPTURE_CONFIRMATION_TEXT,
  NEW_CAMPAIGN_REQUEST_AFFIRMATIVE_ACTION_LABEL,
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
 * THE SUBMIT BUTTON IS THE AFFIRMATIVE ACTION (owner decision 2026-10-12)
 * ============================================================================
 * There is no consent tickbox: the disclosure is shown above the form and
 * pressing the button is the act. The acknowledgment still records BOTH the
 * exact disclosure text (read from the versioned row, never a constant here)
 * and the exact caption pressed, so an evidence row can never describe words
 * the customer did not see.
 *
 * IT STILL FAILS CLOSED when the policy row is absent — 503
 * `copy_pending_approval`, the same guard `apps.carat.custom-jewelry-approval`
 * uses. Reaching it now means the provisioning migration has not run in this
 * environment, and capturing an address with no record of what the person was
 * told is worse than asking them to try again.
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
  const { verified, shop, reason } = verifyAppProxySignature(url.searchParams, getEnv().SHOPIFY_API_SECRET, getEnv().SHOPIFY_SHOP_DOMAIN);
  if (!verified) {
    logger.warn("groupbuy.interest_proxy_rejected", { reason, signedShop: shop });
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
  const isBringItBack = parsed.value.kind === "bring_it_back";
  const slug = isBringItBack ? BRING_IT_BACK_POLICY_SLUG : NEW_CAMPAIGN_REQUEST_POLICY_SLUG;
  // ONE LABEL PER KIND. The two forms ask for different things, and a caption
  // vague enough to cover both is exactly the wording a customer later says
  // they did not understand.
  const label = isBringItBack
    ? BRING_IT_BACK_AFFIRMATIVE_ACTION_LABEL
    : NEW_CAMPAIGN_REQUEST_AFFIRMATIVE_ACTION_LABEL;

  const policy = await getLatestPolicyVersion(slug);
  if (!policy) {
    // STILL FAILS CLOSED. The copy is approved and provisioned by migration
    // 20261012030000, so reaching this means the migration has not run here —
    // and capturing an address with no record of what the person was told is
    // worse than asking them to try again.
    logger.error("groupbuy.interest_copy_pending_approval", { kind: parsed.value.kind, slug });
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

  // IDENTICAL FOR BOTH OUTCOMES, down to the message — see the header. The
  // confirmation travels in the response so the theme renders the approved
  // sentence rather than retyping one.
  return Response.json({ ok: true, message: DEMAND_CAPTURE_CONFIRMATION_TEXT }, { status: 200 });
}
