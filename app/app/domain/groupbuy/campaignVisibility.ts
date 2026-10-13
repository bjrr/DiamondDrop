import { TEST_FIXTURE_CAMPAIGN_CODE_PREFIX } from "./testFixtureCampaign";

/**
 * WHO MAY SEE WHICH CAMPAIGNS. One predicate per audience, defined once.
 *
 * ============================================================================
 * THE DISTINCTION THAT MATTERS MOST (owner-locked 2026-10-05)
 * ============================================================================
 * INTERNAL STAFF ARCHIVING AND THE PUBLIC "PAST GROUP BUYS" ARCHIVE ARE NOT
 * THE SAME THING, and conflating them would be a real mistake in both
 * directions:
 *
 *   - A legitimate completed customer campaign may belong in the PUBLIC Past
 *     Group Buys history even after staff archive it internally. Staff
 *     archiving is a dashboard-tidying decision; it says nothing about whether
 *     customers should still be able to see that the campaign happened.
 *   - A TEST campaign must never appear in Past Group Buys, archived or not.
 *
 * So `archivedAt` must NOT be used to filter the public archive, and the
 * fixture prefix must ALWAYS be. They are different questions with different
 * answers, which is why they are separate exported fragments rather than one
 * "visible" flag someone would inevitably reuse for both.
 *
 * ============================================================================
 * SURFACES THAT DO NOT EXIST YET
 * ============================================================================
 * Past Group Buys (slice 13), Group Buy milestone emails (slice 7+), and
 * operational revenue/participation metrics are not built. These fragments
 * exist now anyway, because the alternative is that whoever builds them writes
 * a filter inline and gets this distinction wrong silently — a test campaign in
 * a customer archive, or a real campaign vanishing from public history because
 * someone tidied a dashboard.
 *
 * `campaignVisibilityFence.test.ts` requires any new campaign-listing query to
 * use one of these rather than an inline condition.
 */

/** Live-gate fixtures: never business, never customer-facing, in any context. */
export const EXCLUDE_TEST_FIXTURE_CAMPAIGNS = {
  code: { not: { startsWith: TEST_FIXTURE_CAMPAIGN_CODE_PREFIX } },
} as const;

/** Internally archived by staff. Affects STAFF listings only — never the public archive. */
export const EXCLUDE_ARCHIVED_CAMPAIGNS = { archivedAt: null } as const;

/**
 * The default STAFF operational view: real business campaigns a human should
 * read as live activity. Excludes fixtures and internally-archived campaigns.
 *
 * Both exclusions are presentation only. Every archived and fixture campaign
 * remains fully queryable — see `STAFF_ARCHIVED_ONLY` and the repository's
 * `includeTestFixtures` option. Archiving must never make audit history
 * inaccessible to staff, which is a requirement, not a nicety.
 */
export const STAFF_OPERATIONAL_CAMPAIGNS = {
  ...EXCLUDE_TEST_FIXTURE_CAMPAIGNS,
  ...EXCLUDE_ARCHIVED_CAMPAIGNS,
} as const;

/** The explicit staff "Archived" view: exactly the campaigns the default view hides for being archived. */
export const STAFF_ARCHIVED_ONLY = { archivedAt: { not: null } } as const;

/**
 * Eligible for the PUBLIC Past Group Buys archive.
 *
 * NOTE WHAT IS ABSENT: `archivedAt`. A completed customer campaign stays in
 * public history whether or not staff later archived it internally — see this
 * module's header. Fixtures are excluded unconditionally, and only a `closed`
 * campaign is past.
 */
export const PUBLIC_PAST_GROUP_BUY_CAMPAIGNS = {
  ...EXCLUDE_TEST_FIXTURE_CAMPAIGNS,
  status: "closed",
} as const;
