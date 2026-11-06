import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import AppHome from "./_index";

/**
 * The embedded app home must actually RENDER SOMETHING.
 *
 * The bug this covers presented as "The destination stream closed early" from
 * entry.server.tsx, which reads like an SSR fault. It was neither: the app had
 * a root layout and no index route, so "/" produced a valid but EMPTY document,
 * and with no frame-ancestors header the browser refused to frame it and
 * aborted the request, collapsing the SSR pipe.
 *
 * NOTHING IS MOCKED HERE. An earlier version stubbed useLoaderData, then
 * useActionData and useNavigation, then hit useSubmit behind <Form> — each new
 * hook needing another stub. That escalation was the signal: the page belongs
 * inside a real data router, so it gets one. Form, useNavigation and
 * useActionData then behave genuinely, and only the loader's RESULT is
 * supplied, because running the real loader would call authenticate.admin and
 * need a live Shopify session.
 */

/** Every queue at zero, so a test that wants a number opts into it explicitly. */
const ZERO_COUNTS = {
  groupBuyDraft: 0,
  groupBuyOpen: 0,
  groupBuyDemandOutstanding: 0,
  luxuryStealSyncFailures: 0,
  luxuryStealUnmatchedOrderChecks: 0,
  beatQuotePendingReview: 0,
  bankPaymentsOpen: 0,
  groupBuyBankPaymentsOpen: 0,
  customJewelryActionable: 0,
  rmaOpen: 0,
  warrantyOpen: 0,
  openAlerts: 0,
};

const LOADER_DATA = {
  apiKey: "test-public-client-id",
  shop: "caratforus-dev.myshopify.com",
  devProbe: true,
  products: [{ id: "gid://shopify/Product/1", title: "The Complete Snowboard", status: "ACTIVE" }],
  readError: null as string | null,
  counts: ZERO_COUNTS,
  customersUrl: "https://admin.shopify.com/store/caratforus-dev/customers" as string | null,
  productsUrl: "https://admin.shopify.com/store/caratforus-dev/products" as string | null,
};

function renderPage(data: Partial<typeof LOADER_DATA> = {}): string {
  const loaderData = { ...LOADER_DATA, ...data };
  const router = createMemoryRouter(
    [{ id: "home", path: "/", Component: AppHome, loader: () => loaderData }],
    // hydrationData starts the router idle WITH data, so static rendering
    // produces the real page rather than a loading fallback.
    { initialEntries: ["/"], hydrationData: { loaderData: { home: loaderData } } }
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("the embedded app home", () => {
  it("renders visible content, not an empty document", () => {
    // The specific failure being guarded: a route that resolves but produces
    // nothing for a person to see.
    const text = textOf(renderPage());
    expect(text.length).toBeGreaterThan(40);
    expect(text).toMatch(/CaratForUs/);
  });

  it("shows which shop the session resolved to", () => {
    // Proves the page reflects loader data rather than being a static shell —
    // a hard-coded page renders identically for every merchant and would hide a
    // broken session.
    expect(renderPage()).toMatch(/caratforus-dev\.myshopify\.com/);
  });

  it("does not leak the API secret into the rendered page", () => {
    const html = renderPage();
    // apiKey is the PUBLIC client id and is expected in the markup via App
    // Bridge; the secret must never appear.
    expect(html).not.toMatch(/shpss_/);
    expect(html).not.toMatch(/SHOPIFY_API_SECRET/);
  });
});

describe("the Admin API probe section", () => {
  it("lists product ids and titles returned by the read", () => {
    const html = renderPage();
    expect(html).toMatch(/gid:\/\/shopify\/Product\/1/);
    expect(html).toMatch(/The Complete Snowboard/);
  });

  it("says the read SUCCEEDED when the catalogue is simply empty", () => {
    // An empty store is a normal state. Rendering nothing here would be
    // indistinguishable from a failed read, which is the trap.
    const text = textOf(renderPage({ products: [] }));
    expect(text).toMatch(/No products in this store/);
    expect(text).toMatch(/read succeeded/i);
  });

  it("surfaces a read failure instead of rendering a blank section", () => {
    const text = textOf(
      renderPage({ products: [], readError: "Shopify Admin API listProducts failed: nope" })
    );
    expect(text).toMatch(/listProducts failed/);
    // Must not claim an empty catalogue when the read actually broke.
    expect(text).not.toMatch(/No products in this store/);
  });

  it("offers the write probe but no delete button until something was created", () => {
    const html = renderPage();
    expect(html).toMatch(/Run write probe/);
    expect(html).not.toMatch(/Delete probe product/);
  });

  it("is hidden entirely when the probe is disabled", () => {
    // Production must not render a button that creates and deletes products.
    const html = renderPage({ devProbe: false });
    expect(html).not.toMatch(/Admin API probe/);
    expect(html).not.toMatch(/Run write probe/);
    // The page itself still renders.
    expect(html).toMatch(/CaratForUs/);
  });
});

describe("document responses carry the embedding headers", () => {
  it("entry.server applies Shopify's document response headers", () => {
    // Without this call Shopify Admin cannot frame the app: the body is blank
    // and the aborted request produces the misleading stream error. Asserted
    // against the source because the alternative is a synthetic EntryContext,
    // which would test the harness more than the fix.
    const source = readFileSync(join(process.cwd(), "app", "entry.server.tsx"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    expect(code).toMatch(/addDocumentResponseHeaders\s*\(\s*request\s*,\s*responseHeaders\s*\)/);
    // Must run before the response is constructed, or the headers are set on an
    // object nobody reads.
    expect(code.indexOf("addDocumentResponseHeaders(")).toBeLessThan(code.indexOf("isbot("));
  });
});

/**
 * The Admin Control Center.
 *
 * These assert the page is NAVIGATION AND A WORKLIST, which is the whole
 * brief. The two that matter most are the ones about what is absent: a
 * custom First Access table and a custom product editor are the two things
 * this page must never grow, because both already exist in Shopify Admin and
 * a second copy would immediately start disagreeing with the first.
 */
describe("the Admin Control Center", () => {
  it("links to every custom admin surface", () => {
    const html = renderPage();
    for (const path of [
      "/app/price-approvals",
      "/app/pricing-settings",
      "/alerts",
      "/app/group-buy-campaigns",
      "/app/group-buy-demand",
      "/app/luxury-steals",
      "/app/custom-jewelry",
      "/app/beat-quote",
      "/app/bank-payments",
      "/app/rma",
      "/app/warranty-claims",
      "/app/shipments",
      "/app/ready-settings",
    ]) {
      expect(html, `missing link to ${path}`).toContain(`href="${path}"`);
    }
  });

  it("links Pricing Alerts at /alerts, not /app/alerts", () => {
    const html = renderPage();
    expect(html).toContain('href="/alerts"');
    expect(html).not.toContain("/app/alerts");
  });

  it("separates Price Approvals from Pricing Alerts as different queues", () => {
    const html = renderPage();
    // A calculated price awaiting a decision is not the same operational
    // state as a calculation or sync that failed, and the page must not blur
    // them into one "pricing problems" bucket.
    expect(html).toMatch(/Price Approvals/);
    expect(html).toMatch(/Pricing Alerts/);
    expect(html).toMatch(/needs a decision/i);
    expect(html).toMatch(/failed/i);
  });

  it("sends First Access to Shopify Customers, with the tag to filter by", () => {
    const html = renderPage();
    expect(html).toContain("https://admin.shopify.com/store/caratforus-dev/customers");
    expect(html).toMatch(/View and manage First Access signups in Shopify Customers/);
    expect(html).toMatch(/Filter by tag: first-access/);
  });

  it("builds no First Access customer table of its own", () => {
    const html = renderPage();
    // The signup data lives on the Shopify customer. If any of these ever
    // appear on the admin home, a second customer database has started.
    expect(html).not.toMatch(/first_access_mobile/);
    expect(html).not.toMatch(/@/); // no email addresses rendered anywhere
  });

  it("points Products at Shopify Product Admin and offers no editor", () => {
    const html = renderPage();
    expect(html).toContain("https://admin.shopify.com/store/caratforus-dev/products");
    expect(html).toMatch(/managed in Shopify Product Admin/);
  });

  it("renders Products and Customers as plain text when no reliable URL exists", () => {
    // Null rather than a guessed URL: a link that goes nowhere is worse than
    // instructions that always work.
    const html = renderPage({ customersUrl: null, productsUrl: null });
    expect(html).not.toContain("admin.shopify.com");
    expect(html).toMatch(/View and manage First Access signups in Shopify Customers/);
    expect(html).toMatch(/Filter by tag: first-access/);
  });

  it("says so plainly when nothing needs attention", () => {
    const html = renderPage();
    expect(html).toMatch(/Everything requiring staff attention is clear/);
  });

  it("lists only queues that actually have work, never a wall of zeroes", () => {
    const html = renderPage({ counts: { ...ZERO_COUNTS, rmaOpen: 2, openAlerts: 1 } });
    // Scoped to the Needs attention list. Asserting against the whole
    // document matched inline CSS like "margin:0 0 1.75rem", which is how an
    // earlier version of this test failed for a reason that had nothing to
    // do with the dashboard.
    const section = html.slice(html.indexOf("Needs attention"), html.indexOf("Sales and special"));
    const items = [...section.matchAll(/<li>.*?<\/li>/g)].map((m) => textOf(m[0]));

    expect(items).toHaveLength(2);
    expect(items.join(" ")).toMatch(/2 open RMA/);
    expect(items.join(" ")).toMatch(/1 open pricing alert/);
    expect(section).not.toMatch(/Everything requiring staff attention is clear/);
    // Every other queue is at zero and must be absent, not shown as "0".
    expect(items.join(" ")).not.toMatch(/warranty|custom jewelry|bank payment|demand/i);
  });

  it("shows no supplier cost, landed cost, margin or price", () => {
    const html = renderPage({
      counts: { ...ZERO_COUNTS, rmaOpen: 3, bankPaymentsOpen: 4, beatQuotePendingReview: 5 },
    });
    // TEXT ONLY. The markup is full of inline CSS, and `margin:` in a style
    // attribute is not a leaked profit margin: an earlier version of this
    // test failed on exactly that and would have been "fixed" by dropping
    // the most important word from the list.
    const text = textOf(html).toLowerCase();
    for (const forbidden of [
      "landed",
      "supplier",
      "margin",
      "cost",
      "usd",
      "bankpaymentprice",
      "uplift",
    ]) {
      expect(text, `dashboard leaked "${forbidden}"`).not.toContain(forbidden);
    }
    // And no money at all: the home page is navigation.
    expect(text).not.toMatch(/\d+\.\d{2}/);
  });

  it("keeps the development probe under its own heading, below the dashboard", () => {
    const html = renderPage({ devProbe: true });
    expect(html).toMatch(/Development Tools/);
    // Below, not above: the operational page is the point of the screen.
    expect(html.indexOf("Needs attention")).toBeLessThan(html.indexOf("Development Tools"));
  });

  it("omits the development probe entirely in production", () => {
    const html = renderPage({ devProbe: false });
    expect(html).not.toMatch(/Development Tools/);
    expect(html).not.toMatch(/Admin API probe/);
    // The real dashboard is still there.
    expect(html).toContain('href="/app/price-approvals"');
  });
});
