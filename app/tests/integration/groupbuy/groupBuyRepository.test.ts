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
