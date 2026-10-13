import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  recordDecision,
  recordVerification,
  searchBeatQuoteSubmissionsForStaff,
} from "~/db/repositories/beatQuoteReviewRepository.server";
import { issueBeatQuoteFallbackBenefit } from "~/jobs/beatyourquote/issueFallbackBenefit.server";

/**
 * The staff triage query behind `/app/beat-quote`.
 *
 * Tested at the repository level rather than by rendering: the loader is a thin
 * mapping over this function plus `authenticate.admin`, and everything worth
 * protecting — which columns reach a staff screen, and whether the work states
 * stay distinguishable — lives here.
 */

const STAFF = "staff:reviewer-q";
let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;

type Kind = "custom_quote" | "online_listing" | "competing_group_buy";

async function submission(
  overrides: { kind?: Kind; customerRef?: string | null; minutesAgo?: number; emailMarker?: string } = {}
) {
  const kind = overrides.kind ?? "custom_quote";
  const isCustom = kind === "custom_quote";
  const minutesAgo = overrides.minutesAgo ?? 0;
  return prisma.beatQuoteSubmission.create({
    data: {
      submissionReference: `BQ-${uniq()}`,
      customerRef: overrides.customerRef !== undefined ? overrides.customerRef : "gid://shopify/Customer/5",
      firstName: "Ada",
      lastName: "Lovelace",
      // The marker lets a test scope a search to its OWN rows.
      email: `ada-${overrides.emailMarker ? `${overrides.emailMarker}-` : ""}${uniq()}@example.com`,
      kind,
      quoteIssuedOn: isCustom ? new Date("2026-10-04T00:00:00.000Z") : null,
      submittedOn: new Date("2026-10-09T00:00:00.000Z"),
      submittedAt: new Date(Date.now() - minutesAgo * 60_000),
      calendarZone: "America/New_York",
      quoteAgeCalendarDays: isCustom ? 5 : null,
      treatment: isCustom ? "guarantee" : "review_only",
      competitorPriceMinorUnits: 450_000n,
      competitorPriceCurrency: "USD",
      specifications: "long free text that must not reach the list screen",
    },
  });
}

async function find(reference: string) {
  const result = await searchBeatQuoteSubmissionsForStaff({ query: reference });
  expect(result.rows, `no row for ${reference}`).toHaveLength(1);
  return result.rows[0]!;
}

describe("the queue keeps the distinct work states distinguishable", () => {
  it("separates awaiting-verification, awaiting-decision, and benefit-owed", async () => {
    // Three different queues. A reviewer's question is "what do I do with
    // this?", and these three all read as "in progress" from `status` alone.
    const awaitingVerification = await submission();

    const awaitingDecision = await submission();
    await recordVerification({
      submissionId: awaitingDecision.id,
      outcome: "verified",
      evidence: "checked",
      actorRef: STAFF,
      at: new Date(),
    });

    const benefitOwed = await submission();
    await recordVerification({
      submissionId: benefitOwed.id,
      outcome: "verified",
      evidence: "checked",
      actorRef: STAFF,
      at: new Date(),
    });
    await recordDecision({
      submissionId: benefitOwed.id,
      status: "declined_cannot_beat",
      reason: "below floor",
      actorRef: STAFF,
      at: new Date(),
    });

    const a = await find(awaitingVerification.submissionReference);
    expect(a.verification).toBe("pending");
    expect(a.benefitIssuedAt).toBeNull();

    const b = await find(awaitingDecision.submissionReference);
    expect(b.verification).toBe("verified");
    expect(b.status).toBe("in_review");
    expect(b.benefitIssuedAt).toBeNull();

    const c = await find(benefitOwed.submissionReference);
    expect(c.verification).toBe("verified");
    expect(c.status).toBe("declined_cannot_beat");
    expect(c.treatment).toBe("guarantee");
    // The liability: owed and not issued.
    expect(c.benefitIssuedAt).toBeNull();
  });

  it("shows a benefit as issued once it exists", async () => {
    const s = await submission();
    await recordVerification({ submissionId: s.id, outcome: "verified", evidence: "ok", actorRef: STAFF, at: new Date() });
    await recordDecision({
      submissionId: s.id,
      status: "declined_cannot_beat",
      reason: "below floor",
      actorRef: STAFF,
      at: new Date(),
    });
    await issueBeatQuoteFallbackBenefit({ submissionId: s.id, issuedByActorRef: STAFF, now: new Date() });

    const row = await find(s.submissionReference);
    expect(row.benefitIssuedAt).not.toBeNull();
  });

  it("distinguishes a declined REVIEW-ONLY submission, which owes nothing", async () => {
    // Same status as the owed case; different treatment. Reading `status`
    // alone would put these in one bucket and invent a liability.
    const s = await submission({ kind: "online_listing" });
    await recordVerification({ submissionId: s.id, outcome: "verified", evidence: "ok", actorRef: STAFF, at: new Date() });
    await recordDecision({
      submissionId: s.id,
      status: "declined_cannot_beat",
      reason: "chose not to match",
      actorRef: STAFF,
      at: new Date(),
    });

    const row = await find(s.submissionReference);
    expect(row.status).toBe("declined_cannot_beat");
    expect(row.treatment).toBe("review_only");
    expect(row.benefitIssuedAt).toBeNull();
  });

  it("reports whether a benefit COULD be bound to an account", async () => {
    // What a triaging reviewer needs is a yes/no, because issuance fails
    // closed for an anonymous submission — the benefit is non-transferable.
    const anonymous = await submission({ customerRef: null });
    const signedIn = await submission();
    expect((await find(anonymous.submissionReference)).hasAccount).toBe(false);
    expect((await find(signedIn.submissionReference)).hasAccount).toBe(true);
  });
});

describe("the queue exposes only what it should", () => {
  it("carries no specifications, verification evidence or decision reason", async () => {
    // All long free text that makes a list unreadable, and the evidence is
    // internal. Asserted on the row's exact key set, so adding a column to the
    // model cannot quietly put it on a staff screen.
    const s = await submission();
    const row = await find(s.submissionReference);
    expect(Object.keys(row).sort()).toEqual(
      [
        "benefitIssuedAt",
        "competitorPriceCurrency",
        "competitorPriceMinorUnits",
        "customerName",
        "email",
        "hasAccount",
        "id",
        "kind",
        "quoteAgeCalendarDays",
        "status",
        "submissionReference",
        "submittedAt",
        "treatment",
        "verification",
      ].sort()
    );
  });

  it("carries no raw customerRef — a gid is not what triage needs", async () => {
    const s = await submission();
    const row = await find(s.submissionReference);
    // Checked field by field rather than by serialising the row: the row holds
    // BigInt money columns, and JSON.stringify throws on those. A test that
    // crashed on its own assertion was proving nothing.
    expect(Object.keys(row)).not.toContain("customerRef");
    for (const value of Object.values(row)) {
      if (typeof value === "string") expect(value).not.toContain("gid://shopify/Customer");
    }
  });
});

describe("ordering and search", () => {
  it("is OLDEST FIRST — a queue is worked front to back", async () => {
    // The submission waiting longest is the one a customer is waiting on.
    //
    // SCOPED TO THIS TEST'S OWN TWO ROWS via a shared email marker. An earlier
    // version read page 1 of everything and failed once the shared
    // integration database held more than 25 submissions from other files —
    // the same cost-depends-on-the-whole-suite mistake this repo has now hit
    // twice. The ordering is still genuinely exercised: both rows match the
    // marker, so their relative position is the assertion.
    const marker = `order-${uniq()}`;
    const older = await submission({ minutesAgo: 600, emailMarker: marker });
    const newer = await submission({ minutesAgo: 1, emailMarker: marker });

    const mine = await searchBeatQuoteSubmissionsForStaff({ query: marker });
    expect(mine.rows).toHaveLength(2);
    expect(mine.rows[0]!.submissionReference).toBe(older.submissionReference);
    expect(mine.rows[1]!.submissionReference).toBe(newer.submissionReference);
  });

  it("finds by reference and by email, case-insensitively", async () => {
    const s = await submission();
    const byRef = await searchBeatQuoteSubmissionsForStaff({ query: s.submissionReference.toLowerCase() });
    expect(byRef.rows.map((r) => r.submissionReference)).toContain(s.submissionReference);
    const byEmail = await searchBeatQuoteSubmissionsForStaff({ query: s.email.toUpperCase() });
    expect(byEmail.rows.map((r) => r.submissionReference)).toContain(s.submissionReference);
  });

  it("returns nothing rather than everything for a query that matches nothing", async () => {
    // An empty filter falling through to "all rows" would show a reviewer
    // someone else's submission as though it matched their search.
    const result = await searchBeatQuoteSubmissionsForStaff({ query: `no-such-${uniq()}-xyz` });
    expect(result.rows).toHaveLength(0);
    expect(result.totalCount).toBe(0);
  });

  it("paginates with a stable page size, and totalCount counts MATCHES not the page", async () => {
    const result = await searchBeatQuoteSubmissionsForStaff({ page: 1 });
    expect(result.pageSize).toBe(25);
    expect(result.rows.length).toBeLessThanOrEqual(25);
    // Otherwise "Next" disappears exactly when it is needed.
    expect(result.totalCount).toBeGreaterThanOrEqual(result.rows.length);
  });

  it("filters by status when asked", async () => {
    // Query AND status together, so this looks only at its own row rather
    // than at page 1 of every submission in the shared database.
    const s = await submission();
    const matching = await searchBeatQuoteSubmissionsForStaff({
      query: s.submissionReference,
      status: "submitted",
    });
    expect(matching.rows.map((r) => r.submissionReference)).toEqual([s.submissionReference]);

    const notMatching = await searchBeatQuoteSubmissionsForStaff({
      query: s.submissionReference,
      status: "closed",
    });
    expect(notMatching.rows).toHaveLength(0);
  });
});
