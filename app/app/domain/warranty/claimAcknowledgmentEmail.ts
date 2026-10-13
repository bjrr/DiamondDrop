/**
 * The warranty claim acknowledgement email.
 *
 * OWNER-APPROVED COPY, 2026-09-29. Every character below is the owner's,
 * including the curly apostrophes. `claimAcknowledgmentEmail.test.ts` pins it
 * character-for-character so a well-meaning tidy-up fails loudly — the same
 * discipline `guaranteeCancellationEmail.ts` already follows, and for the same
 * reason: an edit here is new unapproved customer-facing copy, however small.
 *
 * WHAT THE OWNER EXPLICITLY EXCLUDED: any turnaround-time promise. Earlier
 * drafts carried one and it was struck, twice. Do not reintroduce "within N
 * days", "shortly", or "as soon as possible" — the last is a turnaround
 * promise wearing a vague coat.
 *
 * THE DO-NOT-SHIP LINE IS NOT OPTIONAL. It is the same locked instruction the
 * claim confirmation screen carries (§2.4), and it appears here because a
 * customer who reads only the email must still be told. An earlier draft added
 * a consequence for shipping early ("may be returned to you"); the owner
 * rejected it with no replacement, so the instruction stands alone.
 *
 * TWO SUBSTITUTIONS, BOTH ALREADY IN HAND. The claim reference and the
 * purchaser email are both on the claim row at send time, so unlike the
 * cancellation email there is no Shopify round trip and no fallback greeting
 * to negotiate: "Hi there," is unconditional here.
 */

export interface WarrantyClaimAcknowledgmentEmailInput {
  /** The customer-facing claim reference, printed twice: subject and body. */
  claimReference: string;
  /** Echoed back so the customer can see WHICH address we will write to, and correct it if it is wrong. */
  purchaserEmail: string;
}

export interface WarrantyClaimAcknowledgmentEmailContent {
  subject: string;
  text: string;
}

export function buildWarrantyClaimAcknowledgmentEmail(
  input: WarrantyClaimAcknowledgmentEmailInput
): WarrantyClaimAcknowledgmentEmailContent {
  return {
    subject: `We’ve received your warranty claim (${input.claimReference})`,
    text: [
      "Hi there,",
      "",
      `We’ve received your warranty claim and recorded it under reference ${input.claimReference}.`,
      "",
      `We’ll review what you’ve sent and email you at ${input.purchaserEmail}.`,
      "",
      "Do not send your jewelry until CaratForUs authorizes an inspection and provides shipping instructions.",
      "",
      "CaratForUs",
    ].join("\n"),
  };
}
