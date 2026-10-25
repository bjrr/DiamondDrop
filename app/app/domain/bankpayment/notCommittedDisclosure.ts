/**
 * The §22 "not committed until payment is verified" disclosure — criteria 84
 * and 85.
 *
 * THE SINGLE SOURCE for the storefront checkout form's disclosure (Liquid, so
 * it needs a locale key). Two copies of material customer terms drift — one
 * gets edited, the other does not — so this is the source, and
 * `notCommittedDisclosure.test.ts` asserts that `theme/locales/en.default.json`'s
 * key is character-for-character identical. Edit one without the other and
 * the test fails.
 *
 * D12/D15 (2026-10-24): Buy Now no longer sends a Shopify draft-order invoice
 * (its "Confirm order" button could commit inventory before verification), so
 * there is no invoice custom message any more. Payment instructions are shown
 * on screen and sent in our own email
 * (`buyNowPaymentInstructionsEmail.ts`), which carries its own owner-approved
 * not-committed sentence.
 *
 * OWNER-APPROVED 2026-09-22, text revised and re-approved 2026-10-24 (D12), and pinned character-for-character in
 * `app/theme/ownerApprovedCopy.test.ts` alongside the cart strings. Criterion
 * 84 is satisfied by this exact wording and nothing else — an edit here is new
 * unapproved copy however small, and it must go back for approval.
 *
 * Two tests guard it from different directions: that file pins the words, and
 * this module's own test proves the STOREFRONT copy is byte-identical to it.
 * Neither alone is enough — identical-but-wrong and approved-but-divergent are
 * both failures a customer would feel.
 */

/** The locale key the storefront reads the identical text from. */
export const NOT_COMMITTED_DISCLOSURE_LOCALE_PATH = [
  "sections",
  "cart",
  "bank_payment_checkout_form",
  "not_committed_disclosure",
] as const;

export const NOT_COMMITTED_DISCLOSURE =
  "Your Bank Payment Price is guaranteed for 24 hours. Submitting this form does not complete your order or reserve your items. Your order is not committed and availability is not guaranteed until your Bank Payment is received and verified. We’ll show you payment instructions here, and we’ll also attempt to email you a copy. Nothing is charged when you submit this form.";

/**
 * REMOVED — `buildInvoiceCustomMessage()` (criterion 85).
 *
 * It existed to put the disclosure into the Shopify-sent draft-order
 * invoice, because `customMessage` was the only place we could put words
 * into an email Shopify composed. Bank Payment no longer sends that invoice
 * at all (register D15), so there is no custom message and nothing to carry
 * it: the disclosure now appears on the checkout form before submission and
 * the full instructions on the CaratForUs confirmation after it.
 *
 * Deliberately deleted rather than left as an unused export — a helper named
 * for a flow that no longer exists is an invitation to reinstate the flow.
 */
