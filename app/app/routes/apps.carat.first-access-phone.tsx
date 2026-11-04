/**
 * POST /apps/carat/first-access-phone
 *
 * Stores the optional mobile number from the First Access signup on the
 * Shopify customer the native form just created.
 *
 * A RESOURCE ROUTE — no default export, same as every other `apps.carat.*`.
 *
 * ===========================================================================
 * WHY A ROUTE EXISTS FOR ONE FIELD
 * ===========================================================================
 * Shopify's `{% form 'customer' %}` persists email, first name, last name and
 * tags, and DISCARDS `contact[phone]` — measured with a real signup on
 * 2026-11-04. Rather than replace a working, captcha-protected form, the theme
 * posts to it as before and then calls this route to add the one thing it
 * dropped. The form stays native; the gap is the only custom part.
 *
 * ===========================================================================
 * THE SECURITY POSTURE, BECAUSE THIS IS REACHABLE BY ANYONE
 * ===========================================================================
 *   1. The app-proxy HMAC must verify. Shopify signs the forwarded request;
 *      an unsigned POST straight at Fly is rejected before the body is read.
 *   2. The customer must already carry `first-access`. A real order-placing
 *      customer who never signed up here cannot be reached through this route
 *      at all (`mayWriteToCustomer`).
 *   3. Two rate limits — per email and overall. The per-email one stops a
 *      single record being hammered; the global one bounds total writes.
 *      Note the proxy means `x-forwarded-for` is SHOPIFY's edge, not the
 *      visitor's, so a per-IP limit would be theatre. Email is the only
 *      meaningful key available.
 *   4. Nothing can be cleared and no tag can be removed — see
 *      `planCustomerWrite` and `firstAccessCustomer.server`.
 *   5. One response body for every outcome. "Customer not found", "not a
 *      First Access signup" and "nothing to change" are indistinguishable
 *      from outside, so the endpoint cannot be used to ask whether an address
 *      is on file.
 *
 * ===========================================================================
 * NO SMS CONSENT IS SET OR IMPLIED
 * ===========================================================================
 * `smsMarketingConsent` is never written, here or anywhere this calls. The
 * number is stored; permission to text it is a separate, unchecked control
 * with its own disclosure, to be built when the SMS platform is chosen. Pinned
 * by `app/domain/firstaccess/firstAccessPhoneFence.test.ts`.
 */
import type { ActionFunctionArgs } from "react-router";

import {
  normaliseEmail,
  normaliseName,
  normalisePhone,
  selectedInterestTags,
} from "~/domain/firstaccess/phoneCapture";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { createRateLimiter } from "~/lib/rateLimit.server";
import { applyFirstAccessSignup } from "~/shopify/admin/firstAccessCustomer.server";
import { adminClientForShop } from "~/shopify/admin/offlineClient.server";
import { verifyAppProxySignature } from "~/shopify/proxy";

/**
 * Three attempts per address per ten minutes: enough for a visitor who
 * mistypes their number and resubmits, far short of useful for anyone
 * rewriting a record repeatedly.
 */
const perEmail = createRateLimiter({ limit: 3, windowMs: 10 * 60_000, maxKeys: 5_000 });
/**
 * A ceiling on the whole endpoint. A landing page converting 120 signups a
 * minute is a success nobody has had yet; past that, something is wrong and
 * refusing is the right answer.
 */
const overall = createRateLimiter({ limit: 120, windowMs: 60_000, maxKeys: 1 });

/**
 * The ONLY body this route ever returns on an authenticated request.
 *
 * It does not report whether a customer was found, matched, changed or
 * skipped. The theme does not act on the answer — the signup already
 * succeeded by the time this runs — so there is nothing to gain from saying
 * more, and an endpoint that distinguishes outcomes by email is a membership
 * oracle.
 */
const ACCEPTED = { ok: true } as const;

/**
 * THERE IS NO READ HERE, AND THE REFUSAL IS EXPLICIT.
 *
 * Without a loader, React Router answers a GET with an internal error and a
 * stack trace in the app log — noise that looks like a fault every time a
 * crawler or a preview fetcher touches the URL. More importantly, a read
 * endpoint would have to decide who may ask whether an address is on file,
 * and the answer is nobody.
 */
export async function loader() {
  return Response.json({ error: "method_not_allowed" }, { status: 405 });
}

export async function action({ request }: ActionFunctionArgs) {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const url = new URL(request.url);
  const { verified, shop, reason } = verifyAppProxySignature(
    url.searchParams,
    getEnv().SHOPIFY_API_SECRET,
    getEnv().SHOPIFY_SHOP_DOMAIN
  );
  if (!verified) {
    logger.warn("firstaccess.proxy_rejected", { reason, signedShop: shop });
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  if (!overall.hit("all").allowed) {
    logger.warn("firstaccess.rate_limited", { scope: "overall" });
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return Response.json({ error: "invalid_submission" }, { status: 400 });
  }

  const email = normaliseEmail(String(body.email ?? ""));
  if (!email) return Response.json({ error: "invalid_submission" }, { status: 400 });

  // Keyed AFTER the address is normalised, so differences in letter case and
  // surrounding whitespace share one budget rather than each spelling of the
  // same address getting its own.
  if (!perEmail.hit(email).allowed) {
    logger.warn("firstaccess.rate_limited", { scope: "email" });
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

  // THE OPTIONAL FIELD STAYS OPTIONAL. A number that fails normalisation is
  // dropped, not escalated to an error: the signup has already succeeded and
  // the visitor has moved on, so failing the request would only produce a
  // console error on a page that is working.
  const rawPhone = String(body.phone ?? "");
  const phoneResult = normalisePhone(rawPhone);
  const phoneE164 = phoneResult.ok ? phoneResult.e164 : null;
  if (!phoneResult.ok && phoneResult.reason !== "empty") {
    // The REASON, never the number.
    logger.info("firstaccess.phone_discarded", { reason: phoneResult.reason });
  }

  const interests = Array.isArray(body.interests)
    ? selectedInterestTags(body.interests.map((value) => String(value)))
    : [];

  /**
   * THE SHOP COMES FROM THE SIGNED REQUEST, not from configuration.
   *
   * `verifyAppProxySignature` has already bound the signed `shop` to the
   * configured one and fails closed when either is missing, so by here it is
   * both present and correct. The app is installed on two stores; taking it
   * from the verified request is what keeps a dev-store signup from writing
   * to a production customer.
   */
  const admin = shop ? await adminClientForShop(shop) : null;
  if (!admin) {
    logger.error("firstaccess.no_offline_session", {});
    // Still 200: the customer exists and the signup worked. The missing piece
    // is ours to fix, and telling the visitor their signup failed would be
    // false.
    return Response.json(ACCEPTED, { status: 200 });
  }

  const outcome = await applyFirstAccessSignup(admin, email, {
    firstName: normaliseName(String(body.firstName ?? "")),
    lastName: normaliseName(String(body.lastName ?? "")),
    phoneE164,
    interests,
  });

  // NO EMAIL, NO NAME, NO NUMBER in the log line. The outcome and whether a
  // number was present are enough to tell whether the feature is working;
  // CLAUDE.md "Log important business events without ... unnecessary
  // sensitive payment data", and a lead's mobile number qualifies.
  // Derived BEFORE the call so no PII-bearing identifier appears inside a
  // `logger.*(...)` expression at all. That lets the fence forbid the names
  // outright instead of judging what each use does with them.
  const hadPhone = phoneE164 !== null;
  logger.info("firstaccess.signup_applied", {
    outcome,
    hadPhone,
    interestCount: interests.length,
  });

  return Response.json(ACCEPTED, { status: 200 });
}
