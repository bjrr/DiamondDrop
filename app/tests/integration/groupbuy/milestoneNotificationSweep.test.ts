import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import type { EmailPort, SendEmailInput } from "~/lib/email/port";
import type { EmailPortResolution } from "~/lib/email/configuredPort.server";
import { runGroupBuyMilestoneSweep } from "~/jobs/groupbuy/milestoneNotificationSweep.server";
import { openGroupBuyCampaign } from "~/jobs/groupbuy/openCampaign.server";
import { closeGroupBuyCampaign, recordUnitEvent } from "~/jobs/groupbuy/unitLedger.server";
import { RecordingGroupBuyParticipantEmailPort } from "~/shopify/admin/groupBuyParticipantEmailAdapter.server";

/**
 * The Group Buy milestone notification sweep against a real database.
 *
 * What cannot be shown in a unit test, and is therefore the point of this
 * file: the idempotency keys are real rows under a real UNIQUE constraint, so
 * "nobody is emailed twice" is proven by the same mechanism that enforces it
 * in production. The Shopify participant lookup is faked
 * (`RecordingGroupBuyParticipantEmailPort`) — the "real DB, faked external
 * API" shape `campaignSettlement.test.ts` already uses.
 *
 * DEDICATED FIXTURES ONLY. Every file in this directory shares one disposable
 * database for the whole run (`fileParallelism: false`), so nothing here
 * mutates a shared row.
 */

const ASOF = new Date("2026-09-28T12:00:00Z");
let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;
let numericSeq = 1;
const nextNumericId = () => `${Date.now()}${(numericSeq += 1)}`;

/** Captures sends instead of making them. */
class CapturingEmailPort implements EmailPort {
  readonly sent: SendEmailInput[] = [];
  failFor: string | null = null;

  async send(input: SendEmailInput) {
    if (this.failFor && input.to.includes(this.failFor)) {
      throw new Error("provider rejected the message");
    }
    this.sent.push(input);
    return { providerMessageId: `msg-${this.sent.length}` };
  }
}

function configuredPort(port: EmailPort): () => EmailPortResolution {
  return () => ({ configured: true, port, from: "orders@caratforus.com", recipients: ["staff@example.com"] });
}

const unconfiguredPort = (): EmailPortResolution => ({ configured: false, reason: "test: deliberately unset" });

async function heaviestVariant() {
  return prisma.masterVariant.findFirstOrThrow({
    where: { status: "active", isLuxurySteal: false },
    orderBy: { baseWeightGrams: "desc" },
  });
}

/** Three tiers, so "tier unlocked" and "best tier unlocked" are distinguishable. */
async function openCampaign() {
  const variant = await heaviestVariant();
  const draft = await prisma.groupBuyCampaign.create({
    data: {
      code: `gb-milestone-${uniq()}`,
      name: "milestone fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: {
        create: [
          { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
          { tierNumber: 2, minQualifyingUnits: 5, priceMultiplier: "0.990000" },
          { tierNumber: 3, minQualifyingUnits: 10, priceMultiplier: "0.980000" },
        ],
      },
      variants: {
        create: [
          {
            masterVariantId: variant.id,
            frozenBaseBankPaymentPriceMinorUnits: 1_000_00n,
            frozenLandedCostMinorUnits: 1n,
          },
        ],
      },
    },
  });
  await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF });
  return { campaignId: draft.id, variantId: variant.id };
}

async function createAcknowledgment() {
  const policy = await prisma.policyVersion.create({
    data: {
      slug: `gb-milestone-ack-${uniq()}`,
      version: 1,
      effectiveFrom: new Date(),
      text: "milestone fixture policy text",
      contentHash: `hash-${uniq()}`,
    },
  });
  return prisma.acknowledgment.create({
    data: {
      exactText: "milestone fixture exact text",
      policyVersionId: policy.id,
      acknowledgedAt: new Date(),
      affirmativeActionLabel: "I Understand & Agree",
    },
  });
}

/** A Bank Payment participant: the local order row AND its matching ledger units. */
async function addBankParticipant(
  campaignId: string,
  variantId: string,
  email: string,
  quantity = 1
): Promise<string> {
  const ack = await createAcknowledgment();
  const orderGid = `gid://shopify/Order/${nextNumericId()}`;
  await prisma.groupBuyBankPaymentOrder.create({
    data: {
      campaignId,
      shopifyDraftOrderGid: `gid://shopify/DraftOrder/${randomUUID()}`,
      shopifyOrderGid: orderGid,
      customerEmail: email,
      customerGid: `gid://shopify/Customer/${nextNumericId()}`,
      tierNumberAtQuote: 1,
      quotedAt: ASOF,
      cancellationAcknowledgmentId: ack.id,
    },
  });
  await addUnits(campaignId, variantId, orderGid, quantity);
  return orderGid;
}

/** A Card participant: ledger units only. Their address lives in Shopify. */
async function addCardParticipant(campaignId: string, variantId: string, quantity = 1): Promise<string> {
  const orderGid = `gid://shopify/Order/${nextNumericId()}`;
  await addUnits(campaignId, variantId, orderGid, quantity);
  return orderGid;
}

async function addUnits(campaignId: string, variantId: string, orderRef: string, quantity: number) {
  await recordUnitEvent({
    campaignId,
    masterVariantId: variantId,
    kind: "purchased",
    quantity,
    orderRef,
    lineRef: `line-${uniq()}`,
    externalRef: `ext-${uniq()}`,
    occurredAt: ASOF,
    recordedBy: "integration-test",
  });
}

const subjectsFor = (port: CapturingEmailPort) => port.sent.map((s) => s.subject);
const recipientsFor = (port: CapturingEmailPort) => port.sent.flatMap((s) => s.to).sort();

describe("which milestone a campaign is at", () => {
  it("sends nothing while the campaign is still on tier 1", async () => {
    // Tier 1 is where every campaign starts. "Unlocked" would be an email
    // about nothing having happened.
    const { campaignId, variantId } = await openCampaign();
    await addBankParticipant(campaignId, variantId, `t1-${uniq()}@example.com`);

    const mail = new CapturingEmailPort();
    await runGroupBuyMilestoneSweep({ resolveEmailPort: configuredPort(mail) });

    expect(mail.sent.filter((s) => s.subject.includes("milestone fixture"))).toHaveLength(0);
    await assertNoMilestoneRowsFor(campaignId);
  });

  it("emails every participant once when a middle tier unlocks", async () => {
    const { campaignId, variantId } = await openCampaign();
    const a = `bank-a-${uniq()}@example.com`;
    const b = `bank-b-${uniq()}@example.com`;
    await addBankParticipant(campaignId, variantId, a, 3);
    await addBankParticipant(campaignId, variantId, b, 2);

    const mail = new CapturingEmailPort();
    const summary = await runGroupBuyMilestoneSweep({ resolveEmailPort: configuredPort(mail) });

    expect(summary.emailsFailed).toBe(0);
    const mine = mail.sent.filter((s) => s.to.some((to) => to === a || to === b));
    expect(mine).toHaveLength(2);
    expect(mine[0]!.subject).toContain("Tier 2");
  });

  it("sends the BEST-tier email, not an ordinary tier email, at the top tier", async () => {
    const { campaignId, variantId } = await openCampaign();
    const email = `best-${uniq()}@example.com`;
    await addBankParticipant(campaignId, variantId, email, 10);

    const mail = new CapturingEmailPort();
    await runGroupBuyMilestoneSweep({ resolveEmailPort: configuredPort(mail) });

    const mine = mail.sent.filter((s) => s.to.includes(email));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).toMatch(/best price/i);
    expect(mine[0]!.text).toMatch(/cannot improve further/);
  });

  it("does NOT backfill a tier the group jumped over", async () => {
    // Units land between sweeps and carry the campaign from tier 1 to tier 3.
    // Tier 2 is never announced — it is not the tier anyone is on.
    const { campaignId, variantId } = await openCampaign();
    const email = `jump-${uniq()}@example.com`;
    await addBankParticipant(campaignId, variantId, email, 10);

    const mail = new CapturingEmailPort();
    await runGroupBuyMilestoneSweep({ resolveEmailPort: configuredPort(mail) });

    const mine = mail.sent.filter((s) => s.to.includes(email));
    expect(mine).toHaveLength(1);
    expect(subjectsFor(mail).join(" ")).not.toContain("Tier 2");
  });

  it("announces a close with the LOCKED final figures", async () => {
    const { campaignId, variantId } = await openCampaign();
    const email = `closed-${uniq()}@example.com`;
    await addBankParticipant(campaignId, variantId, email, 6);
    await closeGroupBuyCampaign({ campaignId, closedBy: "staff", closedAt: ASOF });

    const mail = new CapturingEmailPort();
    await runGroupBuyMilestoneSweep({ resolveEmailPort: configuredPort(mail) });

    const mine = mail.sent.filter((s) => s.to.includes(email));
    expect(mine).toHaveLength(1);
    expect(mine[0]!.subject).toMatch(/has closed/);
    expect(mine[0]!.text).toContain("Final qualifying units: 6");
    expect(mine[0]!.text).toContain("Final tier: 2");
  });

  it("sends the close email even though the tier email already went out", async () => {
    // Different milestone, different key. A participant who heard about tier 2
    // must still hear that the campaign closed.
    const { campaignId, variantId } = await openCampaign();
    const email = `both-${uniq()}@example.com`;
    await addBankParticipant(campaignId, variantId, email, 6);

    const mail = new CapturingEmailPort();
    await runGroupBuyMilestoneSweep({ resolveEmailPort: configuredPort(mail) });
    await closeGroupBuyCampaign({ campaignId, closedBy: "staff", closedAt: ASOF });
    await runGroupBuyMilestoneSweep({ resolveEmailPort: configuredPort(mail) });

    const mine = mail.sent.filter((s) => s.to.includes(email));
    expect(mine).toHaveLength(2);
    expect(mine[0]!.subject).toContain("Tier 2");
    expect(mine[1]!.subject).toMatch(/has closed/);
  });
});

describe("nobody is emailed twice", () => {
  it("re-running the sweep sends nothing further", async () => {
    const { campaignId, variantId } = await openCampaign();
    const email = `once-${uniq()}@example.com`;
    await addBankParticipant(campaignId, variantId, email, 5);

    const mail = new CapturingEmailPort();
    await runGroupBuyMilestoneSweep({ resolveEmailPort: configuredPort(mail) });
    const afterFirst = mail.sent.length;

    await runGroupBuyMilestoneSweep({ resolveEmailPort: configuredPort(mail) });
    await runGroupBuyMilestoneSweep({ resolveEmailPort: configuredPort(mail) });

    expect(mail.sent.length).toBe(afterFirst);
    expect(mail.sent.filter((s) => s.to.includes(email))).toHaveLength(1);
  });

  it("emails a participant who joins AFTER the tier unlocked, without re-emailing the others", async () => {
    const { campaignId, variantId } = await openCampaign();
    const early = `early-${uniq()}@example.com`;
    await addBankParticipant(campaignId, variantId, early, 5);

    const mail = new CapturingEmailPort();
    await runGroupBuyMilestoneSweep({ resolveEmailPort: configuredPort(mail) });

    // Joins while the campaign is still on tier 2, so the milestone is the
    // same one — but this person has not heard it yet.
    const late = `late-${uniq()}@example.com`;
    await addBankParticipant(campaignId, variantId, late, 1);
    await clearCompletionMarkers(campaignId);
    await runGroupBuyMilestoneSweep({ resolveEmailPort: configuredPort(mail) });

    expect(mail.sent.filter((s) => s.to.includes(early))).toHaveLength(1);
    expect(mail.sent.filter((s) => s.to.includes(late))).toHaveLength(1);
  });

  it("treats one address reached by two routes as one recipient", async () => {
    const { campaignId, variantId } = await openCampaign();
    const shared = `shared-${uniq()}@example.com`;
    await addBankParticipant(campaignId, variantId, shared, 3);
    const cardOrder = await addCardParticipant(campaignId, variantId, 2);

    const lookup = new RecordingGroupBuyParticipantEmailPort();
    // Same person, different case — dedupe must be case-insensitive.
    lookup.seed(cardOrder, shared.toUpperCase());

    const mail = new CapturingEmailPort();
    await runGroupBuyMilestoneSweep({
      resolveEmailPort: configuredPort(mail),
      participantEmailLookup: lookup,
    });

    const mine = mail.sent.filter((s) => s.to.some((to) => to.toLowerCase() === shared));
    expect(mine).toHaveLength(1);
  });
});

describe("Card participants, whose addresses live in Shopify", () => {
  it("resolves them through the lookup and emails them", async () => {
    const { campaignId, variantId } = await openCampaign();
    const cardOrder = await addCardParticipant(campaignId, variantId, 5);
    const cardEmail = `card-${uniq()}@example.com`;

    const lookup = new RecordingGroupBuyParticipantEmailPort();
    lookup.seed(cardOrder, cardEmail);

    const mail = new CapturingEmailPort();
    await runGroupBuyMilestoneSweep({
      resolveEmailPort: configuredPort(mail),
      participantEmailLookup: lookup,
    });

    expect(recipientsFor(mail)).toContain(cardEmail);
  });

  it("does not look up a Bank Payment order, whose address is already local", async () => {
    // A Bank Payment order also produces unit events. Without the
    // subtraction, every Bank participant would cost a redundant round-trip.
    const { campaignId, variantId } = await openCampaign();
    const bankOrderGid = await addBankParticipant(campaignId, variantId, `nolookup-${uniq()}@example.com`, 5);

    const lookup = new RecordingGroupBuyParticipantEmailPort();
    await runGroupBuyMilestoneSweep({
      resolveEmailPort: configuredPort(new CapturingEmailPort()),
      participantEmailLookup: lookup,
    });

    expect(lookup.calls).not.toContain(bankOrderGid);
  });

  it("counts a guest order with no email as unresolved rather than silently complete", async () => {
    const { campaignId, variantId } = await openCampaign();
    const guestOrder = await addCardParticipant(campaignId, variantId, 5);

    const lookup = new RecordingGroupBuyParticipantEmailPort();
    lookup.seed(guestOrder, null);

    const summary = await runGroupBuyMilestoneSweep({
      resolveEmailPort: configuredPort(new CapturingEmailPort()),
      participantEmailLookup: lookup,
    });

    expect(summary.recipientsUnresolved).toBeGreaterThanOrEqual(1);
    // Nothing was marked complete, so a later run can still finish the job.
    await assertNoCompletionMarkerFor(campaignId);
  });

  it("keeps going when the lookup throws, and retries the campaign next run", async () => {
    const { campaignId, variantId } = await openCampaign();
    const bankEmail = `survivor-${uniq()}@example.com`;
    await addBankParticipant(campaignId, variantId, bankEmail, 4);
    const brokenOrder = await addCardParticipant(campaignId, variantId, 1);

    const lookup = new RecordingGroupBuyParticipantEmailPort();
    lookup.seedFailure(brokenOrder, new Error("Shopify said no"));

    const mail = new CapturingEmailPort();
    await runGroupBuyMilestoneSweep({
      resolveEmailPort: configuredPort(mail),
      participantEmailLookup: lookup,
    });

    // The reachable participant still heard about it.
    expect(recipientsFor(mail)).toContain(bankEmail);
    await assertNoCompletionMarkerFor(campaignId);

    // Next run, Shopify is healthy: the previously unreachable participant is
    // emailed, and the one who already heard is not emailed again.
    const recovered = `recovered-${uniq()}@example.com`;
    lookup.seed(brokenOrder, recovered);
    await runGroupBuyMilestoneSweep({
      resolveEmailPort: configuredPort(mail),
      participantEmailLookup: lookup,
    });

    expect(mail.sent.filter((s) => s.to.includes(bankEmail))).toHaveLength(1);
    expect(mail.sent.filter((s) => s.to.includes(recovered))).toHaveLength(1);
  });

  it("with no lookup at all, emails Bank participants and withholds completion", async () => {
    const { campaignId, variantId } = await openCampaign();
    const bankEmail = `banked-${uniq()}@example.com`;
    await addBankParticipant(campaignId, variantId, bankEmail, 4);
    await addCardParticipant(campaignId, variantId, 1);

    const mail = new CapturingEmailPort();
    const summary = await runGroupBuyMilestoneSweep({ resolveEmailPort: configuredPort(mail) });

    expect(recipientsFor(mail)).toContain(bankEmail);
    expect(summary.recipientsUnresolved).toBeGreaterThanOrEqual(1);
    await assertNoCompletionMarkerFor(campaignId);
  });
});

describe("failure does not become silence", () => {
  it("records a failed send and does not mark the milestone complete", async () => {
    const { campaignId, variantId } = await openCampaign();
    const good = `good-${uniq()}@example.com`;
    const bad = `bad-${uniq()}@example.com`;
    await addBankParticipant(campaignId, variantId, good, 3);
    await addBankParticipant(campaignId, variantId, bad, 2);

    const mail = new CapturingEmailPort();
    mail.failFor = bad;

    const summary = await runGroupBuyMilestoneSweep({ resolveEmailPort: configuredPort(mail) });

    expect(summary.emailsFailed).toBeGreaterThanOrEqual(1);
    expect(recipientsFor(mail)).toContain(good);
    await assertNoCompletionMarkerFor(campaignId);

    const failed = await prisma.idempotencyKey.findMany({
      where: { key: { startsWith: `groupbuy_milestone:${campaignId}:` }, status: "failed" },
    });
    expect(failed).toHaveLength(1);
  });

  it("sends nothing and marks nothing when email is unconfigured", async () => {
    const { campaignId, variantId } = await openCampaign();
    await addBankParticipant(campaignId, variantId, `unconfigured-${uniq()}@example.com`, 5);

    const summary = await runGroupBuyMilestoneSweep({ resolveEmailPort: unconfiguredPort });

    expect(summary.emailsSent).toBe(0);
    await assertNoMilestoneRowsFor(campaignId);
  });

  it("one campaign's trouble does not stop another's notifications", async () => {
    const healthy = await openCampaign();
    const healthyEmail = `healthy-${uniq()}@example.com`;
    await addBankParticipant(healthy.campaignId, healthy.variantId, healthyEmail, 5);

    const broken = await openCampaign();
    const brokenEmail = `broken-${uniq()}@example.com`;
    await addBankParticipant(broken.campaignId, broken.variantId, brokenEmail, 5);

    const mail = new CapturingEmailPort();
    mail.failFor = brokenEmail;

    await runGroupBuyMilestoneSweep({ resolveEmailPort: configuredPort(mail) });

    expect(recipientsFor(mail)).toContain(healthyEmail);
  });
});

describe("no address is written in plaintext to the idempotency table", () => {
  it("stores a fingerprint, not the email", async () => {
    // CLAUDE.md: minimise PII. An operational bookkeeping table is no place
    // for a customer's address.
    const { campaignId, variantId } = await openCampaign();
    const email = `private-${uniq()}@example.com`;
    await addBankParticipant(campaignId, variantId, email, 5);

    await runGroupBuyMilestoneSweep({ resolveEmailPort: configuredPort(new CapturingEmailPort()) });

    const rows = await prisma.idempotencyKey.findMany({
      where: { key: { startsWith: `groupbuy_milestone:${campaignId}:` } },
    });
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.key).not.toContain(email);
      expect(row.key).not.toContain("@");
      expect(JSON.stringify(row.requestPayload)).not.toContain(email);
    }
  });
});

/** Nothing at all was recorded for this campaign — not even a completion marker. */
async function assertNoMilestoneRowsFor(campaignId: string) {
  const rows = await prisma.idempotencyKey.findMany({
    where: { key: { contains: campaignId } },
  });
  expect(rows).toHaveLength(0);
}

async function assertNoCompletionMarkerFor(campaignId: string) {
  const rows = await prisma.idempotencyKey.findMany({
    where: { key: { startsWith: `groupbuy_milestone_complete:${campaignId}:` } },
  });
  expect(rows).toHaveLength(0);
}

/**
 * Simulates the next milestone-worthy moment for a campaign already marked
 * complete at its current milestone. The sweep intentionally skips a
 * completed milestone — that is the cost guard — so a test about a LATE
 * JOINER has to reopen it, which is exactly what a tier change would do by
 * producing a different milestone key.
 */
async function clearCompletionMarkers(campaignId: string) {
  await prisma.idempotencyKey.deleteMany({
    where: { key: { startsWith: `groupbuy_milestone_complete:${campaignId}:` } },
  });
}
