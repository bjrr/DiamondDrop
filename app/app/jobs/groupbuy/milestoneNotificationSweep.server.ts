import { createHash } from "node:crypto";

import { prisma } from "~/db/client.server";
import { idempotencyKeyRepository } from "~/db/repositories/idempotencyKeyRepository.server";
import {
  buildGroupBuyMilestoneEmail,
  milestoneKey,
  type GroupBuyMilestone,
} from "~/domain/groupbuy/milestoneEmail";
import { resolveEmailPort as resolveRealEmailPort, type EmailPortResolution } from "~/lib/email/configuredPort.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";

import { getCurrentTier } from "./unitLedger.server";

/**
 * THE GROUP BUY MILESTONE NOTIFICATION SWEEP — delivers the participant
 * emails README line 245 requires (tier unlock, best-tier unlock, campaign
 * close). The copy itself lives in `~/domain/groupbuy/milestoneEmail`, which
 * is pure; this module is the part that decides WHO and WHETHER.
 *
 * ============================================================================
 * WHY A SWEEP AND NOT AN INLINE SEND AT THE MOMENT THE TIER CHANGES
 * ============================================================================
 * The obvious place to send "tier 3 unlocked" is inside `recordUnitEvent`,
 * where the tier actually moves. That place is reached from the Shopify
 * orders webhook, and it is the wrong place for three reasons:
 *
 *   1. it would put N provider round-trips (N = every participant) inside a
 *      webhook handler that Shopify will retry if it is slow — turning a mail
 *      provider's bad minute into duplicated order processing;
 *   2. unit recording is money-adjacent and must not acquire a dependency on
 *      an email provider being up;
 *   3. a tier can move more than once in a burst of orders. A sweep naturally
 *      coalesces that into one email about the tier the group is actually on,
 *      which is exactly what README's "do not email for every unit change"
 *      asks for.
 *
 * The sweep is idempotent under arbitrarily frequent or overlapping
 * invocation. Cadence is scheduler configuration, not encoded here.
 *
 * ============================================================================
 * IDEMPOTENCY IS PER RECIPIENT, AND PER MILESTONE
 * ============================================================================
 * Reuses the existing `IdempotencyKey` table rather than introducing a
 * notification ledger — no migration, and the semantics already match.
 *
 *   per recipient: `groupbuy_milestone:<campaign>:<milestone>:<recipient>`
 *   per campaign:  `groupbuy_milestone_complete:<campaign>:<milestone>`
 *
 * Per-recipient keys are what actually prevent a duplicate email: if the
 * sweep dies halfway through a 200-person broadcast, the next run sends only
 * the remaining 150.
 *
 * The per-campaign "complete" marker exists for a different reason — cost. A
 * closed campaign stays closed forever, and resolving its participant list
 * requires a Shopify lookup per Card order. Without the marker the sweep
 * would re-resolve every historical campaign's participants on every run,
 * forever, just to discover it had nothing to send. The marker is written
 * only after a pass in which nothing failed and nothing was left unresolved,
 * so a partial pass is always retried.
 *
 * RECIPIENTS ARE HASHED INTO THE KEY, NEVER STORED IN PLAINTEXT. CLAUDE.md
 * requires minimising PII; a customer's address has no business sitting in an
 * operational bookkeeping table. SHA-256 of the normalised address is stable,
 * which is all the key needs to be.
 *
 * ============================================================================
 * A FAILED SEND IS NOT AUTO-RETRIED
 * ============================================================================
 * Deliberate, and consistent with how this codebase already treats customer
 * mail (see the Group Buy payment-instructions send, which logs at error and
 * leaves staff to send by hand rather than retrying). Auto-retry here would
 * either loop forever on a permanently bad address or need a backoff schedule
 * that MVP1's scope freeze does not justify. Every failure is logged at error
 * with the campaign and milestone so staff can act, and the returned summary
 * counts them.
 *
 * A milestone email is also never worth failing the sweep over: one
 * campaign's problem must not stop another campaign's notifications, so each
 * campaign is isolated.
 */

export interface GroupBuyParticipantEmailLookupPort {
  /** Null when the order is gone or carries no email (e.g. a guest checkout). */
  resolveOrderEmail(orderGid: string): Promise<string | null>;
}

/**
 * Builds the real Shopify-backed participant lookup for the scheduled run.
 *
 * THIS LIVES IN THE JOB MODULE, NOT IN THE ROUTE, and that placement is
 * enforced: `shopify.server.test.ts` fences every `internal.jobs.*` route
 * against calling `unauthenticated.admin` directly, because a cron request
 * carries no shop session and no App Bridge frame. The route therefore calls
 * this function, exactly as `internal.jobs.bank-payment-guarantee.tsx`
 * reaches the Admin API only through `guaranteeSweep.server.ts`. This module
 * is listed in that test's `BACKGROUND_ADMIN_CALLERS`; adding another caller
 * means adding it there too.
 *
 * Undefined when `SHOPIFY_SHOP_DOMAIN` is unset: the sweep then emails Bank
 * Payment participants, reports the Card ones as unresolved, and withholds
 * the completion marker so a properly configured later run finishes the job.
 */
export async function resolveDefaultParticipantEmailLookup(): Promise<
  GroupBuyParticipantEmailLookupPort | undefined
> {
  const shop = getEnv().SHOPIFY_SHOP_DOMAIN;
  if (!shop) {
    logger.warn("group_buy_milestone.participant_lookup_unconfigured", { reason: "SHOPIFY_SHOP_DOMAIN unset" });
    return undefined;
  }

  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(shop);
  const { ShopifyGroupBuyParticipantEmailAdapter } = await import(
    "~/shopify/admin/groupBuyParticipantEmailAdapter.server"
  );
  return new ShopifyGroupBuyParticipantEmailAdapter(admin);
}

export interface GroupBuyMilestoneSweepDeps {
  /** Defaults to the real resolver (reads process env). Injectable for tests. */
  resolveEmailPort?: () => EmailPortResolution;
  /**
   * Resolves Card-basis participants' addresses from Shopify. When absent,
   * Card participants are counted as unresolved and only Bank Payment
   * participants are emailed — the sweep does not silently pretend the list
   * was complete, and withholds the completion marker so a later run with a
   * lookup configured finishes the job.
   */
  participantEmailLookup?: GroupBuyParticipantEmailLookupPort;
}

export interface GroupBuyMilestoneSweepSummary {
  readonly campaignsExamined: number;
  readonly milestonesDispatched: number;
  readonly emailsSent: number;
  readonly emailsAlreadySent: number;
  readonly emailsFailed: number;
  /** Participants whose address could not be determined. Never silently zero. */
  readonly recipientsUnresolved: number;
}

const OPERATION_TYPE = "group_buy_milestone_email";

export async function runGroupBuyMilestoneSweep(
  deps: GroupBuyMilestoneSweepDeps = {}
): Promise<GroupBuyMilestoneSweepSummary> {
  const resolvePort = deps.resolveEmailPort ?? resolveRealEmailPort;

  const campaigns = await prisma.groupBuyCampaign.findMany({
    // Draft campaigns have no participants to notify. Everything else does.
    where: { status: { in: ["open", "closed"] } },
    include: { tiers: { orderBy: { tierNumber: "asc" } } },
    orderBy: { createdAt: "asc" },
  });

  const totals = {
    campaignsExamined: campaigns.length,
    milestonesDispatched: 0,
    emailsSent: 0,
    emailsAlreadySent: 0,
    emailsFailed: 0,
    recipientsUnresolved: 0,
  };

  for (const campaign of campaigns) {
    try {
      const milestone = await currentMilestoneFor(campaign);
      if (!milestone) continue;

      const key = milestoneKey(milestone);
      if (await isMilestoneComplete(campaign.id, key)) continue;

      const result = await dispatchMilestone(campaign, milestone, resolvePort, deps.participantEmailLookup);

      totals.milestonesDispatched += 1;
      totals.emailsSent += result.sent;
      totals.emailsAlreadySent += result.alreadySent;
      totals.emailsFailed += result.failed;
      totals.recipientsUnresolved += result.unresolved;
    } catch (error) {
      // One campaign's failure must not stop the others.
      logger.error("group_buy_milestone.campaign_failed", {
        campaignId: campaign.id,
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  logger.info("group_buy_milestone.sweep_complete", { ...totals });
  return totals;
}

type CampaignWithTiers = Awaited<ReturnType<typeof prisma.groupBuyCampaign.findMany>>[number] & {
  tiers: { tierNumber: number }[];
};

/**
 * The ONE milestone a campaign is currently at, or null.
 *
 * Only the current state produces an email. A campaign that crossed tiers 2
 * and 3 between sweeps reports tier 3 — see `milestoneEmail.ts` on why
 * skipped tiers are not backfilled.
 */
async function currentMilestoneFor(campaign: CampaignWithTiers): Promise<GroupBuyMilestone | null> {
  if (campaign.status === "closed") {
    // The locked values, not a fresh fold. A campaign closed without settled
    // final figures is not ready to be announced.
    if (campaign.finalTierNumber === null || campaign.finalQualifyingUnits === null) return null;
    return {
      kind: "campaign_closed",
      finalTierNumber: campaign.finalTierNumber,
      finalQualifyingUnits: campaign.finalQualifyingUnits,
    };
  }

  const bestTierNumber = campaign.tiers.at(-1)?.tierNumber;
  if (bestTierNumber === undefined) return null;

  const { tier, qualifyingUnits } = await getCurrentTier(campaign.id);

  // Tier 1 is where every campaign starts. Announcing it as "unlocked" would
  // be an email about nothing having happened.
  if (tier.tierNumber < 2) return null;

  return tier.tierNumber >= bestTierNumber
    ? { kind: "best_tier_unlocked", tierNumber: tier.tierNumber, qualifyingUnits }
    : { kind: "tier_unlocked", tierNumber: tier.tierNumber, qualifyingUnits };
}

interface DispatchResult {
  sent: number;
  alreadySent: number;
  failed: number;
  unresolved: number;
}

async function dispatchMilestone(
  campaign: CampaignWithTiers,
  milestone: GroupBuyMilestone,
  resolvePort: () => EmailPortResolution,
  lookup: GroupBuyParticipantEmailLookupPort | undefined
): Promise<DispatchResult> {
  const key = milestoneKey(milestone);
  const result: DispatchResult = { sent: 0, alreadySent: 0, failed: 0, unresolved: 0 };

  const resolution = resolvePort();
  if (!resolution.configured) {
    // Nothing is marked complete, so a later run with mail configured will
    // still deliver this milestone.
    logger.error("group_buy_milestone.email_unconfigured", {
      campaignId: campaign.id,
      milestone: key,
      reason: resolution.reason,
    });
    return result;
  }

  const { emails, unresolved } = await resolveParticipantEmails(campaign.id, lookup);
  result.unresolved = unresolved;

  const content = buildGroupBuyMilestoneEmail({
    campaignCode: campaign.code,
    campaignName: campaign.name,
    milestone,
  });

  for (const email of emails) {
    const idempotencyKey = `groupbuy_milestone:${campaign.id}:${key}:${recipientFingerprint(email)}`;

    const claimed = await idempotencyKeyRepository.tryCreatePending(idempotencyKey, OPERATION_TYPE, {
      campaignId: campaign.id,
      milestone: key,
    });
    if (!claimed) {
      result.alreadySent += 1;
      continue;
    }

    try {
      const sendResult = await resolution.port.send({
        from: resolution.from,
        to: [email],
        subject: content.subject,
        text: content.text,
      });
      await idempotencyKeyRepository.recordSuccess(idempotencyKey, {
        providerMessageId: sendResult.providerMessageId,
      });
      result.sent += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      await idempotencyKeyRepository.recordFailure(idempotencyKey, message);
      result.failed += 1;
      // NO ADDRESS IS LOGGED. The fingerprint is enough to correlate with the
      // idempotency row, which is where staff look to resolve it.
      logger.error("group_buy_milestone.email_failed", {
        campaignId: campaign.id,
        milestone: key,
        recipientFingerprint: recipientFingerprint(email),
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  // Only a clean, complete pass closes the milestone out. A failure or an
  // unresolved participant leaves it open for the next run.
  if (result.failed === 0 && result.unresolved === 0) {
    await markMilestoneComplete(campaign.id, key);
  }

  logger.info("group_buy_milestone.dispatched", {
    campaignId: campaign.id,
    milestone: key,
    ...result,
  });

  return result;
}

/**
 * Every participant in a campaign, both payment bases, deduplicated.
 *
 * Bank Payment participants come from the local table, which stores the
 * address captured at checkout. INACTIVE ORDERS ARE INCLUDED: an order
 * inactivated for non-payment still counts toward campaign progress (the
 * status enum says so explicitly) and can be reactivated by email while the
 * campaign is open, so its owner is still a participant. Excluding them would
 * hide the campaign's progress from exactly the people most likely to act on
 * it.
 *
 * Card participants are found by subtracting the Bank Payment orders from the
 * ledger's distinct order references, then asking Shopify for each remaining
 * order's email. The subtraction matters: a Bank Payment order also produces
 * unit events, so without it every Bank participant would cost a redundant
 * Shopify round-trip.
 */
async function resolveParticipantEmails(
  campaignId: string,
  lookup: GroupBuyParticipantEmailLookupPort | undefined
): Promise<{ emails: string[]; unresolved: number }> {
  const bankOrders = await prisma.groupBuyBankPaymentOrder.findMany({
    where: { campaignId },
    select: { customerEmail: true, shopifyOrderGid: true },
  });

  const ledgerOrderRefs = await prisma.groupBuyUnitEvent.findMany({
    where: { campaignId },
    select: { orderRef: true },
    distinct: ["orderRef"],
  });

  const bankOrderGids = new Set(bankOrders.map((o) => o.shopifyOrderGid));
  const cardOrderRefs = ledgerOrderRefs.map((e) => e.orderRef).filter((ref) => !bankOrderGids.has(ref));

  // Case-insensitive dedupe; the first spelling seen is the one used.
  const seen = new Set<string>();
  const emails: string[] = [];
  const add = (raw: string): void => {
    const email = raw.trim();
    if (!email) return;
    const normalised = email.toLowerCase();
    if (seen.has(normalised)) return;
    seen.add(normalised);
    emails.push(email);
  };

  for (const order of bankOrders) add(order.customerEmail);

  let unresolved = 0;
  for (const orderRef of cardOrderRefs) {
    if (!lookup) {
      unresolved += 1;
      continue;
    }
    try {
      const email = await lookup.resolveOrderEmail(orderRef);
      if (email) add(email);
      else unresolved += 1;
    } catch (error) {
      unresolved += 1;
      logger.error("group_buy_milestone.participant_lookup_failed", {
        campaignId,
        errorName: error instanceof Error ? error.name : "unknown",
      });
    }
  }

  return { emails, unresolved };
}

function completionKey(campaignId: string, milestone: string): string {
  return `groupbuy_milestone_complete:${campaignId}:${milestone}`;
}

async function isMilestoneComplete(campaignId: string, milestone: string): Promise<boolean> {
  const row = await idempotencyKeyRepository.findByKey(completionKey(campaignId, milestone));
  return row !== null;
}

async function markMilestoneComplete(campaignId: string, milestone: string): Promise<void> {
  const key = completionKey(campaignId, milestone);
  if (await idempotencyKeyRepository.tryCreatePending(key, OPERATION_TYPE, { campaignId, milestone })) {
    await idempotencyKeyRepository.recordSuccess(key, { complete: true });
  }
}

/** SHA-256 of the normalised address. Stable, and not the address itself. */
function recipientFingerprint(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 32);
}
