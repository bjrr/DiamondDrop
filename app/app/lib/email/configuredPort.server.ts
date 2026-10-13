import { getEnv, type Env } from "~/lib/env.server";

import type { EmailPort } from "./port";
import { ResendEmailPort } from "./resendAdapter.server";

export type EmailPortResolution =
  | { configured: true; port: EmailPort; from: string; recipients: string[] }
  | { configured: false; reason: string };

/**
 * The single place that decides whether outbound admin email is possible
 * right now (Slice 2 stage 2A). Team-lead directive: "when [EMAIL_API_KEY /
 * EMAIL_FROM / STAFF_EMAIL_ALLOWLIST] are unset, do not pretend" — this
 * function is the honesty boundary. It never fabricates a working port when
 * configuration is missing; it returns `configured: false` with a stated
 * reason, and `adminAlertDispatch.server.ts` records that reason rather than
 * claiming a send that did not happen.
 *
 * `env` is an explicit parameter (default `getEnv()`) purely for unit
 * testability — this mirrors `loadEnv(source = process.env)`'s own shape in
 * `env.server.ts` rather than introducing a different test seam.
 */
export function resolveEmailPort(env: Env = getEnv()): EmailPortResolution {
  const missing: string[] = [];
  if (!env.EMAIL_API_KEY) missing.push("EMAIL_API_KEY");
  if (!env.EMAIL_FROM) missing.push("EMAIL_FROM");
  if (!env.STAFF_EMAIL_ALLOWLIST) missing.push("STAFF_EMAIL_ALLOWLIST");
  if (missing.length > 0) {
    return { configured: false, reason: `email not configured: missing ${missing.join(", ")}` };
  }

  const recipients = env
    .STAFF_EMAIL_ALLOWLIST!.split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  if (recipients.length === 0) {
    return {
      configured: false,
      reason: "email not configured: STAFF_EMAIL_ALLOWLIST is empty after parsing",
    };
  }

  return {
    configured: true,
    port: new ResendEmailPort(env.EMAIL_API_KEY!),
    from: env.EMAIL_FROM!,
    recipients,
  };
}
