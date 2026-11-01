import { Money } from "~/domain/money/money";

import { MAX_VENDOR_RING_SIZE, MIN_VENDOR_RING_SIZE } from "./vendorDefaultRingSize";
import type { MountingSpec } from "./mountingPricing";

/**
 * Pricing inputs for a vendor mounting, projected from SHOPIFY.
 *
 * Authoritative requirements: owner decisions 2026-11-01 (§1-§3).
 *
 * ---------------------------------------------------------------------------
 * SHOPIFY IS THE OPERATIONAL SOURCE OF TRUTH
 * ---------------------------------------------------------------------------
 * A George's mounting is authored in Shopify Product Admin and its pricing
 * inputs live there too: supplier cost on `inventoryItem.unitCost`, and the
 * rest on pinned product metafields staff can see and verify. There is no
 * second editable catalogue, so there is no second place to keep George's
 * cost up to date and no way for the two to disagree.
 *
 * This module is the ONLY boundary between that Shopify-shaped data and the
 * pricing rules. It is a pure projection: no Shopify client, no Prisma, no
 * clock. The caller fetches, this validates and shapes, `mountingPricing`
 * prices. Keeping the fetch out means every refusal below is unit-testable
 * without a network.
 *
 * ---------------------------------------------------------------------------
 * EVERY MISSING FACT IS A REFUSAL, NOT A DEFAULT
 * ---------------------------------------------------------------------------
 * A missing input here has no safe default. Each one would produce a
 * plausible, confidently wrong price:
 *
 *   large stone count absent  ->  assuming 1 is $70 per stone wrong
 *   band pave count absent    ->  assuming 0 under-prices every pave band
 *   hidden halo absent        ->  assuming false under-prices by $100
 *   unit cost absent or zero  ->  prices the mounting at the fees alone
 *
 * None of those fail loudly, which is precisely why they are refused. A ZERO
 * is different from an ABSENCE and is accepted: `band_pave_diamond_count = 0`
 * is the vendor confirming a plain band, which is a fact.
 *
 * WHAT MUST NOT REACH A PRICE. Vendor min/max acceptance dimensions, nominal
 * centre sizes, shape, prong flags and the rest of the SYOS compatibility
 * data decide whether a mounting FITS A STONE. They have no pricing meaning,
 * and `vendorMountingInputsFence.test.ts` checks that none of them appear
 * here.
 */

/** Exactly the Shopify fields that bear on price. Nothing else is accepted. */
export interface ShopifyMountingPricingFields {
  /** `inventoryItem.unitCost.amount` — George's actual cost, major units. */
  readonly unitCostAmount: string | null;
  readonly unitCostCurrency: string | null;
  /** `carat.default_ring_size`. */
  readonly defaultRingSize: string | null;
  /** `carat.large_stone_setting_count`. */
  readonly largeStoneSettingCount: string | null;
  /** `carat.band_pave_diamond_count`. Zero is a fact; absent is not. */
  readonly bandPaveDiamondCount: string | null;
  /** `carat.hidden_halo`. */
  readonly hiddenHalo: string | null;
}

export type VendorMountingInputs =
  | { readonly ok: true; readonly spec: MountingSpec }
  | { readonly ok: false; readonly reasons: readonly string[] };

/** A whole non-negative count, from a `number_integer` metafield. */
function parseCount(raw: string | null): number | null {
  if (raw === null || raw.trim() === "") return null;
  if (!/^\d+$/.test(raw.trim())) return null;
  return Number.parseInt(raw.trim(), 10);
}

/** A half-step ring size, as a canonical decimal string. */
function parseRingSize(raw: string | null): string | null {
  if (raw === null || raw.trim() === "") return null;
  const t = raw.trim();
  if (!/^\d+(\.\d+)?$/.test(t)) return null;
  const [whole, frac = ""] = t.split(".");
  // Tenths as an integer: ring sizes come in half steps, so this is exact and
  // no float comparison happens at a boundary.
  if (frac.replace(/0+$/, "").length > 1) return null;
  const tenths = Number.parseInt(whole!, 10) * 10 + (frac === "" ? 0 : Number.parseInt(frac[0]!, 10));
  if (tenths % 10 !== 0 && tenths % 10 !== 5) return null;
  if (tenths < MIN_VENDOR_RING_SIZE * 10 || tenths > MAX_VENDOR_RING_SIZE * 10) return null;
  // Integer division only — tenths is a multiple of 5 here, so both branches
  // are exact. No Math.trunc: the money-safety rules forbid that whole family,
  // and a half-step size has no need of it.
  return tenths % 10 === 0 ? String(tenths / 10) : `${(tenths - 5) / 10}.5`;
}

/** Shopify's `boolean` metafield, which arrives as the string "true"/"false". */
function parseBoolean(raw: string | null): boolean | null {
  if (raw === null || raw.trim() === "") return null;
  if (raw.trim() === "true") return true;
  if (raw.trim() === "false") return false;
  return null;
}

/**
 * Project Shopify's structured fields into a `MountingSpec`, or refuse with
 * every reason at once.
 *
 * ALL reasons are returned, not just the first. Staff fixing an import should
 * see the whole list rather than discovering the next missing field on the
 * next run.
 */
export function vendorMountingInputs(
  fields: ShopifyMountingPricingFields
): VendorMountingInputs {
  const reasons: string[] = [];

  // ---- supplier cost
  const costAmount = fields.unitCostAmount?.trim() ?? "";
  const currency = fields.unitCostCurrency?.trim() ?? "";
  let vendorCost: Money | null = null;
  if (costAmount === "") {
    reasons.push(
      "inventoryItem.unitCost is not set; it must hold George's actual cost for this configuration"
    );
  } else if (!/^\d+(\.\d{1,2})?$/.test(costAmount)) {
    reasons.push(`inventoryItem.unitCost "${costAmount}" is not a plain money amount`);
  } else if (currency === "") {
    reasons.push("inventoryItem.unitCost has no currency");
  } else {
    // Major units -> minor units at the one sanctioned boundary.
    vendorCost = Money.fromDecimalMajorUnits(costAmount, currency, "HALF_UP_MINOR_UNIT_V1");
    if (vendorCost.amountMinorUnits <= 0n) {
      reasons.push(
        "inventoryItem.unitCost is zero; the mounting would be priced at the setting fees alone"
      );
      vendorCost = null;
    }
  }

  // ---- base ring size
  const baseRingSize = parseRingSize(fields.defaultRingSize);
  if (baseRingSize === null) {
    reasons.push(
      fields.defaultRingSize === null || fields.defaultRingSize.trim() === ""
        ? "carat.default_ring_size is not set; read it from the vendor title at import and stop pricing until it is"
        : `carat.default_ring_size "${fields.defaultRingSize}" is not a supported half-step size between ` +
          `${MIN_VENDOR_RING_SIZE} and ${MAX_VENDOR_RING_SIZE}`
    );
  }

  // ---- large stones
  const largeStoneCount = parseCount(fields.largeStoneSettingCount);
  if (largeStoneCount === null) {
    reasons.push(
      "carat.large_stone_setting_count is not a confirmed whole count; a guess is $70 per stone wrong"
    );
  }

  // ---- band pave. ZERO IS A CONFIRMED FACT, ABSENCE IS NOT.
  const bandPaveDiamondCount = parseCount(fields.bandPaveDiamondCount);
  if (bandPaveDiamondCount === null) {
    reasons.push(
      "carat.band_pave_diamond_count is not established; flag for review rather than counting stones in a photograph"
    );
  }

  // ---- hidden halo
  const hasHiddenHalo = parseBoolean(fields.hiddenHalo);
  if (hasHiddenHalo === null) {
    reasons.push(
      "carat.hidden_halo is not established; assuming no halo under-prices the mounting by $100"
    );
  }

  if (
    reasons.length > 0 ||
    vendorCost === null ||
    baseRingSize === null ||
    largeStoneCount === null ||
    bandPaveDiamondCount === null ||
    hasHiddenHalo === null
  ) {
    return { ok: false, reasons };
  }

  return {
    ok: true,
    spec: {
      vendorCost: vendorCost.toJSON(),
      largeStoneCount,
      bandPaveDiamondCount,
      hasHiddenHalo,
      baseRingSize,
    },
  };
}
