/**
 * First Access — validating the one optional field the native signup form
 * cannot carry.
 *
 * ===========================================================================
 * WHAT THIS IS FOR
 * ===========================================================================
 * Shopify's native `{% form 'customer' %}` stores email, first name, last
 * name and tags, and DISCARDS `contact[phone]` — confirmed by a real signup on
 * 2026-11-04, not inferred from the docs. Everything except the mobile number
 * therefore persists natively and is none of this module's business.
 *
 * The number is captured as PLAIN DATA in a customer metafield
 * (`custom.first_access_mobile`), not in Shopify's native `Customer.phone`.
 * Owner decision 2026-11-05: populating the native field is not needed at this
 * stage, and mapping into an official SMS phone field is deferred until the
 * SMS/marketing platform is chosen. An earlier implementation wrote
 * `Customer.phone`, names and tags; all of that is deleted rather than kept
 * switched off.
 *
 * Everything here is pure. No Shopify client, no database, no clock.
 *
 * ===========================================================================
 * THIS IS NOT SMS CONSENT
 * ===========================================================================
 * Storing a number is not permission to text it. Nothing in this module or in
 * its caller sets `smsMarketingConsent`, and the form that collects the number
 * makes no SMS promise. When CaratForUs picks an SMS platform, consent will be
 * its own unchecked control with its own disclosure and its own evidence row —
 * which is exactly the thing that cannot be retrofitted onto a number that was
 * collected without asking. Pinned by `firstAccessPhoneFence.test.ts`.
 */

/**
 * Applied by the landing page to every signup, via the native form.
 *
 * Read-only here: this module never asks for it to be written. It is the WRITE
 * GATE — see `mayWriteToCustomer`.
 */
export const FIRST_ACCESS_TAG = "first-access";

/** The customer metafield the number is stored in, and nothing else. */
export const FIRST_ACCESS_MOBILE_METAFIELD = {
  namespace: "custom",
  key: "first_access_mobile",
  type: "single_line_text_field",
} as const;

/** Longest address RFC 5321 permits. Anything longer is not a typo. */
const MAX_EMAIL_LENGTH = 254;

export type PhoneRejection =
  | "empty"
  | "too_short"
  | "too_long"
  | "ambiguous_country"
  | "not_a_number";

export type PhoneNormalisation =
  | { readonly ok: true; readonly e164: string }
  | { readonly ok: false; readonly reason: PhoneRejection };

/**
 * A submitted number in E.164, or a reason it is not one.
 *
 * E.164 BECAUSE THE ALTERNATIVE IS FIVE SPELLINGS OF ONE NUMBER.
 * `(555) 012-3456`, `555-012-3456` and `+15550123456` are the same person, and
 * storing whichever one they typed makes the field useless for matching later.
 * The metafield is a free text field, so nothing downstream will normalise it
 * on our behalf — this is the only place it happens.
 *
 * NORTH AMERICA IS THE ONLY ASSUMED COUNTRY, and only for a bare 10-digit
 * number, because that is the one format a US customer types without thinking.
 * Anything else without a `+` is REFUSED rather than guessed: silently
 * prefixing `+1` onto a 9- or 12-digit string invents a number that belongs to
 * someone else.
 */
export function normalisePhone(raw: string): PhoneNormalisation {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };

  // An extension is not part of the number, and stripping the separator would
  // weld it onto the end — `555-0123 x99` must not become `+15550123 99`.
  if (/(^|[^a-z])(x|ext\.?|extension)\s*\d/i.test(trimmed)) {
    return { ok: false, reason: "not_a_number" };
  }
  // Letters anywhere else mean this is not a phone number at all.
  if (/[a-z]/i.test(trimmed)) return { ok: false, reason: "not_a_number" };

  const international = trimmed.startsWith("+");
  const digits = trimmed.replace(/\D/g, "");
  if (digits === "") return { ok: false, reason: "not_a_number" };

  if (international) {
    // E.164 allows at most 15 digits; no country code is shorter than 8 in
    // practice, and a shorter string here is a mistyped number.
    if (digits.length < 8) return { ok: false, reason: "too_short" };
    if (digits.length > 15) return { ok: false, reason: "too_long" };
    return { ok: true, e164: `+${digits}` };
  }

  if (digits.length === 10) return { ok: true, e164: `+1${digits}` };
  if (digits.length === 11 && digits.startsWith("1")) {
    return { ok: true, e164: `+${digits}` };
  }
  if (digits.length < 10) return { ok: false, reason: "too_short" };
  // 11+ digits with no `+` and no leading 1: a real international number typed
  // without its plus. Refusing beats inventing a country code for it.
  return { ok: false, reason: "ambiguous_country" };
}

/**
 * A usable address in the one spelling the lookup will be done in, or null.
 *
 * Deliberately a shape check, not an RFC parser: the address is used only to
 * find a customer Shopify has ALREADY created from the same string, so the
 * authority on whether it is deliverable is Shopify, not this function.
 */
export function normaliseEmail(raw: string): string | null {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "" || trimmed.length > MAX_EMAIL_LENGTH) return null;
  if (/\s/.test(trimmed)) return null;
  if (!/^[^@]+@[^@.]+(\.[^@.]+)+$/.test(trimmed)) return null;
  return trimmed;
}

/**
 * Whether this customer may be written to by the public endpoint.
 *
 * ===========================================================================
 * THE BLAST-RADIUS GATE
 * ===========================================================================
 * Anyone on the internet can POST an email address here. Without this check,
 * knowing a customer's address would be enough to attach a mobile number to a
 * real order-placing account.
 *
 * So the endpoint can only touch a customer who ALREADY carries
 * `first-access` — a record the landing page itself created. A paying customer
 * who never signed up for First Access is untouchable through this route.
 */
export function mayWriteToCustomer(tags: readonly string[]): boolean {
  return tags.some((tag) => tag.trim().toLowerCase() === FIRST_ACCESS_TAG);
}
