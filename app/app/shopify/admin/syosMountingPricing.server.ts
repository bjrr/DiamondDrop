import { computeMountingPrice } from "~/domain/pricing/mountingPricing";
import { vendorMountingInputs } from "~/domain/pricing/vendorMountingInputs";

import type { AdminGraphqlClient } from "./productClient.server";
import { AdminApiError } from "./productClient.server";

/**
 * Both customer-facing prices for a matched SYOS mounting variant.
 *
 * Authoritative requirements: owner §3/§4 (2026-11-02) — the mounting card and
 * the detail view must show Regular Price, Bank Payment Price and the exact
 * saving.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS READS COST AND THE CARD NEVER SEES IT
 * ---------------------------------------------------------------------------
 * The prices are COMPUTED here from the same structured Shopify inputs the
 * pricing slice established — `inventoryItem.unitCost` plus the product's
 * pricing metafields — through `vendorMountingInputs` and
 * `computeMountingPrice`. No parallel pricing path, and no reading the
 * `carat.bank_payment_price_minor_units` metafield either: that is a
 * presentation cache (ARCHITECTURE-MVP1 §5), and money is never reconciled
 * from a cache.
 *
 * Supplier cost, the markup, the setting/pavé/halo/ring-size components and
 * the uplift rate all stay inside this module. What leaves it is three
 * finished figures. That separation is the point: §19 and §25 forbid any of
 * those inputs reaching a customer, and the way to honour that is for the
 * card's type to have nowhere to put them.
 *
 * A variant whose inputs are incomplete yields NO price rather than a guess.
 * The storefront then shows the mounting without a price instead of inventing
 * one, and the operator dashboard already reports the misconfiguration.
 */
export interface MountingVariantPrices {
  /** Minor units, as decimal strings — never JS numbers (money safety). */
  readonly bankPaymentPriceMinorUnits: string;
  readonly regularCardPriceMinorUnits: string;
  readonly bankPaymentSavingsMinorUnits: string;
  readonly currency: string;
}

const READ_PRICING_SOURCE = `#graphql
  query SyosMountingPricingSource($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id
        selectedOptions { name value }
        inventoryItem { unitCost { amount currencyCode } }
        product {
          id
          dflt: metafield(namespace: "carat", key: "default_ring_size") { value }
          stones: metafield(namespace: "carat", key: "large_stone_setting_count") { value }
          pave: metafield(namespace: "carat", key: "band_pave_diamond_count") { value }
          halo: metafield(namespace: "carat", key: "hidden_halo") { value }
        }
      }
    }
  }`;

interface RawPricingSource {
  id: string;
  selectedOptions?: { name: string; value: string }[];
  inventoryItem?: { unitCost?: { amount?: string | null; currencyCode?: string | null } | null } | null;
  product?: {
    id: string;
    dflt?: { value?: string | null } | null;
    stones?: { value?: string | null } | null;
    pave?: { value?: string | null } | null;
    halo?: { value?: string | null } | null;
  } | null;
}

/** The option that carries the customer's chosen ring size. */
const RING_SIZE_OPTION = "Ring Size";

/**
 * Compute both prices for each variant gid.
 *
 * Variants whose pricing inputs are incomplete are simply absent from the
 * result — the caller renders them without a price.
 */
export async function readMountingVariantPrices(
  client: AdminGraphqlClient,
  variantGids: readonly string[]
): Promise<Map<string, MountingVariantPrices>> {
  const out = new Map<string, MountingVariantPrices>();
  if (variantGids.length === 0) return out;

  // `nodes` is capped; page rather than silently truncating.
  const CHUNK = 100;
  for (let i = 0; i < variantGids.length; i += CHUNK) {
    // A Shopify operation can be refused inside an HTTP 200, so both failure
    // modes are checked — the transport status alone proves nothing.
    const response = await client.graphql(READ_PRICING_SOURCE, {
      variables: { ids: variantGids.slice(i, i + CHUNK) },
    });
    const envelope = (await response.json()) as {
      data?: { nodes?: (RawPricingSource | null)[] };
      errors?: { message: string }[];
    };
    if (envelope.errors?.length) {
      throw new AdminApiError(
        "nodes(mountingPricingSource)",
        envelope.errors.map((e) => e.message)
      );
    }
    if (!envelope.data) {
      throw new AdminApiError("nodes(mountingPricingSource)", ["response contained no data"]);
    }

    for (const node of envelope.data.nodes ?? []) {
      if (!node?.product) continue;
      const ringSize = (node.selectedOptions ?? []).find((o) => o.name === RING_SIZE_OPTION)?.value;
      if (!ringSize) continue;

      const projected = vendorMountingInputs({
        unitCostAmount: node.inventoryItem?.unitCost?.amount ?? null,
        unitCostCurrency: node.inventoryItem?.unitCost?.currencyCode ?? null,
        defaultRingSize: node.product.dflt?.value ?? null,
        largeStoneSettingCount: node.product.stones?.value ?? null,
        bandPaveDiamondCount: node.product.pave?.value ?? null,
        hiddenHalo: node.product.halo?.value ?? null,
      });
      // Fail closed and quietly: a mounting with incomplete pricing inputs is
      // shown without a price, never with a guessed one.
      if (!projected.ok) continue;

      let priced;
      try {
        priced = computeMountingPrice(projected.spec, ringSize);
      } catch {
        // An unsupported ring size throws rather than returning a figure.
        continue;
      }

      out.set(node.id, {
        bankPaymentPriceMinorUnits: priced.bankPaymentPrice.amountMinorUnits,
        regularCardPriceMinorUnits: priced.regularCardPrice.amountMinorUnits,
        bankPaymentSavingsMinorUnits: priced.bankPaymentSavings.amountMinorUnits,
        currency: priced.currency,
      });
    }
  }
  return out;
}
