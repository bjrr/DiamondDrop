import type { AdminGraphqlClient } from "~/shopify/admin/productClient.server";
import { AdminApiError } from "~/shopify/admin/productClient.server";

/**
 * Bulk variant "available for sale" lookup for the "as low as" aggregator
 * (Stage 2B / R13, spec §4.5 criteria 28-31).
 *
 * WHY `nodes(ids:)` RATHER THAN ONE `productVariant(id:)` QUERY PER VARIANT.
 * A product can carry many priced configurations (metal x purity x band), and
 * recomputing "as low as" on every variant publish would otherwise cost one
 * Admin API round trip per variant in that product. `nodes` resolves any mix
 * of ids in ONE call, aligned to the input array, so this is a single request
 * regardless of how many variants a product has.
 *
 * WHY `availableForSale` RATHER THAN REASONING FROM `inventoryQuantity` /
 * `inventoryItem.tracked` OURSELVES. Verified live against
 * caratforus-dev.myshopify.com (Admin API 2026-07), 2026-09-20: a throwaway
 * variant with inventory tracking OFF reported `inventoryQuantity: 0` and
 * `inventoryItem.tracked: false` yet `availableForSale: true`. Computing
 * "out of stock" from quantity alone would wrongly exclude every untracked
 * variant — likely most of this catalogue, since made-to-order jewelry is
 * commonly sold without inventory tracking. "Inventory and sold-out
 * behaviour" is a Shopify-native boundary (spec §5); `availableForSale` IS
 * Shopify's own answer to that question, so reading it directly is the
 * correct boundary, not a shortcut around it.
 */
const QUERY = `#graphql
  query CaratVariantsAvailability($ids: [ID!]!) {
    nodes(ids: $ids) {
      id
      ... on ProductVariant { availableForSale }
    }
  }`;

interface NodesEnvelope {
  data?: { nodes?: ({ id: string; availableForSale?: boolean } | null)[] };
  errors?: { message: string }[];
}

/**
 * Returns a map of `shopifyVariantGid -> availableForSale`.
 *
 * A gid ABSENT from the result (deleted product/variant, or an id that does
 * not resolve to a `ProductVariant`) is OMITTED from the map rather than
 * defaulted to either `true` or `false`. Callers must treat "missing" the
 * same as "not available" — criterion 29's "a variant nobody can buy must
 * never set the headline price" extends to "a variant we could not confirm
 * is buyable must never set it either". Deciding that at each call site
 * (rather than baking a default in here) keeps this function an honest,
 * unopinionated mirror of what Shopify actually returned.
 */
export async function getVariantsAvailability(
  client: AdminGraphqlClient,
  shopifyVariantGids: readonly string[]
): Promise<Map<string, boolean>> {
  if (shopifyVariantGids.length === 0) return new Map();

  const response = await client.graphql(QUERY, { variables: { ids: shopifyVariantGids } });
  const body = (await response.json()) as NodesEnvelope;

  if (body.errors?.length) {
    throw new AdminApiError("getVariantsAvailability", body.errors.map((e) => e.message));
  }

  const nodes = body.data?.nodes;
  if (!nodes) {
    throw new AdminApiError("getVariantsAvailability", ["response had no nodes payload"]);
  }

  const result = new Map<string, boolean>();
  for (const node of nodes) {
    if (node && typeof node.availableForSale === "boolean") {
      result.set(node.id, node.availableForSale);
    }
  }
  return result;
}
