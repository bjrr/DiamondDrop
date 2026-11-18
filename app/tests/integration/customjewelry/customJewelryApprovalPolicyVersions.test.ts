import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT,
  CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG,
  CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_VERSION,
} from "~/domain/customjewelry/finalApprovalCopy";

/**
 * Every version of the final approval acknowledgment, in the database.
 *
 * ============================================================================
 * THE PROPERTY THE WHOLE VERSIONING MECHANISM RESTS ON
 * ============================================================================
 * Each time the owner reworded the acknowledgment, a new version was ADDED and
 * the earlier ones were NOT edited. That is not a nicety: an `acknowledgment`
 * row references the `policy_version` it was shown under, and every approval
 * package records `approval_acknowledgment_policy_version`. Editing an old
 * version would retroactively change what existing evidence claims a customer
 * agreed to — on a purchase that is final sale and cannot be returned.
 *
 * `policy_version` is append-only by trigger, so an edit is impossible rather
 * than merely discouraged. These tests assert the OUTCOME anyway, because the
 * thing worth protecting is "v1 still says what it said", not "a trigger
 * exists".
 *
 * ============================================================================
 * EACH SUPERSEDED VERSION IS PINNED TO A LITERAL, NOT TO THE CONSTANT
 * ============================================================================
 * The constant always holds the CURRENT text, so comparing an old version to
 * it asserts nothing. v1 was already pinned to a literal for that reason; v3
 * (owner decision 2026-11-18, the shipping sentence) moved the constant on
 * again, so **v2 is now pinned to a literal too**.
 *
 * That is the step that is easy to skip and expensive to skip. Without it, the
 * only assertion about v2 would be "it differs from v1" — which a migration
 * that silently rewrote v2 would still satisfy. Every version that is no
 * longer the constant gets its own frozen copy here, and a v4 must add one for
 * v3.
 */

const V1_TEXT =
  "I have reviewed and approve the design, specifications, materials, dimensions and size where applicable, and " +
  "engraving where applicable, exactly as displayed on this page. " +
  "I approve the final price shown and the credit of my $49 Design Deposit against it, and I understand I am paying " +
  "the remaining balance. " +
  "I understand that once my final design and specifications are approved and the jewelry is purchased, my order is " +
  "final sale except for covered defects, incorrect specifications, shipping damage, or material failure to match the " +
  "approved design and specifications.";

/** Superseded by v3 on 2026-11-18. Frozen here the moment it stopped being the constant. */
const V2_TEXT =
  "I have reviewed and approve the design, specifications, materials, dimensions and size where applicable, and " +
  "engraving where applicable, exactly as displayed on this page. " +
  "I approve the final price shown and the $49 Design Deposit credit applied to it, and I understand the amount " +
  "due is the remaining balance after that credit. " +
  "I understand that once my final design and specifications are approved and the jewelry is purchased, my order is " +
  "final sale except for covered defects, incorrect specifications, shipping damage, or material failure to match the " +
  "approved design and specifications.";

describe("the acknowledgment's version history", () => {
  it("has ALL THREE versions provisioned", async () => {
    const rows = await prisma.policyVersion.findMany({
      where: { slug: CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG },
      orderBy: { version: "asc" },
      select: { version: true },
    });
    expect(rows.map((r) => r.version)).toEqual([1, 2, 3]);
  });

  it("VERSION 1 still says exactly what it said", async () => {
    // The regression that would matter most: a later migration that edited an
    // existing version instead of inserting beside it.
    const v1 = await prisma.policyVersion.findFirstOrThrow({
      where: { slug: CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG, version: 1 },
    });
    expect(v1.text).toBe(V1_TEXT);
    expect(v1.text).toContain("I understand I am paying the remaining balance");
    // v1 predates the shipping decision and must not have acquired it.
    expect(v1.text).not.toContain("shipping is calculated separately");
  });

  it("VERSION 2 still says exactly what it said", async () => {
    const v2 = await prisma.policyVersion.findFirstOrThrow({
      where: { slug: CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG, version: 2 },
    });
    expect(v2.text).toBe(V2_TEXT);
    expect(v2.text).toContain("the amount due is the remaining balance after that credit");
    // Same guarantee as for v1: the 2026-11-18 sentence belongs to v3 alone.
    expect(v2.text).not.toContain("shipping is calculated separately");
  });

  it("VERSION 3 is the current constant, byte for byte", async () => {
    const current = await prisma.policyVersion.findFirstOrThrow({
      where: {
        slug: CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG,
        version: CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_VERSION,
      },
    });
    expect(current.version).toBe(3);
    expect(current.text).toBe(CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT);
  });

  it("VERSION 3 added the shipping sentence and changed nothing else", async () => {
    // THE SUBSTANCE OF THE 2026-11-18 DECISION, and the reason it does not
    // weaken the acknowledgment: it is strictly additive. v2's three sentences
    // survive verbatim, so v3 is v2 with one sentence inserted.
    const v3 = await prisma.policyVersion.findFirstOrThrow({
      where: { slug: CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG, version: 3 },
    });

    expect(v3.text).toContain(
      "I understand the approved price is the price of the jewelry itself, and that shipping is calculated " +
        "separately under the CaratForUs Shipping Policy and shown to me before I pay."
    );

    // Every sentence v2 certified is still certified. Checked individually so
    // a failure names which clause went missing.
    for (const clause of [
      "I have reviewed and approve the design, specifications, materials, dimensions and size where applicable",
      "I approve the final price shown and the $49 Design Deposit credit applied to it",
      "the amount due is the remaining balance after that credit",
      "my order is final sale except for covered defects, incorrect specifications, shipping damage, or material " +
        "failure to match the approved design and specifications",
    ]) {
      expect(v3.text).toContain(clause);
    }

    // And nothing was traded for it. These are the categories an
    // acknowledgment must never quietly acquire.
    for (const forbidden of ["waive", "not liable", "no liability", "as amended", "agree to any delay"]) {
      expect(v3.text.toLowerCase()).not.toContain(forbidden);
    }
  });

  it("every version genuinely differs from every other", async () => {
    // A new row identical to its predecessor would be a migration that
    // shipped without the wording change it exists for.
    const rows = await prisma.policyVersion.findMany({
      where: { slug: CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG },
      orderBy: { version: "asc" },
      select: { version: true, text: true, contentHash: true },
    });
    expect(new Set(rows.map((r) => r.text)).size).toBe(rows.length);
    expect(new Set(rows.map((r) => r.contentHash)).size).toBe(rows.length);
  });

  it("the DATABASE refuses editing version 1", async () => {
    // Append-only, by trigger. The thing that makes "we never rewrite history"
    // a fact rather than a convention.
    await expect(
      prisma.$executeRaw`UPDATE "policy_version" SET "text" = 'rewritten' WHERE "slug" = ${CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG} AND "version" = 1`
    ).rejects.toThrow(/append-only/i);
  });

  it("the DATABASE refuses editing version 2 as well", async () => {
    // v2 is now history too, and history is protected by the same trigger
    // rather than by it happening to be the oldest row.
    await expect(
      prisma.$executeRaw`UPDATE "policy_version" SET "text" = 'rewritten' WHERE "slug" = ${CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG} AND "version" = 2`
    ).rejects.toThrow(/append-only/i);
  });

  it("a NEW approval is recorded against version 3", async () => {
    // `getLatestPolicyVersion` returns the highest version, so approvals from
    // now on carry v3 while existing ones keep v1 or v2.
    const { getLatestPolicyVersion } = await import("~/db/repositories/policyVersionRepository.server");
    const latest = await getLatestPolicyVersion(CUSTOM_JEWELRY_FINAL_APPROVAL_POLICY_SLUG);
    expect(latest?.version).toBe(3);
    expect(latest?.text).toBe(CUSTOM_JEWELRY_FINAL_APPROVAL_ACKNOWLEDGMENT_TEXT);
  });
});
