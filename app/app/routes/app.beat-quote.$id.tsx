import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation, useRouteError } from "react-router";

import { prisma } from "~/db/client.server";
import {
  BeatQuoteAlreadyVerifiedError,
  BeatQuoteDecisionIncoherentError,
  BeatQuoteSubmissionNotFoundError,
  findReleasableHoldForSubmission,
  recordDecision,
  recordVerification,
} from "~/db/repositories/beatQuoteReviewRepository.server";
import { issueBeatQuoteFallbackBenefit } from "~/jobs/beatyourquote/issueFallbackBenefit.server";
import { staffReleaseRedemptionHold } from "~/jobs/beatyourquote/staffReleaseRedemption.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { ShopifyDraftOrderAdapter } from "~/shopify/admin/draftOrderAdapter.server";
import { authenticate } from "~/shopify.server";

/**
 * GET/POST /app/beat-quote/:id — the staff review surface for one submission.
 *
 * Mirrors `app.rma.$id.tsx` and `app.custom-jewelry.$id.tsx`: the same staff
 * identity discipline (D23 — the AUTHENTICATED Shopify session, never a form
 * field), the same "only offer a control the domain would actually allow"
 * gating, and the same explicit view model rather than a raw Prisma spread.
 *
 * A DEFAULT EXPORT WITH AN ACTION — needs a reasoned entry in
 * `csrfResourceRouteFence.test.ts`'s `EXEMPT_UI_ACTION_ROUTES`.
 *
 * ============================================================================
 * THE FROZEN FACTS ARE DISPLAYED AND NOT EDITABLE, ANYWHERE
 * ============================================================================
 * Treatment, quote age, the submission's business-calendar date and the zone
 * it was derived in are shown so a reviewer can see WHY a submission is on the
 * path it is on — and no form on this page can change any of them. They were
 * settled at intake, and a reviewer who could edit them could hand out a $100
 * benefit by changing a date.
 *
 * The page also shows the calendar zone explicitly, because "7 days" means
 * nothing without knowing whose calendar measured it, and a submission judged
 * under a zone the store has since changed is exactly the case a reviewer
 * needs to be able to see rather than infer.
 *
 * ============================================================================
 * THREE ACTIONS, EACH GATED ON WHAT THE DOMAIN WOULD ALLOW
 * ============================================================================
 *   verify            only while verification is pending
 *   decide            only once verified
 *   issue benefit     only when the gate in `issueBeatQuoteFallbackBenefit`
 *                     would pass
 *
 * The gating is UI convenience; the authority is the repository and the
 * schema. But a button offered when it cannot work is its own defect: a
 * reviewer clicking it reasonably expects it to work, and "the server said no"
 * is a worse experience than the control not being there.
 *
 * NO CONTROL ON THIS PAGE DECIDES WHETHER TO MATCH A PRICE. The specification
 * forbids an engine that commits CaratForUs from uploaded documents; the
 * decision form RECORDS a conclusion a human reached.
 */

// ---------------------------------------------------------------------------
// View model — an explicit field list, never a Prisma spread.
// ---------------------------------------------------------------------------

export interface BeatQuoteAcknowledgmentView {
  readonly exactText: string;
  readonly affirmativeActionLabel: string;
  readonly policySlug: string;
  readonly policyVersion: number;
  readonly acknowledgedAt: string;
}

export interface BeatQuoteBenefitView {
  readonly benefitCode: string;
  readonly percent: number;
  readonly maxDiscount: string;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly issuedByActorRef: string | null;
  readonly redeemedAt: string | null;
  readonly redemptionOrderRef: string | null;
  readonly revokedAt: string | null;
  readonly revokedReason: string | null;
}

/** An active redemption hold — the only kind the release control is offered for. */
export interface ReleasableHoldView {
  readonly intentId: string;
  readonly status: string;
  readonly paymentBasis: string;
  readonly discount: string;
  readonly reservedAt: string;
  readonly draftOrderGid: string | null;
  readonly bankPaymentOrderId: string | null;
  readonly reviewReason: string | null;
}

export interface BeatQuoteDetailView {
  readonly id: string;
  readonly submissionReference: string;
  readonly kind: string;
  /** FROZEN at intake. Displayed, never editable. */
  readonly treatment: string;
  readonly quoteAge: string;
  readonly quoteIssuedOn: string | null;
  readonly submittedOn: string;
  readonly calendarZone: string;
  readonly submittedAt: string;

  readonly customerName: string;
  readonly email: string;
  readonly phone: string | null;
  readonly hasAccount: boolean;

  readonly competitorSellerName: string | null;
  readonly competitorWebsite: string | null;
  readonly listingUrl: string | null;
  readonly competitorPrice: string;
  readonly specifications: string | null;
  readonly competitorTimeline: string | null;
  readonly competitorReturnPolicy: string | null;
  readonly competitorWarranty: string | null;

  readonly verification: string;
  readonly verificationEvidence: string | null;
  readonly verifiedAt: string | null;
  readonly verifiedByActorRef: string | null;

  readonly status: string;
  readonly offeredPrice: string | null;
  readonly offerTermsShown: string | null;
  readonly decisionReason: string | null;
  readonly decidedAt: string | null;
  readonly decidedByActorRef: string | null;

  readonly acknowledgments: readonly BeatQuoteAcknowledgmentView[];
  readonly benefit: BeatQuoteBenefitView | null;

  /**
   * Redemption holds on this submission’s benefit that a person can act on.
   *
   * Only ACTIVE ones. A completed or released redemption is history, and
   * offering a Release control beside it would invite a click that the service
   * correctly refuses — a control that exists only to say no is worse than no
   * control.
   */
  readonly releasableHolds: readonly ReleasableHoldView[];

  /** Derived gates for the three controls. */
  readonly canVerify: boolean;
  readonly canDecide: boolean;
  readonly benefitOwed: boolean;
  readonly benefitBlockedReason: string | null;
}

/** Minor units to a display string by integer arithmetic — no rounding helper. */
function formatMinorUnits(amountMinorUnits: bigint, currency: string): string {
  const negative = amountMinorUnits < 0n;
  const absolute = negative ? -amountMinorUnits : amountMinorUnits;
  const major = absolute / 100n;
  const minor = absolute % 100n;
  return `${negative ? "-" : ""}${major}.${minor < 10n ? `0${minor}` : minor} ${currency}`;
}

/** D23 — the AUTHENTICATED session, never a form field. */
function resolveStaffActorRef(session: Awaited<ReturnType<typeof authenticate.admin>>["session"]): string | null {
  const associatedUser = session.onlineAccessInfo?.associated_user;
  if (!associatedUser) return null;
  return `staff:${associatedUser.id}`;
}

interface LoaderData {
  apiKey: string;
  shop: string;
  submission: BeatQuoteDetailView | null;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const id = params.id;
  if (!id) throw new Response("Missing submission id.", { status: 400 });

  const row = await prisma.beatQuoteSubmission.findUnique({
    where: { id },
    include: {
      fallbackBenefit: { include: { redemptionIntents: { orderBy: { reservedAt: "asc" } } } },
    },
  });

  const acknowledgments = row
    ? await prisma.acknowledgment.findMany({
        where: { submissionRef: row.id },
        include: { policyVersion: true },
        orderBy: { acknowledgedAt: "asc" },
      })
    : [];

  const submission: BeatQuoteDetailView | null = row
    ? {
        id: row.id,
        submissionReference: row.submissionReference,
        kind: row.kind,
        treatment: row.treatment,
        quoteAge: row.quoteAgeCalendarDays === null ? "n/a (no age rule for this path)" : `${row.quoteAgeCalendarDays} days`,
        quoteIssuedOn: row.quoteIssuedOn ? row.quoteIssuedOn.toISOString().slice(0, 10) : null,
        submittedOn: row.submittedOn.toISOString().slice(0, 10),
        calendarZone: row.calendarZone,
        submittedAt: row.submittedAt.toISOString(),

        customerName: `${row.firstName} ${row.lastName}`,
        email: row.email,
        phone: row.phone,
        hasAccount: row.customerRef !== null,

        competitorSellerName: row.competitorSellerName,
        competitorWebsite: row.competitorWebsite,
        listingUrl: row.listingUrl,
        competitorPrice:
          row.competitorPriceMinorUnits !== null && row.competitorPriceCurrency !== null
            ? formatMinorUnits(row.competitorPriceMinorUnits, row.competitorPriceCurrency)
            : "Not stated",
        specifications: row.specifications,
        competitorTimeline: row.competitorTimeline,
        competitorReturnPolicy: row.competitorReturnPolicy,
        competitorWarranty: row.competitorWarranty,

        verification: row.verification,
        verificationEvidence: row.verificationEvidence,
        verifiedAt: row.verifiedAt?.toISOString() ?? null,
        verifiedByActorRef: row.verifiedByActorRef,

        status: row.status,
        offeredPrice:
          row.offeredPriceMinorUnits !== null && row.offeredPriceCurrency !== null
            ? formatMinorUnits(row.offeredPriceMinorUnits, row.offeredPriceCurrency)
            : null,
        offerTermsShown: row.offerTermsShown,
        decisionReason: row.decisionReason,
        decidedAt: row.decidedAt?.toISOString() ?? null,
        decidedByActorRef: row.decidedByActorRef,

        acknowledgments: acknowledgments.map((ack) => ({
          exactText: ack.exactText,
          affirmativeActionLabel: ack.affirmativeActionLabel,
          policySlug: ack.policyVersion.slug,
          policyVersion: ack.policyVersion.version,
          acknowledgedAt: ack.acknowledgedAt.toISOString(),
        })),
        benefit: row.fallbackBenefit
          ? {
              benefitCode: row.fallbackBenefit.benefitCode,
              percent: row.fallbackBenefit.percent,
              maxDiscount: formatMinorUnits(
                row.fallbackBenefit.maxDiscountMinorUnits,
                row.fallbackBenefit.currency
              ),
              issuedAt: row.fallbackBenefit.issuedAt.toISOString(),
              expiresAt: row.fallbackBenefit.expiresAt.toISOString(),
              issuedByActorRef: row.fallbackBenefit.issuedByActorRef,
              redeemedAt: row.fallbackBenefit.redeemedAt?.toISOString() ?? null,
              redemptionOrderRef: row.fallbackBenefit.redemptionOrderRef,
              revokedAt: row.fallbackBenefit.revokedAt?.toISOString() ?? null,
              revokedReason: row.fallbackBenefit.revokedReason,
            }
          : null,

        // ACTIVE HOLDS ONLY — `reserved` and `failed_review` are the two states in
        // which the benefit is held and its fate undecided. Those are exactly
        // the rows the release control exists for.
        releasableHolds: (row.fallbackBenefit?.redemptionIntents ?? [])
          .filter((hold) => hold.status === "reserved" || hold.status === "failed_review")
          .map((hold) => ({
            intentId: hold.id,
            status: hold.status,
            paymentBasis: hold.paymentBasis,
            discount: formatMinorUnits(hold.discountMinorUnits, hold.currency),
            reservedAt: hold.reservedAt.toISOString(),
            draftOrderGid: hold.draftOrderGid,
            bankPaymentOrderId: hold.bankPaymentOrderId,
            reviewReason: hold.reviewReason,
          })),

        canVerify: row.verification === "pending",
        canDecide: row.verification === "verified" && row.status !== "closed",
        benefitOwed:
          row.treatment === "guarantee" &&
          row.verification === "verified" &&
          row.status === "declined_cannot_beat" &&
          row.fallbackBenefit === null,
        // Named explicitly so the page can say WHY rather than just hiding a
        // button — "needs the customer signed in" is a real action a reviewer
        // can take.
        benefitBlockedReason:
          row.treatment === "guarantee" &&
          row.verification === "verified" &&
          row.status === "declined_cannot_beat" &&
          row.fallbackBenefit === null &&
          row.customerRef === null
            ? "The customer submitted without an account. The benefit is non-transferable, so it cannot be issued until they are signed in and the submission is linked."
            : null,
      }
    : null;

  return { apiKey: getEnv().SHOPIFY_API_KEY ?? "", shop: session.shop, submission } satisfies LoaderData;
}

interface ActionData {
  error?: string;
  notice?: string;
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const id = params.id;
  if (!id) return { error: "Missing submission id." } satisfies ActionData;

  const staffActorRef = resolveStaffActorRef(session);
  if (!staffActorRef) {
    // An offline session carries no associated user, so there is no identity
    // to attribute a verdict or a $100 benefit to. Refuse rather than record
    // it against nobody — the schema's own CHECK would refuse anyway.
    return {
      error: "Could not identify the signed-in staff user. Open this page from Shopify Admin and try again.",
    } satisfies ActionData;
  }

  const formData = await request.formData();
  const intent = formData.get("intent");
  const now = new Date();

  try {
    if (intent === "verify") {
      const outcome = formData.get("outcome");
      if (outcome !== "verified" && outcome !== "rejected") {
        return { error: "Choose whether the submission is verified or rejected." } satisfies ActionData;
      }
      const evidence = String(formData.get("evidence") ?? "").trim();
      if (evidence === "") {
        // The spec is explicit that customer screenshots alone do not
        // establish eligibility, so OUR evidence is what the verdict rests on.
        return { error: "Record what you checked. A verdict with no evidence is not a verdict." } satisfies ActionData;
      }
      await recordVerification({ submissionId: id, outcome, evidence, actorRef: staffActorRef, at: now });
      logger.info("beat_quote_admin.verified", { submissionId: id, outcome, actor: staffActorRef });
      return { notice: `Recorded as ${outcome}.` } satisfies ActionData;
    }

    if (intent === "decide") {
      const status = String(formData.get("status") ?? "");
      if (!["offer_made", "declined_cannot_beat", "rejected", "closed"].includes(status)) {
        return { error: "Choose a decision." } satisfies ActionData;
      }
      const reason = String(formData.get("reason") ?? "").trim();
      const priceText = String(formData.get("offeredPrice") ?? "").trim();

      let offeredPriceMinorUnits: bigint | undefined;
      if (status === "offer_made") {
        // Dollars-and-cents text to integer minor units by STRING padding —
        // never multiplying a float by 100.
        if (!/^\d+(\.\d{1,2})?$/.test(priceText)) {
          return {
            error: "Enter the offered price as dollars and cents, at most two decimals, no symbol — e.g. 4300 or 4300.00.",
          } satisfies ActionData;
        }
        const [whole, fraction = ""] = priceText.split(".");
        offeredPriceMinorUnits = BigInt(whole! + fraction.padEnd(2, "0"));
      } else if (priceText !== "") {
        return { error: "An offered price applies only to an offer." } satisfies ActionData;
      }

      await recordDecision({
        submissionId: id,
        status: status as "offer_made" | "declined_cannot_beat" | "rejected" | "closed",
        reason,
        actorRef: staffActorRef,
        at: now,
        ...(offeredPriceMinorUnits !== undefined
          ? { offeredPriceMinorUnits, offeredPriceCurrency: "USD" }
          : {}),
        offerTermsShown: String(formData.get("offerTermsShown") ?? "").trim() || undefined,
      });
      logger.info("beat_quote_admin.decided", { submissionId: id, status, actor: staffActorRef });
      return { notice: `Decision recorded: ${status}.` } satisfies ActionData;
    }

    if (intent === "issue_benefit") {
      const result = await issueBeatQuoteFallbackBenefit({
        submissionId: id,
        issuedByActorRef: staffActorRef,
        now,
      });
      switch (result.outcome) {
        case "issued":
          logger.info("beat_quote_admin.benefit_issued", { submissionId: id, actor: staffActorRef });
          return {
            notice: `Benefit issued: ${result.benefit.benefitCode}, expires ${result.benefit.expiresAt.toISOString().slice(0, 10)}.`,
          } satisfies ActionData;
        case "already_issued":
          return { error: "This submission already has a benefit. One qualifying outcome, one benefit." } satisfies ActionData;
        case "not_owed":
          return { error: `No benefit is owed: ${result.detail}` } satisfies ActionData;
        case "customer_not_linked":
          return {
            error:
              "The benefit is non-transferable and this submission has no account to bind it to. Get the customer signed in and the submission linked first.",
          } satisfies ActionData;
        case "submission_not_found":
          return { error: "Submission not found." } satisfies ActionData;
      }
    }

    if (intent === "release_redemption") {
      // ======================================================================
      // THE AUTHORIZATION CHECK THAT MUST NOT BE SKIPPED
      // ======================================================================
      // This route is keyed on a SUBMISSION. The form posts a REDEMPTION
      // INTENT id, which is a different object — so without this check a staff
      // member looking at one submission could release a hold belonging to
      // another by editing a hidden field. Same class of defect as trusting an
      // order tag: the id locates the row, it does not authorise acting on it.
      const redemptionIntentId = String(formData.get("redemptionIntentId") ?? "").trim();
      if (redemptionIntentId === "") {
        return { error: "Which redemption hold? None was named." } satisfies ActionData;
      }
      const owned = await findReleasableHoldForSubmission({
        submissionId: id,
        redemptionIntentId,
      });
      if (!owned) {
        logger.warn("beat_quote_admin.release_foreign_intent_refused", {
          submissionId: id,
          redemptionIntentId,
          actor: staffActorRef,
        });
        // Deliberately not "that belongs to another submission": the same
        // reasoning as the redemption route's refusals, so this cannot be used
        // to confirm an id exists.
        return { error: "That redemption hold does not belong to this submission." } satisfies ActionData;
      }

      // NOT PRE-CHECKED, AND NOT INFERRED FROM A STATUS. The staff member is
      // asserting a fact about money — that none arrived — and CLAUDE.md
      // forbids pre-checking or silently inferring a material acknowledgment.
      // An unpaid-looking order is not confirmation: a transfer can be in
      // flight or received and unreconciled.
      const paymentConfirmedNotReceived = formData.get("paymentConfirmedNotReceived") === "yes";

      const { admin } = await authenticate.admin(request);
      const result = await staffReleaseRedemptionHold({
        intentId: redemptionIntentId,
        reason: String(formData.get("releaseReason") ?? ""),
        actorRef: staffActorRef,
        paymentConfirmedNotReceived,
        // Built here, inside the branch that needs it — the deposit handler's
        // live 500 came from constructing an Admin client on a path that did
        // not.
        draftOrderPort: new ShopifyDraftOrderAdapter(admin),
        now,
      });

      switch (result.outcome) {
        case "released":
          logger.info("beat_quote_admin.redemption_released", {
            submissionId: id,
            redemptionIntentId,
            actor: staffActorRef,
            shopifyRef: result.shopifyRef,
          });
          return {
            notice:
              `Hold released. The discounted checkout was confirmed unpayable first (${result.shopifyRef}). ` +
              (result.benefitExpiredWhileReserved
                ? `NOTE: the benefit expired on ${result.benefitExpiresAt.toISOString().slice(0, 10)} while it was reserved, ` +
                  `so it is available again but will refuse a new redemption. Releasing does not extend it.`
                : `The benefit is usable again until ${result.benefitExpiresAt.toISOString().slice(0, 10)} — its original expiry, unchanged.`),
          } satisfies ActionData;
        case "already_released":
          return { notice: "That hold was already released. Nothing changed." } satisfies ActionData;
        case "refused":
          // Each refusal means something different and actionable. The Shopify
          // one especially must not read as a generic error: the hold is KEPT
          // because the checkout may still be payable.
          return { error: result.detail } satisfies ActionData;
      }
    }

    return { error: "Unrecognised action." } satisfies ActionData;
  } catch (error) {
    // The domain's own refusals, surfaced as the reviewer's message rather
    // than as a stack trace. Anything else is a real fault and propagates.
    if (
      error instanceof BeatQuoteAlreadyVerifiedError ||
      error instanceof BeatQuoteDecisionIncoherentError ||
      error instanceof BeatQuoteSubmissionNotFoundError
    ) {
      return { error: error.message } satisfies ActionData;
    }
    throw error;
  }
}

export default function BeatQuoteDetailPage() {
  const { apiKey, shop, submission } = useLoaderData<LoaderData>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";

  if (!submission) {
    return (
      <AppProvider apiKey={apiKey}>
        <main style={{ padding: "1.5rem" }}>
          <p>Submission not found.</p>
        </main>
      </AppProvider>
    );
  }

  const s = submission;

  return (
    <AppProvider apiKey={apiKey}>
      <main style={{ padding: "1.5rem", maxWidth: "60rem" }}>
        <h1 style={{ marginTop: 0 }}>Beat Your Quote — {s.submissionReference}</h1>

        {actionData?.error ? (
          <p role="alert" style={{ fontWeight: 600 }}>
            {actionData.error}
          </p>
        ) : null}
        {actionData?.notice ? (
          <p role="status" style={{ fontWeight: 600 }}>
            {actionData.notice}
          </p>
        ) : null}

        <h2>Eligibility — frozen at intake</h2>
        <dl>
          <dt>Path</dt>
          <dd>{s.kind}</dd>
          <dt>Treatment</dt>
          {/* Shown, never editable. A reviewer who could change this could
              hand out a $100 benefit by editing a date. */}
          <dd>
            <strong>{s.treatment}</strong>
            {s.treatment === "review_only" ? " — no guaranteed match-or-beat, no 10%-off fallback" : null}
          </dd>
          <dt>Quote issued</dt>
          <dd>{s.quoteIssuedOn ?? "n/a"}</dd>
          <dt>Quote age at submission</dt>
          <dd>{s.quoteAge}</dd>
          <dt>Submitted on (business calendar)</dt>
          {/* The zone is shown because "7 days" means nothing without knowing
              whose calendar measured it. */}
          <dd>
            {s.submittedOn} ({s.calendarZone})
          </dd>
          <dt>Submitted at (UTC)</dt>
          <dd>{s.submittedAt}</dd>
        </dl>

        <h2>Customer</h2>
        <dl>
          <dt>Name</dt>
          <dd>{s.customerName}</dd>
          <dt>Email</dt>
          <dd>{s.email}</dd>
          <dt>Phone</dt>
          <dd>{s.phone ?? "Not given"}</dd>
          <dt>Account</dt>
          <dd>{s.hasAccount ? "Signed in when they submitted" : "Not signed in"}</dd>
        </dl>

        <h2>The competing offer</h2>
        <dl>
          <dt>Seller</dt>
          <dd>{s.competitorSellerName ?? "Not stated"}</dd>
          <dt>Website</dt>
          <dd style={{ wordBreak: "break-all" }}>{s.competitorWebsite ?? "Not stated"}</dd>
          <dt>Listing URL</dt>
          {/* PLAIN TEXT, NEVER AN ANCHOR. Nothing server-side fetches these
              (that would be an SSRF primitive) and nothing here makes a
              customer-supplied URL one click from an admin session. */}
          <dd style={{ wordBreak: "break-all" }}>{s.listingUrl ?? "Not stated"}</dd>
          <dt>Their price</dt>
          <dd>{s.competitorPrice}</dd>
        </dl>
        {s.specifications ? (
          <>
            <h3>Specifications as submitted</h3>
            <p style={{ whiteSpace: "pre-wrap" }}>{s.specifications}</p>
          </>
        ) : null}

        <h3>Their service terms</h3>
        {/* NOT terms CaratForUs promises to match — the spec is explicit, and
            labelling them keeps that visible to whoever builds the comparison. */}
        <p>These are the competing seller&apos;s terms, as reported. CaratForUs does not promise to match them.</p>
        <dl>
          <dt>Timeline</dt>
          <dd>{s.competitorTimeline ?? "Unknown"}</dd>
          <dt>Returns</dt>
          <dd>{s.competitorReturnPolicy ?? "Unknown"}</dd>
          <dt>Warranty</dt>
          <dd>{s.competitorWarranty ?? "Unknown"}</dd>
        </dl>

        <h2>Verification</h2>
        {s.verification === "pending" ? (
          <p>Not yet verified.</p>
        ) : (
          <dl>
            <dt>Outcome</dt>
            <dd>
              <strong>{s.verification}</strong>
            </dd>
            <dt>By</dt>
            <dd>
              {s.verifiedByActorRef} at {s.verifiedAt}
            </dd>
            <dt>Evidence</dt>
            <dd style={{ whiteSpace: "pre-wrap" }}>{s.verificationEvidence}</dd>
          </dl>
        )}

        {s.canVerify ? (
          <Form method="post">
            <input type="hidden" name="intent" value="verify" />
            <fieldset>
              <legend>Record a verification verdict</legend>
              <p>
                <label>
                  <input type="radio" name="outcome" value="verified" required /> Verified — seller, price, date
                  and specifications check out
                </label>
                <br />
                <label>
                  <input type="radio" name="outcome" value="rejected" required /> Rejected — fabricated, altered,
                  unverifiable or not comparable
                </label>
              </p>
              <p>
                <label htmlFor="evidence">What did you check? (recorded as CaratForUs&apos;s own evidence)</label>
                <br />
                <textarea id="evidence" name="evidence" rows={4} cols={70} required />
              </p>
              <p>
                <strong>This is recorded once and cannot be changed.</strong> A verdict that can be flipped after
                a benefit was issued on the strength of it is not evidence.
              </p>
              <button type="submit" disabled={submitting}>
                {submitting ? "Recording…" : "Record verdict"}
              </button>
            </fieldset>
          </Form>
        ) : null}

        <h2>Decision</h2>
        {s.status === "submitted" || s.status === "in_review" ? (
          <p>No decision recorded yet.</p>
        ) : (
          <dl>
            <dt>Outcome</dt>
            <dd>
              <strong>{s.status}</strong>
            </dd>
            {s.offeredPrice ? (
              <>
                <dt>Our price</dt>
                <dd>{s.offeredPrice}</dd>
              </>
            ) : null}
            <dt>Reason</dt>
            <dd style={{ whiteSpace: "pre-wrap" }}>{s.decisionReason}</dd>
            <dt>By</dt>
            <dd>
              {s.decidedByActorRef} at {s.decidedAt}
            </dd>
            {s.offerTermsShown ? (
              <>
                <dt>Terms shown</dt>
                <dd style={{ whiteSpace: "pre-wrap" }}>{s.offerTermsShown}</dd>
              </>
            ) : null}
          </dl>
        )}

        {s.canDecide ? (
          <Form method="post">
            <input type="hidden" name="intent" value="decide" />
            <fieldset>
              <legend>Record your decision</legend>
              <p>
                <label>
                  <input type="radio" name="status" value="offer_made" required /> We can match or beat it
                </label>
                <br />
                <label>
                  <input type="radio" name="status" value="declined_cannot_beat" required /> We cannot beat it
                  {s.treatment === "guarantee" ? " — this owes the 10%-off benefit" : ""}
                </label>
                <br />
                <label>
                  <input type="radio" name="status" value="rejected" required /> Not a qualifying submission
                </label>
                <br />
                <label>
                  <input type="radio" name="status" value="closed" required /> Close without an offer
                </label>
              </p>
              <p>
                <label htmlFor="offeredPrice">Our price, if offering (dollars and cents, USD)</label>
                <br />
                <input id="offeredPrice" name="offeredPrice" inputMode="decimal" placeholder="4300.00" />
              </p>
              <p>
                <label htmlFor="offerTermsShown">Terms shown to the customer (timeline, warranty, returns)</label>
                <br />
                <textarea id="offerTermsShown" name="offerTermsShown" rows={3} cols={70} />
              </p>
              <p>
                <label htmlFor="reason">Reason (required)</label>
                <br />
                <textarea id="reason" name="reason" rows={3} cols={70} required />
              </p>
              <button type="submit" disabled={submitting}>
                {submitting ? "Recording…" : "Record decision"}
              </button>
            </fieldset>
          </Form>
        ) : null}

        <h2>10%-off fallback benefit</h2>
        {s.benefit ? (
          <dl>
            <dt>Code</dt>
            <dd>{s.benefit.benefitCode}</dd>
            <dt>Terms</dt>
            <dd>
              {s.benefit.percent}% off, max {s.benefit.maxDiscount}
            </dd>
            <dt>Issued</dt>
            <dd>
              {s.benefit.issuedAt} by {s.benefit.issuedByActorRef ?? "unknown"}
            </dd>
            <dt>Expires</dt>
            <dd>{s.benefit.expiresAt}</dd>
            <dt>Redeemed</dt>
            <dd>
              {s.benefit.redeemedAt ? `${s.benefit.redeemedAt} on ${s.benefit.redemptionOrderRef}` : "Not yet"}
            </dd>
            {s.benefit.revokedAt ? (
              <>
                <dt>Revoked</dt>
                <dd>
                  {s.benefit.revokedAt} — {s.benefit.revokedReason}
                </dd>
              </>
            ) : null}
          </dl>
        ) : null}

        {/*
          ======================================================================
          THE RELEASE CONTROL — OFFERED ONLY FOR AN ACTIVE HOLD
          ======================================================================
          Releasing is not cleanup. It makes a benefit available again, and the
          discounted Shopify checkout has to be proven incapable of completing
          FIRST — otherwise a customer with the invoice in their inbox could pay
          it later and take the benefit twice.

          The copy says that out loud rather than hiding it behind a button
          label, because the person clicking is the last check on it.
        */}
        {s.releasableHolds.length > 0 ? (
          <section aria-labelledby="holds-heading" style={{ marginTop: "1.5rem" }}>
            <h3 id="holds-heading">Active redemption holds</h3>
            {s.releasableHolds.map((hold) => (
              <Form
                method="post"
                key={hold.intentId}
                style={{ border: "1px solid", padding: "1rem", marginBottom: "1rem" }}
              >
                <input type="hidden" name="intent" value="release_redemption" />
                {/*
                  Verified server-side against THIS submission before anything
                  is released — the route is keyed on a submission and this is a
                  different object, so the id locates the row without
                  authorising action on it.
                */}
                <input type="hidden" name="redemptionIntentId" value={hold.intentId} />

                <dl>
                  <dt>State</dt>
                  <dd>
                    {hold.status}
                    {hold.status === "failed_review" ? " — waiting on a decision" : ""}
                  </dd>
                  <dt>Basis</dt>
                  <dd>{hold.paymentBasis === "bank_payment" ? "Bank Payment" : "Card"}</dd>
                  <dt>Benefit held</dt>
                  <dd>{hold.discount}</dd>
                  <dt>Reserved</dt>
                  <dd>{hold.reservedAt}</dd>
                  <dt>Payable object</dt>
                  <dd>
                    {hold.draftOrderGid ??
                      (hold.bankPaymentOrderId
                        ? `bank payment order ${hold.bankPaymentOrderId}`
                        : "none — this hold never reached checkout creation")}
                  </dd>
                  {hold.reviewReason ? (
                    <>
                      <dt>Why it needs a person</dt>
                      <dd>{hold.reviewReason}</dd>
                    </>
                  ) : null}
                </dl>

                <p>
                  Releasing cancels the discounted checkout in Shopify first and only then frees the
                  benefit. If Shopify does not confirm the cancellation, the benefit stays held — it must
                  not become available while that checkout could still be paid.
                </p>

                <label htmlFor={`reason-${hold.intentId}`}>Why are you releasing this hold?</label>
                <br />
                <textarea
                  id={`reason-${hold.intentId}`}
                  name="releaseReason"
                  rows={3}
                  cols={60}
                  required
                />
                <br />

                {/*
                  NOT PRE-CHECKED. The staff member is asserting a fact about
                  money, and `CLAUDE.md` forbids pre-checking or silently
                  inferring a material acknowledgment. An order that merely
                  looks unpaid is not confirmation: a transfer can be in flight,
                  or received and not yet reconciled.
                */}
                <label>
                  <input type="checkbox" name="paymentConfirmedNotReceived" value="yes" required />{" "}
                  I have confirmed no payment was received for this order. Received, verified, partial or
                  uncertain payments all block a release.
                </label>
                <br />

                <button type="submit" disabled={submitting}>
                  {submitting ? "Releasing…" : "Release this hold"}
                </button>
              </Form>
            ))}
          </section>
        ) : null}

        {s.benefit ? null : s.benefitBlockedReason ? (
          <p role="alert" style={{ fontWeight: 600 }}>
            {s.benefitBlockedReason}
          </p>
        ) : s.benefitOwed ? (
          <Form method="post">
            <input type="hidden" name="intent" value="issue_benefit" />
            <p>
              This submission is <strong>owed</strong> the 10%-off benefit: a verified custom quote inside the
              7-day window that CaratForUs cannot beat.
            </p>
            <button type="submit" disabled={submitting}>
              {submitting ? "Issuing…" : "Issue the 10%-off benefit"}
            </button>
          </Form>
        ) : (
          <p>
            No benefit is owed on this submission.
            {s.treatment === "review_only"
              ? " This is a review-only path — an older quote, an online listing or a competing Group Buy."
              : null}
          </p>
        )}

        <h2>Acknowledgments ({s.acknowledgments.length})</h2>
        {s.acknowledgments.length === 0 ? (
          <p>None recorded.</p>
        ) : (
          s.acknowledgments.map((ack) => (
            <div key={`${ack.policySlug}-${ack.acknowledgedAt}`}>
              <p>
                <strong>{ack.policySlug}</strong> v{ack.policyVersion} — accepted via &ldquo;
                {ack.affirmativeActionLabel}&rdquo; at {ack.acknowledgedAt}
              </p>
              {/* The EXACT text, in full. A reviewer deciding a $100 question
                  should see precisely what the customer agreed to. */}
              <blockquote style={{ whiteSpace: "pre-wrap", borderLeft: "3px solid #888", paddingLeft: "1rem" }}>
                {ack.exactText}
              </blockquote>
            </div>
          ))
        )}

        <p style={{ marginTop: "2rem", fontSize: "0.9rem" }}>Shop: {shop}</p>
      </main>
    </AppProvider>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
