import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, useActionData, useLoaderData, useNavigation, useRouteError } from "react-router";

import { AdminNavigation } from "~/components/AdminNavigation";
import { listPendingIntents } from "~/db/repositories/priceSyncIntentRepository.server";
import { MoneyDecimal } from "~/domain/money/decimal";
import { deriveRegularCardPrice } from "~/domain/pricing/regularCardPrice";
import type { RegularCardPriceRuleId } from "~/domain/pricing/types";
import { decideAndSyncIntent } from "~/jobs/pricing/decideAndSyncIntent.server";
import { decideIntent } from "~/jobs/pricing/intentTransitions.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { authenticate } from "~/shopify.server";

/**
 * GET/POST /app/price-approvals — the human decision queue for prices.
 *
 * ===========================================================================
 * THIS SUPERSEDES `scripts/price-review.ts`
 * ===========================================================================
 * That script's own header calls itself a Slice 1 stopgap awaiting an admin
 * UI. Until now, approving a recalculated price required shell access to
 * production. This is that UI. The script is left in place: it is the
 * break-glass path and it calls exactly the same functions, so the two cannot
 * disagree about what approval means.
 *
 * ===========================================================================
 * A UI OVER THE EXISTING WORKFLOW, NOT A SECOND PRICING ENGINE
 * ===========================================================================
 * Nothing here calculates a price, decides whether approval is needed, or
 * talks to Shopify directly. Approve calls `decideAndSyncIntent`, the one
 * function that runs the state transition and then the single real publish
 * path; reject calls `decideIntent`, the pure transition. Every protection
 * those already carry stays where it is: allowed transitions, the D14
 * placeholder guard, supersession, the audit event, sync-failure recording,
 * admin alerts and retry. This route adds a list and two buttons.
 *
 * ===========================================================================
 * "APPROVED" IS NOT SAID UNLESS SHOPIFY ALSO PUBLISHED
 * ===========================================================================
 * `decideAndSyncIntent` returns the decision and the publish attempt
 * separately, precisely because they can disagree: the approval commits in
 * its own transaction and a later Shopify failure must neither un-approve it
 * nor be swallowed. Every outcome below is reported as what it actually was.
 * A bare "Approved" after a failed publish would tell an operator the price
 * is live when it is not, and the price on the storefront is the one thing
 * this screen must never lie about.
 *
 * ===========================================================================
 * WHAT AN OPERATOR MAY SEE
 * ===========================================================================
 * Product, variant, the previous and proposed Bank Payment Price, the derived
 * Regular/Card Price, the size of the change, why approval is required, when
 * it was calculated, and the status. Nothing else.
 *
 * NOT shown, and deliberately never loaded into the view model: landed cost,
 * supplier cost, cost components, margin, or the profile's internal rates.
 * `priceCalculation.landedCostMinorUnits` sits one field away from the price
 * in the same row, so the view model is built field by field rather than by
 * spreading the record.
 */

export const headers: HeadersFunction = (args) => boundary.headers(args);

// ---------------------------------------------------------------------------
// Staff identity — D23. Duplicated from the other admin routes for the reason
// stated there: a shared helper under app/routes/ would itself become a
// route, because React Router flat-routes treats dots as path separators.
// ---------------------------------------------------------------------------

function resolveStaffActorRef(
  session: Awaited<ReturnType<typeof authenticate.admin>>["session"]
): string | null {
  const associatedUser = session.onlineAccessInfo?.associated_user;
  if (!associatedUser) return null;
  return `staff:${associatedUser.id}`;
}

/** Minor units to a displayable amount. Never floats: BigInt throughout. */
function formatMinorUnits(amountMinorUnits: bigint, currency: string): string {
  const negative = amountMinorUnits < 0n;
  const absolute = negative ? -amountMinorUnits : amountMinorUnits;
  const major = absolute / 100n;
  const minor = absolute % 100n;
  return `${negative ? "-" : ""}${major}.${minor.toString().padStart(2, "0")} ${currency}`;
}

/**
 * Basis points as a percentage, with no floating point and no rounding call.
 *
 * The obvious fixed-decimal formatter would have been shorter, and the
 * money-safety gate flags it repository-wide, correctly: the gate is lexical
 * and cannot know these are basis points rather than money. Rather than
 * argue for an allow-list entry on a financial display, the arithmetic is
 * exact instead. Basis points are integers, so hundredths divide out cleanly
 * and there is nothing to round.
 *
 * (The gate is lexical in comments too, so this one deliberately does not
 * name the forbidden call.)
 */
function bpsToPercentString(bps: number): string {
  const abs = Math.abs(bps);
  const whole = (abs - (abs % 100)) / 100;
  const hundredths = abs % 100;
  return `${whole}.${String(hundredths).padStart(2, "0")}`;
}

function formatBps(bps: number | null): string {
  if (bps === null) return "n/a";
  const sign = bps > 0 ? "+" : bps < 0 ? "-" : "";
  return `${sign}${bpsToPercentString(bps)}% (${sign}${Math.abs(bps)} bps)`;
}

/**
 * A readable variant identity.
 *
 * MasterVariant has no SKU column: a variant is identified by its metal,
 * purity and ring-size band. The band is included only when present, because
 * not every product is sized.
 */
function describeVariant(variant: {
  metal: string;
  purity: string;
  bandId: string | null;
}): string {
  const band = variant.bandId ? `band ${variant.bandId.slice(0, 8)}` : null;
  return [variant.metal, variant.purity, band].filter(Boolean).join(" / ");
}

export interface ApprovalRowView {
  readonly intentId: string;
  readonly productTitle: string;
  readonly variantLabel: string;
  readonly previousBankPaymentPrice: string | null;
  readonly proposedBankPaymentPrice: string;
  readonly proposedRegularCardPrice: string;
  readonly change: string;
  readonly approvalReason: string;
  readonly calculatedAt: string;
  readonly status: string;
}

interface LoaderData {
  readonly apiKey: string;
  readonly rows: readonly ApprovalRowView[];
}

/**
 * Why this one needs a person.
 *
 * Read off the intent rather than recomputed: the threshold that produced
 * `needs_approval` was applied when the intent was written, and re-deciding
 * it here could disagree with the record.
 */
function approvalReasonFor(deltaBps: number | null): string {
  if (deltaBps === null) {
    return "Flagged for approval (no previous published price to compare).";
  }
  return `Change of ${bpsToPercentString(deltaBps)}% exceeds the 2% auto-publish threshold.`;
}

export async function loader({ request }: LoaderFunctionArgs) {
  await authenticate.admin(request);

  // Already filtered to `pending_approval` by the repository, so approved,
  // rejected, syncing, synced and superseded intents cannot appear here.
  const intents = await listPendingIntents();

  const rows: ApprovalRowView[] = intents.map((intent) => {
    const calc = intent.priceCalculation;
    // THE CALCULATION'S OWN PROFILE, never today's active one: the same rule
    // the publish path follows, so the figure shown is the figure that would
    // be published.
    const derived = deriveRegularCardPrice(
      calc.bankPaymentPriceMinorUnits,
      new MoneyDecimal(calc.pricingProfile.fixedCardUpliftRate.toString()),
      calc.pricingProfile.regularCardPriceRuleId as RegularCardPriceRuleId
    );

    return {
      intentId: intent.id,
      productTitle: intent.masterVariant.masterProduct.name,
      variantLabel: describeVariant(intent.masterVariant),
      previousBankPaymentPrice:
        intent.previousBankPaymentPriceMinorUnits !== null &&
        intent.previousBankPaymentPriceCurrency !== null
          ? formatMinorUnits(
              intent.previousBankPaymentPriceMinorUnits,
              intent.previousBankPaymentPriceCurrency
            )
          : null,
      proposedBankPaymentPrice: formatMinorUnits(calc.bankPaymentPriceMinorUnits, calc.currency),
      proposedRegularCardPrice: formatMinorUnits(
        derived.regularCardPriceMinorUnits,
        calc.currency
      ),
      change: formatBps(intent.deltaBps),
      approvalReason: approvalReasonFor(intent.deltaBps),
      calculatedAt: calc.createdAt.toISOString(),
      status: intent.status,
    };
  });

  return { apiKey: getEnv().SHOPIFY_API_KEY ?? "", rows } satisfies LoaderData;
}

type ActionResult =
  | { readonly tone: "success"; readonly message: string }
  | { readonly tone: "warning"; readonly message: string }
  | { readonly tone: "error"; readonly message: string };

/**
 * Turn the real result into the sentence an operator should read.
 *
 * Exported so the tests assert the mapping itself, not a rendered string:
 * the thing that must never regress is that a failed publish cannot produce
 * a success tone.
 */
export function describeApprovalOutcome(
  result: Awaited<ReturnType<typeof decideAndSyncIntent>>
): ActionResult {
  if (result.syncError) {
    return {
      tone: "error",
      message:
        "Approved and recorded, but publishing to Shopify FAILED. The price is not live. " +
        "The sync failure has been recorded and will retry; check Pricing Alerts.",
    };
  }

  const sync = result.sync;
  if (!sync) {
    return { tone: "warning", message: "Decision recorded. No publish was attempted." };
  }

  switch (sync.kind) {
    case "synced":
      return { tone: "success", message: "Approved and published to Shopify." };
    case "already_synced":
      return { tone: "warning", message: "Already synced. No change was published." };
    case "superseded":
      return {
        tone: "warning",
        message: "Superseded by a newer calculation. Nothing was published for this intent.",
      };
    case "placeholder_refused":
      return {
        tone: "error",
        message:
          "Refused: this price came from a placeholder pricing profile. " +
          "Publishing was blocked. Configure a real profile in Pricing Settings.",
      };
    case "not_applicable":
      return {
        tone: "warning",
        message: `Not applicable: ${sync.reason}. The state changed before this decision was applied.`,
      };
  }
}

export async function action({ request }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);

  // IDENTITY COMES FROM THE ONLINE SESSION, NEVER THE FORM. A posted actor
  // field would let a browser claim to be anyone in an append-only pricing
  // audit trail.
  const actor = resolveStaffActorRef(session);
  if (!actor) {
    return {
      tone: "error",
      message:
        "No associated Shopify staff user on this session. Open the app from Shopify Admin and sign in.",
    } satisfies ActionResult;
  }

  const form = await request.formData();
  const intentId = String(form.get("intentId") ?? "").trim();
  const decision = String(form.get("decision") ?? "").trim();
  const reason = String(form.get("reason") ?? "").trim();

  if (!intentId) {
    return { tone: "error", message: "Missing intent." } satisfies ActionResult;
  }

  try {
    if (decision === "reject") {
      // A reason is required: a rejection with no recorded why is an
      // unexplained price decision in an append-only history.
      if (!reason) {
        return {
          tone: "error",
          message: "A rejection reason is required.",
        } satisfies ActionResult;
      }
      // decideIntent only. A rejection never reaches Shopify.
      await decideIntent({ intentId, status: "rejected", actor, reason });
      logger.info("pricing.intent_rejected_via_admin", { intentId });
      return { tone: "success", message: "Rejected. Nothing was published." } satisfies ActionResult;
    }

    if (decision === "approve") {
      /**
       * BOTH DEPENDENCIES, matching the scheduled path exactly.
       *
       * `internal.jobs.price-recalculation.tsx` builds a sync port AND
       * metafield publish deps from this same module and passes both into
       * the pricing workflow. This route previously passed only the port,
       * which made manual approval quietly weaker than auto-publish: on a
       * successful sync `syncApprovedPriceSyncIntent` uses `metafields` to
       * write the variant Bank Payment Price metafield and recompute the
       * product-level As Low As. Without it the Regular/Card Price would
       * publish to Shopify while the Bank Payment presentation data stayed
       * stale or missing, so a storefront could show a fresh card price
       * beside an old bank price.
       *
       * Dynamically imported for the reason the module's own header gives:
       * importing it at module scope makes the route fail to load wherever
       * Shopify OAuth is not configured.
       */
      const { createProductionPriceSyncPort, createProductionMetafieldPublishDeps } = await import(
        "~/shopify/admin/productionPriceSyncPort.server"
      );
      const port = await createProductionPriceSyncPort();
      const metafields = await createProductionMetafieldPublishDeps();
      const result = await decideAndSyncIntent(
        { intentId, status: "approved", actor, reason: reason || undefined },
        { port, metafields }
      );
      logger.info("pricing.intent_approved_via_admin", {
        intentId,
        syncKind: result.sync?.kind ?? (result.syncError ? "threw" : "none"),
      });
      return describeApprovalOutcome(result);
    }

    return { tone: "error", message: "Unknown decision." } satisfies ActionResult;
  } catch (error) {
    // A rejected transition (wrong state, placeholder guard, concurrent
    // change) arrives here. Report it; never pretend it succeeded.
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("pricing.admin_decision_refused", { intentId, decision });
    return { tone: "error", message: `Refused: ${message}` } satisfies ActionResult;
  }
}

export default function PriceApprovalsRoute() {
  const { apiKey, rows } = useLoaderData<typeof loader>();
  const result = useActionData<typeof action>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  return (
    <AppProvider apiKey={apiKey}>
      <AdminNavigation />
      <main style={{ padding: "0 1rem 2rem", fontFamily: "system-ui, sans-serif" }}>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.25rem" }}>Price Approvals</h1>
        <p style={{ margin: "0 0 1rem", color: "#5c5f62", fontSize: "0.875rem" }}>
          A valid price was calculated and needs a human decision before it publishes. For
          calculation or synchronization <em>failures</em>, see Pricing Alerts.
        </p>

        {result ? (
          <p
            role="status"
            style={{
              margin: "0 0 1rem",
              padding: "0.75rem 1rem",
              fontSize: "0.875rem",
              border: "1px solid",
              borderColor:
                result.tone === "success" ? "#008060" : result.tone === "warning" ? "#b98900" : "#d72c0d",
              color:
                result.tone === "success" ? "#008060" : result.tone === "warning" ? "#8a6116" : "#d72c0d",
            }}
          >
            {result.message}
          </p>
        ) : null}

        {rows.length === 0 ? (
          <p style={{ fontSize: "0.9375rem" }}>No prices are waiting for approval.</p>
        ) : (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: "0.8125rem" }}>
            <thead>
              <tr style={{ textAlign: "left", borderBottom: "2px solid #e1e3e5" }}>
                <th style={{ padding: "0.5rem" }}>Product</th>
                <th style={{ padding: "0.5rem" }}>Variant</th>
                <th style={{ padding: "0.5rem" }}>Previous bank price</th>
                <th style={{ padding: "0.5rem" }}>Proposed bank price</th>
                <th style={{ padding: "0.5rem" }}>Proposed card price</th>
                <th style={{ padding: "0.5rem" }}>Change</th>
                <th style={{ padding: "0.5rem" }}>Why</th>
                <th style={{ padding: "0.5rem" }}>Calculated</th>
                <th style={{ padding: "0.5rem" }}>Decision</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.intentId} style={{ borderBottom: "1px solid #e1e3e5" }}>
                  <td style={{ padding: "0.5rem" }}>{row.productTitle}</td>
                  <td style={{ padding: "0.5rem" }}>{row.variantLabel}</td>
                  <td style={{ padding: "0.5rem" }}>{row.previousBankPaymentPrice ?? "none"}</td>
                  <td style={{ padding: "0.5rem" }}>{row.proposedBankPaymentPrice}</td>
                  <td style={{ padding: "0.5rem" }}>{row.proposedRegularCardPrice}</td>
                  <td style={{ padding: "0.5rem" }}>{row.change}</td>
                  <td style={{ padding: "0.5rem" }}>{row.approvalReason}</td>
                  <td style={{ padding: "0.5rem" }}>{row.calculatedAt}</td>
                  <td style={{ padding: "0.5rem" }}>
                    <Form method="post" style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap" }}>
                      <input type="hidden" name="intentId" value={row.intentId} />
                      <label style={{ display: "block" }}>
                        <span className="visually-hidden" style={{ fontSize: "0.75rem" }}>
                          Reason
                        </span>
                        <input
                          type="text"
                          name="reason"
                          placeholder="Reason (required to reject)"
                          style={{ padding: "0.25rem", minWidth: "14rem" }}
                        />
                      </label>
                      <button
                        type="submit"
                        name="decision"
                        value="approve"
                        disabled={busy}
                        style={{ padding: "0.35rem 0.75rem" }}
                      >
                        Approve and publish
                      </button>
                      <button
                        type="submit"
                        name="decision"
                        value="reject"
                        disabled={busy}
                        style={{ padding: "0.35rem 0.75rem" }}
                      >
                        Reject
                      </button>
                    </Form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </AppProvider>
  );
}

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
