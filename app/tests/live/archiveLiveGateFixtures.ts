/**
 * Archives the live-gate fixture campaigns, once their gates are closed
 * (owner-directed 2026-10-05).
 *
 * ARCHIVES, NEVER DELETES. These campaigns carry real qualifying units, real
 * orders and real acknowledgments. That evidence stays exactly as recorded —
 * the owner was explicit, and the database now refuses the delete anyway
 * (`group_buy_campaign_no_delete_with_history`). Archiving is an annotation
 * that keeps them out of the default staff view; nothing becomes unqueryable.
 *
 * IDEMPOTENT. Re-archiving an already-archived campaign would rewrite its
 * timestamp and lose when it was actually archived, so already-archived rows
 * are reported and skipped rather than touched.
 *
 * RUN: npx tsx tests/live/archiveLiveGateFixtures.ts
 *   DATABASE_URL must point at the production database.
 */
import "dotenv/config";

const REASON = "Production live-gate test campaign — retained for audit evidence; not customer-facing.";
const ARCHIVED_BY = "owner:archive-live-gate-fixtures";

async function main() {
  const { prisma } = await import("~/db/client.server");
  const { archiveGroupBuyCampaign, describeGroupBuyCampaignHistory } = await import(
    "~/db/repositories/groupBuyRepository.server"
  );
  const { TEST_FIXTURE_CAMPAIGN_CODE_PREFIX } = await import("~/domain/groupbuy/testFixtureCampaign");

  const fixtures = await prisma.groupBuyCampaign.findMany({
    where: { code: { startsWith: TEST_FIXTURE_CAMPAIGN_CODE_PREFIX } },
    select: { id: true, code: true, status: true, archivedAt: true },
    orderBy: { createdAt: "asc" },
  });

  console.log(`Found ${fixtures.length} live-gate fixture campaign(s).\n`);

  for (const campaign of fixtures) {
    // Printed so the record shows what was retained, not merely that something
    // was hidden. "Archived 3 campaigns" tells a future reader nothing about
    // what evidence still exists under them.
    const history = await describeGroupBuyCampaignHistory(campaign.id);
    const evidence = history.hasHistory ? history.describedParts.join(", ") : "no dependent evidence";

    if (campaign.archivedAt) {
      console.log(`  SKIP  ${campaign.code} — already archived ${campaign.archivedAt.toISOString()} (${evidence})`);
      continue;
    }

    await archiveGroupBuyCampaign({ campaignId: campaign.id, archivedBy: ARCHIVED_BY, reason: REASON });
    console.log(`  ARCHIVED  ${campaign.code}  status=${campaign.status}  retains: ${evidence}`);
  }

  const remaining = await prisma.groupBuyCampaign.count({
    where: { code: { startsWith: TEST_FIXTURE_CAMPAIGN_CODE_PREFIX }, archivedAt: null },
  });
  console.log(`\nUnarchived fixtures remaining: ${remaining}`);
  if (remaining !== 0) process.exitCode = 1;

  await prisma.$disconnect();
}

main().catch((error) => {
  console.error("\n", error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
