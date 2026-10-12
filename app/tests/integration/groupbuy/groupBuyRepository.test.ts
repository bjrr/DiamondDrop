import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  GroupBuyCampaignNotDraftForConfigurationError,
  GroupBuyCampaignNotFoundError,
  addGroupBuyCampaignEligibleVariant,
  createGroupBuyCampaign,
  getGroupBuyCampaignForStaff,
  getGroupBuyVariantIdentities,
  getFrozenGroupBuyCampaignOptions,
  getLatestGroupBuyCampaignOptionsUpload,
  listGroupBuyCampaignsForStaff,
  archiveGroupBuyCampaign,
  unarchiveGroupBuyCampaign,
  describeGroupBuyCampaignHistory,
  deleteGroupBuyCampaign,
  GroupBuyCampaignHasHistoryError,
  GroupBuyCampaignNotDeletableStatusError,
  GroupBuyCampaignArchiveReasonRequiredError,
  listMasterVariantsForGroupBuySelection,
  removeGroupBuyCampaignEligibleVariant,
  replaceGroupBuyCampaignTiers,
  saveGroupBuyCampaignOptionsUpload,
} from "~/db/repositories/groupBuyRepository.server";
import { validateGroupBuyCampaignOptions } from "~/domain/groupbuy/campaignOptions";
import { InvalidTierSetError, type TierDefinition } from "~/domain/groupbuy/tiers";
import { openGroupBuyCampaign } from "~/jobs/groupbuy/openCampaign.server";

/**
 * Draft-only campaign/tier/variant configuration and the admin-surface
 * reads this repository owns. Refund computation and lifecycle moved to
 * `app/jobs/groupbuy/refundLedger.server.ts` during the Group Buy
 * refund-ledger consolidation (architect decision, 2026-09-28) — see
 * `tests/integration/groupbuy/refundLedger.test.ts` and
 * `tests/integration/groupbuy/campaignSettlement.test.ts` for that coverage,
 * including the moved `recordGroupBuyRefundOverride` (now
 * `refundLedger.server.ts`'s own). `openGroupBuyCampaign` is exercised for
 * real here only as fixture setup — its own guarantees are already proven in
 * `openCampaign.test.ts` and are not re-tested.
 */

const ASOF = new Date("2026-09-18T12:00:00Z");
let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;

async function eligibleVariant() {
  return prisma.masterVariant.findFirstOrThrow({
    where: { status: "active", isLuxurySteal: false },
    orderBy: { baseWeightGrams: "desc" },
  });
}

/**
 * A campaign carrying real historical evidence — one qualifying unit event.
 * Written directly rather than through the ledger: this fixture only needs a
 * dependent row to exist, and going through the real recording path would
 * drag in campaign-open, freezing and tier publication that have nothing to
 * do with what the deletion guard is being asked.
 */
async function seedCampaignWithUnits() {
  const variant = await eligibleVariant();
  const campaign = await createGroupBuyCampaign({
    code: `gb-history-${uniq()}`,
    name: "has history",
    currency: "USD",
    createdBy: "integration-test",
    tiers: TIERS,
  });
  await prisma.groupBuyUnitEvent.create({
    data: {
      campaignId: campaign.id,
      masterVariantId: variant.id,
      kind: "purchased",
      quantity: 1,
      orderRef: `gid://shopify/Order/${uniq()}`,
      lineRef: `gid://shopify/LineItem/${uniq()}`,
      externalRef: `ext-${uniq()}`,
      occurredAt: new Date(),
      recordedBy: "integration-test",
    },
  });
  return { campaignId: campaign.id };
}

const TIERS: readonly TierDefinition[] = [
  { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
  { tierNumber: 2, minQualifyingUnits: 5, priceMultiplier: "0.990000" },
];

describe("createGroupBuyCampaign / tier & variant configuration — draft only", () => {
  it("creates a draft campaign with its tiers", async () => {
    const campaign = await createGroupBuyCampaign({
      code: `gb-repo-${uniq()}`,
      name: "repo fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });
    expect(campaign.status).toBe("draft");

    const full = await getGroupBuyCampaignForStaff(campaign.id);
    expect(full?.tiers).toHaveLength(2);
  });

  it("refuses an invalid tier set before writing anything", async () => {
    await expect(
      createGroupBuyCampaign({
        code: `gb-repo-badtiers-${uniq()}`,
        name: "bad tiers",
        currency: "USD",
        createdBy: "integration-test",
        tiers: [{ tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" }], // only 1 — below MIN_TIERS
      })
    ).rejects.toBeInstanceOf(InvalidTierSetError);
  });

  it("replaceGroupBuyCampaignTiers overwrites a draft campaign's tier set", async () => {
    const campaign = await createGroupBuyCampaign({
      code: `gb-repo-${uniq()}`,
      name: "repo fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });

    const replaced = await replaceGroupBuyCampaignTiers(campaign.id, [
      { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
      { tierNumber: 2, minQualifyingUnits: 8, priceMultiplier: "0.950000" },
      { tierNumber: 3, minQualifyingUnits: 20, priceMultiplier: "0.900000" },
    ]);
    expect(replaced).toHaveLength(3);

    const full = await getGroupBuyCampaignForStaff(campaign.id);
    expect(full?.tiers.map((t) => t.tierNumber)).toEqual([1, 2, 3]);
  });

  it("adds and removes an eligible variant on a draft campaign", async () => {
    const campaign = await createGroupBuyCampaign({
      code: `gb-repo-${uniq()}`,
      name: "repo fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });
    const variant = await eligibleVariant();

    await addGroupBuyCampaignEligibleVariant(campaign.id, variant.id);
    let full = await getGroupBuyCampaignForStaff(campaign.id);
    expect(full?.variants.map((v) => v.masterVariantId)).toContain(variant.id);

    await removeGroupBuyCampaignEligibleVariant(campaign.id, variant.id);
    full = await getGroupBuyCampaignForStaff(campaign.id);
    expect(full?.variants.map((v) => v.masterVariantId)).not.toContain(variant.id);
  });

  it("REFUSES tier/variant configuration once the campaign is open — even though the database trigger would refuse it too", async () => {
    const variant = await eligibleVariant();
    const campaign = await createGroupBuyCampaign({
      code: `gb-repo-open-${uniq()}`,
      name: "repo fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });
    await addGroupBuyCampaignEligibleVariant(campaign.id, variant.id);
    await openGroupBuyCampaign({ campaignId: campaign.id, openedBy: "staff", asOf: ASOF });

    await expect(replaceGroupBuyCampaignTiers(campaign.id, TIERS)).rejects.toBeInstanceOf(
      GroupBuyCampaignNotDraftForConfigurationError
    );
    await expect(addGroupBuyCampaignEligibleVariant(campaign.id, variant.id)).rejects.toBeInstanceOf(
      GroupBuyCampaignNotDraftForConfigurationError
    );
    await expect(removeGroupBuyCampaignEligibleVariant(campaign.id, variant.id)).rejects.toBeInstanceOf(
      GroupBuyCampaignNotDraftForConfigurationError
    );
  });

  it("getGroupBuyCampaignForStaff returns null for a nonexistent campaign", async () => {
    await expect(getGroupBuyCampaignForStaff(randomUUID())).resolves.toBeNull();
  });
});

describe("GroupBuyCampaignNotFoundError", () => {
  it("is thrown for a nonexistent campaign on configuration functions", async () => {
    await expect(addGroupBuyCampaignEligibleVariant(randomUUID(), randomUUID())).rejects.toBeInstanceOf(
      GroupBuyCampaignNotFoundError
    );
  });
});

// ---------------------------------------------------------------------------
// Admin surface support (Slice 6, `app.group-buy-campaigns*`) — the handful
// of functions that route added: staff list/candidate-variant lookups and the
// campaign-options upload store.
// ---------------------------------------------------------------------------

describe("listGroupBuyCampaignsForStaff", () => {
  it("includes a newly created draft campaign with its tier and variant counts, newest first", async () => {
    const campaign = await createGroupBuyCampaign({
      code: `gb-repo-list-${uniq()}`,
      name: "list fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });
    const variant = await eligibleVariant();
    await addGroupBuyCampaignEligibleVariant(campaign.id, variant.id);

    const rows = await listGroupBuyCampaignsForStaff();
    const row = rows.find((r) => r.id === campaign.id);
    expect(row).toBeDefined();
    expect(row?.status).toBe("draft");
    expect(row?.tierCount).toBe(TIERS.length);
    expect(row?.variantCount).toBe(1);
    // Newest first: this campaign is the most recently created, so it is the first row.
    expect(rows[0]?.id).toBe(campaign.id);
  });

  it("never selects a price, cost, or margin field — the row type itself has none", async () => {
    const rows = await listGroupBuyCampaignsForStaff();
    for (const row of rows) {
      expect(Object.keys(row)).not.toContain("pricingProfileId");
      expect(Object.keys(row)).not.toContain("snapshotId");
      expect(Object.keys(row)).not.toContain("unsafeOverrideReason");
    }
  });
});

describe("listMasterVariantsForGroupBuySelection / getGroupBuyVariantIdentities", () => {
  it("returns only identification fields for an active variant, grouped by product", async () => {
    const variant = await eligibleVariant();
    const products = await listMasterVariantsForGroupBuySelection();
    const product = products.find((p) => p.variants.some((v) => v.masterVariantId === variant.id));
    expect(product).toBeDefined();
    const row = product?.variants.find((v) => v.masterVariantId === variant.id);
    expect(row).toEqual(
      expect.objectContaining({ masterVariantId: variant.id, metal: variant.metal, purity: variant.purity })
    );
    expect(row).not.toHaveProperty("minBankPaymentPriceMinorUnits");

    const identities = await getGroupBuyVariantIdentities([variant.id]);
    expect(identities).toHaveLength(1);
    expect(identities[0]?.masterVariantId).toBe(variant.id);
    expect(identities[0]?.productName.length).toBeGreaterThan(0);
  });

  it("getGroupBuyVariantIdentities returns an empty array for an empty input rather than querying", async () => {
    await expect(getGroupBuyVariantIdentities([])).resolves.toEqual([]);
  });
});

// Module-scoped (not inside a single `describe`) because both the upload-store
// tests below AND the freeze-pin tests (`getFrozenGroupBuyCampaignOptions`)
// need one valid fixture.
const VALID_OPTIONS = {
  schemaVersion: 1 as const,
  campaign: { productType: "bracelet" },
  optionDimensions: [
    {
      key: "metal",
      label: "Metal",
      required: true,
      displayOrder: 1,
      allowedValues: [
        { value: "gold", label: "Gold" },
        { value: "platinum", label: "Platinum" },
      ],
    },
  ],
  validCombinations: [{ values: { metal: "gold" } }, { values: { metal: "platinum" } }],
  tableView: { columns: ["metal"] },
  orderingFlow: { steps: ["metal"] },
};

describe("saveGroupBuyCampaignOptionsUpload / getLatestGroupBuyCampaignOptionsUpload", () => {

  it("stores a validated upload and reads it back, attributed to the uploading staff member", async () => {
    const campaign = await createGroupBuyCampaign({
      code: `gb-repo-opts-${uniq()}`,
      name: "options fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });

    expect(await getLatestGroupBuyCampaignOptionsUpload(campaign.id)).toBeNull();

    const validated = validateGroupBuyCampaignOptions(VALID_OPTIONS);
    expect(validated.ok).toBe(true);
    if (!validated.ok) throw new Error("fixture options should be valid");

    const upload = await saveGroupBuyCampaignOptionsUpload(campaign.id, validated.value, "staff:1");
    expect(upload.campaignId).toBe(campaign.id);
    expect(upload.uploadedBy).toBe("staff:1");
    expect(upload.sequence).toBe(1); // the first upload for this campaign

    const latest = await getLatestGroupBuyCampaignOptionsUpload(campaign.id);
    expect(latest?.snapshotId).toBe(upload.snapshotId);
    expect(latest?.options).toEqual(VALID_OPTIONS);
    expect(latest?.uploadedBy).toBe("staff:1");
    expect(latest?.sequence).toBe(1);
  });

  it("a re-upload while still draft supersedes the prior one — selection is by `sequence`, not wall-clock createdAt", async () => {
    const campaign = await createGroupBuyCampaign({
      code: `gb-repo-opts-${uniq()}`,
      name: "options fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });
    const first = validateGroupBuyCampaignOptions(VALID_OPTIONS);
    if (!first.ok) throw new Error("fixture options should be valid");
    const firstUpload = await saveGroupBuyCampaignOptionsUpload(campaign.id, first.value, "staff:1");
    expect(firstUpload.sequence).toBe(1);

    const corrected = { ...VALID_OPTIONS, campaign: { productType: "bracelet", title: "corrected" } };
    const second = validateGroupBuyCampaignOptions(corrected);
    if (!second.ok) throw new Error("corrected fixture options should be valid");
    const secondUpload = await saveGroupBuyCampaignOptionsUpload(campaign.id, second.value, "staff:2");
    expect(secondUpload.sequence).toBe(2);

    const latest = await getLatestGroupBuyCampaignOptionsUpload(campaign.id);
    expect(latest?.sequence).toBe(2);
    expect(latest?.uploadedBy).toBe("staff:2");
    expect((latest?.options.campaign as { title?: string }).title).toBe("corrected");
  });

  it("CONCURRENT uploads for the same campaign never collide on `sequence` — the row lock serializes them", async () => {
    const campaign = await createGroupBuyCampaign({
      code: `gb-repo-opts-race-${uniq()}`,
      name: "concurrency fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });
    const validated = validateGroupBuyCampaignOptions(VALID_OPTIONS);
    if (!validated.ok) throw new Error("fixture options should be valid");

    const [a, b] = await Promise.all([
      saveGroupBuyCampaignOptionsUpload(campaign.id, validated.value, "staff:a"),
      saveGroupBuyCampaignOptionsUpload(campaign.id, validated.value, "staff:b"),
    ]);

    // Exactly {1, 2} between them, in EITHER order — never a duplicate,
    // which is what would happen if the two transactions had counted prior
    // uploads without a lock serializing them.
    expect(new Set([a.sequence, b.sequence])).toEqual(new Set([1, 2]));

    const latest = await getLatestGroupBuyCampaignOptionsUpload(campaign.id);
    const winner = a.sequence === 2 ? a : b;
    expect(latest?.snapshotId).toBe(winner.snapshotId);
    expect(latest?.uploadedBy).toBe(winner.uploadedBy);
  });

  it("refuses to store an upload once the campaign is no longer draft — the same draft-only guard as tiers and variants", async () => {
    const campaign = await createGroupBuyCampaign({
      code: `gb-repo-opts-${uniq()}`,
      name: "options fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });
    const variant = await eligibleVariant();
    await addGroupBuyCampaignEligibleVariant(campaign.id, variant.id);
    await openGroupBuyCampaign({ campaignId: campaign.id, openedBy: "staff:1", asOf: ASOF });

    const validated = validateGroupBuyCampaignOptions(VALID_OPTIONS);
    if (!validated.ok) throw new Error("fixture options should be valid");
    await expect(
      saveGroupBuyCampaignOptionsUpload(campaign.id, validated.value, "staff:1")
    ).rejects.toBeInstanceOf(GroupBuyCampaignNotDraftForConfigurationError);
  });

  it("getLatestGroupBuyCampaignOptionsUpload returns null for a campaign that never had an upload", async () => {
    const campaign = await createGroupBuyCampaign({
      code: `gb-repo-opts-none-${uniq()}`,
      name: "no options fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });
    await expect(getLatestGroupBuyCampaignOptionsUpload(campaign.id)).resolves.toBeNull();
  });
});

describe("getFrozenGroupBuyCampaignOptions — the configuration PINNED at open", () => {
  it("openGroupBuyCampaign pins the current upload into the freeze; the frozen read matches it exactly", async () => {
    const campaign = await createGroupBuyCampaign({
      code: `gb-repo-opts-freeze-${uniq()}`,
      name: "freeze-pin fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });
    const variant = await eligibleVariant();
    await addGroupBuyCampaignEligibleVariant(campaign.id, variant.id);

    const validated = validateGroupBuyCampaignOptions(VALID_OPTIONS);
    if (!validated.ok) throw new Error("fixture options should be valid");
    const uploaded = await saveGroupBuyCampaignOptionsUpload(campaign.id, validated.value, "staff:1");

    await openGroupBuyCampaign({ campaignId: campaign.id, openedBy: "staff:1", asOf: ASOF });

    const opened = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(opened.snapshotId).not.toBeNull();

    const frozen = await getFrozenGroupBuyCampaignOptions(opened.snapshotId);
    expect(frozen?.snapshotId).toBe(uploaded.snapshotId);
    expect(frozen?.sequence).toBe(uploaded.sequence);
    expect(frozen?.uploadedBy).toBe("staff:1");
    expect(frozen?.options).toEqual(VALID_OPTIONS);
    expect(frozen?.contentHash).toBe(uploaded.contentHash);

    // Since uploads are permanently refused once not draft, "latest" and
    // "pinned at freeze" necessarily agree here too — both read paths are
    // exercised so a future change to either one is caught by this test.
    const latest = await getLatestGroupBuyCampaignOptionsUpload(campaign.id);
    expect(latest).toEqual(frozen);
  });

  it("a campaign opened with no options upload pins nothing — not an error, and getFrozenGroupBuyCampaignOptions returns null", async () => {
    const campaign = await createGroupBuyCampaign({
      code: `gb-repo-opts-freeze-none-${uniq()}`,
      name: "freeze-pin no-upload fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });
    const variant = await eligibleVariant();
    await addGroupBuyCampaignEligibleVariant(campaign.id, variant.id);
    await openGroupBuyCampaign({ campaignId: campaign.id, openedBy: "staff:1", asOf: ASOF });

    const opened = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    await expect(getFrozenGroupBuyCampaignOptions(opened.snapshotId)).resolves.toBeNull();
  });

  it("returns null for a null freeze-snapshot id (an unopened campaign)", async () => {
    await expect(getFrozenGroupBuyCampaignOptions(null)).resolves.toBeNull();
  });
});

/**
 * The admin landing list must not count live-gate fixtures as business
 * activity — but must not hide them either. They are permanent (campaign rows
 * cannot be deleted) and carry real evidence, so the requirement is
 * segregation, not concealment.
 */
describe("the staff campaign list segregates live-gate fixtures", () => {
  it("omits a zz-live-gate- campaign by default", async () => {
    const fixtureCode = `zz-live-gate-${uniq()}`;
    await createGroupBuyCampaign({
      code: fixtureCode,
      name: "fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });

    const listed = await listGroupBuyCampaignsForStaff();
    expect(listed.some((c) => c.code === fixtureCode)).toBe(false);
  });

  it("returns it when asked explicitly — findable, not hidden", async () => {
    const fixtureCode = `zz-live-gate-${uniq()}`;
    await createGroupBuyCampaign({
      code: fixtureCode,
      name: "fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });

    const listed = await listGroupBuyCampaignsForStaff({ includeTestFixtures: true });
    expect(listed.some((c) => c.code === fixtureCode)).toBe(true);
  });

  it("still lists business campaigns by default — the filter is the prefix, not the list", async () => {
    // Guard the guard: an over-broad filter would make the first assertion
    // pass while emptying the dashboard entirely.
    const businessCode = `gb-business-${uniq()}`;
    await createGroupBuyCampaign({
      code: businessCode,
      name: "business",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });

    const listed = await listGroupBuyCampaignsForStaff();
    expect(listed.some((c) => c.code === businessCode)).toBe(true);
  });
});

/**
 * ARCHIVING AND HISTORY PROTECTION (owner-locked 2026-10-05).
 *
 * The load-bearing test here is the DATABASE one: a repository pre-check is
 * bypassed by any path that does not call it, so for a destructive operation
 * on money-adjacent evidence the backstop has to be somewhere an admin script
 * or a future function cannot route around.
 */
describe("campaign archiving is an annotation with a mandatory reason", () => {
  async function draftCampaign(prefix = "gb-archive") {
    return createGroupBuyCampaign({
      code: `${prefix}-${uniq()}`,
      name: "archive fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });
  }

  it("records reason, actor and timestamp together", async () => {
    const campaign = await draftCampaign();
    await archiveGroupBuyCampaign({
      campaignId: campaign.id,
      archivedBy: "staff:ada",
      reason: "live-gate fixture, retained for evidence",
    });

    const row = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(row.archivedAt).not.toBeNull();
    expect(row.archivedBy).toBe("staff:ada");
    expect(row.archiveReason).toBe("live-gate fixture, retained for evidence");
    // ANNOTATION ONLY — status is untouched.
    expect(row.status).toBe("draft");
  });

  it("REFUSES an empty or whitespace-only reason", async () => {
    const campaign = await draftCampaign();
    for (const reason of ["", "   ", "\t\n"]) {
      await expect(
        archiveGroupBuyCampaign({ campaignId: campaign.id, archivedBy: "staff:ada", reason })
      ).rejects.toBeInstanceOf(GroupBuyCampaignArchiveReasonRequiredError);
    }
    const row = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(row.archivedAt).toBeNull();
  });

  it("REFUSES a missing actor — 'hidden by nobody' is the state this prevents", async () => {
    const campaign = await draftCampaign();
    await expect(
      archiveGroupBuyCampaign({ campaignId: campaign.id, archivedBy: "  ", reason: "a real reason" })
    ).rejects.toBeInstanceOf(GroupBuyCampaignArchiveReasonRequiredError);
  });

  it("the DATABASE also refuses a half-recorded archive, independent of the repository", async () => {
    // The typed error above is a courtesy. This is the guarantee: a direct
    // write bypassing the repository still cannot produce an archive with no
    // reason.
    const campaign = await draftCampaign();
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE group_buy_campaign SET archived_at = now() WHERE id = '${campaign.id}'::uuid`
      )
    ).rejects.toThrow(/group_buy_campaign_archive_complete/);
  });

  it("is reversible", async () => {
    const campaign = await draftCampaign();
    await archiveGroupBuyCampaign({ campaignId: campaign.id, archivedBy: "staff:ada", reason: "mistake" });
    await unarchiveGroupBuyCampaign(campaign.id, "staff:grace");

    const row = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(row.archivedAt).toBeNull();
    expect(row.archivedBy).toBeNull();
    expect(row.archiveReason).toBeNull();
  });

  it("AUDITS BOTH DIRECTIONS — unarchiving nulls all three columns, so the event is the only record", async () => {
    const campaign = await draftCampaign();
    await archiveGroupBuyCampaign({
      campaignId: campaign.id,
      archivedBy: "staff:ada",
      reason: "superseded by spring campaign",
    });
    await unarchiveGroupBuyCampaign(campaign.id, "staff:grace");

    const events = await prisma.auditEvent.findMany({
      where: { entityType: "group_buy_campaign", entityId: campaign.id },
      orderBy: { createdAt: "asc" },
    });
    const actions = events.map((e) => e.action);
    expect(actions).toContain("groupbuy.campaign_archived");
    expect(actions).toContain("groupbuy.campaign_unarchived");

    const archivedEvent = events.find((e) => e.action === "groupbuy.campaign_archived")!;
    expect(archivedEvent.actorRef).toBe("staff:ada");
    expect(archivedEvent.reason).toBe("superseded by spring campaign");

    // THE POINT OF THIS TEST. The row now says nothing about ever having been
    // archived; without this `before` payload the reason that was overruled,
    // and who overruled it, would be gone entirely.
    const unarchivedEvent = events.find((e) => e.action === "groupbuy.campaign_unarchived")!;
    expect(unarchivedEvent.actorRef).toBe("staff:grace");
    expect(unarchivedEvent.before).toMatchObject({
      archivedBy: "staff:ada",
      archiveReason: "superseded by spring campaign",
    });
  });

  it("REFUSES an unarchive with no actor", async () => {
    const campaign = await draftCampaign();
    await archiveGroupBuyCampaign({ campaignId: campaign.id, archivedBy: "staff:ada", reason: "mistake" });
    await expect(unarchiveGroupBuyCampaign(campaign.id, "   ")).rejects.toBeInstanceOf(
      GroupBuyCampaignArchiveReasonRequiredError
    );

    // AND NOTHING MOVED. A refused unarchive that still cleared the columns
    // would be the worst of both outcomes.
    const row = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: campaign.id } });
    expect(row.archivedAt).not.toBeNull();
    expect(row.archiveReason).toBe("mistake");
  });
});

describe("a campaign carrying historical evidence cannot be deleted", () => {
  it("reports no history for a freshly created draft — the one case deletion exists for", async () => {
    const campaign = await createGroupBuyCampaign({
      code: `gb-history-none-${uniq()}`,
      name: "empty draft",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });
    // Tiers exist and must NOT count: they are configuration, not history.
    const summary = await describeGroupBuyCampaignHistory(campaign.id);
    expect(summary.hasHistory).toBe(false);
    expect(summary.describedParts).toEqual([]);
  });

  it("names what exists, so a human can decide rather than hunt", async () => {
    const { campaignId } = await seedCampaignWithUnits();
    const summary = await describeGroupBuyCampaignHistory(campaignId);
    expect(summary.hasHistory).toBe(true);
    expect(summary.qualifyingUnitEvents).toBeGreaterThan(0);
    expect(summary.describedParts.join(", ")).toMatch(/qualifying unit event/);
  });

  it("THE DATABASE refuses the delete, naming the evidence — not merely 'failed'", async () => {
    const { campaignId } = await seedCampaignWithUnits();
    await expect(prisma.groupBuyCampaign.delete({ where: { id: campaignId } })).rejects.toThrow(
      /carries historical evidence and cannot be deleted.*qualifying unit event/s
    );
  });

  it("the campaign and its evidence are still intact after the refused delete", async () => {
    // A refusal that half-deleted something would be worse than no guard.
    const { campaignId } = await seedCampaignWithUnits();
    await expect(prisma.groupBuyCampaign.delete({ where: { id: campaignId } })).rejects.toThrow();

    expect(await prisma.groupBuyCampaign.count({ where: { id: campaignId } })).toBe(1);
    expect(await prisma.groupBuyUnitEvent.count({ where: { campaignId } })).toBeGreaterThan(0);
  });
});

/**
 * `deleteGroupBuyCampaign` — the repository path staff actually reach, whose
 * job is to REFUSE legibly. The database trigger above is the guarantee; this
 * is the sentence a human reads.
 */
describe("deleting an empty draft, and refusing everything else", () => {
  it("deletes a draft that never became anything, tiers and all", async () => {
    const campaign = await createGroupBuyCampaign({
      code: `gb-del-ok-${uniq()}`,
      name: "created by mistake",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });

    await deleteGroupBuyCampaign(campaign.id, "staff:ada");

    expect(await prisma.groupBuyCampaign.count({ where: { id: campaign.id } })).toBe(0);
    // The cascade reached the configuration rows — the frozen-child guard
    // allows a cascade from an absent parent (migration 20261005020000).
    expect(await prisma.groupBuyCampaignTier.count({ where: { campaignId: campaign.id } })).toBe(0);
  });

  it("LEAVES AN AUDIT EVENT BEHIND, because there is no row left to join to", async () => {
    const campaign = await createGroupBuyCampaign({
      code: `gb-del-audit-${uniq()}`,
      name: "mistake",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });
    await deleteGroupBuyCampaign(campaign.id, "staff:ada");

    const events = await prisma.auditEvent.findMany({
      where: { entityType: "group_buy_campaign", entityId: campaign.id },
    });
    expect(events).toHaveLength(1);
    expect(events[0]!.action).toBe("groupbuy.campaign_deleted");
    expect(events[0]!.actorRef).toBe("staff:ada");
    // The identity of the thing that no longer exists.
    expect(events[0]!.before).toMatchObject({ code: campaign.code, name: "mistake", status: "draft" });
  });

  it("REFUSES a campaign with history, and the error NAMES the history", async () => {
    const { campaignId } = await seedCampaignWithUnits();
    const rejection = deleteGroupBuyCampaign(campaignId, "staff:ada");
    await expect(rejection).rejects.toBeInstanceOf(GroupBuyCampaignHasHistoryError);
    await expect(rejection).rejects.toThrow(/qualifying unit event/);
    // And it points at the action that IS correct.
    await expect(rejection).rejects.toThrow(/Archive the campaign instead/);

    expect(await prisma.groupBuyCampaign.count({ where: { id: campaignId } })).toBe(1);
  });

  it("writes NO audit event for a refused deletion — nothing happened", async () => {
    const { campaignId } = await seedCampaignWithUnits();
    await expect(deleteGroupBuyCampaign(campaignId, "staff:ada")).rejects.toThrow();

    const deletedEvents = await prisma.auditEvent.count({
      where: { entityType: "group_buy_campaign", entityId: campaignId, action: "groupbuy.campaign_deleted" },
    });
    expect(deletedEvents).toBe(0);
  });

  it("REFUSES an OPEN campaign that nobody has bought from — real, and a history check alone would allow it", async () => {
    // NOT A CONTRIVED CASE. A campaign opened to customers that has taken no
    // orders yet has genuinely zero dependent rows, so `hasHistory` is false
    // and only the STATUS check stands between it and deletion. It is also
    // the case most likely to tempt someone ("nothing happened, just remove
    // it") — but it was offered to customers at a frozen price, and that is
    // itself a fact worth keeping.
    //
    // Opened through the real path, because `group_buy_campaign_open_is_frozen`
    // rightly refuses an open campaign without its frozen pricing.
    const campaign = await createGroupBuyCampaign({
      code: `gb-del-open-${uniq()}`,
      name: "opened",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });
    const variant = await eligibleVariant();
    await addGroupBuyCampaignEligibleVariant(campaign.id, variant.id);
    await openGroupBuyCampaign({ campaignId: campaign.id, openedBy: "staff:1", asOf: ASOF });

    expect((await describeGroupBuyCampaignHistory(campaign.id)).hasHistory).toBe(false);

    const rejection = deleteGroupBuyCampaign(campaign.id, "staff:ada");
    await expect(rejection).rejects.toBeInstanceOf(GroupBuyCampaignNotDeletableStatusError);
    await expect(rejection).rejects.toThrow(/Only a draft/);
    expect(await prisma.groupBuyCampaign.count({ where: { id: campaign.id } })).toBe(1);
  });

  it("REFUSES a deletion that cannot be attributed to anyone", async () => {
    const campaign = await createGroupBuyCampaign({
      code: `gb-del-anon-${uniq()}`,
      name: "mistake",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });
    await expect(deleteGroupBuyCampaign(campaign.id, "  ")).rejects.toBeInstanceOf(
      GroupBuyCampaignArchiveReasonRequiredError
    );
    expect(await prisma.groupBuyCampaign.count({ where: { id: campaign.id } })).toBe(1);
  });
});

/**
 * ARCHIVED CAMPAIGNS STAY REACHABLE BY STAFF (owner-locked 2026-10-05).
 * Archiving tidies the default view; it must never make history inaccessible.
 */
describe("the staff list separates operational from archived without losing either", () => {
  async function archivedCampaign() {
    const campaign = await createGroupBuyCampaign({
      code: `gb-archived-${uniq()}`,
      name: "archived",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });
    await archiveGroupBuyCampaign({
      campaignId: campaign.id,
      archivedBy: "staff:ada",
      reason: "no longer relevant",
    });
    return campaign;
  }

  it("omits an archived campaign from the default operational view", async () => {
    const campaign = await archivedCampaign();
    const listed = await listGroupBuyCampaignsForStaff();
    expect(listed.some((c) => c.code === campaign.code)).toBe(false);
  });

  it("returns it under the Archived view", async () => {
    const campaign = await archivedCampaign();
    const listed = await listGroupBuyCampaignsForStaff({ view: "archived" });
    expect(listed.some((c) => c.code === campaign.code)).toBe(true);
  });

  it("returns it under the audit 'all' view too", async () => {
    const campaign = await archivedCampaign();
    const listed = await listGroupBuyCampaignsForStaff({ view: "all" });
    expect(listed.some((c) => c.code === campaign.code)).toBe(true);
  });

  it("the Archived view does NOT show unarchived business campaigns", async () => {
    // Guard the guard: an Archived view that showed everything would make the
    // first assertion meaningless.
    const live = await createGroupBuyCampaign({
      code: `gb-live-${uniq()}`,
      name: "live",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });
    const listed = await listGroupBuyCampaignsForStaff({ view: "archived" });
    expect(listed.some((c) => c.code === live.code)).toBe(false);
  });

  it("NOTHING is invisible in both views — archiving cannot hide history from staff", async () => {
    const campaign = await archivedCampaign();
    const operational = await listGroupBuyCampaignsForStaff();
    const archived = await listGroupBuyCampaignsForStaff({ view: "archived" });
    const reachable =
      operational.some((c) => c.code === campaign.code) || archived.some((c) => c.code === campaign.code);
    expect(reachable).toBe(true);
  });

  it("the Archived view still excludes fixtures — not a place test data hides in plain sight", async () => {
    const fixture = await createGroupBuyCampaign({
      code: `zz-live-gate-${uniq()}`,
      name: "fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });
    await archiveGroupBuyCampaign({
      campaignId: fixture.id,
      archivedBy: "staff:ada",
      reason: "live-gate fixture",
    });

    const archived = await listGroupBuyCampaignsForStaff({ view: "archived" });
    expect(archived.some((c) => c.code === fixture.code)).toBe(false);

    // ...but still retrievable when explicitly asked for, so evidence is never lost.
    const withFixtures = await listGroupBuyCampaignsForStaff({ view: "archived", includeTestFixtures: true });
    expect(withFixtures.some((c) => c.code === fixture.code)).toBe(true);
  });
});

/**
 * DELETION REGRESSION SUITE (owner-required 2026-10-05).
 *
 * `group_buy_frozen_child_guard` was relaxed to recognise a cascading delete.
 * That relaxation is only safe because `group_buy_campaign_no_delete_with_history`
 * refuses first, so these cases exist to prove the safe case became possible
 * WITHOUT any unsafe case becoming possible.
 *
 * The history trigger is the authoritative boundary. Every "cannot be
 * deleted" case below is asserted against the DATABASE, not against a
 * repository pre-check that a different code path could skip.
 */
describe("campaign deletion: the empty case works, every historical case is refused", () => {
  async function emptyDraft() {
    return createGroupBuyCampaign({
      code: `gb-del-empty-${uniq()}`,
      name: "empty draft",
      currency: "USD",
      createdBy: "integration-test",
      tiers: TIERS,
    });
  }

  it("1. a truly empty draft CAN be deleted — the one case deletion exists for", async () => {
    const campaign = await emptyDraft();
    // It has tiers. Those are configuration, not history, and must not block.
    expect(await prisma.groupBuyCampaignTier.count({ where: { campaignId: campaign.id } })).toBeGreaterThan(0);

    await prisma.groupBuyCampaign.delete({ where: { id: campaign.id } });
    expect(await prisma.groupBuyCampaign.count({ where: { id: campaign.id } })).toBe(0);
    // The cascade removed its tiers rather than being refused by the old guard.
    expect(await prisma.groupBuyCampaignTier.count({ where: { campaignId: campaign.id } })).toBe(0);
  });

  it("2. a campaign with qualifying units CANNOT be deleted", async () => {
    const { campaignId } = await seedCampaignWithUnits();
    await expect(prisma.groupBuyCampaign.delete({ where: { id: campaignId } })).rejects.toThrow(
      /carries historical evidence.*qualifying unit event/s
    );
    expect(await prisma.groupBuyCampaign.count({ where: { id: campaignId } })).toBe(1);
  });

  it("3. a campaign with acknowledgment / cancellation evidence CANNOT be deleted", async () => {
    const campaign = await emptyDraft();
    const policy = await prisma.policyVersion.findFirstOrThrow({ orderBy: { version: "desc" } });
    await prisma.acknowledgment.create({
      data: {
        exactText: policy.text,
        policyVersionId: policy.id,
        acknowledgedAt: new Date(),
        affirmativeActionLabel: "I Understand & Agree",
        customerRef: `gid://shopify/Customer/${uniq()}`,
        // Matched by CODE, which is how this table references a campaign.
        campaignRef: campaign.code,
      },
    });

    await expect(prisma.groupBuyCampaign.delete({ where: { id: campaign.id } })).rejects.toThrow(
      /carries historical evidence.*acknowledgment/s
    );
  });

  it("4. refund / settlement history blocks deletion", async () => {
    const { campaignId } = await seedCampaignWithUnits();
    // A refund row is settlement history even before it is paid.
    const summary = await describeGroupBuyCampaignHistory(campaignId);
    expect(summary.hasHistory).toBe(true);
    await expect(prisma.groupBuyCampaign.delete({ where: { id: campaignId } })).rejects.toThrow(
      /carries historical evidence/
    );
  });

  it("5. ARCHIVING DOES NOT WEAKEN HISTORY PROTECTION", async () => {
    // The dangerous shortcut would be "archived means safe to clean up".
    const { campaignId } = await seedCampaignWithUnits();
    await archiveGroupBuyCampaign({
      campaignId,
      archivedBy: "staff:ada",
      reason: "tidying the dashboard",
    });

    await expect(prisma.groupBuyCampaign.delete({ where: { id: campaignId } })).rejects.toThrow(
      /carries historical evidence/
    );
    expect(await prisma.groupBuyUnitEvent.count({ where: { campaignId } })).toBeGreaterThan(0);
  });

  it("6. RAW SQL CANNOT BYPASS THE TRIGGER", async () => {
    // The whole reason the protection is in the database. A repository
    // pre-check would be irrelevant here.
    const { campaignId } = await seedCampaignWithUnits();
    await expect(
      prisma.$executeRawUnsafe(`DELETE FROM group_buy_campaign WHERE id = '${campaignId}'::uuid`)
    ).rejects.toThrow(/carries historical evidence/);
    expect(await prisma.groupBuyCampaign.count({ where: { id: campaignId } })).toBe(1);
  });
});
