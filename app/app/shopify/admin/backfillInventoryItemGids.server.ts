import { prisma } from "~/db/client.server";
import { logger } from "~/lib/logger.server";

import { AdminApiError, type AdminGraphqlClient } from "./productClient.server";

/**
 * R17 (owner ruling, 2026-09-20) — populates `master_variant.shopify_inventory_item_gid`,
 * the mapping `inventory_levels/update` resolves through.
 *
 * MUST RUN BEFORE THE WEBHOOK IS RELIED ON. An unpopulated mapping resolves
 * nothing for a real delivery and logs `webhook.inventory_recompute_unresolved`
 * — which is INDISTINGUISHABLE from the handler correctly finding no match
 * for a foreign product. That ambiguity is exactly what cost the live-
 * verification session real time before R15/R17's actual root cause (the
 * wrong TOPICS, not a resolution bug) was found. This module exists so the
 * mapping is never the reason a later "why isn't this firing?" investigation
 * starts from zero again.
 *
 * ONE ADMIN API CALL PER PRODUCT, not per variant — batches every variant of
 * a product into a single `variants(first: 100)` connection, mirroring the
 * batching discipline `variantAvailability.server.ts` already uses for the
 * same reason (rate limits, and one round trip regardless of catalogue size
 * per product).
 *
 * `InventoryItem.variants` CONNECTION, NOT THE DEPRECATED SINGULAR `variant`
 * FIELD — and used as a VERIFICATION, not merely a lookup. The straightforward
 * direction for this backfill is variant -> `inventoryItem.id`, which alone
 * would need no `variants` connection at all. It is queried anyway and
 * checked that it names the SAME variant gid the query started from, so a
 * data anomaly (an inventory item legitimately shared across variants, or a
 * response that silently returned the wrong pairing) is caught and the
 * variant is left UNRESOLVED rather than mapped to a plausible-looking but
 * unconfirmed id — the same "verify, don't assume" discipline R15/R17's own
 * live checks used throughout this stage.
 */

const QUERY = `#graphql
  query CaratBackfillInventoryItemIds($id: ID!) {
    product(id: $id) {
      variants(first: 100) {
        nodes {
          id
          inventoryItem {
            id
            variants(first: 5) {
              nodes { id }
            }
          }
        }
      }
    }
  }`;

interface VariantNode {
  id: string;
  inventoryItem: {
    id: string;
    variants: { nodes: { id: string }[] };
  } | null;
}

interface QueryEnvelope {
  data?: { product?: { variants?: { nodes?: VariantNode[] } } | null };
  errors?: { message: string }[];
}

/**
 * PURE — no I/O. Given the variant nodes a product query returned, resolves
 * the inventory item id for ONE variant gid, requiring the backward
 * `variants` connection to confirm it. Returns `null` on any mismatch —
 * missing inventory item, empty backward connection, or a backward
 * connection that does not include this exact variant gid.
 */
export function resolveConfirmedInventoryItemGid(variantNodes: readonly VariantNode[], variantGid: string): string | null {
  const node = variantNodes.find((n) => n.id === variantGid);
  if (!node?.inventoryItem) return null;
  const confirmed = node.inventoryItem.variants.nodes.some((v) => v.id === variantGid);
  return confirmed ? node.inventoryItem.id : null;
}

export interface BackfillInventoryItemGidsResult {
  readonly productsProcessed: number;
  readonly variantsUpdated: number;
  readonly variantsAlreadyMapped: number;
  /** master_variant ids that could not be resolved this run — see the module doc comment for why that is logged, not thrown. */
  readonly variantsUnresolved: readonly string[];
}

interface BackfillCandidateProduct {
  id: string;
  shopifyProductGid: string;
  variants: { id: string; shopifyVariantGid: string | null; shopifyInventoryItemGid: string | null }[];
}

async function defaultLoadCandidateProducts(): Promise<BackfillCandidateProduct[]> {
  const rows = await prisma.masterProduct.findMany({
    where: {
      shopifyProductGid: { not: null },
      variants: { some: { shopifyVariantGid: { not: null }, shopifyInventoryItemGid: null } },
    },
    select: {
      id: true,
      shopifyProductGid: true,
      variants: {
        where: { shopifyVariantGid: { not: null } },
        select: { id: true, shopifyVariantGid: true, shopifyInventoryItemGid: true },
      },
    },
  });
  // shopifyProductGid is guaranteed non-null by the where clause above, but
  // Prisma's generated type does not encode that — narrowed explicitly
  // rather than asserted, so a future query change that drops the filter
  // fails loudly here instead of producing a runtime null.
  return rows
    .filter((row): row is BackfillCandidateProduct & { shopifyProductGid: string } => row.shopifyProductGid !== null)
    .map((row) => ({ ...row, shopifyProductGid: row.shopifyProductGid! }));
}

export interface BackfillInventoryItemGidsDeps {
  loadCandidateProducts?: () => Promise<BackfillCandidateProduct[]>;
}

/**
 * Runs the backfill for every currently-unmapped, linked variant. Safe to
 * re-run: `defaultLoadCandidateProducts` only selects products with at
 * least one unmapped variant, so an already-fully-mapped catalogue is a
 * fast no-op.
 *
 * A single product's Admin API failure does not abort the run — mirrors the
 * per-variant isolation discipline in `runPriceRecalculation` (one bad
 * product must not block backfilling the rest of the catalogue).
 */
export async function backfillInventoryItemGids(
  client: AdminGraphqlClient,
  deps: BackfillInventoryItemGidsDeps = {}
): Promise<BackfillInventoryItemGidsResult> {
  const loadCandidateProducts = deps.loadCandidateProducts ?? defaultLoadCandidateProducts;
  const products = await loadCandidateProducts();

  let variantsUpdated = 0;
  let variantsAlreadyMapped = 0;
  const variantsUnresolved: string[] = [];

  for (const product of products) {
    let variantNodes: VariantNode[];
    try {
      const response = await client.graphql(QUERY, { variables: { id: product.shopifyProductGid } });
      const body = (await response.json()) as QueryEnvelope;
      if (body.errors?.length) {
        throw new AdminApiError("backfillInventoryItemGids", body.errors.map((e) => e.message));
      }
      variantNodes = body.data?.product?.variants?.nodes ?? [];
    } catch (error) {
      logger.error("shopify.inventory_item_backfill_product_failed", {
        masterProductId: product.id,
        error: error instanceof Error ? error.name : "UnknownError",
      });
      for (const variant of product.variants) {
        if (!variant.shopifyInventoryItemGid) variantsUnresolved.push(variant.id);
      }
      continue;
    }

    for (const variant of product.variants) {
      if (variant.shopifyInventoryItemGid) {
        variantsAlreadyMapped += 1;
        continue;
      }
      // Guaranteed non-null by defaultLoadCandidateProducts's own where
      // clause, narrowed the same way as shopifyProductGid above.
      const variantGid = variant.shopifyVariantGid;
      const inventoryItemGid = variantGid ? resolveConfirmedInventoryItemGid(variantNodes, variantGid) : null;

      if (!inventoryItemGid) {
        variantsUnresolved.push(variant.id);
        logger.warn("shopify.inventory_item_backfill_unresolved", {
          masterVariantId: variant.id,
          masterProductId: product.id,
        });
        continue;
      }

      await prisma.masterVariant.update({
        where: { id: variant.id },
        data: { shopifyInventoryItemGid: inventoryItemGid },
      });
      variantsUpdated += 1;
    }
  }

  logger.info("shopify.inventory_item_backfill_completed", {
    productsProcessed: products.length,
    variantsUpdated,
    variantsAlreadyMapped,
    variantsUnresolved: variantsUnresolved.length,
  });

  return {
    productsProcessed: products.length,
    variantsUpdated,
    variantsAlreadyMapped,
    variantsUnresolved,
  };
}
