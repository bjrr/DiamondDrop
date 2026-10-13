/**
 * The Custom Jewelry intake confirmation email.
 *
 * OWNER-APPROVED COPY, 2026-10-05, verbatim — including the curly
 * apostrophes. `intakeConfirmationEmail.test.ts` pins it character for
 * character, the same discipline `claimAcknowledgmentEmail.ts` and
 * `guaranteeCancellationEmail.ts` follow: an edit here is new unapproved
 * customer-facing copy however small it looks.
 *
 * BUILT BECAUSE THE PAGE PROMISES IT. The intake confirmation says "We'll be
 * in touch by email", and the README requires a customer confirmation. Twice
 * already in this project a page promised an email that did not exist (§1.5
 * and §2.8), and both were caught only because the owner asked for the
 * condition to be verified rather than assumed. This one existed before the
 * sentence shipped.
 *
 * NO RESPONSE-TIME PROMISE. The owner struck turnaround language from the
 * warranty copy twice and from this email explicitly. Do not reintroduce
 * "shortly", "within N days", or "as soon as possible" — the last is a
 * turnaround promise wearing a vague coat.
 *
 * NO DEPOSIT TERMS HERE BEYOND "no charge for this enquiry". The conditional
 * refund rules — and specifically that a refund is NOT automatic if the
 * customer abandons or stops responding before the agreed design stage
 * completes — belong on the deposit/approval step where the customer
 * affirmatively accepts them, not in a welcome email where they would read as
 * a warning and cannot be acknowledged.
 */

export interface CustomJewelryIntakeConfirmationEmailInput {
  /** The customer-facing reference, printed in both subject and body. */
  projectReference: string;
}

export interface CustomJewelryIntakeConfirmationEmailContent {
  subject: string;
  text: string;
}

export function buildCustomJewelryIntakeConfirmationEmail(
  input: CustomJewelryIntakeConfirmationEmailInput
): CustomJewelryIntakeConfirmationEmailContent {
  return {
    subject: `We received your custom jewelry request (${input.projectReference})`,
    text: [
      "Hi there,",
      "",
      `We’ve received your custom jewelry request and recorded it under reference ${input.projectReference}.`,
      "",
      "There’s no charge for this enquiry. We’ll be in touch by email about the next step.",
      "",
      "CaratForUs",
    ].join("\n"),
  };
}
