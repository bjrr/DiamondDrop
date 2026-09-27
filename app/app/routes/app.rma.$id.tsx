import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation, useRouteError } from "react-router";
import type { CSSProperties, ReactNode } from "react";

import {
  approveRmaRequest,
  beginRmaRemedy,
  closeRmaRequest,
  createRmaRemedy,
  decideRmaCondition,
  denyRmaRequest,
  expireRmaRequest,
  getRmaRequestForStaffReview,
  IllegalRmaTransitionError,
  InvalidRmaRemedyStatusUpdateError,
  markRmaReturnShipped,
  recordRmaReceipt,
  recordRmaReturnShippingEvidence,
  resolveRmaRequest,
  RmaActorRequiredError,
  RmaNotApprovedForShippingError,
  RmaNotEligibleForRemedyError,
  RmaPersonalizedNotEligibleForApprovalError,
  RmaRemedyAlreadyExistsError,
  RmaRemedyNotFoundError,
  RmaRequestNotFoundError,
  updateRmaRemedyStatus,
  type RmaStaffView,
} from "~/db/repositories/rmaRepository.server";
import { RMA_REMEDY_KINDS } from "~/domain/rma/remedy";
import { mayIssueReturnInstructions } from "~/domain/rma/status";
import { DEFAULT_ROUNDING_RULE_ID } from "~/domain/money/rounding";
import { Money } from "~/domain/money/money";
import { executeRmaRemedy, RmaRemedyIllegalStateError } from "~/jobs/rma/executeRmaRemedy.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import type { RmaRemedyExecutionPort } from "~/shopify/admin/rmaRemedyExecutionAdapter.server";
import { ShopifyRmaRemedyExecutionAdapter } from "~/shopify/admin/rmaRemedyExecutionAdapter.server";
import { authenticate } from "~/shopify.server";

/**
 * GET/POST /app/rma/:id — the staff Buy Now RMA detail/review surface (Slice
 * 4 remedy-execution task, `docs/BUY-NOW-RETURNS-AND-DISPUTE-EVIDENCE.md`,
 * `docs/ARCHITECTURE-MVP1.md` D5/D7/D10, `docs/specs/SLICE-4-BUY-NOW-RMA.md`
 * criteria 192-204). Mirrors `app.warranty-claims.$id.tsx`'s architecture
 * closely — same staff-identity discipline (D23: the AUTHENTICATED Shopify
 * session, never a form field), same "only offer a control the domain would
 * actually allow" UI-gating discipline, same explicit view-model field list
 * (never a raw Prisma spread) — see that route's own header for the fuller
 * rationale this file does not repeat.
 *
 * TWO REMEDY PATHS, BOTH GATED THE SAME WAY (remedy exists, not yet issued):
 *   - `execute_remedy` — the AUTOMATED path, via
 *     `app/jobs/rma/executeRmaRemedy.server.ts`. Handles the two 100%-value
 *     cases (standard-window refund, late-window merchandise credit)
 *     end-to-end against Shopify, idempotently.
 *   - `update_remedy_status` — the MANUAL path (same shape as
 *     `app.warranty-claims.$id.tsx`'s own manual remedy-status control),
 *     for exactly the case the automated path always declines to touch: a
 *     late-window 50%-restocking-fee refund, which this codebase refuses to
 *     compute Shopify tax for (D7 — see the job's own header). Staff process
 *     that refund directly in Shopify Admin, then record the result here.
 *     This is the SAME repository function
 *     (`updateRmaRemedyStatus`/`assertRmaRemedyTransition`) either path
 *     ultimately writes through — a manual entry cannot skip a state the
 *     automated path could not skip either.
 *
 * A DEFAULT EXPORT WITH AN ACTION — see this repo's
 * `csrfResourceRouteFence.test.ts` `EXEMPT_UI_ACTION_ROUTES` for the reasoned
 * exemption entry added for this route (same argument as
 * `app.warranty-claims.$id.tsx`: Shopify Admin iframes this route at the
 * app's own host, so a form submitted from within it is same-origin by
 * construction).
 *
 * NEVER SHOWS supplier cost, margin, or landed cost — there is none on
 * `RmaRequest`/`RmaRemedy`/`RmaEvent` to begin with.
 */

// ---------------------------------------------------------------------------
// View model
// ---------------------------------------------------------------------------

interface RmaEventView {
  readonly id: string;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly actorType: string;
  readonly actorRef: string | null;
  readonly reason: string | null;
  readonly createdAt: string;
}

interface RmaRemedyView {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly eligibleMerchandiseAmountMinorUnits: string;
  readonly merchandiseAmountMinorUnits: string;
  readonly restockingFeeMinorUnits: string;
  readonly currency: string;
  readonly shopifyTaxAdjustmentMinorUnits: string | null;
  readonly actualRefundOrCreditMinorUnits: string | null;
  readonly processorReference: string | null;
  readonly failureReason: string | null;
  readonly staffReviewReason: string | null;
  readonly issuedAt: string | null;
}

interface RmaView {
  readonly id: string;
  readonly rmaReference: string;
  readonly orderRef: string;
  readonly lineRef: string;
  readonly customerRef: string | null;
  readonly itemConfigurationDescription: string;
  readonly purchaserEmail: string;
  readonly carrierConfirmedDeliveryDate: string;
  readonly requestedAt: string;
  readonly calendarDaysSinceDelivery: number;
  readonly reasonCategory: string;
  readonly reasonExplanation: string;
  readonly requestedRemedyKind: string | null;
  readonly isPersonalizedOrAltered: boolean;
  readonly hasProductSpecificReturnOverride: boolean;
  readonly windowKind: string;
  readonly eligibleMerchandiseAmountMinorUnits: string;
  readonly eligibleMerchandiseAmountCurrency: string;
  readonly status: string;
  readonly approvedAt: string | null;
  readonly deniedAt: string | null;
  readonly denialReason: string | null;
  readonly receiveByDeadline: string | null;
  readonly returnTrackingCarrier: string | null;
  readonly returnTrackingNumber: string | null;
  readonly returnInsuranceReference: string | null;
  readonly returnInsuredValueMinorUnits: string | null;
  readonly returnInsuredValueCurrency: string | null;
  readonly returnShippedAt: string | null;
  readonly expiredAt: string | null;
  readonly receivedAt: string | null;
  readonly packageCondition: string | null;
  readonly itemCondition: string | null;
  readonly inspectionNotes: string | null;
  readonly conditionDecision: string | null;
  readonly conditionDecisionReason: string | null;
  readonly resolvedAt: string | null;
  readonly closedAt: string | null;
  readonly events: readonly RmaEventView[];
  readonly remedy: RmaRemedyView | null;
}

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}
function money(minorUnits: bigint | null | undefined): string | null {
  return minorUnits === null || minorUnits === undefined ? null : minorUnits.toString();
}

function buildRmaView(rma: RmaStaffView): RmaView {
  return {
    id: rma.id,
    rmaReference: rma.rmaReference,
    orderRef: rma.orderRef,
    lineRef: rma.lineRef,
    customerRef: rma.customerRef,
    itemConfigurationDescription: rma.itemConfigurationDescription,
    purchaserEmail: rma.purchaserEmail,
    carrierConfirmedDeliveryDate: rma.carrierConfirmedDeliveryDate.toISOString(),
    requestedAt: rma.requestedAt.toISOString(),
    calendarDaysSinceDelivery: rma.calendarDaysSinceDelivery,
    reasonCategory: rma.reasonCategory,
    reasonExplanation: rma.reasonExplanation,
    requestedRemedyKind: rma.requestedRemedyKind,
    isPersonalizedOrAltered: rma.isPersonalizedOrAltered,
    hasProductSpecificReturnOverride: rma.hasProductSpecificReturnOverride,
    windowKind: rma.windowKind,
    eligibleMerchandiseAmountMinorUnits: rma.eligibleMerchandiseAmountMinorUnits.toString(),
    eligibleMerchandiseAmountCurrency: rma.eligibleMerchandiseAmountCurrency,
    status: rma.status,
    approvedAt: iso(rma.approvedAt),
    deniedAt: iso(rma.deniedAt),
    denialReason: rma.denialReason,
    receiveByDeadline: iso(rma.receiveByDeadline),
    returnTrackingCarrier: rma.returnTrackingCarrier,
    returnTrackingNumber: rma.returnTrackingNumber,
    returnInsuranceReference: rma.returnInsuranceReference,
    returnInsuredValueMinorUnits: money(rma.returnInsuredValueMinorUnits),
    returnInsuredValueCurrency: rma.returnInsuredValueCurrency,
    returnShippedAt: iso(rma.returnShippedAt),
    expiredAt: iso(rma.expiredAt),
    receivedAt: iso(rma.receivedAt),
    packageCondition: rma.packageCondition,
    itemCondition: rma.itemCondition,
    inspectionNotes: rma.inspectionNotes,
    conditionDecision: rma.conditionDecision,
    conditionDecisionReason: rma.conditionDecisionReason,
    resolvedAt: iso(rma.resolvedAt),
    closedAt: iso(rma.closedAt),
    events: rma.events.map((event) => ({
      id: event.id,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      actorType: event.actorType,
      actorRef: event.actorRef,
      reason: event.reason,
      createdAt: event.createdAt.toISOString(),
    })),
    remedy: rma.remedy
      ? {
          id: rma.remedy.id,
          kind: rma.remedy.kind,
          status: rma.remedy.status,
          eligibleMerchandiseAmountMinorUnits: rma.remedy.eligibleMerchandiseAmountMinorUnits.toString(),
          merchandiseAmountMinorUnits: rma.remedy.merchandiseAmountMinorUnits.toString(),
          restockingFeeMinorUnits: rma.remedy.restockingFeeMinorUnits.toString(),
          currency: rma.remedy.currency,
          shopifyTaxAdjustmentMinorUnits: money(rma.remedy.shopifyTaxAdjustmentMinorUnits),
          actualRefundOrCreditMinorUnits: money(rma.remedy.actualRefundOrCreditMinorUnits),
          processorReference: rma.remedy.processorReference,
          failureReason: rma.remedy.failureReason,
          staffReviewReason: rma.remedy.staffReviewReason,
          issuedAt: iso(rma.remedy.issuedAt),
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Which controls the UI may offer — a plain status comparison, never a
// re-derivation of the transition table itself (same criterion-159
// discipline as `app.warranty-claims.$id.tsx`).
// ---------------------------------------------------------------------------

function canApproveOrDeny(status: string): boolean {
  return status === "submitted";
}
function canMarkReturnShipped(status: string): boolean {
  return status === "approved";
}
function canExpire(status: string): boolean {
  return status === "approved" || status === "return_shipped";
}
function canRecordReceipt(status: string): boolean {
  return status === "approved" || status === "return_shipped";
}
function canRecordReturnShipping(view: RmaView): boolean {
  return mayIssueReturnInstructions({ approvedAt: view.approvedAt ? new Date(view.approvedAt) : null });
}
function canDecideCondition(status: string): boolean {
  return status === "received_inspection_pending";
}
function canCreateRemedy(view: RmaView): boolean {
  return view.status === "inspection_passed" && view.remedy === null;
}
function canExecuteRemedy(view: RmaView): boolean {
  return view.status === "remedy_in_progress" && view.remedy !== null && view.remedy.status !== "issued";
}
function canManuallyUpdateRemedyStatus(view: RmaView): boolean {
  return view.remedy !== null && view.remedy.status !== "issued";
}
function canResolve(status: string): boolean {
  return status === "remedy_in_progress" || status === "inspection_failed";
}
function canClose(status: string): boolean {
  return status === "resolved";
}

// ---------------------------------------------------------------------------
// Staff identity — D23, identical discipline to `app.warranty-claims.$id.tsx`.
// ---------------------------------------------------------------------------

function resolveStaffActorRef(session: Awaited<ReturnType<typeof authenticate.admin>>["session"]): string | null {
  const associatedUser = session.onlineAccessInfo?.associated_user;
  if (!associatedUser) return null;
  return `staff:${associatedUser.id}`;
}

// ---------------------------------------------------------------------------
// Money field parsing — dollars-and-cents text, same discipline as
// `app.warranty-claims.$id.tsx`'s `parseMoneyField`.
// ---------------------------------------------------------------------------

const MAJOR_UNIT_AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

function parseMoneyField(amountText: string, currencyText: string, fieldLabel: string): { minorUnits: bigint; currency: string } | { error: string } {
  const amount = amountText.trim();
  const currency = currencyText.trim().toUpperCase();
  if (amount === "") return { error: `${fieldLabel} amount is required.` };
  if (!MAJOR_UNIT_AMOUNT_PATTERN.test(amount)) {
    return { error: `${fieldLabel} amount must be dollars and cents, at most two decimal places, no symbol — e.g. 150 or 150.00.` };
  }
  if (currency === "" || !CURRENCY_PATTERN.test(currency)) {
    return { error: `${fieldLabel} currency must be a 3-letter ISO 4217 code (e.g. USD).` };
  }
  const minorUnits = Money.fromDecimalMajorUnits(amount, currency, DEFAULT_ROUNDING_RULE_ID).amountMinorUnits;
  if (minorUnits < 0n) return { error: `${fieldLabel} amount cannot be negative.` };
  return { minorUnits, currency };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

interface LoaderData {
  apiKey: string;
  shop: string;
  rma: RmaView | null;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const id = params.id;
  if (!id) throw new Response("Missing RMA id.", { status: 400 });

  const rma = await getRmaRequestForStaffReview(id);
  return {
    apiKey: getEnv().SHOPIFY_API_KEY ?? "",
    shop: session.shop,
    rma: rma ? buildRmaView(rma) : null,
  } satisfies LoaderData;
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

interface ActionData {
  ok: boolean;
  formError: string | null;
}
function ok(): ActionData {
  return { ok: true, formError: null };
}
function fail(formError: string): ActionData {
  return { ok: false, formError };
}
function stringField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}
function optionalStringField(formData: FormData, name: string): string | undefined {
  const value = stringField(formData, name).trim();
  return value === "" ? undefined : value;
}

/** TEST-ONLY OVERRIDE HOOK, identical pattern to `app.luxury-steals._index.tsx`'s `__setLuxuryStealSyncPortForTests`. */
let rmaRemedyPortOverrideForTests: RmaRemedyExecutionPort | null = null;
export function __setRmaRemedyPortForTests(port: RmaRemedyExecutionPort | null): void {
  rmaRemedyPortOverrideForTests = port;
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const id = params.id;
  if (!id) return Response.json(fail("Missing RMA id."), { status: 400 });
  if (request.method !== "POST") return Response.json(fail("Method not allowed."), { status: 405 });

  const staffActorRef = resolveStaffActorRef(session);
  if (!staffActorRef) {
    logger.error("rma.no_online_user", { rmaId: id });
    return Response.json(
      fail("This request could not be attributed to a signed-in Shopify staff member (no online session). Reload the page and try again."),
      { status: 401 }
    );
  }
  const actor = { actorType: "staff" as const, actorRef: staffActorRef };

  const formData = await request.formData();
  const intent = stringField(formData, "intent");

  try {
    switch (intent) {
      case "approve": {
        await approveRmaRequest(id, staffActorRef, { reason: optionalStringField(formData, "reason") });
        return Response.json(ok());
      }

      case "deny": {
        const reason = stringField(formData, "reason").trim();
        if (reason === "") return Response.json(fail("A reason is required to deny an RMA."), { status: 400 });
        await denyRmaRequest(id, staffActorRef, reason);
        return Response.json(ok());
      }

      case "mark_return_shipped": {
        await markRmaReturnShipped(id, actor);
        return Response.json(ok());
      }

      case "expire": {
        await expireRmaRequest(id, actor);
        return Response.json(ok());
      }

      case "record_receipt": {
        await recordRmaReceipt(id, {
          packageCondition: optionalStringField(formData, "packageCondition"),
          itemCondition: optionalStringField(formData, "itemCondition"),
          inspectionNotes: optionalStringField(formData, "inspectionNotes"),
          inspectedByActorRef: staffActorRef,
        });
        return Response.json(ok());
      }

      case "record_return_shipping": {
        const insuredValueAmount = stringField(formData, "insuredValueAmount").trim();
        let insuredValueMinorUnits: bigint | undefined;
        let insuredValueCurrency: string | undefined;
        if (insuredValueAmount !== "") {
          const parsed = parseMoneyField(insuredValueAmount, stringField(formData, "insuredValueCurrency"), "Insured value");
          if ("error" in parsed) return Response.json(fail(parsed.error), { status: 400 });
          insuredValueMinorUnits = parsed.minorUnits;
          insuredValueCurrency = parsed.currency;
        }
        await recordRmaReturnShippingEvidence(
          id,
          {
            carrier: optionalStringField(formData, "carrier"),
            trackingNumber: optionalStringField(formData, "trackingNumber"),
            insuranceReference: optionalStringField(formData, "insuranceReference"),
            insuredValueMinorUnits,
            insuredValueCurrency,
          },
          actor
        );
        return Response.json(ok());
      }

      case "decide_condition": {
        const decisionText = stringField(formData, "decision");
        if (decisionText !== "accepted" && decisionText !== "rejected") {
          return Response.json(fail("A condition decision (accepted or rejected) is required."), { status: 400 });
        }
        const reason = optionalStringField(formData, "reason");
        if (decisionText === "rejected" && !reason) {
          return Response.json(fail("A reason is required to reject item condition at inspection."), { status: 400 });
        }
        await decideRmaCondition(id, { decision: decisionText, reason, decidedByActorRef: staffActorRef });
        return Response.json(ok());
      }

      case "create_remedy": {
        // Two repository calls, one staff action — same "select the remedy"
        // orchestration as `app.warranty-claims.$id.tsx`'s `record_remedy`:
        // records WHAT the computed remedy is, then moves the RMA into
        // `remedy_in_progress`. Neither function's own rules are re-derived
        // here.
        await createRmaRemedy({ rmaId: id });
        await beginRmaRemedy(id, actor);
        return Response.json(ok());
      }

      case "execute_remedy": {
        const port = rmaRemedyPortOverrideForTests ?? new ShopifyRmaRemedyExecutionAdapter(admin);
        await executeRmaRemedy(id, { port });
        return Response.json(ok());
      }

      case "update_remedy_status": {
        const statusText = stringField(formData, "status");
        if (!["processing", "issued", "failed", "staff_review_required"].includes(statusText)) {
          return Response.json(fail("A valid remedy status is required."), { status: 400 });
        }

        let actualRefundOrCreditMinorUnits: bigint | undefined;
        let shopifyTaxAdjustmentMinorUnits: bigint | undefined;
        if (statusText === "issued") {
          const actualParsed = parseMoneyField(
            stringField(formData, "actualRefundOrCreditAmount"),
            stringField(formData, "actualRefundOrCreditCurrency"),
            "Actual refund/credit"
          );
          if ("error" in actualParsed) return Response.json(fail(actualParsed.error), { status: 400 });
          actualRefundOrCreditMinorUnits = actualParsed.minorUnits;

          const taxAmountText = stringField(formData, "shopifyTaxAdjustmentAmount").trim();
          if (taxAmountText !== "") {
            const taxParsed = parseMoneyField(taxAmountText, stringField(formData, "shopifyTaxAdjustmentCurrency"), "Shopify tax adjustment");
            if ("error" in taxParsed) return Response.json(fail(taxParsed.error), { status: 400 });
            shopifyTaxAdjustmentMinorUnits = taxParsed.minorUnits;
          }
        }

        await updateRmaRemedyStatus({
          rmaId: id,
          status: statusText as "processing" | "issued" | "failed" | "staff_review_required",
          processorReference: optionalStringField(formData, "processorReference"),
          failureReason: optionalStringField(formData, "failureReason"),
          staffReviewReason: optionalStringField(formData, "staffReviewReason"),
          actualRefundOrCreditMinorUnits,
          shopifyTaxAdjustmentMinorUnits,
        });
        return Response.json(ok());
      }

      case "resolve": {
        await resolveRmaRequest(id, actor);
        return Response.json(ok());
      }

      case "close": {
        await closeRmaRequest(id, actor);
        return Response.json(ok());
      }

      default:
        return Response.json(fail(`Unrecognized action: ${intent}`), { status: 400 });
    }
  } catch (error) {
    if (error instanceof RmaRequestNotFoundError || error instanceof RmaRemedyNotFoundError) {
      return Response.json(fail("That RMA no longer exists."), { status: 404 });
    }
    if (
      error instanceof IllegalRmaTransitionError ||
      error instanceof RmaNotApprovedForShippingError ||
      error instanceof RmaRemedyAlreadyExistsError ||
      error instanceof RmaRemedyIllegalStateError
    ) {
      // Should be unreachable through this UI's own gating — still surfaced
      // plainly (a stale page, two staff tabs, can still reach it).
      return Response.json(fail(error.message), { status: 409 });
    }
    if (error instanceof RmaPersonalizedNotEligibleForApprovalError || error instanceof RmaNotEligibleForRemedyError) {
      return Response.json(fail(error.message), { status: 409 });
    }
    if (error instanceof RmaActorRequiredError || error instanceof InvalidRmaRemedyStatusUpdateError) {
      return Response.json(fail(error.message), { status: 400 });
    }
    logger.error("rma.action_failed", { rmaId: id, intent, message: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function formatTimestamp(iso8601: string): string {
  return `${iso8601.replace("T", " ").slice(0, 16)} UTC`;
}
function formatMoney(minorUnits: string | null, currency: string | null): string {
  if (minorUnits === null || currency === null) return "(not recorded)";
  const negative = minorUnits.startsWith("-");
  const digits = negative ? minorUnits.slice(1) : minorUnits;
  const padded = digits.padStart(3, "0");
  const major = padded.slice(0, -2);
  const minor = padded.slice(-2);
  const grouped = major.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${currency} ${grouped}.${minor}`;
}

const sectionStyle: CSSProperties = { marginBottom: "1.5rem", border: "1px solid #ddd", borderRadius: "4px", padding: "1rem" };
const labelStyle: CSSProperties = { display: "block", fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.25rem" };
const inputStyle: CSSProperties = { display: "block", padding: "0.4rem 0.6rem", width: "100%", maxWidth: "24rem", marginBottom: "0.6rem" };

function Field({ id, name, label, defaultValue, required }: { id: string; name: string; label: string; defaultValue?: string; required?: boolean }) {
  return (
    <div>
      <label htmlFor={id} style={labelStyle}>{label}</label>
      <input id={id} name={name} type="text" defaultValue={defaultValue} required={required} style={inputStyle} />
    </div>
  );
}
function TextAreaField({ id, name, label }: { id: string; name: string; label: string }) {
  return (
    <div>
      <label htmlFor={id} style={labelStyle}>{label}</label>
      <textarea id={id} name={name} rows={3} style={{ ...inputStyle, maxWidth: "100%" }} />
    </div>
  );
}

export default function RmaDetailPage() {
  const { apiKey, shop, rma } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <AppProvider apiKey={apiKey}>
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", lineHeight: 1.5, maxWidth: "56rem" }}>
        <p style={{ margin: "0 0 0.5rem" }}>
          <Link to="/app/rma">&larr; Back to RMAs</Link>
        </p>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>Buy Now RMA</h1>
        <p style={{ margin: "0 0 1.5rem", color: "#555" }}>
          Connected to <strong>{shop}</strong>.
        </p>

        {!rma ? (
          <p role="alert" style={{ color: "#b00" }}>That RMA was not found.</p>
        ) : (
          <>
            {actionData?.formError ? (
              <p role="alert" style={{ color: "#b00", margin: "0 0 1rem", border: "1px solid #b00", borderRadius: "4px", padding: "0.75rem 1rem" }}>
                {actionData.formError}
              </p>
            ) : null}

            <section style={sectionStyle}>
              <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
                {rma.rmaReference} — <span style={{ fontWeight: 400 }}>{rma.status}</span>
              </h2>
              <dl style={{ margin: 0, fontSize: "0.875rem", display: "grid", rowGap: "0.35rem" }}>
                <Row label="Order">{rma.orderRef}</Row>
                <Row label="Line">{rma.lineRef}</Row>
                <Row label="Customer ref">{rma.customerRef ?? "(none)"}</Row>
                <Row label="Purchaser">{rma.purchaserEmail}</Row>
                <Row label="Item / configuration">{rma.itemConfigurationDescription}</Row>
                <Row label="Delivered">{rma.carrierConfirmedDeliveryDate.slice(0, 10)}</Row>
                <Row label="Requested">
                  {formatTimestamp(rma.requestedAt)} ({rma.calendarDaysSinceDelivery} days after delivery, {rma.windowKind} window)
                </Row>
                <Row label="Reason">
                  {rma.reasonCategory} — {rma.reasonExplanation}
                </Row>
                <Row label="Requested remedy">{rma.requestedRemedyKind ?? "(standard window — no choice)"}</Row>
                <Row label="Eligible merchandise amount">{formatMoney(rma.eligibleMerchandiseAmountMinorUnits, rma.eligibleMerchandiseAmountCurrency)}</Row>
                <Row label="Personalized/altered?">
                  {rma.isPersonalizedOrAltered ? "Yes" : "No"}
                  {rma.isPersonalizedOrAltered ? ` (product-specific override recorded: ${rma.hasProductSpecificReturnOverride ? "yes" : "no"})` : ""}
                </Row>
                {rma.denialReason ? <Row label="Denial reason">{rma.denialReason}</Row> : null}
              </dl>
            </section>

            {rma.approvedAt ? (
              <section style={sectionStyle}>
                <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Approval &amp; return shipping</h2>
                <dl style={{ margin: 0, fontSize: "0.875rem", display: "grid", rowGap: "0.35rem" }}>
                  <Row label="Approved at">{formatTimestamp(rma.approvedAt)}</Row>
                  <Row label="Receive-by deadline">{rma.receiveByDeadline?.slice(0, 10) ?? "(none)"}</Row>
                  <Row label="Carrier">{rma.returnTrackingCarrier ?? "(not recorded)"}</Row>
                  <Row label="Tracking number">{rma.returnTrackingNumber ?? "(not recorded)"}</Row>
                  <Row label="Insurance reference">{rma.returnInsuranceReference ?? "(not recorded)"}</Row>
                  <Row label="Insured value">{formatMoney(rma.returnInsuredValueMinorUnits, rma.returnInsuredValueCurrency)}</Row>
                </dl>
                {canRecordReturnShipping(rma) ? (
                  <Form method="post" style={{ marginTop: "0.75rem" }}>
                    <input type="hidden" name="intent" value="record_return_shipping" />
                    <Field id="carrier" name="carrier" label="Carrier" defaultValue={rma.returnTrackingCarrier ?? ""} />
                    <Field id="trackingNumber" name="trackingNumber" label="Tracking number" defaultValue={rma.returnTrackingNumber ?? ""} />
                    <Field id="insuranceReference" name="insuranceReference" label="Insurance reference" defaultValue={rma.returnInsuranceReference ?? ""} />
                    <Field id="insuredValueAmount" name="insuredValueAmount" label="Insured value (dollars and cents, optional)" />
                    <Field id="insuredValueCurrency" name="insuredValueCurrency" label="Currency" defaultValue="USD" />
                    <button type="submit" disabled={busy}>Save shipping evidence</button>
                  </Form>
                ) : null}
              </section>
            ) : null}

            {rma.receivedAt ? (
              <section style={sectionStyle}>
                <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Receipt &amp; inspection</h2>
                <dl style={{ margin: 0, fontSize: "0.875rem", display: "grid", rowGap: "0.35rem" }}>
                  <Row label="Received at">{formatTimestamp(rma.receivedAt)}</Row>
                  <Row label="Package condition">{rma.packageCondition ?? "(not recorded)"}</Row>
                  <Row label="Item condition">{rma.itemCondition ?? "(not recorded)"}</Row>
                  <Row label="Inspection notes">{rma.inspectionNotes ?? "(not recorded)"}</Row>
                </dl>
              </section>
            ) : null}

            {rma.conditionDecision ? (
              <section style={sectionStyle}>
                <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Condition decision</h2>
                <dl style={{ margin: 0, fontSize: "0.875rem", display: "grid", rowGap: "0.35rem" }}>
                  <Row label="Decision">{rma.conditionDecision}</Row>
                  <Row label="Reason">{rma.conditionDecisionReason ?? "(none)"}</Row>
                </dl>
              </section>
            ) : null}

            {rma.remedy ? (
              <section style={sectionStyle}>
                <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Remedy</h2>
                <dl style={{ margin: 0, fontSize: "0.875rem", display: "grid", rowGap: "0.35rem" }}>
                  <Row label="Kind">{rma.remedy.kind}</Row>
                  <Row label="Status">{rma.remedy.status}</Row>
                  <Row label="Merchandise amount">{formatMoney(rma.remedy.merchandiseAmountMinorUnits, rma.remedy.currency)}</Row>
                  <Row label="Restocking fee">{formatMoney(rma.remedy.restockingFeeMinorUnits, rma.remedy.currency)}</Row>
                  <Row label="Shopify tax adjustment">{formatMoney(rma.remedy.shopifyTaxAdjustmentMinorUnits, rma.remedy.currency)}</Row>
                  <Row label="Actual refund/credit">{formatMoney(rma.remedy.actualRefundOrCreditMinorUnits, rma.remedy.currency)}</Row>
                  {rma.remedy.processorReference ? <Row label="Processor reference">{rma.remedy.processorReference}</Row> : null}
                  {rma.remedy.failureReason ? <Row label="Failure reason">{rma.remedy.failureReason}</Row> : null}
                  {rma.remedy.staffReviewReason ? <Row label="Staff review reason">{rma.remedy.staffReviewReason}</Row> : null}
                </dl>

                {canExecuteRemedy(rma) ? (
                  <Form method="post" style={{ marginTop: "0.75rem" }}>
                    <input type="hidden" name="intent" value="execute_remedy" />
                    <p style={{ margin: "0 0 0.5rem", fontSize: "0.8rem", color: "#555" }}>
                      Attempts to issue this remedy automatically through Shopify (refund or Store Credit). A
                      late-window 50% restocking-fee refund always routes to staff review — Shopify has no way to
                      compute tax on a partial merchandise value, and CaratForUs does not invent one.
                    </p>
                    <button type="submit" disabled={busy}>Execute remedy via Shopify</button>
                  </Form>
                ) : null}

                {canManuallyUpdateRemedyStatus(rma) ? (
                  <Form method="post" style={{ marginTop: "0.75rem", borderTop: "1px solid #eee", paddingTop: "0.75rem" }}>
                    <input type="hidden" name="intent" value="update_remedy_status" />
                    <p style={{ margin: "0 0 0.5rem", fontSize: "0.8rem", color: "#555" }}>
                      Manual entry — use after processing a remedy directly in Shopify Admin (e.g. the
                      restocking-fee case above), or to record a definitive outcome.
                    </p>
                    <label htmlFor="status" style={labelStyle}>Remedy status</label>
                    <select id="status" name="status" style={inputStyle}>
                      <option value="processing">Processing</option>
                      <option value="issued">Issued</option>
                      <option value="failed">Failed</option>
                      <option value="staff_review_required">Staff review required</option>
                    </select>
                    <Field id="processorReference" name="processorReference" label="Processor reference (Shopify refund/credit id)" />
                    <Field id="actualRefundOrCreditAmount" name="actualRefundOrCreditAmount" label="Actual refund/credit amount (dollars and cents — issued only)" />
                    <Field id="actualRefundOrCreditCurrency" name="actualRefundOrCreditCurrency" label="Currency" defaultValue="USD" />
                    <Field id="shopifyTaxAdjustmentAmount" name="shopifyTaxAdjustmentAmount" label="Shopify tax adjustment (dollars and cents, optional — issued only)" />
                    <Field id="shopifyTaxAdjustmentCurrency" name="shopifyTaxAdjustmentCurrency" label="Currency" defaultValue="USD" />
                    <Field id="failureReason" name="failureReason" label="Failure reason (if failed)" />
                    <Field id="staffReviewReason" name="staffReviewReason" label="Staff review reason (if staff review required)" />
                    <button type="submit" disabled={busy}>Update remedy status</button>
                  </Form>
                ) : null}
              </section>
            ) : null}

            <section style={sectionStyle}>
              <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem" }}>Actions</h2>

              {canApproveOrDeny(rma.status) ? (
                <>
                  <Form method="post" style={{ marginBottom: "0.75rem" }}>
                    <input type="hidden" name="intent" value="approve" />
                    <Field id="approveReason" name="reason" label="Note (optional)" />
                    <button type="submit" disabled={busy}>Approve</button>
                  </Form>
                  <Form method="post" style={{ marginBottom: "0.75rem" }}>
                    <input type="hidden" name="intent" value="deny" />
                    <Field id="denyReason" name="reason" label="Denial reason" required />
                    <button type="submit" disabled={busy}>Deny</button>
                  </Form>
                </>
              ) : null}

              {canMarkReturnShipped(rma.status) ? (
                <Form method="post" style={{ marginBottom: "0.75rem" }}>
                  <input type="hidden" name="intent" value="mark_return_shipped" />
                  <button type="submit" disabled={busy}>Mark return shipped</button>
                </Form>
              ) : null}

              {canRecordReceipt(rma.status) ? (
                <Form method="post" style={{ marginBottom: "0.75rem" }}>
                  <input type="hidden" name="intent" value="record_receipt" />
                  <Field id="packageCondition" name="packageCondition" label="Package condition" />
                  <Field id="itemCondition" name="itemCondition" label="Item condition" />
                  <TextAreaField id="inspectionNotes" name="inspectionNotes" label="Inspection notes" />
                  <button type="submit" disabled={busy}>Record receipt</button>
                </Form>
              ) : null}

              {canExpire(rma.status) ? (
                <Form method="post" style={{ marginBottom: "0.75rem" }}>
                  <input type="hidden" name="intent" value="expire" />
                  <button type="submit" disabled={busy}>Mark expired (receive-by deadline passed)</button>
                </Form>
              ) : null}

              {canDecideCondition(rma.status) ? (
                <Form method="post" style={{ marginBottom: "0.75rem" }}>
                  <input type="hidden" name="intent" value="decide_condition" />
                  <fieldset style={{ border: "none", padding: 0, margin: "0 0 0.6rem" }}>
                    <legend style={labelStyle}>Condition decision — no default; an explicit choice is required</legend>
                    <label style={{ display: "block", fontSize: "0.875rem", marginBottom: "0.25rem" }}>
                      <input type="radio" name="decision" value="accepted" required /> Accepted
                    </label>
                    <label style={{ display: "block", fontSize: "0.875rem" }}>
                      <input type="radio" name="decision" value="rejected" required /> Rejected
                    </label>
                  </fieldset>
                  <Field id="conditionReason" name="reason" label="Reason (required if rejecting)" />
                  <button type="submit" disabled={busy}>Record condition decision</button>
                </Form>
              ) : null}

              {canCreateRemedy(rma) ? (
                <Form method="post" style={{ marginBottom: "0.75rem" }}>
                  <input type="hidden" name="intent" value="create_remedy" />
                  <p style={{ margin: "0 0 0.5rem", fontSize: "0.8rem", color: "#555" }}>
                    Computes the merchandise-only remedy from the customer&apos;s own choice ({RMA_REMEDY_KINDS.join(" or ")} in
                    the late window; a 100% refund in the standard window) and begins the remedy.
                  </p>
                  <button type="submit" disabled={busy}>Compute remedy &amp; begin</button>
                </Form>
              ) : null}

              {canResolve(rma.status) ? (
                <Form method="post" style={{ marginBottom: "0.75rem" }}>
                  <input type="hidden" name="intent" value="resolve" />
                  <button type="submit" disabled={busy}>Mark resolved</button>
                </Form>
              ) : null}

              {canClose(rma.status) ? (
                <Form method="post" style={{ marginBottom: "0.75rem" }}>
                  <input type="hidden" name="intent" value="close" />
                  <button type="submit" disabled={busy}>Close RMA</button>
                </Form>
              ) : null}

              {!canApproveOrDeny(rma.status) &&
              !canMarkReturnShipped(rma.status) &&
              !canRecordReceipt(rma.status) &&
              !canExpire(rma.status) &&
              !canDecideCondition(rma.status) &&
              !canCreateRemedy(rma) &&
              !canExecuteRemedy(rma) &&
              !canManuallyUpdateRemedyStatus(rma) &&
              !canResolve(rma.status) &&
              !canClose(rma.status) ? (
                <p style={{ margin: 0, fontSize: "0.875rem", color: "#555" }}>No further staff action is available for this RMA in its current state.</p>
              ) : null}
            </section>

            <section style={sectionStyle}>
              <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>History</h2>
              {rma.events.length === 0 ? (
                <p style={{ margin: 0, fontSize: "0.875rem", color: "#555" }}>No events recorded.</p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: "1.25rem", fontSize: "0.8rem" }}>
                  {rma.events.map((event) => (
                    <li key={event.id} style={{ marginBottom: "0.35rem" }}>
                      {formatTimestamp(event.createdAt)} — {event.fromStatus ?? "(new)"} &rarr; {event.toStatus} — {event.actorType}
                      {event.actorRef ? ` (${event.actorRef})` : ""}
                      {event.reason ? `: ${event.reason}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
    </AppProvider>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt style={{ display: "inline", fontWeight: 600 }}>{label}: </dt>
      <dd style={{ display: "inline", margin: 0 }}>{children}</dd>
    </div>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
