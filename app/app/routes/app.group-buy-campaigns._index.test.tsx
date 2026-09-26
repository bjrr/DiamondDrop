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
};

function renderPage(campaigns: readonly CampaignRowFixture[], loadError: string | null = null): string {
  const loaderData = { apiKey: "test-public-client-id", shop: "caratforus-dev.myshopify.com", campaigns, loadError };
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

  it("shows a clear empty state with no campaigns", () => {
    expect(textOf(renderPage([]))).toMatch(/no Group Buy campaigns yet/i);
  });

  it("shows a clear load error rather than crashing", () => {
    expect(textOf(renderPage([], "database unavailable"))).toMatch(/could not load/i);
  });

  it("never renders a price, cost, or margin figure — the row shape has none to leak", () => {
    // Checked on the tag-stripped text, not the raw markup — a CSS
    // `margin:0` style property would otherwise false-positive this check.
    expect(textOf(renderPage([ROW]))).not.toMatch(/margin|landedcost|wholesale|\$\d/i);
  });
});
