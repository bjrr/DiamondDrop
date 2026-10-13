import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation, useRouteError } from "react-router";
import type { CSSProperties, ReactNode } from "react";

import { WARRANTY_REMEDY_KINDS, type WarrantyRemedyKind } from "~/domain/warranty/remedy";
import {
  authorizeWarrantyClaimForInspection,
  beginWarrantyClaimRemedy,
  closeWarrantyClaim,
  createWarrantyClaimRemedy,
  decideWarrantyClaimCoverage,
  getWarrantyClaimForStaffReview,
  markWarrantyClaimInTransit,
  recordWarrantyClaimInboundShippingEvidence,
  recordWarrantyClaimReceipt,
  requestMoreInformation,
  resolveWarrantyClaim,
  resumeWarrantyClaimAfterMoreInformation,
  staffRecordLocalJewellerAuthorization,
  staffUpdateLocalJewellerAuthorizationCompletion,
  startWarrantyClaimReview,
  updateWarrantyClaimRemedyStatus,
  WarrantyClaimActorRequiredError,
  IllegalWarrantyClaimTransitionError,
  InvalidWarrantyRemedyMoneyError,
  WarrantyClaimNotCoveredError,
  WarrantyClaimNotFoundError,
  WarrantyClaimNotAuthorizedForShippingError,
  WarrantyClaimRemedyAlreadyExistsError,
  WarrantyClaimLocalJewellerAuthorizationAlreadyExistsError,
  type WarrantyClaimStaffView,
} from "~/db/repositories/warrantyClaimRepository.server";
import { DEFAULT_ROUNDING_RULE_ID } from "~/domain/money/rounding";
import { Money } from "~/domain/money/money";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { authenticate } from "~/shopify.server";

/**
 * GET/POST /app/warranty-claims/:id — the staff warranty claim detail/review
 * surface (Slice 5 task 5-4, `docs/WARRANTY-CLAIMS.md` §5-§8,
 * `docs/specs/SLICE-5-WARRANTY-CLAIMS.md` criteria 157-170).
 *
 * CALLS THE REPOSITORY; DOES NOT RE-DERIVE ANYTHING. Every mutation below is
 * a thin wrapper around a task 5-2 repository function, which itself never
 * writes a status change without first asking `decideWarrantyClaimTransition`
 * (the pure domain rule). This route's only jobs are: (1) attribute every
 * write to the AUTHENTICATED Shopify staff identity, exactly like
 * `app.bank-payments.$id.tsx`'s D23 discipline — never a typed name, never a
 * form field; and (2) not OFFER a control the system will refuse, which is
 * a UI discipline the repository/database cannot enforce on its own
 * (criterion 159 — see `canDecideCoverage` below).
 *
 * A DEFAULT EXPORT WITH AN ACTION — same shape as `app.bank-payments.$id.tsx`
 * and `app.luxury-steals._index.tsx`. See this repo's
 * `csrfResourceRouteFence.test.ts` `EXEMPT_UI_ACTION_ROUTES` for the reasoned
 * exemption entry added for this route: Shopify Admin iframes this route at
 * the app's own host, so a form submitted from within it is same-origin by
 * construction, unlike an App Proxy/webhook/cron caller.
 *
 * NEVER SHOWS cost, margin, landed cost or any pricing-profile data — there
 * is none on `WarrantyClaim`/`WarrantyClaimRemedy`/
 * `WarrantyClaimLocalJewellerAuthorization` to begin with, so nothing needs
 * excluding by hand; `buildClaimView` below is still an explicit field list
 * (not a raw spread of the Prisma row) so that stays legible rather than
 * accidental.
 *
 * CRITERION 165 — THIS IS THE INTERNAL SURFACE §7 REQUIRES. The
 * local-jeweller section is deliberately present here (labelled INTERNAL
 * ONLY in the UI itself, not merely in a comment) — this is staff-only,
 * behind `authenticate.admin`, and is not `apps.carat.warranty-claim.tsx`
 * (task 5-3's customer-facing intake/status route), which has no import of
 * this route, this file's view model, or any local-jeweller repository
 * function.
 */

// ---------------------------------------------------------------------------
// View model — an explicit field list, never a raw spread of a Prisma row.
// BigInt/Date are stringified at this boundary (BigInt does not survive
// `Response.json`/`useLoaderData` — see schema.prisma's own money-column
// convention comment).
// ---------------------------------------------------------------------------

interface WarrantyClaimEventView {
  readonly id: string;
  readonly fromStatus: string | null;
  readonly toStatus: string;
  readonly actorType: string;
  readonly actorRef: string | null;
  readonly reason: string | null;
  readonly createdAt: string;
}

interface WarrantyClaimUploadView {
  readonly id: string;
  readonly kind: string;
  readonly contentType: string;
  readonly sizeBytes: string;
  readonly checksum: string;
  readonly uploadedAt: string;
}

interface LocalJewellerAuthorizationView {
  readonly id: string;
  readonly jewellerName: string;
  readonly jewellerContact: string | null;
  readonly authorizedScope: string;
  readonly authorizedCostMinorUnits: string;
  readonly authorizedCostCurrency: string;
  readonly authorizedByActorRef: string;
  readonly authorizedAt: string;
  readonly communicationsLog: string | null;
  readonly invoiceReference: string | null;
  readonly invoiceAmountMinorUnits: string | null;
  readonly invoiceAmountCurrency: string | null;
  readonly paymentReference: string | null;
  readonly reimbursementReference: string | null;
  readonly completionEvidence: string | null;
  readonly completedAt: string | null;
}

interface RemedyView {
  readonly id: string;
  readonly kind: string;
  readonly status: string;
  readonly refundAmountMinorUnits: string | null;
  readonly currency: string | null;
  readonly processorReference: string | null;
  readonly failureReason: string | null;
  readonly decidedByActorRef: string;
  readonly decidedAt: string;
  readonly completedAt: string | null;
  readonly localJewellerAuthorization: LocalJewellerAuthorizationView | null;
}

interface ClaimView {
  readonly id: string;
  readonly claimReference: string;
  readonly orderRef: string;
  readonly lineRef: string;
  readonly customerRef: string | null;
  readonly itemConfigurationDescription: string;
  readonly purchaserName: string;
  readonly purchaserEmail: string;
  readonly purchaseDate: string | null;
  readonly deliveryDate: string | null;
  readonly issueFirstNoticedDate: string | null;
  readonly problemDescription: string;
  readonly hadImpactOrDamageEvent: boolean;
  readonly impactOrDamageDetails: string | null;
  readonly wasAlteredAfterDelivery: boolean;
  readonly alterationDetails: string | null;
  readonly certificateOrSerialIdentifier: string | null;
  readonly submittedAt: string;
  readonly status: string;
  readonly pausedFromStatus: string | null;
  readonly authorizedAt: string | null;
  readonly authorizedByActorRef: string | null;
  readonly inboundTrackingCarrier: string | null;
  readonly inboundTrackingNumber: string | null;
  readonly inboundInsuranceReference: string | null;
  readonly inboundInsuredValueMinorUnits: string | null;
  readonly inboundInsuredValueCurrency: string | null;
  readonly receivedAt: string | null;
  readonly packageCondition: string | null;
  readonly itemCondition: string | null;
  readonly inspectionNotes: string | null;
  readonly inspectedByActorRef: string | null;
  readonly coverageDecision: string | null;
  readonly coverageDecisionReason: string | null;
  readonly coverageDecidedAt: string | null;
  readonly coverageDecidedByActorRef: string | null;
  readonly resolvedAt: string | null;
  readonly closedAt: string | null;
  readonly events: readonly WarrantyClaimEventView[];
  readonly uploads: readonly WarrantyClaimUploadView[];
  readonly remedy: RemedyView | null;
}

function iso(date: Date | null | undefined): string | null {
  return date ? date.toISOString() : null;
}

function buildClaimView(claim: WarrantyClaimStaffView): ClaimView {
  return {
    id: claim.id,
    claimReference: claim.claimReference,
    orderRef: claim.orderRef,
    lineRef: claim.lineRef,
    customerRef: claim.customerRef,
    itemConfigurationDescription: claim.itemConfigurationDescription,
    purchaserName: claim.purchaserName,
    purchaserEmail: claim.purchaserEmail,
    purchaseDate: iso(claim.purchaseDate),
    deliveryDate: iso(claim.deliveryDate),
    issueFirstNoticedDate: iso(claim.issueFirstNoticedDate),
    problemDescription: claim.problemDescription,
    hadImpactOrDamageEvent: claim.hadImpactOrDamageEvent,
    impactOrDamageDetails: claim.impactOrDamageDetails,
    wasAlteredAfterDelivery: claim.wasAlteredAfterDelivery,
    alterationDetails: claim.alterationDetails,
    certificateOrSerialIdentifier: claim.certificateOrSerialIdentifier,
    submittedAt: claim.submittedAt.toISOString(),
    status: claim.status,
    pausedFromStatus: claim.pausedFromStatus,
    authorizedAt: iso(claim.authorizedAt),
    authorizedByActorRef: claim.authorizedByActorRef,
    inboundTrackingCarrier: claim.inboundTrackingCarrier,
    inboundTrackingNumber: claim.inboundTrackingNumber,
    inboundInsuranceReference: claim.inboundInsuranceReference,
    inboundInsuredValueMinorUnits: claim.inboundInsuredValueMinorUnits?.toString() ?? null,
    inboundInsuredValueCurrency: claim.inboundInsuredValueCurrency,
    receivedAt: iso(claim.receivedAt),
    packageCondition: claim.packageCondition,
    itemCondition: claim.itemCondition,
    inspectionNotes: claim.inspectionNotes,
    inspectedByActorRef: claim.inspectedByActorRef,
    coverageDecision: claim.coverageDecision,
    coverageDecisionReason: claim.coverageDecisionReason,
    coverageDecidedAt: iso(claim.coverageDecidedAt),
    coverageDecidedByActorRef: claim.coverageDecidedByActorRef,
    resolvedAt: iso(claim.resolvedAt),
    closedAt: iso(claim.closedAt),
    events: claim.events.map((event) => ({
      id: event.id,
      fromStatus: event.fromStatus,
      toStatus: event.toStatus,
      actorType: event.actorType,
      actorRef: event.actorRef,
      reason: event.reason,
      createdAt: event.createdAt.toISOString(),
    })),
    uploads: claim.uploads.map((upload) => ({
      id: upload.id,
      kind: upload.kind,
      contentType: upload.contentType,
      sizeBytes: upload.sizeBytes.toString(),
      checksum: upload.checksum,
      uploadedAt: upload.uploadedAt.toISOString(),
    })),
    remedy: claim.remedy
      ? {
          id: claim.remedy.id,
          kind: claim.remedy.kind,
          status: claim.remedy.status,
          refundAmountMinorUnits: claim.remedy.refundAmountMinorUnits?.toString() ?? null,
          currency: claim.remedy.currency,
          processorReference: claim.remedy.processorReference,
          failureReason: claim.remedy.failureReason,
          decidedByActorRef: claim.remedy.decidedByActorRef,
          decidedAt: claim.remedy.decidedAt.toISOString(),
          completedAt: iso(claim.remedy.completedAt),
          localJewellerAuthorization: claim.remedy.localJewellerAuthorization
            ? {
                id: claim.remedy.localJewellerAuthorization.id,
                jewellerName: claim.remedy.localJewellerAuthorization.jewellerName,
                jewellerContact: claim.remedy.localJewellerAuthorization.jewellerContact,
                authorizedScope: claim.remedy.localJewellerAuthorization.authorizedScope,
                authorizedCostMinorUnits: claim.remedy.localJewellerAuthorization.authorizedCostMinorUnits.toString(),
                authorizedCostCurrency: claim.remedy.localJewellerAuthorization.authorizedCostCurrency,
                authorizedByActorRef: claim.remedy.localJewellerAuthorization.authorizedByActorRef,
                authorizedAt: claim.remedy.localJewellerAuthorization.authorizedAt.toISOString(),
                communicationsLog: claim.remedy.localJewellerAuthorization.communicationsLog,
                invoiceReference: claim.remedy.localJewellerAuthorization.invoiceReference,
                invoiceAmountMinorUnits:
                  claim.remedy.localJewellerAuthorization.invoiceAmountMinorUnits?.toString() ?? null,
                invoiceAmountCurrency: claim.remedy.localJewellerAuthorization.invoiceAmountCurrency,
                paymentReference: claim.remedy.localJewellerAuthorization.paymentReference,
                reimbursementReference: claim.remedy.localJewellerAuthorization.reimbursementReference,
                completionEvidence: claim.remedy.localJewellerAuthorization.completionEvidence,
                completedAt: iso(claim.remedy.localJewellerAuthorization.completedAt),
              }
            : null,
        }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Which controls the UI may offer, given the claim's CURRENT status. This is
// the criterion-159 discipline: the repository and the database both already
// refuse an illegal transition, but a control that is merely present invites
// a staff member to try it and reasonably read its presence as permission.
// Every function here is a plain status comparison, not a re-derivation of
// the transition table itself.
// ---------------------------------------------------------------------------

function canStartReview(status: string): boolean {
  return status === "submitted";
}
function canRequestMoreInformation(status: string): boolean {
  return status === "under_review" || status === "received_inspection_pending";
}
function canResume(status: string): boolean {
  return status === "more_information_requested";
}
function canAuthorizeForInspection(status: string): boolean {
  return status === "under_review";
}
function canMarkInTransit(status: string): boolean {
  return status === "authorized_for_inspection";
}
function canRecordReceipt(status: string): boolean {
  return status === "in_transit_to_carat_for_us";
}
/** Criterion 159 — the control this route must never offer before receipt. */
function canDecideCoverage(status: string): boolean {
  return status === "received_inspection_pending";
}
function canSelectRemedy(view: ClaimView): boolean {
  return view.status === "approved_covered" && view.remedy === null;
}
function canUpdateRemedyStatus(view: ClaimView): boolean {
  return view.remedy !== null && view.status === "remedy_in_progress";
}
function canResolve(status: string): boolean {
  return status === "remedy_in_progress" || status === "denied_not_covered";
}
function canClose(status: string): boolean {
  return status === "resolved";
}
function canRecordInboundShipping(view: ClaimView): boolean {
  return view.authorizedAt !== null;
}
/** §7 — the local-jeweller path is only offered for a repair remedy, in progress or already recorded. */
function canManageLocalJeweller(view: ClaimView): boolean {
  return view.remedy !== null && view.remedy.kind === "repair";
}

// ---------------------------------------------------------------------------
// Staff identity — D23, exactly the discipline `app.bank-payments.$id.tsx`
// and `app.luxury-steals._index.tsx` already use. `staff:<Shopify user id>`
// (never email, which can change) — same format as
// `app.luxury-steals._index.tsx`'s `resolveStaffTrigger`.
// ---------------------------------------------------------------------------

function resolveStaffActorRef(session: Awaited<ReturnType<typeof authenticate.admin>>["session"]): string | null {
  const associatedUser = session.onlineAccessInfo?.associated_user;
  if (!associatedUser) return null;
  return `staff:${associatedUser.id}`;
}

// ---------------------------------------------------------------------------
// Money — dollars-and-cents text, exactly like
// `verification.ts`'s `MAJOR_UNIT_AMOUNT_PATTERN`/`parseVerificationSubmission`
// discipline: rejected, never rounded, if not exactly representable.
// ---------------------------------------------------------------------------

const MAJOR_UNIT_AMOUNT_PATTERN = /^\d+(\.\d{1,2})?$/;
const CURRENCY_PATTERN = /^[A-Z]{3}$/;

interface ParsedMoney {
  readonly minorUnits: bigint;
  readonly currency: string;
}

function parseMoneyField(amountText: string, currencyText: string, fieldLabel: string): ParsedMoney | { error: string } {
  const amount = amountText.trim();
  const currency = currencyText.trim().toUpperCase();
  if (amount === "") return { error: `${fieldLabel} amount is required.` };
  if (!MAJOR_UNIT_AMOUNT_PATTERN.test(amount)) {
    return {
      error: `${fieldLabel} amount must be dollars and cents, at most two decimal places, no symbol — e.g. 150 or 150.00.`,
    };
  }
  if (currency === "" || !CURRENCY_PATTERN.test(currency)) {
    return { error: `${fieldLabel} currency must be a 3-letter ISO 4217 code (e.g. USD).` };
  }
  const minorUnits = Money.fromDecimalMajorUnits(amount, currency, DEFAULT_ROUNDING_RULE_ID).amountMinorUnits;
  if (minorUnits <= 0n) return { error: `${fieldLabel} amount must be greater than zero.` };
  return { minorUnits, currency };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

interface LoaderData {
  apiKey: string;
  shop: string;
  claim: ClaimView | null;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const id = params.id;
  if (!id) throw new Response("Missing warranty claim id.", { status: 400 });

  const claim = await getWarrantyClaimForStaffReview(id);
  return {
    apiKey: getEnv().SHOPIFY_API_KEY ?? "",
    shop: session.shop,
    claim: claim ? buildClaimView(claim) : null,
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

export async function action({ request, params }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const id = params.id;
  if (!id) return Response.json(fail("Missing warranty claim id."), { status: 400 });
  if (request.method !== "POST") return Response.json(fail("Method not allowed."), { status: 405 });

  const staffActorRef = resolveStaffActorRef(session);
  if (!staffActorRef) {
    logger.error("warranty_claims.no_online_user", { warrantyClaimId: id });
    return Response.json(
      fail(
        "This request could not be attributed to a signed-in Shopify staff member (no online session). " +
          "Reload the page and try again."
      ),
      { status: 401 }
    );
  }
  const actor = { actorType: "staff" as const, actorRef: staffActorRef };

  const formData = await request.formData();
  const intent = stringField(formData, "intent");

  try {
    switch (intent) {
      case "start_review": {
        await startWarrantyClaimReview(id, actor);
        return Response.json(ok());
      }

      case "request_more_information": {
        const reason = stringField(formData, "reason").trim();
        if (reason === "") return Response.json(fail("A reason is required to request more information."), { status: 400 });
        await requestMoreInformation(id, actor, reason);
        return Response.json(ok());
      }

      case "resume_after_more_information": {
        await resumeWarrantyClaimAfterMoreInformation(id, actor);
        return Response.json(ok());
      }

      case "authorize_for_inspection": {
        // Criterion 157 — staffActorRef is the AUTHENTICATED identity above,
        // never a form field. The optional "reason" here is a note, not an
        // identity substitute.
        await authorizeWarrantyClaimForInspection(id, staffActorRef, {
          reason: optionalStringField(formData, "reason"),
        });
        return Response.json(ok());
      }

      case "mark_in_transit": {
        await markWarrantyClaimInTransit(id, actor);
        return Response.json(ok());
      }

      case "record_receipt": {
        await recordWarrantyClaimReceipt(id, {
          packageCondition: optionalStringField(formData, "packageCondition"),
          itemCondition: optionalStringField(formData, "itemCondition"),
          inspectionNotes: optionalStringField(formData, "inspectionNotes"),
          inspectedByActorRef: staffActorRef,
        });
        return Response.json(ok());
      }

      case "record_inbound_shipping": {
        const insuredValueAmount = stringField(formData, "insuredValueAmount").trim();
        let insuredValueMinorUnits: bigint | undefined;
        let insuredValueCurrency: string | undefined;
        if (insuredValueAmount !== "") {
          const parsed = parseMoneyField(insuredValueAmount, stringField(formData, "insuredValueCurrency"), "Insured value");
          if ("error" in parsed) return Response.json(fail(parsed.error), { status: 400 });
          insuredValueMinorUnits = parsed.minorUnits;
          insuredValueCurrency = parsed.currency;
        }
        await recordWarrantyClaimInboundShippingEvidence(
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

      case "decide_coverage": {
        const decisionText = stringField(formData, "decision");
        if (decisionText !== "covered" && decisionText !== "not_covered") {
          return Response.json(fail("A coverage decision (covered or not covered) is required."), { status: 400 });
        }
        const reason = optionalStringField(formData, "reason");
        // Criterion 160 — checked here too (not only inside
        // decideWarrantyClaimTransition) so the field-level error is clear
        // rather than a generic transition refusal.
        if (decisionText === "not_covered" && !reason) {
          return Response.json(fail("A reason is required to deny a claim as not covered."), { status: 400 });
        }
        await decideWarrantyClaimCoverage(id, { decision: decisionText, reason, decidedByActorRef: staffActorRef });
        return Response.json(ok());
      }

      case "record_remedy": {
        // Criterion 162 — kind has no default anywhere in this form; an
        // absent/blank value is refused rather than assumed.
        const kindText = stringField(formData, "kind");
        if (!(WARRANTY_REMEDY_KINDS as readonly string[]).includes(kindText)) {
          return Response.json(fail("A remedy (repair, replacement, refund, or other) must be selected."), { status: 400 });
        }
        const kind = kindText as WarrantyRemedyKind;

        let refundAmountMinorUnits: bigint | undefined;
        let currency: string | undefined;
        if (kind === "refund") {
          const parsed = parseMoneyField(
            stringField(formData, "refundAmount"),
            stringField(formData, "refundCurrency"),
            "Refund"
          );
          if ("error" in parsed) return Response.json(fail(parsed.error), { status: 400 });
          refundAmountMinorUnits = parsed.minorUnits;
          currency = parsed.currency;
        }

        // Two repository calls, one staff action: "select the remedy" both
        // records WHAT was decided (createWarrantyClaimRemedy) and moves the
        // claim into remedy_in_progress (beginWarrantyClaimRemedy). Neither
        // function's own rules are re-derived here — this is orchestration
        // of two already-guarded writes, not a new domain rule.
        await createWarrantyClaimRemedy({
          claimId: id,
          kind,
          refundAmountMinorUnits,
          currency,
          decidedByActorRef: staffActorRef,
        });
        await beginWarrantyClaimRemedy(id, actor);
        return Response.json(ok());
      }

      case "update_remedy_status": {
        const statusText = stringField(formData, "status");
        if (!["pending", "processing", "completed", "failed"].includes(statusText)) {
          return Response.json(fail("A valid remedy status is required."), { status: 400 });
        }
        await updateWarrantyClaimRemedyStatus({
          claimId: id,
          status: statusText as "pending" | "processing" | "completed" | "failed",
          processorReference: optionalStringField(formData, "processorReference"),
          failureReason: optionalStringField(formData, "failureReason"),
        });
        return Response.json(ok());
      }

      case "resolve": {
        await resolveWarrantyClaim(id, actor);
        return Response.json(ok());
      }

      case "close": {
        await closeWarrantyClaim(id, actor);
        return Response.json(ok());
      }

      case "record_local_jeweller_authorization": {
        const remedyId = stringField(formData, "remedyId").trim();
        const jewellerName = stringField(formData, "jewellerName").trim();
        const authorizedScope = stringField(formData, "authorizedScope").trim();
        if (!remedyId || !jewellerName || !authorizedScope) {
          return Response.json(fail("Jeweller name, remedy, and authorized scope are all required."), { status: 400 });
        }
        const costParsed = parseMoneyField(
          stringField(formData, "authorizedCostAmount"),
          stringField(formData, "authorizedCostCurrency"),
          "Authorized cost"
        );
        if ("error" in costParsed) return Response.json(fail(costParsed.error), { status: 400 });

        await staffRecordLocalJewellerAuthorization({
          remedyId,
          jewellerName,
          jewellerContact: optionalStringField(formData, "jewellerContact"),
          authorizedScope,
          authorizedCostMinorUnits: costParsed.minorUnits,
          authorizedCostCurrency: costParsed.currency,
          authorizedByActorRef: staffActorRef,
        });
        return Response.json(ok());
      }

      case "update_local_jeweller_completion": {
        const remedyId = stringField(formData, "remedyId").trim();
        if (!remedyId) return Response.json(fail("Missing remedy id."), { status: 400 });

        const invoiceAmount = stringField(formData, "invoiceAmount").trim();
        let invoiceAmountMinorUnits: bigint | undefined;
        let invoiceAmountCurrency: string | undefined;
        if (invoiceAmount !== "") {
          const parsed = parseMoneyField(invoiceAmount, stringField(formData, "invoiceCurrency"), "Invoice");
          if ("error" in parsed) return Response.json(fail(parsed.error), { status: 400 });
          invoiceAmountMinorUnits = parsed.minorUnits;
          invoiceAmountCurrency = parsed.currency;
        }

        await staffUpdateLocalJewellerAuthorizationCompletion({
          remedyId,
          communicationsLog: optionalStringField(formData, "communicationsLog"),
          invoiceReference: optionalStringField(formData, "invoiceReference"),
          invoiceAmountMinorUnits,
          invoiceAmountCurrency,
          paymentReference: optionalStringField(formData, "paymentReference"),
          // Criterion 167 — only ever set here, by this explicit staff call,
          // never a side effect of anything else on this route.
          reimbursementReference: optionalStringField(formData, "reimbursementReference"),
          completionEvidence: optionalStringField(formData, "completionEvidence"),
        });
        return Response.json(ok());
      }

      default:
        return Response.json(fail(`Unrecognized action: ${intent}`), { status: 400 });
    }
  } catch (error) {
    if (error instanceof WarrantyClaimNotFoundError) {
      return Response.json(fail("That warranty claim no longer exists."), { status: 404 });
    }
    if (error instanceof IllegalWarrantyClaimTransitionError) {
      // Should be unreachable through this UI (see canX() gating above) —
      // still surfaced plainly rather than as a 500, since a stale page
      // (two staff members, two tabs) can still reach it legitimately.
      return Response.json(fail(error.message), { status: 409 });
    }
    if (error instanceof WarrantyClaimActorRequiredError) {
      return Response.json(fail(error.message), { status: 401 });
    }
    if (error instanceof WarrantyClaimNotAuthorizedForShippingError) {
      return Response.json(fail(error.message), { status: 409 });
    }
    if (error instanceof WarrantyClaimNotCoveredError) {
      return Response.json(fail(error.message), { status: 409 });
    }
    if (error instanceof WarrantyClaimRemedyAlreadyExistsError) {
      return Response.json(fail(error.message), { status: 409 });
    }
    if (error instanceof WarrantyClaimLocalJewellerAuthorizationAlreadyExistsError) {
      return Response.json(fail(error.message), { status: 409 });
    }
    if (error instanceof InvalidWarrantyRemedyMoneyError) {
      return Response.json(fail(error.message), { status: 400 });
    }
    logger.error("warranty_claims.action_failed", {
      warrantyClaimId: id,
      intent,
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function formatTimestamp(iso8601: string): string {
  return `${iso8601.replace("T", " ").slice(0, 16)} UTC`;
}

/** Whole minor units as a human dollar-and-cents string — display only. Same string-manipulation discipline as `app.bank-payments.$id.tsx`'s identical helper (no Number(), no toLocaleString). */
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

const sectionStyle: CSSProperties = {
  marginBottom: "1.5rem",
  border: "1px solid #ddd",
  borderRadius: "4px",
  padding: "1rem",
};
const labelStyle: CSSProperties = { display: "block", fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.25rem" };
const inputStyle: CSSProperties = { display: "block", padding: "0.4rem 0.6rem", width: "100%", maxWidth: "24rem", marginBottom: "0.6rem" };

function Field({
  id,
  name,
  label,
  defaultValue,
  required,
  maxLength,
}: {
  id: string;
  name: string;
  label: string;
  defaultValue?: string;
  required?: boolean;
  maxLength?: number;
}) {
  return (
    <div>
      <label htmlFor={id} style={labelStyle}>
        {label}
      </label>
      <input
        id={id}
        name={name}
        type="text"
        defaultValue={defaultValue}
        required={required}
        maxLength={maxLength}
        style={inputStyle}
      />
    </div>
  );
}

function TextAreaField({ id, name, label }: { id: string; name: string; label: string }) {
  return (
    <div>
      <label htmlFor={id} style={labelStyle}>
        {label}
      </label>
      <textarea id={id} name={name} rows={3} style={{ ...inputStyle, maxWidth: "100%" }} />
    </div>
  );
}

export default function WarrantyClaimDetailPage() {
  const { apiKey, shop, claim } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <AppProvider apiKey={apiKey}>
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", lineHeight: 1.5, maxWidth: "56rem" }}>
        <p style={{ margin: "0 0 0.5rem" }}>
          <Link to="/app/warranty-claims">&larr; Back to warranty claims</Link>
        </p>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>Warranty claim</h1>
        <p style={{ margin: "0 0 1.5rem", color: "#555" }}>
          Connected to <strong>{shop}</strong>.
        </p>

        {!claim ? (
          <p role="alert" style={{ color: "#b00" }}>
            That warranty claim was not found.
          </p>
        ) : (
          <>
            {actionData?.formError ? (
              <p role="alert" style={{ color: "#b00", margin: "0 0 1rem", border: "1px solid #b00", borderRadius: "4px", padding: "0.75rem 1rem" }}>
                {actionData.formError}
              </p>
            ) : null}

            <section style={sectionStyle}>
              <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
                {claim.claimReference} — <span style={{ fontWeight: 400 }}>{claim.status}</span>
              </h2>
              <dl style={{ margin: 0, fontSize: "0.875rem", display: "grid", rowGap: "0.35rem" }}>
                <Row label="Order">{claim.orderRef}</Row>
                <Row label="Line">{claim.lineRef}</Row>
                <Row label="Customer ref">{claim.customerRef ?? "(none)"}</Row>
                <Row label="Purchaser">
                  {claim.purchaserName} ({claim.purchaserEmail})
                </Row>
                <Row label="Item / configuration">{claim.itemConfigurationDescription}</Row>
                <Row label="Submitted">{formatTimestamp(claim.submittedAt)}</Row>
                <Row label="Problem description">{claim.problemDescription}</Row>
                <Row label="Impact/damage event?">
                  {claim.hadImpactOrDamageEvent ? "Yes" : "No"}
                  {claim.impactOrDamageDetails ? ` — ${claim.impactOrDamageDetails}` : ""}
                </Row>
                <Row label="Altered/repaired since delivery?">
                  {claim.wasAlteredAfterDelivery ? "Yes" : "No"}
                  {claim.alterationDetails ? ` — ${claim.alterationDetails}` : ""}
                </Row>
                {claim.certificateOrSerialIdentifier ? (
                  <Row label="Certificate/serial">{claim.certificateOrSerialIdentifier}</Row>
                ) : null}
                {claim.pausedFromStatus ? <Row label="Paused from">{claim.pausedFromStatus}</Row> : null}
              </dl>
            </section>

            {claim.authorizedAt ? (
              <section style={sectionStyle}>
                <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Authorization &amp; inbound shipping</h2>
                <dl style={{ margin: 0, fontSize: "0.875rem", display: "grid", rowGap: "0.35rem" }}>
                  <Row label="Authorized at">{formatTimestamp(claim.authorizedAt)}</Row>
                  <Row label="Authorized by">{claim.authorizedByActorRef}</Row>
                  <Row label="Carrier">{claim.inboundTrackingCarrier ?? "(not recorded)"}</Row>
                  <Row label="Tracking number">{claim.inboundTrackingNumber ?? "(not recorded)"}</Row>
                  <Row label="Insurance reference">{claim.inboundInsuranceReference ?? "(not recorded)"}</Row>
                  <Row label="Insured value">
                    {formatMoney(claim.inboundInsuredValueMinorUnits, claim.inboundInsuredValueCurrency)}
                  </Row>
                </dl>
                {canRecordInboundShipping(claim) ? (
                  <Form method="post" style={{ marginTop: "0.75rem" }}>
                    <input type="hidden" name="intent" value="record_inbound_shipping" />
                    <Field id="carrier" name="carrier" label="Carrier" defaultValue={claim.inboundTrackingCarrier ?? ""} />
                    <Field
                      id="trackingNumber"
                      name="trackingNumber"
                      label="Tracking number"
                      defaultValue={claim.inboundTrackingNumber ?? ""}
                    />
                    <Field
                      id="insuranceReference"
                      name="insuranceReference"
                      label="Insurance reference"
                      defaultValue={claim.inboundInsuranceReference ?? ""}
                    />
                    <Field id="insuredValueAmount" name="insuredValueAmount" label="Insured value (dollars and cents, optional)" />
                    <Field id="insuredValueCurrency" name="insuredValueCurrency" label="Currency" defaultValue="USD" maxLength={3} />
                    <button type="submit" disabled={busy}>
                      Save shipping evidence
                    </button>
                  </Form>
                ) : null}
              </section>
            ) : null}

            {claim.receivedAt ? (
              <section style={sectionStyle}>
                <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Receipt &amp; inspection</h2>
                <dl style={{ margin: 0, fontSize: "0.875rem", display: "grid", rowGap: "0.35rem" }}>
                  <Row label="Received at">{formatTimestamp(claim.receivedAt)}</Row>
                  <Row label="Inspected by">{claim.inspectedByActorRef ?? "(not recorded)"}</Row>
                  <Row label="Package condition">{claim.packageCondition ?? "(not recorded)"}</Row>
                  <Row label="Item condition">{claim.itemCondition ?? "(not recorded)"}</Row>
                  <Row label="Inspection notes">{claim.inspectionNotes ?? "(not recorded)"}</Row>
                </dl>
              </section>
            ) : null}

            {claim.coverageDecision ? (
              <section style={sectionStyle}>
                <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Coverage decision</h2>
                <dl style={{ margin: 0, fontSize: "0.875rem", display: "grid", rowGap: "0.35rem" }}>
                  <Row label="Decision">{claim.coverageDecision}</Row>
                  <Row label="Reason">{claim.coverageDecisionReason ?? "(none recorded)"}</Row>
                  <Row label="Decided at">{claim.coverageDecidedAt ? formatTimestamp(claim.coverageDecidedAt) : ""}</Row>
                  <Row label="Decided by">{claim.coverageDecidedByActorRef}</Row>
                </dl>
              </section>
            ) : null}

            {claim.remedy ? (
              <section style={sectionStyle}>
                <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Remedy</h2>
                <dl style={{ margin: 0, fontSize: "0.875rem", display: "grid", rowGap: "0.35rem" }}>
                  <Row label="Kind">{claim.remedy.kind}</Row>
                  <Row label="Status">{claim.remedy.status}</Row>
                  {claim.remedy.kind === "refund" ? (
                    <Row label="Refund amount">{formatMoney(claim.remedy.refundAmountMinorUnits, claim.remedy.currency)}</Row>
                  ) : null}
                  <Row label="Decided by">{claim.remedy.decidedByActorRef}</Row>
                  <Row label="Decided at">{formatTimestamp(claim.remedy.decidedAt)}</Row>
                  {claim.remedy.processorReference ? <Row label="Processor reference">{claim.remedy.processorReference}</Row> : null}
                  {claim.remedy.failureReason ? <Row label="Failure reason">{claim.remedy.failureReason}</Row> : null}
                </dl>

                {canUpdateRemedyStatus(claim) ? (
                  <Form method="post" style={{ marginTop: "0.75rem" }}>
                    <input type="hidden" name="intent" value="update_remedy_status" />
                    <label htmlFor="status" style={labelStyle}>
                      Remedy processing status
                    </label>
                    <select id="status" name="status" style={inputStyle}>
                      <option value="pending">Pending</option>
                      <option value="processing">Processing</option>
                      <option value="completed">Completed</option>
                      <option value="failed">Failed</option>
                    </select>
                    <Field id="processorReference" name="processorReference" label="Processor reference (optional)" />
                    <Field id="failureReason" name="failureReason" label="Failure reason (if failed)" />
                    <button type="submit" disabled={busy}>
                      Update remedy status
                    </button>
                  </Form>
                ) : null}
              </section>
            ) : null}

            {canManageLocalJeweller(claim) ? (
              <section style={{ ...sectionStyle, border: "2px solid #b06a00" }}>
                <h2 style={{ fontSize: "1rem", margin: "0 0 0.25rem", color: "#b06a00" }}>
                  INTERNAL ONLY — Local jeweller authorization
                </h2>
                <p style={{ margin: "0 0 0.75rem", fontSize: "0.8rem", color: "#b06a00", fontWeight: 600 }}>
                  Never disclose this section, or the fact that this option exists, to a customer. This is an
                  internal CaratForUs option (docs/WARRANTY-CLAIMS.md §7) — customers are never told it is
                  available until CaratForUs has specifically authorized and communicated an arrangement for
                  their claim.
                </p>

                {claim.remedy?.localJewellerAuthorization ? (
                  <>
                    <dl style={{ margin: "0 0 0.75rem", fontSize: "0.875rem", display: "grid", rowGap: "0.35rem" }}>
                      <Row label="Jeweller">{claim.remedy.localJewellerAuthorization.jewellerName}</Row>
                      <Row label="Contact">{claim.remedy.localJewellerAuthorization.jewellerContact ?? "(none)"}</Row>
                      <Row label="Authorized scope">{claim.remedy.localJewellerAuthorization.authorizedScope}</Row>
                      <Row label="Authorized cost">
                        {formatMoney(
                          claim.remedy.localJewellerAuthorization.authorizedCostMinorUnits,
                          claim.remedy.localJewellerAuthorization.authorizedCostCurrency
                        )}
                      </Row>
                      <Row label="Authorized by">{claim.remedy.localJewellerAuthorization.authorizedByActorRef}</Row>
                      <Row label="Authorized at">{formatTimestamp(claim.remedy.localJewellerAuthorization.authorizedAt)}</Row>
                      <Row label="Communications">{claim.remedy.localJewellerAuthorization.communicationsLog ?? "(none)"}</Row>
                      <Row label="Invoice reference">{claim.remedy.localJewellerAuthorization.invoiceReference ?? "(none)"}</Row>
                      <Row label="Invoice amount">
                        {formatMoney(
                          claim.remedy.localJewellerAuthorization.invoiceAmountMinorUnits,
                          claim.remedy.localJewellerAuthorization.invoiceAmountCurrency
                        )}
                      </Row>
                      <Row label="Payment reference">{claim.remedy.localJewellerAuthorization.paymentReference ?? "(none)"}</Row>
                      <Row label="Reimbursement reference">
                        {claim.remedy.localJewellerAuthorization.reimbursementReference ?? "(none — never automatic, criterion 167)"}
                      </Row>
                      <Row label="Completion evidence">{claim.remedy.localJewellerAuthorization.completionEvidence ?? "(none)"}</Row>
                    </dl>

                    <Form method="post">
                      <input type="hidden" name="intent" value="update_local_jeweller_completion" />
                      <input type="hidden" name="remedyId" value={claim.remedy.id} />
                      <TextAreaField id="communicationsLog" name="communicationsLog" label="Communications log" />
                      <Field id="invoiceReference" name="invoiceReference" label="Invoice reference" />
                      <Field id="invoiceAmount" name="invoiceAmount" label="Invoice amount (dollars and cents, optional)" />
                      <Field id="invoiceCurrency" name="invoiceCurrency" label="Invoice currency" defaultValue="USD" maxLength={3} />
                      <Field id="paymentReference" name="paymentReference" label="Payment reference" />
                      <Field
                        id="reimbursementReference"
                        name="reimbursementReference"
                        label="Reimbursement reference — only fill in if CaratForUs has explicitly approved reimbursement"
                      />
                      <TextAreaField id="completionEvidence" name="completionEvidence" label="Completion evidence" />
                      <button type="submit" disabled={busy}>
                        Save jeweller record
                      </button>
                    </Form>
                  </>
                ) : (
                  <Form method="post">
                    <input type="hidden" name="intent" value="record_local_jeweller_authorization" />
                    <input type="hidden" name="remedyId" value={claim.remedy?.id} />
                    <Field id="jewellerName" name="jewellerName" label="Jeweller name" required />
                    <Field id="jewellerContact" name="jewellerContact" label="Jeweller contact" />
                    <TextAreaField id="authorizedScope" name="authorizedScope" label="Authorized scope of work" />
                    <Field id="authorizedCostAmount" name="authorizedCostAmount" label="Authorized cost (dollars and cents)" required />
                    <Field id="authorizedCostCurrency" name="authorizedCostCurrency" label="Currency" defaultValue="USD" maxLength={3} />
                    <button type="submit" disabled={busy}>
                      Record local jeweller authorization
                    </button>
                  </Form>
                )}
              </section>
            ) : null}

            <section style={sectionStyle}>
              <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Uploads</h2>
              {claim.uploads.length === 0 ? (
                <p style={{ margin: 0, fontSize: "0.875rem", color: "#555" }}>No uploads.</p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: "1.25rem", fontSize: "0.875rem" }}>
                  {claim.uploads.map((upload) => (
                    <li key={upload.id}>
                      {upload.kind} — {upload.contentType} — {upload.sizeBytes} bytes — uploaded{" "}
                      {formatTimestamp(upload.uploadedAt)}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section style={sectionStyle}>
              <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>History</h2>
              {claim.events.length === 0 ? (
                <p style={{ margin: 0, fontSize: "0.875rem", color: "#555" }}>No events recorded.</p>
              ) : (
                <ul style={{ margin: 0, paddingLeft: "1.25rem", fontSize: "0.8rem" }}>
                  {claim.events.map((event) => (
                    <li key={event.id} style={{ marginBottom: "0.35rem" }}>
                      {formatTimestamp(event.createdAt)} — {event.fromStatus ?? "(new)"} &rarr; {event.toStatus} —{" "}
                      {event.actorType}
                      {event.actorRef ? ` (${event.actorRef})` : ""}
                      {event.reason ? `: ${event.reason}` : ""}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section style={sectionStyle}>
              <h2 style={{ fontSize: "1rem", margin: "0 0 0.75rem" }}>Actions</h2>

              {canStartReview(claim.status) ? (
                <Form method="post" style={{ marginBottom: "0.75rem" }}>
                  <input type="hidden" name="intent" value="start_review" />
                  <button type="submit" disabled={busy}>
                    Start review
                  </button>
                </Form>
              ) : null}

              {canRequestMoreInformation(claim.status) ? (
                <Form method="post" style={{ marginBottom: "0.75rem" }}>
                  <input type="hidden" name="intent" value="request_more_information" />
                  <Field id="moreInfoReason" name="reason" label="What additional information is needed?" required />
                  <button type="submit" disabled={busy}>
                    Request more information
                  </button>
                </Form>
              ) : null}

              {canResume(claim.status) ? (
                <Form method="post" style={{ marginBottom: "0.75rem" }}>
                  <input type="hidden" name="intent" value="resume_after_more_information" />
                  <button type="submit" disabled={busy}>
                    Resume (information received)
                  </button>
                </Form>
              ) : null}

              {canAuthorizeForInspection(claim.status) ? (
                <Form method="post" style={{ marginBottom: "0.75rem" }}>
                  <input type="hidden" name="intent" value="authorize_for_inspection" />
                  <p style={{ margin: "0 0 0.5rem", fontSize: "0.8rem", color: "#555" }}>
                    This authorizes the customer to ship their item for inspection — customer-paid, tracked, and
                    insured for the appropriate value (docs/WARRANTY-CLAIMS.md §3-§4). It does not establish
                    coverage.
                  </p>
                  <Field id="authorizeReason" name="reason" label="Note (optional)" />
                  <button type="submit" disabled={busy}>
                    Authorize for inspection
                  </button>
                </Form>
              ) : null}

              {canMarkInTransit(claim.status) ? (
                <Form method="post" style={{ marginBottom: "0.75rem" }}>
                  <input type="hidden" name="intent" value="mark_in_transit" />
                  <button type="submit" disabled={busy}>
                    Mark in transit
                  </button>
                </Form>
              ) : null}

              {canRecordReceipt(claim.status) ? (
                <Form method="post" style={{ marginBottom: "0.75rem" }}>
                  <input type="hidden" name="intent" value="record_receipt" />
                  <Field id="packageCondition" name="packageCondition" label="Package condition" />
                  <Field id="itemCondition" name="itemCondition" label="Item condition" />
                  <TextAreaField id="inspectionNotes" name="inspectionNotes" label="Inspection notes" />
                  <button type="submit" disabled={busy}>
                    Record receipt
                  </button>
                </Form>
              ) : null}

              {/* Criterion 159 — this control is offered ONLY when canDecideCoverage(claim.status) is true, i.e. only once receipt has been recorded. It is not rendered, disabled, or greyed out beforehand — absent entirely. */}
              {canDecideCoverage(claim.status) ? (
                <Form method="post" style={{ marginBottom: "0.75rem" }}>
                  <input type="hidden" name="intent" value="decide_coverage" />
                  <fieldset style={{ border: "none", padding: 0, margin: "0 0 0.6rem" }}>
                    <legend style={labelStyle}>Coverage decision — no default; an explicit choice is required</legend>
                    <label style={{ display: "block", fontSize: "0.875rem", marginBottom: "0.25rem" }}>
                      <input type="radio" name="decision" value="covered" required /> Covered
                    </label>
                    <label style={{ display: "block", fontSize: "0.875rem" }}>
                      <input type="radio" name="decision" value="not_covered" required /> Not covered
                    </label>
                  </fieldset>
                  <Field id="coverageReason" name="reason" label="Reason (required if denying)" />
                  <button type="submit" disabled={busy}>
                    Record coverage decision
                  </button>
                </Form>
              ) : null}

              {canSelectRemedy(claim) ? (
                <Form method="post" style={{ marginBottom: "0.75rem" }}>
                  <input type="hidden" name="intent" value="record_remedy" />
                  <fieldset style={{ border: "none", padding: 0, margin: "0 0 0.6rem" }}>
                    <legend style={labelStyle}>
                      Remedy — CaratForUs determines the appropriate resolution; no option is pre-selected or
                      recommended (criterion 162)
                    </legend>
                    {WARRANTY_REMEDY_KINDS.map((kind) => (
                      <label key={kind} style={{ display: "block", fontSize: "0.875rem", marginBottom: "0.15rem" }}>
                        <input type="radio" name="kind" value={kind} required /> {kind}
                      </label>
                    ))}
                  </fieldset>
                  <p style={{ margin: "0 0 0.5rem", fontSize: "0.8rem", color: "#555" }}>
                    If refund is selected, an amount and currency are required below; otherwise leave blank.
                  </p>
                  <Field id="refundAmount" name="refundAmount" label="Refund amount (dollars and cents — refund only)" />
                  <Field id="refundCurrency" name="refundCurrency" label="Currency" defaultValue="USD" maxLength={3} />
                  <button type="submit" disabled={busy}>
                    Record remedy
                  </button>
                </Form>
              ) : null}

              {canResolve(claim.status) ? (
                <Form method="post" style={{ marginBottom: "0.75rem" }}>
                  <input type="hidden" name="intent" value="resolve" />
                  <button type="submit" disabled={busy}>
                    Mark resolved
                  </button>
                </Form>
              ) : null}

              {canClose(claim.status) ? (
                <Form method="post" style={{ marginBottom: "0.75rem" }}>
                  <input type="hidden" name="intent" value="close" />
                  <button type="submit" disabled={busy}>
                    Close claim
                  </button>
                </Form>
              ) : null}

              {!canStartReview(claim.status) &&
              !canRequestMoreInformation(claim.status) &&
              !canResume(claim.status) &&
              !canAuthorizeForInspection(claim.status) &&
              !canMarkInTransit(claim.status) &&
              !canRecordReceipt(claim.status) &&
              !canDecideCoverage(claim.status) &&
              !canSelectRemedy(claim) &&
              !canResolve(claim.status) &&
              !canClose(claim.status) ? (
                <p style={{ margin: 0, fontSize: "0.875rem", color: "#555" }}>
                  No further staff action is available for this claim in its current state.
                </p>
              ) : null}
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
