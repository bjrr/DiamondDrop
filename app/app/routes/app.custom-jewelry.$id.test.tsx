import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import CustomJewelryProjectPage, { type ProjectView } from "./app.custom-jewelry.$id";
import {
  CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT,
  CUSTOM_JEWELRY_DEPOSIT_AFFIRMATIVE_ACTION_LABEL,
} from "~/domain/customjewelry/designDepositAcknowledgmentText";

/**
 * Same technique as `app.bank-payments.$id.test.tsx`: nothing is mocked, and
 * only the loader's RESULT is supplied — running the real loader would call
 * `authenticate.admin` and query a live session. The action's decision logic
 * (no acceptance, already invoiced, amount drift) is exercised for real in
 * `tests/integration/customjewelry/customJewelryDepositInvoice.test.ts`.
 *
 * WHAT THESE COVER THAT NOTHING ELSE DOES: the UI gating around a control that
 * asks a customer for money. The server refuses an unauthorized issue
 * regardless — the schema makes an invoice without an acceptance
 * unrepresentable — but a button offered when it should not be is its own
 * defect: a member of staff clicking it reasonably expects it to work, and
 * "the server said no" is a worse experience than the control not being there.
 */

const ROUTE_ID = "custom-jewelry-detail";

const BASE: ProjectView = {
  id: "11111111-1111-1111-1111-111111111111",
  projectReference: "CJ-7Q2MPX4N",
  status: "submitted",
  customerName: "Ada Lovelace",
  email: "ada@example.com",
  phone: "+1 555 0100",
  customerRef: "gid://shopify/Customer/123",
  startingPoint: "from_scratch",
  promptText: "A signet ring reworked from my grandmother's.",
  jewelryType: "Ring",
  inspirationLinks: null,
  budgetDisplay: "3500.00 USD",
  timingDisplay: "No deadline",
  followUpPreference: "contact_me",
  createdAt: "2026-10-05T10:00:00.000Z",
  uploads: [],
  acceptance: null,
};

const ACCEPTED: ProjectView = {
  ...BASE,
  acceptance: {
    acceptedAt: "2026-10-06T10:00:00.000Z",
    exactText: CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT,
    affirmativeActionLabel: CUSTOM_JEWELRY_DEPOSIT_AFFIRMATIVE_ACTION_LABEL,
    policySlug: "custom-jewelry-design-deposit",
    policyVersion: 1,
    amountDisplay: "49.00 USD",
    invoice: null,
  },
};

const INVOICED: ProjectView = {
  ...ACCEPTED,
  acceptance: {
    ...ACCEPTED.acceptance!,
    invoice: {
      draftOrderGid: "gid://shopify/DraftOrder/999",
      issuedAt: "2026-10-07T10:00:00.000Z",
      issuedByActorRef: "staff:42",
    },
  },
};

/**
 * Static markup with HTML entities decoded.
 *
 * The approved affirmative-action label contains an ampersand, which renders
 * as `&amp;` — asserting on the raw markup would fail for a page that is
 * perfectly correct. Decoding is narrower than loosening the assertion to some
 * substring that happens to avoid the `&`.
 */
function decodeEntities(html: string): string {
  return html
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'");
}

function render(
  project: ProjectView | null,
  final: { approvalPackages?: unknown[]; purchase?: unknown } = {}
): string {
  const approvalPackages = final.approvalPackages ?? [];
  const purchase = final.purchase ?? null;
  const router = createMemoryRouter(
    [
      {
        id: ROUTE_ID,
        path: "/app/custom-jewelry/:id",
        Component: CustomJewelryProjectPage,
        loader: () => ({ apiKey: "test-key", shop: "caratforus-dev.myshopify.com", project, approvalPackages, purchase }),
      },
    ],
    { initialEntries: ["/app/custom-jewelry/11111111-1111-1111-1111-111111111111"], hydrationData: {
      loaderData: {
        [ROUTE_ID]: {
          apiKey: "test-key",
          shop: "caratforus-dev.myshopify.com",
          project,
          // THE LOADER ALWAYS RETURNS THESE, so the fixture supplies them
          // rather than the component defaulting. A `?? []` in the component
          // would hide a genuinely missing field, which is the opposite of
          // what this file exists to catch — it supplies loader RESULTS
          // precisely so the render is tested against what the loader really
          // produces.
          //
          // The final-approval surface has its own dedicated cases below; this
          // empty pair is the "no package issued yet" state every existing
          // test here is written against.
          approvalPackages,
          purchase,
        },
      },
    } }
  );
  return decodeEntities(renderToStaticMarkup(<RouterProvider router={router} />));
}

describe("the issue-invoice control appears only when it would work", () => {
  it("is ABSENT when the customer has not accepted the deposit terms", () => {
    const html = render(BASE);
    expect(html).not.toContain("issue_deposit_invoice");
    expect(html).toContain("has not accepted the Design Deposit terms yet");
  });

  it("is PRESENT once they have accepted and no invoice has gone out", () => {
    const html = render(ACCEPTED);
    expect(html).toContain("issue_deposit_invoice");
    expect(html).toContain("Issue deposit invoice");
  });

  it("is ABSENT once an invoice already exists — a second would let them pay twice", () => {
    const html = render(INVOICED);
    expect(html).not.toContain("issue_deposit_invoice");
    expect(html).toContain("gid://shopify/DraftOrder/999");
  });
});

describe("the page shows what the customer actually agreed to", () => {
  it("renders the EXACT acknowledgment text, not a summary of it", () => {
    // A member of staff about to ask someone for money should see precisely
    // what that person agreed to, rather than a green tick. Asserted against
    // the pinned constant so a reworded acknowledgment cannot pass by matching
    // whatever the page happens to render.
    const html = render(ACCEPTED);
    expect(html).toContain(CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT);
    expect(html).toContain(CUSTOM_JEWELRY_DEPOSIT_AFFIRMATIVE_ACTION_LABEL);
    expect(html).toContain("49.00 USD");
    expect(html).toContain("custom-jewelry-design-deposit");
  });

  it("says plainly that issuing does NOT email the customer", () => {
    // The invoice email's wording is not approved, so staff send it from the
    // Shopify admin. A page that implied the customer had been contacted would
    // mean nobody ever sends it.
    const html = render(ACCEPTED);
    expect(html).toMatch(/does.*not.*email the customer/is);
  });
});

describe("what the page must never show", () => {
  it("renders no storage key or file URL for an inspiration upload", () => {
    // Staff needing a file is a separate authorized retrieval, not a link
    // rendered into every page view.
    const html = render({
      ...ACCEPTED,
      uploads: [{ id: "u1", kind: "photo", contentType: "image/jpeg", uploadedAt: "2026-10-05T11:00:00.000Z" }],
    });
    expect(html).toContain("photo");
    // SCOPED TO THE SHAPE OF A REAL STORAGE KEY. Two earlier attempts were
    // wrong in opposite directions: `not.toContain("https://")` failed on
    // AppProvider's injected Shopify CDN script, and
    // `custom-jewelry/[0-9a-f-]{8}` matched this page's OWN route URL
    // (`/app/custom-jewelry/11111111-…`). What distinguishes a key is the
    // `/photo/` or `/video/` segment after the owner id, which no route path
    // has.
    expect(html).not.toMatch(/custom-jewelry\/[0-9a-f-]{36}\/(photo|video)\//);
    expect(html).not.toMatch(/\.r2\.cloudflarestorage\.com/);
    expect(html).not.toMatch(/X-Amz-Signature/i);
  });

  it("renders inspiration links as plain text, never as anchors", () => {
    // Nothing server-side fetches these (a server that retrieves a
    // customer-supplied URL is an SSRF primitive), and nothing here makes one
    // a single click from an admin session.
    const html = render({ ...ACCEPTED, inspirationLinks: "http://example.test/a\nhttp://example.test/b" });
    expect(html).toContain("example.test/a");
    expect(html).not.toContain('<a href="http://example.test/a"');
  });

  it("carries no cost, margin or landed-cost language", () => {
    const html = render(INVOICED);
    // "margin" alone matched this page's own `margin-top` CSS — a false
    // positive. The terms that would actually indicate a leak are specific.
    expect(html).not.toMatch(/\b(gross margin|profit margin|landed cost|supplier cost|markup)\b/i);
  });
});

describe("an anonymous enquiry reads as normal, not broken", () => {
  it("says the customer was not signed in rather than showing a blank", () => {
    // Intake is deliberately open to signed-out visitors, so a null
    // customerRef is the expected case for many projects.
    const html = render({ ...BASE, customerRef: null });
    expect(html).toContain("Not signed in when they submitted");
  });
});

describe("a missing project", () => {
  it("renders a plain message rather than throwing", () => {
    expect(render(null)).toContain("Project not found");
  });
});

// ---------------------------------------------------------------------------
// The final approval and purchase surface.
// ---------------------------------------------------------------------------

const ISSUED_PACKAGE = {
  id: "aaaaaaaa-1111-1111-1111-111111111111",
  version: 1,
  status: "issued",
  issuedAt: "2026-11-01T12:00:00.000Z",
  issuedByActorRef: "staff:42",
  approvedAt: null,
  approvedByCustomerRef: null,
  supersededByVersion: null,
  supersededReason: null,
  bankPaymentPrice: "5000.00 USD",
  regularCardPrice: "5175.00 USD",
  depositCredit: "49.00 USD",
  bankPaymentBalanceDue: "4951.00 USD",
  regularCardBalanceDue: "5126.00 USD",
  acknowledgmentPolicyVersion: 1,
  finalSaleCopyVersion: 1,
  summary: "white platinum, size 6.5",
};

const APPROVED_PACKAGE = {
  ...ISSUED_PACKAGE,
  status: "approved",
  approvedAt: "2026-11-02T09:00:00.000Z",
  approvedByCustomerRef: "gid://shopify/Customer/123",
};

const SUPERSEDED_PACKAGE = {
  ...ISSUED_PACKAGE,
  id: "aaaaaaaa-0000-0000-0000-000000000000",
  status: "superseded",
  supersededByVersion: 2,
  supersededReason: "customer changed the metal",
  summary: "yellow gold, size 7",
};

describe("the issue-package form appears only when it would work", () => {
  it("is PRESENT when no package has been approved", () => {
    const html = render(ACCEPTED, { approvalPackages: [ISSUED_PACKAGE] });
    expect(html).toContain("issue_approval_package");
    expect(html).toContain("Issue approval package");
  });

  it("is ABSENT once the customer has approved a version", () => {
    // Staff must not silently replace what a customer approved — the trigger
    // refuses it, and offering a form that cannot work is its own defect.
    const html = render(ACCEPTED, { approvalPackages: [APPROVED_PACKAGE] });
    expect(html).not.toContain("issue_approval_package");
    expect(html).toContain("commercial conversation, not a re-issue");
  });

  it("asks for the BANK price and says the card price is derived", () => {
    // A typed card price would be a second pricing engine with a human in it.
    const html = render(ACCEPTED, { approvalPackages: [] });
    expect(html).toContain("bankPaymentPrice");
    expect(html).toContain("Bank Payment Price");
    expect(html).toMatch(/Regular\/Card Price is derived/i);
    // And there is NO field for it.
    expect(html).not.toContain('name="regularCardPrice"');
  });

  it("offers NO field for the deposit credit", () => {
    // It is read from the recorded payment, so the credit always points at a
    // transaction that actually happened.
    const html = render(ACCEPTED, { approvalPackages: [] });
    expect(html).not.toContain('name="depositCredit"');
    expect(html).toMatch(/read from the recorded payment/i);
  });

  it("gives the timeline field NO default", () => {
    // The owner forbade unsupported turnaround promises; a templated sentence
    // is exactly how one would appear.
    const html = render(ACCEPTED, { approvalPackages: [] });
    expect(html).toContain("approvedTimelineText");
    expect(html).toMatch(/only what has actually been agreed/i);
    // EMPTY BETWEEN THE TAGS, asserted positively. The obvious negative
    // version — `>\S` after the opening tag — matches the `<` of
    // `</textarea>`, so it is true of every empty textarea ever rendered and
    // proves nothing. That is how the first version of this assertion
    // "passed".
    expect(html).toMatch(/name="approvedTimelineText"[^>]*><\/textarea>/);
  });

  it("asks WHY a revision replaces the current version, but only when one exists", () => {
    expect(render(ACCEPTED, { approvalPackages: [ISSUED_PACKAGE] })).toContain("supersedesReason");
    expect(render(ACCEPTED, { approvalPackages: [] })).not.toContain("supersedesReason");
  });
});

describe("the approval history", () => {
  it("shows SUPERSEDED versions, not only the current one", () => {
    // A superseded version is the evidence of what was offered before the
    // design changed, and a claim about the approved design is decided against
    // it.
    const html = render(ACCEPTED, { approvalPackages: [ISSUED_PACKAGE, SUPERSEDED_PACKAGE] });
    expect(html).toContain("white platinum, size 6.5");
    expect(html).toContain("yellow gold, size 7");
    expect(html).toContain("superseded");
    expect(html).toContain("customer changed the metal");
  });

  it("shows BOTH price bases and both balances", () => {
    const html = render(ACCEPTED, { approvalPackages: [ISSUED_PACKAGE] });
    expect(html).toContain("5000.00 USD");
    expect(html).toContain("5175.00 USD");
    expect(html).toContain("4951.00 USD");
    expect(html).toContain("5126.00 USD");
  });

  it("shows whether the customer approved, and the copy versions they saw", () => {
    const html = render(ACCEPTED, { approvalPackages: [APPROVED_PACKAGE] });
    expect(html).toContain("2026-11-02 09:00");
    expect(html).toMatch(/ack v1/);
    expect(html).toMatch(/final-sale v1/);
  });

  it("says plainly when nothing has been issued", () => {
    const html = render(ACCEPTED, { approvalPackages: [] });
    expect(html).toContain("No approval package has been issued");
  });
});

describe("the purchase panel", () => {
  const PURCHASE = {
    id: "bbbbbbbb-1111-1111-1111-111111111111",
    paymentBasis: "bank_payment",
    status: "awaiting_payment",
    grossApprovedPrice: "5000.00 USD",
    depositCredit: "49.00 USD",
    depositPaymentReference: "gid://shopify/Order/dep-1",
    benefitDiscount: "100.00 USD",
    balanceDue: "4851.00 USD",
    bankPaymentOrderId: "cccccccc-1111-1111-1111-111111111111",
    shopifyDraftOrderGid: null,
    shopifyOrderGid: null,
    paidAt: null,
    bankOrderStatus: "open",
    bankOrderVerifiedAt: null,
  };

  it("shows the GROSS price, the credits separately, and the balance", () => {
    // The deposit is a credit against the price, not a discount to it — so the
    // price is what the piece sold for and the balance is merely what was
    // collected. Showing only the balance would lose that.
    const html = render(ACCEPTED, { approvalPackages: [APPROVED_PACKAGE], purchase: PURCHASE });
    expect(html).toContain("Approved price (gross)");
    expect(html).toContain("5000.00 USD");
    expect(html).toContain("Design Deposit credit");
    expect(html).toContain("gid://shopify/Order/dep-1");
    expect(html).toContain("Let Us Beat Your Quote benefit");
    expect(html).toContain("100.00 USD");
    expect(html).toContain("4851.00 USD");
  });

  it("FLAGS funds verified while the purchase still awaits payment", () => {
    // The urgent anomaly: the customer has paid and nothing downstream knows.
    const html = render(ACCEPTED, {
      approvalPackages: [APPROVED_PACKAGE],
      purchase: { ...PURCHASE, bankOrderVerifiedAt: "2026-11-05T10:00:00.000Z" },
    });
    expect(html).toMatch(/customer has paid and nothing downstream knows/i);
  });

  it("FLAGS a cancelled bank order", () => {
    const html = render(ACCEPTED, {
      approvalPackages: [APPROVED_PACKAGE],
      purchase: { ...PURCHASE, bankOrderStatus: "cancelled" },
    });
    expect(html).toMatch(/balance will not arrive/i);
  });

  it("does NOT flag a healthy awaiting-payment purchase", () => {
    const html = render(ACCEPTED, { approvalPackages: [APPROVED_PACKAGE], purchase: PURCHASE });
    expect(html).not.toMatch(/nothing downstream knows/i);
    expect(html).not.toMatch(/will not arrive/i);
  });

  it("is absent when no purchase exists", () => {
    const html = render(ACCEPTED, { approvalPackages: [APPROVED_PACKAGE] });
    expect(html).not.toContain("Approved price (gross)");
  });
});
