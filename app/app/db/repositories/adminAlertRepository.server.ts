import type { PriceCalculationFailure, PriceSyncFailure } from "@prisma/client";

import { buildAlertViewModel, type AlertFailureDetail } from "~/domain/alerts/viewModel";

import {
  findOpenCalculationFailureRows,
  findOpenSyncFailureRows,
  loadVariantContext,
} from "./adminAlertEpisodes.server";

/**
 * The embedded-admin alert listing (Slice 2 stage 2A, owner §7/§15;
 * `AdminAlertView` is the team-lead-authored contract the admin route
 * (`app/routes/alerts.tsx`) renders against — the route owns NO
 * view-model logic of its own, so this shape and `~/domain/alerts`'s pure
 * `AlertViewModel` are the two things that must never let the admin page
 * and the notification email disagree).
 *
 * "Open" means `resolvedAt IS NULL` on the underlying episode row — this
 * INCLUDES episodes not yet suspended (`suspended: false`) as well as ones
 * already past the 48h cutoff (`suspended: true`). A resolved episode drops
 * off this list automatically the moment `resolvedAt` is set (R2's own
 * predicate, applied inside `buildAlertViewModel`) — there is no separate
 * flag to clear.
 */
export type AdminAlertKind = "calculation_failure" | "sync_failure";

export interface AdminAlertView {
  kind: AdminAlertKind;
  episodeId: string;
  masterVariantId: string;
  /** Null only if the variant/product row could not be resolved — the route renders its own fallback text; see `loadVariantContext`. */
  productTitle: string | null;
  variantLabel: string | null;
  shopifyProductGid: string | null;
  shopifyVariantGid: string | null;
  /** The calculation-failure taxonomy value, or the fixed `"sync_rejected"` label for a sync failure — see `~/domain/alerts`'s doc comment. */
  failureType: string;
  reason: string;
  firstFailedAt: Date;
  ageMs: number;
  msRemainingBeforeSuspension: number;
  /** `suspendedAt IS NOT NULL AND resolvedAt IS NULL` (R2) — never derived from `alertState`. */
  suspended: boolean;
  attemptCount: number;
  lastAttemptAt: Date;
  lastError: string;
  /**
   * `"dismissed"` is a SYNC-FAILURE-ONLY concept (owner §4.3's alert
   * dismissal — calculation failures carry no dismiss workflow, see
   * `~/domain/pricing/calculationFailure.ts`'s own doc comment). Dismissal
   * only silences the notification; it does NOT affect `suspended` or
   * variant availability (R2), so a dismissed episode can independently be
   * suspended or not — `suspended` is the field that answers "can this
   * still be sold," `status` answers "has a human already acknowledged
   * this alert."
   */
  status: "active" | "suspended" | "dismissed";
}

function resolveStatus(suspended: boolean, dismissed: boolean): AdminAlertView["status"] {
  if (dismissed) return "dismissed";
  return suspended ? "suspended" : "active";
}

async function toAdminAlertView(
  kind: AdminAlertView["kind"],
  row: {
    id: string;
    masterVariantId: string;
    firstFailedAt: Date;
    lastAttemptAt: Date;
    attemptCount: number;
    lastError: string;
    suspendedAt: Date | null;
    resolvedAt: Date | null;
  },
  detail: AlertFailureDetail,
  dismissed: boolean,
  now: Date
): Promise<AdminAlertView> {
  const context = await loadVariantContext(row.masterVariantId);

  const viewModel = buildAlertViewModel({
    sourceId: row.id,
    masterVariantId: row.masterVariantId,
    product: context.productTitle ?? `Unresolved product (variant ${row.masterVariantId})`,
    variant: context.variantLabel ?? `Unresolved variant (${row.masterVariantId})`,
    firstFailedAt: row.firstFailedAt,
    lastAttemptAt: row.lastAttemptAt,
    attemptCount: row.attemptCount,
    lastError: row.lastError,
    suspendedAt: row.suspendedAt,
    resolvedAt: row.resolvedAt,
    now,
    detail,
  });

  const suspended = viewModel.status === "suspended";

  return {
    kind,
    episodeId: row.id,
    masterVariantId: row.masterVariantId,
    productTitle: context.productTitle,
    variantLabel: context.variantLabel,
    shopifyProductGid: context.shopifyProductGid,
    shopifyVariantGid: context.shopifyVariantGid,
    failureType: viewModel.failureType,
    reason: viewModel.reason,
    firstFailedAt: viewModel.firstFailedAt,
    ageMs: viewModel.ageMs,
    msRemainingBeforeSuspension: viewModel.timeRemainingBeforeSuspensionMs,
    suspended,
    attemptCount: row.attemptCount,
    lastAttemptAt: row.lastAttemptAt,
    lastError: row.lastError,
    status: resolveStatus(suspended, dismissed),
  };
}

function toCalculationAdminAlertView(
  row: PriceCalculationFailure,
  now: Date
): Promise<AdminAlertView> {
  return toAdminAlertView(
    "calculation_failure",
    row,
    { sourceKind: "calculation_failure", failureType: row.failureType },
    // No dismiss workflow exists for calculation failures (see the
    // `status` field's own doc comment) — always false.
    false,
    now
  );
}

function toSyncAdminAlertView(row: PriceSyncFailure, now: Date): Promise<AdminAlertView> {
  return toAdminAlertView(
    "sync_failure",
    row,
    { sourceKind: "sync_failure" },
    row.alertState === "dismissed",
    now
  );
}

export async function listOpenAdminAlerts(now: Date = new Date()): Promise<AdminAlertView[]> {
  const [calculationRows, syncRows] = await Promise.all([
    findOpenCalculationFailureRows(),
    findOpenSyncFailureRows(),
  ]);

  const views = await Promise.all([
    ...calculationRows.map((row) => toCalculationAdminAlertView(row, now)),
    ...syncRows.map((row) => toSyncAdminAlertView(row, now)),
  ]);

  return views.sort((a, b) => a.firstFailedAt.getTime() - b.firstFailedAt.getTime());
}
