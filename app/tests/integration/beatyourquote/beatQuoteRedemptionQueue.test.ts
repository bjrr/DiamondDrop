import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  listRedemptionsNeedingAttention,
  STALE_RESERVATION_HOURS,
} from "~/db/repositories/beatQuoteReviewRepository.server";
import { fallbackExpiresAt } from "~/domain/beatyourquote/fallbackBenefit";

/**
 * The staff queue of redemptions needing attention.
 *
 * ============================================================================
 * WHY THIS QUERY IS WORTH TESTING AT ALL
 * ============================================================================
 * Order-time verification fails CLOSED to `failed_review` — it will not mark a
 * benefit redeemed on a discount that disagrees with the reservation, and it
 * will not release one that may already have been honoured. That safeguard is
 * only real if a person sees the result. A fail-closed state nobody can find is
 * a silent failure with extra steps, so the thing to protect here is simply:
 * does the row reach the screen, and is it distinguishable from routine work?
 *
 * Tested at the repository level, same reasoning as `beatQuoteAdminQueue`: the
 * loader is a thin mapping over this function plus `authenticate.admin`.
 *
 * EVERY TEST SCOPES TO ITS OWN ROWS. This query is deliberately unpaginated and
 * unfiltered — it returns everything needing attention in the whole database —
 * so asserting on counts would make each test depend on every other test's
 * leftovers. Two of my own admin-queue tests already failed that way once.
 */

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;

const CUSTOMER = "gid://shopify/Customer/4242";
const ISSUED_AT = new Date("2026-10-10T12:00:00.000Z");

async function benefit(): Promise<{ id: string; benefitCode: string; submissionId: string }> {
  const submission = await prisma.beatQuoteSubmission.create({
    data: {
      submissionReference: `BQ-RQ-${uniq()}`,
      customerRef: CUSTOMER,
      firstName: "Ada",
      lastName: "Lovelace",
      email: `ada-rq-${uniq()}@example.com`,
      kind: "custom_quote",
      quoteIssuedOn: new Date("2026-10-05T00:00:00.000Z"),
      submittedOn: new Date("2026-10-09T00:00:00.000Z"),
      submittedAt: new Date("2026-10-09T15:00:00.000Z"),
      calendarZone: "America/New_York",
      quoteAgeCalendarDays: 4,
      treatment: "guarantee",
      verification: "verified",
      verifiedAt: ISSUED_AT,
      verifiedByActorRef: "staff:reviewer",
      status: "declined_cannot_beat",
      decisionReason: "below floor",
    },
  });
  const row = await prisma.beatQuoteFallbackBenefit.create({
    data: {
      submissionId: submission.id,
      benefitCode: `BQ10-RQ-${uniq()}`,
      customerRef: CUSTOMER,
      percent: 10,
      maxDiscountMinorUnits: 10_000n,
      currency: "USD",
      issuedAt: ISSUED_AT,
      expiresAt: fallbackExpiresAt(ISSUED_AT),
      issuedByActorType: "staff",
      issuedByActorRef: "staff:reviewer",
    },
  });
  return { id: row.id, benefitCode: row.benefitCode, submissionId: submission.id };
}

/**
 * An intent in a given state, written directly.
 *
 * `reservedAt` is set explicitly rather than by waiting: the staleness
 * threshold is hours, and a test that sleeps past it is not a test anybody
 * runs twice.
 */
async function intent(options: {
  status: "reserved" | "completed" | "released" | "failed_review";
  reservedMinutesAgo?: number;
  reviewReason?: string;
}) {
  const b = await benefit();
  const reservedAt = new Date(Date.now() - (options.reservedMinutesAgo ?? 0) * 60_000);
  const row = await prisma.beatQuoteRedemptionIntent.create({
    data: {
      benefitId: b.id,
      customerRef: CUSTOMER,
      surface: "buy_now",
      paymentBasis: "card",
      eligibleSubtotalMinorUnits: 50_000n,
      discountMinorUnits: 5_000n,
      currency: "USD",
      benefitMaxDiscountMinorUnits: 10_000n,
      benefitExpiresAt: fallbackExpiresAt(ISSUED_AT),
      eligibleLines: [],
      reservedAt,
      draftOrderGid: `gid://shopify/DraftOrder/rq-${uniq()}`,
    },
  });

  // The terminal states are reached by UPDATE, because the guard trigger makes
  // them terminal — an intent cannot be born `completed`.
  if (options.status !== "reserved") {
    const terminal =
      options.status === "completed"
        ? {
            status: "completed" as const,
            completedAt: new Date(),
            orderGid: `gid://shopify/Order/rq-${uniq()}`,
          }
        : options.status === "released"
          ? { status: "released" as const, releasedAt: new Date(), releaseReason: "abandoned: test" }
          : {
              status: "failed_review" as const,
              reviewReason: options.reviewReason ?? "order discount 1 does not equal the reserved 5000",
              orderGid: `gid://shopify/Order/rq-${uniq()}`,
            };
    await prisma.beatQuoteRedemptionIntent.update({ where: { id: row.id }, data: terminal });
    if (options.status === "completed") {
      await prisma.beatQuoteFallbackBenefit.update({
        where: { id: b.id },
        data: {
          redeemedAt: new Date(),
          redemptionOrderRef: terminal.orderGid!,
          redemptionDiscountMinorUnits: 5_000n,
        },
      });
    }
  }

  return { intentId: row.id, benefit: b };
}

/** Only this test's own row, found by id. */
async function findMine(intentId: string) {
  const rows = await listRedemptionsNeedingAttention();
  return rows.find((row) => row.intentId === intentId) ?? null;
}

describe("what reaches the queue", () => {
  it("SURFACES a failed_review redemption, with the reason that explains it", async () => {
    const { intentId, benefit: b } = await intent({
      status: "failed_review",
      reviewReason: "order discount 100 does not equal the reserved 5000",
    });

    const row = await findMine(intentId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("failed_review");
    // THE FLAG THE SCREEN SORTS ON. A failed verification is a decision for a
    // person; a stale hold is housekeeping. Collapsing them would bury the one
    // that matters.
    expect(row!.needsDecision).toBe(true);
    expect(row!.reviewReason).toMatch(/does not equal the reserved/);
    // Enough context to act: which benefit, whose submission, which order.
    expect(row!.benefitCode).toBe(b.benefitCode);
    expect(row!.submissionId).toBe(b.submissionId);
    expect(row!.orderGid).not.toBeNull();
    expect(row!.discountMinorUnits).toBe(5_000n);
  });

  it("SURFACES a reservation held longer than the threshold", async () => {
    const { intentId } = await intent({
      status: "reserved",
      reservedMinutesAgo: STALE_RESERVATION_HOURS * 60 + 5,
    });

    const row = await findMine(intentId);
    expect(row).not.toBeNull();
    expect(row!.status).toBe("reserved");
    // Housekeeping, not a decision — but it still has a customer on the other
    // end who cannot start a new checkout until it is released.
    expect(row!.needsDecision).toBe(false);
  });

  it("IGNORES a reservation still inside the threshold", async () => {
    // A customer part-way through a normal checkout must never be flagged.
    const { intentId } = await intent({ status: "reserved", reservedMinutesAgo: 1 });
    expect(await findMine(intentId)).toBeNull();
  });

  it.each(["completed", "released"] as const)("IGNORES a %s redemption", async (status) => {
    // Both are finished. A queue that lists finished work is a queue nobody
    // reads.
    const { intentId } = await intent({ status, reservedMinutesAgo: 60 * 24 });
    expect(await findMine(intentId)).toBeNull();
  });

  it("surfaces a failed_review row REGARDLESS of how long ago it was reserved", async () => {
    // Staleness gates the `reserved` rows only. A verification failure needs a
    // person whether it happened two minutes or two weeks ago.
    const { intentId } = await intent({ status: "failed_review", reservedMinutesAgo: 1 });
    expect(await findMine(intentId)).not.toBeNull();
  });
});

describe("ordering", () => {
  it("returns the oldest reservation first", async () => {
    // A triage queue is worked front to back, and the one waiting longest has a
    // customer waiting longest.
    const older = await intent({ status: "failed_review", reservedMinutesAgo: 600 });
    const newer = await intent({ status: "failed_review", reservedMinutesAgo: 300 });

    const rows = await listRedemptionsNeedingAttention();
    const olderAt = rows.findIndex((r) => r.intentId === older.intentId);
    const newerAt = rows.findIndex((r) => r.intentId === newer.intentId);
    expect(olderAt).toBeGreaterThanOrEqual(0);
    expect(newerAt).toBeGreaterThanOrEqual(0);
    expect(olderAt).toBeLessThan(newerAt);
  });
});

describe("the threshold is a queue setting, not a deadline", () => {
  it("NOTHING expires a reservation — it is still reserved long past the threshold", async () => {
    // Worth pinning: the benefit stays unusable until someone releases it or
    // the customer pays. If a sweep is ever added, this test should fail and be
    // changed deliberately rather than silently.
    const { intentId } = await intent({
      status: "reserved",
      reservedMinutesAgo: STALE_RESERVATION_HOURS * 60 * 100,
    });
    const stored = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intentId } });
    expect(stored.status).toBe("reserved");
    expect(stored.releasedAt).toBeNull();
  });
});
