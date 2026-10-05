import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import GroupBuyCampaignsListPage from "./app.group-buy-campaigns._index";

/**
 * Same fixture-based technique as the sibling route tests. `listGroupBuyCampaignsForStaff`
 * (the real, DB-backed query) is exercised in
 * `tests/integration/groupbuy/groupBuyRepository.test.ts`. Its own explicit
 * `select` already makes leaking a price/cost field a compile error, not
 * merely a review miss, but the smoke test below still confirms the list
 * page renders only what that select provides.
 */

const ROUTE_ID = "group-buy-campaigns-list";

interface CampaignRowFixture {
  id: string;
  code: string;
  name: string;
  status: string;
  currency: string;
  scheduledCloseAt: string | null;
  openedAt: string | null;
  closedAt: string | null;
  createdAt: string;
  tierCount: number;
  variantCount: number;
  tierPublish: { tierNumber: number; published: boolean } | null;
}

const ROW: CampaignRowFixture = {
  id: "11111111-1111-1111-1111-111111111111",
  code: "gb-summer-rings",
  name: "Summer Rings Group Buy",
  status: "draft",
  currency: "USD",
  scheduledCloseAt: null,
  openedAt: null,
  closedAt: null,
  createdAt: "2026-09-20T10:00:00.000Z",
  tierCount: 3,
  variantCount: 2,
  tierPublish: null,
};

function renderPage(
  campaigns: readonly CampaignRowFixture[],
  loadError: string | null = null,
  view: "operational" | "archived" | "all" = "operational"
): string {
  const loaderData = { apiKey: "test-public-client-id", shop: "caratforus-dev.myshopify.com", campaigns, loadError, view };
  const router = createMemoryRouter(
    [
      {
        id: ROUTE_ID,
        path: "/app/group-buy-campaigns",
        Component: GroupBuyCampaignsListPage,
        loader: () => loaderData,
      },
    ],
    { initialEntries: ["/app/group-buy-campaigns"], hydrationData: { loaderData: { [ROUTE_ID]: loaderData } } }
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("Group Buy campaigns list", () => {
  it("lists a campaign's code, name, status, and counts, with a link to its detail page", () => {
    const html = renderPage([ROW]);
    const text = textOf(html);
    expect(text).toMatch(/gb-summer-rings/);
    expect(text).toMatch(/Summer Rings Group Buy/);
    expect(text).toMatch(/Draft/);
    expect(html).toMatch(new RegExp(`/app/group-buy-campaigns/${ROW.id}`));
  });

  it("offers a link to create a new campaign", () => {
    expect(renderPage([ROW])).toMatch(/\/app\/group-buy-campaigns\/new/);
  });

  it("names the view in the empty state, so an empty Archived list is not read as a broken page", () => {
    // The default view deliberately says where the missing rows might BE,
    // rather than "none yet" — which would be wrong the moment anything is
    // archived, and would send a staff member looking for a bug.
    expect(textOf(renderPage([]))).toMatch(/no active Group Buy campaigns/i);
    expect(textOf(renderPage([]))).toMatch(/archived view/i);
    expect(textOf(renderPage([], null, "archived"))).toMatch(/no archived Group Buy campaigns/i);
    expect(textOf(renderPage([], null, "all"))).toMatch(/no Group Buy campaigns yet/i);
  });

  it("shows a clear load error rather than crashing", () => {
    expect(textOf(renderPage([], "database unavailable"))).toMatch(/could not load/i);
  });

  it("never renders a price, cost, or margin figure — the row shape has none to leak", () => {
    // Checked on the tag-stripped text, not the raw markup — a CSS
    // `margin:0` style property would otherwise false-positive this check.
    expect(textOf(renderPage([ROW]))).not.toMatch(/margin|landedcost|wholesale|\$\d/i);
  });

  it("shows no publish claim at all for a campaign with no publish status (draft/closed) — not applicable, not a false negative", () => {
    const text = textOf(renderPage([ROW]));
    expect(text).not.toMatch(/live|NOT on Shopify/);
  });

  it("flags an open campaign whose tier price never reached Shopify, distinctly from a healthy one", () => {
    const gap = { ...ROW, id: "22222222-2222-2222-2222-222222222222", status: "open", tierPublish: { tierNumber: 1, published: false } };
    const healthy = { ...ROW, id: "33333333-3333-3333-3333-333333333333", status: "open", tierPublish: { tierNumber: 2, published: true } };
    const text = textOf(renderPage([gap, healthy]));
    expect(text).toMatch(/Tier 1 NOT on Shopify/);
    expect(text).toMatch(/Tier 2 live/);
  });
});

/**
 * ARCHIVING MUST NEVER MAKE HISTORY UNREACHABLE (owner-locked 2026-10-05).
 * The data layer enforces that; these assert the UI actually offers the way in.
 */
describe("the archived view is reachable from the page", () => {
  it("offers Active, Archived and All", () => {
    const text = textOf(renderPage([ROW]));
    expect(text).toMatch(/Active/);
    expect(text).toMatch(/Archived/);
    expect(text).toMatch(/All/);
  });

  it("links to the archived and all views", () => {
    const html = renderPage([ROW]);
    expect(html).toMatch(/\/app\/group-buy-campaigns\?view=archived/);
    expect(html).toMatch(/\/app\/group-buy-campaigns\?view=all/);
  });

  it("marks the current view, so a staff member can tell which list they are reading", () => {
    // Without this, an Archived list showing few rows looks identical to an
    // Active list showing few rows.
    expect(renderPage([ROW], null, "archived")).toMatch(/aria-current="page"/);
  });
});
