import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import type { AdminAlertView } from "~/db/repositories/adminAlertRepository.server";

import AdminAlertsPage from "./alerts";

/**
 * Same technique as _index.test.tsx: nothing is mocked. AdminAlertsPage is
 * rendered inside a real data router so Form/useLoaderData behave genuinely,
 * and only the loader's RESULT is supplied — running the real loader would
 * call authenticate.admin and listOpenAdminAlerts against a live session/DB.
 *
 * Fixture AdminAlertView values are constructed against the contract in
 * ~/db/repositories/adminAlertRepository.server (team-lead's interface
 * definition, 2026-09-19) rather than any local reshaping of it.
 */

const CALC_ALERT: AdminAlertView = {
  kind: "calculation_failure",
  episodeId: "calc-episode-1",
  masterVariantId: "mv-1",
  productTitle: "Solitaire Engagement Ring",
  variantLabel: "14K Yellow Gold / Size 6.5-8",
  shopifyProductGid: "gid://shopify/Product/1",
  shopifyVariantGid: "gid://shopify/ProductVariant/1",
  failureType: "unresolved_band",
  reason: "No ring-size band matched size 6.5-8 for this configuration.",
  firstFailedAt: new Date("2026-09-17T10:00:00.000Z"),
  ageMs: 2 * 60 * 60 * 1000 + 30 * 60 * 1000, // 2h30m
  msRemainingBeforeSuspension: 45 * 60 * 60 * 1000 + 30 * 60 * 1000, // 45h30m
  suspended: false,
  attemptCount: 3,
  lastAttemptAt: new Date("2026-09-17T12:00:00.000Z"),
  lastError: "unresolved_band: size 6.5-8 not found",
  status: "active",
};

const SUSPENDED_SYNC_ALERT: AdminAlertView = {
  kind: "sync_failure",
  episodeId: "sync-episode-1",
  masterVariantId: "mv-2",
  // Deliberately unresolvable product/variant — exercises the fallback path.
  productTitle: null,
  variantLabel: null,
  shopifyProductGid: null,
  shopifyVariantGid: "gid://shopify/ProductVariant/2",
  failureType: "ProductVariantUpdateUserError",
  reason: "Shopify rejected the price update: Price must be greater than 0.",
  firstFailedAt: new Date("2026-09-15T00:00:00.000Z"),
  ageMs: 50 * 60 * 60 * 1000, // 50h — past the 48h cutoff
  msRemainingBeforeSuspension: 0,
  suspended: true,
  attemptCount: 6,
  lastAttemptAt: new Date("2026-09-17T05:00:00.000Z"),
  lastError: "Price must be greater than 0.",
  status: "suspended",
};

const DISMISSED_SYNC_ALERT: AdminAlertView = {
  kind: "sync_failure",
  episodeId: "sync-episode-2",
  masterVariantId: "mv-3",
  productTitle: "Tennis Bracelet",
  variantLabel: "18K White Gold / 7 inch",
  shopifyProductGid: "gid://shopify/Product/3",
  shopifyVariantGid: "gid://shopify/ProductVariant/3",
  failureType: "ProductVariantUpdateUserError",
  reason: "Shopify rejected the price update: variant is archived.",
  firstFailedAt: new Date("2026-09-16T00:00:00.000Z"),
  ageMs: 30 * 60 * 60 * 1000,
  msRemainingBeforeSuspension: 18 * 60 * 60 * 1000,
  suspended: false,
  attemptCount: 2,
  lastAttemptAt: new Date("2026-09-16T20:00:00.000Z"),
  lastError: "variant is archived",
  status: "dismissed",
};

const LOADER_DATA = {
  apiKey: "test-public-client-id",
  shop: "caratforus-dev.myshopify.com",
  alerts: [CALC_ALERT, SUSPENDED_SYNC_ALERT] as AdminAlertView[],
  loadError: null as string | null,
};

function renderPage(data: Partial<typeof LOADER_DATA> = {}): string {
  const loaderData = { ...LOADER_DATA, ...data };
  const router = createMemoryRouter(
    [{ id: "alerts", path: "/alerts", Component: AdminAlertsPage, loader: () => loaderData }],
    { initialEntries: ["/alerts"], hydrationData: { loaderData: { alerts: loaderData } } }
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("the persistent embedded-admin alert surface", () => {
  it("renders visible content and shows which shop the session resolved to", () => {
    const text = textOf(renderPage());
    expect(text.length).toBeGreaterThan(40);
    expect(text).toMatch(/caratforus-dev\.myshopify\.com/);
  });

  it("does not leak the API secret", () => {
    const html = renderPage();
    expect(html).not.toMatch(/shpss_/);
    expect(html).not.toMatch(/SHOPIFY_API_SECRET/);
  });

  it("shows a clear empty state when there are no unresolved alerts", () => {
    const text = textOf(renderPage({ alerts: [] }));
    expect(text).toMatch(/No unresolved pricing alerts/i);
  });

  it("shows a load-error banner instead of crashing when the read fails", () => {
    const text = textOf(renderPage({ alerts: [], loadError: "Prisma connection refused" }));
    expect(text).toMatch(/Could not load pricing alerts/i);
    expect(text).toMatch(/Prisma connection refused/);
    // Sections are not rendered on a failed read — nothing to show under them.
    expect(text).not.toMatch(/Calculation failures/);
  });
});

describe("calculation vs sync failures are distinguishable at a glance", () => {
  it("renders both kinds under their own, separately labelled section", () => {
    const html = renderPage();
    const text = textOf(html);
    expect(text).toMatch(/Calculation failures/);
    expect(text).toMatch(/Sync failures/);
    // Each row also carries an explicit text badge — not a colour-only cue.
    expect(html).toMatch(/CALCULATION FAILURE/);
    expect(html).toMatch(/SYNC FAILURE/);
  });

  it("explains the two kinds mean different things, not just different labels", () => {
    const text = textOf(renderPage());
    expect(text).toMatch(/could not compute a price/i);
    expect(text).toMatch(/Shopify would not accept it/i);
  });

  it("uses real heading and list structure, not styled divs", () => {
    const html = renderPage();
    expect((html.match(/<h2[ >]/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(html).toMatch(/<ul[ >]/);
    expect(html).toMatch(/<dl[ >]/);
  });
});

describe("a single alert row", () => {
  it("shows product, variant, failure type and reason", () => {
    const text = textOf(renderPage());
    expect(text).toMatch(/Solitaire Engagement Ring/);
    expect(text).toMatch(/14K Yellow Gold \/ Size 6\.5-8/);
    expect(text).toMatch(/unresolved_band/);
    expect(text).toMatch(/No ring-size band matched size 6\.5-8/);
  });

  it("shows the first-failure timestamp and current age as text", () => {
    const text = textOf(renderPage());
    expect(text).toMatch(/2026-09-17 10:00 UTC/);
    expect(text).toMatch(/2 hours 30 minutes ago/);
  });

  it("shows latest retry result with attempt count and message", () => {
    const text = textOf(renderPage());
    expect(text).toMatch(/Attempt 3/);
    expect(text).toMatch(/unresolved_band: size 6\.5-8 not found/);
  });

  it("renders time remaining as readable text, not only implied by a bar", () => {
    const text = textOf(renderPage());
    // 45h30m = 1 day 21 hours 30 minutes at formatDuration's day granularity.
    expect(text).toMatch(/1 day 21 hours 30 minutes remaining/);
  });

  it("falls back to ids rather than hiding a row with an unresolved product/variant", () => {
    const text = textOf(renderPage());
    expect(text).toMatch(/Unresolved product \(variant mv-2\)/);
    expect(text).toMatch(/Unresolved variant \(gid:\/\/shopify\/ProductVariant\/2\)/);
  });
});

describe("suspension state", () => {
  it("reads 0 minutes remaining as urgent, not as missing data", () => {
    const text = textOf(renderPage());
    expect(text).toMatch(/0 minutes remaining — the 48-hour cutoff has already passed/);
    expect(text).toMatch(/Unavailable — taken off sale automatically/);
  });

  it("shows the active (non-suspended) row as currently available", () => {
    const text = textOf(renderPage());
    expect(text).toMatch(/Available — the last valid published price remains live/);
  });
});

describe("dismissed sync-failure alerts", () => {
  it("never reads as resolved or fixed", () => {
    const text = textOf(renderPage({ alerts: [DISMISSED_SYNC_ALERT] }));
    expect(text).toMatch(/Dismissed by staff/);
    expect(text).toMatch(/does not fix the failure/);
    expect(text).not.toMatch(/\bResolved\b/);
    expect(text).not.toMatch(/\bFixed\b/i);
  });
});

describe("no internal pricing data leaks onto this page", () => {
  it("never mentions cost, margin, landed cost, uplift, rule id, token or secret", () => {
    // Checked against the rendered TEXT, not the raw HTML — the raw markup
    // legitimately contains `style="margin:0..."` on every <dd>, which is
    // CSS layout, not a pricing-data leak, and would false-positive here.
    const text = textOf(renderPage({ alerts: [CALC_ALERT, SUSPENDED_SYNC_ALERT, DISMISSED_SYNC_ALERT] }));
    expect(text).not.toMatch(/margin/i);
    expect(text).not.toMatch(/landed[\s-]?cost/i);
    expect(text).not.toMatch(/uplift/i);
    expect(text).not.toMatch(/pricing[\s-]?profile/i);
    expect(text).not.toMatch(/\brule[\s-]?id\b/i);
    expect(text).not.toMatch(/\btoken\b/i);
    expect(text).not.toMatch(/\bsecret\b/i);
  });
});
