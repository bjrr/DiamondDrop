import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import NewGroupBuyCampaignPage from "./app.group-buy-campaigns.new";
import { InvalidTierSetError, MAX_TIERS, MIN_TIERS, validateTierSet } from "~/domain/groupbuy/tiers";

/**
 * Same fixture-based technique as `app.group-buy-campaigns.$id.test.tsx` —
 * the real DB-backed `createGroupBuyCampaign` path is exercised in
 * `tests/integration/groupbuy/groupBuyRepository.test.ts`. This file covers
 * the one thing genuinely new here: that a rejected tier set's problems are
 * surfaced verbatim from the REAL `validateTierSet`, never re-worded.
 */

const ROUTE_ID = "group-buy-campaign-new";

function renderPage(actionData?: { ok: boolean; formError: string | null; problems: readonly string[] }): string {
  const loaderData = {
    apiKey: "test-public-client-id",
    shop: "caratforus-dev.myshopify.com",
    minTiers: MIN_TIERS,
    maxTiers: MAX_TIERS,
  };
  const router = createMemoryRouter(
    [
      {
        id: ROUTE_ID,
        path: "/app/group-buy-campaigns/new",
        Component: NewGroupBuyCampaignPage,
        loader: () => loaderData,
      },
    ],
    {
      initialEntries: ["/app/group-buy-campaigns/new"],
      hydrationData: {
        loaderData: { [ROUTE_ID]: loaderData },
        ...(actionData ? { actionData: { [ROUTE_ID]: actionData } } : {}),
      },
    }
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("new Group Buy campaign form", () => {
  it("renders a code/name/currency field and one row per tier up to MAX_TIERS", () => {
    const html = renderPage();
    expect(html).toMatch(/id="code"/);
    expect(html).toMatch(/id="name"/);
    expect(html).toMatch(/id="currency"/);
    for (let tierNumber = 1; tierNumber <= MAX_TIERS; tierNumber++) {
      expect(html).toMatch(new RegExp(`id="tierUnits_${tierNumber}"`));
      expect(html).toMatch(new RegExp(`id="tierPercentOff_${tierNumber}"`));
    }
    expect(textOf(html)).toMatch(/Create draft campaign/);
  });

  it("states plainly that opening freezes pricing and is a separate later step", () => {
    expect(textOf(renderPage())).toMatch(/starts as a draft/i);
    expect(textOf(renderPage())).toMatch(/Opening freezes pricing permanently/i);
  });

  it("surfaces the REAL validateTierSet's rejection verbatim, not a generic message", () => {
    let problems: readonly string[] = [];
    try {
      validateTierSet([{ tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" }]); // below MIN_TIERS
    } catch (error) {
      if (error instanceof InvalidTierSetError) problems = error.problems;
    }
    expect(problems.length).toBeGreaterThan(0);

    const html = renderPage({ ok: false, formError: "The tier set is invalid.", problems });
    for (const problem of problems) {
      expect(textOf(html)).toContain(problem);
    }
  });

  it("surfaces a duplicate-code conflict plainly", () => {
    const html = renderPage({
      ok: false,
      formError: 'Campaign code "gb-summer-rings" is already in use. Choose a different code.',
      problems: [],
    });
    expect(textOf(html)).toMatch(/already in use/);
  });
});
