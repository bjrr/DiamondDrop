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
  customerEmail: "ada@example.com",
  shopifyDraftOrderGid: "gid://shopify/DraftOrder/1",
  shopifyOrderGid: null,
  quotedAt: "2026-09-20T10:00:00.000Z",
  guaranteeExpiresAt: "2026-09-21T10:00:00.000Z",
  verifiedAt: null,
  verifiedBy: null,
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

const VERIFIED_ORDER = {
  ...OPEN_ORDER,
  id: "22222222-2222-2222-2222-222222222222",
  status: "completed" as const,
  shopifyOrderGid: "gid://shopify/Order/1",
  verifiedAt: "2026-09-20T11:00:00.000Z",
  verifiedBy: "Jordan Lee",
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

const CANCELLED_ORDER = {
  ...OPEN_ORDER,
  id: "33333333-3333-3333-3333-333333333333",
  status: "cancelled" as const,
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
    expect(html).toMatch(/Record verification and complete order/);
  });

  it("has a real, labelled, keyboard-operable form with every required field", () => {
    const html = renderPage();
    for (const field of ["amountReceived", "currency", "method", "verifiedBy"]) {
      expect(html).toMatch(new RegExp(`<label[^>]*for="${field}"`));
      expect(html).toMatch(new RegExp(`id="${field}"`));
    }
    // reference is present but optional — still labelled.
    expect(html).toMatch(/<label[^>]*for="reference"/);
    expect(html).toMatch(/<form[^>]*method="post"/i);
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

  it("discloses that the verifying admin identifier is typed, not authenticated", () => {
    const text = textOf(renderPage());
    expect(text).toMatch(/not authenticated/i);
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

describe("an already-verified order", () => {
  it("renders the verification record instead of the form", () => {
    const html = renderPage({ order: VERIFIED_ORDER });
    const text = textOf(html);
    expect(text).toMatch(/Jordan Lee/);
    expect(text).toMatch(/zelle/);
    expect(text).toMatch(/REF-99/);
    expect(html).not.toMatch(/id="amountReceived"/);
  });

  it("shows the Shopify order id once completed", () => {
    const text = textOf(renderPage({ order: VERIFIED_ORDER }));
    expect(text).toMatch(/gid:\/\/shopify\/Order\/1/);
  });

  it("shows an amount mismatch prominently as text, without blocking anything", () => {
    const text = textOf(renderPage({ order: VERIFIED_ORDER }));
    expect(text).toMatch(/does NOT match/);
    expect(text).toMatch(/overpaid/);
  });

  it("shows an exact match plainly when received equals expected", () => {
    const text = textOf(
      renderPage({
        order: {
          ...VERIFIED_ORDER,
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
          ...VERIFIED_ORDER,
          verifiedPaymentCurrency: "EUR",
          comparison: { receivedMinorUnits: "150500", currencyMismatch: true, differenceMinorUnits: null, matchesExactly: false },
        },
      })
    );
    expect(text).toMatch(/does not match the expected currency/i);
  });
});

describe("a rejected submission (server-side field validation)", () => {
  it("shows every field error, associates it with its field, and re-populates what was submitted", () => {
    const actionData = {
      ok: false,
      formError: null,
      fieldErrors: [
        { field: "amountReceived", message: "Amount received is required." },
        { field: "verifiedBy", message: "The verifying admin's name is required." },
      ],
      submitted: { amountReceived: "", currency: "USD", method: "zelle", reference: "", verifiedBy: "" },
    };
    const html = renderPage({}, actionData);
    const text = textOf(html);
    expect(text).toMatch(/Amount received is required/);
    // renderToStaticMarkup HTML-encodes the apostrophe as `&#x27;`, and
    // textOf() only strips tags, not entities.
    expect(text).toMatch(/verifying admin(?:'|&#x27;)s name is required/);
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
      submitted: { amountReceived: "150000", currency: "USD", method: "zelle", reference: "", verifiedBy: "Jordan Lee" },
    };
    const text = textOf(renderPage({}, actionData));
    expect(text).toMatch(/only an open order can be verified/);
  });
});
