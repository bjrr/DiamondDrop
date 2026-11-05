/**
 * The one Shopify write behind the First Access mobile number.
 *
 * ===========================================================================
 * WHAT IT DOES AND, MORE IMPORTANTLY, WHAT IT CANNOT DO
 * ===========================================================================
 * It finds a customer Shopify has ALREADY created from the native signup form
 * and sets ONE text metafield on it: `custom.first_access_mobile`.
 *
 * That is the entire surface. It cannot create a customer, cannot delete one,
 * cannot touch `Customer.phone`, cannot change a name, cannot add or remove a
 * tag, and cannot set marketing consent of any kind. Those are not omissions:
 * `write_customers` is the scope Shopify requires for ANY customer write,
 * including a metafield, so the only honest way to keep the grant narrow is
 * for the code it authorises to be this small. Pinned by
 * `firstAccessPhoneFence.test.ts`, which fails if a second mutation appears.
 *
 * Owner decision 2026-11-05 replaced an earlier `Customer.phone` +
 * `customerUpdate` + `tagsAdd` implementation with this. Names, interests and
 * the `first-access` tag all persist through the native customer form and are
 * none of this module's business.
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
 * Every way this can end. The route maps all of them onto one response body —
 * the distinctions are for the log, never for the caller, because a public
 * endpoint that distinguishes "not a customer" from "nothing to change" is a
 * free membership oracle for any address someone cares to try.
 */
export type FirstAccessWriteOutcome =
  | "stored"
  | "customer_absent"
  | "not_first_access"
  | "write_rejected"
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
 * Stores the normalised mobile number on the customer's metafield.
 *
 * @param email already normalised; used verbatim as the lookup identifier
 * @param mobileE164 already normalised; never empty — the route makes no call
 *                   at all when the optional field was skipped, which is what
 *                   guarantees an omitted number cannot clear a stored one
 * @returns the outcome, for logging only
 */
export async function storeFirstAccessMobile(
  admin: AdminGraphqlClient,
  email: string,
  mobileE164: string
): Promise<FirstAccessWriteOutcome> {
  const found = await runGraphql(admin, "lookup", LOOKUP, { email });
  if (!found) return "unavailable";

  const customer = found.customerByIdentifier as
    | { id: string; tags: readonly string[] | null }
    | null;
  if (!customer) return "customer_absent";

  // THE BLAST-RADIUS GATE. A customer who never signed up for First Access
  // cannot be touched through this route, however well-formed the request.
  if (!mayWriteToCustomer(customer.tags ?? [])) return "not_first_access";

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
