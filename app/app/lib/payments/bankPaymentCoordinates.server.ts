import { getEnv, type Env } from "~/lib/env.server";

/**
 * The ONLY place that reads real bank payment coordinates.
 *
 * Owner decision 2026-09-29: MVP1 offers Zelle and DOMESTIC WIRE. ACH and
 * generic "bank transfer" are permitted by policy but deliberately not
 * exposed to customers yet.
 *
 * ============================================================================
 * THE FOUR RULES, AND WHY EACH IS SEPARATE
 * ============================================================================
 * 1. NEVER LOG A VALUE. Not the account number, not the routing number, not
 *    the Zelle destination. `redactedSummary()` below exists so a log line can
 *    say WHICH coordinates are present without saying what they are — the
 *    thing you actually want at 3am is "wire configured, Zelle missing", not
 *    the digits.
 *
 * 2. NEVER PUT ONE IN AN ERROR MESSAGE. Errors travel further than logs: into
 *    stack traces, alerting webhooks, sometimes a response body. `missing`
 *    below names the VARIABLES that are absent, never the values that are
 *    present.
 *
 * 3. FAIL CLOSED WHEN ANY IS MISSING. A resolver that returned a partial set
 *    would let the caller send an email that tells a customer to pay and then
 *    omits where to send it — worse than no email, because the customer
 *    believes they have been told.
 *
 * 4. ALL OR NOTHING PER METHOD. A wire block missing only its routing number
 *    is not "mostly usable"; it is unusable and dangerous, because a customer
 *    may try to act on the part they can see.
 *
 * NOT PERSISTED, EVER. These live in Fly secrets and are read at send time.
 * Copying them into a table would create a second place to secure, retain and
 * eventually redact — the same argument that kept the shipping first name at
 * Shopify rather than in our own tables.
 */

/** Zelle, per the owner's MVP1 method list. The recipient may be an email address or a phone number; we do not parse or validate which. */
export interface ZelleCoordinates {
  readonly recipient: string;
}

/** Domestic wire. No SWIFT/BIC — domestic only, owner decision 2026-09-29. */
export interface DomesticWireCoordinates {
  readonly bankName: string;
  readonly accountName: string;
  readonly routingNumber: string;
  readonly accountNumber: string;
}

export interface BankPaymentCoordinates {
  readonly zelle: ZelleCoordinates;
  readonly wire: DomesticWireCoordinates;
}

export type BankPaymentCoordinatesResolution =
  | { readonly configured: true; readonly coordinates: BankPaymentCoordinates }
  | { readonly configured: false; readonly reason: string };

function present(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

/**
 * Mirrors `resolveEmailPort`'s shape deliberately — same honesty boundary,
 * same discriminated union, so a caller handles "not configured" the way it
 * already handles it for email rather than learning a second idiom.
 */
export function resolveBankPaymentCoordinates(env: Env = getEnv()): BankPaymentCoordinatesResolution {
  const zelleRecipient = present(env.PAYMENT_ZELLE_RECIPIENT);
  const bankName = present(env.PAYMENT_WIRE_BANK_NAME);
  const accountName = present(env.PAYMENT_WIRE_ACCOUNT_NAME);
  const routingNumber = present(env.PAYMENT_WIRE_ROUTING_NUMBER);
  const accountNumber = present(env.PAYMENT_WIRE_ACCOUNT_NUMBER);

  // NAMES OF WHAT IS MISSING, never values of what is present — rule 2.
  const missing: string[] = [];
  if (!zelleRecipient) missing.push("PAYMENT_ZELLE_RECIPIENT");
  if (!bankName) missing.push("PAYMENT_WIRE_BANK_NAME");
  if (!accountName) missing.push("PAYMENT_WIRE_ACCOUNT_NAME");
  if (!routingNumber) missing.push("PAYMENT_WIRE_ROUTING_NUMBER");
  if (!accountNumber) missing.push("PAYMENT_WIRE_ACCOUNT_NUMBER");

  if (missing.length > 0) {
    return {
      configured: false,
      reason: `bank payment coordinates not configured: missing ${missing.join(", ")}`,
    };
  }

  return {
    configured: true,
    coordinates: {
      zelle: { recipient: zelleRecipient! },
      wire: {
        bankName: bankName!,
        accountName: accountName!,
        routingNumber: routingNumber!,
        accountNumber: accountNumber!,
      },
    },
  };
}

/**
 * A log-safe description of WHICH coordinates are configured. Contains no
 * coordinate value of any kind, not even a masked tail: a masked account
 * number is still account-number-shaped, and the last four digits are exactly
 * what a caller is asked for to prove account ownership.
 */
export function redactedSummary(resolution: BankPaymentCoordinatesResolution): string {
  return resolution.configured ? "bank payment coordinates: configured" : resolution.reason;
}
