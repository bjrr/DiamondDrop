import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import BankPaymentVerificationPage, { type OrderViewModel } from "./app.bank-payments.$id";

/**
 * Same technique as `alerts.test.tsx` / `_index.test.tsx`: nothing is
 * mocked. Only the loader's (and, where relevant, the action's) RESULT is
 * supplied — running the real loader/action would call `authenticate.admin`
 * and the Shopify Admin API against a live session/store. The
 * database/Shopify-facing decision logic this page renders is exercised for
 * real in `tests/integration/bankpayment/verification.test.ts`.
 */

const ROUTE_ID = "bank-payment-detail";

const OPEN_ORDER: OrderViewModel = {
  id: "11111111-1111-1111-1111-111111111111",
  status: "open" as const,
  verificationState: "unverified",
  customerEmail: "ada@example.com",
  shopifyDraftOrderGid: "gid://shopify/DraftOrder/1",
  shopifyOrderGid: null,
  quotedAt: "2026-09-20T10:00:00.000Z",
  guaranteeExpiresAt: "2026-09-21T10:00:00.000Z",
  verifiedAt: null,
  verifiedByEmail: null,
  verifiedByShopifyUserId: null,
  verifiedPaymentAmountMinorUnits: null,
  verifiedPaymentCurrency: null,
  verifiedPaymentMethod: null,
  verifiedPaymentReference: null,
  cancellationReason: null,
  currency: "USD",
  expectedTotalMinorUnits: "150000",
  lines: [
    {
      id: "line-1",
      productTitle: "Solitaire Engagement Ring",
      variantLabel: "gold GOLD_14K",
      quantity: 1,
      eligibleAtQuoteTime: true,
      chargedUnitPriceMinorUnits: "150000",
      currency: "USD",
      availability: "available" as const,
    },
  ],
  comparison: null,
};

const VERIFIED_AND_COMPLETED_ORDER: OrderViewModel = {
  ...OPEN_ORDER,
  id: "22222222-2222-2222-2222-222222222222",
  status: "completed" as const,
  verificationState: "completed",
  shopifyOrderGid: "gid://shopify/Order/1",
  verifiedAt: "2026-09-20T11:00:00.000Z",
  verifiedByEmail: "jordan@example.com",
  verifiedByShopifyUserId: "42",
  verifiedPaymentAmountMinorUnits: "150500",
  verifiedPaymentCurrency: "USD",
  verifiedPaymentMethod: "zelle",
  verifiedPaymentReference: "REF-99",
  comparison: {
    receivedMinorUnits: "150500",
    currencyMismatch: false,
    differenceMinorUnits: "500",
    matchesExactly: false,
  },
};

/** D25 — verified, but completion has not (yet) succeeded. The recovery state; the form must never reappear here. */
const VERIFIED_PENDING_COMPLETION_ORDER: OrderViewModel = {
  ...OPEN_ORDER,
  id: "44444444-4444-4444-4444-444444444444",
  status: "open" as const,
  verificationState: "verified_pending_completion",
  shopifyOrderGid: null,
  verifiedAt: "2026-09-20T11:00:00.000Z",
  verifiedByEmail: "jordan@example.com",
  verifiedByShopifyUserId: "42",
  verifiedPaymentAmountMinorUnits: "150000",
  verifiedPaymentCurrency: "USD",
  verifiedPaymentMethod: "zelle",
  verifiedPaymentReference: "REF-99",
  comparison: { receivedMinorUnits: "150000", currencyMismatch: false, differenceMinorUnits: "0", matchesExactly: true },
};

const CANCELLED_ORDER: OrderViewModel = {
  ...OPEN_ORDER,
  id: "33333333-3333-3333-3333-333333333333",
  status: "cancelled" as const,
  verificationState: "cancelled",
  cancellationReason: "Published price changed through a human-approved publication.",
};

const LOADER_DATA = {
  apiKey: "test-public-client-id",
  shop: "caratforus-dev.myshopify.com",
  order: OPEN_ORDER as OrderViewModel | null,
  availabilityCheckError: null as string | null,
};

function renderPage(data: Partial<typeof LOADER_DATA> = {}, actionData?: unknown): string {
  const loaderData = { ...LOADER_DATA, ...data };
  const router = createMemoryRouter(
    [
      {
        id: ROUTE_ID,
        path: "/app/bank-payments/:id",
        Component: BankPaymentVerificationPage,
        loader: () => loaderData,
      },
    ],
    {
      initialEntries: [`/app/bank-payments/${loaderData.order?.id ?? "unknown"}`],
      hydrationData: {
        loaderData: { [ROUTE_ID]: loaderData },
        ...(actionData ? { actionData: { [ROUTE_ID]: actionData } } : {}),
      },
    }
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

const textOf = (html: string) => html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();

describe("the Bank Payment verification page — order not found", () => {
  it("shows a clear not-found message rather than crashing", () => {
    const text = textOf(renderPage({ order: null }));
    expect(text).toMatch(/not found/i);
  });
});

describe("an open, unverified order", () => {
  it("shows customer email, status, expected total and every line", () => {
    const text = textOf(renderPage());
    expect(text).toMatch(/ada@example\.com/);
    expect(text).toMatch(/USD 1,500\.00/);
    expect(text).toMatch(/Solitaire Engagement Ring/);
    expect(text).toMatch(/gold GOLD_14K/);
  });

  it("shows line availability as explicit text, not colour alone (criterion 103)", () => {
    const text = textOf(renderPage());
    expect(text).toMatch(/Available for sale/);
  });

  it("shows an unavailable line prominently but still renders the verification form (criterion 104)", () => {
    const html = renderPage({
      order: {
        ...OPEN_ORDER,
        lines: [{ ...OPEN_ORDER.lines[0]!, availability: "unavailable" as const }],
      },
    });
    const text = textOf(html);
    expect(text).toMatch(/NOT currently available for sale/);
    // The form is still present — unavailability never blocks (criterion 104).
    expect(html).toMatch(/id="amountReceived"/);
    expect(html).toMatch(/Verify Payment &amp; Complete Order/);
  });

  it("has a real, labelled, keyboard-operable form with every required field, and NO identity field (D23)", () => {
    const html = renderPage();
    for (const field of ["amountReceived", "currency", "method"]) {
      expect(html).toMatch(new RegExp(`<label[^>]*for="${field}"`));
      expect(html).toMatch(new RegExp(`id="${field}"`));
    }
    // reference is present but optional — still labelled.
    expect(html).toMatch(/<label[^>]*for="reference"/);
    expect(html).toMatch(/<form[^>]*method="post"/i);
    // D23 removed the typed "verifiedBy" field entirely — the identity comes
    // from the authenticated session, never a form field.
    expect(html).not.toMatch(/id="verifiedBy"/);
    expect(html).not.toMatch(/name="verifiedBy"/);
  });

  it("submits with intent=verify", () => {
    const html = renderPage();
    expect(html).toMatch(/name="intent"[^>]*value="verify"|value="verify"[^>]*name="intent"/);
  });

  it("offers only the four eligible electronic methods in the method select — CLAUDE.md #14", () => {
    const html = renderPage();
    expect(html).toMatch(/<option value="zelle">/);
    expect(html).toMatch(/<option value="ach">/);
    expect(html).toMatch(/<option value="bank_transfer">/);
    expect(html).toMatch(/<option value="wire">/);
    // Word-boundaried: the page's own copy legitimately says "checked just
    // now" for the availability re-check, which contains "check" as a
    // substring but is not the payment method "check" this guards against.
    expect(html).not.toMatch(/<option value="check"|<option value="money_order"|<option value="cash"|\bcheque\b/i);
  });

  it("never renders cost, margin or landed-cost figures", () => {
    const text = textOf(renderPage());
    expect(text.toLowerCase()).not.toMatch(/landed ?cost|gross margin|margin rate|uplift/);
  });

  it("names the button 'Verify Payment & Complete Order' so the consequence is legible before the click (criterion 123)", () => {
    const html = renderPage();
    expect(html).toMatch(/Verify Payment &amp; Complete Order/);
  });

  it("states the consequence and shows the order reference and expected amount before submitting (criterion 123)", () => {
    const text = textOf(renderPage());
    expect(text).toMatch(/mark the payment as verified/i);
    expect(text).toMatch(/11111111-1111-1111-1111-111111111111/);
  });
});

describe("a cancelled order", () => {
  it("shows the cancellation reason and no verification form", () => {
    const html = renderPage({ order: CANCELLED_ORDER });
    const text = textOf(html);
    expect(text).toMatch(/cancelled/i);
    expect(text).toMatch(/Published price changed/);
    expect(html).not.toMatch(/id="amountReceived"/);
  });
});

describe("a verified AND completed order", () => {
  it("renders the verification record instead of the form, with the authenticated identity (D23)", () => {
    const html = renderPage({ order: VERIFIED_AND_COMPLETED_ORDER });
    const text = textOf(html);
    expect(text).toMatch(/jordan@example\.com/);
    expect(text).toMatch(/Shopify user 42/);
    expect(text).toMatch(/zelle/);
    expect(text).toMatch(/REF-99/);
    expect(html).not.toMatch(/id="amountReceived"/);
  });

  it("shows the Shopify order id once completed", () => {
    const text = textOf(renderPage({ order: VERIFIED_AND_COMPLETED_ORDER }));
    expect(text).toMatch(/gid:\/\/shopify\/Order\/1/);
  });

  it("shows an exact match plainly when received equals expected", () => {
    const text = textOf(
      renderPage({
        order: {
          ...VERIFIED_AND_COMPLETED_ORDER,
          verifiedPaymentAmountMinorUnits: "150000",
          comparison: { receivedMinorUnits: "150000", currencyMismatch: false, differenceMinorUnits: "0", matchesExactly: true },
        },
      })
    );
    expect(text).toMatch(/matches the amount expected exactly/);
  });

  it("flags a currency mismatch instead of a numeric difference", () => {
    const text = textOf(
      renderPage({
        order: {
          ...VERIFIED_AND_COMPLETED_ORDER,
          verifiedPaymentCurrency: "EUR",
          comparison: { receivedMinorUnits: "150500", currencyMismatch: true, differenceMinorUnits: null, matchesExactly: false },
        },
      })
    );
    expect(text).toMatch(/does not match the expected currency/i);
  });

  it("shows no 'Retry completion' button once genuinely completed", () => {
    const html = renderPage({ order: VERIFIED_AND_COMPLETED_ORDER });
    expect(html).not.toMatch(/Retry completion/);
  });
});

describe("D25 — verified but not completed (the recovery state, criteria 118-120)", () => {
  it("shows the verification record, NOT the verification form", () => {
    const html = renderPage({ order: VERIFIED_PENDING_COMPLETION_ORDER });
    const text = textOf(html);
    expect(text).toMatch(/jordan@example\.com/);
    // The form must not reappear (criterion 118).
    expect(html).not.toMatch(/id="amountReceived"/);
  });

  it("explains that completion did not finish, and offers a 'Retry completion' action", () => {
    const html = renderPage({ order: VERIFIED_PENDING_COMPLETION_ORDER });
    const text = textOf(html);
    expect(text).toMatch(/could not be completed automatically/i);
    expect(html).toMatch(/Retry completion/);
    // The retry submits a DIFFERENT intent — never "verify" (criterion 119: never a second verification).
    expect(html).toMatch(/name="intent"[^>]*value="retry-completion"|value="retry-completion"[^>]*name="intent"/);
  });

  it("says retrying is safe because it always checks with Shopify first", () => {
    const text = textOf(renderPage({ order: VERIFIED_PENDING_COMPLETION_ORDER }));
    expect(text).toMatch(/checks with Shopify first/i);
  });

  it("shows a repeated completion-failure message when the retry itself just failed", () => {
    const html = renderPage(
      { order: VERIFIED_PENDING_COMPLETION_ORDER },
      { ok: false, formError: "Completion failed again: simulated outage", fieldErrors: [], submitted: null, mismatch: null, completionFailed: true }
    );
    expect(textOf(html)).toMatch(/Completion failed again: simulated outage/);
  });
});

describe("D24 — a mismatched amount refuses, and states both figures plus the difference (criteria 115-117)", () => {
  const mismatchActionData = {
    ok: false,
    formError: "Amount received does not match the amount expected. Nothing was recorded — resolution is manual.",
    fieldErrors: [],
    submitted: { amountReceived: "900.00", currency: "USD", method: "zelle", reference: "" },
    mismatch: {
      expectedMinorUnits: "150000",
      expectedCurrency: "USD",
      receivedMinorUnits: "90000",
      receivedCurrency: "USD",
      currencyMismatch: false,
      differenceMinorUnits: "-60000",
    },
    completionFailed: false,
  };

  it("states the expected amount, the received amount and the difference", () => {
    const text = textOf(renderPage({}, mismatchActionData));
    expect(text).toMatch(/does not match the amount expected/i);
    expect(text).toMatch(/Expected: USD 1,500\.00/);
    expect(text).toMatch(/Received: USD 900\.00/);
    expect(text).toMatch(/Difference: -USD 600\.00/);
  });

  it("says resolution is manual and offers no remedy path", () => {
    const text = textOf(renderPage({}, mismatchActionData));
    expect(text).toMatch(/resolution is manual/i);
    expect(text).not.toMatch(/refund|credit|adjust|partial payment/i);
  });

  it("still shows the form so the submission can be corrected", () => {
    const html = renderPage({}, mismatchActionData);
    expect(html).toMatch(/id="amountReceived"/);
  });

  it("flags a currency mismatch distinctly from a numeric difference", () => {
    const text = textOf(
      renderPage(
        {},
        {
          ...mismatchActionData,
          mismatch: { ...mismatchActionData.mismatch, receivedCurrency: "EUR", currencyMismatch: true, differenceMinorUnits: null },
        }
      )
    );
    expect(text).toMatch(/received currency does not match the expected currency/i);
  });
});

describe("a rejected submission (server-side field validation)", () => {
  it("shows every field error, associates it with its field, and re-populates what was submitted", () => {
    const actionData = {
      ok: false,
      formError: null,
      fieldErrors: [
        { field: "amountReceived", message: "Amount received is required." },
        { field: "method", message: "Payment method is required." },
      ],
      submitted: { amountReceived: "", currency: "USD", method: "", reference: "" },
      mismatch: null,
      completionFailed: false,
    };
    const html = renderPage({}, actionData);
    const text = textOf(html);
    expect(text).toMatch(/Amount received is required/);
    expect(text).toMatch(/Payment method is required/);
    // Associated with the field via aria-describedby, not merely present somewhere on the page.
    expect(html).toMatch(/aria-describedby="amountReceived-error"/);
    expect(html).toMatch(/id="amountReceived-error"/);
    expect(html).toMatch(/aria-invalid="true"[^>]*id="amountReceived"|id="amountReceived"[^>]*aria-invalid="true"/);
  });

  it("shows a whole-form error (e.g. an order that stopped being open mid-submit)", () => {
    const actionData = {
      ok: false,
      formError: "bank payment order 11111111-1111-1111-1111-111111111111 is cancelled; only an open order can be verified",
      fieldErrors: [],
      submitted: { amountReceived: "150000", currency: "USD", method: "zelle", reference: "" },
      mismatch: null,
      completionFailed: false,
    };
    const text = textOf(renderPage({}, actionData));
    expect(text).toMatch(/only an open order can be verified/);
  });

  it("shows a refusal when the request could not be attributed to an authenticated staff member (criterion 114)", () => {
    const actionData = {
      ok: false,
      formError:
        "This request could not be attributed to a signed-in Shopify staff member (no online session). Reload the page and try again.",
      fieldErrors: [],
      submitted: { amountReceived: "1500.00", currency: "USD", method: "zelle", reference: "" },
      mismatch: null,
      completionFailed: false,
    };
    const text = textOf(renderPage({}, actionData));
    expect(text).toMatch(/could not be attributed to a signed-in Shopify staff member/);
  });
});
