/**
 * Synchronize the derived compatibility index from Shopify.
 *
 * Authoritative requirements: docs/SET-YOUR-OWN-STONE.md §5, §6.2.1; owner
 * direction 2026-11-01.
 *
 * ---------------------------------------------------------------------------
 * ONE SYNC PATH, THREE CALLERS
 * ---------------------------------------------------------------------------
 * The Product event handler, the Metaobject event handler and the
 * reconciliation job all call `syncProduct`. None of them contains matching or
 * validation logic of its own — the owner's instruction, and the reason
 * event-derived state and reconciliation-derived state can be expected to
 * agree. If a handler ever grows its own rule, that guarantee is gone.
 *
 * Events provide freshness. Reconciliation provides recovery. Both produce
 * identical rows for identical Shopify state, which is a property worth being
 * able to assert rather than hope for.
 *
 * ---------------------------------------------------------------------------
 * WHAT HAPPENS TO A ROW THAT SHOPIFY NO LONGER DESCRIBES
 * ---------------------------------------------------------------------------
 * DEACTIVATED, NEVER DELETED. A variant removed in Shopify, or a product
 * deleted outright, leaves rows behind that past `StoneSession`s still point
 * at. Deleting them would make a historical match unexplainable precisely when
 * someone is asking about it. Deactivating removes the mounting from customer
 * results immediately, which is the behaviour that matters, and keeps the
 * record for the audit trail.
 */
import { prisma } from "~/db/client.server";
import {
  projectProduct,
  type ProjectedReadySetting,
} from "~/domain/setyourownstone/metafieldProjection";
import { logger } from "~/lib/logger.server";
import type { AdminGraphqlClient } from "~/shopify/admin/productClient.server";
import { readSyosProduct } from "~/shopify/admin/syosProductReader.server";

export interface SyncOutcome {
  readonly productGid: string;
  readonly found: boolean;
  readonly rowsUpserted: number;
  readonly rowsDeactivated: number;
  readonly eligible: number;
  readonly withProblems: number;
}

/**
 * A stable fingerprint of the EFFECTIVE ROW — every value that changes what a
 * customer could be shown.
 *
 * Lets reconciliation skip rows that cannot have changed, and makes a silent
 * divergence between Shopify and the index detectable instead of invisible.
 *
 * It includes `eligibleForSetYourOwnStone`, which is derived rather than read.
 * That is deliberate: eligibility is the single most consequential field in
 * the row, and a change from eligible to not — however it arose — is exactly
 * what a change detector must notice.
 *
 * It excludes the problem MESSAGES. Those are prose, and rewording one would
 * otherwise churn every hash in the catalogue while changing nothing about
 * what is offered. Whether problems exist is already captured, because any
 * problem forces eligibility to false.
 */
function sourceHash(row: ProjectedReadySetting): string {
  return [
    row.centerSizeProfileId ?? "-",
    row.centerSizeOptionValueId ?? "-",
    row.shape,
    row.nominalLengthUm,
    row.nominalWidthUm,
    row.nominalDepthUm ?? "-",
    row.minLengthUm ?? "-",
    row.maxLengthUm ?? "-",
    row.minWidthUm ?? "-",
    row.maxWidthUm ?? "-",
    row.vendorRangeSource ?? "-",
    row.vendorToleranceUm ?? "-",
    row.vendorToleranceSource ?? "-",
    row.eligibleForSetYourOwnStone ? "1" : "0",
    row.prongSetToleranceEligible ? "1" : "0",
    row.isActive ? "1" : "0",
  ].join("|");
}

/**
 * Re-read one product from Shopify and bring its rows into line.
 *
 * @param now injected rather than read from the clock, so a test can assert
 *            the recorded sync time instead of tolerating whatever `new Date()`
 *            happened to return.
 */
export async function syncProduct(
  client: AdminGraphqlClient,
  productGid: string,
  now: Date = new Date()
): Promise<SyncOutcome> {
  const read = await readSyosProduct(client, productGid);

  // Product gone from Shopify. Withdraw every configuration, keep every row.
  if (read === null) {
    const deactivated = await prisma.readySettingCompatibility.updateMany({
      where: { shopifyProductGid: productGid, isActive: true },
      data: {
        isActive: false,
        eligibleForSetYourOwnStone: false,
        syncedFromShopifyAt: now,
        syncProblems: ["The Shopify product no longer exists."],
      },
    });
    logger.info("syos_sync.product_absent", { productGid, deactivated: deactivated.count });
    return {
      productGid,
      found: false,
      rowsUpserted: 0,
      rowsDeactivated: deactivated.count,
      eligible: 0,
      withProblems: 0,
    };
  }

  const { rows } = projectProduct(read.input);

  // A product with no centre-size option cannot link a profile, and the
  // projection will already have said so per variant. Recorded here too
  // because the dashboard reports it at product level.
  if (!read.hasCenterSizeOption) {
    logger.info("syos_sync.no_center_size_option", { productGid });
  }

  for (const row of rows) {
    const data = {
      shopifyProductGid: row.shopifyProductGid,
      centerSizeOptionValueId: row.centerSizeOptionValueId,
      centerSizeProfileId: row.centerSizeProfileId,
      shape: row.shape,
      nominalLengthUm: row.nominalLengthUm,
      nominalWidthUm: row.nominalWidthUm,
      nominalDepthUm: row.nominalDepthUm,
      minLengthUm: row.minLengthUm,
      maxLengthUm: row.maxLengthUm,
      minWidthUm: row.minWidthUm,
      maxWidthUm: row.maxWidthUm,
      vendorRangeSource: row.vendorRangeSource,
      vendorToleranceUm: row.vendorToleranceUm,
      vendorToleranceSource: row.vendorToleranceSource,
      eligibleForSetYourOwnStone: row.eligibleForSetYourOwnStone,
      prongSetToleranceEligible: row.prongSetToleranceEligible,
      isActive: row.isActive,
      syncedFromShopifyAt: now,
      syncSourceHash: sourceHash(row),
      syncProblems: row.problems.length > 0 ? [...row.problems] : [],
    };

    await prisma.readySettingCompatibility.upsert({
      where: { shopifyVariantGid: row.shopifyVariantGid },
      create: { shopifyVariantGid: row.shopifyVariantGid, ...data },
      update: data,
    });
  }

  // Variants that existed last time and do not now. Same reasoning as a
  // deleted product: withdraw, never delete.
  const liveVariantGids = rows.map((r) => r.shopifyVariantGid);
  const stale = await prisma.readySettingCompatibility.updateMany({
    where: {
      shopifyProductGid: productGid,
      isActive: true,
      shopifyVariantGid: { notIn: liveVariantGids.length > 0 ? liveVariantGids : ["__none__"] },
    },
    data: {
      isActive: false,
      eligibleForSetYourOwnStone: false,
      syncedFromShopifyAt: now,
      syncProblems: ["This variant no longer exists on the Shopify product."],
    },
  });

  const outcome: SyncOutcome = {
    productGid,
    found: true,
    rowsUpserted: rows.length,
    rowsDeactivated: stale.count,
    eligible: rows.filter((r) => r.eligibleForSetYourOwnStone).length,
    withProblems: rows.filter((r) => r.problems.length > 0).length,
  };

  logger.info("syos_sync.product_synced", { ...outcome });
  return outcome;
}

/**
 * Re-sync every product that uses a given size profile.
 *
 * THE METAOBJECT EVENT PATH. A merchant editing "Pear 10 × 7 mm" touches no
 * product, so the only way to find the affected configurations is the reverse
 * index recorded on each row. Each affected product then goes through the
 * ordinary `syncProduct`, which re-reads the profile from Shopify — so the
 * event payload is a trigger, never a data source. A payload trusted as data
 * would let a malformed or replayed delivery write dimensions.
 */
export async function syncProductsUsingProfile(
  client: AdminGraphqlClient,
  profileMetaobjectId: string,
  now: Date = new Date()
): Promise<readonly SyncOutcome[]> {
  const affected = await prisma.readySettingCompatibility.findMany({
    where: { centerSizeProfileId: profileMetaobjectId },
    select: { shopifyProductGid: true },
    distinct: ["shopifyProductGid"],
  });

  logger.info("syos_sync.profile_changed", {
    profileMetaobjectId,
    productsAffected: affected.length,
  });

  const outcomes: SyncOutcome[] = [];
  for (const { shopifyProductGid } of affected) {
    outcomes.push(await syncProduct(client, shopifyProductGid, now));
  }
  return outcomes;
}

/**
 * Rebuild the whole index from Shopify.
 *
 * Recovery, and the proof that the table is genuinely derived: if this cannot
 * reproduce the index, something is being authored in our database that should
 * not be.
 *
 * Driven from the rows we already have plus any product ids supplied by the
 * caller. It does not crawl the catalogue — a product that has never synced is
 * discovered by its first Product event or by an explicit id, and inventing a
 * full-catalogue crawl would make this job's cost grow with the shop rather
 * than with the feature.
 */
export async function reconcileCompatibility(
  client: AdminGraphqlClient,
  options: { readonly additionalProductGids?: readonly string[]; readonly now?: Date } = {}
): Promise<{
  readonly productsConsidered: number;
  readonly outcomes: readonly SyncOutcome[];
  readonly failures: readonly { readonly productGid: string; readonly message: string }[];
}> {
  const now = options.now ?? new Date();

  const known = await prisma.readySettingCompatibility.findMany({
    select: { shopifyProductGid: true },
    distinct: ["shopifyProductGid"],
  });

  const productGids = [
    ...new Set([
      ...known.map((k) => k.shopifyProductGid),
      ...(options.additionalProductGids ?? []),
    ]),
  ];

  const outcomes: SyncOutcome[] = [];
  const failures: { productGid: string; message: string }[] = [];

  for (const productGid of productGids) {
    try {
      outcomes.push(await syncProduct(client, productGid, now));
    } catch (error) {
      // One unreachable product must not abandon the rest. A partial
      // reconciliation that reports what it could not do beats an aborted one
      // that leaves most of the index untouched and says nothing.
      const message = error instanceof Error ? error.message : "unknown error";
      failures.push({ productGid, message });
      logger.warn("syos_sync.reconcile_product_failed", { productGid, message });
    }
  }

  logger.info("syos_sync.reconciled", {
    productsConsidered: productGids.length,
    synced: outcomes.length,
    failed: failures.length,
  });

  return { productsConsidered: productGids.length, outcomes, failures };
}
