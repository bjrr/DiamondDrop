import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  FIRST_ACCESS_CONSENT_AFFIRMATIVE_ACTION_LABEL,
  FIRST_ACCESS_EMAIL_CONSENT_POLICY_SLUG,
  FIRST_ACCESS_EMAIL_CONSENT_TEXT,
  FIRST_ACCESS_SMS_CONSENT_POLICY_SLUG,
  FIRST_ACCESS_SMS_CONSENT_TEXT,
} from "~/domain/firstaccess/marketingConsentCopy";
import { recordMarketingConsentEvidence } from "~/domain/firstaccess/marketingConsentEvidence.server";

/**
 * Our own proof of HOW a marketing permission was obtained, against a real
 * database and the real seeded policy rows.
 *
 * ============================================================================
 * WHAT THIS IS AND IS NOT
 * ============================================================================
 * Shopify holds the PERMISSION — it is what a sending platform reads and what
 * a STOP reply unsubscribes. This holds the PROOF: the exact sentence the
 * customer was shown, which version of it, when, and who. Shopify's consent
 * object has no field for the wording, and for a marketing permission that is
 * the part most worth being able to produce later.
 */

let seq = 0;
const customerRef = () => `gid://shopify/Customer/evid-${Date.now() % 900_000}-${++seq}`;

describe("marketing consent evidence", () => {
  it("records the EMAIL consent against the seeded policy, with the policy's own text", async () => {
    const ref = customerRef();
    const at = new Date("2026-11-18T12:00:00.000Z");

    const result = await recordMarketingConsentEvidence({
      channel: "email",
      customerRef: ref,
      consentedAt: at,
      sourceIp: "203.0.113.7",
      userAgent: "Mozilla/5.0 (test)",
    });

    expect(result.outcome).toBe("recorded");
    if (result.outcome !== "recorded") return;

    const row = await prisma.acknowledgment.findUniqueOrThrow({
      where: { id: result.acknowledgmentId },
      include: { policyVersion: true },
    });

    // THE WORDING COMES FROM THE POLICY ROW, not from the request and not from
    // the module constant — so the row and the version it points at can never
    // disagree, which is the one way this record could mislead.
    expect(row.exactText).toBe(FIRST_ACCESS_EMAIL_CONSENT_TEXT);
    expect(row.policyVersion.slug).toBe(FIRST_ACCESS_EMAIL_CONSENT_POLICY_SLUG);
    expect(row.policyVersion.text).toBe(row.exactText);

    expect(row.acknowledgedAt.toISOString()).toBe(at.toISOString());
    expect(row.affirmativeActionLabel).toBe(FIRST_ACCESS_CONSENT_AFFIRMATIVE_ACTION_LABEL);
    expect(row.customerRef).toBe(ref);
    expect(row.sourceIp).toBe("203.0.113.7");
    expect(row.userAgent).toBe("Mozilla/5.0 (test)");
  });

  it("records the SMS consent against a DIFFERENT policy, with its own wording", async () => {
    const ref = customerRef();
    const result = await recordMarketingConsentEvidence({
      channel: "sms",
      customerRef: ref,
      consentedAt: new Date("2026-11-18T12:00:00.000Z"),
    });

    expect(result.outcome).toBe("recorded");
    if (result.outcome !== "recorded") return;

    const row = await prisma.acknowledgment.findUniqueOrThrow({
      where: { id: result.acknowledgmentId },
      include: { policyVersion: true },
    });
    expect(row.policyVersion.slug).toBe(FIRST_ACCESS_SMS_CONSENT_POLICY_SLUG);
    expect(row.exactText).toBe(FIRST_ACCESS_SMS_CONSENT_TEXT);
    // The SMS sentence carries disclosures the email one does not, and this is
    // the record that proves the customer saw them.
    expect(row.exactText).toContain("Reply STOP to unsubscribe");
    expect(row.exactText).toContain("Msg & data rates may apply");
  });

  it("keeps the two channels INDEPENDENT for one customer", async () => {
    // The property the whole design rests on: holding one permission is not
    // holding the other, and the evidence has to be able to say so.
    const ref = customerRef();
    const at = new Date("2026-11-18T12:00:00.000Z");

    const emailOnly = await recordMarketingConsentEvidence({ channel: "email", customerRef: ref, consentedAt: at });
    expect(emailOnly.outcome).toBe("recorded");

    const rows = await prisma.acknowledgment.findMany({
      where: { customerRef: ref },
      include: { policyVersion: true },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.policyVersion.slug).toBe(FIRST_ACCESS_EMAIL_CONSENT_POLICY_SLUG);

    // Adding SMS later does not disturb the email record.
    const sms = await recordMarketingConsentEvidence({ channel: "sms", customerRef: ref, consentedAt: at });
    expect(sms.outcome).toBe("recorded");

    const both = await prisma.acknowledgment.findMany({
      where: { customerRef: ref },
      include: { policyVersion: true },
    });
    expect(both.map((r) => r.policyVersion.slug).sort()).toEqual(
      [FIRST_ACCESS_EMAIL_CONSENT_POLICY_SLUG, FIRST_ACCESS_SMS_CONSENT_POLICY_SLUG].sort()
    );
  });

  it("is idempotent per customer per channel, so a resubmit does not pile up records", async () => {
    // The theme re-sends on a reload-handoff path and a customer can submit
    // twice. Three rows for one consent is harder to read than one: an auditor
    // cannot tell three records of one consent from one person consenting
    // three times.
    const ref = customerRef();
    const at = new Date("2026-11-18T12:00:00.000Z");

    const first = await recordMarketingConsentEvidence({ channel: "email", customerRef: ref, consentedAt: at });
    const second = await recordMarketingConsentEvidence({ channel: "email", customerRef: ref, consentedAt: new Date() });
    const third = await recordMarketingConsentEvidence({ channel: "email", customerRef: ref, consentedAt: new Date() });

    expect(first.outcome).toBe("recorded");
    expect(second.outcome).toBe("already_recorded");
    expect(third.outcome).toBe("already_recorded");
    if (first.outcome !== "recorded" || second.outcome !== "already_recorded") return;
    // The SAME row, so the original timestamp survives the resubmit rather
    // than being quietly moved forward.
    expect(second.acknowledgmentId).toBe(first.acknowledgmentId);

    const rows = await prisma.acknowledgment.findMany({ where: { customerRef: ref } });
    expect(rows).toHaveLength(1);
    expect(rows[0]!.acknowledgedAt.toISOString()).toBe(at.toISOString());
  });

  it("does not let one customer's consent satisfy another's", async () => {
    const a = customerRef();
    const b = customerRef();
    const at = new Date("2026-11-18T12:00:00.000Z");

    await recordMarketingConsentEvidence({ channel: "email", customerRef: a, consentedAt: at });
    const forB = await recordMarketingConsentEvidence({ channel: "email", customerRef: b, consentedAt: at });

    expect(forB.outcome).toBe("recorded");
    expect(await prisma.acknowledgment.count({ where: { customerRef: a } })).toBe(1);
    expect(await prisma.acknowledgment.count({ where: { customerRef: b } })).toBe(1);
  });

  it("points at the LATEST version of the policy", async () => {
    // A future rewording adds version 2; new consents must attach to it while
    // existing rows keep pointing at the version they were shown under.
    const ref = customerRef();
    const result = await recordMarketingConsentEvidence({
      channel: "email",
      customerRef: ref,
      consentedAt: new Date("2026-11-18T12:00:00.000Z"),
    });
    expect(result.outcome).toBe("recorded");
    if (result.outcome !== "recorded") return;

    const latest = await prisma.policyVersion.findFirstOrThrow({
      where: { slug: FIRST_ACCESS_EMAIL_CONSENT_POLICY_SLUG },
      orderBy: { version: "desc" },
    });
    expect(result.policyVersion).toBe(latest.version);
  });

  it("stores a content hash that matches the stored text", async () => {
    // Pinned here as well as in the migration fence, because this is the row
    // an audit would actually be shown.
    const { createHash } = await import("node:crypto");
    for (const slug of [FIRST_ACCESS_EMAIL_CONSENT_POLICY_SLUG, FIRST_ACCESS_SMS_CONSENT_POLICY_SLUG]) {
      const policy = await prisma.policyVersion.findFirstOrThrow({
        where: { slug },
        orderBy: { version: "desc" },
      });
      expect(policy.contentHash).toBe(createHash("sha256").update(policy.text, "utf8").digest("hex"));
    }
  });

  it("the policy rows are append-only, so a consent cannot be retroactively reworded", async () => {
    // The guarantee the whole evidence trail rests on.
    await expect(
      prisma.$executeRaw`UPDATE "policy_version" SET "text" = 'rewritten' WHERE "slug" = ${FIRST_ACCESS_SMS_CONSENT_POLICY_SLUG}`
    ).rejects.toThrow(/append-only/i);
  });
});
