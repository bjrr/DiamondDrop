import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import LuxuryStealsAssignmentPage, { type ProductView, type VariantView } from "./app.luxury-steals._index";

/**
 * Same technique as `app.bank-payments.$id.test.tsx`: nothing is mocked.
 * Only the loader's RESULT is supplied — running the real loader would call
 * `authenticate.admin` against a live session/store. The database-facing
 * decision logic this page renders is exercised for real in
 * `tests/integration/luxurysteals/luxuryStealRepository.test.ts` and
 * `tests/integration/luxurysteals/syncAssignment.test.ts`.
 */

const ROUTE_ID = "luxury-steals-index";

const ASSIGNED_VARIANT: VariantView = {
  masterVariantId: "11111111-1111-1111-1111-111111111111",
  shopifyVariantGid: "gid://shopify/ProductVariant/1",
  isLuxurySteal: true,
  metal: "gold",
  purity: "GOLD_14K",
  bandLabel: "6-6.5",
  syncFailure: null,
};

const UNASSIGNED_VARIANT: VariantView = {
  masterVariantId: "22222222-2222-2222-2222-222222222222",
  shopifyVariantGid: "gid://shopify/ProductVariant/2",
  isLuxurySteal: false,
  metal: "platinum",
  purity: "pt950" as VariantView["purity"],
  bandLabel: null,
  syncFailure: null,
};

const FAILING_VARIANT: VariantView = {
  masterVariantId: "33333333-3333-3333-3333-333333333333",
  shopifyVariantGid: "gid://shopify/ProductVariant/3",
  isLuxurySteal: true,
  metal: "gold",
  purity: "GOLD_18K",
  bandLabel: "7-7.5",
  syncFailure: {
    attemptCount: 3,
    lastError: "Shopify Admin API metafieldsSet failed: userErrors present",
    firstFailedAt: "2026-09-24T00:00:00.000Z",
  },
};

const NOT_LINKED_VARIANT: VariantView = {
  masterVariantId: "44444444-4444-4444-4444-444444444444",
  shopifyVariantGid: null,
  isLuxurySteal: false,
  metal: "gold",
  purity: "GOLD_10K",
  bandLabel: null,
  syncFailure: null,
};

const A_PRODUCT: ProductView = {
  masterProductId: "aaaaaaaa-1111-1111-1111-111111111111",
  name: "Solitaire Engagement Ring",
  variants: [ASSIGNED_VARIANT, UNASSIGNED_VARIANT, FAILING_VARIANT, NOT_LINKED_VARIANT],
};

const LOADER_DATA = {
  apiKey: "test-public-client-id",
  shop: "caratforus-dev.myshopify.com",
  query: "",
  products: [A_PRODUCT] as ProductView[],
  loadError: null as string | null,
};

function renderPage(data: Partial<typeof LOADER_DATA> = {}): string {
  const loaderData = { ...LOADER_DATA, ...data };
  const router = createMemoryRouter(
    [
      {
        id: ROUTE_ID,
        path: "/app/luxury-steals",
        Component: LuxuryStealsAssignmentPage,
        loader: () => loaderData,
      },
    ],
    {
      initialEntries: ["/app/luxury-steals"],
      hydrationData: { loaderData: { [ROUTE_ID]: loaderData } },
    }
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("the Luxury Steal assignment page — listing", () => {
  it("shows the product name and each variant's identification", () => {
    const text = textOf(renderPage());
    expect(text).toMatch(/Solitaire Engagement Ring/);
    expect(text).toMatch(/gold \/ GOLD_14K \/ band 6-6\.5/);
    expect(text).toMatch(/platinum \/ pt950/);
  });

  it("labels assigned vs unassigned state in plain text, not colour alone", () => {
    const text = textOf(renderPage());
    expect(text).toMatch(/Assigned \(Luxury Steal, Final Sale\)/);
    expect(text).toMatch(/Not assigned/);
  });

  it("shows a variant with no Shopify linkage distinctly, not as an error", () => {
    const text = textOf(renderPage());
    expect(text).toMatch(/Not yet linked to a Shopify variant/);
  });

  it("shows the empty-catalogue message when there are no products", () => {
    const text = textOf(renderPage({ products: [] }));
    expect(text).toMatch(/No products found/);
  });

  it("shows the search-specific empty message when a query matched nothing", () => {
    const text = textOf(renderPage({ products: [], query: "nonexistent" }));
    expect(text).toMatch(/No product matched &quot;nonexistent&quot;/);
  });

  it("shows the load error banner rather than crashing when the read failed", () => {
    const text = textOf(renderPage({ loadError: "database unreachable" }));
    expect(text).toMatch(/Could not load Luxury Steal assignments: database unreachable/);
  });
});

describe("the Luxury Steal assignment page — mutation forms", () => {
  it("offers Assign for an unassigned variant and Unassign for an assigned one, each posting the correct intent", () => {
    const html = renderPage();
    expect(html).toMatch(
      new RegExp(`name="masterVariantId" value="${ASSIGNED_VARIANT.masterVariantId}"[\\s\\S]*?name="intent" value="unassign"`)
    );
    expect(html).toMatch(
      new RegExp(`name="masterVariantId" value="${UNASSIGNED_VARIANT.masterVariantId}"[\\s\\S]*?name="intent" value="assign"`)
    );
  });

  it("every mutation form posts (method=post), never a GET", () => {
    const html = renderPage();
    const formTags = html.match(/<form[^>]*>/g) ?? [];
    // The search form is a GET by design (role="search"); every OTHER form must be POST.
    const nonSearchForms = formTags.filter((tag) => !tag.includes('role="search"'));
    expect(nonSearchForms.length).toBeGreaterThan(0);
    expect(nonSearchForms.every((tag) => /method="post"/i.test(tag))).toBe(true);
  });

  it("offers per-product 'apply to all variants' actions with the correct product id and flag", () => {
    const html = renderPage();
    expect(html).toMatch(
      new RegExp(`name="masterProductId" value="${A_PRODUCT.masterProductId}"[\\s\\S]*?name="intent" value="apply-to-product"[\\s\\S]*?name="isLuxurySteal" value="true"`)
    );
    expect(html).toMatch(/Assign all variants/);
    expect(html).toMatch(/Unassign all variants/);
  });

  it("offers 'Retry sync' only for a variant with an open sync failure", () => {
    const html = renderPage();
    // Exactly one retry-sync form — for FAILING_VARIANT only.
    const retryForms = html.match(/name="intent" value="retry-sync"/g) ?? [];
    expect(retryForms).toHaveLength(1);
    expect(html).toMatch(
      new RegExp(`name="masterVariantId" value="${FAILING_VARIANT.masterVariantId}"[\\s\\S]*?name="intent" value="retry-sync"`)
    );
  });
});

describe("the Luxury Steal assignment page — sync failure visibility (criterion 152)", () => {
  it("shows the failure detail and states the variant is still purchasable", () => {
    const text = textOf(renderPage());
    expect(text).toMatch(/Sync failing since/);
    expect(text).toMatch(/3 attempts/);
    expect(text).toMatch(/Shopify Admin API metafieldsSet failed/);
    expect(text).toMatch(/still purchasable/i);
  });

  it("does not show a sync-failure notice for a variant with no open failure", () => {
    const html = renderPage({ products: [{ ...A_PRODUCT, variants: [ASSIGNED_VARIANT] }] });
    expect(html).not.toMatch(/Sync failing since/);
  });
});

describe("the Luxury Steal assignment page — search and navigation", () => {
  it("has a labelled search-by-product-name field", () => {
    const html = renderPage();
    expect(html).toMatch(/<label[^>]*for="q"/);
    expect(html).toMatch(/id="q"/);
  });

  it("links to the held-orders admin surface", () => {
    const html = renderPage();
    expect(html).toMatch(/href="\/app\/luxury-steals\/held-orders"/);
  });
});

describe("the Luxury Steal assignment page — never leaks cost/margin data", () => {
  it("renders no cost, margin, landed-cost or uplift figures", () => {
    const text = textOf(renderPage()).toLowerCase();
    expect(text).not.toMatch(/landed ?cost|gross margin|margin rate|uplift|cost component/);
  });
});
