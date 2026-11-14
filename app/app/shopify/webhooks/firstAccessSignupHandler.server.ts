import { idempotencyKeyRepository } from "~/db/repositories/idempotencyKeyRepository.server";
import {
  SIGNUP_NOTIFICATION_RECIPIENT,
  buildSignupConfirmationEmail,
  buildSignupInternalNotification,
} from "~/domain/firstaccess/signupEmails";
import { resolveEmailPort as resolveRealEmailPort, type EmailPortResolution } from "~/lib/email/configuredPort.server";
import type { IdempotencyRepository } from "~/domain/idempotency/types";
import { logger } from "~/lib/logger.server";

import type { ReceivedWebhookEvent } from "./receive.server";

/**
 * LAUNCHING SOON SIGNUP — confirmation to the customer, notification to us.
 *
 * ===========================================================================
 * WHY A WEBHOOK AND NOT THE SIGNUP FORM'S OWN FETCH
 * ===========================================================================
 * The obvious trigger is the form: it already calls
 * `/apps/carat/first-access-phone` after submitting. Three things make that
 * the wrong place for the emails.
 *
 * 1. IT DID NOT FIRE FOR MOST SIGNUPS. The theme script returned early when
 *    the optional mobile field was blank:
 *
 *        var phone = value('contact[phone]');
 *        if (phone === '') return null;
 *
 *    so a customer who gave only a name and an email never reached the
 *    backend at all. That is the defect this work was opened for.
 *
 * 2. IT CANNOT REACH THE LIVE PAGE. `/pages/first-access` is served by the
 *    published COMING SOON theme, which must not be modified. A fix that
 *    lives in theme JavaScript therefore cannot fix the page that is
 *    actually taking signups today. A webhook fixes both themes at once and
 *    needs neither of them changed.
 *
 * 3. IT IS CLIENT-SIDE. A fetch from the browser is lost to a closed tab, a
 *    dropped connection or a blocked script. `customers/create` is delivered
 *    by Shopify with retries, and arrives even when the visitor's browser
 *    does not cooperate.
 *
 * The form's own call still happens and still does its original job --
 * storing the optional mobile number -- and deliberately sends no email, so
 * there is exactly one sender and no way to double-send.
 *
 * ===========================================================================
 * WHICH CUSTOMERS THIS ACTS ON
 * ===========================================================================
 * Only those carrying the `first-access` tag, which the signup form sets as
 * a hidden field. A customer created in the Shopify admin, by an import, or
 * by a future checkout is NOT a Launching Soon signup and must not be told
 * they are on an early-access list.
 *
 * ===========================================================================
 * SENT ONCE, EVEN THOUGH DELIVERY IS AT-LEAST-ONCE
 * ===========================================================================
 * `receiveShopifyWebhook` already deduplicates on the delivery id, but a
 * redelivery whose first attempt FAILED is reprocessed by design -- that is
 * what makes a transient failure recoverable. If the confirmation had
 * already been sent and the internal notification was what failed, a plain
 * retry would email the customer twice.
 *
 * So each email takes its own idempotency key, keyed on the customer id and
 * which email it is. The retry then sends only the part that did not
 * succeed. This is the same claim/record pattern the Group Buy milestone
 * sweep uses for the same reason.
 */

const OPERATION_TYPE = "first_access_signup_email";

/**
 * One key per customer PER EMAIL, so a retry after a half-failure resends
 * only the half that failed. Keyed on the Shopify customer id rather than on
 * the address: the id is stable, and no email address belongs in a key that
 * is written to the database and read back by staff.
 */
const confirmationKeyFor = (customerId: string): string =>
  `firstaccess_signup_confirmation:${customerId}`;
const notificationKeyFor = (customerId: string): string =>
  `firstaccess_signup_notification:${customerId}`;

/**
 * Whether this email still needs sending.
 *
 * `tryCreatePending` ALONE IS NOT THE ANSWER, and the first version of this
 * file got it wrong by assuming it was. That call returns false whenever the
 * key exists, whatever state it is in — so once a send had failed and its
 * key was marked `failed`, every redelivery skipped it and the email was
 * never sent. The comment above claimed the retry "sends only the part that
 * did not succeed"; the code quietly sent neither. A unit test for the
 * half-failure case is what surfaced it.
 *
 * The four states, and why each behaves as it does:
 *
 *   (none)     nothing has tried yet. Claim it and send.
 *   failed     a definitive provider rejection: it is KNOWN not to have been
 *              delivered, so sending again is safe and is the whole point of
 *              a retry.
 *   succeeded  already delivered. Never again.
 *   in_doubt   a timeout or aborted connection — the provider may well have
 *              sent it. Resending risks a duplicate in a customer's inbox to
 *              fix a maybe, so this deliberately does NOT resend and leaves
 *              the row for a human to resolve.
 *   pending    another delivery is mid-flight. Leave it alone.
 */
async function shouldSend(
  idempotency: IdempotencyRepository,
  key: string,
  requestPayload: unknown
): Promise<boolean> {
  if (await idempotency.tryCreatePending(key, OPERATION_TYPE, requestPayload)) return true;

  const existing = await idempotency.findByKey(key);
  return existing?.status === "failed";
}

/** The tag the signup form sets. Nothing else marks a Launching Soon signup. */
export const FIRST_ACCESS_TAG = "first-access";

export interface FirstAccessSignupPayload {
  readonly customerId: string;
  readonly email: string;
  readonly firstName: string | null;
  readonly lastName: string | null;
  readonly phone: string | null;
  readonly tags: readonly string[];
}

/**
 * Shopify sends `tags` as a comma-separated string on this topic, and the
 * REST-shaped payload spells the name fields with underscores. Both are
 * normalised here so the rest of the file deals in one shape.
 */
export function parseFirstAccessSignupPayload(rawBody: string): FirstAccessSignupPayload | null {
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return null;
  }
  if (typeof json !== "object" || json === null) return null;

  const record = json as Record<string, unknown>;
  const email = typeof record.email === "string" ? record.email.trim() : "";
  if (email === "") return null;

  // The id is numeric in this payload and only ever used as a string key, so
  // it is read from the parsed value rather than through the BigInt-safe
  // path the order handlers need for 64-bit line ids.
  const rawId = record.id;
  const customerId =
    typeof rawId === "string" ? rawId : typeof rawId === "number" ? String(rawId) : "";
  if (customerId === "") return null;

  const tagsRaw = record.tags;
  const tags =
    typeof tagsRaw === "string"
      ? tagsRaw.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)
      : Array.isArray(tagsRaw)
        ? tagsRaw.filter((t): t is string => typeof t === "string").map((t) => t.trim().toLowerCase())
        : [];

  const str = (value: unknown): string | null => {
    if (typeof value !== "string") return null;
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  };

  return {
    customerId,
    email,
    firstName: str(record.first_name) ?? str(record.firstName),
    lastName: str(record.last_name) ?? str(record.lastName),
    phone: str(record.phone),
    tags,
  };
}

export interface FirstAccessSignupResult {
  readonly skipped: boolean;
  readonly confirmationSent: boolean;
  readonly notificationSent: boolean;
  readonly reason?: string;
}

export interface FirstAccessSignupDeps {
  readonly resolveEmailPort?: () => EmailPortResolution;
  /**
   * Injected in tests, exactly like `resolveEmailPort` above and for the
   * same reason: the real repository is a module-level singleton that talks
   * to Postgres, and asserting "a blank phone still sends both emails"
   * should not require a database. Production always uses the default.
   */
  readonly idempotency?: IdempotencyRepository;
}

export async function handleFirstAccessSignupWebhook(
  event: ReceivedWebhookEvent,
  deps: FirstAccessSignupDeps = {}
): Promise<FirstAccessSignupResult> {
  const payload = parseFirstAccessSignupPayload(event.rawBody);
  if (!payload) {
    logger.warn("firstaccess.signup_payload_unreadable", { topic: event.topic });
    return { skipped: true, confirmationSent: false, notificationSent: false, reason: "unreadable_payload" };
  }

  if (!payload.tags.includes(FIRST_ACCESS_TAG)) {
    // Not a Launching Soon signup. Normal and silent -- every customer
    // created by any other route lands here too.
    return { skipped: true, confirmationSent: false, notificationSent: false, reason: "not_first_access" };
  }

  const idempotency = deps.idempotency ?? idempotencyKeyRepository;
  const resolution = (deps.resolveEmailPort ?? resolveRealEmailPort)();
  if (!resolution.configured) {
    // THE HONESTY BOUNDARY. Record why nothing was sent rather than
    // reporting a send that did not happen, and fail the delivery so
    // Shopify retries once configuration is fixed.
    logger.error("firstaccess.signup_email_unconfigured", { reason: resolution.reason });
    throw new Error(`first access signup email not sent: ${resolution.reason}`);
  }

  const failures: string[] = [];
  let confirmationSent = false;
  let notificationSent = false;

  // ---- The customer's confirmation ---------------------------------------
  const confirmationKey = confirmationKeyFor(payload.customerId);
  if (
    await shouldSend(idempotency, confirmationKey, {
      customerId: payload.customerId,
      kind: "confirmation",
    })
  ) {
    const content = buildSignupConfirmationEmail(payload);
    try {
      const sent = await resolution.port.send({
        from: resolution.from,
        to: [payload.email],
        subject: content.subject,
        text: content.text,
      });
      await idempotency.recordSuccess(confirmationKey, {
        providerMessageId: sent.providerMessageId,
      });
      confirmationSent = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      await idempotency.recordFailure(confirmationKey, message);
      failures.push(`confirmation: ${message}`);
    }
  }

  // ---- Our notification --------------------------------------------------
  const notificationKey = notificationKeyFor(payload.customerId);
  if (
    await shouldSend(idempotency, notificationKey, {
      customerId: payload.customerId,
      kind: "notification",
    })
  ) {
    const content = buildSignupInternalNotification(payload);
    try {
      const sent = await resolution.port.send({
        from: resolution.from,
        to: [SIGNUP_NOTIFICATION_RECIPIENT],
        subject: content.subject,
        text: content.text,
      });
      await idempotency.recordSuccess(notificationKey, {
        providerMessageId: sent.providerMessageId,
      });
      notificationSent = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown";
      await idempotency.recordFailure(notificationKey, message);
      failures.push(`notification: ${message}`);
    }
  }

  if (failures.length > 0) {
    // NO ADDRESS IN THE LOG. The customer id correlates with the
    // idempotency row, which is where staff look to resolve it.
    logger.error("firstaccess.signup_email_failed", {
      customerId: payload.customerId,
      failures: failures.length,
    });
    throw new Error(`first access signup emails incomplete: ${failures.join(" | ")}`);
  }

  logger.info("firstaccess.signup_processed", {
    customerId: payload.customerId,
    confirmationSent,
    notificationSent,
    hasPhone: payload.phone !== null,
  });

  return { skipped: false, confirmationSent, notificationSent };
}
