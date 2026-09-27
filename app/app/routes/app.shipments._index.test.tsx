import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import ShipmentsListPage from "./app.shipments._index";
import type { ShipmentStaffListRow } from "~/db/repositories/shipmentRepository.server";

const ROUTE_ID = "shipments-list";

function row(overrides: Partial<ShipmentStaffListRow> = {}): ShipmentStaffListRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    orderRef: "gid://shopify/Order/1",
    carrier: "USPS",
    trackingNumber: "TRACK-1",
    shipDate: new Date("2026-09-25"),
    signatureRequired: false,
    signatureRequiredSource: "rule",
    computedMerchandiseValueMinorUnits: 5000n,
    computedMerchandiseValueCurrency: "USD",
    insuredValueMinorUnits: null,
    insuredValueCurrency: null,
    insuranceProviderId: null,
    insuranceCoverageVerifiedAt: null,
    deliveredAt: null,
    ...overrides,
  } as ShipmentStaffListRow;
}

function renderPage(rows: ShipmentStaffListRow[], overrides: Partial<{ query: string; totalCount: number; loadError: string | null }> = {}) {
  const loaderData = {
    apiKey: "test-public-client-id",
    shop: "caratforus-dev.myshopify.com",
    query: overrides.query ?? "",
    rows,
    totalCount: overrides.totalCount ?? rows.length,
    page: 1,
    pageSize: 25,
    loadError: overrides.loadError ?? null,
  };
  const router = createMemoryRouter(
    [{ id: ROUTE_ID, path: "/app/shipments", Component: ShipmentsListPage, loader: () => loaderData }],
    { initialEntries: ["/app/shipments"], hydrationData: { loaderData: { [ROUTE_ID]: loaderData } } }
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("shipments list", () => {
  it("shows an empty state when there are no shipments", () => {
    expect(textOf(renderPage([]))).toMatch(/No shipments recorded yet/);
  });

  it("shows a row's order, carrier, and tracking number", () => {
    const text = textOf(renderPage([row()]));
    expect(text).toMatch(/gid:\/\/shopify\/Order\/1/);
    expect(text).toMatch(/USPS/);
    expect(text).toMatch(/TRACK-1/);
  });

  it("flags a divergence between insured and computed value", () => {
    const text = textOf(
      renderPage([row({ insuredValueMinorUnits: 100n, insuredValueCurrency: "USD", computedMerchandiseValueMinorUnits: 50000n })])
    );
    // The warning glyph is rendered with a title attribute explaining the divergence.
    expect(renderPage([row({ insuredValueMinorUnits: 100n, insuredValueCurrency: "USD", computedMerchandiseValueMinorUnits: 50000n })])).toMatch(
      /Recorded insured value differs from the computed shipment merchandise value/
    );
    expect(text).toBeTruthy();
  });

  it("does not flag a divergence when insured value matches computed value", () => {
    const html = renderPage([row({ insuredValueMinorUnits: 5000n, insuredValueCurrency: "USD", computedMerchandiseValueMinorUnits: 5000n })]);
    expect(html).not.toMatch(/Recorded insured value differs/);
  });

  it("shows a load error rather than crashing", () => {
    expect(textOf(renderPage([], { loadError: "database unreachable" }))).toMatch(/database unreachable/);
  });
});
