import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { openGroupBuyCampaign } from "~/jobs/groupbuy/openCampaign.server";
import {
  CampaignNotOpenError,
  UnitRemovalRefusedError,
  VariantNotEligibleError,
  closeGroupBuyCampaign,
  getCurrentTier,
  getQualifyingUnits,
  recordUnitEvent,
} from "~/jobs/groupbuy/unitLedger.server";

/**
 * Qualifying-unit counting against a real database.
 *
 * The three properties worth proving here cannot be shown in a unit test:
 * idempotency is a unique constraint, the ledger's immutability is a trigger,
 * and the close lock is both. Each is the kind of guarantee that holds in the
 * service and fails the moment anything else writes.
 */

const ASOF = new Date("2026-09-18T12:00:00Z");
let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;

async function openCampaign() {
  const variant = await prisma.masterVariant.findFirstOrThrow({
    where: { status: "active", masterProduct: { isLuxurySteal: false } },
    orderBy: { baseWeightGrams: "desc" },
  });

  const draft = await prisma.groupBuyCampaign.create({
    data: {
      code: `gb-units-${uniq()}`,
      name: "unit ledger fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: {
        create: [
          // 1% apart, the documented minimum (MIN_TIER_MULTIPLIER_GAP). These
          // were 0.5% apart, chosen shallow so the campaign could open under
          // the old fee-deducting margin floor; the tier-gap rule added with
          // the Bank/Card schedule now rejects that, correctly — adjacent tiers
          // that close together can invert the CARD price across an uplift-band
          // boundary. Widening is safe here because the floors no longer deduct
          // payment expense, so a 2% total discount clears comfortably.
          { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
          { tierNumber: 2, minQualifyingUnits: 5, priceMultiplier: "0.990000" },
          { tierNumber: 3, minQualifyingUnits: 10, priceMultiplier: "0.980000" },
        ],
      },
      variants: {
        create: [
          { masterVariantId: variant.id, frozenBaseBankPaymentPriceMinorUnits: 1n, frozenLandedCostMinorUnits: 0n },
        ],
      },
    },
  });

  await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF });
  return { campaignId: draft.id, variantId: variant.id };
}

function unit(campaignId: string, variantId: string, over: Partial<Parameters<typeof recordUnitEvent>[0]> = {}) {
  return {
    campaignId,
    masterVariantId: variantId,
    kind: "purchased" as const,
    quantity: 1,
    orderRef: `order-${uniq()}`,
    lineRef: `line-${uniq()}`,
    externalRef: `ext-${uniq()}`,
    occurredAt: ASOF,
    recordedBy: "integration-test",
    ...over,
  };
}

describe("recording qualifying units", () => {
  it("counts units, not orders", async () => {
    const { campaignId, variantId } = await openCampaign();
    await recordUnitEvent(unit(campaignId, variantId, { quantity: 3, lineRef: "L1" }));

    expect((await getQualifyingUnits(campaignId)).total).toBe(3);
  });

  it("is IDEMPOTENT — a replayed webhook does not double-count", async () => {
    // Shopify retries as a matter of course. Our webhook boundary deduplicates
    // deliveries, but this is the place where a double-count would cost money.
    const { campaignId, variantId } = await openCampaign();
    const event = unit(campaignId, variantId, { quantity: 2, externalRef: "shopify-evt-1" });

    const first = await recordUnitEvent(event);
    const replay = await recordUnitEvent(event);

    expect(first).toMatchObject({ recorded: true, duplicate: false });
    // A replay is not an error: the caller did nothing wrong and needs an
    // answer, so it reports the current state.
    expect(replay).toMatchObject({ recorded: false, duplicate: true });
    expect((await getQualifyingUnits(campaignId)).total).toBe(2);
  });

  it("refuses a variant that is not eligible for the campaign", async () => {
    const { campaignId } = await openCampaign();
    const other = await prisma.masterVariant.findFirstOrThrow({
      where: { status: "active", groupBuyCampaignVariants: { none: { campaignId } } },
    });

    // An ineligible variant would inflate the count towards a tier it was never
    // meant to qualify for.
    await expect(recordUnitEvent(unit(campaignId, other.id))).rejects.toThrow(
      VariantNotEligibleError
    );
  });
});

describe("the tier can move BACKWARDS before close", () => {
  it("drops to a prior tier when units are cancelled", async () => {
    // README: "Cancellation removes qualifying units and can move the live
    // campaign back to a prior tier before close." The tier is therefore not a
    // high-water mark, which is the thing most likely to be got wrong.
    const { campaignId, variantId } = await openCampaign();

    await recordUnitEvent(unit(campaignId, variantId, { quantity: 6, lineRef: "L1" }));
    expect((await getCurrentTier(campaignId)).tier.tierNumber).toBe(2);

    await recordUnitEvent(
      unit(campaignId, variantId, { kind: "cancelled", quantity: 3, lineRef: "L1" })
    );

    const after = await getCurrentTier(campaignId);
    expect(after.qualifyingUnits).toBe(3);
    expect(after.tier.tierNumber).toBe(1);
  });

  it("climbs again if units come back", async () => {
    const { campaignId, variantId } = await openCampaign();
    await recordUnitEvent(unit(campaignId, variantId, { quantity: 5, lineRef: "L1" }));
    await recordUnitEvent(unit(campaignId, variantId, { kind: "cancelled", quantity: 5, lineRef: "L1" }));
    expect((await getCurrentTier(campaignId)).tier.tierNumber).toBe(1);

    await recordUnitEvent(unit(campaignId, variantId, { quantity: 10, lineRef: "L2" }));
    expect((await getCurrentTier(campaignId)).tier.tierNumber).toBe(3);
  });

  it("refuses to remove more units than a line has", async () => {
    const { campaignId, variantId } = await openCampaign();
    await recordUnitEvent(unit(campaignId, variantId, { quantity: 2, lineRef: "L1" }));

    await expect(
      recordUnitEvent(unit(campaignId, variantId, { kind: "refunded", quantity: 3, lineRef: "L1" }))
    ).rejects.toThrow(UnitRemovalRefusedError);

    // And nothing was written — the ledger stays foldable.
    expect((await getQualifyingUnits(campaignId)).total).toBe(2);
  });
});

describe("the ledger is evidence", () => {
  it("cannot be edited", async () => {
    const { campaignId, variantId } = await openCampaign();
    await recordUnitEvent(unit(campaignId, variantId, { quantity: 2, lineRef: "L1" }));
    const row = await prisma.groupBuyUnitEvent.findFirstOrThrow({ where: { campaignId } });

    await expect(
      prisma.groupBuyUnitEvent.update({ where: { id: row.id }, data: { quantity: 99 } })
    ).rejects.toThrow(/append-only/);
  });

  it("cannot be deleted — a cancellation is a record, not an undo", async () => {
    const { campaignId, variantId } = await openCampaign();
    await recordUnitEvent(unit(campaignId, variantId, { quantity: 2, lineRef: "L1" }));
    const row = await prisma.groupBuyUnitEvent.findFirstOrThrow({ where: { campaignId } });

    await expect(prisma.groupBuyUnitEvent.delete({ where: { id: row.id } })).rejects.toThrow(
      /append-only/
    );
  });

  it("retains cancellations in the history, per README 430", async () => {
    const { campaignId, variantId } = await openCampaign();
    await recordUnitEvent(unit(campaignId, variantId, { quantity: 3, lineRef: "L1" }));
    await recordUnitEvent(unit(campaignId, variantId, { kind: "cancelled", quantity: 1, lineRef: "L1" }));

    const events = await prisma.groupBuyUnitEvent.findMany({ where: { campaignId } });
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.kind).sort()).toEqual(["cancelled", "purchased"]);
  });
});

describe("closing locks the count and tier", () => {
  it("records the final count and tier", async () => {
    const { campaignId, variantId } = await openCampaign();
    await recordUnitEvent(unit(campaignId, variantId, { quantity: 7, lineRef: "L1" }));

    const result = await closeGroupBuyCampaign({ campaignId, closedBy: "staff" });

    expect(result.finalQualifyingUnits).toBe(7);
    expect(result.finalTierNumber).toBe(2);

    const closed = await prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: campaignId } });
    expect(closed.status).toBe("closed");
    expect(closed.finalQualifyingUnits).toBe(7);
  });

  it("REFUSES to change the locked count afterwards", async () => {
    // The final tier determines what every earlier participant is refunded down
    // to, so a count that could still drift would make the refund ledger
    // unsettleable.
    const { campaignId, variantId } = await openCampaign();
    await recordUnitEvent(unit(campaignId, variantId, { quantity: 7, lineRef: "L1" }));
    await closeGroupBuyCampaign({ campaignId, closedBy: "staff" });

    await expect(
      prisma.groupBuyCampaign.update({
        where: { id: campaignId },
        data: { finalQualifyingUnits: 100, finalTierNumber: 3 },
      })
    ).rejects.toThrow(/locked at close/);
  });

  it("reports the LOCKED count after close, not a fresh fold", async () => {
    const { campaignId, variantId } = await openCampaign();
    await recordUnitEvent(unit(campaignId, variantId, { quantity: 7, lineRef: "L1" }));
    await closeGroupBuyCampaign({ campaignId, closedBy: "staff" });

    const after = await getCurrentTier(campaignId);
    expect(after.qualifyingUnits).toBe(7);
    expect(after.tier.tierNumber).toBe(2);
  });

  it("refuses further unit changes once closed", async () => {
    // README: at close the order is committed, with no discretionary
    // cancellation.
    const { campaignId, variantId } = await openCampaign();
    await recordUnitEvent(unit(campaignId, variantId, { quantity: 7, lineRef: "L1" }));
    await closeGroupBuyCampaign({ campaignId, closedBy: "staff" });

    await expect(recordUnitEvent(unit(campaignId, variantId))).rejects.toThrow(CampaignNotOpenError);
    await expect(
      recordUnitEvent(unit(campaignId, variantId, { kind: "cancelled", quantity: 1, lineRef: "L1" }))
    ).rejects.toThrow(CampaignNotOpenError);
  });

  it("refuses to close twice", async () => {
    const { campaignId, variantId } = await openCampaign();
    await recordUnitEvent(unit(campaignId, variantId, { quantity: 1, lineRef: "L1" }));
    await closeGroupBuyCampaign({ campaignId, closedBy: "staff" });

    await expect(closeGroupBuyCampaign({ campaignId, closedBy: "staff" })).rejects.toThrow(
      CampaignNotOpenError
    );
  });

  it("closes cleanly at zero units, on tier 1", async () => {
    // No mandatory minimum — a campaign with no sales still has a tier.
    const { campaignId } = await openCampaign();
    const result = await closeGroupBuyCampaign({ campaignId, closedBy: "staff" });

    expect(result.finalQualifyingUnits).toBe(0);
    expect(result.finalTierNumber).toBe(1);
  });
});
