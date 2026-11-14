import { timingSafeEqual } from "node:crypto";

import type { ActionFunctionArgs } from "react-router";

import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { adminClientForShop } from "~/shopify/admin/offlineClient.server";
import {
  FIRST_ACCESS_TAG,
  handleFirstAccessSignupWebhook,
} from "~/shopify/webhooks/firstAccessSignupHandler.server";

/**
 * Sends the Launching Soon confirmation to people who signed up BEFORE the
 * `customers/create` webhook existed, and who therefore received nothing.
 *
 * ===========================================================================
 * IT REUSES THE WEBHOOK HANDLER RATHER THAN REIMPLEMENTING IT
 * ===========================================================================
 * The owner's requirement was that a backfilled send be recorded through the
 * same idempotency tracking as a live one, so that a later retry -- or a
 * redelivery of a real webhook for the same customer -- cannot send a second
 * copy.
 *
 * The only way to guarantee that is to call the same function. This route
 * reconstructs the payload Shopify would have delivered and hands it to
 * `handleFirstAccessSignupWebhook`, so the copy, the recipient, the tag
 * gate, the `failed`/`succeeded`/`in_doubt` rules and the idempotency keys
 * are all literally the same code. A second implementation would have its
 * own keys, and "do not send duplicates" would quietly become untrue.
 *
 * ===========================================================================
 * WHO IT WILL CONTACT, AND WHO IT WILL NOT
 * ===========================================================================
 * Three independent conditions, all required:
 *
 *   1. The customer carries the `first-access` tag. Enforced TWICE: in the
 *      Shopify query, and again inside the handler, which refuses anything
 *      untagged. The store's own `orders@caratforus.com` customer record has
 *      no tags and is excluded by both.
 *   2. The customer was created BEFORE `createdBefore`. Anyone who signed up
 *      after the webhook went live has already been emailed by it, and the
 *      idempotency key would stop a second send anyway -- this is the belt
 *      to that brace.
 *   3. No successful send is already recorded. That is the handler's own
 *      check, not this route's.
 *
 * `dryRun` is the default. The route reports exactly who it WOULD contact
 * and sends nothing until it is called again with `dryRun: false`, because
 * the failure mode here is mailing a stranger and there is no undo.
 */

const CRON_SECRET_HEADER = "x-carat-cron-secret";

/**
 * First letter, last letter, domain -- enough to recognise a record in a
 * report, not enough to be personal information in a log.
 *
 * No worked example is spelled out here: `customerFacingEmailDomain.test.ts`
 * fences every address literal in production code to @caratforus.com, and an
 * illustrative one in a comment trips it. The fence is right and the comment
 * was the thing to change.
 */
function maskEmail(email: string): string {
  const [local = "", domain = ""] = email.split("@");
  if (local.length <= 2) return `${local.slice(0, 1)}***@${domain}`;
  return `${local.slice(0, 1)}***${local.slice(-1)}@${domain}`;
}

const CUSTOMERS_QUERY = `#graphql
  query FirstAccessBackfill($query: String!) {
    customers(first: 50, query: $query) {
      nodes {
        id
        firstName
        lastName
        createdAt
        tags
        defaultEmailAddress { emailAddress }
        metafield(namespace: "custom", key: "first_access_mobile") { value }
      }
    }
  }
`;

interface ShopifyCustomerNode {
  id: string;
  firstName: string | null;
  lastName: string | null;
  createdAt: string;
  tags: string[];
  defaultEmailAddress: { emailAddress: string | null } | null;
  metafield: { value: string | null } | null;
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }
  if (!isAuthorised(request)) {
    return Response.json({ error: "unauthorised" }, { status: 401 });
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    /* An empty body is a dry run, which is the safe default. */
  }

  const dryRun = body.dryRun !== false;
  const createdBefore =
    typeof body.createdBefore === "string" && body.createdBefore.trim() !== ""
      ? body.createdBefore.trim()
      : null;
  if (!createdBefore) {
    return Response.json(
      { error: "createdBefore is required, as an ISO date. It is the cutoff that keeps this from re-mailing live signups." },
      { status: 400 }
    );
  }

  const { SHOPIFY_SHOP_DOMAIN } = getEnv();
  if (!SHOPIFY_SHOP_DOMAIN) {
    return Response.json({ error: "missing SHOPIFY_SHOP_DOMAIN" }, { status: 500 });
  }
  const admin = await adminClientForShop(SHOPIFY_SHOP_DOMAIN);
  if (!admin) return Response.json({ error: "no_offline_session" }, { status: 503 });

  const response = await admin.graphql(CUSTOMERS_QUERY, {
    variables: { query: `tag:${FIRST_ACCESS_TAG} AND created_at:<'${createdBefore}'` },
  });
  const json = (await response.json()) as { data?: { customers?: { nodes?: ShopifyCustomerNode[] } } };
  const candidates = json.data?.customers?.nodes ?? [];

  const results: Record<string, unknown>[] = [];

  for (const customer of candidates) {
    const email = customer.defaultEmailAddress?.emailAddress ?? "";
    const tags = (customer.tags ?? []).map((t) => t.toLowerCase());

    // THE QUERY ALREADY FILTERED, AND THIS CHECKS AGAIN. A search-index
    // filter is not a guarantee: `customersCount` for this very tag reported
    // two records when only one carries it, which is exactly the kind of
    // looseness that must not decide who gets emailed.
    if (email === "" || !tags.includes(FIRST_ACCESS_TAG)) {
      results.push({ id: customer.id, skipped: "not_a_first_access_signup" });
      continue;
    }

    const numericId = customer.id.split("/").pop() ?? customer.id;
    const payload = {
      id: numericId,
      email,
      first_name: customer.firstName,
      last_name: customer.lastName,
      // The mobile lives in the metafield, which is where the signup form's
      // own proxy call put it; Shopify's native customer form discards
      // `contact[phone]` entirely.
      phone: customer.metafield?.value ?? null,
      tags: customer.tags.join(","),
    };

    if (dryRun) {
      results.push({
        email: maskEmail(email),
        createdAt: customer.createdAt,
        firstName: customer.firstName,
        hasPhone: Boolean(customer.metafield?.value),
        wouldSend: true,
      });
      continue;
    }

    const outcome = await handleFirstAccessSignupWebhook({
      shopifyEventId: `backfill:${numericId}`,
      topic: "customers/create",
      shopDomain: SHOPIFY_SHOP_DOMAIN,
      rawBody: JSON.stringify(payload),
      payload,
    });

    results.push({
      email: maskEmail(email),
      createdAt: customer.createdAt,
      confirmationSent: outcome.confirmationSent,
      notificationSent: outcome.notificationSent,
      skipped: outcome.skipped ? outcome.reason : undefined,
    });
  }

  logger.info("firstaccess.backfill_run", {
    dryRun,
    candidates: candidates.length,
    processed: results.length,
  });

  return Response.json({ dryRun, createdBefore, candidates: candidates.length, results });
}

function isAuthorised(request: Request): boolean {
  const presented = request.headers.get(CRON_SECRET_HEADER);
  if (presented === null) return false;
  const { CRON_SECRET } = getEnv();
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(CRON_SECRET, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}
