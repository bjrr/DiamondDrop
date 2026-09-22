import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation, useRouteError } from "react-router";

import {
  BANK_PAYMENT_METHODS,
  classifyBankPaymentOrderState,
  compareReceivedToExpected,
  computeExpectedTotal,
  parseVerificationFormData,
  validateVerificationSubmission,
  type BankPaymentVerificationState,
  type VerificationFieldError,
} from "~/domain/bankpayment/verification";
import {
  BankPaymentAmountMismatchError,
  BankPaymentOrderNotOpenForVerificationError,
  checkLinesAvailability,
  completeVerifiedBankPaymentOrder,
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
 * 2C phase 2C-c, `docs/specs/SLICE-2C-BANK-PAYMENT-CHECKOUT.md` §5.4/§14/§19,
 * owner §23, criteria 87-91, 103-104, 112-124).
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
 * D23 — "VERIFYING ADMIN" IS THE AUTHENTICATED SHOPIFY STAFF IDENTITY, not a
 * typed name. `session.onlineAccessInfo.associated_user` (id + email) is
 * resolved here, in the action, and passed straight through to
 * `verification.server.ts` — there is no form field for it, and a request
 * that carries no associated user is refused outright (criterion 114).
 *
 * D24 — a mismatched amount refuses BEFORE anything is recorded (criteria
 * 115-117): see the `BankPaymentAmountMismatchError` branch below.
 *
 * D25 — completion can fail after verification is recorded, and recovery is
 * its own explicit action (criteria 118-120): the "intent" hidden field
 * distinguishes the verification submission from the "Retry completion"
 * recovery action, which NEVER re-validates or re-records a verification —
 * it only calls `completeVerifiedBankPaymentOrder` again, which itself
 * always asks Shopify first (read-before-write) before ever attempting
 * `draftOrderComplete` a second time.
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
  /** D25 — which of the four UI states this order is in right now (see `classifyBankPaymentOrderState`). */
  readonly verificationState: BankPaymentVerificationState;
  readonly customerEmail: string;
  readonly shopifyDraftOrderGid: string;
  readonly shopifyOrderGid: string | null;
  readonly quotedAt: string;
  readonly guaranteeExpiresAt: string;
  readonly verifiedAt: string | null;
  /** D23 — the authenticated identity, never a typed name. */
  readonly verifiedByEmail: string | null;
  readonly verifiedByShopifyUserId: string | null;
  readonly verifiedPaymentAmountMinorUnits: string | null;
  readonly verifiedPaymentCurrency: string | null;
  readonly verifiedPaymentMethod: string | null;
  readonly verifiedPaymentReference: string | null;
  readonly cancellationReason: string | null;
  readonly currency: string;
  readonly expectedTotalMinorUnits: string;
  readonly lines: readonly LineViewModel[];
  /** Only present once verified — the expected-vs-received comparison (display only; never re-evaluated here). */
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
    verificationState: classifyBankPaymentOrderState(order),
    customerEmail: order.customerEmail,
    shopifyDraftOrderGid: order.shopifyDraftOrderGid,
    shopifyOrderGid: order.shopifyOrderGid,
    quotedAt: order.quotedAt.toISOString(),
    guaranteeExpiresAt: order.guaranteeExpiresAt.toISOString(),
    verifiedAt: order.verifiedAt ? order.verifiedAt.toISOString() : null,
    verifiedByEmail: order.verifiedByEmail,
    verifiedByShopifyUserId: order.verifiedByShopifyUserId?.toString() ?? null,
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

interface AmountMismatchView {
  readonly expectedMinorUnits: string;
  readonly expectedCurrency: string;
  readonly receivedMinorUnits: string;
  readonly receivedCurrency: string;
  readonly currencyMismatch: boolean;
  readonly differenceMinorUnits: string | null;
}

interface ActionData {
  ok: boolean;
  formError: string | null;
  fieldErrors: readonly VerificationFieldError[];
  /** Echoed back so a rejected submission can be re-displayed rather than cleared. No identity field — see D23. */
  submitted: { amountReceived: string; currency: string; method: string; reference: string } | null;
  /** D24 — set only when the submission was refused for not matching the expected amount. */
  mismatch: AmountMismatchView | null;
  /** D25 — true when verification (or the retry) succeeded up to the point of completion, but completion itself failed. The order is left in `verified_pending_completion`; the next load shows the recovery UI, not the form. */
  completionFailed: boolean;
}

function emptyActionData(overrides: Partial<ActionData> = {}): ActionData {
  return { ok: false, formError: null, fieldErrors: [], submitted: null, mismatch: null, completionFailed: false, ...overrides };
}

/** Resolves the AUTHENTICATED Shopify staff identity (D23) from the online session, or null if somehow absent — never defaulted (criterion 114). */
function resolveVerifierIdentity(
  session: Awaited<ReturnType<typeof authenticate.admin>>["session"]
): { verifiedByShopifyUserId: bigint; verifiedByEmail: string } | null {
  const associatedUser = session.onlineAccessInfo?.associated_user;
  if (!associatedUser) return null;
  return { verifiedByShopifyUserId: BigInt(associatedUser.id), verifiedByEmail: associatedUser.email };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const id = params.id;
  if (!id) {
    return Response.json(emptyActionData({ formError: "Missing Bank Payment order id." }), { status: 400 });
  }
  if (request.method !== "POST") {
    return Response.json(emptyActionData({ formError: "Method not allowed." }), { status: 405 });
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  // Criterion 112/114 — every write on this route is attributed to the
  // AUTHENTICATED Shopify staff identity, never a typed name. Checked BEFORE
  // either branch below does anything else, because neither branch may
  // proceed without it.
  const verifier = resolveVerifierIdentity(session);
  if (!verifier) {
    logger.error("bank_payments.no_online_user", { bankPaymentOrderId: id });
    return Response.json(
      emptyActionData({
        formError:
          "This request could not be attributed to a signed-in Shopify staff member (no online session). " +
          "Reload the page and try again.",
      }),
      { status: 401 }
    );
  }

  const draftOrderPort: DraftOrderPort = draftOrderPortOverrideForTests ?? new ShopifyDraftOrderAdapter(admin);

  // D25, criterion 119 — RECOVERY IS ITS OWN EXPLICIT ACTION, never a second
  // verification. This branch never touches verification fields; it only
  // (re)attempts completion through the one function safe to call twice.
  if (intent === "retry-completion") {
    const completion = await completeVerifiedBankPaymentOrder({
      bankPaymentOrderId: id,
      shop: session.shop,
      admin,
      draftOrderPort,
    });
    if (completion.outcome === "completion_failed") {
      logger.warn("bank_payments.retry_completion_failed", { bankPaymentOrderId: id, error: completion.error });
      return Response.json(
        emptyActionData({ formError: `Completion failed again: ${completion.error}`, completionFailed: true }),
        { status: 502 }
      );
    }
    logger.info("bank_payments.retry_completion_succeeded", { bankPaymentOrderId: id });
    return Response.json(emptyActionData({ ok: true }));
  }

  const raw = parseVerificationFormData(formData);
  const submittedEcho = {
    amountReceived: raw.amountReceived ?? "",
    currency: raw.currency ?? "",
    method: raw.method ?? "",
    reference: raw.reference ?? "",
  };

  const validation = validateVerificationSubmission(raw);
  if (!validation.ok) {
    return Response.json(
      emptyActionData({ fieldErrors: validation.errors, submitted: submittedEcho }),
      { status: 400 }
    );
  }

  const order = await loadBankPaymentOrderForVerification(id);
  if (!order) {
    return Response.json(
      emptyActionData({ formError: "That Bank Payment order no longer exists.", submitted: submittedEcho }),
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

  try {
    const result = await verifyAndCompleteBankPaymentOrder({
      bankPaymentOrderId: id,
      submission: validation.value,
      shop: session.shop,
      verifiedByShopifyUserId: verifier.verifiedByShopifyUserId,
      verifiedByEmail: verifier.verifiedByEmail,
      admin,
      draftOrderPort,
      availabilityShownToAdmin,
    });

    if (result.outcome === "completion_failed") {
      // D25, criterion 118 — the verification itself IS recorded; only
      // completion failed. Never re-thrown as a request failure: the next
      // load classifies this order as verified_pending_completion and shows
      // the recovery UI, not the form.
      logger.warn("bank_payments.verified_but_completion_failed", {
        bankPaymentOrderId: id,
        error: result.completionError,
      });
      return Response.json(
        emptyActionData({
          ok: true,
          completionFailed: true,
          formError: `Payment was recorded as verified, but completing the Shopify order failed: ${result.completionError}. Use "Retry completion" below.`,
        })
      );
    }

    logger.info("bank_payments.verified", { bankPaymentOrderId: id, outcome: result.outcome });
    return Response.json(emptyActionData({ ok: true }));
  } catch (error) {
    if (error instanceof BankPaymentAmountMismatchError) {
      // D24, criteria 115-117 — refused before anything was persisted.
      const c = error.comparison;
      return Response.json(
        emptyActionData({
          formError: "Amount received does not match the amount expected. Nothing was recorded — resolution is manual.",
          submitted: submittedEcho,
          mismatch: {
            expectedMinorUnits: c.expected.amountMinorUnits.toString(),
            expectedCurrency: c.expected.currency,
            receivedMinorUnits: c.received.amountMinorUnits.toString(),
            receivedCurrency: c.received.currency,
            currencyMismatch: c.currencyMismatch,
            differenceMinorUnits: c.differenceMinorUnits?.toString() ?? null,
          },
        }),
        { status: 409 }
      );
    }
    if (error instanceof BankPaymentOrderNotOpenForVerificationError) {
      return Response.json(
        emptyActionData({ formError: error.message, submitted: submittedEcho }),
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

/** D24 — both figures and the difference, stated plainly; no remedy path offered (criterion 116). */
function AmountMismatchNotice({ mismatch }: { mismatch: AmountMismatchView }) {
  return (
    <div role="alert" style={{ color: "#b00", margin: "0 0 1rem", border: "1px solid #b00", borderRadius: "4px", padding: "0.75rem 1rem" }}>
      <p style={{ margin: "0 0 0.5rem", fontWeight: 700 }}>Amount received does not match the amount expected.</p>
      <p style={{ margin: "0 0 0.25rem" }}>
        Expected: {formatMinorUnitsForDisplay(mismatch.expectedMinorUnits, mismatch.expectedCurrency)}
      </p>
      <p style={{ margin: "0 0 0.25rem" }}>
        Received: {formatMinorUnitsForDisplay(mismatch.receivedMinorUnits, mismatch.receivedCurrency)}
      </p>
      {mismatch.currencyMismatch ? (
        <p style={{ margin: "0 0 0.5rem" }}>The received currency does not match the expected currency.</p>
      ) : (
        <p style={{ margin: "0 0 0.5rem" }}>
          Difference: {formatMinorUnitsForDisplay(mismatch.differenceMinorUnits ?? "0", mismatch.expectedCurrency)}
        </p>
      )}
      <p style={{ margin: 0 }}>
        Nothing was recorded. Resolution is manual — confirm the correct amount before submitting again.
      </p>
    </div>
  );
}

export default function BankPaymentVerificationPage() {
  const { apiKey, shop, order, availabilityCheckError } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const fieldErrors = actionData?.fieldErrors ?? [];
  const submitted = actionData?.submitted ?? null;
  const mismatch = actionData?.mismatch ?? null;

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
                  <dt style={{ display: "inline", fontWeight: 600 }}>Bank Payment order reference: </dt>
                  <dd style={{ display: "inline", margin: 0 }}>
                    <code>{order.id}</code>
                  </dd>
                </div>
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

            {order.verificationState === "completed" || order.verificationState === "verified_pending_completion" ? (
              <section style={{ marginBottom: "1.5rem", border: "1px solid #ddd", borderRadius: "4px", padding: "1rem" }}>
                <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Verification record</h2>
                <dl style={{ margin: 0, fontSize: "0.875rem", display: "grid", rowGap: "0.35rem" }}>
                  <div>
                    <dt style={{ display: "inline", fontWeight: 600 }}>Verified at: </dt>
                    <dd style={{ display: "inline", margin: 0 }}>
                      {order.verifiedAt ? <time dateTime={order.verifiedAt}>{formatTimestamp(order.verifiedAt)}</time> : null}
                    </dd>
                  </div>
                  <div>
                    <dt style={{ display: "inline", fontWeight: 600 }}>Verified by: </dt>
                    <dd style={{ display: "inline", margin: 0 }}>
                      {order.verifiedByEmail} (Shopify user {order.verifiedByShopifyUserId})
                    </dd>
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
                  ) : null /* D24 means a stored, non-matching comparison should not occur going forward; kept defensive rather than asserted. */
                ) : null}

                {order.verificationState === "verified_pending_completion" ? (
                  <div style={{ marginTop: "1rem", padding: "0.75rem 1rem", border: "1px solid #b06a00", borderRadius: "4px" }}>
                    <p role="alert" style={{ margin: "0 0 0.5rem", fontWeight: 700, color: "#b06a00" }}>
                      Payment is verified, but the Shopify order could not be completed automatically.
                    </p>
                    <p style={{ margin: "0 0 0.75rem", fontSize: "0.875rem" }}>
                      Nothing further was verified or charged. Retrying is safe — it always checks with Shopify
                      first, so it will never create a second order for this payment.
                    </p>
                    {actionData?.formError && actionData.completionFailed ? (
                      <p role="alert" style={{ margin: "0 0 0.75rem", color: "#b00", fontSize: "0.875rem" }}>
                        {actionData.formError}
                      </p>
                    ) : null}
                    <Form method="post">
                      <input type="hidden" name="intent" value="retry-completion" />
                      <button type="submit" disabled={busy}>
                        {busy ? "Retrying…" : "Retry completion"}
                      </button>
                    </Form>
                  </div>
                ) : null}
              </section>
            ) : order.verificationState === "cancelled" ? (
              <p role="alert" style={{ color: "#b00" }}>
                This order is {order.status} and cannot be verified.
              </p>
            ) : (
              <section style={{ border: "1px solid #ddd", borderRadius: "4px", padding: "1rem" }}>
                <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem" }}>Verify payment</h2>
                <p style={{ margin: "0 0 1rem", fontSize: "0.875rem", color: "#555" }}>
                  Recording this will mark the payment as verified and attempt to complete the Shopify order for
                  Bank Payment order <code>{order.id}</code>. If the amount you enter does not match the amount
                  expected, nothing will be recorded.
                </p>

                {mismatch ? <AmountMismatchNotice mismatch={mismatch} /> : null}

                {actionData?.formError && !mismatch ? (
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
                  <input type="hidden" name="intent" value="verify" />
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

                  <div style={{ marginBottom: "1rem" }}>
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

                  <button type="submit" disabled={busy}>
                    {busy ? "Verifying…" : "Verify Payment & Complete Order"}
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
