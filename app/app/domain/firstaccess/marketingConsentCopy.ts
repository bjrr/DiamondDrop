/**
 * THE EXACT WORDS THE CUSTOMER AGREED TO, for email and for SMS separately.
 *
 * ============================================================================
 * WHY THIS FILE EXISTS AT ALL
 * ============================================================================
 * Until 2026-11-18 the First Access form carried a HIDDEN field:
 *
 *     <input type="hidden" name="contact[accepts_marketing]" value="true">
 *
 * So every signup was recorded in Shopify as email-marketing SUBSCRIBED
 * without the customer having agreed to anything, and there was no record of
 * any wording because none was ever shown. SMS consent did not exist in any
 * form: the mobile number was captured to a metafield and the form's own
 * comment correctly insisted that a phone number is not permission to text.
 *
 * The owner's decision of 2026-11-18 replaces both with real, separate,
 * unchecked opt-ins. That makes the wording itself evidence, and evidence has
 * to be stored as the exact string that was displayed — which is only true if
 * exactly one definition of it exists. This is that definition.
 *
 * ============================================================================
 * THREE PLACES MUST AGREE, AND A TEST ENFORCES IT
 * ============================================================================
 *   1. this module                       -> what the evidence row stores
 *   2. `theme/locales/en.default.json`   -> what the customer actually reads
 *   3. the `policy_version` migration    -> what the versioned policy says
 *
 * If (1) and (2) drift, we store a sentence the customer never saw, which is
 * worse than storing nothing: it is a confident record of the wrong thing.
 * `marketingConsentCopy.test.ts` compares this module against the theme
 * locale file byte for byte, and `requiredPolicyVersionsMigrationFence` style
 * assertions tie it to the migration.
 *
 * ============================================================================
 * CHANGING THE WORDING MEANS A NEW VERSION, NEVER AN EDIT
 * ============================================================================
 * `policy_version` is append-only by trigger. An `acknowledgment` row points
 * at the version it was shown under, so editing a version would retroactively
 * change what an existing subscriber is recorded as having agreed to — the
 * single thing a consent record exists to prevent. Bump the constant, add a
 * migration, leave the old row alone.
 */

/**
 * EMAIL. The customer-facing sentence, from the owner's instruction.
 *
 * NAMES THE CHANNEL AND THE CONTENT, which is what makes it consent to
 * something rather than a vague "keep me posted". The list is deliberately the
 * owner's own: early access, new arrivals, Group Buys, special offers, sales,
 * promotions — the categories we actually intend to send.
 */
export const FIRST_ACCESS_EMAIL_CONSENT_TEXT =
  "Email me CaratForUs early access, new arrivals, Group Buys, special offers, sales, and promotions.";

/**
 * SMS. The customer-facing sentence, from the owner's instruction.
 *
 * CARRIES THE FOUR DISCLOSURES A MARKETING-SMS OPT-IN NEEDS and that the
 * email one does not: what is being sent, that frequency varies, that message
 * and data rates may apply, and how to stop. They travel together in one
 * string precisely so none of them can be dropped by a later edit to the
 * markup — the label is this constant, not four spans a designer may reflow.
 *
 * ============================================================================
 * VERSION 2 — WHY "Reply STOP" HAD TO GO (owner decision 2026-11-19)
 * ============================================================================
 * Version 1 said "Reply STOP to unsubscribe". That sentence was written on the
 * assumption that the sender would honour replies, which is true of most SMS
 * platforms and is NOT true of the one CaratForUs is actually using: Shopify
 * Messaging's US/Canada toll-free sender is delivery-only and cannot receive
 * inbound messages. A customer replying STOP to it would have been following
 * our own written instruction into a dead end — believing they had opted out
 * while remaining SUBSCRIBED, which is the single worst failure mode an
 * unsubscribe instruction has.
 *
 * What Shopify Messaging DOES do is append an unsubscribe URL to marketing
 * messages, so the opt-out named here is the one that exists. CaratForUs must
 * not build its own unsubscribe URL: Shopify's link is what actually mutates
 * `smsMarketingConsent`, and a parallel mechanism would create a customer who
 * believes they unsubscribed while Shopify still considers them subscribed —
 * the same defect in a different place.
 *
 * This is still a promise about behaviour kept natively, which remains the
 * reason this flow records consent through `customerSmsMarketingConsentUpdate`
 * rather than into a private column: a private column could not be
 * unsubscribed from by Shopify's own link.
 *
 * Version 1 stays in the database untouched, pointing at what existing
 * subscribers were shown. There is exactly one such subscriber as of this
 * change and they hold no SMS consent, so no live consent rests on the
 * withdrawn wording.
 */
export const FIRST_ACCESS_SMS_CONSENT_TEXT =
  "Text me CaratForUs early access, new arrivals, Group Buys, special offers, sales, and promotions. " +
  "Message frequency varies. Msg & data rates may apply. You can unsubscribe at any time using the " +
  "unsubscribe link included in our texts.";

/**
 * What the customer DID. Stored on the acknowledgment as the affirmative
 * action, the same discipline the Custom Jewelry and RMA acknowledgments use:
 * the record says what was ticked, not merely that something was.
 *
 * Both channels share the label because both are a checkbox, and the channel
 * is already named by the slug and by the text.
 */
export const FIRST_ACCESS_CONSENT_AFFIRMATIVE_ACTION_LABEL = "Checked the opt-in box";

/**
 * The policy slugs.
 *
 * SEPARATE SLUGS, NOT ONE WITH A CHANNEL COLUMN. Email consent and SMS
 * consent are independent permissions with independent lifecycles — a customer
 * may hold one and not the other, may withdraw one and keep the other, and in
 * the SMS case may withdraw it by replying STOP to a text that never touches
 * our code. Two slugs means the two can be versioned, queried and audited
 * apart, which a shared slug with a discriminator could not do.
 *
 * THE SLUG ALSO RECORDS THE SURFACE. "first-access-..." names the Launching
 * Soon signup specifically, so a consent collected here is distinguishable
 * from one collected at checkout or in an account page later, without needing
 * a free-text source column that nothing would validate.
 */
export const FIRST_ACCESS_EMAIL_CONSENT_POLICY_SLUG = "first-access-email-marketing-consent";
export const FIRST_ACCESS_SMS_CONSENT_POLICY_SLUG = "first-access-sms-marketing-consent";

/**
 * Bump together with the text above, as a NEW version, on any approved wording
 * change.
 *
 * THE TWO CHANNELS VERSION INDEPENDENTLY, and this is the first case that
 * proves the design was right: the 2026-11-19 correction changed only the SMS
 * sentence, so SMS is at 2 while email stays at 1. A shared version number
 * would have forced a meaningless email version 2 whose text was identical to
 * version 1 — and an auditor reading two versions with the same words cannot
 * tell which one a customer was shown.
 */
export const FIRST_ACCESS_EMAIL_CONSENT_POLICY_VERSION = 1;
export const FIRST_ACCESS_SMS_CONSENT_POLICY_VERSION = 2;

/**
 * The version string the THEME sends with a signup, so the server can tell
 * which wording a given browser actually rendered.
 *
 * WHY THE CLIENT SENDS IT AND THE SERVER DOES NOT TRUST IT. A cached page can
 * outlive a wording change by as long as the customer leaves the tab open, so
 * a signup may genuinely arrive quoting last week's sentence. The server
 * records consent against ITS OWN current version regardless — a client must
 * never be able to choose which policy it is consenting to — but it logs a
 * mismatch, because a steady stream of them means a stale cache is showing
 * customers wording we no longer consider current.
 */
export const FIRST_ACCESS_CONSENT_COPY_VERSION = "2026-11-19";

/** The locale keys the theme renders these from. Pinned so the fence test can find them. */
export const FIRST_ACCESS_EMAIL_CONSENT_LOCALE_KEY = "email_consent";
export const FIRST_ACCESS_SMS_CONSENT_LOCALE_KEY = "sms_consent";
