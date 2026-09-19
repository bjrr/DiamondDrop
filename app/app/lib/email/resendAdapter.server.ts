import { EmailSendError, type EmailPort, type SendEmailInput, type SendEmailResult } from "./port";

const RESEND_API_URL = "https://api.resend.com/emails";

/**
 * The real transactional-email adapter (Slice 2 stage 2A, owner §15: "both
 * email and a persistent embedded-admin alert"). A direct `fetch` call
 * against Resend's send endpoint rather than the `resend` npm package —
 * CLAUDE.md's "avoid ... unnecessary SaaS dependencies": the endpoint is one
 * POST with a small, stable JSON contract, and a dependency buys nothing
 * here that a fetch call does not already give at zero install cost.
 *
 * `fetchImpl` is injectable so unit tests exercise this class against a
 * fake `fetch` — no network, no real API key — rather than needing an
 * integration-test/live-credential path for what is a thin HTTP mapping.
 */
export class ResendEmailPort implements EmailPort {
  constructor(
    private readonly apiKey: string,
    private readonly fetchImpl: typeof fetch = fetch
  ) {}

  async send(input: SendEmailInput): Promise<SendEmailResult> {
    const response = await this.fetchImpl(RESEND_API_URL, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: input.from,
        to: input.to,
        subject: input.subject,
        text: input.text,
      }),
    });

    if (!response.ok) {
      // The response BODY is never read into the thrown error or logged.
      // Resend's error payloads can echo request content, and this send's
      // own body may itself carry a stored failure `reason` string (never
      // cost data, but still not something to fold into a log line) — see
      // `~/domain/alerts/emailContent.ts`'s own security note. The status
      // code alone is enough to diagnose a delivery failure.
      throw new EmailSendError(`Resend responded with status ${response.status}`);
    }

    let data: unknown;
    try {
      data = await response.json();
    } catch {
      throw new EmailSendError("Resend response was not valid JSON");
    }

    const messageId = (data as { id?: unknown } | null)?.id;
    if (typeof messageId !== "string" || messageId.length === 0) {
      throw new EmailSendError("Resend response did not include a message id");
    }

    return { providerMessageId: messageId };
  }
}
