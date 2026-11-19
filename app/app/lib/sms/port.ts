/**
 * THE SMS SEAM.
 *
 * ============================================================================
 * WHY A PORT AND NOT A PROVIDER
 * ============================================================================
 * CaratForUs has no SMS provider yet. Shopify does not offer transactional SMS
 * to apps — its SMS marketing is delivered through installed apps, not an API
 * an app may call — so sending a text needs an account somewhere (Twilio or
 * similar), which needs credentials and a payment method. Those are the
 * owner's to arrange, not something this code can conjure.
 *
 * What does NOT need waiting for is everything around the send: the consent,
 * the evidence, the decision about whom it is lawful to text, and the message
 * itself. All of that is built and tested. This interface is the single line
 * the provider will be wired behind, so adding one later is a new adapter and
 * a configuration value, not a change to any flow.
 *
 * ============================================================================
 * UNCONFIGURED IS A STATE, NOT A FAILURE, AND NEVER A PRETENCE
 * ============================================================================
 * `resolveSmsPort` reports `configured: false` with a reason, exactly as
 * `resolveEmailPort` does, and the team-lead directive behind that one applies
 * here verbatim: "when [the credentials] are unset, do not pretend". A caller
 * logs the reason and carries on; nothing claims a text was sent, and no
 * signup fails because a text could not be.
 *
 * THE CONSENT IS STILL RECORDED when there is no provider. That separation is
 * the whole point of doing it this way round: a customer who opts in today is
 * properly subscribed in Shopify today, and becomes reachable the moment a
 * provider exists — rather than being asked again later because we declined to
 * write down what they already told us.
 */

export interface SendSmsInput {
  /** E.164. The same normalised value written to `Customer.phone`. */
  readonly to: string;
  readonly body: string;
}

export interface SendSmsResult {
  /** The provider's own id, when it returns one. For log correlation only. */
  readonly providerMessageId?: string;
}

export interface SmsPort {
  send(input: SendSmsInput): Promise<SendSmsResult>;
}
