import type { PriceCalculationFailure, PriceSyncFailure } from "@prisma/client";

import {
  buildAlertViewModel,
  type AlertEpisodeInput,
  type AlertFailureDetail,
  type AlertViewModel,
} from "~/domain/alerts/viewModel";

import { prisma } from "../client.server";

/**
 * Shared read/mapping helpers for the admin-alert repository entry points
 * (`adminAlertRepository.server.ts`'s embedded-admin listing,
 * `adminAlertDispatch.server.ts`'s single-episode notification). Neither
 * `price_calculation_failure` nor `price_sync_failure`'s own repository
 * modules are touched or imported here — this reads the same tables
 * directly (read-only), which is deliberate: those two repositories are
 * reviewed and green, and this module adds a call site beside them, not a
 * change inside them.
 */

export interface VariantContext {
  productTitle: string | null;
  variantLabel: string | null;
  shopifyProductGid: string | null;
  shopifyVariantGid: string | null;
}

/** `"gold 14k, Comfort Fit 6.5-8"` — never null; only used where a display fallback is acceptable (the email body). */
function describeVariant(variant: { metal: string; purity: string; band: { label: string } | null }): string {
  const metalAndPurity = `${variant.metal} ${variant.purity}`;
  return variant.band ? `${metalAndPurity}, ${variant.band.label}` : metalAndPurity;
}

/**
 * Tolerant of a missing variant — returns all-null rather than throwing.
 * `masterVariantId` is a required FK on both failure tables so this should
 * never actually miss, but the admin-route contract (team-lead's
 * `AdminAlertView`) asks for a graceful fallback rather than a crashed page
 * if a row is ever orphaned, so this stays defensive rather than asserting.
 */
export async function loadVariantContext(masterVariantId: string): Promise<VariantContext> {
  const variant = await prisma.masterVariant.findUnique({
    where: { id: masterVariantId },
    select: {
      metal: true,
      purity: true,
      shopifyVariantGid: true,
      masterProduct: { select: { name: true, shopifyProductGid: true } },
      band: { select: { label: true } },
    },
  });

  if (!variant) {
    return { productTitle: null, variantLabel: null, shopifyProductGid: null, shopifyVariantGid: null };
  }

  return {
    productTitle: variant.masterProduct.name,
    variantLabel: describeVariant(variant),
    shopifyProductGid: variant.masterProduct.shopifyProductGid,
    shopifyVariantGid: variant.shopifyVariantGid,
  };
}

async function toAlertViewModel(
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
  now: Date
): Promise<AlertViewModel> {
  const context = await loadVariantContext(row.masterVariantId);

  const input: AlertEpisodeInput = {
    sourceId: row.id,
    masterVariantId: row.masterVariantId,
    // The email body accepts a display fallback here — AlertEpisodeInput's
    // product/variant are plain strings. The embedded-admin route gets the
    // raw nullable values instead (see `adminAlertRepository.server.ts`),
    // because that surface renders its OWN fallback text/markup for a
    // missing product/variant rather than baking one in here.
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
  };

  return buildAlertViewModel(input);
}

/** Loads one calculation-failure episode by id and builds its view model, or null if the id does not exist. */
export async function loadCalculationAlertViewModel(
  episodeId: string,
  now: Date
): Promise<AlertViewModel | null> {
  const row = await prisma.priceCalculationFailure.findUnique({ where: { id: episodeId } });
  if (!row) return null;
  return toAlertViewModel(row, { sourceKind: "calculation_failure", failureType: row.failureType }, now);
}

/** Loads one sync-failure episode by id and builds its view model, or null if the id does not exist. */
export async function loadSyncAlertViewModel(episodeId: string, now: Date): Promise<AlertViewModel | null> {
  const row = await prisma.priceSyncFailure.findUnique({ where: { id: episodeId } });
  if (!row) return null;
  return toAlertViewModel(row, { sourceKind: "sync_failure" }, now);
}

/** Every OPEN calculation-failure row, for the admin listing to map into its own DTO. */
export async function findOpenCalculationFailureRows(): Promise<PriceCalculationFailure[]> {
  return prisma.priceCalculationFailure.findMany({ where: { resolvedAt: null } });
}

/** Every OPEN sync-failure row, for the admin listing to map into its own DTO. */
export async function findOpenSyncFailureRows(): Promise<PriceSyncFailure[]> {
  return prisma.priceSyncFailure.findMany({ where: { resolvedAt: null } });
}
