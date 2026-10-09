import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation, useRouteError } from "react-router";

import { prisma } from "~/db/client.server";
import {
  CUSTOM_JEWELRY_DEPOSIT_ACKNOWLEDGMENT_TEXT,
  CUSTOM_JEWELRY_DEPOSIT_AFFIRMATIVE_ACTION_LABEL,
} from "~/domain/customjewelry/designDepositAcknowledgmentText";
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

interface LoaderData {
  apiKey: string;
  shop: string;
  project: ProjectView | null;
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

  return { apiKey: getEnv().SHOPIFY_API_KEY ?? "", shop: session.shop, project } satisfies LoaderData;
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

interface ActionData {
  error?: string;
  notice?: string;
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
  const { apiKey, shop, project } = useLoaderData<LoaderData>();
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
