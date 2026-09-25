import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import WarrantyClaimDetailPage from "./app.warranty-claims.$id";

/**
 * Same technique as `app.bank-payments.$id.test.tsx`: nothing is mocked.
 * Only the loader's (and, where relevant, the action's) RESULT is supplied —
 * running the real loader/action would call `authenticate.admin` and the
 * database. The repository/domain decision logic this page calls into is
 * exercised for real in `tests/integration/warranty/warrantyClaimRepository.test.ts`
 * (task 5-2). This file's job is the UI-gating logic that is genuinely new
 * here — criteria 157/159/160/162/165 — which lives in this route, not the
 * repository.
 */

const ROUTE_ID = "warranty-claim-detail";

interface ClaimViewFixture {
  id: string;
  claimReference: string;
  orderRef: string;
  lineRef: string;
  customerRef: string | null;
  itemConfigurationDescription: string;
  purchaserName: string;
  purchaserEmail: string;
  purchaseDate: string | null;
  deliveryDate: string | null;
  issueFirstNoticedDate: string | null;
  problemDescription: string;
  hadImpactOrDamageEvent: boolean;
  impactOrDamageDetails: string | null;
  wasAlteredAfterDelivery: boolean;
  alterationDetails: string | null;
  certificateOrSerialIdentifier: string | null;
  submittedAt: string;
  status: string;
  pausedFromStatus: string | null;
  authorizedAt: string | null;
  authorizedByActorRef: string | null;
  inboundTrackingCarrier: string | null;
  inboundTrackingNumber: string | null;
  inboundInsuranceReference: string | null;
  inboundInsuredValueMinorUnits: string | null;
  inboundInsuredValueCurrency: string | null;
  receivedAt: string | null;
  packageCondition: string | null;
  itemCondition: string | null;
  inspectionNotes: string | null;
  inspectedByActorRef: string | null;
  coverageDecision: string | null;
  coverageDecisionReason: string | null;
  coverageDecidedAt: string | null;
  coverageDecidedByActorRef: string | null;
  resolvedAt: string | null;
  closedAt: string | null;
  events: unknown[];
  uploads: unknown[];
  remedy: {
    id: string;
    kind: string;
    status: string;
    refundAmountMinorUnits: string | null;
    currency: string | null;
    processorReference: string | null;
    failureReason: string | null;
    decidedByActorRef: string;
    decidedAt: string;
    completedAt: string | null;
    localJewellerAuthorization: unknown | null;
  } | null;
}

const SUBMITTED_CLAIM: ClaimViewFixture = {
  id: "11111111-1111-1111-1111-111111111111",
  claimReference: "WC-ABC12345",
  orderRef: "gid://shopify/Order/1",
  lineRef: "gid://shopify/LineItem/1",
  customerRef: "gid://shopify/Customer/1",
  itemConfigurationDescription: "14k gold solitaire ring, size 7",
  purchaserName: "Ada Lovelace",
  purchaserEmail: "ada@example.com",
  purchaseDate: null,
  deliveryDate: null,
  issueFirstNoticedDate: null,
  problemDescription: "Prong appears to have a defective solder joint.",
  hadImpactOrDamageEvent: false,
  impactOrDamageDetails: null,
  wasAlteredAfterDelivery: false,
  alterationDetails: null,
  certificateOrSerialIdentifier: null,
  submittedAt: "2026-09-20T10:00:00.000Z",
  status: "submitted",
  pausedFromStatus: null,
  authorizedAt: null,
  authorizedByActorRef: null,
  inboundTrackingCarrier: null,
  inboundTrackingNumber: null,
  inboundInsuranceReference: null,
  inboundInsuredValueMinorUnits: null,
  inboundInsuredValueCurrency: null,
  receivedAt: null,
  packageCondition: null,
  itemCondition: null,
  inspectionNotes: null,
  inspectedByActorRef: null,
  coverageDecision: null,
  coverageDecisionReason: null,
  coverageDecidedAt: null,
  coverageDecidedByActorRef: null,
  resolvedAt: null,
  closedAt: null,
  events: [],
  uploads: [],
  remedy: null,
};

const RECEIVED_CLAIM: ClaimViewFixture = {
  ...SUBMITTED_CLAIM,
  status: "received_inspection_pending",
  authorizedAt: "2026-09-21T10:00:00.000Z",
  authorizedByActorRef: "staff:1",
  receivedAt: "2026-09-23T10:00:00.000Z",
  inspectedByActorRef: "staff:2",
};

const UNDER_REVIEW_CLAIM: ClaimViewFixture = { ...SUBMITTED_CLAIM, status: "under_review" };

const APPROVED_CLAIM: ClaimViewFixture = {
  ...RECEIVED_CLAIM,
  status: "approved_covered",
  coverageDecision: "covered",
  coverageDecidedAt: "2026-09-24T10:00:00.000Z",
  coverageDecidedByActorRef: "staff:2",
};

const DENIED_CLAIM: ClaimViewFixture = {
  ...RECEIVED_CLAIM,
  status: "denied_not_covered",
  coverageDecision: "not_covered",
  coverageDecisionReason: "wear consistent with normal use, not a manufacturing defect",
  coverageDecidedAt: "2026-09-24T10:00:00.000Z",
  coverageDecidedByActorRef: "staff:2",
};

const REMEDY_IN_PROGRESS_CLAIM: ClaimViewFixture = {
  ...APPROVED_CLAIM,
  status: "remedy_in_progress",
  remedy: {
    id: "remedy-1",
    kind: "repair",
    status: "pending",
    refundAmountMinorUnits: null,
    currency: null,
    processorReference: null,
    failureReason: null,
    decidedByActorRef: "staff:2",
    decidedAt: "2026-09-25T10:00:00.000Z",
    completedAt: null,
    localJewellerAuthorization: null,
  },
};

const REFUND_REMEDY_CLAIM: ClaimViewFixture = {
  ...APPROVED_CLAIM,
  status: "remedy_in_progress",
  remedy: {
    id: "remedy-2",
    kind: "refund",
    status: "pending",
    refundAmountMinorUnits: "150000",
    currency: "USD",
    processorReference: null,
    failureReason: null,
    decidedByActorRef: "staff:2",
    decidedAt: "2026-09-25T10:00:00.000Z",
    completedAt: null,
    localJewellerAuthorization: null,
  },
};

function renderPage(claim: ClaimViewFixture | null, actionData?: unknown): string {
  const loaderData = { apiKey: "test-public-client-id", shop: "caratforus-dev.myshopify.com", claim };
  const router = createMemoryRouter(
    [
      {
        id: ROUTE_ID,
        path: "/app/warranty-claims/:id",
        Component: WarrantyClaimDetailPage,
        loader: () => loaderData,
      },
    ],
    {
      initialEntries: [`/app/warranty-claims/${claim?.id ?? "unknown"}`],
      hydrationData: {
        loaderData: { [ROUTE_ID]: loaderData },
        ...(actionData ? { actionData: { [ROUTE_ID]: actionData } } : {}),
      },
    }
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("claim not found", () => {
  it("shows a clear not-found message rather than crashing", () => {
    expect(textOf(renderPage(null))).toMatch(/not found/i);
  });
});

describe("a freshly submitted claim", () => {
  it("shows the claim reference, purchaser, and problem description", () => {
    const text = textOf(renderPage(SUBMITTED_CLAIM));
    expect(text).toMatch(/WC-ABC12345/);
    expect(text).toMatch(/Ada Lovelace/);
    expect(text).toMatch(/ada@example\.com/);
    expect(text).toMatch(/defective solder joint/);
  });

  it("offers Start review, and nothing further downstream", () => {
    const html = renderPage(SUBMITTED_CLAIM);
    expect(html).toMatch(/Start review/);
    expect(html).not.toMatch(/Authorize for inspection/);
    expect(html).not.toMatch(/Record coverage decision/);
  });

  it("never renders cost, margin or landed-cost figures", () => {
    const text = textOf(renderPage(SUBMITTED_CLAIM)).toLowerCase();
    expect(text).not.toMatch(/landed ?cost|gross margin|margin rate|uplift|wholesale/);
  });
});

describe("criterion 156/157 — authorize-for-inspection", () => {
  it("under_review offers Authorize for inspection with no identity field (D23)", () => {
    const html = renderPage(UNDER_REVIEW_CLAIM);
    expect(html).toMatch(/Authorize for inspection/);
    expect(html).not.toMatch(/name="staffActorRef"|name="authorizedBy"|id="authorizedBy"/);
    expect(html).toMatch(/does not establish coverage/i);
  });
});

describe("criterion 159 — no coverage-decision control before receipt", () => {
  const preReceiptClaims: [string, ClaimViewFixture][] = [
    ["submitted", SUBMITTED_CLAIM],
    ["under_review", UNDER_REVIEW_CLAIM],
    ["authorized_for_inspection", { ...SUBMITTED_CLAIM, status: "authorized_for_inspection", authorizedAt: "2026-09-21T10:00:00.000Z" }],
    ["in_transit_to_carat_for_us", { ...SUBMITTED_CLAIM, status: "in_transit_to_carat_for_us", authorizedAt: "2026-09-21T10:00:00.000Z" }],
    ["more_information_requested", { ...SUBMITTED_CLAIM, status: "more_information_requested", pausedFromStatus: "under_review" }],
  ];

  it.each(preReceiptClaims)("%s: the coverage-decision form is entirely absent, not merely disabled", (_label, claim) => {
    const html = renderPage(claim);
    expect(html).not.toMatch(/name="intent"[^>]*value="decide_coverage"|value="decide_coverage"/);
    expect(html).not.toMatch(/Record coverage decision/);
  });

  it("received_inspection_pending DOES offer the coverage-decision form", () => {
    const html = renderPage(RECEIVED_CLAIM);
    expect(html).toMatch(/value="decide_coverage"/);
    expect(html).toMatch(/Record coverage decision/);
  });

  it("the coverage-decision radios have no default selection", () => {
    const html = renderPage(RECEIVED_CLAIM);
    const fieldsetMatch = html.match(/Coverage decision[\s\S]*?<\/fieldset>/);
    expect(fieldsetMatch).not.toBeNull();
    expect(fieldsetMatch![0]).not.toMatch(/checked/);
  });
});

describe("criterion 160 — a denial requires a reason", () => {
  it("the coverage-decision form includes a reason field, not merely a checkbox", () => {
    const html = renderPage(RECEIVED_CLAIM);
    expect(html).toMatch(/id="coverageReason"/);
    expect(html).toMatch(/required if denying/i);
  });

  it("displays a recorded denial reason once decided", () => {
    const text = textOf(renderPage(DENIED_CLAIM));
    expect(text).toMatch(/wear consistent with normal use/);
    expect(text).toMatch(/not_covered/);
  });
});

describe("criterion 162 — remedy selection is never pre-selected or recommended", () => {
  it("approved_covered with no remedy yet offers the remedy form with all four kinds, none checked", () => {
    const html = renderPage(APPROVED_CLAIM);
    expect(html).toMatch(/value="record_remedy"/);
    for (const kind of ["repair", "replacement", "refund", "other"]) {
      expect(html).toMatch(new RegExp(`value="${kind}"`));
    }
    const fieldsetMatch = html.match(/Remedy — CaratForUs determines[\s\S]*?<\/fieldset>/);
    expect(fieldsetMatch).not.toBeNull();
    expect(fieldsetMatch![0]).not.toMatch(/checked/);
  });

  it("does not offer the remedy form once a remedy already exists", () => {
    const html = renderPage(REMEDY_IN_PROGRESS_CLAIM);
    expect(html).not.toMatch(/value="record_remedy"/);
  });

  it("a repair remedy shows no refund amount; a refund remedy shows its amount", () => {
    const repairText = textOf(renderPage(REMEDY_IN_PROGRESS_CLAIM));
    expect(repairText).not.toMatch(/Refund amount/);

    const refundText = textOf(renderPage(REFUND_REMEDY_CLAIM));
    expect(refundText).toMatch(/Refund amount/);
    expect(refundText).toMatch(/USD 1,500\.00/);
  });
});

describe("criterion 165 — the local-jeweller section is internal-only and clearly labelled", () => {
  it("is shown, and labelled INTERNAL ONLY, for a repair remedy in progress", () => {
    const html = renderPage(REMEDY_IN_PROGRESS_CLAIM);
    expect(html).toMatch(/INTERNAL ONLY/);
    expect(html).toMatch(/never disclose this section/i);
  });

  it("is absent entirely for a refund remedy — no reason for a jeweller record there", () => {
    const html = renderPage(REFUND_REMEDY_CLAIM);
    expect(html).not.toMatch(/INTERNAL ONLY/);
    expect(html).not.toMatch(/local jeweller/i);
  });

  it("is absent entirely before any remedy exists", () => {
    const html = renderPage(APPROVED_CLAIM);
    expect(html).not.toMatch(/INTERNAL ONLY/);
    expect(html).not.toMatch(/local jeweller/i);
  });
});

describe("action error display", () => {
  it("shows a whole-page error banner when the action refuses", () => {
    const text = textOf(renderPage(SUBMITTED_CLAIM, { ok: false, formError: "A reason is required to deny a claim as not covered." }));
    expect(text).toMatch(/A reason is required to deny a claim as not covered/);
  });
});

describe("a denied claim with no remedy needed", () => {
  it("offers Mark resolved directly, with no remedy step", () => {
    const html = renderPage(DENIED_CLAIM);
    expect(html).toMatch(/Mark resolved/);
    expect(html).not.toMatch(/value="record_remedy"/);
  });
});

describe("a resolved claim", () => {
  it("offers Close claim", () => {
    const html = renderPage({ ...REMEDY_IN_PROGRESS_CLAIM, status: "resolved", resolvedAt: "2026-09-26T10:00:00.000Z" });
    expect(html).toMatch(/Close claim/);
  });
});

describe("a closed claim", () => {
  it("offers no further action", () => {
    const text = textOf(
      renderPage({ ...REMEDY_IN_PROGRESS_CLAIM, status: "closed", resolvedAt: "2026-09-26T10:00:00.000Z", closedAt: "2026-09-27T10:00:00.000Z" })
    );
    expect(text).toMatch(/No further staff action is available/i);
  });
});
