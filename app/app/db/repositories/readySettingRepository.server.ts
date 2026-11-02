/**
 * Set Your Own Stone — ready-setting compatibility lookup.
 *
 * Authoritative requirements: docs/SET-YOUR-OWN-STONE.md §5 and §11.
 *
 * ---------------------------------------------------------------------------
 * THIS TABLE IS DERIVED. SHOPIFY IS THE SOURCE OF TRUTH.
 * ---------------------------------------------------------------------------
 * That reversed on 2026-11-01. It used to be the system of record, authored
 * through our own admin; it is now a projection of Shopify product metafields,
 * variant metafields and app-owned Center Stone Size Profiles, written only by
 * `syncCompatibility.server.ts` from events and reconciliation. Nothing here
 * or in the admin edits it, and the whole index must be rebuildable from
 * Shopify alone.
 *
 * WHY KEEP IT AT ALL, rather than matching against Shopify directly: §11
 * requires deterministic server-side matching with "no client-only trust
 * boundary", and a Shopify read per candidate per request would be both slow
 * and rate-limited. The table is an index for speed, validation, auditability
 * and historical explanation — not a second place to author anything.
 */
import type { ReadySettingCompatibility as Row } from "@prisma/client";

import { prisma } from "~/db/client.server";
import type { ReadySettingCompatibility, StoneShape } from "~/domain/setyourownstone/matching";

/**
 * Load every eligible setting of one shape.
 *
 * SHAPE IS FILTERED IN THE DATABASE; dimensions are not. That split is
 * deliberate. Shape is an equality the index covers and a mismatch can never
 * become a match, so excluding it early is free. Dimension rules are policy
 * — vendor ranges, approved tolerances, a review band — and policy belongs
 * in the domain service where it is unit tested, not spread across a WHERE
 * clause where it would quietly diverge from the tests.
 *
 * The catalogue of eligible settings per shape is small by construction, so
 * loading it and classifying in memory costs nothing worth optimising.
 */
export async function findEligibleSettingsForShape(
  shape: StoneShape
): Promise<ReadySettingCompatibility[]> {
  const rows = await prisma.readySettingCompatibility.findMany({
    // `isActive` is enforced here rather than in the matcher. A withdrawn
    // mounting has no verdict to render — it is simply not in the catalogue —
    // and filtering in SQL means there is no code path where someone forgets
    // to check it before showing a result.
    where: { shape, eligibleForSetYourOwnStone: true, isActive: true },
    orderBy: { shopifyVariantGid: "asc" },
  });
  return rows.map(toDomain);
}

/**
 * One setting, for recording a selection.
 *
 * ALSO GATED ON `isActive`, which matters more here than it looks. A customer
 * sitting on a tab opened before staff withdrew a mounting would otherwise be
 * able to select it, and the selection route's "not available for Set Your
 * Own Stone" refusal is exactly the right answer in that case.
 */
export async function findSettingByVariantGid(
  shopifyVariantGid: string
): Promise<ReadySettingCompatibility | null> {
  const row = await prisma.readySettingCompatibility.findFirst({
    where: { shopifyVariantGid, isActive: true },
  });
  return row ? toDomain(row) : null;
}

/** The Shopify identity the storefront needs to render a result. Kept apart
 *  from the matching type so the domain service stays free of Shopify. */
export interface SettingIdentity {
  readonly shopifyVariantGid: string;
  readonly shopifyProductGid: string;
}

export async function findIdentitiesByVariantGids(
  gids: readonly string[]
): Promise<Map<string, SettingIdentity>> {
  if (gids.length === 0) return new Map();
  const rows = await prisma.readySettingCompatibility.findMany({
    where: { shopifyVariantGid: { in: [...gids] } },
    select: { shopifyVariantGid: true, shopifyProductGid: true },
  });
  return new Map(rows.map((r) => [r.shopifyVariantGid, r]));
}

/**
 * Prisma row to the domain's shape.
 *
 * `null` becomes `undefined` rather than passing through. The domain treats
 * "absent" as a real state — a half-specified vendor range is ignored rather
 * than completed by guesswork — and `undefined` is the word it uses for it.
 */
function toDomain(row: Row): ReadySettingCompatibility {
  return {
    shopifyVariantGid: row.shopifyVariantGid,
    shape: row.shape as StoneShape,
    nominalLengthUm: row.nominalLengthUm,
    nominalWidthUm: row.nominalWidthUm,
    nominalDepthUm: row.nominalDepthUm ?? undefined,
    minLengthUm: row.minLengthUm ?? undefined,
    maxLengthUm: row.maxLengthUm ?? undefined,
    minWidthUm: row.minWidthUm ?? undefined,
    maxWidthUm: row.maxWidthUm ?? undefined,
    eligibleForSetYourOwnStone: row.eligibleForSetYourOwnStone,
    vendorToleranceUm: row.vendorToleranceUm ?? undefined,
    prongSetToleranceEligible: row.prongSetToleranceEligible,
    centerSizeOptionValueId: row.centerSizeOptionValueId,
    centerSizeProfileId: row.centerSizeProfileId,
  };
}
