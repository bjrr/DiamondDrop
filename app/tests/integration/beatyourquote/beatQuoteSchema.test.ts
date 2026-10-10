import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { fallbackExpiresAt } from "~/domain/beatyourquote/fallbackBenefit";

/**
 * The database-level guarantees for "Let Us Beat Your Quote".
 *
 * These are not tests of the application's logic — the pure rules are covered
 * in `app/domain/beatyourquote/`. These prove the SCHEMA refuses what policy
 * forbids, so that a route with a bug, a retried job, or a careless manual
 * INSERT cannot produce a state the amendment rules out.
 *
 * Every assertion here corresponds to a locked clause, named in the test.
 */

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;

async function submission(
  overrides: Partial<{
    kind: "custom_quote" | "online_listing" | "competing_group_buy";
    treatment: "guarantee" | "review_only";
    quoteIssuedOn: Date | null;
    quoteAgeCalendarDays: number | null;
    verification: "pending" | "verified" | "rejected";
    verifiedAt: Date | null;
    verifiedByActorRef: string | null;
  }> = {}
) {
  const kind = overrides.kind ?? "custom_quote";
  const isCustom = kind === "custom_quote";
  return prisma.beatQuoteSubmission.create({
    data: {
      submissionReference: `BQ-${uniq()}`,
      firstName: "Ada",
      lastName: "Lovelace",
      email: `ada-${uniq()}@example.com`,
      kind,
      quoteIssuedOn:
        overrides.quoteIssuedOn !== undefined
          ? overrides.quoteIssuedOn
          : isCustom
            ? new Date("2026-10-02T00:00:00.000Z")
            : null,
      submittedOn: new Date("2026-10-09T00:00:00.000Z"),
      quoteAgeCalendarDays:
        overrides.quoteAgeCalendarDays !== undefined ? overrides.quoteAgeCalendarDays : isCustom ? 7 : null,
      treatment: overrides.treatment ?? (isCustom ? "guarantee" : "review_only"),
      verification: overrides.verification ?? "verified",
      verifiedAt: overrides.verifiedAt !== undefined ? overrides.verifiedAt : new Date(),
      verifiedByActorRef:
        overrides.verifiedByActorRef !== undefined ? overrides.verifiedByActorRef : "staff:reviewer",
    },
  });
}

async function benefit(submissionId: string, overrides: Record<string, unknown> = {}) {
  const issuedAt = new Date("2026-10-09T12:00:00.000Z");
  return prisma.beatQuoteFallbackBenefit.create({
    data: {
      submissionId,
      benefitCode: `BQB-${uniq()}`,
      customerRef: "gid://shopify/Customer/1",
      percent: 10,
      maxDiscountMinorUnits: 10_000n,
      currency: "USD",
      issuedAt,
      expiresAt: fallbackExpiresAt(issuedAt),
      issuedByActorType: "system",
      issuedByActorRef: "job:beat-quote-fallback",
      ...overrides,
    },
  });
}

describe("amendment §1: only a custom quote can carry the guarantee", () => {
  it("REFUSES treatment=guarantee on an online listing", async () => {
    // The original spec §2 promises the guarantee for a live listing;
    // amendment §1 supersedes it. This is that supersession as a constraint,
    // so implementing from the original document fails loudly rather than
    // quietly over-promising a $100 benefit.
    await expect(
      prisma.beatQuoteSubmission.create({
        data: {
          submissionReference: `BQ-${uniq()}`,
          firstName: "A",
          lastName: "B",
          email: `x-${uniq()}@example.com`,
          kind: "online_listing",
          submittedOn: new Date("2026-10-09T00:00:00.000Z"),
          treatment: "guarantee",
        },
      })
    ).rejects.toThrow(/guarantee_requires_custom_quote/i);
  });

  it("REFUSES treatment=guarantee on a competing Group Buy", async () => {
    await expect(
      prisma.beatQuoteSubmission.create({
        data: {
          submissionReference: `BQ-${uniq()}`,
          firstName: "A",
          lastName: "B",
          email: `x-${uniq()}@example.com`,
          kind: "competing_group_buy",
          submittedOn: new Date("2026-10-09T00:00:00.000Z"),
          treatment: "guarantee",
        },
      })
    ).rejects.toThrow(/guarantee_requires_custom_quote/i);
  });

  it("ALLOWS review_only for both — they are accepted, just not guaranteed", async () => {
    // Without this, the constraint could be "reject these kinds entirely" and
    // the refusals above would still pass. The spec wants them accepted.
    for (const kind of ["online_listing", "competing_group_buy"] as const) {
      const row = await submission({ kind });
      expect(row.treatment).toBe("review_only");
      expect(row.quoteAgeCalendarDays).toBeNull();
    }
  });
});

describe("the 7-day window is a constraint, not just a calculation", () => {
  it("REFUSES a guarantee on a quote aged 8 days", async () => {
    await expect(submission({ quoteAgeCalendarDays: 8, treatment: "guarantee" })).rejects.toThrow(
      /guarantee_within_window/i
    );
  });

  it("ALLOWS a guarantee at exactly 7, and at 0", async () => {
    expect((await submission({ quoteAgeCalendarDays: 7 })).treatment).toBe("guarantee");
    expect((await submission({ quoteAgeCalendarDays: 0 })).treatment).toBe("guarantee");
  });

  it("REFUSES a guarantee on a negative age — a quote from the future", async () => {
    await expect(submission({ quoteAgeCalendarDays: -1, treatment: "guarantee" })).rejects.toThrow(
      /guarantee_within_window/i
    );
  });

  it("ALLOWS review_only at any age, including 8 and beyond", async () => {
    // "There is no need to reject an older quote solely because of age."
    expect((await submission({ quoteAgeCalendarDays: 400, treatment: "review_only" })).treatment).toBe(
      "review_only"
    );
  });
});

describe("age belongs only to custom quotes — amendment §1", () => {
  it("REFUSES an age on an online listing", async () => {
    // Storing one would invite someone to compare it against 7 for a kind that
    // has no age rule at all.
    await expect(submission({ kind: "online_listing", quoteAgeCalendarDays: 3 })).rejects.toThrow(
      /age_only_for_custom_quote/i
    );
  });

  it("REFUSES a custom quote with no age or no issue date", async () => {
    await expect(submission({ quoteAgeCalendarDays: null })).rejects.toThrow(/age_only_for_custom_quote/i);
    await expect(submission({ quoteIssuedOn: null })).rejects.toThrow(/age_only_for_custom_quote/i);
  });
});

describe("a verification verdict is attributed", () => {
  it("REFUSES a verified submission with no reviewer or no timestamp", async () => {
    // An audit trail with an anonymous verdict on a $100-bearing decision is
    // not an audit trail.
    await expect(submission({ verification: "verified", verifiedByActorRef: null })).rejects.toThrow(
      /verification_attributed/i
    );
    await expect(submission({ verification: "rejected", verifiedAt: null })).rejects.toThrow(
      /verification_attributed/i
    );
  });

  it("ALLOWS pending with neither — nothing has been decided yet", async () => {
    const row = await submission({ verification: "pending", verifiedAt: null, verifiedByActorRef: null });
    expect(row.verification).toBe("pending");
  });
});

describe("amendment §3: duplicate issuance cannot create a second benefit", () => {
  it("REFUSES a second benefit for the same submission", async () => {
    // Case 8 of §4. A retried job, a double-clicked button and two concurrent
    // requests all lose to this index rather than to a code path.
    const s = await submission();
    await benefit(s.id);
    await expect(benefit(s.id)).rejects.toThrow();
    expect(await prisma.beatQuoteFallbackBenefit.count({ where: { submissionId: s.id } })).toBe(1);
  });

  it("REFUSES two benefits redeemed against the SAME order", async () => {
    const a = await submission();
    const b = await submission();
    const orderRef = `gid://shopify/Order/${uniq()}`;
    await benefit(a.id, {
      redeemedAt: new Date("2026-10-20T00:00:00.000Z"),
      redemptionOrderRef: orderRef,
      redemptionDiscountMinorUnits: 5_000n,
    });
    await expect(
      benefit(b.id, {
        redeemedAt: new Date("2026-10-21T00:00:00.000Z"),
        redemptionOrderRef: orderRef,
        redemptionDiscountMinorUnits: 5_000n,
      })
    ).rejects.toThrow();
  });
});

describe("the $100 cap is a constraint", () => {
  it("REFUSES a redemption above the benefit's own frozen maximum", async () => {
    // "maximum discount $100" is the term an arithmetic slip would break, so
    // the database refuses the over-discount rather than trusting the
    // calculation that produced it.
    const s = await submission();
    await expect(
      benefit(s.id, {
        redeemedAt: new Date(),
        redemptionOrderRef: `gid://shopify/Order/${uniq()}`,
        redemptionDiscountMinorUnits: 10_001n,
      })
    ).rejects.toThrow(/redemption_within_cap/i);
  });

  it("ALLOWS a redemption at exactly the cap", async () => {
    const s = await submission();
    const row = await benefit(s.id, {
      redeemedAt: new Date(),
      redemptionOrderRef: `gid://shopify/Order/${uniq()}`,
      redemptionDiscountMinorUnits: 10_000n,
    });
    expect(row.redemptionDiscountMinorUnits).toBe(10_000n);
  });
});

describe("a redemption record is complete or absent", () => {
  it("REFUSES redeemed-with-no-order and redeemed-with-no-amount", async () => {
    // "Redeemed, but we do not know where or for how much" is not a record of
    // a redemption, and amendment §3 requires the order.
    const a = await submission();
    await expect(benefit(a.id, { redeemedAt: new Date() })).rejects.toThrow(/redemption_complete/i);
    const b = await submission();
    await expect(
      benefit(b.id, { redeemedAt: new Date(), redemptionOrderRef: `gid://shopify/Order/${uniq()}` })
    ).rejects.toThrow(/redemption_complete/i);
  });

  it("REFUSES an order reference with no redemption timestamp", async () => {
    const s = await submission();
    await expect(benefit(s.id, { redemptionOrderRef: `gid://shopify/Order/${uniq()}` })).rejects.toThrow(
      /redemption_complete/i
    );
  });
});

describe("single use and finality are enforced by trigger, not convention", () => {
  it("REFUSES un-redeeming a spent benefit", async () => {
    const s = await submission();
    const row = await benefit(s.id, {
      redeemedAt: new Date("2026-10-20T00:00:00.000Z"),
      redemptionOrderRef: `gid://shopify/Order/${uniq()}`,
      redemptionDiscountMinorUnits: 4_000n,
    });
    await expect(
      prisma.$executeRaw`UPDATE "beat_quote_fallback_benefit" SET "redeemed_at" = NULL, "redemption_order_ref" = NULL, "redemption_discount_minor_units" = NULL WHERE "id" = ${row.id}::uuid`
    ).rejects.toThrow(/single use and final/i);
  });

  it("REFUSES moving a redemption to another order, or re-valuing it", async () => {
    const s = await submission();
    const row = await benefit(s.id, {
      redeemedAt: new Date("2026-10-20T00:00:00.000Z"),
      redemptionOrderRef: `gid://shopify/Order/${uniq()}`,
      redemptionDiscountMinorUnits: 4_000n,
    });
    await expect(
      prisma.$executeRaw`UPDATE "beat_quote_fallback_benefit" SET "redemption_order_ref" = 'gid://shopify/Order/999' WHERE "id" = ${row.id}::uuid`
    ).rejects.toThrow(/single use and final/i);
    await expect(
      prisma.$executeRaw`UPDATE "beat_quote_fallback_benefit" SET "redemption_discount_minor_units" = 9999 WHERE "id" = ${row.id}::uuid`
    ).rejects.toThrow(/single use and final/i);
  });

  it("ALLOWS the FIRST redemption — the guard is conditional, not a block", async () => {
    // Without this the trigger could refuse every update and every test above
    // would still pass.
    const s = await submission();
    const row = await benefit(s.id);
    const updated = await prisma.beatQuoteFallbackBenefit.update({
      where: { id: row.id },
      data: {
        redeemedAt: new Date("2026-10-20T00:00:00.000Z"),
        redemptionOrderRef: `gid://shopify/Order/${uniq()}`,
        redemptionDiscountMinorUnits: 3_500n,
      },
    });
    expect(updated.redeemedAt).not.toBeNull();
  });

  it("REFUSES editing the frozen terms", async () => {
    // If the benefit later becomes 15%, every already-issued one must still be
    // worth exactly what its holder was promised.
    const s = await submission();
    const row = await benefit(s.id);
    for (const sql of [
      prisma.$executeRaw`UPDATE "beat_quote_fallback_benefit" SET "percent" = 15 WHERE "id" = ${row.id}::uuid`,
      prisma.$executeRaw`UPDATE "beat_quote_fallback_benefit" SET "max_discount_minor_units" = 15000 WHERE "id" = ${row.id}::uuid`,
      prisma.$executeRaw`UPDATE "beat_quote_fallback_benefit" SET "expires_at" = now() + interval '1 year' WHERE "id" = ${row.id}::uuid`,
      prisma.$executeRaw`UPDATE "beat_quote_fallback_benefit" SET "customer_ref" = 'gid://shopify/Customer/999' WHERE "id" = ${row.id}::uuid`,
      prisma.$executeRaw`UPDATE "beat_quote_fallback_benefit" SET "benefit_code" = 'BQB-STOLEN' WHERE "id" = ${row.id}::uuid`,
    ]) {
      await expect(sql).rejects.toThrow(/issued terms are immutable/i);
    }
  });

  it("REFUSES reversing a revocation", async () => {
    const s = await submission();
    const row = await benefit(s.id, { revokedAt: new Date(), revokedReason: "fabricated quote discovered" });
    await expect(
      prisma.$executeRaw`UPDATE "beat_quote_fallback_benefit" SET "revoked_at" = NULL, "revoked_reason" = NULL WHERE "id" = ${row.id}::uuid`
    ).rejects.toThrow(/revocation cannot be reversed/i);
  });

  it("REFUSES a revocation with no reason, and DELETE outright", async () => {
    const s = await submission();
    await expect(benefit(s.id, { revokedAt: new Date() })).rejects.toThrow(/revocation_has_reason/i);

    const row = await benefit(s.id);
    // Deleting a benefit would erase the record of a promise made to a
    // customer. Revocation is how one stops being usable.
    await expect(
      prisma.$executeRaw`DELETE FROM "beat_quote_fallback_benefit" WHERE "id" = ${row.id}::uuid`
    ).rejects.toThrow(/append-only/i);
  });
});

describe("expiry must run forwards", () => {
  it("REFUSES an expiry at or before issuance", async () => {
    const s = await submission();
    const issuedAt = new Date("2026-10-09T12:00:00.000Z");
    await expect(benefit(s.id, { issuedAt, expiresAt: issuedAt })).rejects.toThrow(/expires_after_issue/i);
  });
});
