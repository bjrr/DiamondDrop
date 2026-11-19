/**
 * The one Shopify write behind the First Access mobile number.
 *
 * ===========================================================================
 * WHAT IT DOES AND, MORE IMPORTANTLY, WHAT IT CANNOT DO
 * ===========================================================================
 * It finds a customer Shopify has ALREADY created from the native signup form
 * and sets ONE text metafield on it: `custom.first_access_mobile`.
 *
 * ===========================================================================
 * AND, SINCE 2026-11-18, SMS MARKETING CONSENT — BUT ONLY WITH CONSENT
 * ===========================================================================
 * It cannot create a customer, cannot delete one, cannot change a name, and
 * cannot add or remove a tag. It CAN now set `Customer.phone` and
 * `smsMarketingConsent`, and only when the customer ticked the SMS opt-in box.
 *
 * THAT REVERSES PART OF OWNER DECISION 2026-11-05, which said the number goes
 * to a metafield and "never to `Customer.phone`", because "mapping into an
 * official SMS phone field is deferred until the SMS/marketing platform is
 * chosen". Both halves of that reasoning have now expired:
 *
 *   - The platform question is settled for CONSENT: it is recorded in Shopify
 *     natively, through `customerSmsMarketingConsentUpdate`, whichever sending
 *     platform is chosen later. Consent has to live where STOP replies are
 *     honoured, and that is Shopify.
 *   - Shopify REQUIRES a phone on the account for SMS marketing — the
 *     mutation's own documentation says so. So there is no way to hold a real
 *     SMS consent without `Customer.phone`, and a consent we cannot record is
 *     a consent we cannot act on.
 *
 * The part of 2026-11-05 that has NOT expired is the important one: **a phone
 * number is not permission to text.** The metafield write still happens for
 * every number given; the phone field and the consent record happen only for
 * a number given WITH an explicit opt-in. A customer who types a mobile and
 * leaves the SMS box unchecked ends up exactly where they would have before
 * this change — number captured, no consent, no `Customer.phone`.
 *
 * EMAIL CONSENT IS NOT WRITTEN HERE, deliberately. The native
 * `{% form 'customer' %}` carries `contact[accepts_marketing]`, so an unchecked
 * box sends nothing and a checked one has Shopify record SUBSCRIBED with its
 * own opt-in level and timestamp. That is the simplest Shopify-native answer
 * and it needs no scope, no mutation and no code — so email consent is set by
 * the platform and only its EVIDENCE is ours. Adding a redundant
 * `customerEmailMarketingConsentUpdate` here would mean two writers for one
 * fact, with the usual consequence.
 *
 * `write_customers` is the scope Shopify requires for ANY customer write,
 * including a metafield, so the only honest way to keep the grant narrow is
 * for the code it authorises to be this small. Pinned by
 * `firstAccessPhoneFence.test.ts`, which allows exactly these mutations by
 * name and fails if any other appears.
 *
 * Names, interests and the `first-access` tag all persist through the native
 * customer form and are none of this module's business.
 *
 * NO CUSTOMER CREATION. The native `{% form 'customer' %}` creates the
 * record, and Shopify puts hCaptcha in front of it. An app-proxy route has no
 * such protection, so a create path here would be an uncaptcha'd public
 * customer factory. The record always exists by the time this runs because
 * the theme only calls the endpoint after the native post succeeded.
 *
 * LOOKUP IS `customerByIdentifier`, NOT `customers(query:)`. The search index
 * lags writes by seconds, and this runs milliseconds after the customer was
 * created — a search would intermittently return nothing and silently drop
 * the number. `customerByIdentifier` reads the record directly.
 */
import type { AdminGraphqlClient } from "./productClient.server";
import {
  FIRST_ACCESS_MOBILE_METAFIELD,
  mayWriteToCustomer,
} from "~/domain/firstaccess/phoneCapture";
import { logger } from "~/lib/logger.server";

/**
 * Reads the tags (for the gate) and the id (for `ownerId`). Nothing else.
 *
 * It deliberately does NOT read `defaultPhoneNumber`, a name, an order or a
 * consent state: a public endpoint should not pull back more about a person
 * than the write it is about to perform requires.
 */
const LOOKUP = `#graphql
  query CaratFirstAccessCustomer($email: String!) {
    customerByIdentifier(identifier: { emailAddress: $email }) {
      id
      tags
    }
  }`;

/**
 * `owner { ... on Customer { id } }` is requested back so the write can be
 * confirmed to have landed on the EXPECTED customer, not merely on some
 * customer — the same discipline as `luxuryStealMetafieldWriter.server.ts`.
 * A count-only check would let an id-mapping bug attach someone's mobile
 * number to a different person's record and still report success.
 */
const SET_MOBILE = `#graphql
  mutation CaratSetFirstAccessMobile($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields {
        namespace
        key
        owner {
          ... on Customer {
            id
          }
        }
      }
      userErrors { field message code }
    }
  }`;

/**
 * THE PHONE FIELD, written only alongside an SMS opt-in.
 *
 * `customerUpdate` rather than anything narrower because Shopify has no
 * "set just the phone" mutation. The input carries the id and the phone and
 * NOTHING else — no name, no tags, no email — so the blast radius is the one
 * field even though the mutation's name is broad.
 *
 * The phone is read back so the write can be confirmed to have landed on the
 * expected customer with the expected value, the same discipline the metafield
 * write already applies.
 */
const SET_PHONE = `#graphql
  mutation CaratSetFirstAccessPhone($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer {
        id
        defaultPhoneNumber { phoneNumber }
      }
      userErrors { field message }
    }
  }`;

/**
 * SMS MARKETING CONSENT, the native record.
 *
 * SINGLE_OPT_IN is the honest level for a ticked box on a web form: the
 * customer confirmed once, here, and nothing sent them a code to confirm
 * again. Claiming CONFIRMED_OPT_IN would overstate the evidence we hold.
 *
 * `consentUpdatedAt` is passed explicitly rather than left to Shopify's own
 * clock, so the native record and our acknowledgment row carry the SAME
 * instant — two timestamps a second apart on one consent is the kind of
 * discrepancy that makes an audit trail harder to defend than no trail.
 *
 * The state is read back for the same reason as every other write here.
 */
const SET_SMS_CONSENT = `#graphql
  mutation CaratSetFirstAccessSmsConsent($input: CustomerSmsMarketingConsentUpdateInput!) {
    customerSmsMarketingConsentUpdate(input: $input) {
      customer {
        id
        defaultPhoneNumber {
          phoneNumber
          smsMarketingConsent { state optInLevel updatedAt }
        }
      }
      userErrors { field message }
    }
  }`;

/**
 * Every way this can end. The route maps all of them onto one response body —
 * the distinctions are for the log, never for the caller, because a public
 * endpoint that distinguishes "not a customer" from "nothing to change" is a
 * free membership oracle for any address someone cares to try.
 *
 * `sms_consent_rejected` is separated from `write_rejected` because the two
 * need different human responses: the first means a real consent was given
 * and Shopify would not record it, which is a consent we must not lose; the
 * second is a metafield that failed to store a number we still have.
 */
export type FirstAccessWriteOutcome =
  | "stored"
  | "customer_absent"
  | "not_first_access"
  | "write_rejected"
  | "sms_consent_rejected"
  | "unavailable";

/**
 * One Admin API call, with both failure shapes handled.
 *
 * THE SHOPIFY CLIENT THROWS on GraphQL errors — it does not hand them back in
 * the body. Found the hard way: a missing `write_customers` scope produced an
 * unhandled rejection and a 500 on a public endpoint, rather than the logged,
 * contained failure the body check was written for. Both paths now return
 * null, which every caller treats as "unavailable".
 *
 * NOTHING FROM THE ERROR IS LOGGED but the operation name. Shopify's error
 * bodies echo the submitted variables, which here include an address and a
 * mobile number.
 */
async function runGraphql(
  admin: AdminGraphqlClient,
  operation: string,
  query: string,
  variables: Record<string, unknown>
): Promise<Record<string, unknown> | null> {
  try {
    const response = await admin.graphql(query, { variables });
    const body = (await response.json()) as {
      data?: Record<string, unknown>;
      errors?: unknown;
    };
    if (body.errors) {
      logger.error("firstaccess.graphql_error", { operation, shape: "body" });
      return null;
    }
    return body.data ?? null;
  } catch {
    logger.error("firstaccess.graphql_error", { operation, shape: "thrown" });
    return null;
  }
}

/**
 * THE LOOKUP AND THE GATE, exposed so a caller can resolve the customer ONCE.
 *
 * Both writes below, and the route's own evidence records, need the customer
 * gid. Each doing its own lookup meant up to three identical reads of the same
 * record on one signup — cheap individually, but a public endpoint should not
 * do the same work three times, and three reads can disagree if the record
 * changes between them.
 *
 * THE GATE LIVES HERE, not in the caller. `not_first_access` is returned
 * rather than the id, so there is no way to obtain an id for a customer this
 * route may not touch: the blast-radius rule is enforced by what this function
 * hands back, not by the caller remembering to check.
 */
export type FirstAccessCustomerLookup =
  | { readonly kind: "found"; readonly customerId: string }
  | { readonly kind: "customer_absent" }
  | { readonly kind: "not_first_access" }
  | { readonly kind: "unavailable" };

export async function lookupFirstAccessCustomer(
  admin: AdminGraphqlClient,
  email: string
): Promise<FirstAccessCustomerLookup> {
  const found = await runGraphql(admin, "lookup", LOOKUP, { email });
  if (!found) return { kind: "unavailable" };

  const customer = found.customerByIdentifier as
    | { id: string; tags: readonly string[] | null }
    | null;
  if (!customer) return { kind: "customer_absent" };

  // THE BLAST-RADIUS GATE. A customer who never signed up for First Access
  // cannot be touched through this route, however well-formed the request.
  if (!mayWriteToCustomer(customer.tags ?? [])) return { kind: "not_first_access" };

  return { kind: "found", customerId: customer.id };
}

/**
 * Stores the normalised mobile number on the customer's metafield.
 *
 * @param customerId from `lookupFirstAccessCustomer`, which has already
 *                   applied the first-access gate — so this function cannot be
 *                   pointed at an arbitrary customer
 * @param mobileE164 already normalised; never empty — the route makes no call
 *                   at all when the optional field was skipped, which is what
 *                   guarantees an omitted number cannot clear a stored one
 * @returns the outcome, for logging only
 */
export async function storeFirstAccessMobile(
  admin: AdminGraphqlClient,
  customerId: string,
  mobileE164: string
): Promise<FirstAccessWriteOutcome> {
  const customer = { id: customerId };

  const written = await runGraphql(admin, "metafieldsSet", SET_MOBILE, {
    metafields: [
      {
        ownerId: customer.id,
        namespace: FIRST_ACCESS_MOBILE_METAFIELD.namespace,
        key: FIRST_ACCESS_MOBILE_METAFIELD.key,
        type: FIRST_ACCESS_MOBILE_METAFIELD.type,
        value: mobileE164,
      },
    ],
  });
  if (!written) return "unavailable";

  const result = written.metafieldsSet as {
    metafields?: { namespace: string; key: string; owner?: { id?: string } | null }[];
    userErrors?: { message: string }[];
  } | null;

  if (result?.userErrors?.length) {
    logger.warn("firstaccess.metafield_rejected", {
      messages: result.userErrors.map((e) => e.message),
    });
    return "write_rejected";
  }

  // A 200 WITH NO CONFIRMED METAFIELD IS NOT A SUCCESS. Checked explicitly
  // because the Admin API can answer without userErrors and without having
  // done the work, and a silent no-op here loses the number for good.
  const confirmed = (result?.metafields ?? []).some(
    (metafield) =>
      metafield.namespace === FIRST_ACCESS_MOBILE_METAFIELD.namespace &&
      metafield.key === FIRST_ACCESS_MOBILE_METAFIELD.key &&
      metafield.owner?.id === customer.id
  );
  if (!confirmed) {
    logger.error("firstaccess.metafield_unconfirmed", {});
    return "unavailable";
  }

  return "stored";
}

/**
 * Records SMS marketing consent natively: the phone on the account, then the
 * consent against it.
 *
 * ===========================================================================
 * TWO WRITES, AND THE ORDER IS NOT OPTIONAL
 * ===========================================================================
 * Shopify refuses SMS marketing consent for a customer with no phone number
 * on their account — the mutation's own documentation states it. So the phone
 * must land first. If it lands and the consent write then fails, the customer
 * has a phone on file and NO consent, which is the safe direction: a number
 * we may not text is exactly what the pre-2026-11-18 behaviour already was.
 * The reverse order is not expressible, and a combined one does not exist.
 *
 * ===========================================================================
 * CALLED ONLY WHEN THE CUSTOMER TICKED THE BOX
 * ===========================================================================
 * This function does not decide consent, it records it. The caller is
 * responsible for having an explicit opt-in, and the caller must not infer one
 * from the presence of a phone number. Keeping the decision out of here is
 * deliberate: a function that could be called speculatively would eventually
 * be called speculatively.
 *
 * @param consentUpdatedAt the SAME instant written to our own acknowledgment
 *                         row, so the native record and the evidence agree
 */
export async function recordFirstAccessSmsConsent(
  admin: AdminGraphqlClient,
  customerId: string,
  mobileE164: string,
  consentUpdatedAt: Date
): Promise<FirstAccessWriteOutcome> {
  // Already gated by `lookupFirstAccessCustomer`; see its comment for why the
  // gate cannot be bypassed by calling this directly with any id.
  const customer = { id: customerId };

  // ---- 1. the phone, which the consent cannot exist without ---------------
  const phoneWritten = await runGraphql(admin, "customerUpdate", SET_PHONE, {
    input: { id: customer.id, phone: mobileE164 },
  });
  if (!phoneWritten) return "unavailable";

  const phoneResult = phoneWritten.customerUpdate as {
    customer?: { id: string; defaultPhoneNumber?: { phoneNumber?: string | null } | null } | null;
    userErrors?: { field?: string[] | null; message: string }[];
  } | null;

  if (phoneResult?.userErrors?.length) {
    // A REJECTED PHONE IS A REJECTED CONSENT, and it is logged loudly because
    // the customer asked to be texted and we could not arrange it. The most
    // likely cause is a number Shopify will not accept, which is a thing to
    // fix in validation rather than to retry.
    logger.warn("firstaccess.sms_phone_rejected", {
      messages: phoneResult.userErrors.map((e) => e.message),
    });
    return "sms_consent_rejected";
  }
  if (phoneResult?.customer?.id !== customer.id) {
    logger.error("firstaccess.sms_phone_unconfirmed", {});
    return "unavailable";
  }

  // ---- 2. the consent itself ----------------------------------------------
  const consentWritten = await runGraphql(admin, "customerSmsMarketingConsentUpdate", SET_SMS_CONSENT, {
    input: {
      customerId: customer.id,
      smsMarketingConsent: {
        marketingState: "SUBSCRIBED",
        // Honest about what we hold: one ticked box on one web form, with no
        // second confirmation step. See SET_SMS_CONSENT.
        marketingOptInLevel: "SINGLE_OPT_IN",
        consentUpdatedAt: consentUpdatedAt.toISOString(),
      },
    },
  });
  if (!consentWritten) return "unavailable";

  const consentResult = consentWritten.customerSmsMarketingConsentUpdate as {
    customer?: {
      id: string;
      defaultPhoneNumber?: { smsMarketingConsent?: { state?: string | null } | null } | null;
    } | null;
    userErrors?: { field?: string[] | null; message: string }[];
  } | null;

  if (consentResult?.userErrors?.length) {
    logger.warn("firstaccess.sms_consent_rejected", {
      messages: consentResult.userErrors.map((e) => e.message),
    });
    return "sms_consent_rejected";
  }

  // A 200 THAT DID NOT SUBSCRIBE IS NOT A SUCCESS. The same reasoning as the
  // metafield confirmation: the Admin API can answer cleanly without having
  // done the work, and an unrecorded consent means we either never text a
  // customer who asked us to, or — far worse — believe we may.
  const state = consentResult?.customer?.defaultPhoneNumber?.smsMarketingConsent?.state;
  if (consentResult?.customer?.id !== customer.id || state !== "SUBSCRIBED") {
    logger.error("firstaccess.sms_consent_unconfirmed", { state: state ?? null });
    return "unavailable";
  }

  return "stored";
}
