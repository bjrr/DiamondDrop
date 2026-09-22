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
 * DRAFT — PENDING OWNER APPROVAL. Criterion 84 requires owner-approved copy
 * and no wording has been approved. It is deliberately not pinned as a
 * character-for-character expectation the way the cancellation email's is;
 * pinning unapproved wording would dress a draft as a decision. What IS
 * pinned is that the two surfaces agree, and that the text carries no
 * forbidden term — both of which stay true through an approval edit.
 */

/** The locale key the storefront reads the identical text from. */
export const NOT_COMMITTED_DISCLOSURE_LOCALE_PATH = [
  "sections",
  "cart",
  "bank_payment_checkout_form",
  "not_committed_disclosure",
] as const;

export const NOT_COMMITTED_DISCLOSURE =
  "Your order is not placed and your item is not reserved until we receive and verify your Bank Payment. " +
  "We'll email you an invoice for your Bank Payment Price — nothing is charged now.";

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
