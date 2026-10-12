import { createHmac, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  countOutstandingBringItBack,
  listGroupBuyDemandSignals,
  markGroupBuyDemandSignalsNotified,
  recordGroupBuyDemandSignal,
} from "~/db/repositories/groupBuyDemandSignalRepository.server";
import { createPolicyVersion } from "~/db/repositories/policyVersionRepository.server";
import {
  BRING_IT_BACK_POLICY_SLUG,
  DEMAND_CAPTURE_AFFIRMATIVE_ACTION_LABEL,
} from "~/domain/groupbuy/demandCaptureCopy";
import type { DemandSignalSubmission } from "~/domain/groupbuy/demandSignal";
import { action } from "~/routes/apps.carat.group-buy-interest";

/**
 * Demand capture — "Bring It Back" and "Request a New Group Buy".
 *
 * ============================================================================
 * WHAT ONLY A REAL DATABASE PROVES
 * ============================================================================
 * Three guarantees here are constraints, not code, and a unit test cannot
 * reach them:
 *
 *   1. one person registers ONCE per campaign, under concurrency;
 *   2. the two kinds cannot be stored in each other's shape;
 *   3. a duplicate submission leaves NOTHING behind — not even the
 *      acknowledgment row, which is append-only and could never be cleaned up.
 *
 * (3) is the one most worth having. This is an unauthenticated public
 * endpoint: without the shared transaction, every resubmission would deposit
 * an orphaned evidence row describing a submission that was never stored, with
 * no way to remove it.
 */

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;
const emailFor = (label: string) => `${label}-${uniq()}@example.com`;

function acknowledgmentInput(policyVersionId: string, campaignRef?: string) {
  return {
    exactText: "Tell me if this Group Buy runs again. (test disclosure)",
    policyVersionId,
    acknowledgedAt: new Date(),
    affirmativeActionLabel: "Notify me (test label)",
    ...(campaignRef ? { campaignRef } : {}),
  };
}

/**
 * A policy version to attach acknowledgments to. The TEXT here is a fixture —
 * the real disclosure is an owner decision (see demandCaptureCopy.ts).
 *
 * The version number is a counter rather than a random draw: `(slug, version)`
 * is UNIQUE, so a random number can collide and produce a flaky failure that
 * has nothing to do with what the test is asking.
 */
let policyVersionCounter = 0;
async function policyVersion(slug: string) {
  const text = `test disclosure ${uniq()}`;
  policyVersionCounter += 1;
  return createPolicyVersion({
    slug,
    version: policyVersionCounter,
    effectiveFrom: new Date(),
    text,
    contentHash: createHmac("sha256", "test").update(text).digest("hex"),
  });
}

function bringItBack(email: string, campaignRef: string): DemandSignalSubmission {
  return { kind: "bring_it_back", email, campaignRef, note: null };
}

describe("one person registers once per campaign", () => {
  it("records the first submission", async () => {
    const policy = await policyVersion(BRING_IT_BACK_POLICY_SLUG);
    const email = emailFor("first");
    const campaignRef = `gb-dedup-${uniq()}`;

    const result = await recordGroupBuyDemandSignal({
      submission: bringItBack(email, campaignRef),
      acknowledgment: acknowledgmentInput(policy.id, campaignRef),
    });
    expect(result.outcome).toBe("recorded");
    expect(result.id).not.toBeNull();
  });

  it("treats a REPEAT as already_registered rather than an error", async () => {
    const policy = await policyVersion(BRING_IT_BACK_POLICY_SLUG);
    const email = emailFor("repeat");
    const campaignRef = `gb-dedup-${uniq()}`;
    const submission = bringItBack(email, campaignRef);

    await recordGroupBuyDemandSignal({
      submission,
      acknowledgment: acknowledgmentInput(policy.id, campaignRef),
    });
    const second = await recordGroupBuyDemandSignal({
      submission,
      acknowledgment: acknowledgmentInput(policy.id, campaignRef),
    });

    expect(second.outcome).toBe("already_registered");
    expect(await prisma.groupBuyDemandSignal.count({ where: { email, campaignRef } })).toBe(1);
  });

  it("A DUPLICATE LEAVES NO ORPHANED ACKNOWLEDGMENT — the table is append-only", async () => {
    // THE ASSERTION THIS FILE EXISTS FOR. Without one transaction around both
    // writes, every resubmission against this public endpoint would deposit
    // an evidence row for a submission that was never stored, permanently.
    const policy = await policyVersion(BRING_IT_BACK_POLICY_SLUG);
    const email = emailFor("orphan");
    const campaignRef = `gb-orphan-${uniq()}`;
    const submission = bringItBack(email, campaignRef);

    await recordGroupBuyDemandSignal({
      submission,
      acknowledgment: acknowledgmentInput(policy.id, campaignRef),
    });
    const after = await prisma.acknowledgment.count({ where: { campaignRef } });

    await recordGroupBuyDemandSignal({
      submission,
      acknowledgment: acknowledgmentInput(policy.id, campaignRef),
    });
    await recordGroupBuyDemandSignal({
      submission,
      acknowledgment: acknowledgmentInput(policy.id, campaignRef),
    });

    expect(await prisma.acknowledgment.count({ where: { campaignRef } })).toBe(after);
  });

  it("CONCURRENT submissions of the same address cannot both pass", async () => {
    // Why the unique index is the mechanism rather than a read-then-write:
    // on a public endpoint, simultaneous duplicates are ordinary traffic.
    const policy = await policyVersion(BRING_IT_BACK_POLICY_SLUG);
    const email = emailFor("race");
    const campaignRef = `gb-race-${uniq()}`;
    const submission = bringItBack(email, campaignRef);

    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        recordGroupBuyDemandSignal({
          submission,
          acknowledgment: acknowledgmentInput(policy.id, campaignRef),
        })
      )
    );

    expect(results.filter((r) => r.outcome === "recorded")).toHaveLength(1);
    expect(await prisma.groupBuyDemandSignal.count({ where: { email, campaignRef } })).toBe(1);
  });

  it("the SAME person may register for DIFFERENT campaigns", async () => {
    const policy = await policyVersion(BRING_IT_BACK_POLICY_SLUG);
    const email = emailFor("two-campaigns");
    const a = `gb-a-${uniq()}`;
    const b = `gb-b-${uniq()}`;

    await recordGroupBuyDemandSignal({
      submission: bringItBack(email, a),
      acknowledgment: acknowledgmentInput(policy.id, a),
    });
    const second = await recordGroupBuyDemandSignal({
      submission: bringItBack(email, b),
      acknowledgment: acknowledgmentInput(policy.id, b),
    });
    expect(second.outcome).toBe("recorded");
  });

  it("the dedup index does NOT apply to new-campaign requests — two wishes are two requests", async () => {
    const policy = await policyVersion(BRING_IT_BACK_POLICY_SLUG);
    const email = emailFor("two-wishes");

    for (const note of ["a wider band", "a different stone"]) {
      const result = await recordGroupBuyDemandSignal({
        submission: { kind: "new_campaign_request", email, campaignRef: null, note },
        acknowledgment: acknowledgmentInput(policy.id),
      });
      expect(result.outcome).toBe("recorded");
    }
    expect(await prisma.groupBuyDemandSignal.count({ where: { email } })).toBe(2);
  });
});

describe("the database enforces the shapes, not just the route", () => {
  it("REFUSES a bring-it-back with no campaign", async () => {
    const policy = await policyVersion(BRING_IT_BACK_POLICY_SLUG);
    const ack = await prisma.acknowledgment.create({
      data: {
        exactText: "x",
        policyVersionId: policy.id,
        acknowledgedAt: new Date(),
        affirmativeActionLabel: "y",
      },
    });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO group_buy_demand_signal (id, kind, email, acknowledgment_id)
         VALUES ('${randomUUID()}'::uuid, 'bring_it_back', '${emailFor("nocampaign")}', '${ack.id}'::uuid)`
      )
    ).rejects.toThrow(/group_buy_demand_signal_kind_shape/);
  });

  it("REFUSES a new-campaign request that names a campaign", async () => {
    const policy = await policyVersion(BRING_IT_BACK_POLICY_SLUG);
    const ack = await prisma.acknowledgment.create({
      data: {
        exactText: "x",
        policyVersionId: policy.id,
        acknowledgedAt: new Date(),
        affirmativeActionLabel: "y",
      },
    });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO group_buy_demand_signal (id, kind, email, campaign_ref, note, acknowledgment_id)
         VALUES ('${randomUUID()}'::uuid, 'new_campaign_request', '${emailFor("named")}', 'gb-x', 'note', '${ack.id}'::uuid)`
      )
    ).rejects.toThrow(/group_buy_demand_signal_kind_shape/);
  });

  it("REFUSES an unnormalised email — the dedup index depends on it", async () => {
    const policy = await policyVersion(BRING_IT_BACK_POLICY_SLUG);
    const ack = await prisma.acknowledgment.create({
      data: {
        exactText: "x",
        policyVersionId: policy.id,
        acknowledgedAt: new Date(),
        affirmativeActionLabel: "y",
      },
    });
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO group_buy_demand_signal (id, kind, email, campaign_ref, acknowledgment_id)
         VALUES ('${randomUUID()}'::uuid, 'bring_it_back', 'Ada@Example.com', 'gb-x', '${ack.id}'::uuid)`
      )
    ).rejects.toThrow(/group_buy_demand_signal_email_normalised/);
  });
});

describe("the staff view", () => {
  it("lists outstanding signals for a campaign and counts them", async () => {
    const policy = await policyVersion(BRING_IT_BACK_POLICY_SLUG);
    const campaignRef = `gb-staff-${uniq()}`;
    const emails = [emailFor("s1"), emailFor("s2"), emailFor("s3")];
    for (const email of emails) {
      await recordGroupBuyDemandSignal({
        submission: bringItBack(email, campaignRef),
        acknowledgment: acknowledgmentInput(policy.id, campaignRef),
      });
    }

    expect(await countOutstandingBringItBack(campaignRef)).toBe(3);
    const listed = await listGroupBuyDemandSignals({ campaignRef, outstandingOnly: true });
    expect(listed).toHaveLength(3);
  });

  it("marking notified is idempotent — nobody is told twice", async () => {
    const policy = await policyVersion(BRING_IT_BACK_POLICY_SLUG);
    const campaignRef = `gb-notify-${uniq()}`;
    const recorded = await recordGroupBuyDemandSignal({
      submission: bringItBack(emailFor("n1"), campaignRef),
      acknowledgment: acknowledgmentInput(policy.id, campaignRef),
    });

    const ids = [recorded.id!];
    expect(await markGroupBuyDemandSignalsNotified({ ids, notifiedBy: "staff:ada" })).toBe(1);
    // A RE-RUN AFTER A PARTIAL FAILURE transitions nobody again.
    expect(await markGroupBuyDemandSignalsNotified({ ids, notifiedBy: "staff:ada" })).toBe(0);
    expect(await countOutstandingBringItBack(campaignRef)).toBe(0);
  });

  it("REFUSES to mark notified with no acting staff identity", async () => {
    await expect(
      markGroupBuyDemandSignalsNotified({ ids: [randomUUID()], notifiedBy: "  " })
    ).rejects.toThrow(/acting staff identity/);
  });
});

describe("the public intake route", () => {
  function signed(params: Record<string, string>): URL {
    const secret = process.env.SHOPIFY_API_SECRET as string;
    const message = Object.entries(params)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${k}=${v}`)
      .join("");
    const signature = createHmac("sha256", secret).update(message, "utf8").digest("hex");
    const url = new URL("https://shop.example.com/apps/carat/group-buy-interest");
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    url.searchParams.set("signature", signature);
    return url;
  }

  function post(body: Record<string, string>, options?: { unsigned?: boolean }) {
    const url = options?.unsigned
      ? new URL("https://shop.example.com/apps/carat/group-buy-interest")
      : signed({ shop: "caratforus-dev.myshopify.com" });
    const form = new FormData();
    for (const [k, v] of Object.entries(body)) form.set(k, v);
    return action({
      request: new Request(url, { method: "POST", body: form }),
      params: {},
      context: {},
    } as unknown as Parameters<typeof action>[0]);
  }

  it("REJECTS an unsigned request", async () => {
    const response = await post({ kind: "bring_it_back", email: "ada@example.com", campaignRef: "gb-x" }, { unsigned: true });
    expect(response.status).toBe(401);
  });

  it("REJECTS a GET", async () => {
    // There is no read endpoint on purpose — see the route header.
    const response = await action({
      request: new Request(signed({ shop: "caratforus-dev.myshopify.com" })),
      params: {},
      context: {},
    } as unknown as Parameters<typeof action>[0]);
    expect(response.status).toBe(405);
  });

  it("reports validation problems by name", async () => {
    const response = await post({ kind: "bring_it_back", email: "nope" });
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; problems: string[] };
    expect(body.error).toBe("invalid_submission");
    expect(body.problems).toContain("email_malformed");
    expect(body.problems).toContain("campaign_required");
  });

  it("FAILS CLOSED while the customer-facing copy is unapproved", async () => {
    // The label is `null` until the owner decides it (demandCaptureCopy.ts),
    // so a well-formed submission is refused rather than captured against
    // words nobody approved. When the label and policy row exist this test
    // changes to assert a 200 — deliberately, as part of that decision.
    expect(DEMAND_CAPTURE_AFFIRMATIVE_ACTION_LABEL).toBeNull();

    const response = await post({
      kind: "bring_it_back",
      email: emailFor("pending"),
      campaignRef: `gb-pending-${uniq()}`,
    });
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("copy_pending_approval");
  });

  it("captures NOTHING while copy is pending", async () => {
    const campaignRef = `gb-nothing-${uniq()}`;
    await post({ kind: "bring_it_back", email: emailFor("nothing"), campaignRef });
    expect(await prisma.groupBuyDemandSignal.count({ where: { campaignRef } })).toBe(0);
    expect(await prisma.acknowledgment.count({ where: { campaignRef } })).toBe(0);
  });

  it("validates BEFORE the copy gate, so a malformed submission still gets a useful answer", async () => {
    // A 503 for a malformed submission would tell the customer to come back
    // later about a problem that is theirs to fix.
    const response = await post({ kind: "bring_it_back", email: "nope" });
    expect(response.status).toBe(400);
  });
});
