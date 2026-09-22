/**
 * The §22 "not committed until payment is verified" disclosure — criteria 84
 * and 85.
 *
 * THE SINGLE SOURCE FOR TWO SURFACES, and that is the whole point of this
 * module existing rather than the text living where each surface needs it.
 * The same words must appear on the storefront checkout form (Liquid, so it
 * needs a locale key) and in the invoice email Shopify sends on our behalf
 * (server-side, so it needs a string here). Two copies of material customer
 * terms drift — one gets edited, the other does not, and a customer is told
 * two different things about whether their order exists.
 *
 * So this is the source, and `notCommittedDisclosure.test.ts` asserts that
 * `theme/locales/en.default.json`'s key is character-for-character identical.
 * Edit one without the other and the test fails.
 *
 * OWNER-APPROVED 2026-09-22, and pinned character-for-character in
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
  "Your Bank Payment Price is guaranteed for 24 hours. Submitting this form does not complete your order or reserve your items. Your order is not committed and availability is not guaranteed until your Bank Payment is received and verified. We’ll email you an invoice with payment instructions, and nothing is charged when you submit this form.";

/**
 * What rides along with the Shopify-sent invoice (criterion 85).
 *
 * Shopify composes and sends that email; `customMessage` is the only place we
 * can put words into it. So the disclosure travels as the custom message
 * rather than as a separate email of our own — a second email would arrive
 * detached from the invoice it qualifies, which is precisely when a customer
 * would miss it.
 */
export function buildInvoiceCustomMessage(): string {
  return NOT_COMMITTED_DISCLOSURE;
}
