import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT,
  CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG,
  CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_VERSION,
} from "~/domain/customjewelry/finalApprovalCopy";

/**
 * Both versions of the final approval acknowledgment, in the database.
 *
 * ============================================================================
 * THE PROPERTY THE WHOLE VERSIONING MECHANISM RESTS ON
 * ============================================================================
 * When the owner reworded the acknowledgment, version 2 was added and version
 * 1 was NOT edited. That is not a nicety: an `acknowledgment` row references
 * the `policy_version` it was shown under, and every approval package records
 * `approval_acknowledgment_policy_version`. Editing version 1 would
 * retroactively change what existing evidence claims a customer agreed to — on
 * a purchase that is final sale and cannot be returned.
 *
 * `policy_version` is append-only by trigger, so an edit is impossible rather
 * than merely discouraged. These tests assert the OUTCOME anyway, because the
 * thing worth protecting is "v1 still says what it said", not "a trigger
 * exists".
 */

const V1_TEXT =
  "I have reviewed and approve the design, specifications, materials, dimensions and size where applicable, and " +
  "engraving where applicable, exactly as displayed on this page. " +
  "I approve the final price shown and the credit of my $49 Design Deposit against it, and I understand I am paying " +
  "the remaining balance. " +
  "I understand that once my final design and specifications are approved and the jewelry is purchased, my order is " +
  "final sale except for covered defects, incorrect specifications, shipping damage, or material failure to match the " +
  "approved design and specifications.";

describe("the acknowledgment's version history", () => {
  it("has BOTH versions provisioned", async () => {
    const rows = await prisma.policyVersion.findMany({
      where: { slug: CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG },
      orderBy: { version: "asc" },
      select: { version: true },
    });
    expect(rows.map((r) => r.version)).toEqual([1, 2]);
  });

  it("VERSION 1 still says exactly what it said", async () => {
    // The regression that would matter most: a v2 migration that edited v1
    // instead of inserting beside it. Asserted against a literal copy of the
    // original text, deliberately NOT against the constant — the constant is
    // now v2, so comparing to it would assert nothing.
    const v1 = await prisma.policyVersion.findFirstOrThrow({
      where: { slug: CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG, version: 1 },
    });
    expect(v1.text).toBe(V1_TEXT);
    expect(v1.text).toContain("I understand I am paying the remaining balance");
  });

  it("VERSION 2 is the current constant, byte for byte", async () => {
    const v2 = await prisma.policyVersion.findFirstOrThrow({
      where: {
        slug: CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG,
        version: CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_VERSION,
      },
    });
    expect(v2.version).toBe(2);
    expect(v2.text).toBe(CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT);
  });

  it("the two versions genuinely differ", async () => {
    // A v2 row identical to v1 would be a migration that shipped without the
    // wording change it exists for.
    const rows = await prisma.policyVersion.findMany({
      where: { slug: CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG },
      orderBy: { version: "asc" },
      select: { text: true, contentHash: true },
    });
    expect(rows[0]!.text).not.toBe(rows[1]!.text);
    expect(rows[0]!.contentHash).not.toBe(rows[1]!.contentHash);
  });

  it("the DATABASE refuses editing version 1", async () => {
    // Append-only, by trigger. The thing that makes "we never rewrite history"
    // a fact rather than a convention.
    await expect(
      prisma.$executeRaw`UPDATE "policy_version" SET "text" = 'rewritten' WHERE "slug" = ${CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG} AND "version" = 1`
    ).rejects.toThrow(/append-only/i);
  });

  it("a NEW approval is recorded against version 2", async () => {
    // `getLatestPolicyVersion` returns the highest version, so approvals from
    // now on carry v2 while existing ones keep v1.
    const { getLatestPolicyVersion } = await import("~/db/repositories/policyVersionRepository.server");
    const latest = await getLatestPolicyVersion(CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG);
    expect(latest?.version).toBe(2);
    expect(latest?.text).toBe(CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT);
  });
});
