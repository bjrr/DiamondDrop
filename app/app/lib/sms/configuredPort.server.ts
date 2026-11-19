import { getEnv, type Env } from "~/lib/env.server";

import type { SmsPort } from "./port";

export type SmsPortResolution =
  | { configured: true; port: SmsPort; from: string }
  | { configured: false; reason: string };

/**
 * Resolves the SMS sender, or says plainly that there is not one.
 *
 * ============================================================================
 * THERE IS NO PROVIDER CONFIGURED, AND THAT IS REPORTED RATHER THAN FAKED
 * ============================================================================
 * Mirrors `resolveEmailPort` deliberately, including its directive: when the
 * credentials are unset, do not pretend. Callers log the reason; nothing
 * reports a text as sent, and no signup fails for want of one.
 *
 * `SMS_API_KEY` and `SMS_FROM` are the two values a provider needs, and both
 * are optional in `env.server.ts` so the app boots, builds and serves without
 * them — which is the state it is in today. Supplying them is an owner action:
 * it means opening an account with a sending provider and paying for it.
 *
 * NO ADAPTER IS SELECTED HERE YET. When the provider is chosen, this function
 * grows one `new TwilioSmsPort(...)` (or equivalent) and nothing else changes:
 * every caller already handles both branches, and the message copy, the
 * consent gate and the evidence are all independent of who sends.
 */
export function resolveSmsPort(env: Env = getEnv()): SmsPortResolution {
  const missing: string[] = [];
  if (!env.SMS_API_KEY) missing.push("SMS_API_KEY");
  if (!env.SMS_FROM) missing.push("SMS_FROM");

  if (missing.length > 0) {
    return { configured: false, reason: `sms not configured: missing ${missing.join(", ")}` };
  }

  // UNREACHABLE TODAY, and deliberately not a stub that silently drops
  // messages. If both variables are somehow set without an adapter having been
  // written, the honest answer is still "not configured" — a port that accepts
  // a send and does nothing is worse than no port, because it would report
  // success.
  return {
    configured: false,
    reason: "sms not configured: credentials are present but no provider adapter is implemented yet",
  };
}
