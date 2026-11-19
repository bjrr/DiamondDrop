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
 *   - the brand, so the first text from an unknown number is identifiable;
 *   - what they opted into, so it is recognisable as the thing they asked for;
 *   - HELP and STOP, because the opt-in promised "Reply STOP to unsubscribe"
 *     and a confirmation that omits it is the worst place to drop it;
 *   - message and data rates, carried once more here for the same reason.
 *
 * NO OFFER, NO LINK, NO DISCOUNT CODE. This is the confirmation of a
 * subscription, not the first marketing message. Putting a promotion in it
 * would make the very first text a campaign the customer had not yet seen the
 * list behave for.
 *
 * ONE SEGMENT WHERE POSSIBLE. Kept under 160 GSM-7 characters so it sends as a
 * single segment: pinned by a test, because a message that silently becomes
 * two costs twice and can arrive out of order.
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
  "CaratForUs: you're on the list for early access, Group Buys and offers. " +
  "Msg & data rates may apply. Reply HELP for help, STOP to cancel.";

export function buildSignupConfirmationSms(): SignupSmsContent {
  return { body: FIRST_ACCESS_SIGNUP_SMS_BODY };
}
