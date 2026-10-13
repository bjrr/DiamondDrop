import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import LuxuryStealsHeldOrdersPage, { type HeldCheckView } from "./app.luxury-steals.held-orders";

/**
 * Same render-only technique as `app.bank-payments.$id.test.tsx` and
 * `app.luxury-steals._index.test.tsx` — the loader's RESULT is supplied
 * directly; the real database read is exercised in
 * `tests/integration/luxurysteals/luxuryStealRepository.test.ts`
 * (`listUnmatchedLuxuryStealOrderChecks`).
 */

const ROUTE_ID = "luxury-steals-held-orders";

const HELD_ROW: HeldCheckView = {
  id: "check-1",
  orderRef: "gid://shopify/Order/900001",
  lineRef: "gid://shopify/LineItem/900002",
  variantRef: "gid://shopify/ProductVariant/900003",
  checkedAt: "2026-09-24T08:15:00.000Z",
};

const LOADER_DATA = {
  apiKey: "test-public-client-id",
  shop: "caratforus-dev.myshopify.com",
  held: [] as HeldCheckView[],
  loadError: null as string | null,
};

function renderPage(data: Partial<typeof LOADER_DATA> = {}): string {
  const loaderData = { ...LOADER_DATA, ...data };
  const router = createMemoryRouter(
    [
      {
        id: ROUTE_ID,
        path: "/app/luxury-steals/held-orders",
        Component: LuxuryStealsHeldOrdersPage,
        loader: () => loaderData,
      },
    ],
    {
      initialEntries: ["/app/luxury-steals/held-orders"],
      hydrationData: { loaderData: { [ROUTE_ID]: loaderData } },
    }
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("the held Luxury Steal orders page — empty state", () => {
  it("says every checked line has matched rather than showing an empty table", () => {
    const text = textOf(renderPage());
    expect(text).toMatch(/No held orders — every checked Luxury Steal line has matched/);
  });
});

describe("the held Luxury Steal orders page — listing (criterion 138)", () => {
  it("shows the order, line, variant reference and checked-at timestamp", () => {
    const text = textOf(renderPage({ held: [HELD_ROW] }));
    expect(text).toMatch(/gid:\/\/shopify\/Order\/900001/);
    expect(text).toMatch(/gid:\/\/shopify\/LineItem\/900002/);
    expect(text).toMatch(/gid:\/\/shopify\/ProductVariant\/900003/);
    expect(text).toMatch(/2026-09-24 08:15 UTC/);
  });

  it("states this is a pull-based surface that does not depend on the notification email", () => {
    const text = textOf(renderPage());
    expect(text).toMatch(/does not depend on the notification email/i);
  });

  it("states the hold is never silently fulfilled and never auto-cancelled (criterion 138)", () => {
    const text = textOf(renderPage());
    expect(text).toMatch(/never silently fulfilled, never\s*auto-cancelled/i);
  });
});

describe("the held Luxury Steal orders page — no release/approve action", () => {
  it("renders no release, approve or resolve action for a held line", () => {
    const html = renderPage({ held: [HELD_ROW] });
    expect(html).not.toMatch(/<form/i);
    expect(html.toLowerCase()).not.toMatch(/release|approve|resolve hold|dismiss/);
  });
});

describe("the held Luxury Steal orders page — load failure", () => {
  it("shows the load error banner rather than crashing", () => {
    const text = textOf(renderPage({ loadError: "database unreachable" }));
    expect(text).toMatch(/Could not load held Luxury Steal orders: database unreachable/);
  });
});

describe("the held Luxury Steal orders page — navigation", () => {
  it("links back to the assignment page", () => {
    const html = renderPage();
    expect(html).toMatch(/href="\/app\/luxury-steals"/);
  });
});

describe("the held Luxury Steal orders page — never leaks cost/margin data", () => {
  it("renders no cost, margin, landed-cost or uplift figures", () => {
    const text = textOf(renderPage({ held: [HELD_ROW] })).toLowerCase();
    expect(text).not.toMatch(/landed ?cost|gross margin|margin rate|uplift|cost component/);
  });
});
