/**
 * The Final Sale disclosure — criterion 143, docs/specs/SLICE-3-LUXURY-STEALS.md
 * §13.1, OWNER-APPROVED 2026-09-23. Reproduced exactly as approved, including
 * the curly apostrophes in "can’t" and "we’ll" and the em dash (U+2014) in
 * the heading line.
 *
 * WHY THIS EXISTS, WHEN 3-5 ALREADY SHIPPED THE COPY. Criterion 143 requires
 * this exact copy be "asserted by a copy test, because this is the exact
 * sentence a well-meaning edit shortens into something untrue" — and until
 * now nothing pinned it. Same discipline as
 * app/domain/bankpayment/notCommittedDisclosure.ts and this slice’s own
 * acknowledgmentText.ts: the constants below are the SOURCE, and
 * disclosureText.test.ts proves theme/locales/en.default.json’s
 * luxury_steals.disclosure keys are byte-identical to them, reading the
 * locale file from disk rather than importing a shared constant — Liquid
 * cannot import a TypeScript module, so the theme’s copy is genuinely a
 * second artefact, and a test that compared this module to itself would pass
 * while the file a customer actually reads said something else entirely.
 *
 * THE CLAIMS PARAGRAPH IS THE ONE THAT MATTERS MOST. docs/LUXURY-STEALS.md is
 * explicit that "Final Sale" must never be presented as ending CaratForUs’s
 * responsibility for a defective, wrong, or not-as-described item. This
 * constant’s third sentence is the entire thing keeping that presentation
 * honest — and it is exactly the sentence a later "tighten up the marketing
 * copy" edit would trim, because shortening it does not look like a bug in
 * review, it looks like an improvement. If this test fails, that is what
 * broke: owner-approved material terms, not a lint rule.
 *
 * TWO DETAILS OF THE OWNER’S WORDING THAT MUST SURVIVE VERBATIM (spec §13.1):
 * the heading states the restriction plainly, and the BODY paragraph is what
 * than stating flatly that the item cannot be returned, and the claims
 * paragraph promises to "review it under the applicable CaratForUs warranty
 * or claims policy" — never a promised remedy before inspection.
 *
 * NO HTML IN THESE CONSTANTS. The theme currently stores all three disclosure
 * keys as plain strings with no markup (unlike
 * luxury_steals.acknowledgment.body_html, which this slice’s
 * acknowledgmentText.ts already governs separately, and which does carry a
 * <strong> tag). disclosureText.test.ts therefore compares these constants to
 * the locale strings directly — but strips HTML tags before comparing
 * regardless, so the fence keeps working unmodified if a later change moves
 * any of these three keys to an "_html" variant with inline markup: the
 * requirement criterion 143 states is that the WORDS cannot change, not that
 * the bolding cannot.
 */

export const FINAL_SALE_BADGE = "Final Sale";

/** Product page disclosure heading (spec §13.1). Scopes the restriction to change-of-mind reasons rather than stating flatly that the item cannot be returned — see this module’s header comment. */
export const FINAL_SALE_DISCLOSURE_HEADING = "Final Sale — this item cannot be returned or exchanged.";

/** Product page disclosure body (spec §13.1). */
export const FINAL_SALE_DISCLOSURE_BODY = "Luxury Steals are limited pieces offered at exceptional prices. Because of that, this item can’t be returned or exchanged if you change your mind, prefer another style, or choose the wrong size or configuration. Please review the specifications and your selected options carefully before ordering.";

/** Product page disclosure claims paragraph (spec §13.1) — the sentence that keeps Final Sale from reading as an end to CaratForUs’s responsibility. Promises a review under the applicable policy, never a remedy before inspection — see this module’s header comment. */
export const FINAL_SALE_DISCLOSURE_CLAIMS = "This does not affect claims for an item that arrives damaged, is not what you ordered, does not match its description, or may have a manufacturing issue covered by our warranty. If something is wrong with your order, contact us and we’ll review it under the applicable CaratForUs warranty or claims policy.";

/**
 * Where the storefront reads the identical text from —
 * `theme/locales/en.default.json`, dot-path form.
 */
export const FINAL_SALE_DISCLOSURE_LOCALE_PATHS = {
  badge: ["luxury_steals", "badge"],
  heading: ["luxury_steals", "disclosure", "heading"],
  body: ["luxury_steals", "disclosure", "body"],
  claims: ["luxury_steals", "disclosure", "claims"],
} as const;
