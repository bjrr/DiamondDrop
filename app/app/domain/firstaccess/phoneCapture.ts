/**
 * First Access — what a public signup is allowed to write to a Shopify
 * customer, and in what shape.
 *
 * ===========================================================================
 * WHY THIS EXISTS AT ALL
 * ===========================================================================
 * Shopify's native `{% form 'customer' %}` stores email, first name, last name
 * and tags. It DISCARDS `contact[phone]` — confirmed by a real signup on
 * 2026-11-04, not inferred from the docs. The mobile number is the one field
 * the native form cannot carry, so one narrow authenticated write puts it on
 * the customer Shopify already created.
 *
 * Everything here is pure. No Shopify client, no database, no clock. The
 * decisions are the risky part and they are testable without a network.
 *
 * ===========================================================================
 * THIS IS NOT SMS CONSENT
 * ===========================================================================
 * Storing a number is not permission to text it. Nothing in this module or in
 * its caller sets `smsMarketingConsent`, and the form that collects the number
 * makes no SMS promise. When CaratForUs picks an SMS platform, consent will be
 * its own unchecked control with its own disclosure and its own evidence row —
 * which is exactly the thing that cannot be retrofitted onto a number that was
 * collected without asking.
 */

/** Applied by the landing page to every signup. Also the write gate — see below. */
export const FIRST_ACCESS_TAG = "first-access";

/**
 * The interest chips, mirroring the `interests` list in
 * `theme/snippets/first-access-form.liquid`.
 *
 * An ALLOWLIST, not a suggestion. Tags arrive from a public page, and a tag is
 * a merchandising primitive — segments, automations and discounts key off
 * them. Anything not on this list is dropped rather than stored, so the page
 * can never mint a tag nobody chose to create.
 */
export const FIRST_ACCESS_INTEREST_TAGS = [
  "loose-diamonds",
  "engagement-rings",
  "luxury-steals",
  "group-buys",
  "set-your-own-stone",
  "custom-jewelry",
] as const;

export type FirstAccessInterestTag = (typeof FIRST_ACCESS_INTEREST_TAGS)[number];

/** Longest address RFC 5321 permits. Anything longer is not a typo. */
const MAX_EMAIL_LENGTH = 254;
/** Shopify accepts more; a First Access signup needing more is not a name. */
const MAX_NAME_LENGTH = 80;
/**
 * Control characters become spaces.
 *
 * Written as a code-point test rather than a character class because the
 * literal bytes are invisible in an editor and in a diff — which is exactly
 * how a stray one survives review.
 */
function withoutControlCharacters(value: string): string {
  let out = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    out += code < 32 || code === 127 ? " " : character;
  }
  return out;
}

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
 *
 * NORTH AMERICA IS THE ONLY ASSUMED COUNTRY, and only for a bare 10-digit
 * number, because that is the one format a US customer types without thinking.
 * Anything else without a `+` is REFUSED rather than guessed: silently
 * prefixing `+1` onto an 9- or 12-digit string invents a number that belongs
 * to someone else.
 */
export function normalisePhone(raw: string): PhoneNormalisation {
  const trimmed = raw.trim();
  if (trimmed === "") return { ok: false, reason: "empty" };

  // An extension is not part of the number, and stripping the separator would
  // weld it onto the end — `555-0123 x99` must not become `+15550123 99`.
  if (/(^|[^a-z])(x|ext\.?|extension)\s*\d/i.test(trimmed)) {
    return { ok: false, reason: "not_a_number" };
  }
  // Letters anywhere else mean this is not a phone number at all (and keeps
  // vanity numbers out, which Shopify would reject regardless).
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
 * A name fit to store, or null when there is nothing to store.
 *
 * Control characters are removed rather than rejected — a name pasted out of a
 * PDF carries them and the person did nothing wrong — and runs of whitespace
 * collapse so `Mary   Anne` does not persist its own formatting.
 */
export function normaliseName(raw: string): string | null {
  const cleaned = withoutControlCharacters(raw).replace(/\s+/g, " ").trim();
  if (cleaned === "") return null;
  return cleaned.slice(0, MAX_NAME_LENGTH);
}

/** The submitted interests that are real interests, deduplicated, in list order. */
export function selectedInterestTags(raw: readonly string[]): FirstAccessInterestTag[] {
  const asked = new Set(raw.map((value) => value.trim().toLowerCase()));
  return FIRST_ACCESS_INTEREST_TAGS.filter((tag) => asked.has(tag));
}

export interface ExistingCustomerFacts {
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly phone: string | null;
  readonly tags: readonly string[];
}

export interface SubmittedSignup {
  readonly firstName: string | null;
  readonly lastName: string | null;
  /** Already normalised to E.164, or null when the optional field was left blank. */
  readonly phoneE164: string | null;
  readonly interests: readonly FirstAccessInterestTag[];
}

export interface CustomerWritePlan {
  /** Fields for `customerUpdate`. Absent keys are NOT sent, so they cannot be cleared. */
  readonly fields: {
    readonly firstName?: string;
    readonly lastName?: string;
    readonly phone?: string;
  };
  /** Tags for `tagsAdd`. Purely additive; never a replacement list. */
  readonly tagsToAdd: readonly string[];
  /** True when both are empty — the caller then performs no mutation at all. */
  readonly isNoop: boolean;
}

/**
 * What to write, given what is already on the customer.
 *
 * ===========================================================================
 * THREE RULES, ALL OF THEM ABOUT NOT DESTROYING DATA
 * ===========================================================================
 *
 * 1. A FIELD THE SUBMISSION DOES NOT CARRY IS OMITTED, NOT BLANKED. Shopify's
 *    `CustomerInput` treats an explicit `""` as "clear this", so a signup that
 *    skips the optional phone must leave the key off entirely. This is the
 *    difference between "no phone given" and "delete their phone".
 *
 * 2. A VALUE EQUAL TO WHAT IS ALREADY STORED IS OMITTED TOO. Resubmitting the
 *    same form is then genuinely idempotent — identical input produces an
 *    empty plan and no API call, rather than a write that happens to land on
 *    the same bytes.
 *
 * 3. TAGS ONLY EVER GROW. The returned list is for `tagsAdd`, never for
 *    `CustomerInput.tags`, which REPLACES the whole set — using it here would
 *    silently strip `vip`, `wholesale` or anything else operations added, from
 *    a public endpoint. Tags already present are filtered out so a repeat
 *    submission sends nothing.
 *
 * `first-access` is included in the growth set because it is the mark of where
 * the signup came from; on the normal path the native form has already applied
 * it and rule 3 makes this a no-op.
 */
export function planCustomerWrite(
  existing: ExistingCustomerFacts,
  submitted: SubmittedSignup
): CustomerWritePlan {
  const fields: { firstName?: string; lastName?: string; phone?: string } = {};

  if (submitted.firstName !== null && submitted.firstName !== existing.firstName) {
    fields.firstName = submitted.firstName;
  }
  if (submitted.lastName !== null && submitted.lastName !== existing.lastName) {
    fields.lastName = submitted.lastName;
  }
  if (submitted.phoneE164 !== null && submitted.phoneE164 !== existing.phone) {
    fields.phone = submitted.phoneE164;
  }

  const held = new Set(existing.tags.map((tag) => tag.trim().toLowerCase()));
  const tagsToAdd = [FIRST_ACCESS_TAG, ...submitted.interests].filter(
    (tag) => !held.has(tag)
  );

  return {
    fields,
    tagsToAdd,
    isNoop: Object.keys(fields).length === 0 && tagsToAdd.length === 0,
  };
}

/**
 * Whether this customer may be written to by the public endpoint.
 *
 * ===========================================================================
 * THE BLAST-RADIUS GATE
 * ===========================================================================
 * Anyone on the internet can POST an email address here. Without this check,
 * knowing a customer's address would be enough to rewrite the name and phone
 * on a real order-placing account.
 *
 * So the endpoint can only touch a customer who ALREADY carries
 * `first-access` — a record the landing page itself created. A paying customer
 * who never signed up for First Access is untouchable through this route, and
 * one who did has a name and a mobile number at stake, not an order or a card.
 */
export function mayWriteToCustomer(existing: ExistingCustomerFacts): boolean {
  return existing.tags.some((tag) => tag.trim().toLowerCase() === FIRST_ACCESS_TAG);
}
