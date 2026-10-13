import type { PriceMetafieldPublishDeps, ShopifyPriceSyncPort } from "~/jobs/pricing/ports";
import { getEnv } from "~/lib/env.server";

import { ShopifyPriceSyncAdapter } from "./priceSyncAdapter.server";

/**
 * Production wiring for `ShopifyPriceSyncPort` — the one place this app
 * constructs an Admin API client for a BACKGROUND job rather than a request.
 *
 * WHY THIS IS ITS OWN FILE, IMPORTED LAZILY BY ITS CALLER, NOT EAGERLY.
 *
 * `~/shopify.server` calls `requireShopifyConfig()` at MODULE SCOPE, which
 * throws immediately if `SHOPIFY_API_KEY`/`SHOPIFY_API_SECRET`/`SHOPIFY_APP_URL`
 * are not configured — and that module's own header comment states the
 * pricing job "must be able to boot and run without any Shopify credentials
 * at all". If this file (or anything that imports `~/shopify.server`) were
 * imported at the TOP of `app/routes/internal.jobs.price-recalculation.tsx`,
 * the cron route — and therefore the whole nightly recalculation — would fail
 * to load whenever Shopify OAuth is not configured, even though auto-publish
 * defaults OFF and the route would otherwise run perfectly well without it.
 *
 * So the route imports this module with a DYNAMIC `import()`, and only when
 * `PRICE_AUTO_PUBLISH_ENABLED` is actually "true" — deferring the
 * `requireShopifyConfig()` throw to exactly the moment it is relevant, not to
 * every cold start.
 *
 * `app/jobs/pricing/runRecalculation.server.ts` itself never imports this
 * file or anything Shopify-shaped, for the same reason criterion 29's fence
 * (layering.test.ts) exists: app/jobs/pricing is forbidden from reaching the
 * Admin API directly.
 *
 * THE DEFERRAL ABOVE DOES NOT CURRENTLY ACHIEVE WHAT IT DESCRIBES, and saying
 * so here is cheaper than letting someone rely on it. `app/entry.server.tsx`
 * imports `~/shopify.server` STATICALLY, and entry.server is loaded on every
 * cold start — so the bundler resolves the module into the main chunk
 * regardless of how any single route imports it, and the server already
 * requires Shopify configuration to boot. The build says as much: "dynamically
 * imported by apps.carat.bank-checkout.tsx ... but also statically imported by
 * entry.server.tsx ... dynamic import will not move module into another
 * chunk."
 *
 * The dynamic import is still correct and worth keeping — it defers
 * `requireShopifyConfig()`'s THROW to the moment auto-publish is actually
 * used, which is a real property. What it cannot do on its own is keep the
 * process bootable without Shopify credentials; that needs entry.server's
 * static import addressed too, and that is a separate change with its own
 * blast radius. Recorded rather than quietly fixed here.
 */
export class MissingShopDomainError extends Error {
  constructor() {
    super(
      "PRICE_AUTO_PUBLISH_ENABLED is \"true\" but SHOPIFY_SHOP_DOMAIN is not set. " +
        "A single-merchant background job has no request to read the shop domain " +
        "from, so it must be configured explicitly. Set it in app/.env — see .env.example."
    );
    this.name = "MissingShopDomainError";
  }
}

/**
 * Obtains an offline-session Admin API client for THE shop (this app is
 * single-merchant — see shopify.server.ts) and wraps it in the real adapter.
 *
 * Throws `MissingShopDomainError` if unconfigured, and whatever
 * `unauthenticated.admin` throws if OAuth has not yet been completed for that
 * shop (no stored offline session) — both loudly, on purpose: auto-publish
 * being enabled without a working Shopify connection is a fundamental
 * misconfiguration, not a per-variant failure to degrade gracefully around.
 */
export async function createProductionPriceSyncPort(): Promise<ShopifyPriceSyncPort> {
  const { SHOPIFY_SHOP_DOMAIN } = getEnv();
  if (!SHOPIFY_SHOP_DOMAIN) {
    throw new MissingShopDomainError();
  }

  // Dynamic import for the same reason this whole file is imported lazily by
  // its caller: importing `~/shopify.server` at module scope would move the
  // `requireShopifyConfig()` throw to whenever THIS file is first loaded,
  // defeating the deferral its caller relies on.
  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOPIFY_SHOP_DOMAIN);

  return new ShopifyPriceSyncAdapter(admin);
}

/**
 * Production wiring for `PriceMetafieldPublishDeps` (Stage 2B / R13) —
 * mirrors `createProductionPriceSyncPort` above exactly, including the
 * "throw loudly if unconfigured" behaviour and the dynamic `import()` of
 * `~/shopify.server` for the same deferral reason documented on that
 * function. A separate function rather than folding this into
 * `createProductionPriceSyncPort`'s return value: the two dependencies are
 * consumed independently (a caller may want the sync port without ever
 * wanting metafield publish), and `SyncApprovedIntentDeps.metafields` is
 * OPTIONAL specifically so the two can be wired one at a time.
 */
export async function createProductionMetafieldPublishDeps(): Promise<PriceMetafieldPublishDeps> {
  const { SHOPIFY_SHOP_DOMAIN } = getEnv();
  if (!SHOPIFY_SHOP_DOMAIN) {
    throw new MissingShopDomainError();
  }

  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOPIFY_SHOP_DOMAIN);

  return { client: admin };
}
