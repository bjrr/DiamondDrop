/**
 * The confirmation text sent to someone who opted into SMS.
 *
 * ============================================================================
 * WHY THIS IS SENT FROM THE PROXY ROUTE AND NOT FROM `customers/create`
 * ============================================================================
 * The confirmation EMAIL hangs off the `customers/create` webhook, which is
 * the right place for it: Shopify delivers that topic for every customer the
 * form creates, with retries, whatever the browser did.
 *
 * The SMS cannot. At `customers/create` time the SMS consent does not exist
 * yet — the native form post creates the customer, and the opt-in reaches us
 * on a SEPARATE request afterwards, because Shopify's customer form has no SMS
 * field. A webhook handler asking "does this customer have SMS consent?" would
 * be racing the request that grants it, and would answer "no" most of the time.
 *
 * So the text is sent from the proxy route at the one moment consent is a
 * known fact: immediately after `customerSmsMarketingConsentUpdate` confirmed
 * SUBSCRIBED. Nothing infers consent from a phone number, and nothing sends
 * before Shopify has recorded the permission.
 *
 * ============================================================================
 * NO NAME IN IT, DELIBERATELY
 * ============================================================================
 * The email greets by first name; this does not. Names are deliberately never
 * sent to the app-proxy endpoint — the original author's rule, kept because
 * anything a public endpoint accepts is something a public endpoint could
 * change — and the route therefore does not have one to use. Inventing a
 * lookup to fetch a first name purely to decorate a 160-character message
 * would mean reading more about a person than the task requires.
 *
 * ============================================================================
 * WHAT IT MUST CONTAIN, AND WHY EACH PART
 * ============================================================================
 *   - what they opted into, so it is recognisable as the thing they asked for;
 *   - message and data rates, the one disclosure worth repeating on the first
 *     text rather than relying on the customer remembering the opt-in label.
 *
 * NO OFFER, NO LINK, NO DISCOUNT CODE. This is the confirmation of a
 * subscription, not the first marketing message. Putting a promotion in it
 * would make the very first text a campaign the customer had not yet seen the
 * list behave for.
 *
 * ============================================================================
 * NO "Reply STOP", NO "Reply HELP", AND NO BRAND PREFIX OF OUR OWN
 * ============================================================================
 * Owner decision 2026-11-19. Three things this body deliberately does NOT do,
 * all for the same underlying reason — Shopify Messaging owns them:
 *
 *   1. NO REPLY INSTRUCTION. Shopify's US/Canada toll-free sender is
 *      delivery-only and cannot receive inbound messages. "Reply STOP" would
 *      have been an instruction into a dead end, leaving a customer who
 *      believes they opted out still SUBSCRIBED — worse than saying nothing,
 *      because they stop looking for the mechanism that works.
 *   2. NO UNSUBSCRIBE URL OF OURS. Shopify Messaging appends its own, and that
 *      link is what actually mutates `smsMarketingConsent`. A CaratForUs-built
 *      link would be a second opt-out that Shopify does not honour.
 *   3. NO "CaratForUs:" PREFIX. Shopify Messaging prepends the configured
 *      message prefix (verified as `CaratForUs` on the live shop), so writing
 *      it here too produces "CaratForUs: CaratForUs: ...". Brand
 *      identification is still present on the delivered text — it is just not
 *      ours to add. This is why the body no longer leads with the brand, which
 *      version 1 of this message did.
 *
 * ============================================================================
 * SEGMENTS: TWO, MEASURED, NOT ONE
 * ============================================================================
 * The earlier body fitted a single 160-character GSM-7 segment. The owner's
 * wording does not, and the test now pins what is actually true rather than
 * the number we would prefer: 167 characters, plus Shopify's prefix and its
 * appended unsubscribe URL, so the delivered message is two to three segments.
 *
 * What the test still enforces is the part that is a bug if it slips: the body
 * stays within GSM-7. A single curly apostrophe (U+2019) would push the whole
 * message to UCS-2 and HALVE the per-segment capacity from 153 to 67,
 * silently adding a segment. That is why the apostrophes below are
 * deliberately straight.
 */

export interface SignupSmsContent {
  readonly body: string;
}

/**
 * NOT A TEMPLATE FUNCTION. There is nothing to interpolate — no name, no
 * offer, no link — so it is a constant wearing a function's clothes only
 * where the caller shape benefits. Exported as a constant too, so a test can
 * assert its length without calling anything.
 */
export const FIRST_ACCESS_SIGNUP_SMS_BODY =
  "You're on the First Access list. We'll text you about new launches, Group Buys, " +
  "special offers and select promotions. Msg frequency varies. Msg & data rates may apply.";

export function buildSignupConfirmationSms(): SignupSmsContent {
  return { body: FIRST_ACCESS_SIGNUP_SMS_BODY };
}
