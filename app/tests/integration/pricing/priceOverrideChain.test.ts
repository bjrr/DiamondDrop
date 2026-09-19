import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  NothingToRevokeError,
  PriceOverrideActorRequiredError,
  PriceOverrideReasonRequiredError,
  applyPriceOverride,
  resolveActiveOverride,
  revokePriceOverride,
} from "~/jobs/pricing/priceOverride.server";
import { runPriceRecalculation } from "~/jobs/pricing/runRecalculation.server";

/**
 * Architect follow-up N3 — override supersession and revocation.
 *
 * `price_override` is append-only, so neither "replace the current override"
 * nor "go back to the calculated price" can be expressed by editing or deleting
 * a row. Both are appended: a `set` that names its predecessor, or a `revoke`
 * that carries no price.
 *
 * What these tests are really pinning is that the resulting history has exactly
 * ONE answer to "what is in effect?". Before this, that answer was an unstated
 * latest-by-created_at convention — which is the kind of thing that holds until
 * two rows land in the same millisecond, or until someone is disputing a price.
 */

const ASOF = new Date("2026-09-17T12:00:00Z");

/**
 * A calculation whose variant has NO override in effect.
 *
 * Getting to that state is the fiddly part, and worth explaining. Tests here
 * share a small pool of seeded variants, and overrides are append-only — so an
 * override set by an earlier test cannot be deleted, and simply taking "the
 * latest calculation" meant later tests inherited it. That made "refuses to
 * revoke when nothing is in effect" pass by revoking the PREVIOUS test's
 * override: green, and testing nothing.
 *
 * Filtering for variants with no override history at all fixed that but ran the
 * pool dry, because every test consumes one. So the slate is cleared through
 * the public API instead: if something is in effect, revoke it as SETUP. That
 * keeps each test independent without depending on how many variants happen to
 * be seeded.
 */
async function aComputedCalculation() {
  await runPriceRecalculation({ asOf: ASOF });
  const calculation = await prisma.priceCalculation.findFirstOrThrow({
    where: { status: "computed" },
    orderBy: { createdAt: "desc" },
  });

  if (await resolveActiveOverride(calculation.masterVariantId)) {
    await revokePriceOverride({
      masterVariantId: calculation.masterVariantId,
      reason: "test setup — clearing prior override",
      revokedBy: "integration-test",
    });
  }

  return calculation;
}

describe("override supersession", () => {
  it("chains a replacement onto the override it replaces", async () => {
    const calculation = await aComputedCalculation();
    const args = {
      masterVariantId: calculation.masterVariantId,
      priceCalculationId: calculation.id,
      currency: calculation.currency,
      overriddenBy: "owner:brian",
    };

    const first = await applyPriceOverride({
      ...args,
      overrideCashPriceMinorUnits: calculation.cashPriceMinorUnits * 2n,
      reason: "first",
    });
    const second = await applyPriceOverride({
      ...args,
      overrideCashPriceMinorUnits: calculation.cashPriceMinorUnits * 3n,
      reason: "second",
    });

    const row = await prisma.priceOverride.findUniqueOrThrow({ where: { id: second.id } });
    expect(row.supersedesId).toBe(first.id);
    expect((await resolveActiveOverride(calculation.masterVariantId))?.id).toBe(second.id);
  });

  it("keeps the superseded override on the record", async () => {
    const calculation = await aComputedCalculation();
    const args = {
      masterVariantId: calculation.masterVariantId,
      priceCalculationId: calculation.id,
      currency: calculation.currency,
      overriddenBy: "owner:brian",
    };

    const first = await applyPriceOverride({
      ...args,
      overrideCashPriceMinorUnits: calculation.cashPriceMinorUnits * 2n,
      reason: "first",
    });
    await applyPriceOverride({
      ...args,
      overrideCashPriceMinorUnits: calculation.cashPriceMinorUnits * 3n,
      reason: "second",
    });

    // A price that was in force and then replaced is precisely what a dispute
    // asks about. Superseding must never erase it.
    const superseded = await prisma.priceOverride.findUniqueOrThrow({ where: { id: first.id } });
    expect(superseded.reason).toBe("first");
    expect(superseded.overrideCashPriceMinorUnits).toBe(calculation.cashPriceMinorUnits * 2n);
  });

  it("refuses at the DATABASE level to fork the history", async () => {
    const calculation = await aComputedCalculation();
    const args = {
      masterVariantId: calculation.masterVariantId,
      priceCalculationId: calculation.id,
      currency: calculation.currency,
      overriddenBy: "owner:brian",
    };

    const first = await applyPriceOverride({
      ...args,
      overrideCashPriceMinorUnits: calculation.cashPriceMinorUnits * 2n,
      reason: "first",
    });
    await applyPriceOverride({
      ...args,
      overrideCashPriceMinorUnits: calculation.cashPriceMinorUnits * 3n,
      reason: "second",
    });

    // Two rows superseding the same predecessor give "what is in effect?" two
    // answers. Refused by a unique index, so it holds even against a raw insert
    // that bypasses applyPriceOverride entirely.
    await expect(
      prisma.priceOverride.create({
        data: {
          masterVariantId: calculation.masterVariantId,
          kind: "set",
          supersedesId: first.id,
          overrideCashPriceMinorUnits: 99900n,
          currency: calculation.currency,
          breachedFloors: [],
          reason: "forking the chain",
          overriddenBy: "owner:brian",
        },
      })
    ).rejects.toThrow();
  });
});

describe("override revocation", () => {
  it("returns the variant to its calculated price", async () => {
    const calculation = await aComputedCalculation();

    await applyPriceOverride({
      masterVariantId: calculation.masterVariantId,
      priceCalculationId: calculation.id,
      overrideCashPriceMinorUnits: calculation.cashPriceMinorUnits * 2n,
      currency: calculation.currency,
      reason: "temporary promotion",
      overriddenBy: "owner:brian",
    });
    expect(await resolveActiveOverride(calculation.masterVariantId)).not.toBeNull();

    await revokePriceOverride({
      masterVariantId: calculation.masterVariantId,
      reason: "promotion ended",
      revokedBy: "owner:brian",
    });

    // Null means "the calculated price applies". A caller should not need to
    // know that a revoke row exists in order to get that right.
    expect(await resolveActiveOverride(calculation.masterVariantId)).toBeNull();
  });

  it("records the revocation as its own row, with actor and reason", async () => {
    const calculation = await aComputedCalculation();

    const set = await applyPriceOverride({
      masterVariantId: calculation.masterVariantId,
      priceCalculationId: calculation.id,
      overrideCashPriceMinorUnits: calculation.cashPriceMinorUnits * 2n,
      currency: calculation.currency,
      reason: "temporary promotion",
      overriddenBy: "owner:brian",
    });

    const revocation = await revokePriceOverride({
      masterVariantId: calculation.masterVariantId,
      reason: "promotion ended",
      revokedBy: "staff:alex",
    });

    const row = await prisma.priceOverride.findUniqueOrThrow({ where: { id: revocation.id } });
    expect(row.kind).toBe("revoke");
    expect(row.supersedesId).toBe(set.id);
    expect(row.overrideCashPriceMinorUnits).toBeNull();
    expect(row.reason).toBe("promotion ended");
    // Withdrawing someone else's override is attributed to the person who
    // withdrew it, not inherited from whoever set it.
    expect(row.overriddenBy).toBe("staff:alex");
    expect(revocation.revokedOverrideId).toBe(set.id);
  });

  it("allows a new override after a revocation, chained onto it", async () => {
    const calculation = await aComputedCalculation();
    const args = {
      masterVariantId: calculation.masterVariantId,
      priceCalculationId: calculation.id,
      currency: calculation.currency,
      overriddenBy: "owner:brian",
    };

    await applyPriceOverride({
      ...args,
      overrideCashPriceMinorUnits: calculation.cashPriceMinorUnits * 2n,
      reason: "first",
    });
    const revocation = await revokePriceOverride({
      masterVariantId: calculation.masterVariantId,
      reason: "ended",
      revokedBy: "owner:brian",
    });
    const reinstated = await applyPriceOverride({
      ...args,
      overrideCashPriceMinorUnits: calculation.cashPriceMinorUnits * 4n,
      reason: "new promotion",
    });

    const row = await prisma.priceOverride.findUniqueOrThrow({ where: { id: reinstated.id } });
    expect(row.supersedesId).toBe(revocation.id);
    expect((await resolveActiveOverride(calculation.masterVariantId))?.id).toBe(reinstated.id);
  });

  it("refuses to revoke when nothing is in effect", async () => {
    const calculation = await aComputedCalculation();

    await expect(
      revokePriceOverride({
        masterVariantId: calculation.masterVariantId,
        reason: "nothing here",
        revokedBy: "owner:brian",
      })
    ).rejects.toThrow(NothingToRevokeError);
  });

  it("requires a reason and an actor, exactly as setting one does", async () => {
    const calculation = await aComputedCalculation();
    await applyPriceOverride({
      masterVariantId: calculation.masterVariantId,
      priceCalculationId: calculation.id,
      overrideCashPriceMinorUnits: calculation.cashPriceMinorUnits * 2n,
      currency: calculation.currency,
      reason: "promotion",
      overriddenBy: "owner:brian",
    });

    await expect(
      revokePriceOverride({
        masterVariantId: calculation.masterVariantId,
        reason: "",
        revokedBy: "owner:brian",
      })
    ).rejects.toThrow(PriceOverrideReasonRequiredError);

    await expect(
      revokePriceOverride({
        masterVariantId: calculation.masterVariantId,
        reason: "a reason",
        revokedBy: "",
      })
    ).rejects.toThrow(PriceOverrideActorRequiredError);
  });
});

describe("kind and price cannot disagree", () => {
  it("refuses at the DATABASE level a revoke that carries a price", async () => {
    const calculation = await aComputedCalculation();

    await expect(
      prisma.priceOverride.create({
        data: {
          masterVariantId: calculation.masterVariantId,
          kind: "revoke",
          overrideCashPriceMinorUnits: 12345n,
          currency: calculation.currency,
          breachedFloors: [],
          reason: "incoherent",
          overriddenBy: "owner:brian",
        },
      })
    ).rejects.toThrow();
  });

  it("refuses at the DATABASE level a set with no price", async () => {
    const calculation = await aComputedCalculation();

    // The one combination that would look like an override while meaning
    // nothing at all.
    await expect(
      prisma.priceOverride.create({
        data: {
          masterVariantId: calculation.masterVariantId,
          kind: "set",
          overrideCashPriceMinorUnits: null,
          currency: calculation.currency,
          breachedFloors: [],
          reason: "incoherent",
          overriddenBy: "owner:brian",
        },
      })
    ).rejects.toThrow();
  });
});
