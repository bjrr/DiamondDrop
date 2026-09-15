import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verifies a Shopify webhook HMAC over the RAW, unparsed request body
 * (spec §0.6). Callers must obtain `rawBody` via `request.text()` (or
 * equivalent) BEFORE any `JSON.parse` — verifying after parsing, or after
 * re-serializing, is a defect: it no longer matches the exact bytes that
 * were signed.
 *
 * Pure and side-effect-free so it is fully unit-testable without any
 * database, request, or environment dependency — the secret is an
 * explicit parameter, not read from env here.
 */
export function verifyShopifyWebhookHmac(
  rawBody: string,
  hmacHeader: string | null | undefined,
  apiSecret: string
): boolean {
  if (!hmacHeader) return false;

  const computed = createHmac("sha256", apiSecret).update(rawBody, "utf8").digest("base64");

  const computedBuffer = Buffer.from(computed, "utf8");
  const providedBuffer = Buffer.from(hmacHeader, "utf8");

  if (computedBuffer.length !== providedBuffer.length) {
    // timingSafeEqual throws on mismatched lengths; short-circuiting here
    // is still safe because header length itself is not sensitive.
    return false;
  }
  return timingSafeEqual(computedBuffer, providedBuffer);
}
