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
  BRING_IT_BACK_AFFIRMATIVE_ACTION_LABEL,
  BRING_IT_BACK_DISCLOSURE_TEXT,
  BRING_IT_BACK_POLICY_SLUG,
  DEMAND_CAPTURE_CONFIRMATION_TEXT,
  NEW_CAMPAIGN_REQUEST_AFFIRMATIVE_ACTION_LABEL,
  NEW_CAMPAIGN_REQUEST_POLICY_SLUG,
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
 * A policy version for the REPOSITORY-level tests to attach acknowledgments
 * to. Those tests do not care what the disclosure says — only that the FK is
 * satisfiable — so this deliberately uses its own slug.
 *
 * IT MUST NOT USE A REAL SLUG. The provisioning migration inserts version 1
 * of both real disclosures, and `getLatestPolicyVersion` returns the HIGHEST
 * version for a slug: a fixture writing version 2 under the real slug would
 * both collide with the migration on version 1 and then SHADOW the approved
 * text for every route test in this file, which would pass while asserting a
 * fixture string instead of the words the owner approved.
 *
 * The version is a counter rather than a random draw, because (slug, version)
 * is UNIQUE and a collision would be a flaky failure about nothing.
 */
const FIXTURE_POLICY_SLUG = "zz-test-demand-capture-fixture";
let policyVersionCounter = 0;
async function policyVersion() {
  const text = `test disclosure ${uniq()}`;
  policyVersionCounter += 1;
  return createPolicyVersion({
    slug: FIXTURE_POLICY_SLUG,
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
    const policy = await policyVersion();
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
    const policy = await policyVersion();
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
    const policy = await policyVersion();
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
    const policy = await policyVersion();
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
    const policy = await policyVersion();
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
    const policy = await policyVersion();
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
    const policy = await policyVersion();
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
    const policy = await policyVersion();
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
    const policy = await policyVersion();
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
    const policy = await policyVersion();
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
    const policy = await policyVersion();
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

  it("CAPTURES a well-formed bring-it-back, now that the copy is approved", async () => {
    const campaignRef = `gb-live-${uniq()}`;
    const email = emailFor("live");
    const response = await post({ kind: "bring_it_back", email, campaignRef });

    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; message: string };
    expect(body.ok).toBe(true);
    expect(body.message).toBe(DEMAND_CAPTURE_CONFIRMATION_TEXT);

    const row = await prisma.groupBuyDemandSignal.findFirstOrThrow({ where: { email, campaignRef } });
    expect(row.kind).toBe("bring_it_back");
  });

  it("records the EXACT disclosure and the EXACT button caption as evidence", async () => {
    // The acknowledgment must name words the customer actually saw. The text
    // comes from the versioned row (so a later revision does not restate what
    // this person was told) and the caption from the copy module.
    const campaignRef = `gb-evidence-${uniq()}`;
    await post({ kind: "bring_it_back", email: emailFor("evidence"), campaignRef });

    const ack = await prisma.acknowledgment.findFirstOrThrow({
      where: { campaignRef },
      include: { policyVersion: true },
    });
    expect(ack.policyVersion.slug).toBe(BRING_IT_BACK_POLICY_SLUG);
    expect(ack.exactText).toBe(ack.policyVersion.text);
    expect(ack.exactText).toBe(BRING_IT_BACK_DISCLOSURE_TEXT);
    expect(ack.affirmativeActionLabel).toBe(BRING_IT_BACK_AFFIRMATIVE_ACTION_LABEL);
  });

  it("uses the OTHER kind's label and disclosure for a new-campaign request", async () => {
    // A caption vague enough to cover both forms is the wording a customer
    // later says they did not understand.
    const email = emailFor("wish");
    await post({ kind: "new_campaign_request", email, note: "a wider band in platinum" });

    const row = await prisma.groupBuyDemandSignal.findFirstOrThrow({ where: { email } });
    const ack = await prisma.acknowledgment.findFirstOrThrow({
      where: { id: row.acknowledgmentId },
      include: { policyVersion: true },
    });
    expect(ack.policyVersion.slug).toBe(NEW_CAMPAIGN_REQUEST_POLICY_SLUG);
    expect(ack.affirmativeActionLabel).toBe(NEW_CAMPAIGN_REQUEST_AFFIRMATIVE_ACTION_LABEL);
  });

  it("answers a REPEAT identically — no oracle for whether an address is on file", async () => {
    const campaignRef = `gb-oracle-${uniq()}`;
    const email = emailFor("oracle");
    const first = await post({ kind: "bring_it_back", email, campaignRef });
    const second = await post({ kind: "bring_it_back", email, campaignRef });

    expect(second.status).toBe(first.status);
    expect(await second.text()).toBe(await first.text());
    // And still only one row, with one acknowledgment.
    expect(await prisma.groupBuyDemandSignal.count({ where: { email, campaignRef } })).toBe(1);
    expect(await prisma.acknowledgment.count({ where: { campaignRef } })).toBe(1);
  });

  it("the approved copy promises no return, no date and no price", async () => {
    // The misunderstanding most available to a reader, now that the public
    // archive states each closed campaign's final price plainly.
    expect(BRING_IT_BACK_DISCLOSURE_TEXT).toMatch(/can't promise it will/i);
    expect(BRING_IT_BACK_DISCLOSURE_TEXT).toMatch(/priced from costs at the time it opens/i);
    expect(BRING_IT_BACK_DISCLOSURE_TEXT).not.toMatch(/same price|will return|guarantee/i);
  });

  it("still FAILS CLOSED if the policy row is missing from this environment", async () => {
    // Proven by asking for a kind whose slug has no row rather than by
    // deleting one — policy_version is append-only, and a test that could
    // remove a disclosure would be a worse thing to own than this gap.
    const { getLatestPolicyVersion } = await import("~/db/repositories/policyVersionRepository.server");
    expect(await getLatestPolicyVersion("group-buy-no-such-disclosure")).toBeNull();
  });

  it("validates BEFORE the copy gate, so a malformed submission still gets a useful answer", async () => {
    // A 503 for a malformed submission would tell the customer to come back
    // later about a problem that is theirs to fix.
    const response = await post({ kind: "bring_it_back", email: "nope" });
    expect(response.status).toBe(400);
  });
});
