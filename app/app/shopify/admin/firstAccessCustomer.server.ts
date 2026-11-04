/**
 * The one Shopify write behind the First Access signup.
 *
 * ===========================================================================
 * WHAT IT DOES AND, MORE IMPORTANTLY, WHAT IT CANNOT DO
 * ===========================================================================
 * It finds a customer Shopify has ALREADY created from the native signup form
 * and fills in what that form dropped. It cannot create a customer, cannot
 * delete one, cannot clear a field, and cannot remove a tag. Those are not
 * omissions — see each guard below.
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
 *
 * TAGS GO THROUGH `tagsAdd`, NEVER `CustomerInput.tags`. The input field
 * REPLACES the whole tag set; from a public endpoint that would be a way to
 * strip `vip` or `wholesale` off a customer by knowing their email address.
 */
import type { AdminGraphqlClient } from "./productClient.server";
import {
  mayWriteToCustomer,
  planCustomerWrite,
  type SubmittedSignup,
} from "~/domain/firstaccess/phoneCapture";
import { logger } from "~/lib/logger.server";

const LOOKUP = `
  query FirstAccessCustomerByEmail($email: String!) {
    customerByIdentifier(identifier: { emailAddress: $email }) {
      id
      firstName
      lastName
      tags
      defaultPhoneNumber {
        phoneNumber
      }
    }
  }
`;

const UPDATE = `
  mutation FirstAccessCustomerUpdate($input: CustomerInput!) {
    customerUpdate(input: $input) {
      customer { id }
      userErrors { field message }
    }
  }
`;

const ADD_TAGS = `
  mutation FirstAccessCustomerTagsAdd($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) {
      userErrors { field message }
    }
  }
`;

/**
 * Every way this can end. The route maps all of them onto one response body —
 * the distinctions are for the log, never for the caller, because a public
 * endpoint that distinguishes "not a customer" from "nothing to change" is a
 * free membership oracle for any address someone cares to try.
 */
export type FirstAccessWriteOutcome =
  | "updated"
  | "already_current"
  | "customer_absent"
  | "not_first_access"
  | "write_rejected"
  | "unavailable";

interface LookupResult {
  readonly id: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly tags: readonly string[];
  /**
   * `Customer.phone` is DEPRECATED on reads in Admin API 2026-10 in favour of
   * this. The write side still uses `CustomerInput.phone`, which is current —
   * the asymmetry is Shopify's, not a mistake here.
   */
  readonly defaultPhoneNumber: { readonly phoneNumber: string } | null;
}

/**
 * One Admin API call, with both failure shapes handled.
 *
 * THE SHOPIFY CLIENT THROWS on GraphQL errors — it does not hand them back in
 * the body. Found the hard way: a missing `write_customers` scope produced an
 * unhandled rejection and a 500 on a public endpoint, rather than the logged,
 * contained failure the body check was written for. Both paths now return
 * null, which every caller already treats as "unavailable".
 *
 * NOTHING FROM THE ERROR IS LOGGED but the operation name. Shopify's error
 * bodies echo the submitted variables, which here include an address, a name
 * and a mobile number.
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
 * Fills in what the native form dropped.
 *
 * @param email already normalised; used verbatim as the lookup identifier
 * @returns the outcome, for logging only
 */
export async function applyFirstAccessSignup(
  admin: AdminGraphqlClient,
  email: string,
  submitted: SubmittedSignup
): Promise<FirstAccessWriteOutcome> {
  const found = await runGraphql(admin, "lookup", LOOKUP, { email });
  if (!found) return "unavailable";

  const customer = found.customerByIdentifier as LookupResult | null;
  if (!customer) return "customer_absent";

  const existing = {
    firstName: customer.firstName,
    lastName: customer.lastName,
    phone: customer.defaultPhoneNumber?.phoneNumber ?? null,
    tags: customer.tags ?? [],
  };

  // THE BLAST-RADIUS GATE. See `mayWriteToCustomer`: a customer who never
  // signed up for First Access cannot be touched through this route, however
  // well-formed the request.
  if (!mayWriteToCustomer(existing)) return "not_first_access";

  const plan = planCustomerWrite(existing, submitted);
  if (plan.isNoop) return "already_current";

  if (Object.keys(plan.fields).length > 0) {
    const updated = await runGraphql(admin, "update", UPDATE, {
      input: { id: customer.id, ...plan.fields },
    });
    if (!updated) return "unavailable";
    const result = updated.customerUpdate as { userErrors?: { message: string }[] } | null;
    if (result?.userErrors?.length) {
      // Shopify rejects numbers it cannot parse as dialable. That is a bad
      // submission, not an outage, and the only thing worth keeping is which
      // field failed — never the value.
      logger.warn("firstaccess.customer_update_rejected", {
        fields: Object.keys(plan.fields),
        messages: result.userErrors.map((e) => e.message),
      });
      return "write_rejected";
    }
  }

  if (plan.tagsToAdd.length > 0) {
    const tagged = await runGraphql(admin, "tagsAdd", ADD_TAGS, {
      id: customer.id,
      tags: plan.tagsToAdd,
    });
    if (!tagged) return "unavailable";
    const result = tagged.tagsAdd as { userErrors?: { message: string }[] } | null;
    if (result?.userErrors?.length) {
      logger.warn("firstaccess.tags_add_rejected", {
        messages: result.userErrors.map((e) => e.message),
      });
      return "write_rejected";
    }
  }

  return "updated";
}
