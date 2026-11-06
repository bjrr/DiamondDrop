import { prisma } from "../client.server";
import { findOpenCalculationFailureRows, findOpenSyncFailureRows } from "./adminAlertEpisodes.server";

/**
 * The counts behind the admin home.
 *
 * ===========================================================================
 * WHAT THIS IS, AND MORE IMPORTANTLY WHAT IT IS NOT
 * ===========================================================================
 * It is one batch of indexed `count` queries, run in parallel, answering a
 * single question per queue: how many things are waiting for a person.
 *
 * It is NOT analytics. There is no aggregation table, no rollup job, no
 * cache, no time series and no history. Nothing here is written, ever. If a
 * number is not cheap to get, it is not here: Shipments has no status column
 * and therefore no count, and the dashboard links to it without one rather
 * than inventing a notion of an "open" shipment.
 *
 * ===========================================================================
 * EVERY COUNT IS AN ACTION QUEUE, NOT A TOTAL
 * ===========================================================================
 * "How many RMAs exist" is a vanity metric; nobody does anything differently
 * because of it. "How many RMAs are waiting on a decision" is a worklist. So
 * each number below is filtered to the statuses that mean a human still owes
 * the record something, and the status sets are spelled out rather than
 * inferred so that adding a new status does not silently change what the
 * dashboard claims.
 *
 * NO MONEY, NO COST, NO MARGIN. Not supplier cost, not frozen landed cost,
 * not a price. The home page is navigation; the queues themselves are where
 * authorised staff see figures.
 */

/** A queue with nothing to show is `null`, never `0`: they are different facts. */
export interface AdminDashboardCounts {
  readonly groupBuyDraft: number;
  readonly groupBuyOpen: number;
  readonly groupBuyDemandOutstanding: number;
  readonly luxuryStealSyncFailures: number;
  readonly luxuryStealUnmatchedOrderChecks: number;
  readonly beatQuotePendingReview: number;
  readonly bankPaymentsOpen: number;
  readonly groupBuyBankPaymentsOpen: number;
  readonly customJewelryActionable: number;
  readonly rmaOpen: number;
  readonly warrantyOpen: number;
  readonly openAlerts: number;
}

/**
 * Statuses that mean a person still owes the record something.
 *
 * Deliberately explicit. The alternative, "everything except the terminal
 * states", quietly re-scopes the dashboard every time a status is added.
 */
const RMA_OPEN = [
  "submitted",
  "approved",
  "return_shipped",
  "received_inspection_pending",
  "inspection_passed",
  "inspection_failed",
  "remedy_in_progress",
] as const;

const WARRANTY_OPEN = [
  "submitted",
  "under_review",
  "more_information_requested",
  "authorized_for_inspection",
  "in_transit_to_carat_for_us",
  "received_inspection_pending",
  "approved_covered",
  "remedy_in_progress",
] as const;

/** Submitted needs triage; awaiting_approval needs chasing. The rest are waiting on the customer or done. */
const CUSTOM_JEWELRY_ACTIONABLE = ["submitted", "awaiting_approval"] as const;

/** Only the two review states. `offer_made` and the terminal states are not a queue. */
const BEAT_QUOTE_PENDING = ["submitted", "in_review"] as const;

/**
 * One round trip per queue, all issued together.
 *
 * `Promise.all` rather than sequential awaits: these are independent indexed
 * counts and the home page should not pay for them one after another.
 */
export async function getAdminDashboardCounts(): Promise<AdminDashboardCounts> {
  const [
    groupBuyDraft,
    groupBuyOpen,
    groupBuyDemandOutstanding,
    luxuryStealSyncFailures,
    luxuryStealUnmatchedOrderChecks,
    beatQuotePendingReview,
    bankPaymentsOpen,
    groupBuyBankPaymentsOpen,
    customJewelryActionable,
    rmaOpen,
    warrantyOpen,
    openCalculationFailures,
    openSyncFailures,
  ] = await Promise.all([
    prisma.groupBuyCampaign.count({ where: { status: "draft" } }),
    prisma.groupBuyCampaign.count({ where: { status: "open" } }),
    prisma.groupBuyDemandSignal.count({ where: { notifiedAt: null } }),
    prisma.luxuryStealSyncFailure.count({ where: { resolvedAt: null } }),
    prisma.luxuryStealOrderCheck.count({ where: { outcome: "unmatched" } }),
    prisma.beatQuoteSubmission.count({ where: { status: { in: [...BEAT_QUOTE_PENDING] } } }),
    prisma.bankPaymentOrder.count({ where: { status: "open" } }),
    prisma.groupBuyBankPaymentOrder.count({ where: { status: "active" } }),
    prisma.customJewelryProject.count({
      where: { status: { in: [...CUSTOM_JEWELRY_ACTIONABLE] } },
    }),
    prisma.rmaRequest.count({ where: { status: { in: [...RMA_OPEN] } } }),
    prisma.warrantyClaim.count({ where: { status: { in: [...WARRANTY_OPEN] } } }),
    // REUSES THE APPROVED PREDICATES rather than restating what "open" means.
    // `listOpenAdminAlerts` composes these same two row sets; counting them
    // here avoids building the full view objects just to take a length.
    findOpenCalculationFailureRows().then((rows: unknown[]) => rows.length),
    findOpenSyncFailureRows().then((rows: unknown[]) => rows.length),
  ]);

  return {
    groupBuyDraft,
    groupBuyOpen,
    groupBuyDemandOutstanding,
    luxuryStealSyncFailures,
    luxuryStealUnmatchedOrderChecks,
    beatQuotePendingReview,
    bankPaymentsOpen,
    groupBuyBankPaymentsOpen,
    customJewelryActionable,
    rmaOpen,
    warrantyOpen,
    openAlerts: openCalculationFailures + openSyncFailures,
  };
}
