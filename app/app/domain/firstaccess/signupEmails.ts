/**
 * LAUNCHING SOON SIGNUP — the two emails a valid signup produces.
 *
 * ===========================================================================
 * PURE CONTENT, NO I/O
 * ===========================================================================
 * Same shape as `customjewelry/intakeConfirmationEmail.ts` and the bank
 * payment templates: these functions take a plain record and return a
 * subject and a body. Nothing here knows about Resend, webhooks or the
 * database, so the owner-approved wording can be asserted character by
 * character in a unit test rather than inferred from a live send.
 *
 * ===========================================================================
 * THE COPY IS THE OWNER'S, VERBATIM
 * ===========================================================================
 * Subject, greeting, every paragraph and all four bullets are reproduced
 * exactly as supplied on 2026-11-13. Do not reword, reorder or "tighten"
 * them. `signupEmails.test.ts` pins the full body, so an accidental edit
 * fails the build instead of reaching a customer.
 *
 * NO EM DASHES. The First Access V2 copy rule
 * (docs/COMING-SOON-FIRST-ACCESS.md) applies to everything this page sends.
 *
 * NO RESPONSE-TIME PROMISE and no launch date. "as soon as we launch" is the
 * commitment; the owner has struck dated language from customer copy before
 * (see the custom jewelry intake email's own note) and
 * docs/COMING-SOON-FIRST-ACCESS.md forbids a countdown until a real date is
 * approved.
 */

export interface SignupEmailInput {
  /** As stored on the Shopify customer. Blank/absent is normal and handled. */
  readonly firstName?: string | null;
  readonly lastName?: string | null;
  readonly email: string;
  /** Optional by design. A signup is valid without it. */
  readonly phone?: string | null;
}

export interface EmailContent {
  readonly subject: string;
  readonly text: string;
}

/** Trimmed value, or null when absent/blank/whitespace. */
function present(value: string | null | undefined): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * THE GREETING, AND ITS FALLBACK.
 *
 * First name comes from Shopify's real `first_name` field, which the signup
 * form captures as a required input. It is still treated as optional here:
 * a customer can be created through other paths (admin, import, a future
 * form) and a greeting reading "Hi ," is the kind of defect that only shows
 * up in someone's inbox.
 */
export function signupGreeting(firstName: string | null | undefined): string {
  const name = present(firstName);
  return name ? `Hi ${name},` : "Hi there,";
}

/** The confirmation sent to the person who signed up. */
export function buildSignupConfirmationEmail(input: SignupEmailInput): EmailContent {
  const body = [
    signupGreeting(input.firstName),
    "",
    "Thank you for joining CaratForUs.",
    "",
    "You’re now on our early-access list, and we’ll let you know as soon as we launch.",
    "",
    "CaratForUs is being built around a simpler way to buy fine jewelry, diamonds, and exclusive Group Buys at exceptional pricing.",
    "",
    "You’ll be among the first to hear about:",
    "",
    "- Our official launch",
    "- Direct diamond pricing",
    "- New Group Buy opportunities",
    "- Special early-access offers",
    "",
    "We look forward to welcoming you.",
    "",
    "The CaratForUs Team",
  ].join("\n");

  return { subject: "You’re on the CaratForUs list", text: body };
}

/** Where every signup notification goes. */
export const SIGNUP_NOTIFICATION_RECIPIENT = "orders@caratforus.com";

/**
 * The internal notification.
 *
 * PHONE AND LAST NAME ARE OMITTED WHEN ABSENT rather than printed as an
 * empty label. "Phone: " with nothing after it reads as a capture bug and
 * sends someone looking for a number that was never asked for; both fields
 * are genuinely optional on this form.
 *
 * This is the one email on this path that carries a customer's details, and
 * it goes to a single internal address. The customer-facing confirmation
 * above deliberately contains none of them.
 */
export function buildSignupInternalNotification(input: SignupEmailInput): EmailContent {
  const firstName = present(input.firstName);
  const lastName = present(input.lastName);
  const phone = present(input.phone);

  const lines = [
    "New Launching Soon signup.",
    "",
    `First name: ${firstName ?? "(not provided)"}`,
  ];

  if (lastName) lines.push(`Last name: ${lastName}`);
  lines.push(`Email: ${input.email}`);
  if (phone) lines.push(`Phone: ${phone}`);

  lines.push("", "Source: Launching Soon signup (First Access)");

  const who = firstName ?? input.email;
  return { subject: `New Launching Soon signup: ${who}`, text: lines.join("\n") };
}
