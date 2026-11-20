import { getEnv, type Env } from "~/lib/env.server";

import type { SmsPort } from "./port";

export type SmsPortResolution =
  | { configured: true; port: SmsPort; from: string }
  | { configured: false; reason: string };

/**
 * Resolves the SMS sender, or says plainly that there is not one.
 *
 * ============================================================================
 * ⚠️ DEPRECATED AND DELIBERATELY DISABLED — owner decision 2026-11-19
 * ============================================================================
 * DO NOT WIRE THIS UP. **Shopify Messaging is the only sender of the First
 * Access welcome SMS.** This path is retained as a disabled seam, not as work
 * in progress, and the owner's instruction is explicit: do not configure the
 * app SMS sender while a Shopify Messaging welcome automation is in place.
 *
 * THE REASON IS DUPLICATE SENDS, NOT PREFERENCE. Shopify Messaging decides for
 * itself when a new SMS subscriber gets a welcome text. This module cannot see
 * that decision and Shopify cannot see this one, so two live senders means two
 * welcome texts for one signup — on a first text from an unknown number, which
 * is exactly the impression a toll-free sender under carrier review must not
 * make. There is no shared idempotency key between the two, and inventing one
 * would mean reimplementing Shopify's own send log.
 *
 * `resolveSmsPort` therefore returns `configured: false` on EVERY path,
 * including when `SMS_API_KEY` and `SMS_FROM` are both set. That is not an
 * oversight left half-finished — it is the disablement, and
 * `smsSenderDisabledFence.test.ts` pins it. Setting the environment variables
 * alone must not be enough to start sending, because an environment variable
 * is exactly the kind of change that gets made without reading this comment.
 *
 * IF THIS IS EVER REVIVED, three things must happen first, in order: the
 * Shopify Messaging welcome automation must be confirmed OFF, the owner must
 * re-approve the message copy (the constant in `signupSms.ts` predates the
 * copy approved on 2026-11-19 for Messaging and is NOT interchangeable with
 * it — a different sender means different sender identification and a
 * different unsubscribe mechanism), and the fence test must be updated
 * deliberately rather than deleted.
 *
 * Callers already handle the unconfigured branch: they log the reason, nothing
 * reports a text as sent, and no signup fails for want of one. Consent is
 * still recorded correctly in Shopify regardless — the permission and the send
 * are separate concerns, which is why disabling the send costs nothing.
 */
export function resolveSmsPort(env: Env = getEnv()): SmsPortResolution {
  const missing: string[] = [];
  if (!env.SMS_API_KEY) missing.push("SMS_API_KEY");
  if (!env.SMS_FROM) missing.push("SMS_FROM");

  if (missing.length > 0) {
    return { configured: false, reason: `sms not configured: missing ${missing.join(", ")}` };
  }

  // BOTH VARIABLES ARE SET AND THE ANSWER IS STILL NO.
  //
  // This is the disablement, not a gap. Owner decision 2026-11-19 makes
  // Shopify Messaging the only sender of the First Access welcome SMS, so
  // populating two environment variables must not be sufficient to start a
  // second sender and deliver two welcome texts for one signup.
  //
  // Returning "not configured" is also the only honest answer available: a
  // port that accepts a send and does nothing is worse than no port, because
  // it would report success for a text that never left.
  return {
    configured: false,
    reason:
      "sms sending is disabled: Shopify Messaging is the sole sender of the First Access welcome SMS " +
      "(owner decision 2026-11-19). Configuring an app-side sender would duplicate it.",
  };
}
