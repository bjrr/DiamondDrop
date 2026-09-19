import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  CampaignIncompleteError,
  CampaignNotDraftError,
  UnsafeTiersError,
  openGroupBuyCampaign,
} from "~/jobs/groupbuy/openCampaign.server";

/**
 * Freeze at open — README: "When a campaign opens, freeze/version its
 * applicable cost inputs, pricing assumptions, tier thresholds/percentages, and
 * eligible-variant prices. Market changes after opening must not retroactively
 * alter campaign tier prices."
 *
 * These run against a real database because the freeze is enforced by TRIGGERS,
 * not by application code. A unit test could only prove the service does not
 * try to edit frozen data; it could not prove the database refuses when
 * something else does — and "something else" is the case that matters, since a
 * frozen price which can be edited is not frozen.
 */

const ASOF = new Date("2026-09-18T12:00:00Z");
let sequence = 0;
const uniqueCode = () => `gb-${Date.now() % 900_000}-${++sequence}`;

/**
 * The HEAVIEST eligible variant, deliberately.
 *
 * A light piece clears the $100 minimum-profit floor only narrowly at full
 * price, so even a 5% tier breaches it — as the first run of these tests
 * discovered. That is the safety check working, not a defect, but it makes a
 * light variant useless as the "campaign opens cleanly" fixture. The heaviest
 * variant carries enough absolute margin for a shallow tier to stay safe.
 */
async function anEligibleVariant() {
  return prisma.masterVariant.findFirstOrThrow({
    where: { status: "active", masterProduct: { isLuxurySteal: false } },
    orderBy: { baseWeightGrams: "desc" },
  });
}

async function draftCampaign(options?: {
  tiers?: { tierNumber: number; minQualifyingUnits: number; priceMultiplier: string }[];
  variantIds?: string[];
}) {
  const variantIds = options?.variantIds ?? [(await anEligibleVariant()).id];
  // A SHALLOW second tier, and the depth is not arbitrary.
  //
  // These tests run against a freshly seeded disposable database whose largest
  // eligible piece is 5.5g — it prices at $436 with $112 of profit, so it only
  // tolerates multipliers down to about 0.9723 before breaching the $100
  // minimum. A 0.95 tier fails there, which the first run of this file
  // demonstrated. That is the safety check working exactly as intended; it just
  // makes a deep tier useless as the "opens cleanly" fixture.
  //
  // The unsafe-tier tests below pass their own much deeper multiplier, so the
  // refusal path is still exercised.
  const tiers = options?.tiers ?? [
    { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
    { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.990000" },
  ];

  return prisma.groupBuyCampaign.create({
    data: {
      code: uniqueCode(),
      name: "freeze fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: { create: tiers },
      variants: {
        create: variantIds.map((id) => ({
          masterVariantId: id,
          frozenBaseCashPriceMinorUnits: 1n,
          frozenLandedCostMinorUnits: 0n,
        })),
      },
    },
    include: { tiers: true, variants: true },
  });
}

describe("opening a campaign freezes its pricing", () => {
  it("records the profile, the snapshot and the as-of instant", () => {
    return draftCampaign().then(async (draft) => {
      const result = await openGroupBuyCampaign({
        campaignId: draft.id,
        openedBy: "staff:brian",
        asOf: ASOF,
      });

      const opened = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: draft.id } });

      expect(opened.status).toBe("open");
      expect(opened.pricingProfileId).not.toBeNull();
      expect(opened.profileVersion).not.toBeNull();
      expect(opened.snapshotId).not.toBeNull();
      // Recorded so a later recomputation resolves inputs at the instant the
      // freeze used, rather than at "now".
      expect(opened.frozenAsOf?.toISOString()).toBe(ASOF.toISOString());
      expect(result.openedWithOverride).toBe(false);
    });
  });

  it("freezes the INPUTS, not just the resulting prices", async () => {
    // Storing only prices makes a campaign unauditable the moment anyone asks
    // why a variant was priced as it was.
    const draft = await draftCampaign();
    await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF });

    const opened = await prisma.groupBuyCampaign.findUniqueOrThrow({
      where: { id: draft.id },
      include: { snapshot: true },
    });
    const payload = opened.snapshot!.payload as unknown as {
      tiers: unknown[];
      variants: { inputs: { metalPricePerGramMinorUnits: string }; result: unknown }[];
    };

    expect(payload.tiers.length).toBeGreaterThanOrEqual(2);
    expect(payload.variants[0]!.inputs.metalPricePerGramMinorUnits).toBeTruthy();
    expect(payload.variants[0]!.result).toBeTruthy();
  });

  it("writes a real frozen base price and landed cost per variant", async () => {
    const draft = await draftCampaign();
    await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF });

    const variant = await prisma.groupBuyCampaignVariant.findFirstOrThrow({
      where: { campaignId: draft.id },
    });

    // The placeholder 1n written at draft time must have been replaced.
    expect(variant.frozenBaseCashPriceMinorUnits).toBeGreaterThan(1000n);
    expect(variant.frozenLandedCostMinorUnits).toBeGreaterThan(0n);
    expect(variant.frozenBaseCashPriceMinorUnits).toBeGreaterThan(variant.frozenLandedCostMinorUnits);
  });
});

describe("frozen pricing cannot be edited afterwards", () => {
  it("REFUSES to change a frozen variant price, at the database", async () => {
    const draft = await draftCampaign();
    await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF });

    const variant = await prisma.groupBuyCampaignVariant.findFirstOrThrow({
      where: { campaignId: draft.id },
    });

    // The guarantee the whole feature rests on. Enforced by a trigger so it
    // survives a script, an ORM change, or a manual UPDATE.
    await expect(
      prisma.groupBuyCampaignVariant.update({
        where: { id: variant.id },
        data: { frozenBaseCashPriceMinorUnits: 1n },
      })
    ).rejects.toThrow(/frozen/);
  });

  it("refuses to change a tier threshold or multiplier once open", async () => {
    const draft = await draftCampaign();
    await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF });

    const tier = await prisma.groupBuyCampaignTier.findFirstOrThrow({
      where: { campaignId: draft.id, tierNumber: 2 },
    });

    await expect(
      prisma.groupBuyCampaignTier.update({
        where: { id: tier.id },
        data: { minQualifyingUnits: 2 },
      })
    ).rejects.toThrow(/frozen/);
  });

  it("refuses to add or remove an eligible variant once open", async () => {
    const draft = await draftCampaign();
    await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF });

    const other = await prisma.masterVariant.findFirstOrThrow({
      where: { status: "active", id: { not: draft.variants[0]!.masterVariantId } },
    });

    await expect(
      prisma.groupBuyCampaignVariant.create({
        data: {
          campaignId: draft.id,
          masterVariantId: other.id,
          frozenBaseCashPriceMinorUnits: 10_000n,
          frozenLandedCostMinorUnits: 1_000n,
        },
      })
    ).rejects.toThrow(/frozen/);

    await expect(
      prisma.groupBuyCampaignVariant.delete({ where: { id: draft.variants[0]!.id } })
    ).rejects.toThrow(/frozen/);
  });

  it("refuses to repoint the frozen basis of an open campaign", async () => {
    const draft = await draftCampaign();
    await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF });

    await expect(
      prisma.groupBuyCampaign.update({
        where: { id: draft.id },
        data: { frozenAsOf: new Date("2030-01-01T00:00:00Z") },
      })
    ).rejects.toThrow(/frozen pricing basis cannot be changed/);
  });

  it("refuses to reopen a campaign as a draft", async () => {
    // Returning to draft would silently re-expose frozen prices to editing,
    // since the child guard keys off draft.
    const draft = await draftCampaign();
    await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF });

    await expect(
      prisma.groupBuyCampaign.update({ where: { id: draft.id }, data: { status: "draft" } })
    ).rejects.toThrow(/cannot return to draft/);
  });

  it("STILL ALLOWS closing, which is a legitimate transition", async () => {
    const draft = await draftCampaign();
    await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF });

    const closed = await prisma.groupBuyCampaign.update({
      where: { id: draft.id },
      data: { status: "closed", closedAt: new Date() },
    });
    expect(closed.status).toBe("closed");
  });

  it("allows editing while still a draft", async () => {
    // The freeze starts at open, not at creation — a campaign has to be
    // configurable before it goes live.
    const draft = await draftCampaign();
    const tier = draft.tiers.find((t) => t.tierNumber === 2)!;

    const updated = await prisma.groupBuyCampaignTier.update({
      where: { id: tier.id },
      data: { minQualifyingUnits: 20 },
    });
    expect(updated.minQualifyingUnits).toBe(20);
  });
});

describe("safety is checked before opening", () => {
  it("REFUSES to open when a tier breaches a floor", async () => {
    // A 1% multiplier prices far below cost at tier 2.
    const draft = await draftCampaign({
      tiers: [
        { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
        { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.010000" },
      ],
    });

    await expect(
      openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF })
    ).rejects.toThrow(UnsafeTiersError);

    const still = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: draft.id } });
    expect(still.status).toBe("draft");
  });

  it("says WHICH variant and tier failed, rather than refusing blankly", async () => {
    const draft = await draftCampaign({
      tiers: [
        { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
        { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.010000" },
      ],
    });

    const error = await openGroupBuyCampaign({
      campaignId: draft.id,
      openedBy: "staff",
      asOf: ASOF,
    }).catch((e: unknown) => e as UnsafeTiersError);

    expect(error).toBeInstanceOf(UnsafeTiersError);
    expect((error as UnsafeTiersError).summary).toMatch(/tier 2 fails/);
    expect((error as UnsafeTiersError).report.unsafe.length).toBeGreaterThan(0);
  });

  it("opens over a breach ONLY with an attributed override", async () => {
    const draft = await draftCampaign({
      tiers: [
        { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
        { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.010000" },
      ],
    });

    const result = await openGroupBuyCampaign({
      campaignId: draft.id,
      openedBy: "staff",
      asOf: ASOF,
      unsafeOverride: { by: "owner:brian", reason: "loss-leader launch, approved" },
    });

    expect(result.openedWithOverride).toBe(true);
    expect(result.safety.allSafe).toBe(false);

    const opened = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: draft.id } });
    expect(opened.status).toBe("open");
    expect(opened.unsafeOverrideBy).toBe("owner:brian");
    expect(opened.unsafeOverrideReason).toMatch(/loss-leader/);
    expect(opened.unsafeOverrideAt).not.toBeNull();
  });
});

describe("refusals that protect the freeze", () => {
  it("refuses to open a campaign twice", async () => {
    const draft = await draftCampaign();
    await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF });

    await expect(
      openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF })
    ).rejects.toThrow(CampaignNotDraftError);
  });

  it("refuses to open a campaign with no eligible variants", async () => {
    const empty = await prisma.groupBuyCampaign.create({
      data: {
        code: uniqueCode(),
        name: "empty",
        currency: "USD",
        createdBy: "test",
        tiers: {
          create: [
            { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
            { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.950000" },
          ],
        },
      },
    });

    await expect(
      openGroupBuyCampaign({ campaignId: empty.id, openedBy: "staff", asOf: ASOF })
    ).rejects.toThrow(CampaignIncompleteError);
  });

  it("refuses an invalid tier set at open, not just at configuration time", async () => {
    // Tier 1 not starting at 1 unit contradicts "no mandatory minimum".
    const draft = await draftCampaign({
      tiers: [
        { tierNumber: 1, minQualifyingUnits: 5, priceMultiplier: "1.000000" },
        { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.950000" },
      ],
    });

    await expect(
      openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF })
    ).rejects.toThrow(/must start at 1 qualifying unit/);
  });
});
