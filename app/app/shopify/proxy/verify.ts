import { createHmac, timingSafeEqual } from "node:crypto";

export interface AppProxyVerificationResult {
  verified: boolean;
  loggedInCustomerId: string | null;
}

/**
 * Verifies a Shopify App Proxy request signature (spec §0.8): sorts query
 * parameters alphabetically (excluding `signature`), concatenates as
 * `key=value` pairs with no separator, HMAC-SHA256s with the app secret,
 * hex-encodes, and compares to the provided `signature` parameter using a
 * timing-safe comparison. Pure and side-effect-free — the secret is an
 * explicit parameter, not read from env here.
 *
 * Documented limitation, not exercised this slice (no proxy routes exist
 * yet — spec §0.8 explicitly defers those to later slices): Shopify joins
 * repeated query keys with commas before hashing; this implementation
 * assumes each key appears at most once. Revisit if a later slice needs a
 * proxied route with multi-value query parameters.
 */
export function verifyAppProxySignature(
  searchParams: URLSearchParams,
  apiSecret: string
): AppProxyVerificationResult {
  const signature = searchParams.get("signature");
  if (!signature) {
    return { verified: false, loggedInCustomerId: null };
  }

  const params = new URLSearchParams(searchParams);
  params.delete("signature");

  const message = Array.from(params.entries())
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join("");

  const computed = createHmac("sha256", apiSecret).update(message, "utf8").digest("hex");

  const computedBuffer = Buffer.from(computed, "utf8");
  const providedBuffer = Buffer.from(signature, "utf8");

  const verified =
    computedBuffer.length === providedBuffer.length && timingSafeEqual(computedBuffer, providedBuffer);

  return {
    verified,
    loggedInCustomerId: verified ? params.get("logged_in_customer_id") : null,
  };
}
