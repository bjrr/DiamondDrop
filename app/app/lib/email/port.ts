/**
 * The email port (Slice 2 stage 2A, owner §15). Kept as a tiny interface so
 * `adminAlertDispatch.server.ts` and its tests depend on this shape, not on
 * Resend specifically — a fake implementing `EmailPort` is all a unit test
 * needs.
 */
export interface SendEmailInput {
  from: string;
  /** Every recipient in `STAFF_EMAIL_ALLOWLIST` — this is an internal admin notification, not a customer email. */
  to: string[];
  subject: string;
  text: string;
}

export interface SendEmailResult {
  /** The provider's own message id — proof of acceptance, not merely of an attempt. */
  providerMessageId: string;
}

export interface EmailPort {
  send(input: SendEmailInput): Promise<SendEmailResult>;
}

/** Thrown by an `EmailPort` implementation on a provider/network failure. Never carries the raw response body — see `resendAdapter.server.ts`. */
export class EmailSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmailSendError";
  }
}
