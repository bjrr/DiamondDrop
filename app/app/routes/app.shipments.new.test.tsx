import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import NewShipmentPage from "./app.shipments.new";

const ROUTE_ID = "shipment-new";

function renderPage(actionData?: unknown): string {
  const loaderData = { apiKey: "test-public-client-id", shop: "caratforus-dev.myshopify.com", maxContentLines: 6 };
  const router = createMemoryRouter(
    [{ id: ROUTE_ID, path: "/app/shipments/new", Component: NewShipmentPage, loader: () => loaderData }],
    {
      initialEntries: ["/app/shipments/new"],
      hydrationData: { loaderData: { [ROUTE_ID]: loaderData }, ...(actionData ? { actionData: { [ROUTE_ID]: actionData } } : {}) },
    }
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("new shipment form", () => {
  it("renders the required core fields", () => {
    const html = renderPage();
    expect(html).toMatch(/name="orderRef"/);
    expect(html).toMatch(/name="carrier"/);
    expect(html).toMatch(/name="trackingNumber"/);
    expect(html).toMatch(/name="shipDate"/);
  });

  it("renders content-line rows up to maxContentLines", () => {
    const html = renderPage();
    expect(html).toMatch(/name="contentQuantity_1"/);
    expect(html).toMatch(/name="contentQuantity_6"/);
    expect(html).not.toMatch(/name="contentQuantity_7"/);
  });

  it("never renders a field for amount paid, tender, or payment method", () => {
    const html = renderPage();
    expect(html).not.toMatch(/amountPaid|tender|paymentMethod/i);
  });

  it("shows a returned form error", () => {
    const html = renderPage({ ok: false, formError: "At least one content line is required." });
    expect(textOf(html)).toMatch(/At least one content line is required/);
  });
});
