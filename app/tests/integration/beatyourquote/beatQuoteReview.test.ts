import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  BeatQuoteAlreadyVerifiedError,
  BeatQuoteDecisionIncoherentError,
  BeatQuoteSubmissionNotFoundError,
  newBenefitCode,
  recordDecision,
  recordVerification,
} from "~/db/repositories/beatQuoteReviewRepository.server";
import { evaluateFallbackRedeemability } from "~/domain/beatyourquote/fallbackBenefit";
import { issueBeatQuoteFallbackBenefit } from "~/jobs/beatyourquote/issueFallbackBenefit.server";

/**
 * Staff review, and the one outcome that owes a $100 benefit.
 *
 * THE GATE IS THE SUBJECT HERE. Amendment §2 and §4 case 6 make a fallback owed
 * in exactly one situation — a verified recent custom quote CaratForUs cannot
 * beat — so most of these tests are the combinations that owe NOTHING, each for
 * its own stated reason.
 */

const STAFF = "staff:reviewer-1";
let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;

type Kind = "custom_quote" | "online_listing" | "competing_group_buy";

async function submission(
  overrides: {
    kind?: Kind;
    treatment?: "guarantee" | "review_only";
    quoteAgeCalendarDays?: number | null;
    customerRef?: string | null;
  } = {}
) {
  const kind = overrides.kind ?? "custom_quote";
  const isCustom = kind === "custom_quote";
  const treatment = overrides.treatment ?? (isCustom ? "guarantee" : "review_only");
  return prisma.beatQuoteSubmission.create({
    data: {
      submissionReference: `BQ-${uniq()}`,
      customerRef: overrides.customerRef !== undefined ? overrides.customerRef : "gid://shopify/Customer/7",
      firstName: "Ada",
      lastName: "Lovelace",
      email: `ada-${uniq()}@example.com`,
      kind,
      quoteIssuedOn: isCustom ? new Date("2026-10-03T00:00:00.000Z") : null,
      submittedOn: new Date("2026-10-09T00:00:00.000Z"),
      submittedAt: new Date("2026-10-09T15:00:00.000Z"),
      calendarZone: "America/New_York",
      quoteAgeCalendarDays:
        overrides.quoteAgeCalendarDays !== undefined ? overrides.quoteAgeCalendarDays : isCustom ? 6 : null,
      treatment,
    },
  });
}

/** Verified and declined — the only state that owes a benefit. */
async function qualifying(overrides: Parameters<typeof submission>[0] = {}) {
  const s = await submission(overrides);
  await recordVerification({
    submissionId: s.id,
    outcome: "verified",
    evidence: "Called the seller; quote and price confirmed. Specs comparable.",
    actorRef: STAFF,
    at: new Date("2026-10-10T10:00:00.000Z"),
  });
  await recordDecision({
    submissionId: s.id,
    status: "declined_cannot_beat",
    reason: "Competitor price is below our minimum-profit floor for this configuration.",
    actorRef: STAFF,
    at: new Date("2026-10-10T11:00:00.000Z"),
  });
  return s;
}

describe("recording a verification verdict", () => {
  it("stores the outcome, the evidence, the actor and the time", async () => {
    const s = await submission();
    const after = await recordVerification({
      submissionId: s.id,
      outcome: "verified",
      evidence: "Seller website reachable; quote PDF metadata consistent.",
      actorRef: STAFF,
      at: new Date("2026-10-10T10:00:00.000Z"),
    });
    expect(after.verification).toBe("verified");
    expect(after.verifiedByActorRef).toBe(STAFF);
    expect(after.verifiedAt?.toISOString()).toBe("2026-10-10T10:00:00.000Z");
    expect(after.verificationEvidence).toContain("Seller website");
    expect(after.status).toBe("in_review");
  });

  it("REFUSES to overwrite an existing verdict", async () => {
    // A verdict that can be flipped is a verdict that can be flipped AFTER a
    // benefit was issued or refused on the strength of it, leaving the
    // evidence disagreeing with the outcome.
    const s = await submission();
    await recordVerification({
      submissionId: s.id,
      outcome: "rejected",
      evidence: "Quote metadata shows edits; seller unreachable.",
      actorRef: STAFF,
      at: new Date(),
    });
    await expect(
      recordVerification({
        submissionId: s.id,
        outcome: "verified",
        evidence: "changed my mind",
        actorRef: STAFF,
        at: new Date(),
      })
    ).rejects.toThrow(BeatQuoteAlreadyVerifiedError);

    const row = await prisma.beatQuoteSubmission.findUniqueOrThrow({ where: { id: s.id } });
    expect(row.verification).toBe("rejected");
  });

  it("CONCURRENT verdicts: exactly one wins", async () => {
    // Both reviewers pass the existence read before either writes; the
    // conditional UPDATE decides it.
    const s = await submission();
    const results = await Promise.allSettled([
      recordVerification({ submissionId: s.id, outcome: "verified", evidence: "a", actorRef: "staff:a", at: new Date() }),
      recordVerification({ submissionId: s.id, outcome: "rejected", evidence: "b", actorRef: "staff:b", at: new Date() }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
  });

  it("REFUSES an unknown submission", async () => {
    await expect(
      recordVerification({
        submissionId: "11111111-1111-4111-8111-111111111111",
        outcome: "verified",
        evidence: "x",
        actorRef: STAFF,
        at: new Date(),
      })
    ).rejects.toThrow(BeatQuoteSubmissionNotFoundError);
  });
});

describe("recording a decision", () => {
  it("an offer_made decision carries its price", async () => {
    const s = await submission();
    const after = await recordDecision({
      submissionId: s.id,
      status: "offer_made",
      reason: "We can beat it at this metal weight.",
      actorRef: STAFF,
      at: new Date("2026-10-10T12:00:00.000Z"),
      offeredPriceMinorUnits: 430_000n,
      offeredPriceCurrency: "usd",
      offerTermsShown: "6-8 weeks, 1-year warranty, 14-day discretionary return",
    });
    expect(after.status).toBe("offer_made");
    expect(after.offeredPriceMinorUnits).toBe(430_000n);
    expect(after.offeredPriceCurrency).toBe("USD");
    expect(after.offerTermsShown).toContain("warranty");
  });

  it("REFUSES offer_made with no price — that is not a record of an offer", async () => {
    const s = await submission();
    await expect(
      recordDecision({ submissionId: s.id, status: "offer_made", reason: "r", actorRef: STAFF, at: new Date() })
    ).rejects.toThrow(BeatQuoteDecisionIncoherentError);
  });

  it("REFUSES a price on a declined or rejected decision", async () => {
    // Storing one would make a refusal read as an offer in any later report.
    const s = await submission();
    await expect(
      recordDecision({
        submissionId: s.id,
        status: "declined_cannot_beat",
        reason: "below floor",
        actorRef: STAFF,
        at: new Date(),
        offeredPriceMinorUnits: 1n,
        offeredPriceCurrency: "USD",
      })
    ).rejects.toThrow(BeatQuoteDecisionIncoherentError);
  });

  it("REFUSES a decision with no reason", async () => {
    const s = await submission();
    await expect(
      recordDecision({ submissionId: s.id, status: "rejected", reason: "   ", actorRef: STAFF, at: new Date() })
    ).rejects.toThrow(BeatQuoteDecisionIncoherentError);
  });
});

describe("the fallback is owed in EXACTLY one situation", () => {
  it("ISSUES for a verified recent custom quote CaratForUs cannot beat", async () => {
    const s = await qualifying();
    const result = await issueBeatQuoteFallbackBenefit({
      submissionId: s.id,
      issuedByActorRef: STAFF,
      now: new Date("2026-10-10T12:00:00.000Z"),
    });
    expect(result.outcome).toBe("issued");
    if (result.outcome !== "issued") return;

    // The terms, frozen onto the row.
    expect(result.benefit.percent).toBe(10);
    expect(result.benefit.maxDiscountMinorUnits).toBe(10_000n);
    expect(result.benefit.currency).toBe("USD");
    expect(result.benefit.expiresAt.toISOString()).toBe("2027-01-08T12:00:00.000Z");
    expect(result.benefit.customerRef).toBe("gid://shopify/Customer/7");
    expect(result.benefit.issuedByActorType).toBe("staff");
    expect(result.benefit.benefitCode).toMatch(/^BQ10-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });

  it("owes NOTHING when an offer WAS made — that fulfils the guarantee", async () => {
    // Amendment §4 case 5. Issuing a fallback as well would pay twice for one
    // promise, which is the most expensive mistake available here.
    const s = await submission();
    await recordVerification({ submissionId: s.id, outcome: "verified", evidence: "ok", actorRef: STAFF, at: new Date() });
    await recordDecision({
      submissionId: s.id,
      status: "offer_made",
      reason: "beat it",
      actorRef: STAFF,
      at: new Date(),
      offeredPriceMinorUnits: 400_000n,
      offeredPriceCurrency: "USD",
    });

    const result = await issueBeatQuoteFallbackBenefit({ submissionId: s.id, issuedByActorRef: STAFF, now: new Date() });
    expect(result.outcome).toBe("not_owed");
    expect(await prisma.beatQuoteFallbackBenefit.count({ where: { submissionId: s.id } })).toBe(0);
  });

  it.each(["online_listing", "competing_group_buy"] as const)(
    "owes NOTHING for a %s, even verified and declined — amendment §1",
    async (kind) => {
      const s = await qualifying({ kind });
      const result = await issueBeatQuoteFallbackBenefit({ submissionId: s.id, issuedByActorRef: STAFF, now: new Date() });
      expect(result.outcome).toBe("not_owed");
      if (result.outcome === "not_owed") expect(result.detail).toMatch(/review-only|review_only/i);
      expect(await prisma.beatQuoteFallbackBenefit.count({ where: { submissionId: s.id } })).toBe(0);
    }
  );

  it("owes NOTHING for an over-age custom quote", async () => {
    const s = await qualifying({ treatment: "review_only", quoteAgeCalendarDays: 30 });
    const result = await issueBeatQuoteFallbackBenefit({ submissionId: s.id, issuedByActorRef: STAFF, now: new Date() });
    expect(result.outcome).toBe("not_owed");
  });

  it("owes NOTHING when verification is pending or rejected", async () => {
    // Original §"Verification and Fraud Protection": a fabricated, altered or
    // unverifiable submission does not trigger the fallback.
    const pending = await submission();
    await recordDecision({
      submissionId: pending.id,
      status: "declined_cannot_beat",
      reason: "below floor",
      actorRef: STAFF,
      at: new Date(),
    });
    const a = await issueBeatQuoteFallbackBenefit({ submissionId: pending.id, issuedByActorRef: STAFF, now: new Date() });
    expect(a.outcome).toBe("not_owed");
    if (a.outcome === "not_owed") expect(a.detail).toMatch(/not verified|pending/i);

    const rejected = await submission();
    await recordVerification({
      submissionId: rejected.id,
      outcome: "rejected",
      evidence: "quote appears AI-generated",
      actorRef: STAFF,
      at: new Date(),
    });
    await recordDecision({
      submissionId: rejected.id,
      status: "declined_cannot_beat",
      reason: "not qualifying",
      actorRef: STAFF,
      at: new Date(),
    });
    const b = await issueBeatQuoteFallbackBenefit({ submissionId: rejected.id, issuedByActorRef: STAFF, now: new Date() });
    expect(b.outcome).toBe("not_owed");
  });

  it("FAILS CLOSED for an anonymous submission — non-transferable needs an identity", async () => {
    // Intake is open to signed-out visitors, but amendment §3 makes the
    // benefit non-transferable, which is meaningless without a holder. Binding
    // to an email would make it claimable by anyone controlling that mailbox.
    const s = await qualifying({ customerRef: null });
    const result = await issueBeatQuoteFallbackBenefit({ submissionId: s.id, issuedByActorRef: STAFF, now: new Date() });
    expect(result.outcome).toBe("customer_not_linked");
    expect(await prisma.beatQuoteFallbackBenefit.count({ where: { submissionId: s.id } })).toBe(0);
  });

  it("reports a missing submission rather than throwing", async () => {
    const result = await issueBeatQuoteFallbackBenefit({
      submissionId: "22222222-2222-4222-8222-222222222222",
      issuedByActorRef: STAFF,
      now: new Date(),
    });
    expect(result.outcome).toBe("submission_not_found");
  });
});

describe("amendment §3 / §4 case 8: one qualifying outcome, one benefit", () => {
  it("a second issuance returns the EXISTING benefit", async () => {
    const s = await qualifying();
    const first = await issueBeatQuoteFallbackBenefit({ submissionId: s.id, issuedByActorRef: STAFF, now: new Date() });
    expect(first.outcome).toBe("issued");

    const second = await issueBeatQuoteFallbackBenefit({ submissionId: s.id, issuedByActorRef: STAFF, now: new Date() });
    expect(second.outcome).toBe("already_issued");
    if (first.outcome === "issued" && second.outcome === "already_issued") {
      expect(second.benefit.id).toBe(first.benefit.id);
      // The code is NOT regenerated — a second code for one benefit would be a
      // second benefit in all but name.
      expect(second.benefit.benefitCode).toBe(first.benefit.benefitCode);
    }
    expect(await prisma.beatQuoteFallbackBenefit.count({ where: { submissionId: s.id } })).toBe(1);
  });

  it("CONCURRENT issuances produce exactly one benefit, with no error", async () => {
    const s = await qualifying();
    const [a, b] = await Promise.all([
      issueBeatQuoteFallbackBenefit({ submissionId: s.id, issuedByActorRef: "staff:a", now: new Date() }),
      issueBeatQuoteFallbackBenefit({ submissionId: s.id, issuedByActorRef: "staff:b", now: new Date() }),
    ]);
    expect([a.outcome, b.outcome].sort()).toEqual(["already_issued", "issued"]);
    expect(await prisma.beatQuoteFallbackBenefit.count({ where: { submissionId: s.id } })).toBe(1);
  });
});

describe("the issued benefit is immediately usable, and only as specified", () => {
  it("is redeemable by its holder on Buy Now, and not on a Group Buy", async () => {
    // Composing the issued row with the redemption rule, so the stored terms
    // and the evaluator are proven to agree rather than tested separately.
    const s = await qualifying();
    const issued = await issueBeatQuoteFallbackBenefit({
      submissionId: s.id,
      issuedByActorRef: STAFF,
      now: new Date("2026-10-10T12:00:00.000Z"),
    });
    if (issued.outcome !== "issued") throw new Error("expected issuance");
    const b = issued.benefit;

    const base = {
      issuedAt: b.issuedAt,
      expiresAt: b.expiresAt,
      redeemedAt: b.redeemedAt,
      revokedAt: b.revokedAt,
      issuedToCustomerRef: b.customerRef,
      otherPromotionApplied: false,
      stackingExpresslyAuthorized: false,
      now: new Date("2026-11-01T00:00:00.000Z"),
    };
    expect(
      evaluateFallbackRedeemability({ ...base, attemptingCustomerRef: b.customerRef, surface: "buy_now" })
    ).toEqual({ redeemable: true });
    expect(
      evaluateFallbackRedeemability({ ...base, attemptingCustomerRef: b.customerRef, surface: "group_buy" })
    ).toEqual({ redeemable: false, refusal: "surface_not_eligible" });
    expect(
      evaluateFallbackRedeemability({ ...base, attemptingCustomerRef: "gid://shopify/Customer/999", surface: "buy_now" })
    ).toEqual({ redeemable: false, refusal: "not_transferable" });
    // And after 90 days.
    expect(
      evaluateFallbackRedeemability({
        ...base,
        attemptingCustomerRef: b.customerRef,
        surface: "buy_now",
        now: new Date("2027-02-01T00:00:00.000Z"),
      })
    ).toEqual({ redeemable: false, refusal: "expired" });
  });
});

describe("benefit codes", () => {
  it("are unguessable and read-aloud safe", async () => {
    const codes = new Set(Array.from({ length: 200 }, () => newBenefitCode()));
    // No collisions across 200 draws — a sequence or a weak source would show
    // here.
    expect(codes.size).toBe(200);
    for (const code of codes) {
      // No I, O, 0 or 1 anywhere after the prefix: a code read over the phone
      // must not be ambiguous. The prefix itself contains a literal '10'.
      expect(code.slice(5)).not.toMatch(/[IO01]/);
      expect(code).toMatch(/^BQ10-/);
    }
  });
});
