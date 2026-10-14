import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation, useRouteError } from "react-router";

import { prisma } from "~/db/client.server";
import { resolveActivePricingProfile } from "~/db/repositories/pricingProfileRepository.server";
import {
  CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT,
  CUSTOM_JEWELRY_DEPOSIT_AFFIRMATIVE_ACTION_LABEL,
} from "~/domain/customjewelry/designDepositAcknowledgmentText";
import { issueApprovalPackage } from "~/db/repositories/customJewelryApprovalRepository.server";
import { loadProjectApprovalHistory } from "~/db/repositories/customJewelryStaffRepository.server";
import { MoneyDecimal } from "~/domain/money/decimal";
import { Money } from "~/domain/money/money";
import { deriveRegularCardPrice } from "~/domain/pricing/regularCardPrice";
import type { RegularCardPriceRuleId } from "~/domain/pricing/types";
import { issueCustomJewelryDepositInvoice } from "~/jobs/customjewelry/issueDepositInvoice.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { ShopifyDraftOrderAdapter } from "~/shopify/admin/draftOrderAdapter.server";
import { authenticate } from "~/shopify.server";

/**
 * GET/POST /app/custom-jewelry/:id — the staff Custom Jewelry project surface.
 *
 * Mirrors `app.rma.$id.tsx` and `app.warranty-claims.$id.tsx`: the same staff
 * identity discipline (D23 — the AUTHENTICATED Shopify session, never a form
 * field), the same "only offer a control the domain would actually allow"
 * gating, and the same explicit view model rather than a raw Prisma spread.
 * See those routes' headers for the fuller rationale this file does not
 * repeat.
 *
 * A DEFAULT EXPORT WITH AN ACTION — needs a reasoned entry in
 * `csrfResourceRouteFence.test.ts`'s `EXEMPT_UI_ACTION_ROUTES`, on the same
 * argument as its siblings: Shopify Admin iframes this route at the app's own
 * host, so a form submitted from within it is same-origin by construction.
 *
 * ============================================================================
 * THE ONE ACTION HERE MOVES MONEY, SO THE CONTROL IS GATED ON THE RECORD
 * ============================================================================
 * "Issue deposit invoice" appears ONLY when the customer has an acceptance on
 * file and no invoice has gone out. That is UI convenience; the real refusals
 * live in `issueCustomJewelryDepositInvoice` and, beneath it, in the schema —
 * `custom_jewelry_deposit_invoice.acceptance_id` is a NOT NULL foreign key, so
 * an invoice without an acceptance is unrepresentable however this page
 * behaves.
 *
 * The acceptance is shown in full — the exact text the customer agreed to, the
 * label they clicked, when, and the amount they authorized — because a member
 * of staff about to ask someone for money should be able to see precisely what
 * that person agreed to, rather than a green tick.
 *
 * NO CUSTOMER CONTACT HAPPENS HERE. Issuing creates the Shopify draft order
 * and records it; it does not email the customer. Staff send the invoice from
 * the Shopify admin, where they can see exactly what goes out — the invoice
 * email's wording is partly ours and has not been approved.
 *
 * NEVER SHOWS supplier cost, margin or landed cost. There is none on any of
 * these records to begin with, and the customer's budget figure is shown
 * because they volunteered it, not because it is internal pricing data.
 */

// ---------------------------------------------------------------------------
// View model — an explicit field list, never a Prisma spread.
// ---------------------------------------------------------------------------

export interface UploadView {
  readonly id: string;
  readonly kind: string;
  readonly contentType: string;
  readonly uploadedAt: string;
}

export interface AcceptanceView {
  readonly acceptedAt: string;
  /** The EXACT text the customer agreed to, from the acknowledgment row. */
  readonly exactText: string;
  readonly affirmativeActionLabel: string;
  readonly policySlug: string;
  readonly policyVersion: number;
  readonly amountDisplay: string;
  readonly invoice: {
    readonly draftOrderGid: string;
    readonly issuedAt: string;
    readonly issuedByActorRef: string | null;
  } | null;
}

export interface ProjectView {
  readonly id: string;
  readonly projectReference: string;
  readonly status: string;
  readonly customerName: string;
  readonly email: string;
  readonly phone: string;
  /** Null for an anonymous enquiry — see the intake route's module comment. */
  readonly customerRef: string | null;
  readonly startingPoint: string;
  readonly promptText: string;
  readonly jewelryType: string | null;
  readonly inspirationLinks: string | null;
  readonly budgetDisplay: string | null;
  readonly timingDisplay: string;
  readonly followUpPreference: string;
  readonly createdAt: string;
  readonly uploads: readonly UploadView[];
  readonly acceptance: AcceptanceView | null;
}

/**
 * Minor units to a display string, by integer arithmetic and string padding.
 *
 * This repo bans the float path outright, and a staff screen is not an
 * exception — a figure shown to someone about to charge a customer is exactly
 * where a rounding artefact would do damage.
 */
function formatMinorUnits(amountMinorUnits: bigint, currency: string): string {
  const negative = amountMinorUnits < 0n;
  const absolute = negative ? -amountMinorUnits : amountMinorUnits;
  const major = absolute / 100n;
  const minor = absolute % 100n;
  const minorPadded = minor < 10n ? `0${minor}` : `${minor}`;
  return `${negative ? "-" : ""}${major}.${minorPadded} ${currency}`;
}

// ---------------------------------------------------------------------------
// Staff identity — D23, identical discipline to `app.rma.$id.tsx`.
// ---------------------------------------------------------------------------

function resolveStaffActorRef(session: Awaited<ReturnType<typeof authenticate.admin>>["session"]): string | null {
  const associatedUser = session.onlineAccessInfo?.associated_user;
  if (!associatedUser) return null;
  return `staff:${associatedUser.id}`;
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

/** One approval package, as staff read it. Money as strings — never a JSON number. */
export interface ApprovalPackageRow {
  readonly id: string;
  readonly version: number;
  readonly status: string;
  readonly issuedAt: string;
  readonly issuedByActorRef: string;
  readonly approvedAt: string | null;
  readonly approvedByCustomerRef: string | null;
  readonly supersededByVersion: number | null;
  readonly supersededReason: string | null;
  readonly bankPaymentPrice: string;
  readonly regularCardPrice: string;
  readonly depositCredit: string;
  readonly bankPaymentBalanceDue: string;
  readonly regularCardBalanceDue: string;
  readonly acknowledgmentPolicyVersion: number;
  readonly finalSaleCopyVersion: number;
  readonly summary: string;
}

export interface FinalPurchaseRow {
  readonly id: string;
  readonly paymentBasis: string;
  readonly status: string;
  readonly grossApprovedPrice: string;
  readonly depositCredit: string;
  readonly depositPaymentReference: string | null;
  readonly benefitDiscount: string;
  readonly balanceDue: string;
  readonly bankPaymentOrderId: string | null;
  readonly shopifyDraftOrderGid: string | null;
  readonly shopifyOrderGid: string | null;
  readonly paidAt: string | null;
  readonly bankOrderStatus: string | null;
  readonly bankOrderVerifiedAt: string | null;
}

interface LoaderData {
  apiKey: string;
  shop: string;
  project: ProjectView | null;
  /**
   * Every package ever issued, newest first — INCLUDING superseded ones. A
   * superseded version is the evidence of what was offered before the design
   * changed, and the final-sale exception for "material failure to match the
   * approved design" is decided against exactly those rows.
   */
  approvalPackages: readonly ApprovalPackageRow[];
  purchase: FinalPurchaseRow | null;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const id = params.id;
  if (!id) throw new Response("Missing project id.", { status: 400 });

  const row = await prisma.customJewelryProject.findUnique({
    where: { id },
    select: {
      id: true,
      projectReference: true,
      status: true,
      firstName: true,
      lastName: true,
      email: true,
      phone: true,
      customerRef: true,
      startingPoint: true,
      promptText: true,
      jewelryType: true,
      inspirationLinks: true,
      approximateBudgetMinorUnits: true,
      approximateBudgetCurrency: true,
      desiredCompletionDate: true,
      hasNoDeadline: true,
      followUpPreference: true,
      createdAt: true,
      uploads: { select: { id: true, kind: true, contentType: true, uploadedAt: true } },
      depositAcceptance: {
        select: {
          acceptedAt: true,
          amountMinorUnits: true,
          currency: true,
          acknowledgment: {
            select: {
              exactText: true,
              affirmativeActionLabel: true,
              policyVersion: { select: { slug: true, version: true } },
            },
          },
          invoice: { select: { draftOrderGid: true, issuedAt: true, issuedByActorRef: true } },
        },
      },
    },
  });

  const project: ProjectView | null = row
    ? {
        id: row.id,
        projectReference: row.projectReference,
        status: row.status,
        customerName: `${row.firstName} ${row.lastName}`,
        email: row.email,
        phone: row.phone,
        customerRef: row.customerRef,
        startingPoint: row.startingPoint,
        promptText: row.promptText,
        jewelryType: row.jewelryType,
        inspirationLinks: row.inspirationLinks,
        budgetDisplay:
          row.approximateBudgetMinorUnits !== null && row.approximateBudgetCurrency !== null
            ? formatMinorUnits(row.approximateBudgetMinorUnits, row.approximateBudgetCurrency)
            : null,
        // "No deadline" and "not answered" are different answers, so they
        // read differently here rather than both rendering as a blank.
        timingDisplay: row.hasNoDeadline
          ? "No deadline"
          : row.desiredCompletionDate
            ? row.desiredCompletionDate.toISOString().slice(0, 10)
            : "Not specified",
        followUpPreference: row.followUpPreference,
        createdAt: row.createdAt.toISOString(),
        uploads: row.uploads.map((u) => ({
          id: u.id,
          kind: u.kind,
          contentType: u.contentType,
          uploadedAt: u.uploadedAt.toISOString(),
          // DELIBERATELY NO storageKey AND NO URL. Staff needing the file is a
          // separate, authorized retrieval — not a link rendered into every
          // page view.
        })),
        acceptance: row.depositAcceptance
          ? {
              acceptedAt: row.depositAcceptance.acceptedAt.toISOString(),
              exactText: row.depositAcceptance.acknowledgment.exactText,
              affirmativeActionLabel: row.depositAcceptance.acknowledgment.affirmativeActionLabel,
              policySlug: row.depositAcceptance.acknowledgment.policyVersion.slug,
              policyVersion: row.depositAcceptance.acknowledgment.policyVersion.version,
              amountDisplay: formatMinorUnits(
                row.depositAcceptance.amountMinorUnits,
                row.depositAcceptance.currency
              ),
              invoice: row.depositAcceptance.invoice
                ? {
                    draftOrderGid: row.depositAcceptance.invoice.draftOrderGid,
                    issuedAt: row.depositAcceptance.invoice.issuedAt.toISOString(),
                    issuedByActorRef: row.depositAcceptance.invoice.issuedByActorRef,
                  }
                : null,
            }
          : null,
      }
    : null;

  const history = row ? await loadProjectApprovalHistory(row.id) : { packages: [], purchase: null };

  return {
    apiKey: getEnv().SHOPIFY_API_KEY ?? "",
    shop: session.shop,
    project,
    approvalPackages: history.packages.map((pkg) => ({
      id: pkg.id,
      version: pkg.version,
      status: pkg.status,
      issuedAt: pkg.issuedAt.toISOString(),
      issuedByActorRef: pkg.issuedByActorRef,
      approvedAt: pkg.approvedAt?.toISOString() ?? null,
      approvedByCustomerRef: pkg.approvedByCustomerRef,
      supersededByVersion: pkg.supersededByVersion,
      supersededReason: pkg.supersededReason,
      bankPaymentPrice: formatMinorUnits(pkg.bankPaymentPriceMinorUnits, pkg.currency),
      regularCardPrice: formatMinorUnits(pkg.regularCardPriceMinorUnits, pkg.currency),
      depositCredit: formatMinorUnits(pkg.depositCreditMinorUnits, pkg.currency),
      bankPaymentBalanceDue: formatMinorUnits(pkg.bankPaymentBalanceDueMinorUnits, pkg.currency),
      regularCardBalanceDue: formatMinorUnits(pkg.regularCardBalanceDueMinorUnits, pkg.currency),
      acknowledgmentPolicyVersion: pkg.approvalAcknowledgmentPolicyVersion,
      finalSaleCopyVersion: pkg.finalSaleCopyVersion,
      // Enough of the spec to tell versions apart at a glance, which is what a
      // list of them is for. The full spec lives on the package itself.
      summary: [pkg.metalColor, pkg.metalType, pkg.ringSize ? `size ${pkg.ringSize}` : null, pkg.engraving ? `engraved "${pkg.engraving}"` : null]
        .filter((part): part is string => part !== null && part !== "")
        .join(", "),
    })),
    purchase: history.purchase
      ? {
          id: history.purchase.id,
          paymentBasis: history.purchase.paymentBasis,
          status: history.purchase.status,
          grossApprovedPrice: formatMinorUnits(
            history.purchase.grossApprovedPriceMinorUnits,
            history.purchase.currency
          ),
          depositCredit: formatMinorUnits(history.purchase.depositCreditMinorUnits, history.purchase.currency),
          depositPaymentReference: history.purchase.depositPaymentReference,
          benefitDiscount: formatMinorUnits(
            history.purchase.benefitDiscountMinorUnits,
            history.purchase.currency
          ),
          balanceDue: formatMinorUnits(history.purchase.balanceDueMinorUnits, history.purchase.currency),
          bankPaymentOrderId: history.purchase.bankPaymentOrderId,
          shopifyDraftOrderGid: history.purchase.shopifyDraftOrderGid,
          shopifyOrderGid: history.purchase.shopifyOrderGid,
          paidAt: history.purchase.paidAt?.toISOString() ?? null,
          bankOrderStatus: history.purchase.bankOrderStatus,
          bankOrderVerifiedAt: history.purchase.bankOrderVerifiedAt?.toISOString() ?? null,
        }
      : null,
  } satisfies LoaderData;
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

interface ActionData {
  error?: string;
  notice?: string;
}

/**
 * Issuing a final approval package.
 *
 * ============================================================================
 * STAFF TYPE THE BANK PRICE. THEY NEVER TYPE THE CARD PRICE.
 * ============================================================================
 * The Bank Payment Price is the authoritative underlying figure and the
 * Regular/Card Price is DERIVED from it by the locked tiered rule
 * (`CLAUDE.md` rules 11-12, `docs/BANK-CARD-PRICING.md`). A typed card price
 * would be a second pricing engine with a human in it — and the one case it
 * would get wrong is the one nobody notices: a card price a few dollars under
 * the correct tier, on a single bespoke piece, forever.
 *
 * THEY NEVER TYPE THE DEPOSIT CREDIT EITHER. `issueApprovalPackage` reads it
 * from the recorded payment, so the credit always points at a transaction that
 * actually happened.
 *
 * The timeline is free text with NO default. The owner forbade unsupported
 * turnaround promises, and a templated sentence here is precisely how one
 * would appear — so an empty field means "nothing agreed", which is honest.
 */
async function issueApprovalPackageAction(input: {
  projectId: string;
  staffActorRef: string;
  formData: FormData;
}): Promise<ActionData> {
  const text = (name: string): string | undefined => {
    const value = String(input.formData.get(name) ?? "").trim();
    return value === "" ? undefined : value;
  };

  const metalType = text("metalType");
  const metalColor = text("metalColor");
  if (!metalType || !metalColor) {
    return { error: "Metal type and colour are required — they are part of what the customer approves." };
  }

  // MONEY FROM A FORM, PARSED AS AN EXACT DECIMAL. Never `Number()`, never a
  // float: `parseMoneyInput` is the one place this repo converts typed money,
  // and it refuses anything it cannot represent exactly.
  const bankPriceRaw = String(input.formData.get("bankPaymentPrice") ?? "").trim();
  let bankPaymentPrice;
  try {
    bankPaymentPrice = parseStaffMoneyInput(bankPriceRaw, "USD");
  } catch (error) {
    return { error: error instanceof Error ? error.message : "The Bank Payment Price could not be read." };
  }

  // THE CARD PRICE, DERIVED. The profile carries the locked rule and its rate;
  // reading the ACTIVE profile here is correct because a new package is being
  // priced now, unlike a historical calculation which carries its own.
  //
  // ==========================================================================
  // ONE RESOLVER, SHARED WITH THE REST OF PRICING. DO NOT REPLACE THIS WITH A
  // LOCAL QUERY AGAIN.
  // ==========================================================================
  // This was `findFirst({ where: { code, isPlaceholder: false }, orderBy:
  // { version: "desc" } })` — a second, subtly different definition of "the
  // active profile". It had NO `effectiveFrom` filter, so a future-dated
  // profile version took effect here the instant it was inserted while
  // `resolveActivePricingProfile` correctly ignored it until its date, and
  // Custom Jewelry quoted a card price the rest of the system would not agree
  // with. Not hypothetical: `frozenRuleVersioning.test.ts` inserts a row dated
  // 2999-01-01, and the new pricing-settings surface makes operator-created
  // versions routine.
  //
  // Resolution now comes from the same repository function Buy Now uses, so
  // there is one definition of "current profile" in the codebase.
  // `customJewelryProfileResolution.test.ts` pins this.
  let profile;
  try {
    profile = await resolveActivePricingProfile("buy_now", new Date());
  } catch {
    return {
      error:
        "No active Buy Now pricing profile is provisioned, so the Regular/Card Price cannot be derived. " +
        "This is a configuration problem, not a data-entry one.",
    };
  }
  // PLACEHOLDER REFUSAL IS PRESERVED, but now applies to the profile that is
  // genuinely in effect rather than to whichever non-placeholder row happened
  // to have the highest version. A placeholder in effect is a configuration
  // fault and must stop the quote, exactly as the price-review CLI refuses to
  // sync a price computed from one.
  if (profile.isPlaceholder) {
    return {
      error:
        "The active Buy Now pricing profile is a placeholder, so the Regular/Card Price cannot be derived. " +
        "This is a configuration problem, not a data-entry one.",
    };
  }
  const derived = deriveRegularCardPrice(
    bankPaymentPrice.amountMinorUnits,
    new MoneyDecimal(profile.fixedCardUpliftRate.toString()),
    profile.regularCardPriceRuleId as RegularCardPriceRuleId
  );

  let mediaReferences: unknown;
  try {
    mediaReferences = JSON.parse(String(input.formData.get("mediaReferences") ?? "[]"));
  } catch {
    return { error: "The CAD/media references are not valid JSON." };
  }

  const optionalJson = (name: string): unknown | undefined => {
    const raw = text(name);
    if (raw === undefined) return undefined;
    try {
      return JSON.parse(raw);
    } catch {
      throw new Error(`${name} is not valid JSON.`);
    }
  };

  let centerStone: unknown | undefined;
  let accentStones: unknown | undefined;
  let agreedCustomizations: unknown | undefined;
  try {
    centerStone = optionalJson("centerStone");
    accentStones = optionalJson("accentStones");
    agreedCustomizations = optionalJson("agreedCustomizations");
  } catch (error) {
    return { error: error instanceof Error ? error.message : "A JSON field could not be read." };
  }

  const result = await issueApprovalPackage({
    projectId: input.projectId,
    spec: {
      metalType,
      metalColor,
      ...(centerStone !== undefined ? { centerStone: centerStone as never } : {}),
      ...(accentStones !== undefined ? { accentStones: accentStones as never } : {}),
      dimensions: text("dimensions"),
      ringSize: text("ringSize"),
      engraving: text("engraving"),
      constructionNotes: text("constructionNotes"),
      ...(agreedCustomizations !== undefined
        ? { agreedCustomizations: agreedCustomizations as never }
        : {}),
      mediaReferences: mediaReferences as never,
      approvedTimelineText: text("approvedTimelineText"),
    },
    bankPaymentPrice,
    regularCardPrice: Money.fromMinorUnits(derived.regularCardPriceMinorUnits, "USD"),
    issuedByActorRef: input.staffActorRef,
    supersedesReason: text("supersedesReason"),
    now: new Date(),
  });

  if (result.outcome === "already_approved") {
    // STAFF CANNOT SILENTLY REPLACE WHAT A CUSTOMER APPROVED. The trigger
    // refuses it too; this is the readable version of the same rule.
    return {
      error:
        `The customer already approved version ${result.approvedVersion}. A change now is a commercial ` +
        `conversation, not a re-issue — the approved package is what the final-sale terms rest on.`,
    };
  }

  logger.info("custom_jewelry_admin.approval_package_issued", {
    projectId: input.projectId,
    version: result.package.version,
    actor: input.staffActorRef,
  });
  return {
    notice:
      `Approval package version ${result.package.version} issued` +
      (result.supersededVersion !== null ? `, superseding version ${result.supersededVersion}` : "") +
      `. Card price derived as ${derived.regularCardPriceMinorUnits} minor units from the Bank Payment ` +
      `Price you entered. Send the customer their approval link when ready.`,
  };
}

/**
 * Typed money to exact minor units.
 *
 * NO FLOAT, ANYWHERE. A staff member types "5175.00"; this reads it as a
 * decimal string and converts by integer arithmetic. `Number("5175.00") * 100`
 * is the obvious version and is wrong for values this repo will certainly see.
 */
function parseStaffMoneyInput(raw: string, currency: string): Money {
  const cleaned = raw.replace(/[$,\s]/g, "");
  if (!/^\d+(\.\d{1,2})?$/.test(cleaned)) {
    throw new Error(
      `"${raw}" is not a price. Enter a plain amount such as 5175 or 5175.00 — no currency symbol needed.`
    );
  }
  const [whole, fraction = ""] = cleaned.split(".");
  const minorUnits = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, "0"));
  if (minorUnits <= 0n) throw new Error("The Bank Payment Price must be greater than zero.");
  return Money.fromMinorUnits(minorUnits, currency);
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { session, admin } = await authenticate.admin(request);
  const id = params.id;
  if (!id) return { error: "Missing project id." } satisfies ActionData;

  const staffActorRef = resolveStaffActorRef(session);
  if (!staffActorRef) {
    // Offline sessions carry no associated user, so there is no staff identity
    // to record against an action that moves money. Refuse rather than
    // attribute it to nobody.
    return {
      error: "Could not identify the signed-in staff user. Open this page from Shopify Admin and try again.",
    } satisfies ActionData;
  }

  const formData = await request.formData();
  const intent = formData.get("intent");

  if (intent === "issue_approval_package") {
    return issueApprovalPackageAction({ projectId: id, staffActorRef, formData });
  }

  if (intent !== "issue_deposit_invoice") {
    return { error: "Unrecognised action." } satisfies ActionData;
  }

  const result = await issueCustomJewelryDepositInvoice({
    projectId: id,
    issuedByActorRef: staffActorRef,
    draftOrders: new ShopifyDraftOrderAdapter(admin),
  });

  switch (result.outcome) {
    case "issued":
      logger.info("custom_jewelry_admin.deposit_invoice_issued", { projectId: id, actor: staffActorRef });
      return {
        notice:
          "Deposit invoice created in Shopify as a draft order. It has NOT been emailed — send the invoice from " +
          "Shopify Admin when you are ready.",
      } satisfies ActionData;
    case "already_issued":
      return { error: "This deposit already has an invoice. Issuing a second would let the customer pay twice." } satisfies ActionData;
    case "not_accepted":
      return {
        error:
          "The customer has not accepted the Design Deposit terms yet. They must do that before an invoice can be issued.",
      } satisfies ActionData;
    case "amount_mismatch":
      return {
        error:
          "The amount this customer authorized no longer matches the current deposit price, so no invoice was issued. " +
          "They need to accept the current terms before being charged.",
      } satisfies ActionData;
    case "project_not_found":
      return { error: "Project not found." } satisfies ActionData;
  }
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export default function CustomJewelryProjectPage() {
  const { apiKey, shop, project, approvalPackages, purchase } = useLoaderData<LoaderData>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const submitting = navigation.state === "submitting";

  return (
    <AppProvider apiKey={apiKey}>
      <main style={{ padding: "1.5rem", maxWidth: "60rem" }}>
        {!project ? (
          <p>Project not found.</p>
        ) : (
          <>
            <h1 style={{ marginTop: 0 }}>Custom Jewelry — {project.projectReference}</h1>
            <p>
              Status: <strong>{project.status}</strong> · Submitted {project.createdAt}
            </p>

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

            <h2>Customer</h2>
            <dl>
              <dt>Name</dt>
              <dd>{project.customerName}</dd>
              <dt>Email</dt>
              <dd>{project.email}</dd>
              <dt>Phone</dt>
              <dd>{project.phone}</dd>
              <dt>Account</dt>
              {/* An anonymous enquiry is normal, not a defect — intake is
                  deliberately open to signed-out visitors. */}
              <dd>{project.customerRef ?? "Not signed in when they submitted"}</dd>
              <dt>Preferred follow-up</dt>
              <dd>{project.followUpPreference}</dd>
            </dl>

            <h2>The request</h2>
            <dl>
              <dt>Starting point</dt>
              <dd>{project.startingPoint}</dd>
              <dt>Type of piece</dt>
              <dd>{project.jewelryType ?? "Not specified"}</dd>
              <dt>Approximate budget</dt>
              <dd>{project.budgetDisplay ?? "Not specified"}</dd>
              <dt>Timing</dt>
              <dd>{project.timingDisplay}</dd>
            </dl>
            <p style={{ whiteSpace: "pre-wrap" }}>{project.promptText}</p>

            {project.inspirationLinks ? (
              <>
                <h2>Inspiration links</h2>
                {/* PLAIN TEXT, NEVER RENDERED AS ANCHORS. These are
                    customer-supplied URLs; nothing server-side fetches them
                    (that would be an SSRF primitive) and nothing here makes
                    them one-click from an admin page. Staff copy them
                    deliberately. */}
                <p style={{ whiteSpace: "pre-wrap", wordBreak: "break-all" }}>{project.inspirationLinks}</p>
              </>
            ) : null}

            <h2>Inspiration files ({project.uploads.length})</h2>
            {project.uploads.length === 0 ? (
              <p>None attached.</p>
            ) : (
              <ul>
                {project.uploads.map((upload) => (
                  <li key={upload.id}>
                    {upload.kind} · {upload.contentType} · {upload.uploadedAt}
                  </li>
                ))}
              </ul>
            )}

            <h2>Design Deposit</h2>
            {!project.acceptance ? (
              <p>
                The customer has not accepted the Design Deposit terms yet. No invoice can be issued until they do.
              </p>
            ) : (
              <>
                <p>
                  Authorized <strong>{project.acceptance.amountDisplay}</strong> on {project.acceptance.acceptedAt} by
                  clicking &ldquo;{project.acceptance.affirmativeActionLabel}&rdquo; ({project.acceptance.policySlug} v
                  {project.acceptance.policyVersion}).
                </p>
                {/* THE EXACT TEXT, IN FULL. A member of staff about to ask
                    someone for money should see precisely what that person
                    agreed to, not a green tick. */}
                <blockquote style={{ whiteSpace: "pre-wrap", borderLeft: "3px solid #888", paddingLeft: "1rem" }}>
                  {project.acceptance.exactText}
                </blockquote>

                {project.acceptance.invoice ? (
                  <p>
                    Invoice issued {project.acceptance.invoice.issuedAt} by{" "}
                    {project.acceptance.invoice.issuedByActorRef ?? "unknown"} — Shopify draft order{" "}
                    {project.acceptance.invoice.draftOrderGid}. Send or re-send it from Shopify Admin.
                  </p>
                ) : (
                  <Form method="post">
                    <input type="hidden" name="intent" value="issue_deposit_invoice" />
                    <button type="submit" disabled={submitting}>
                      {submitting ? "Creating…" : "Issue deposit invoice"}
                    </button>
                    <p>
                      Creates a Shopify draft order for {project.acceptance.amountDisplay}. It does{" "}
                      <strong>not</strong> email the customer — send the invoice from Shopify Admin when you are ready.
                    </p>
                  </Form>
                )}
              </>
            )}

            {/* The pinned constants, shown so staff can see at a glance whether
                a stored acceptance matches what the current page would show a
                customer. A divergence here is what `amount_mismatch` refuses
                on. */}
            <details>
              <summary>Current deposit terms (for comparison)</summary>
              <blockquote style={{ whiteSpace: "pre-wrap" }}>{CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT}</blockquote>
              <p>Affirmative action label: {CUSTOM_JEWELRY_DEPOSIT_AFFIRMATIVE_ACTION_LABEL}</p>
            </details>

            {/* ==========================================================
                FINAL APPROVAL AND PURCHASE
                ==========================================================
                The purchase comes FIRST when one exists, because "has this
                been paid for" is the question a staff member opening a
                purchased project is actually asking. */}
            <h2>Final approval and purchase</h2>

            {purchase ? (
              <section aria-labelledby="purchase-heading">
                <h3 id="purchase-heading">Purchase</h3>
                <dl>
                  <dt>Basis</dt>
                  <dd>{purchase.paymentBasis === "bank_payment" ? "Bank Payment" : "Card"}</dd>
                  <dt>State</dt>
                  <dd>
                    {purchase.status}
                    {/* THE ANOMALY THAT MATTERS MOST, named in place rather
                        than left for a queue: the money arrived and our
                        record did not catch up. */}
                    {purchase.status === "awaiting_payment" && purchase.bankOrderVerifiedAt ? (
                      <strong role="alert">
                        {" "}
                        — funds were verified at {purchase.bankOrderVerifiedAt} but this purchase is still
                        awaiting payment. The customer has paid and nothing downstream knows.
                      </strong>
                    ) : null}
                    {purchase.status === "awaiting_payment" && purchase.bankOrderStatus === "cancelled" ? (
                      <strong role="alert"> — the bank payment order was cancelled; the balance will not arrive.</strong>
                    ) : null}
                  </dd>
                  {/* THE GROSS PRICE FIRST. The deposit is a credit against it,
                      not a discount to it, so the price is what the piece sold
                      for and the balance is merely what was collected. */}
                  <dt>Approved price (gross)</dt>
                  <dd>{purchase.grossApprovedPrice}</dd>
                  <dt>Design Deposit credit</dt>
                  <dd>
                    {purchase.depositCredit}
                    {purchase.depositPaymentReference ? ` (paid on ${purchase.depositPaymentReference})` : ""}
                  </dd>
                  <dt>Let Us Beat Your Quote benefit</dt>
                  <dd>{purchase.benefitDiscount}</dd>
                  <dt>Balance due</dt>
                  <dd>
                    <strong>{purchase.balanceDue}</strong>
                  </dd>
                  <dt>Paid</dt>
                  <dd>{purchase.paidAt ?? "Not yet"}</dd>
                  <dt>Shopify</dt>
                  <dd>
                    {purchase.shopifyOrderGid ??
                      purchase.shopifyDraftOrderGid ??
                      (purchase.bankPaymentOrderId
                        ? `bank payment order ${purchase.bankPaymentOrderId}`
                        : "none recorded")}
                  </dd>
                </dl>
              </section>
            ) : null}

            {approvalPackages.length === 0 ? (
              <p>No approval package has been issued for this project yet.</p>
            ) : (
              <table style={{ borderCollapse: "collapse", width: "100%" }}>
                <caption style={{ captionSide: "bottom", textAlign: "left", paddingTop: "0.5rem" }}>
                  Every version ever issued, newest first. Superseded versions are kept: they are the
                  evidence of what was offered before the design changed, and a claim about the approved
                  design is decided against them.
                </caption>
                <thead>
                  <tr>
                    <th scope="col" style={{ textAlign: "left" }}>Version</th>
                    <th scope="col" style={{ textAlign: "left" }}>State</th>
                    <th scope="col" style={{ textAlign: "left" }}>Summary</th>
                    <th scope="col" style={{ textAlign: "left" }}>Bank price</th>
                    <th scope="col" style={{ textAlign: "left" }}>Card price</th>
                    <th scope="col" style={{ textAlign: "left" }}>Deposit credit</th>
                    <th scope="col" style={{ textAlign: "left" }}>Balance (bank / card)</th>
                    <th scope="col" style={{ textAlign: "left" }}>Issued</th>
                    <th scope="col" style={{ textAlign: "left" }}>Customer approved</th>
                  </tr>
                </thead>
                <tbody>
                  {approvalPackages.map((pkg) => (
                    <tr key={pkg.id}>
                      <td>v{pkg.version}</td>
                      <td>
                        {pkg.status}
                        {pkg.supersededByVersion !== null ? ` (by v${pkg.supersededByVersion})` : ""}
                        {/* WHY it was replaced, in full. Without it the table
                            records that a design changed but not what the
                            customer asked for — which is the part a later
                            conversation actually needs. */}
                        {pkg.supersededReason !== null ? (
                          <>
                            <br />
                            <small>{pkg.supersededReason}</small>
                          </>
                        ) : null}
                      </td>
                      <td>{pkg.summary}</td>
                      <td>{pkg.bankPaymentPrice}</td>
                      <td>{pkg.regularCardPrice}</td>
                      <td>{pkg.depositCredit}</td>
                      <td>
                        {pkg.bankPaymentBalanceDue} / {pkg.regularCardBalanceDue}
                      </td>
                      <td>
                        {pkg.issuedAt.slice(0, 16).replace("T", " ")} by {pkg.issuedByActorRef}
                      </td>
                      <td style={pkg.approvedAt ? { fontWeight: 600 } : undefined}>
                        {pkg.approvedAt
                          ? `${pkg.approvedAt.slice(0, 16).replace("T", " ")} (ack v${pkg.acknowledgmentPolicyVersion}, final-sale v${pkg.finalSaleCopyVersion})`
                          : "Not yet"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}

            {/* ==========================================================
                ISSUE A PACKAGE
                ==========================================================
                Hidden once the customer has approved one. Staff must not
                silently replace what a customer approved — the trigger refuses
                it, and offering a form that cannot work is its own defect. */}
            {approvalPackages.some((pkg) => pkg.status === "approved") ? (
              <p>
                The customer has approved a version. A change now is a commercial conversation, not a
                re-issue — the approved package is what the final-sale terms rest on.
              </p>
            ) : (
              <Form method="post">
                <input type="hidden" name="intent" value="issue_approval_package" />
                <h3>Issue a final approval package</h3>
                <p>
                  Enter the <strong>Bank Payment Price</strong> only. The Regular/Card Price is derived
                  from it by the locked tiered rule — typing it would be a second pricing engine. The
                  Design Deposit credit is read from the recorded payment and is never entered here.
                </p>

                <label htmlFor="bankPaymentPrice">Bank Payment Price (USD)</label>
                <br />
                <input id="bankPaymentPrice" name="bankPaymentPrice" required inputMode="decimal" />
                <br />

                <label htmlFor="metalType">Metal type</label>
                <br />
                <input id="metalType" name="metalType" required />
                <br />
                <label htmlFor="metalColor">Metal colour</label>
                <br />
                <input id="metalColor" name="metalColor" required />
                <br />

                <label htmlFor="centerStone">Centre stone (JSON, blank if none)</label>
                <br />
                <textarea id="centerStone" name="centerStone" rows={2} cols={60} />
                <br />
                <label htmlFor="accentStones">Accent/side stones (JSON, blank if none)</label>
                <br />
                <textarea id="accentStones" name="accentStones" rows={2} cols={60} />
                <br />

                <label htmlFor="dimensions">Dimensions</label>
                <br />
                <input id="dimensions" name="dimensions" />
                <br />
                <label htmlFor="ringSize">Ring size (blank if not applicable)</label>
                <br />
                <input id="ringSize" name="ringSize" />
                <br />
                <label htmlFor="engraving">Engraving (blank if none)</label>
                <br />
                <input id="engraving" name="engraving" />
                <br />
                <label htmlFor="constructionNotes">Construction notes</label>
                <br />
                <textarea id="constructionNotes" name="constructionNotes" rows={2} cols={60} />
                <br />
                <label htmlFor="agreedCustomizations">Agreed customizations (JSON, blank if none)</label>
                <br />
                <textarea id="agreedCustomizations" name="agreedCustomizations" rows={2} cols={60} />
                <br />

                <label htmlFor="mediaReferences">CAD / rendering / image references (JSON array)</label>
                <br />
                <textarea id="mediaReferences" name="mediaReferences" rows={3} cols={60} defaultValue="[]" />
                <br />

                {/* NO DEFAULT, AND THE LABEL SAYS WHY. The owner forbade
                    unsupported turnaround promises; a templated sentence here
                    is exactly how one would appear. */}
                <label htmlFor="approvedTimelineText">
                  Production/timeline information — only what has actually been agreed. Leave blank if
                  nothing has.
                </label>
                <br />
                <textarea id="approvedTimelineText" name="approvedTimelineText" rows={2} cols={60} />
                <br />

                {approvalPackages.length > 0 ? (
                  <>
                    <label htmlFor="supersedesReason">Why does this replace the current version?</label>
                    <br />
                    <input id="supersedesReason" name="supersedesReason" />
                    <br />
                  </>
                ) : null}

                <button type="submit" disabled={submitting}>
                  {submitting ? "Issuing…" : "Issue approval package"}
                </button>
              </Form>
            )}

            <p style={{ marginTop: "2rem", fontSize: "0.9rem" }}>Shop: {shop}</p>
          </>
        )}
      </main>
    </AppProvider>
  );
}

export const headers: HeadersFunction = (headersArgs) => boundary.headers(headersArgs);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
