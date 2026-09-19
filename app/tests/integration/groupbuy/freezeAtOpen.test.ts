import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  CampaignIncompleteError,
  CampaignNotDraftError,
  BrokenPriceLadderError,
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
          frozenBaseBankPaymentPriceMinorUnits: 1n,
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
    expect(variant.frozenBaseBankPaymentPriceMinorUnits).toBeGreaterThan(1000n);
    expect(variant.frozenLandedCostMinorUnits).toBeGreaterThan(0n);
    expect(variant.frozenBaseBankPaymentPriceMinorUnits).toBeGreaterThan(variant.frozenLandedCostMinorUnits);
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
        data: { frozenBaseBankPaymentPriceMinorUnits: 1n },
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
          frozenBaseBankPaymentPriceMinorUnits: 10_000n,
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

describe("a broken price ladder blocks publication, and cannot be overridden", () => {
  /**
   * The GATE, not the validator. `tierSafety.test.ts` proves the check finds an
   * inversion; these prove `openGroupBuyCampaign` acts on one — the campaign
   * stays a draft, and stays one even when an authorised override is supplied.
   *
   * WHY THE FAULT EXERCISED HERE IS THE BANK-SIDE ONE. A Regular/Card inversion
   * needs two tiers whose bank prices straddle a Bank/Card band boundary, and
   * the lowest boundary is $500. The heaviest variant in the seeded catalogue
   * prices at about $436, so every tier of every campaign these tests can build
   * sits inside the single "under $500" band, where the derivation is
   * monotonic. Rather than seed a fictional high-value piece purely to trip a
   * check, the card-price inversion is covered by unit tests with explicit
   * prices, and this file covers the gate, the error, the non-overridability
   * and the reporting — which is the part only a real open can demonstrate.
   */

  /**
   * Two tiers that ROUND TO THE SAME bank price.
   *
   * $436.00 x 0.999 = $435.564, which HALF_UP-to-minor-units then
   * whole-dollar-UP returns to $436.00. The multiplier falls, so
   * `validateTierSet` is satisfied; the resulting PRICE does not, which is
   * exactly why the check had to move from multipliers to prices.
   */
  async function flatLadderDraft() {
    return draftCampaign({
      tiers: [
        { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
        { tierNumber: 2, minQualifyingUnits: 10, priceMultiplier: "0.999000" },
      ],
    });
  }

  it("REFUSES to open, and leaves the campaign a draft", async () => {
    const draft = await flatLadderDraft();

    await expect(
      openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF })
    ).rejects.toThrow(BrokenPriceLadderError);

    const still = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: draft.id } });
    expect(still.status).toBe("draft");
  });

  it("REFUSES even with an authorised unsafe override", async () => {
    // The ladder is checked BEFORE the override is consulted, so an override
    // supplied for a margin breach cannot carry a ladder fault through with it.
    //
    // The distinction is deliberate: an override exists so an owner can
    // knowingly sell at a thin margin, which is theirs to decide. There is no
    // equivalent decision behind a tier that does not actually lower the price
    // — the storefront would promise a reward for reaching a threshold and then
    // charge the same amount.
    const draft = await flatLadderDraft();

    await expect(
      openGroupBuyCampaign({
        campaignId: draft.id,
        openedBy: "staff",
        asOf: ASOF,
        unsafeOverride: { by: "owner", reason: "I accept the margin" },
      })
    ).rejects.toThrow(BrokenPriceLadderError);

    const still = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: draft.id } });
    expect(still.status).toBe("draft");
  });

  it("reports the exact variant, tiers and prices", async () => {
    const draft = await flatLadderDraft();

    const error = await openGroupBuyCampaign({
      campaignId: draft.id,
      openedBy: "staff",
      asOf: ASOF,
    }).catch((e: unknown) => e as BrokenPriceLadderError);

    expect(error).toBeInstanceOf(BrokenPriceLadderError);

    const problems = (error as BrokenPriceLadderError).report.priceLadderProblems;
    expect(problems.length).toBeGreaterThan(0);

    const problem = problems.find((p) => p.basis === "bank_payment")!;
    expect(problem).toBeDefined();
    expect(problem.masterVariantId).toBe(draft.variants[0]!.masterVariantId);
    expect(problem.priorTierNumber).toBe(1);
    expect(problem.tierNumber).toBe(2);
    expect(problem.priceMinorUnits).toBe(problem.priorPriceMinorUnits);
    expect(problem.detail).toMatch(/is not below tier 1/);
    expect(problem.detail).toMatch(/\$\d+\.\d\d/); // the actual price, not a placeholder

    // The message names the fault and says it is not overridable, rather than
    // reading like an ordinary safety refusal.
    expect((error as BrokenPriceLadderError).message).toMatch(/cannot be overridden/);
  });

  it("still opens an ordinary campaign whose ladder falls throughout", async () => {
    // Guards the guard: a check that blocked everything would pass the three
    // tests above and be worthless.
    const draft = await draftCampaign();

    const result = await openGroupBuyCampaign({
      campaignId: draft.id,
      openedBy: "staff",
      asOf: ASOF,
    });

    expect(result.safety.priceLadderProblems).toHaveLength(0);
    expect(result.safety.allSafe).toBe(true);

    const opened = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: draft.id } });
    expect(opened.status).toBe("open");
  });

  it("records both prices per tier in the report, so a screen can show the ladder", async () => {
    const draft = await draftCampaign();
    const result = await openGroupBuyCampaign({
      campaignId: draft.id,
      openedBy: "staff",
      asOf: ASOF,
    });

    for (const row of result.safety.results) {
      expect(row.groupBuyBankPaymentPriceMinorUnits).toBeGreaterThan(0n);
      expect(row.groupBuyRegularCardPriceMinorUnits).toBeGreaterThanOrEqual(
        row.groupBuyBankPaymentPriceMinorUnits
      );
      // Derived under the frozen rule, which for a campaign opened today is the
      // tiered one — hence a $5 multiple.
      expect(row.groupBuyRegularCardPriceMinorUnits % 500n).toBe(0n);
    }
  });
});
