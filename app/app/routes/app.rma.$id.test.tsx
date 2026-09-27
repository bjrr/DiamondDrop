import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import RmaDetailPage from "./app.rma.$id";

/**
 * Same technique as `app.warranty-claims.$id.test.tsx`: nothing is mocked —
 * only the loader's RESULT is supplied. The repository/domain/job logic this
 * page calls into is exercised for real in
 * `tests/integration/rma/{rmaRepository,executeRmaRemedy}.test.ts`. This
 * file's job is the UI-gating logic that is genuinely new here — in
 * particular that the automated `execute_remedy` and manual
 * `update_remedy_status` controls are offered only while the remedy is not
 * yet `issued`, and that `execute_remedy` disappears once it is.
 */

const ROUTE_ID = "rma-detail";

interface RmaRemedyViewFixture {
  id: string;
  kind: string;
  status: string;
  eligibleMerchandiseAmountMinorUnits: string;
  merchandiseAmountMinorUnits: string;
  restockingFeeMinorUnits: string;
  currency: string;
  shopifyTaxAdjustmentMinorUnits: string | null;
  actualRefundOrCreditMinorUnits: string | null;
  processorReference: string | null;
  failureReason: string | null;
  staffReviewReason: string | null;
  issuedAt: string | null;
}

interface RmaViewFixture {
  id: string;
  rmaReference: string;
  orderRef: string;
  lineRef: string;
  customerRef: string | null;
  itemConfigurationDescription: string;
  purchaserEmail: string;
  carrierConfirmedDeliveryDate: string;
  requestedAt: string;
  calendarDaysSinceDelivery: number;
  reasonCategory: string;
  reasonExplanation: string;
  requestedRemedyKind: string | null;
  isPersonalizedOrAltered: boolean;
  hasProductSpecificReturnOverride: boolean;
  windowKind: string;
  eligibleMerchandiseAmountMinorUnits: string;
  eligibleMerchandiseAmountCurrency: string;
  status: string;
  approvedAt: string | null;
  deniedAt: string | null;
  denialReason: string | null;
  receiveByDeadline: string | null;
  returnTrackingCarrier: string | null;
  returnTrackingNumber: string | null;
  returnInsuranceReference: string | null;
  returnInsuredValueMinorUnits: string | null;
  returnInsuredValueCurrency: string | null;
  returnShippedAt: string | null;
  expiredAt: string | null;
  receivedAt: string | null;
  packageCondition: string | null;
  itemCondition: string | null;
  inspectionNotes: string | null;
  conditionDecision: string | null;
  conditionDecisionReason: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  events: unknown[];
  remedy: RmaRemedyViewFixture | null;
}

const SUBMITTED_RMA: RmaViewFixture = {
  id: "11111111-1111-1111-1111-111111111111",
  rmaReference: "RMA-ABC12345",
  orderRef: "gid://shopify/Order/1",
  lineRef: "gid://shopify/LineItem/1",
  customerRef: "gid://shopify/Customer/1",
  itemConfigurationDescription: "14k gold solitaire ring, size 7",
  purchaserEmail: "ada@example.com",
  carrierConfirmedDeliveryDate: "2026-01-01T00:00:00.000Z",
  requestedAt: "2026-01-04T00:00:00.000Z",
  calendarDaysSinceDelivery: 3,
  reasonCategory: "buyer_remorse",
  reasonExplanation: "Changed my mind about the style.",
  requestedRemedyKind: null,
  isPersonalizedOrAltered: false,
  hasProductSpecificReturnOverride: false,
  windowKind: "standard",
  eligibleMerchandiseAmountMinorUnits: "25000",
  eligibleMerchandiseAmountCurrency: "USD",
  status: "submitted",
  approvedAt: null,
  deniedAt: null,
  denialReason: null,
  receiveByDeadline: null,
  returnTrackingCarrier: null,
  returnTrackingNumber: null,
  returnInsuranceReference: null,
  returnInsuredValueMinorUnits: null,
  returnInsuredValueCurrency: null,
  returnShippedAt: null,
  expiredAt: null,
  receivedAt: null,
  packageCondition: null,
  itemCondition: null,
  inspectionNotes: null,
  conditionDecision: null,
  conditionDecisionReason: null,
  resolvedAt: null,
  closedAt: null,
  events: [],
  remedy: null,
};

const INSPECTION_PASSED_RMA: RmaViewFixture = {
  ...SUBMITTED_RMA,
  status: "inspection_passed",
  approvedAt: "2026-01-05T00:00:00.000Z",
  receivedAt: "2026-01-08T00:00:00.000Z",
  conditionDecision: "accepted",
};

function remedyFixture(overrides: Partial<RmaRemedyViewFixture>): RmaRemedyViewFixture {
  return {
    id: "remedy-1",
    kind: "refund_original_payment",
    status: "pending",
    eligibleMerchandiseAmountMinorUnits: "25000",
    merchandiseAmountMinorUnits: "25000",
    restockingFeeMinorUnits: "0",
    currency: "USD",
    shopifyTaxAdjustmentMinorUnits: null,
    actualRefundOrCreditMinorUnits: null,
    processorReference: null,
    failureReason: null,
    staffReviewReason: null,
    issuedAt: null,
    ...overrides,
  };
}

const REMEDY_IN_PROGRESS_RMA: RmaViewFixture = {
  ...INSPECTION_PASSED_RMA,
  status: "remedy_in_progress",
  remedy: remedyFixture({}),
};

const REMEDY_STAFF_REVIEW_RMA: RmaViewFixture = {
  ...REMEDY_IN_PROGRESS_RMA,
  remedy: remedyFixture({ status: "staff_review_required", staffReviewReason: "restocking-fee case" }),
};

const REMEDY_ISSUED_RMA: RmaViewFixture = {
  ...REMEDY_IN_PROGRESS_RMA,
  remedy: remedyFixture({
    status: "issued",
    processorReference: "shopify-refund-1",
    actualRefundOrCreditMinorUnits: "26875",
    shopifyTaxAdjustmentMinorUnits: "1875",
    issuedAt: "2026-01-10T00:00:00.000Z",
  }),
};

function renderPage(rma: RmaViewFixture | null): string {
  const loaderData = { apiKey: "test-public-client-id", shop: "caratforus-dev.myshopify.com", rma };
  const router = createMemoryRouter(
    [{ id: ROUTE_ID, path: "/app/rma/:id", Component: RmaDetailPage, loader: () => loaderData }],
    {
      initialEntries: [`/app/rma/${rma?.id ?? "unknown"}`],
      hydrationData: { loaderData: { [ROUTE_ID]: loaderData } },
    }
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("RMA not found", () => {
  it("shows a clear not-found message rather than crashing", () => {
    expect(textOf(renderPage(null))).toMatch(/not found/i);
  });
});

describe("a freshly submitted RMA", () => {
  it("shows the RMA reference, purchaser, and reason", () => {
    const text = textOf(renderPage(SUBMITTED_RMA));
    expect(text).toMatch(/RMA-ABC12345/);
    expect(text).toMatch(/ada@example\.com/);
    expect(text).toMatch(/Changed my mind/);
  });

  it("offers Approve and Deny, and nothing remedy-related", () => {
    const html = renderPage(SUBMITTED_RMA);
    expect(html).toMatch(/>Approve</);
    expect(html).toMatch(/>Deny</);
    expect(html).not.toMatch(/Execute remedy/);
    expect(html).not.toMatch(/Compute remedy/);
  });
});

describe("inspection_passed with no remedy yet", () => {
  it("offers 'Compute remedy & begin' and nothing execution-related", () => {
    const html = renderPage(INSPECTION_PASSED_RMA);
    expect(html).toMatch(/Compute remedy/);
    expect(html).not.toMatch(/Execute remedy/);
    expect(html).not.toMatch(/Update remedy status/);
  });
});

describe("remedy_in_progress with a pending remedy", () => {
  it("offers BOTH the automated execute_remedy control and the manual update_remedy_status control", () => {
    const html = renderPage(REMEDY_IN_PROGRESS_RMA);
    expect(html).toMatch(/Execute remedy via Shopify/);
    expect(html).toMatch(/Update remedy status/);
  });

  it("does not offer Compute remedy again once a remedy already exists", () => {
    const html = renderPage(REMEDY_IN_PROGRESS_RMA);
    expect(html).not.toMatch(/Compute remedy/);
  });
});

describe("remedy staff_review_required (D7's fail-closed state)", () => {
  it("still offers execute_remedy (retry) and the manual path, and shows the reason", () => {
    const html = renderPage(REMEDY_STAFF_REVIEW_RMA);
    expect(textOf(html)).toMatch(/restocking-fee case/);
    expect(html).toMatch(/Execute remedy via Shopify/);
    expect(html).toMatch(/Update remedy status/);
  });
});

describe("remedy issued — terminal", () => {
  it("offers NEITHER execute_remedy NOR the manual update control once issued (criterion 196/204's UI-level mirror)", () => {
    const html = renderPage(REMEDY_ISSUED_RMA);
    expect(html).not.toMatch(/Execute remedy via Shopify/);
    expect(html).not.toMatch(/Update remedy status/);
  });

  it("shows the settled processor reference and both money figures separately (D7)", () => {
    const text = textOf(renderPage(REMEDY_ISSUED_RMA));
    expect(text).toMatch(/shopify-refund-1/);
    expect(text).toMatch(/268\.75/); // actual refund/credit
    expect(text).toMatch(/18\.75/); // Shopify's own tax figure, shown separately
  });

  it("offers Mark resolved", () => {
    const html = renderPage(REMEDY_ISSUED_RMA);
    expect(html).toMatch(/>Mark resolved</);
  });
});
