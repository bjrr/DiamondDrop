import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import ShipmentDetailPage from "./app.shipments.$id";

/**
 * Same technique as `app.warranty-claims.$id.test.tsx`: nothing is mocked.
 * Only the loader's RESULT is supplied — running the real loader would call
 * `authenticate.admin` and the database. The repository/domain logic this
 * page calls into is exercised for real in
 * `tests/integration/shipping/shipmentRepository.test.ts`. This file's job
 * is the UI logic that is genuinely new here: the computed-vs-recorded
 * divergence banner, the "rule says" recomputation for display, and which
 * controls are offered given the shipment's current state.
 */

const ROUTE_ID = "shipment-detail";

interface AddressFixture {
  line1: string;
  line2: string | null;
  city: string;
  region: string | null;
  postalCode: string;
  country: string;
}

const ADDRESS: AddressFixture = {
  line1: "123 Main St",
  line2: null,
  city: "Springfield",
  region: "IL",
  postalCode: "62704",
  country: "US",
};

interface ShipmentViewFixture {
  id: string;
  orderRef: string;
  carrier: string;
  service: string | null;
  trackingNumber: string;
  shipDate: string;
  computedMerchandiseValueMinorUnits: string | null;
  computedMerchandiseValueCurrency: string | null;
  insuredValueMinorUnits: string | null;
  insuredValueCurrency: string | null;
  insuranceReference: string | null;
  insuranceProviderId: string | null;
  insuranceCoverageVerifiedAt: string | null;
  insuranceCoverageVerifiedByActorRef: string | null;
  signatureRequired: boolean;
  signatureRequiredSource: string;
  signatureRequiredSetByActorRef: string | null;
  signatureRequiredSetAt: string | null;
  signatureServiceUsed: string | null;
  deliveredAt: string | null;
  deliveryConfirmationReference: string | null;
  proofOfSignatureReference: string | null;
  address: AddressFixture;
  enteredByActorRef: string;
  enteredAt: string;
  addressChanges: unknown[];
}

const BASE_SHIPMENT: ShipmentViewFixture = {
  id: "11111111-1111-1111-1111-111111111111",
  orderRef: "gid://shopify/Order/1",
  carrier: "USPS",
  service: "Priority Mail",
  trackingNumber: "TRACK-1",
  shipDate: "2026-09-25T00:00:00.000Z",
  computedMerchandiseValueMinorUnits: "5000",
  computedMerchandiseValueCurrency: "USD",
  insuredValueMinorUnits: null,
  insuredValueCurrency: null,
  insuranceReference: null,
  insuranceProviderId: null,
  insuranceCoverageVerifiedAt: null,
  insuranceCoverageVerifiedByActorRef: null,
  signatureRequired: false,
  signatureRequiredSource: "rule",
  signatureRequiredSetByActorRef: null,
  signatureRequiredSetAt: null,
  signatureServiceUsed: null,
  deliveredAt: null,
  deliveryConfirmationReference: null,
  proofOfSignatureReference: null,
  address: ADDRESS,
  enteredByActorRef: "staff:alice",
  enteredAt: "2026-09-25T09:00:00.000Z",
  addressChanges: [],
};

const INSURANCE_PROVIDERS = [{ id: "jewelers_mutual", displayName: "JM Shipping Solution / Jewelers Mutual" }];

function renderPage(shipment: ShipmentViewFixture | null, actionData?: unknown): string {
  const loaderData = { apiKey: "test-public-client-id", shop: "caratforus-dev.myshopify.com", shipment, insuranceProviders: INSURANCE_PROVIDERS };
  const router = createMemoryRouter(
    [
      {
        id: ROUTE_ID,
        path: "/app/shipments/:id",
        Component: ShipmentDetailPage,
        loader: () => loaderData,
      },
    ],
    {
      initialEntries: [`/app/shipments/${shipment?.id ?? "unknown"}`],
      hydrationData: {
        loaderData: { [ROUTE_ID]: loaderData },
        ...(actionData ? { actionData: { [ROUTE_ID]: actionData } } : {}),
      },
    }
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("shipment not found", () => {
  it("shows a clear not-found message rather than crashing", () => {
    expect(textOf(renderPage(null))).toMatch(/not found/i);
  });
});

describe("a shipment at/under the $100 threshold — rule says not required", () => {
  it("shows the computed value and 'rule says' signature not required", () => {
    const text = textOf(renderPage({ ...BASE_SHIPMENT, computedMerchandiseValueMinorUnits: "10000" }));
    expect(text).toMatch(/Rule says.*signature not required/i);
    expect(text).toMatch(/Not required/);
  });
});

describe("a shipment just above the $100 threshold — rule says required", () => {
  it("shows 'rule says' signature required, sourced from the rule", () => {
    const text = textOf(
      renderPage({ ...BASE_SHIPMENT, computedMerchandiseValueMinorUnits: "10001", signatureRequired: true, signatureRequiredSource: "rule" })
    );
    expect(text).toMatch(/Rule says.*signature required/i);
    expect(text).toMatch(/source: rule/);
  });
});

describe("a staff override — recorded distinctly from the rule", () => {
  it("shows the override's actor and reason, distinct from the rule's own answer", () => {
    const text = textOf(
      renderPage({
        ...BASE_SHIPMENT,
        computedMerchandiseValueMinorUnits: "1000", // rule alone says NOT required
        signatureRequired: true,
        signatureRequiredSource: "staff_override",
        signatureRequiredSetByActorRef: "staff:bob",
        signatureRequiredSetAt: "2026-09-25T10:00:00.000Z",
      })
    );
    expect(text).toMatch(/Rule says.*signature not required/i);
    expect(text).toMatch(/source: staff_override/);
    expect(text).toMatch(/staff:bob/);
  });
});

describe("insured value diverging from computed merchandise value — visible, not silent (D30/G2)", () => {
  it("flags a divergence when insured value differs from computed value", () => {
    const text = textOf(
      renderPage({
        ...BASE_SHIPMENT,
        computedMerchandiseValueMinorUnits: "50000000",
        insuredValueMinorUnits: "5000000",
        insuredValueCurrency: "USD",
      })
    );
    expect(text).toMatch(/differs from the computed merchandise value/i);
  });

  it("does not flag anything when the two figures agree", () => {
    const text = textOf(
      renderPage({
        ...BASE_SHIPMENT,
        computedMerchandiseValueMinorUnits: "5000",
        insuredValueMinorUnits: "5000",
        insuredValueCurrency: "USD",
      })
    );
    expect(text).not.toMatch(/differs from the computed merchandise value/i);
  });

  it("does not flag anything when neither figure is recorded", () => {
    const text = textOf(renderPage({ ...BASE_SHIPMENT, computedMerchandiseValueMinorUnits: null, computedMerchandiseValueCurrency: null }));
    expect(text).not.toMatch(/differs from the computed merchandise value/i);
  });
});

describe("insurance verification control — only offered once a provider AND reference are on record and unverified", () => {
  it("does not offer 'mark verified' when no provider/reference is recorded", () => {
    const html = renderPage(BASE_SHIPMENT);
    expect(html).not.toMatch(/Mark coverage verified/);
  });

  it("offers 'mark verified' once a provider and reference are recorded but not yet verified", () => {
    const html = renderPage({
      ...BASE_SHIPMENT,
      insuranceProviderId: "jewelers_mutual",
      insuranceReference: "JM-CERT-1",
      insuredValueMinorUnits: "5000",
      insuredValueCurrency: "USD",
    });
    expect(html).toMatch(/Mark coverage verified/);
  });

  it("does not offer 'mark verified' again once already verified", () => {
    const html = renderPage({
      ...BASE_SHIPMENT,
      insuranceProviderId: "jewelers_mutual",
      insuranceReference: "JM-CERT-1",
      insuredValueMinorUnits: "5000",
      insuredValueCurrency: "USD",
      insuranceCoverageVerifiedAt: "2026-09-26T10:00:00.000Z",
      insuranceCoverageVerifiedByActorRef: "staff:alice",
    });
    expect(html).not.toMatch(/Mark coverage verified/);
    expect(textOf(html)).toMatch(/Yes — by staff:alice/);
  });

  it("shows the provider's display name, not its bare id", () => {
    const text = textOf(
      renderPage({ ...BASE_SHIPMENT, insuranceProviderId: "jewelers_mutual", insuranceReference: "JM-CERT-1" })
    );
    expect(text).toMatch(/JM Shipping Solution \/ Jewelers Mutual/);
  });
});

describe("form error surfaced from a failed action", () => {
  it("shows the returned form error", () => {
    const html = renderPage(BASE_SHIPMENT, { ok: false, formError: "Invalid shipment insurance purchase: bad reference" });
    expect(textOf(html)).toMatch(/bad reference/);
  });
});
