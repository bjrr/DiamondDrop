import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import type { BankPaymentOrderSummary } from "~/domain/bankpayment/verification.server";

import BankPaymentsListPage from "./app.bank-payments._index";

/**
 * Same technique as `alerts.test.tsx` / `_index.test.tsx`: nothing is
 * mocked. Only the loader's RESULT is supplied — running the real loader
 * would call `authenticate.admin` against a live session.
 */

const OPEN_ORDER: BankPaymentOrderSummary = {
  id: "11111111-1111-1111-1111-111111111111",
  status: "open",
  customerEmail: "ada@example.com",
  shopifyDraftOrderGid: "gid://shopify/DraftOrder/1",
  shopifyOrderGid: null,
  quotedAt: new Date("2026-09-20T10:00:00.000Z"),
  guaranteeExpiresAt: new Date("2026-09-21T10:00:00.000Z"),
  verifiedAt: null,
};

const COMPLETED_ORDER: BankPaymentOrderSummary = {
  id: "22222222-2222-2222-2222-222222222222",
  status: "completed",
  customerEmail: "grace@example.com",
  shopifyDraftOrderGid: "gid://shopify/DraftOrder/2",
  shopifyOrderGid: "gid://shopify/Order/2",
  quotedAt: new Date("2026-09-19T10:00:00.000Z"),
  guaranteeExpiresAt: new Date("2026-09-20T10:00:00.000Z"),
  verifiedAt: new Date("2026-09-19T12:00:00.000Z"),
};

const LOADER_DATA = {
  apiKey: "test-public-client-id",
  shop: "caratforus-dev.myshopify.com",
  query: "",
  orders: [OPEN_ORDER] as BankPaymentOrderSummary[],
  loadError: null as string | null,
};

function renderPage(data: Partial<typeof LOADER_DATA> = {}): string {
  const loaderData = { ...LOADER_DATA, ...data };
  const router = createMemoryRouter(
    [{ id: "bank-payments-list", path: "/app/bank-payments", Component: BankPaymentsListPage, loader: () => loaderData }],
    { initialEntries: ["/app/bank-payments"], hydrationData: { loaderData: { "bank-payments-list": loaderData } } }
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("the Bank Payment orders locating page", () => {
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

  it("has a real, labelled search field usable without a mouse", () => {
    const html = renderPage();
    expect(html).toMatch(/<label[^>]*for="q"/);
    expect(html).toMatch(/id="q"/);
    expect(html).toMatch(/<form[^>]*method="get"/i);
  });

  it("lists an order's customer email, status and a link to open it", () => {
    const html = renderPage();
    const text = textOf(html);
    expect(text).toMatch(/ada@example\.com/);
    expect(text).toMatch(/Open — awaiting verification/);
    expect(html).toMatch(/href="\/app\/bank-payments\/11111111-1111-1111-1111-111111111111"/);
  });

  it("shows a clear empty state for a blank query with no open orders", () => {
    const text = textOf(renderPage({ orders: [] }));
    expect(text).toMatch(/No open Bank Payment orders/i);
  });

  it("shows a clear empty state for a non-matching search", () => {
    const text = textOf(renderPage({ orders: [], query: "nobody@example.com" }));
    expect(text).toMatch(/No Bank Payment order matched/i);
    expect(text).toMatch(/nobody@example\.com/);
  });

  it("shows a load-error banner instead of crashing when the search fails", () => {
    const text = textOf(renderPage({ orders: [], loadError: "Prisma connection refused" }));
    expect(text).toMatch(/Could not search Bank Payment orders/i);
    expect(text).toMatch(/Prisma connection refused/);
  });

  it("never renders cost, margin or landed-cost figures", () => {
    // Matched against visible TEXT, not raw markup — the inline `style`
    // attributes on every element legitimately contain the CSS word
    // "margin" (margin:0 0 1rem), which is not the hazard this guards.
    const text = textOf(renderPage({ orders: [OPEN_ORDER, COMPLETED_ORDER] }));
    expect(text.toLowerCase()).not.toMatch(/landed ?cost|gross margin|margin rate|uplift/);
  });

  it("distinguishes verified from not-yet-verified without relying on colour alone", () => {
    const html = renderPage({ orders: [OPEN_ORDER, COMPLETED_ORDER] });
    const text = textOf(html);
    expect(text).toMatch(/Not yet/);
    expect(text).toMatch(/Yes/);
  });
});
