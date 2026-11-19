/**
 * POST /apps/carat/first-access-phone
 *
 * Stores the optional mobile number from the First Access signup as a text
 * metafield on the Shopify customer the native form just created.
 *
 * A RESOURCE ROUTE — no default export, same as every other `apps.carat.*`.
 *
 * ===========================================================================
 * WHY A ROUTE EXISTS FOR ONE FIELD
 * ===========================================================================
 * Shopify's `{% form 'customer' %}` persists email, first name, last name and
 * tags, and DISCARDS `contact[phone]` — measured with a real signup on
 * 2026-11-04. Rather than replace a working, captcha-protected form, the theme
 * posts to it as before and then calls this route with the one thing it
 * dropped. Email, names, the `first-access` tag and the interest tags never
 * pass through here at all: they already persist natively, and re-sending them
 * would mean a public endpoint could change them.
 *
 * SINCE 2026-11-18 IT ALSO CARRIES THE TWO MARKETING CONSENTS, which is why
 * the file is no longer only about a phone number. The name is kept so the
 * live theme's endpoint does not move; renaming a public URL to match a
 * widened purpose would strand every cached page mid-signup.
 *
 * THE NUMBER IS DATA UNLESS IT COMES WITH PERMISSION. Every usable number is
 * still written to `custom.first_access_mobile` (owner decision 2026-11-05).
 * `Customer.phone` and `smsMarketingConsent` are written ONLY when the
 * customer ticked the SMS opt-in — Shopify requires a phone on the account
 * before it will hold an SMS consent at all, so the two travel together or not
 * at all. See `firstAccessCustomer.server.ts` for the full reasoning on which
 * half of 2026-11-05 expired and which half did not.
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
 *   4. One metafield is the whole write surface. Nothing else about the
 *      customer can be read or changed — see `firstAccessCustomer.server`.
 *   5. One response body for every outcome. "Customer not found", "not a
 *      First Access signup" and "stored" are indistinguishable from outside,
 *      so the endpoint cannot be used to ask whether an address is on file.
 *
 * ===========================================================================
 * A PHONE NUMBER IS STILL NOT CONSENT TO TEXT
 * ===========================================================================
 * This is the rule the 2026-11-18 change was most careful not to break. SMS
 * consent is written if and only if the request carries `smsConsent: true`,
 * which the theme sets from a SEPARATE, UNCHECKED checkbox carrying its own
 * disclosure (frequency, rates, STOP). It is never inferred from the presence
 * of a number, never inherited from the email opt-in, and a request that
 * supplies a number with no SMS flag produces exactly the pre-2026-11-18
 * outcome: metafield written, no `Customer.phone`, no consent.
 *
 * The consents are read as STRICT `=== true`, so no truthy near-miss can
 * become a permission. Pinned by
 * `app/domain/firstaccess/firstAccessPhoneFence.test.ts`.
 */
import type { ActionFunctionArgs } from "react-router";

import { normaliseEmail, normalisePhone } from "~/domain/firstaccess/phoneCapture";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { createRateLimiter } from "~/lib/rateLimit.server";
import { FIRST_ACCESS_CONSENT_COPY_VERSION } from "~/domain/firstaccess/marketingConsentCopy";
import { recordMarketingConsentEvidence } from "~/domain/firstaccess/marketingConsentEvidence.server";
import { buildSignupConfirmationSms } from "~/domain/firstaccess/signupSms";
import { resolveSmsPort } from "~/lib/sms/configuredPort.server";
import {
  lookupFirstAccessCustomer,
  recordFirstAccessSmsConsent,
  storeFirstAccessMobile,
} from "~/shopify/admin/firstAccessCustomer.server";
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
 * It does not report whether a customer was found, matched or written. The
 * theme does not act on the answer — the signup already succeeded by the time
 * this runs — so there is nothing to gain from saying more, and an endpoint
 * that distinguishes outcomes by email is a membership oracle.
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

  /**
   * ==========================================================================
   * THE TWO CONSENTS (owner decision 2026-11-18)
   * ==========================================================================
   * Read as STRICT booleans. `=== true` rather than anything truthy, because
   * every other spelling a client might send — "true", 1, "on", "yes" — is a
   * client being imprecise about a marketing permission, and the safe reading
   * of an imprecise consent is no consent. A missing field is no consent.
   *
   * EMAIL CONSENT IS NOT ACTED ON HERE, only evidenced. Shopify has already
   * recorded it (or not) from the native form's `contact[accepts_marketing]`
   * checkbox, which is the authority: this flag tells us only whether to write
   * OUR OWN proof of the wording alongside it. If the two ever disagreed,
   * Shopify's is the one that governs what we may send.
   *
   * SMS CONSENT IS ACTED ON, because the native form cannot carry it — Shopify
   * has no `contact[...]` field for SMS marketing, so without this there is no
   * route by which a customer could ever authorise a text.
   */
  const emailConsent = body.emailConsent === true;
  const smsConsent = body.smsConsent === true;
  const clientCopyVersion = typeof body.consentCopyVersion === "string" ? body.consentCopyVersion : null;

  // A stale cached page can genuinely render last week's wording, so this is
  // logged rather than refused — but it is logged, because a steady stream of
  // mismatches means customers are being shown wording we no longer consider
  // current. The server always records against its own version regardless; a
  // client must never choose which policy it is consenting to.
  if (clientCopyVersion !== null && clientCopyVersion !== FIRST_ACCESS_CONSENT_COPY_VERSION) {
    logger.warn("firstaccess.consent_copy_version_mismatch", {
      client: clientCopyVersion,
      server: FIRST_ACCESS_CONSENT_COPY_VERSION,
    });
  }

  /**
   * NO NUMBER MEANS NO WRITE — the guarantee that an omitted phone can never
   * clear a stored one. There is no "clear" branch anywhere in this feature:
   * the only call the adapter exposes takes a non-empty E.164 string, so
   * erasure is unreachable by construction rather than by a guard someone
   * could later invert.
   *
   * The theme already declines to call this endpoint when the field is blank;
   * this is the server-side half of the same rule, because the theme is not
   * the authority on anything.
   */
  const phoneResult = normalisePhone(String(body.phone ?? ""));
  if (!phoneResult.ok) {
    // The REASON, never the number. `empty` is not logged at all: a blank
    // optional field is the normal case, not an event.
    if (phoneResult.reason !== "empty") {
      logger.info("firstaccess.phone_discarded", { reason: phoneResult.reason });
    }
  }

  /**
   * NO LONGER AN EARLY RETURN WHEN THE PHONE IS ABSENT (owner 2026-11-18).
   *
   * It used to be: no number meant nothing to do, so the route stopped here.
   * That is now wrong, because an email-only signup still carries an EMAIL
   * CONSENT whose wording has to be evidenced — and a customer who opts into
   * email and skips the mobile field is the common case, so stopping here
   * would have lost the evidence for most subscribers.
   *
   * There is still nothing to do when the request carries neither a usable
   * number nor any consent, and that case exits below rather than touching
   * Shopify.
   */
  if (!phoneResult.ok && !emailConsent && !smsConsent) {
    return Response.json(ACCEPTED, { status: 200 });
  }

  // SMS CONSENT WITHOUT A NUMBER IS NOT RECORDABLE, and must not be silently
  // dropped either. Shopify refuses SMS marketing consent for a customer with
  // no phone on the account, so there is nothing to write; the theme validates
  // this before submitting, and this is the server-side half of the same rule.
  // Logged because a real one reaching here means the form let it through.
  if (smsConsent && !phoneResult.ok) {
    logger.warn("firstaccess.sms_consent_without_number", {
      reason: phoneResult.ok ? "none" : phoneResult.reason,
    });
  }

  // Keyed AFTER the address is normalised, so differences in letter case and
  // surrounding whitespace share one budget rather than each spelling of the
  // same address getting its own. Checked after validation so a malformed
  // submission cannot burn a real visitor's retries.
  if (!perEmail.hit(email).allowed) {
    logger.warn("firstaccess.rate_limited", { scope: "email" });
    return Response.json({ error: "rate_limited" }, { status: 429 });
  }

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

  // ONE LOOKUP FOR EVERYTHING THAT FOLLOWS. The gate is applied inside it, so
  // a customer who never signed up for First Access yields no id and therefore
  // no write and no evidence row.
  const lookup = await lookupFirstAccessCustomer(admin, email);
  if (lookup.kind !== "found") {
    // Indistinguishable from success to the caller — see ACCEPTED's comment.
    logger.info("firstaccess.lookup_declined", { kind: lookup.kind });
    return Response.json(ACCEPTED, { status: 200 });
  }
  const customerId = lookup.customerId;

  /**
   * ONE INSTANT FOR THE WHOLE SIGNUP. Shopify's native consent record and our
   * acknowledgment rows all carry this same value, so an audit cannot turn up
   * two timestamps a second apart for one consent — which is the kind of
   * discrepancy that makes a trail harder to defend than no trail at all.
   */
  const consentedAt = new Date();

  // ---- EMAIL: evidence only. Shopify already holds the permission. --------
  if (emailConsent) {
    const evidence = await recordMarketingConsentEvidence({
      channel: "email",
      customerRef: customerId,
      consentedAt,
      sourceIp: null,
      userAgent: request.headers.get("user-agent"),
    });
    logger.info("firstaccess.email_consent_evidence", { outcome: evidence.outcome });
  }

  // ---- The number itself, consent or not. --------------------------------
  // Unchanged behaviour: every usable number given is captured to the
  // metafield. This is the half of owner decision 2026-11-05 that still holds.
  if (phoneResult.ok) {
    const outcome = await storeFirstAccessMobile(admin, customerId, phoneResult.e164);
    // NO EMAIL AND NO NUMBER in the log line. The outcome alone is enough to
    // tell whether the feature is working; CLAUDE.md "Minimize PII", and a
    // lead's mobile number qualifies.
    logger.info("firstaccess.mobile_stored", { outcome });
  }

  // ---- SMS: the permission AND the evidence. -----------------------------
  if (smsConsent && phoneResult.ok) {
    const outcome = await recordFirstAccessSmsConsent(
      admin,
      customerId,
      phoneResult.e164,
      consentedAt
    );
    logger.info("firstaccess.sms_consent", { outcome });

    /**
     * EVIDENCE ONLY IF SHOPIFY ACTUALLY RECORDED THE CONSENT.
     *
     * The order matters and is the opposite of the intuitive one. Writing our
     * proof first would leave, on a Shopify failure, an acknowledgment row
     * asserting a subscription that does not exist — a record that would
     * later be read as permission to text someone Shopify has no consent
     * for. A consent Shopify refused is a consent we do not hold, however
     * sincerely the customer gave it, and the honest state is to have neither
     * half rather than a confident half.
     *
     * The customer is not misled by this: the SMS box was ticked, so the
     * failure is ours to fix from the logged outcome, and until it is fixed
     * nothing texts them.
     */
    if (outcome === "stored") {
      const evidence = await recordMarketingConsentEvidence({
        channel: "sms",
        customerRef: customerId,
        consentedAt,
        sourceIp: null,
        userAgent: request.headers.get("user-agent"),
      });
      logger.info("firstaccess.sms_consent_evidence", { outcome: evidence.outcome });

      /**
       * THE CONFIRMATION TEXT, sent at the one moment consent is a known fact.
       *
       * This is why it is here and not on the `customers/create` webhook that
       * sends the confirmation EMAIL: at webhook time the SMS consent does not
       * exist yet, because it arrives on this separate request. A handler
       * asking "does this customer have SMS consent?" there would be racing
       * the request that grants it. See `signupSms.ts`.
       *
       * UNCONFIGURED IS NOT A FAILURE. There is no SMS provider yet —
       * credentials are an owner action — so this normally logs a reason and
       * moves on. The consent is already recorded either way, which is the
       * point of doing it in this order: the customer is properly subscribed
       * today and becomes reachable the moment a provider exists, rather than
       * being asked again later because we declined to write down what they
       * had already told us.
       *
       * A SEND FAILURE NEVER UNDOES THE CONSENT. They asked to be texted; that
       * permission stands whether or not the first text got through.
       */
      try {
        const sms = resolveSmsPort();
        if (!sms.configured) {
          logger.warn("firstaccess.sms_confirmation_unconfigured", { reason: sms.reason });
        } else {
          const content = buildSignupConfirmationSms();
          const sent = await sms.port.send({ to: phoneResult.e164, body: content.body });
          logger.info("firstaccess.sms_confirmation_sent", {
            providerMessageId: sent.providerMessageId ?? null,
          });
        }
      } catch (error) {
        // THE NUMBER IS NEVER LOGGED, here or anywhere in this route.
        logger.error("firstaccess.sms_confirmation_failed", {
          errorName: error instanceof Error ? error.name : "unknown",
        });
      }
    }
  }

  return Response.json(ACCEPTED, { status: 200 });
}
