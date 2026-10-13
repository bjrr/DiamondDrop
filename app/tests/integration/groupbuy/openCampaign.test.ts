import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  CampaignIncompleteError,
  CampaignNotDraftError,
  UnsafeTiersError,
  openGroupBuyCampaign,
} from "~/jobs/groupbuy/openCampaign.server";

/**
 * Freeze integration coverage — the gap this task found: `openGroupBuyCampaign`
 * (app/jobs/groupbuy/openCampaign.server.ts) had no dedicated integration
 * test file of its own; `unitLedger.test.ts` only exercises its happy path
 * as fixture setup. This file proves the two properties the freeze exists
 * for: a recalculation attempt against an open campaign is refused, and a
 * tier breaching a floor is refused at configuration time, not discovered
 * at settlement.
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

async function draftCampaign(tiers: Array<{ tierNumber: number; minQualifyingUnits: number; priceMultiplier: string }>) {
  const variant = await eligibleVariant();
  const draft = await prisma.groupBuyCampaign.create({
    data: {
      code: `gb-open-${uniq()}`,
      name: "open-campaign fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: { create: tiers },
      variants: {
        create: [{ masterVariantId: variant.id, frozenBaseBankPaymentPriceMinorUnits: 1n, frozenLandedCostMinorUnits: 0n }],
      },
    },
  });
  return { campaignId: draft.id, variantId: variant.id };
}

describe("openGroupBuyCampaign — the freeze", () => {
  it("freezes a well-formed campaign: status open, frozen fields populated, a snapshot recorded", async () => {
    const { campaignId } = await draftCampaign([
      { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
      { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.990000" },
    ]);

    const result = await openGroupBuyCampaign({ campaignId, openedBy: "staff", asOf: ASOF });
    expect(result.safety.allSafe).toBe(true);

    const opened = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(opened.status).toBe("open");
    expect(opened.frozenAsOf?.toISOString()).toBe(ASOF.toISOString());
    expect(opened.snapshotId).not.toBeNull();
    expect(opened.pricingProfileId).not.toBeNull();

    const variant = await prisma.groupBuyCampaignVariant.findFirstOrThrow({ where: { campaignId } });
    expect(variant.frozenBaseBankPaymentPriceMinorUnits).toBeGreaterThan(0n);
  });

  it("REFUSES a second open attempt on an already-open campaign — the freeze holds against a recalculation attempt", async () => {
    const { campaignId } = await draftCampaign([
      { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
      { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.990000" },
    ]);
    await openGroupBuyCampaign({ campaignId, openedBy: "staff", asOf: ASOF });

    // A later "recalculation" attempt is exactly a second call to the same
    // function, with a later asOf — simulating market prices having moved.
    await expect(
      openGroupBuyCampaign({ campaignId, openedBy: "staff", asOf: new Date("2026-10-01T00:00:00Z") })
    ).rejects.toBeInstanceOf(CampaignNotDraftError);

    // And the frozen fields are provably unchanged by the attempt.
    const stillFrozen = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(stillFrozen.frozenAsOf?.toISOString()).toBe(ASOF.toISOString());
  });

  it("the database refuses editing the frozen pricing basis directly, even bypassing this function entirely", async () => {
    const { campaignId } = await draftCampaign([
      { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
      { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.990000" },
    ]);
    await openGroupBuyCampaign({ campaignId, openedBy: "staff", asOf: ASOF });

    await expect(
      prisma.groupBuyCampaign.update({ where: { id: campaignId }, data: { frozenAsOf: new Date() } })
    ).rejects.toThrow(/frozen pricing basis/);
  });

  it("REFUSES a tier that breaches a floor, at configuration time — before any customer ever sees it", async () => {
    // Multiplier 0.5 against the ~1.40x markup this campaign's fixture uses
    // (see openCampaign.server.ts's and the dev script's own worked
    // examples) prices at roughly 0.70x cost — below cost, which breaches
    // any realistic margin or minimum-dollar-profit floor regardless of the
    // exact seeded values, so this does not depend on knowing them.
    const { campaignId } = await draftCampaign([
      { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
      { tierNumber: 2, minQualifyingUnits: 5, priceMultiplier: "0.500000" },
    ]);

    const error = await openGroupBuyCampaign({ campaignId, openedBy: "staff", asOf: ASOF }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnsafeTiersError);
    expect((error as InstanceType<typeof UnsafeTiersError>).report.allSafe).toBe(false);

    // Refused, not merely warned — the campaign never opened.
    const stillDraft = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(stillDraft.status).toBe("draft");
  });

  it("an authorized override lets an unsafe campaign open anyway, and records who/why", async () => {
    const { campaignId } = await draftCampaign([
      { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
      { tierNumber: 2, minQualifyingUnits: 5, priceMultiplier: "0.500000" },
    ]);

    const result = await openGroupBuyCampaign({
      campaignId,
      openedBy: "staff",
      asOf: ASOF,
      unsafeOverride: { by: "owner", reason: "promotional loss-leader, approved out of band" },
    });
    expect(result.openedWithOverride).toBe(true);
    expect(result.safety.allSafe).toBe(false);

    const opened = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(opened.status).toBe("open");
    expect(opened.unsafeOverrideBy).toBe("owner");
    expect(opened.unsafeOverrideReason).toContain("promotional");
  });

  it("refuses a campaign with no eligible variants", async () => {
    const draft = await prisma.groupBuyCampaign.create({
      data: {
        code: `gb-open-empty-${uniq()}`,
        name: "no variants",
        currency: "USD",
        createdBy: "integration-test",
        tiers: { create: [{ tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" }] },
      },
    });

    await expect(openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF })).rejects.toBeInstanceOf(
      CampaignIncompleteError
    );
  });

  it("refuses an invalid tier set before ever touching pricing", async () => {
    // Non-contiguous tier numbers — validateTierSet's job, called first.
    const variant = await eligibleVariant();
    const draft = await prisma.groupBuyCampaign.create({
      data: {
        code: `gb-open-badtiers-${uniq()}`,
        name: "bad tiers",
        currency: "USD",
        createdBy: "integration-test",
        tiers: { create: [{ tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" }] },
        variants: {
          create: [{ masterVariantId: variant.id, frozenBaseBankPaymentPriceMinorUnits: 1n, frozenLandedCostMinorUnits: 0n }],
        },
      },
    });
    // Only 1 tier — below MIN_TIERS (2) — refused by validateTierSet.
    await expect(openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF })).rejects.toThrow(
      /between 2 and 5 tiers/
    );
  });
});
