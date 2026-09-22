import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation, useRouteError } from "react-router";

import {
  BANK_PAYMENT_METHODS,
  compareReceivedToExpected,
  computeExpectedTotal,
  parseVerificationFormData,
  validateVerificationSubmission,
  type VerificationFieldError,
} from "~/domain/bankpayment/verification";
import {
  BankPaymentOrderNotOpenForVerificationError,
  checkLinesAvailability,
  loadBankPaymentOrderForVerification,
  verifyAndCompleteBankPaymentOrder,
  type BankPaymentOrderDetail,
  type LineAvailability,
} from "~/domain/bankpayment/verification.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { authenticate } from "~/shopify.server";
import { ShopifyDraftOrderAdapter, type DraftOrderPort } from "~/shopify/admin/draftOrderAdapter.server";
import { Money } from "~/domain/money/money";

/**
 * GET/POST /app/bank-payments/:id — manual Bank Payment verification (Slice
 * 2C phase 2C-c, `docs/specs/SLICE-2C-BANK-PAYMENT-CHECKOUT.md` §5.4/§14,
 * owner §23, criteria 87-91, 103-104).
 *
 * LAUNCH-MINIMUM, per the assigning message: record amount, method,
 * reference (where available), timestamp and verifying admin; verify
 * exactly once; complete through the already-proven
 * `completeBankPaymentOrder` path. NOT built here (§10 non-goals): a
 * customer payment portal, automated reconciliation, payment-proof upload,
 * partial payments, refunds, bulk actions.
 *
 * A DEFAULT EXPORT WITH AN ACTION, exactly like `_index.tsx` — see
 * `csrfResourceRouteFence.test.ts`'s `EXEMPT_UI_ACTION_ROUTES` for the
 * reasoned exemption this route needed added there. It is not
 * cross-origin-reachable in production: Shopify Admin opens it inside an
 * iframe pointed at this app's own host.
 *
 * "VERIFYING ADMIN" IS A TYPED IDENTIFIER, NOT AN AUTHENTICATED ONE — see
 * `verification.server.ts`'s header comment for the full reasoning
 * (`app/shopify.server.ts` uses an OFFLINE session token, which identifies
 * the shop, not the person). `session.shop` is recorded on every audit
 * event as the authenticated half of "who"; `verifiedBy` is the weaker,
 * self-typed half.
 */

export interface LineViewModel {
  readonly id: string;
  readonly productTitle: string;
  readonly variantLabel: string;
  readonly quantity: number;
  readonly eligibleAtQuoteTime: boolean;
  readonly chargedUnitPriceMinorUnits: string;
  readonly currency: string;
  /** "available" | "unavailable" | "unknown" — criterion 103, shown before the admin confirms; never gates submission (criterion 104). */
  readonly availability: "available" | "unavailable" | "unknown";
}

export interface OrderViewModel {
  readonly id: string;
  readonly status: BankPaymentOrderDetail["status"];
  readonly customerEmail: string;
  readonly shopifyDraftOrderGid: string;
  readonly shopifyOrderGid: string | null;
  readonly quotedAt: string;
  readonly guaranteeExpiresAt: string;
  readonly verifiedAt: string | null;
  readonly verifiedBy: string | null;
  readonly verifiedPaymentAmountMinorUnits: string | null;
  readonly verifiedPaymentCurrency: string | null;
  readonly verifiedPaymentMethod: string | null;
  readonly verifiedPaymentReference: string | null;
  readonly cancellationReason: string | null;
  readonly currency: string;
  readonly expectedTotalMinorUnits: string;
  readonly lines: readonly LineViewModel[];
  /** Only present once verified — the expected-vs-received comparison (never blocks anything; display only). */
  readonly comparison: {
    readonly receivedMinorUnits: string;
    readonly currencyMismatch: boolean;
    readonly differenceMinorUnits: string | null;
    readonly matchesExactly: boolean;
  } | null;
}

function availabilityStatus(value: boolean | null): LineViewModel["availability"] {
  if (value === true) return "available";
  if (value === false) return "unavailable";
  return "unknown";
}

function buildOrderViewModel(order: BankPaymentOrderDetail, availability: readonly LineAvailability[]): OrderViewModel {
  const currency = order.lines[0]?.currency ?? "USD";
  const availabilityByVariant = new Map(availability.map((a) => [a.masterVariantId, a.availableForSale]));
  const expectedTotal = computeExpectedTotal(order.lines, currency);

  const comparison =
    order.verifiedAt && order.verifiedPaymentAmountMinorUnits !== null && order.verifiedPaymentCurrency
      ? compareReceivedToExpected(
          expectedTotal,
          Money.fromMinorUnits(order.verifiedPaymentAmountMinorUnits, order.verifiedPaymentCurrency)
        )
      : null;

  return {
    id: order.id,
    status: order.status,
    customerEmail: order.customerEmail,
    shopifyDraftOrderGid: order.shopifyDraftOrderGid,
    shopifyOrderGid: order.shopifyOrderGid,
    quotedAt: order.quotedAt.toISOString(),
    guaranteeExpiresAt: order.guaranteeExpiresAt.toISOString(),
    verifiedAt: order.verifiedAt ? order.verifiedAt.toISOString() : null,
    verifiedBy: order.verifiedBy,
    verifiedPaymentAmountMinorUnits: order.verifiedPaymentAmountMinorUnits?.toString() ?? null,
    verifiedPaymentCurrency: order.verifiedPaymentCurrency,
    verifiedPaymentMethod: order.verifiedPaymentMethod,
    verifiedPaymentReference: order.verifiedPaymentReference,
    cancellationReason: order.cancellationReason,
    currency,
    expectedTotalMinorUnits: expectedTotal.amountMinorUnits.toString(),
    lines: order.lines.map((line) => ({
      id: line.id,
      productTitle: line.productTitle,
      variantLabel: line.variantLabel,
      quantity: line.quantity,
      eligibleAtQuoteTime: line.eligibleAtQuoteTime,
      chargedUnitPriceMinorUnits: line.chargedUnitPriceMinorUnits.toString(),
      currency: line.currency,
      availability: availabilityStatus(availabilityByVariant.get(line.masterVariantId) ?? null),
    })),
    comparison: comparison
      ? {
          receivedMinorUnits: comparison.received.amountMinorUnits.toString(),
          currencyMismatch: comparison.currencyMismatch,
          differenceMinorUnits: comparison.differenceMinorUnits?.toString() ?? null,
          matchesExactly: comparison.matchesExactly,
        }
      : null,
  };
}

interface LoaderData {
  apiKey: string;
  shop: string;
  order: OrderViewModel | null;
  availabilityCheckError: string | null;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const id = params.id;
  if (!id) throw new Response("Missing Bank Payment order id.", { status: 400 });

  const order = await loadBankPaymentOrderForVerification(id);
  if (!order) {
    return {
      apiKey: getEnv().SHOPIFY_API_KEY ?? "",
      shop: session.shop,
      order: null,
      availabilityCheckError: null,
    } satisfies LoaderData;
  }

  // Criterion 103 — re-queried live, EVERY load, shown BEFORE any
  // confirmation. Never cached, never skipped for an already-verified order:
  // a staff member reviewing history should see current availability too.
  let availability: LineAvailability[] = [];
  let availabilityCheckError: string | null = null;
  try {
    availability = await checkLinesAvailability(
      admin,
      order.lines.map((line) => ({ masterVariantId: line.masterVariantId, shopifyVariantGid: line.shopifyVariantGid }))
    );
  } catch (error) {
    // Criterion 104 says unavailability never blocks; a FAILED check is the
    // same story one level up — never block the page, just say so honestly.
    availabilityCheckError =
      error instanceof Error ? error.message : "Could not check current availability with Shopify.";
  }

  return {
    apiKey: getEnv().SHOPIFY_API_KEY ?? "",
    shop: session.shop,
    order: buildOrderViewModel(order, availability),
    availabilityCheckError,
  } satisfies LoaderData;
}

interface ActionData {
  ok: boolean;
  formError: string | null;
  fieldErrors: readonly VerificationFieldError[];
  /** Echoed back so a rejected submission can be re-displayed rather than cleared. */
  submitted: { amountReceived: string; currency: string; method: string; reference: string; verifiedBy: string } | null;
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const id = params.id;
  if (!id) return Response.json({ ok: false, formError: "Missing Bank Payment order id.", fieldErrors: [], submitted: null } satisfies ActionData, { status: 400 });

  if (request.method !== "POST") {
    return Response.json({ ok: false, formError: "Method not allowed.", fieldErrors: [], submitted: null } satisfies ActionData, { status: 405 });
  }

  const formData = await request.formData();
  const raw = parseVerificationFormData(formData);
  const submittedEcho = {
    amountReceived: raw.amountReceived ?? "",
    currency: raw.currency ?? "",
    method: raw.method ?? "",
    reference: raw.reference ?? "",
    verifiedBy: raw.verifiedBy ?? "",
  };

  const validation = validateVerificationSubmission(raw);
  if (!validation.ok) {
    return Response.json(
      { ok: false, formError: null, fieldErrors: validation.errors, submitted: submittedEcho } satisfies ActionData,
      { status: 400 }
    );
  }

  const order = await loadBankPaymentOrderForVerification(id);
  if (!order) {
    return Response.json(
      { ok: false, formError: "That Bank Payment order no longer exists.", fieldErrors: [], submitted: submittedEcho } satisfies ActionData,
      { status: 404 }
    );
  }

  // Criterion 103, re-checked again at the moment of decision (not merely
  // trusted from what the GET rendered a moment earlier) — see
  // `verifyAndCompleteBankPaymentOrder`'s own doc comment on why this is
  // stronger than carrying the GET's answer through a hidden form field.
  let availabilityShownToAdmin: LineAvailability[] = [];
  try {
    availabilityShownToAdmin = await checkLinesAvailability(
      admin,
      order.lines.map((line) => ({ masterVariantId: line.masterVariantId, shopifyVariantGid: line.shopifyVariantGid }))
    );
  } catch (error) {
    logger.warn("bank_payments.verify_availability_check_failed", {
      bankPaymentOrderId: id,
      message: error instanceof Error ? error.message : String(error),
    });
    // Criterion 104: unavailability (or an inability to confirm it) never
    // blocks verification. Recorded as "unknown" for every line rather than
    // refusing the whole submission over an availability read failure.
    availabilityShownToAdmin = order.lines.map((line) => ({
      masterVariantId: line.masterVariantId,
      shopifyVariantGid: line.shopifyVariantGid,
      availableForSale: null,
    }));
  }

  const draftOrderPort: DraftOrderPort = draftOrderPortOverrideForTests ?? new ShopifyDraftOrderAdapter(admin);

  try {
    const result = await verifyAndCompleteBankPaymentOrder({
      bankPaymentOrderId: id,
      submission: validation.value,
      shop: session.shop,
      draftOrderPort,
      availabilityShownToAdmin,
    });
    logger.info("bank_payments.verified", { bankPaymentOrderId: id, outcome: result.outcome });
    return Response.json({ ok: true, formError: null, fieldErrors: [], submitted: null } satisfies ActionData);
  } catch (error) {
    if (error instanceof BankPaymentOrderNotOpenForVerificationError) {
      return Response.json(
        { ok: false, formError: error.message, fieldErrors: [], submitted: submittedEcho } satisfies ActionData,
        { status: 409 }
      );
    }
    throw error;
  }
}

/**
 * TEST-ONLY OVERRIDE HOOK, identical pattern to
 * `apps.carat.bank-checkout.tsx`'s `__setDraftOrderPortForTests`.
 */
let draftOrderPortOverrideForTests: DraftOrderPort | null = null;
export function __setDraftOrderPortForTests(port: DraftOrderPort | null): void {
  draftOrderPortOverrideForTests = port;
}

function formatTimestamp(iso: string): string {
  return `${iso.replace("T", " ").slice(0, 16)} UTC`;
}

/** Whole minor units as a human dollar-and-cents string — display only, never used for a second calculation (the server already computed everything shown). */
function formatMinorUnitsForDisplay(minorUnits: string, currency: string): string {
  const negative = minorUnits.startsWith("-");
  const digits = negative ? minorUnits.slice(1) : minorUnits;
  const padded = digits.padStart(3, "0");
  const major = padded.slice(0, -2);
  const minor = padded.slice(-2);
  // Thousands separators inserted by STRING manipulation, never arithmetic —
  // toLocaleString would mean Number(), which the money-safety scan bans and
  // which would silently lose precision above 2^53 minor units.
  //
  // Grouping is not cosmetic here. This screen exists so a staff member can
  // compare a figure against a bank statement, and "USD 1500.00" versus
  // "USD 150000.00" is one glance away from a misread on the exact number
  // that records how much money arrived.
  const grouped = major.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${currency} ${grouped}.${minor}`;
}

function availabilityText(status: LineViewModel["availability"]): string {
  switch (status) {
    case "available":
      return "Available for sale (checked just now).";
    case "unavailable":
      return "NOT currently available for sale (checked just now). Recording payment is still allowed — decide how to handle this line after verifying.";
    case "unknown":
      return "Could not be confirmed (no Shopify variant on file, or the availability check failed).";
  }
}

function AvailabilityBanner({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" style={{ color: "#b00", margin: "0 0 1rem" }}>
      Could not check current availability with Shopify: {error}. Every line below is shown as
      "could not be confirmed" until this succeeds — verification is still allowed.
    </p>
  );
}

function FieldError({ id, errors, field }: { id: string; errors: readonly VerificationFieldError[]; field: VerificationFieldError["field"] }) {
  const message = errors.find((e) => e.field === field)?.message;
  if (!message) return null;
  return (
    <p id={id} style={{ color: "#b00", fontSize: "0.8rem", margin: "0.25rem 0 0" }}>
      Error: {message}
    </p>
  );
}

export default function BankPaymentVerificationPage() {
  const { apiKey, shop, order, availabilityCheckError } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const fieldErrors = actionData?.fieldErrors ?? [];
  const submitted = actionData?.submitted ?? null;

  return (
    <AppProvider apiKey={apiKey}>
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", lineHeight: 1.5, maxWidth: "48rem" }}>
        <p style={{ margin: "0 0 0.5rem" }}>
          <Link to="/app/bank-payments">&larr; Back to Bank Payment orders</Link>
        </p>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>Bank Payment verification</h1>
        <p style={{ margin: "0 0 1.5rem", color: "#555" }}>
          Connected to <strong>{shop}</strong>.
        </p>

        {!order ? (
          <p role="alert" style={{ color: "#b00" }}>
            That Bank Payment order was not found.
          </p>
        ) : (
          <>
            <section style={{ marginBottom: "1.5rem", border: "1px solid #ddd", borderRadius: "4px", padding: "1rem" }}>
              <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Order</h2>
              <dl style={{ margin: 0, fontSize: "0.875rem", display: "grid", rowGap: "0.35rem" }}>
                <div>
                  <dt style={{ display: "inline", fontWeight: 600 }}>Customer email: </dt>
                  <dd style={{ display: "inline", margin: 0 }}>{order.customerEmail}</dd>
                </div>
                <div>
                  <dt style={{ display: "inline", fontWeight: 600 }}>Status: </dt>
                  <dd style={{ display: "inline", margin: 0 }}>{order.status}</dd>
                </div>
                <div>
                  <dt style={{ display: "inline", fontWeight: 600 }}>Shopify draft order: </dt>
                  <dd style={{ display: "inline", margin: 0 }}>
                    <code>{order.shopifyDraftOrderGid}</code>
                  </dd>
                </div>
                {order.shopifyOrderGid ? (
                  <div>
                    <dt style={{ display: "inline", fontWeight: 600 }}>Shopify order: </dt>
                    <dd style={{ display: "inline", margin: 0 }}>
                      <code>{order.shopifyOrderGid}</code>
                    </dd>
                  </div>
                ) : null}
                <div>
                  <dt style={{ display: "inline", fontWeight: 600 }}>Quoted at: </dt>
                  <dd style={{ display: "inline", margin: 0 }}>
                    <time dateTime={order.quotedAt}>{formatTimestamp(order.quotedAt)}</time>
                  </dd>
                </div>
                <div>
                  <dt style={{ display: "inline", fontWeight: 600 }}>Amount expected: </dt>
                  <dd style={{ display: "inline", margin: 0 }}>
                    {formatMinorUnitsForDisplay(order.expectedTotalMinorUnits, order.currency)}
                  </dd>
                </div>
                {order.status === "cancelled" && order.cancellationReason ? (
                  <div>
                    <dt style={{ display: "inline", fontWeight: 600 }}>Cancellation reason: </dt>
                    <dd style={{ display: "inline", margin: 0 }}>{order.cancellationReason}</dd>
                  </div>
                ) : null}
              </dl>
            </section>

            <section style={{ marginBottom: "1.5rem" }}>
              <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Lines</h2>
              <AvailabilityBanner error={availabilityCheckError} />
              <ul style={{ margin: 0, padding: 0, listStyle: "none" }}>
                {order.lines.map((line) => (
                  <li
                    key={line.id}
                    style={{ border: "1px solid #ddd", borderRadius: "4px", padding: "0.75rem 1rem", marginBottom: "0.75rem" }}
                  >
                    <p style={{ margin: "0 0 0.25rem", fontWeight: 600 }}>
                      {line.productTitle} — {line.variantLabel} × {line.quantity}
                    </p>
                    <p style={{ margin: "0 0 0.25rem", fontSize: "0.875rem" }}>
                      Charged: {formatMinorUnitsForDisplay(line.chargedUnitPriceMinorUnits, line.currency)} each (
                      {line.eligibleAtQuoteTime ? "Bank Payment Price" : "Regular/Card Price — ineligible at quote time"})
                    </p>
                    <p
                      style={{
                        margin: 0,
                        fontSize: "0.875rem",
                        fontWeight: line.availability === "unavailable" ? 700 : 400,
                      }}
                    >
                      Availability: {availabilityText(line.availability)}
                    </p>
                  </li>
                ))}
              </ul>
            </section>

            {order.verifiedAt ? (
              <section style={{ marginBottom: "1.5rem", border: "1px solid #ddd", borderRadius: "4px", padding: "1rem" }}>
                <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Verification record</h2>
                <dl style={{ margin: 0, fontSize: "0.875rem", display: "grid", rowGap: "0.35rem" }}>
                  <div>
                    <dt style={{ display: "inline", fontWeight: 600 }}>Verified at: </dt>
                    <dd style={{ display: "inline", margin: 0 }}>
                      <time dateTime={order.verifiedAt}>{formatTimestamp(order.verifiedAt)}</time>
                    </dd>
                  </div>
                  <div>
                    <dt style={{ display: "inline", fontWeight: 600 }}>Verified by: </dt>
                    <dd style={{ display: "inline", margin: 0 }}>{order.verifiedBy}</dd>
                  </div>
                  <div>
                    <dt style={{ display: "inline", fontWeight: 600 }}>Method: </dt>
                    <dd style={{ display: "inline", margin: 0 }}>{order.verifiedPaymentMethod}</dd>
                  </div>
                  <div>
                    <dt style={{ display: "inline", fontWeight: 600 }}>Reference: </dt>
                    <dd style={{ display: "inline", margin: 0 }}>{order.verifiedPaymentReference ?? "(none recorded)"}</dd>
                  </div>
                  <div>
                    <dt style={{ display: "inline", fontWeight: 600 }}>Amount received: </dt>
                    <dd style={{ display: "inline", margin: 0 }}>
                      {order.verifiedPaymentAmountMinorUnits && order.verifiedPaymentCurrency
                        ? formatMinorUnitsForDisplay(order.verifiedPaymentAmountMinorUnits, order.verifiedPaymentCurrency)
                        : "(not recorded)"}
                    </dd>
                  </div>
                </dl>

                {order.comparison ? (
                  order.comparison.currencyMismatch ? (
                    <p role="alert" style={{ margin: "0.75rem 0 0", fontWeight: 700, color: "#b06a00" }}>
                      The received currency does not match the expected currency — compare the amounts by hand.
                    </p>
                  ) : order.comparison.matchesExactly ? (
                    <p style={{ margin: "0.75rem 0 0" }}>Amount received matches the amount expected exactly.</p>
                  ) : (
                    <p role="alert" style={{ margin: "0.75rem 0 0", fontWeight: 700, color: "#b06a00" }}>
                      Amount received does NOT match the amount expected. Difference:{" "}
                      {formatMinorUnitsForDisplay(order.comparison.differenceMinorUnits ?? "0", order.currency)} (
                      {order.comparison.differenceMinorUnits && order.comparison.differenceMinorUnits.startsWith("-")
                        ? "underpaid"
                        : "overpaid"}
                      ). This does not block anything — decide how to handle it.
                    </p>
                  )
                ) : null}
              </section>
            ) : order.status !== "open" ? (
              <p role="alert" style={{ color: "#b00" }}>
                This order is {order.status} and cannot be verified.
              </p>
            ) : (
              <section style={{ border: "1px solid #ddd", borderRadius: "4px", padding: "1rem" }}>
                <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem" }}>Record verification</h2>

                {actionData?.formError ? (
                  <p role="alert" style={{ color: "#b00", margin: "0 0 1rem" }}>
                    {actionData.formError}
                  </p>
                ) : null}
                {fieldErrors.length > 0 ? (
                  <div role="alert" style={{ color: "#b00", margin: "0 0 1rem" }}>
                    <p style={{ margin: "0 0 0.25rem", fontWeight: 600 }}>
                      This submission could not be recorded — {fieldErrors.length} field
                      {fieldErrors.length === 1 ? "" : "s"} need attention:
                    </p>
                    <ul style={{ margin: 0, paddingLeft: "1.25rem" }}>
                      {fieldErrors.map((e) => (
                        <li key={e.field}>{e.message}</li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <Form method="post">
                  <div style={{ marginBottom: "0.75rem" }}>
                    <label htmlFor="amountReceived" style={{ display: "block", fontWeight: 600, fontSize: "0.875rem" }}>
                      Amount received in {order.currency} — required (as it appears on the statement, e.g. 1500.00)
                    </label>
                    <input
                      id="amountReceived"
                      name="amountReceived"
                      type="text"
                      inputMode="numeric"
                      defaultValue={submitted?.amountReceived ?? ""}
                      aria-invalid={fieldErrors.some((e) => e.field === "amountReceived") || undefined}
                      aria-describedby="amountReceived-error"
                      style={{ display: "block", padding: "0.4rem 0.6rem", width: "100%", maxWidth: "20rem" }}
                    />
                    <FieldError id="amountReceived-error" errors={fieldErrors} field="amountReceived" />
                  </div>

                  <div style={{ marginBottom: "0.75rem" }}>
                    <label htmlFor="currency" style={{ display: "block", fontWeight: 600, fontSize: "0.875rem" }}>
                      Currency (3-letter code) — required
                    </label>
                    <input
                      id="currency"
                      name="currency"
                      type="text"
                      maxLength={3}
                      defaultValue={submitted?.currency ?? order.currency}
                      aria-invalid={fieldErrors.some((e) => e.field === "currency") || undefined}
                      aria-describedby="currency-error"
                      style={{ display: "block", padding: "0.4rem 0.6rem", width: "6rem", textTransform: "uppercase" }}
                    />
                    <FieldError id="currency-error" errors={fieldErrors} field="currency" />
                  </div>

                  <div style={{ marginBottom: "0.75rem" }}>
                    <label htmlFor="method" style={{ display: "block", fontWeight: 600, fontSize: "0.875rem" }}>
                      Payment method — required
                    </label>
                    <select
                      id="method"
                      name="method"
                      defaultValue={submitted?.method ?? ""}
                      aria-invalid={fieldErrors.some((e) => e.field === "method") || undefined}
                      aria-describedby="method-error"
                      style={{ display: "block", padding: "0.4rem 0.6rem" }}
                    >
                      <option value="">Select a method…</option>
                      {BANK_PAYMENT_METHODS.map((method) => (
                        <option key={method} value={method}>
                          {method}
                        </option>
                      ))}
                    </select>
                    <FieldError id="method-error" errors={fieldErrors} field="method" />
                  </div>

                  <div style={{ marginBottom: "0.75rem" }}>
                    <label htmlFor="reference" style={{ display: "block", fontWeight: 600, fontSize: "0.875rem" }}>
                      Reference / confirmation number (optional — record if available)
                    </label>
                    <input
                      id="reference"
                      name="reference"
                      type="text"
                      defaultValue={submitted?.reference ?? ""}
                      style={{ display: "block", padding: "0.4rem 0.6rem", width: "100%", maxWidth: "20rem" }}
                    />
                  </div>

                  <div style={{ marginBottom: "1rem" }}>
                    <label htmlFor="verifiedBy" style={{ display: "block", fontWeight: 600, fontSize: "0.875rem" }}>
                      Your name (verifying admin) — required
                    </label>
                    <input
                      id="verifiedBy"
                      name="verifiedBy"
                      type="text"
                      defaultValue={submitted?.verifiedBy ?? ""}
                      aria-invalid={fieldErrors.some((e) => e.field === "verifiedBy") || undefined}
                      aria-describedby="verifiedBy-error"
                      style={{ display: "block", padding: "0.4rem 0.6rem", width: "100%", maxWidth: "20rem" }}
                    />
                    <FieldError id="verifiedBy-error" errors={fieldErrors} field="verifiedBy" />
                    <p style={{ margin: "0.25rem 0 0", fontSize: "0.75rem", color: "#777" }}>
                      Typed, not authenticated — this app cannot yet confirm which staff member is signed in. See
                      the handoff notes for the follow-up.
                    </p>
                  </div>

                  <button type="submit" disabled={busy}>
                    {busy ? "Recording…" : "Record verification and complete order"}
                  </button>
                </Form>
              </section>
            )}
          </>
        )}
      </main>
    </AppProvider>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
