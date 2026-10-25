import { createHmac, timingSafeEqual } from "node:crypto";

/** Why a request was refused. `"ok"` only when every check passed. */
export type AppProxyRejectionReason =
  | "ok"
  | "invalid_or_missing_signature"
  | "missing_shop"
  | "shop_mismatch"
  | "expected_shop_unconfigured";

export interface AppProxyVerificationResult {
  verified: boolean;
  loggedInCustomerId: string | null;
  /**
   * The SIGNED `shop` parameter, echoed back for diagnostics only. Present
   * even on rejection (that is the point — a mismatch is unreadable without
   * it). Never an authorization input: by the time a caller sees this, the
   * decision in `verified` is already made.
   */
  shop: string | null;
  reason: AppProxyRejectionReason;
}

/**
 * Verifies a Shopify App Proxy request: HMAC first, then shop binding.
 *
 * ============================================================================
 * 1. SIGNATURE (spec §0.8)
 * ============================================================================
 * Sorts query parameters alphabetically (excluding `signature`), concatenates
 * as `key=value` pairs with no separator, HMAC-SHA256s with the app secret,
 * hex-encodes, and compares timing-safely. Pure and side-effect-free — the
 * secret and the expected shop are explicit parameters, never read from env
 * here, so this function stays testable without a process environment.
 *
 * ============================================================================
 * 2. SHOP BINDING — WHY A VALID SIGNATURE IS NOT ENOUGH (register D4)
 * ============================================================================
 * The signature proves Shopify sent the request and that nobody altered the
 * parameters. It does NOT prove WHICH shop sent it. Every store that has
 * this app installed is signed with the SAME app secret, so a perfectly
 * valid, perfectly genuine request from one installed shop verifies against
 * another shop's backend.
 *
 * That is not hypothetical here. This app is installed on two shops — the
 * production store and `caratforus-dev` — and both share one database. The
 * authorization basis for customer data is
 * `gid://shopify/Customer/<id>`, and Shopify customer ids are unique
 * PER SHOP, not globally. Without this check, dev-store customer 123 and
 * production customer 123 are indistinguishable to every `where: {
 * customerGid }` query in the codebase.
 *
 * So after the signature verifies, the signed `shop` must equal the shop
 * this deployment is configured for, exactly.
 *
 * WHAT IS COMPARED, AND WHAT IS NOT:
 *   - the SIGNED `shop` query parameter — covered by the HMAC, so a caller
 *     cannot change it without invalidating the signature;
 *   - NOT `Host`, NOT `X-Forwarded-Host`, NOT any header or body field. Fly
 *     terminates TLS and rewrites those; they are attacker-influenceable and
 *     have no signature over them;
 *   - NOT the storefront's public/primary domain. For the production shop
 *     that is `caratforus.myshopify.com`, while the canonical
 *     `myshopifyDomain` — what Shopify actually signs — is
 *     `nnb1th-cm.myshopify.com`. Binding to the pretty one would reject
 *     every genuine request.
 *
 * Compared case-insensitively after trimming, because a hostname is
 * case-insensitive; otherwise exact. No suffix matching, no "ends with
 * .myshopify.com" — a substring rule is how this kind of check gets
 * defeated.
 *
 * FAILS CLOSED IN BOTH DIRECTIONS: a missing `shop`, and an unconfigured
 * `expectedShop`. An unconfigured expectation is a deployment fault, and
 * treating it as "allow everything" would silently disable the control at
 * exactly the moment it is least likely to be noticed.
 *
 * ============================================================================
 * 3. WHAT THIS DOES NOT CHANGE
 * ============================================================================
 * `logged_in_customer_id` remains the ONLY basis for deciding which
 * customer's data a request may see, and it is still returned only when the
 * request is fully verified. Shop binding narrows which requests get that
 * far; it never substitutes for the per-customer ownership checks each route
 * already performs.
 *
 * Documented limitation, unchanged: Shopify joins repeated query keys with
 * commas before hashing; this implementation assumes each key appears at
 * most once.
 */
export function verifyAppProxySignature(
  searchParams: URLSearchParams,
  apiSecret: string,
  /**
   * The canonical `*.myshopify.com` domain this deployment serves — in
   * practice `getEnv().SHOPIFY_SHOP_DOMAIN`. Typed as possibly undefined so
   * the optional env var can be passed straight through and refused here,
   * rather than each caller inventing its own fallback.
   */
  expectedShop: string | undefined
): AppProxyVerificationResult {
  const signature = searchParams.get("signature");
  if (!signature) {
    return refuse("invalid_or_missing_signature", null);
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

  const signatureValid =
    computedBuffer.length === providedBuffer.length && timingSafeEqual(computedBuffer, providedBuffer);

  // The shop is only meaningful once the signature proves Shopify set it.
  // Reading it before that would be reading an attacker-supplied string.
  if (!signatureValid) {
    return refuse("invalid_or_missing_signature", null);
  }

  const signedShop = params.get("shop");
  if (!signedShop || signedShop.trim() === "") {
    return refuse("missing_shop", null);
  }

  if (!expectedShop || expectedShop.trim() === "") {
    return refuse("expected_shop_unconfigured", signedShop);
  }

  if (signedShop.trim().toLowerCase() !== expectedShop.trim().toLowerCase()) {
    return refuse("shop_mismatch", signedShop);
  }

  return {
    verified: true,
    loggedInCustomerId: params.get("logged_in_customer_id"),
    shop: signedShop,
    reason: "ok",
  };
}

function refuse(reason: AppProxyRejectionReason, shop: string | null): AppProxyVerificationResult {
  // `loggedInCustomerId` is null on EVERY refusal path, without exception.
  // A customer identity that survived a failed check would be the whole
  // defect this function exists to prevent.
  return { verified: false, loggedInCustomerId: null, shop, reason };
}
