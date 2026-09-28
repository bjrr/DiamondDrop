import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_LABEL_LOCALE_PATH,
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_LOCALE_PATH,
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG,
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_VERSION,
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_TEXT,
  GROUP_BUY_CANCELLATION_DISCLOSURE_LOCALE_PATH,
  GROUP_BUY_CANCELLATION_DISCLOSURE_TEXT,
} from "./cancellationAcknowledgmentText";

/** Mirrors `notCommittedDisclosure.test.ts`'s identical pattern: reads the theme locale file from disk (a SEPARATE artefact Liquid actually renders) rather than importing a shared constant, since a test comparing a module to itself proves nothing about what the storefront shows. */
function localeString(path: readonly string[]): unknown {
  const locale = JSON.parse(
    readFileSync(join(process.cwd(), "..", "theme", "locales", "en.default.json"), "utf8")
  ) as unknown;
  return path.reduce<unknown>(
    (node, key) => (node && typeof node === "object" ? (node as Record<string, unknown>)[key] : undefined),
    locale
  );
}

/**
 * Pinned character-for-character, same discipline as
 * `rma/acknowledgmentText.test.ts` and `warranty/acknowledgmentText.test.ts`
 * — a well-meaning tidy-up (rewrapping, "fixing" punctuation) must fail this
 * test rather than silently changing what the evidence record says the
 * customer agreed to. The owner wrote both strings below themselves
 * (approved 2026-09-27); compared programmatically against a fresh
 * transcription rather than eyeballed, per the assigning instruction.
 */
describe("Group Buy cancellation acknowledgment — pinned copy", () => {
  it("the disclosure paragraph is exactly the owner-approved text, character-for-character", () => {
    expect(GROUP_BUY_CANCELLATION_DISCLOSURE_TEXT).toBe(
      "Before the campaign closes, you may request a cancellation, but cancellation is not automatic and requires CaratForUs approval. " +
        "Once the campaign closes, your Group Buy order is committed and cannot be canceled or returned because you change your mind. " +
        "This does not affect claims for defects, incorrect items or specifications, shipping damage, warranty issues, fulfillment problems, or other rights required by law."
    );
  });

  it("the required checkbox statement is exactly the owner-approved text, character-for-character", () => {
    expect(GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_TEXT).toBe(
      "I understand that cancellation requests before the campaign closes require CaratForUs approval, and that once the campaign closes my Group Buy order is committed and is not eligible for discretionary cancellation or return."
    );
  });

  it("neither string contains internal newlines", () => {
    expect(GROUP_BUY_CANCELLATION_DISCLOSURE_TEXT).not.toContain("\n");
    expect(GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_TEXT).not.toContain("\n");
  });

  it("the affirmative action label is exactly 'I Understand & Agree' — the Final Sale family's label, NOT 'I Certify & Agree' (RMA/warranty family) by owner choice", () => {
    expect(GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL).toBe("I Understand & Agree");
    expect(GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL).not.toBe("I Certify & Agree");
  });

  it("names a policy slug and a positive integer version for evidence rows to reference", () => {
    expect(GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG).toBe("group-buy-cancellation-acknowledgment");
    expect(Number.isInteger(GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_VERSION)).toBe(true);
    expect(GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_VERSION).toBeGreaterThan(0);
  });
});

/**
 * THE THEME FENCE. `theme/sections/group-buy-campaign.liquid` cannot import
 * this TypeScript module — Liquid reads `theme/locales/en.default.json`
 * instead, which is a genuinely SEPARATE artefact. Mirrors
 * `notCommittedDisclosure.test.ts`'s identical discipline: a test comparing
 * this module to itself would prove nothing about what the storefront
 * actually renders.
 */
describe("Group Buy cancellation acknowledgment — the theme locale is byte-identical to the pinned copy", () => {
  it("the disclosure paragraph", () => {
    expect(localeString(GROUP_BUY_CANCELLATION_DISCLOSURE_LOCALE_PATH)).toBe(GROUP_BUY_CANCELLATION_DISCLOSURE_TEXT);
  });

  it("the required checkbox statement", () => {
    expect(localeString(GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_LOCALE_PATH)).toBe(
      GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_TEXT
    );
  });

  it("the affirmative-action label", () => {
    expect(localeString(GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_LABEL_LOCALE_PATH)).toBe(
      GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL
    );
  });

  it("fails if a key goes missing entirely, not just if it differs", () => {
    expect(localeString([...GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_LOCALE_PATH, "nope"])).toBeUndefined();
    expect(localeString(GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_LOCALE_PATH)).toBeTypeOf("string");
  });
});
