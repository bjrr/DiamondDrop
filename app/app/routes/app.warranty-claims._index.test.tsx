import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import WarrantyClaimsListPage from "./app.warranty-claims._index";

/** Same technique as `app.bank-payments._index.tsx`'s (implied) rendering discipline and `app.warranty-claims.$id.test.tsx`: nothing mocked, only the loader's result supplied. */

const ROUTE_ID = "warranty-claims-list";

interface RowFixture {
  id: string;
  claimReference: string;
  status: string;
  orderRef: string;
  purchaserName: string;
  purchaserEmail: string;
  submittedAt: Date;
  authorizedAt: Date | null;
  receivedAt: Date | null;
  coverageDecision: string | null;
}

const ROW_1: RowFixture = {
  id: "11111111-1111-1111-1111-111111111111",
  claimReference: "WC-ABC12345",
  status: "under_review",
  orderRef: "gid://shopify/Order/1",
  purchaserName: "Ada Lovelace",
  purchaserEmail: "ada@example.com",
  submittedAt: new Date("2026-09-20T10:00:00.000Z"),
  authorizedAt: null,
  receivedAt: null,
  coverageDecision: null,
};

const ROW_2: RowFixture = {
  id: "22222222-2222-2222-2222-222222222222",
  claimReference: "WC-DEF67890",
  status: "resolved",
  orderRef: "gid://shopify/Order/2",
  purchaserName: "Grace Hopper",
  purchaserEmail: "grace@example.com",
  submittedAt: new Date("2026-09-18T10:00:00.000Z"),
  authorizedAt: new Date("2026-09-19T10:00:00.000Z"),
  receivedAt: new Date("2026-09-21T10:00:00.000Z"),
  coverageDecision: "covered",
};

const LOADER_DATA = {
  apiKey: "test-public-client-id",
  shop: "caratforus-dev.myshopify.com",
  query: "",
  statusFilter: "",
  rows: [ROW_1] as RowFixture[],
  totalCount: 1,
  page: 1,
  pageSize: 25,
  loadError: null as string | null,
};

function renderPage(data: Partial<typeof LOADER_DATA> = {}): string {
  const loaderData = { ...LOADER_DATA, ...data };
  const router = createMemoryRouter(
    [
      {
        id: ROUTE_ID,
        path: "/app/warranty-claims",
        Component: WarrantyClaimsListPage,
        loader: () => loaderData,
      },
    ],
    {
      initialEntries: ["/app/warranty-claims"],
      hydrationData: { loaderData: { [ROUTE_ID]: loaderData } },
    }
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("the default (open-claims) view", () => {
  it("lists the open claim with a link to its detail page", () => {
    const html = renderPage();
    const text = textOf(html);
    expect(text).toMatch(/WC-ABC12345/);
    expect(text).toMatch(/Ada Lovelace/);
    expect(html).toMatch(/href="\/app\/warranty-claims\/11111111-1111-1111-1111-111111111111"/);
  });

  it("shows a clear empty state when there are no open claims", () => {
    const text = textOf(renderPage({ rows: [], totalCount: 0 }));
    expect(text).toMatch(/No open warranty claims/);
  });

  it("never renders cost, margin or landed-cost figures", () => {
    const text = textOf(renderPage()).toLowerCase();
    expect(text).not.toMatch(/landed ?cost|gross margin|margin rate|uplift|wholesale/);
  });

  it("has a labelled, keyboard-operable search form", () => {
    const html = renderPage();
    expect(html).toMatch(/<label[^>]*for="q"/);
    expect(html).toMatch(/id="q"/);
    expect(html).toMatch(/<label[^>]*for="status"/);
    expect(html).toMatch(/<form[^>]*method="get"/i);
  });

  it("offers every status as a filter option", () => {
    const html = renderPage();
    for (const status of ["submitted", "under_review", "approved_covered", "denied_not_covered", "resolved", "closed"]) {
      expect(html).toMatch(new RegExp(`<option value="${status}"`));
    }
  });
});

describe("a search result", () => {
  it("shows the query and result count, and a way back to the open-claims view", () => {
    const html = renderPage({ query: "Ada", rows: [ROW_1], totalCount: 1 });
    const text = textOf(html);
    expect(text).toMatch(/Search results/);
    expect(text).toMatch(/1 total/);
    expect(html).toMatch(/Clear — show open claims/);
  });

  it("shows a clear no-match message distinct from the open-queue empty state", () => {
    const text = textOf(renderPage({ query: "nonexistent", rows: [], totalCount: 0 }));
    expect(text).toMatch(/No warranty claim matched that search/);
  });

  it("shows a resolved claim's coverage decision when present", () => {
    const text = textOf(renderPage({ rows: [ROW_2], totalCount: 1, statusFilter: "resolved" }));
    expect(text).toMatch(/covered/);
    expect(text).toMatch(/Grace Hopper/);
  });
});

describe("a failed search", () => {
  it("shows the error rather than crashing, and does not also claim there are no results", () => {
    const html = renderPage({ loadError: "database unavailable", rows: [] });
    const text = textOf(html);
    expect(text).toMatch(/Could not search warranty claims: database unavailable/);
    expect(text).not.toMatch(/No open warranty claims/);
  });
});

describe("pagination", () => {
  it("shows a Next link when more rows exist beyond this page", () => {
    const html = renderPage({ rows: [ROW_1], totalCount: 50, page: 1, pageSize: 25 });
    expect(html).toMatch(/Next/);
    expect(html).not.toMatch(/Previous/);
  });

  it("shows a Previous link on page 2, and a Next link if more remain", () => {
    const html = renderPage({ rows: [ROW_1], totalCount: 50, page: 2, pageSize: 25 });
    expect(html).toMatch(/Previous/);
    expect(html).not.toMatch(/Next/);
  });

  it("shows neither link when everything fits on one page", () => {
    const html = renderPage({ rows: [ROW_1], totalCount: 1, page: 1, pageSize: 25 });
    expect(html).not.toMatch(/Previous|Next/);
  });
});
