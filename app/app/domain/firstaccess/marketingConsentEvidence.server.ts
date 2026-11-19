import { prisma } from "~/db/client.server";
import { getLatestPolicyVersion } from "~/db/repositories/policyVersionRepository.server";
import { logger } from "~/lib/logger.server";

import {
  FIRST_ACCESS_CONSENT_AFFIRMATIVE_ACTION_LABEL,
  FIRST_ACCESS_EMAIL_CONSENT_POLICY_SLUG,
  FIRST_ACCESS_SMS_CONSENT_POLICY_SLUG,
} from "./marketingConsentCopy";

/**
 * OUR OWN EVIDENCE that a First Access subscriber opted in, per channel.
 *
 * ============================================================================
 * WHY THIS EXISTS WHEN SHOPIFY ALREADY RECORDS CONSENT
 * ============================================================================
 * Shopify's record is the OPERATIVE one and must not be duplicated: it is what
 * sending platforms read, what a STOP reply unsubscribes, and what holds the
 * state, opt-in level, timestamp and collection source. Nothing here competes
 * with it.
 *
 * What Shopify does NOT store is **the sentence the customer read**. Its
 * consent object knows the channel and the level; it has no field for "and
 * this is the wording they were shown". For a marketing permission that is the
 * part most worth being able to produce later, so it is the part this adds —
 * together with which version of that wording it was, which is what makes a
 * later rewording survivable.
 *
 * So the division is: Shopify holds the PERMISSION, we hold the PROOF of how
 * it was obtained. Neither is a substitute for the other, and the timestamp is
 * deliberately the same instant in both.
 *
 * ============================================================================
 * THE `Acknowledgment` TABLE, NOT A NEW ONE
 * ============================================================================
 * It already does exactly this job for RMA requests, Luxury Steals, Group Buy
 * cancellations and Custom Jewelry approvals: exact text, a versioned policy
 * reference, an affirmative-action label, a timestamp, nullable subject refs,
 * and `source_ip` / `user_agent`. A bespoke consent table would reimplement
 * all of it and get the append-only guarantees wrong.
 *
 * THE SIGNUP SURFACE IS CARRIED BY THE SLUG, not by a free-text source column.
 * `first-access-email-marketing-consent` means "the Launching Soon signup",
 * so a consent collected at a future checkout or account page gets its own
 * slug rather than the same slug with a different string in it. A column
 * nothing validates is a column that eventually holds anything.
 */

export type MarketingConsentChannel = "email" | "sms";

const SLUG_BY_CHANNEL: Record<MarketingConsentChannel, string> = {
  email: FIRST_ACCESS_EMAIL_CONSENT_POLICY_SLUG,
  sms: FIRST_ACCESS_SMS_CONSENT_POLICY_SLUG,
};

export interface RecordConsentEvidenceInput {
  readonly channel: MarketingConsentChannel;
  /** The authenticated Shopify customer gid. The subject of the consent. */
  readonly customerRef: string;
  /** The SAME instant written to Shopify's own consent record. */
  readonly consentedAt: Date;
  /** Present only when the app proxy forwarded them; both are optional on the column. */
  readonly sourceIp?: string | null;
  readonly userAgent?: string | null;
}

export type RecordConsentEvidenceOutcome =
  | { readonly outcome: "recorded"; readonly acknowledgmentId: string; readonly policyVersion: number }
  /** Already recorded for this customer and channel. Not an error — see below. */
  | { readonly outcome: "already_recorded"; readonly acknowledgmentId: string }
  /** The policy row is missing, i.e. the migration has not run. Loud, and never silent. */
  | { readonly outcome: "policy_missing" };

/**
 * Writes one channel's evidence.
 *
 * ============================================================================
 * IDEMPOTENT PER CUSTOMER PER CHANNEL, AND THAT IS THE POINT
 * ============================================================================
 * The theme re-sends a signup on a reload-handoff path, and a customer can
 * submit the form twice. Without a guard, one consent would accumulate
 * duplicate acknowledgment rows, and a pile of identical evidence is harder to
 * read than one row — an auditor cannot tell three records of one consent from
 * one customer consenting three times.
 *
 * So it checks for an existing row with the same customer and the same policy
 * SLUG (any version). "Any version" is deliberate: a customer who consented
 * under v1 has consented, and showing them v2 later does not create a new
 * permission to record — a genuine re-consent after a wording change is a
 * product decision with its own flow, not something to infer from a resubmit.
 *
 * NOT A UNIQUE CONSTRAINT, because `Acknowledgment` is shared by six domains
 * with different cardinality rules and `customer_ref` is nullable for most of
 * them. The check lives here, where the rule actually applies.
 */
export async function recordMarketingConsentEvidence(
  input: RecordConsentEvidenceInput
): Promise<RecordConsentEvidenceOutcome> {
  const slug = SLUG_BY_CHANNEL[input.channel];

  const policy = await getLatestPolicyVersion(slug);
  if (!policy) {
    // A MISSING POLICY MUST NOT BE PAPERED OVER. Recording an acknowledgment
    // without a version would produce evidence that cannot say what was
    // agreed to, and inventing a row here would write unapproved wording into
    // an append-only table.
    logger.error("firstaccess.consent_policy_missing", { slug });
    return { outcome: "policy_missing" };
  }

  const existing = await prisma.acknowledgment.findFirst({
    where: { customerRef: input.customerRef, policyVersion: { slug } },
    select: { id: true },
  });
  if (existing) {
    return { outcome: "already_recorded", acknowledgmentId: existing.id };
  }

  const created = await prisma.acknowledgment.create({
    data: {
      // THE POLICY'S OWN TEXT, not the module constant and not anything the
      // request sent. The row and the version it points at can then never
      // disagree, which is the one way this record could mislead.
      exactText: policy.text,
      policyVersionId: policy.id,
      acknowledgedAt: input.consentedAt,
      affirmativeActionLabel: FIRST_ACCESS_CONSENT_AFFIRMATIVE_ACTION_LABEL,
      customerRef: input.customerRef,
      sourceIp: input.sourceIp ?? null,
      userAgent: input.userAgent ?? null,
    },
    select: { id: true },
  });

  logger.info("firstaccess.consent_recorded", {
    channel: input.channel,
    policyVersion: policy.version,
    acknowledgmentId: created.id,
  });

  return { outcome: "recorded", acknowledgmentId: created.id, policyVersion: policy.version };
}
