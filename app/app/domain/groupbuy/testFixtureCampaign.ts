/**
 * What makes a Group Buy campaign a TEST FIXTURE, defined in exactly one
 * place.
 *
 * ============================================================================
 * WHY THIS EXISTS
 * ============================================================================
 * Live gates must create real campaigns to prove anything: a campaign that is
 * "real except for the counting" would prove nothing about counting. Those
 * campaigns then persist forever, because `group_buy_campaign` rows CANNOT be
 * deleted — the `group_buy_frozen_child_guard` trigger refuses the cascade
 * (it resolves the parent's status to NULL mid-delete and treats that as
 * "not draft"), and that is before considering that their qualifying units,
 * acknowledgments and audit events are append-only evidence we would not want
 * to destroy anyway.
 *
 * So the question is never "how do we remove them" but "how do we make sure
 * they are never mistaken for business activity". That is this module.
 *
 * ============================================================================
 * THE PREFIX IS THE CONTRACT
 * ============================================================================
 * A fixture campaign's `code` starts with `zz-live-gate-`. `zz-` so it sorts
 * last in any human-scanned list; the rest so it names itself. Every gate that
 * creates one refuses to run against a code without this prefix, and every
 * surface that could show a campaign to a customer or count it as business
 * activity filters on it.
 *
 * ONE DEFINITION, NOT A SCATTERED STRING. A second place that spells the
 * prefix inline is a place that will not be updated when this changes, and
 * the failure is silent: a test campaign quietly appearing in a dashboard
 * total or, worse, on a storefront.
 *
 * ============================================================================
 * WHAT THIS DOES NOT DO
 * ============================================================================
 * It does not delete, hide from audit, or exclude from evidence. A fixture
 * campaign's orders, units, acknowledgments, settlements and refunds remain
 * exactly as recorded — they are history, and history that is inconvenient is
 * still history. This only governs OPERATIONAL and CUSTOMER-FACING surfaces:
 * what staff see as live business, and what a customer can reach at all.
 */

/** Prefix identifying a campaign created by a live gate rather than by the business. */
export const TEST_FIXTURE_CAMPAIGN_CODE_PREFIX = "zz-live-gate-";

/** True when this campaign code belongs to a live-gate fixture. */
export function isTestFixtureCampaignCode(code: string): boolean {
  return code.startsWith(TEST_FIXTURE_CAMPAIGN_CODE_PREFIX);
}

/**
 * A Prisma `where` fragment excluding fixture campaigns.
 *
 * Expressed as a fragment rather than a helper that runs the query, so a
 * caller composes it with its own filters and a reader can see at the call
 * site that fixtures are excluded.
 */
export const EXCLUDE_TEST_FIXTURE_CAMPAIGNS = {
  code: { not: { startsWith: TEST_FIXTURE_CAMPAIGN_CODE_PREFIX } },
} as const;
