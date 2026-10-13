import type { AdminGraphqlClient } from "./productClient.server";
import { AdminApiError } from "./productClient.server";

/**
 * The CaratForUs store's configured business timezone, read from Shopify.
 *
 * ============================================================================
 * WHY THIS IS RESOLVED AND NOT A CONSTANT
 * ============================================================================
 * "Let Us Beat Your Quote" turns on a 7-CALENDAR-DAY window, and a calendar day
 * depends on where you stand. Which zone decides that boundary is a business
 * fact, not an implementation detail: it determines whether a quote submitted
 * late in the evening counts as today or tomorrow, and therefore whether a
 * customer receives a guaranteed match-or-beat plus a $100 benefit or a
 * discretionary review.
 *
 * An earlier version hard-coded `America/New_York`. It happened to be correct —
 * the store really is configured that way — and that is precisely the problem:
 * a constant that is right by luck is indistinguishable from one that is right
 * by design, and nothing would have caught it drifting if the store moved.
 *
 * ============================================================================
 * MEMOIZED, BECAUSE IT IS A SHOP SETTING AND NOT A REQUEST PROPERTY
 * ============================================================================
 * `shop.ianaTimezone` changes approximately never. Resolving it per submission
 * would put a Shopify round trip in front of every intake and make an
 * acquisition form depend on Admin API availability. So it is fetched once per
 * process and cached.
 *
 * THE CACHE IS NOT A FALLBACK. If resolution fails and nothing is cached, the
 * caller must refuse rather than assume a zone — guessing would silently move a
 * real eligibility boundary. That is why this throws instead of returning a
 * default.
 *
 * ============================================================================
 * AND THE ZONE USED IS PERSISTED WITH EACH SUBMISSION
 * ============================================================================
 * Callers store the identifier alongside the derived date (see
 * `beat_quote_submission.calendar_zone`). A future store-timezone change must
 * not reinterpret history: a submission judged under `America/New_York` stays
 * judged under it, and the record says so rather than leaving a later reader to
 * assume today's setting applied.
 */

const SHOP_TIMEZONE_QUERY = `#graphql
  query CaratShopTimezone {
    shop {
      ianaTimezone
    }
  }`;

/** Memoized per process, keyed by shop domain. */
const cache = new Map<string, string>();

/**
 * An override for tests, which must exercise specific boundaries without a
 * Shopify client. Never used in production: nothing reads an environment
 * variable here, so a deployment cannot accidentally override the real store
 * setting.
 */
let overrideForTests: string | null = null;
export function __setStoreTimezoneOverrideForTests(zone: string | null): void {
  overrideForTests = zone;
  cache.clear();
}

/** Valid IANA zone identifiers look like `Area/Location`. */
function assertUsableZone(zone: string): string {
  // Proven usable rather than pattern-matched: a zone the runtime cannot format
  // with would throw later, inside date derivation, where the failure would be
  // far from its cause.
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: zone }).format(new Date(0));
  } catch {
    throw new AdminApiError("shop.ianaTimezone", [
      `Shopify returned a timezone this runtime cannot use: ${JSON.stringify(zone)}`,
    ]);
  }
  return zone;
}

/**
 * The Admin client is supplied as a FACTORY, not a client.
 *
 * A cache hit and a test override both need no Shopify client at all, and
 * building one eagerly would make every intake depend on a session lookup it
 * usually does not use. The deposit payment handler learned this the hard way:
 * an eagerly-built client turned a webhook the handler would have ignored into
 * a 500 and a redelivery request.
 */
export async function resolveStoreTimezone(
  shopDomain: string,
  adminGraphql: () => Promise<AdminGraphqlClient>
): Promise<string> {
  if (overrideForTests !== null) return assertUsableZone(overrideForTests);

  const cached = cache.get(shopDomain);
  if (cached) return cached;

  const client = await adminGraphql();
  const response = await client.graphql(SHOP_TIMEZONE_QUERY);
  const body = (await response.json()) as {
    data?: { shop?: { ianaTimezone?: string | null } | null };
    errors?: unknown;
  };
  // EVERY Shopify Admin failure arrives on HTTP 200 — the body decides.
  if (body.errors) {
    throw new AdminApiError("shop.ianaTimezone", [JSON.stringify(body.errors)]);
  }
  const zone = body.data?.shop?.ianaTimezone;
  if (!zone) {
    throw new AdminApiError("shop.ianaTimezone", ["response carried no shop.ianaTimezone"]);
  }

  const usable = assertUsableZone(zone);
  cache.set(shopDomain, usable);
  return usable;
}

/**
 * The calendar date `at` falls on, in `zone`, as `YYYY-MM-DD`.
 *
 * `en-CA` is used because it formats as YYYY-MM-DD, which is the shape the
 * eligibility domain requires. The alternative — assembling parts by hand — is
 * where off-by-one errors live.
 */
export function businessCalendarDate(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: zone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(at);
}
