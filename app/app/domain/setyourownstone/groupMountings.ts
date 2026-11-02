/**
 * Collapse variant-level matches into one card per mounting.
 *
 * Authoritative requirements: owner direction 2026-11-01 (SYOS mounting
 * selection).
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS
 * ---------------------------------------------------------------------------
 * The matcher answers per VARIANT, correctly: a 9 x 7 pear matches all fifteen
 * variants of the pilot mounting, because three metals times five ring sizes
 * are all genuinely compatible. Showing a customer fifteen identical cards for
 * one ring would be absurd.
 *
 * So results group by PRODUCT + MATCHED CENTRE-SIZE PROFILE. Not by product
 * alone: a mounting offered in 9 x 7 and 12 x 8 could match a stone at both
 * sizes, and those are genuinely different things to buy. The pair is the
 * identity of "this ring, in the size that fits your stone".
 *
 * THE CENTRE SIZE IS DECIDED, NOT OFFERED. It was chosen by measuring the
 * customer's stone, so it is presented as information and the customer picks
 * only metal and ring size. That is the owner's approved flow and it is also
 * the honest one — asking someone to choose a head size after we have already
 * measured their diamond invites them to get it wrong.
 *
 * PURE. No Shopify, no Prisma, no clock. The route supplies matches and
 * display data; this only decides the shape.
 */
import type { CompatibilityStatus } from "./matching";

/** One matched variant, as the route already computes it. */
export interface MatchedVariant {
  readonly variantGid: string;
  readonly status: CompatibilityStatus;
  readonly label: string;
  readonly centerSizeProfileId: string | null;
  readonly nominalLengthMm: string;
  readonly nominalWidthMm: string;
}

/** Display data read from Shopify for one variant. */
export interface VariantDisplay {
  readonly variantGid: string;
  readonly productGid: string;
  readonly productTitle: string;
  readonly productHandle: string;
  readonly featuredImageUrl: string | null;
  readonly price: string | null;
  readonly currencyCode: string | null;
  readonly availableForSale: boolean;
  /** Option name -> value, e.g. { Metal: "14K Yellow Gold", "Ring Size": "6.5" }. */
  readonly selections: Readonly<Record<string, string>>;
  /**
   * Shopify's own ordering for each option, when the reader supplied it.
   *
   * Without this the card lists values in whatever order the variants came
   * back, and ring sizes render as "6.5, 6, 7, 7.5, 8" — which reads as a
   * bug. Sorting numerically instead would be a guess that breaks on sizes
   * like "6 1/2" or on metals, so the authoritative order is taken from
   * Shopify rather than invented here.
   */
  readonly optionOrder?: Readonly<Record<string, readonly string[]>>;
  /**
   * The customer-facing CaratForUs SKU (owner §4). This is Shopify's normal
   * `variant.sku`, which since 2026-11-02 holds the +3 transformed value; the
   * raw vendor SKU lives in an admin-only metafield and never comes near here.
   */
  readonly sku?: string | null;
  /**
   * Both finished prices and the exact saving (owner §3).
   *
   * FINISHED FIGURES ONLY. Supplier cost, the markup and the setting/pavé/
   * halo/ring-size components stay in `syosMountingPricing.server.ts`; there
   * is deliberately nowhere on this type to put them, which is how §19 and
   * §25 are kept rather than merely intended. Absent when the mounting's
   * pricing inputs are incomplete — the card then shows no price instead of a
   * guessed one.
   */
  readonly prices?: {
    readonly bankPaymentPriceMinorUnits: string;
    readonly regularCardPriceMinorUnits: string;
    readonly bankPaymentSavingsMinorUnits: string;
    readonly currency: string;
    /**
     * Present only when a required $50 Stone Removal applies to the session
     * (§17.3 as corrected 2026-11-02).
     *
     * SEPARATE FROM THE MOUNTING'S OWN PRICES, WHICH ARE UNCHANGED. §7 is
     * explicit that removal is not part of the mounting formula and must not
     * be absorbed into it, so the two prices above stay exactly what the
     * pricing module produced and these are additional figures beside them.
     * Added in BigInt on the server; the page only formats them.
     */
    readonly removalFeeMinorUnits?: string;
    readonly totalCardPriceMinorUnits?: string;
    readonly totalBankPaymentPriceMinorUnits?: string;
  } | null;
}

export interface MountingOption {
  readonly name: string;
  readonly values: readonly string[];
}

export interface MountingCard {
  readonly productGid: string;
  readonly productTitle: string;
  readonly productHandle: string;
  readonly featuredImageUrl: string | null;
  /** `automatic` or `review_required` — never mixed; see the note below. */
  readonly status: CompatibilityStatus;
  readonly label: string;
  /** "9 × 7 mm", for the locked information line. */
  readonly matchedCenterSize: string;
  readonly centerSizeProfileId: string | null;
  readonly priceFrom: string | null;
  readonly currencyCode: string | null;
  /** The customer-facing CaratForUs SKU for the group, when every variant
   *  shares one — George's SKUs do not encode ring size, so they usually do. */
  readonly sku: string | null;
  /** The lowest Regular/Card price in the group, with its matching Bank
   *  Payment figure and saving. Null when pricing inputs are incomplete. */
  readonly pricesFrom: {
    readonly bankPaymentPriceMinorUnits: string;
    readonly regularCardPriceMinorUnits: string;
    readonly bankPaymentSavingsMinorUnits: string;
    readonly currency: string;
  } | null;
  /** What the customer still gets to choose. Centre size is excluded on
   *  purpose — it was decided by their stone. */
  readonly options: readonly MountingOption[];
  /** Every compatible variant, so the storefront resolves a real Shopify
   *  variant from the customer's choices rather than inventing one. */
  readonly variants: readonly {
    readonly variantGid: string;
    readonly price: string | null;
    readonly availableForSale: boolean;
    readonly selections: Readonly<Record<string, string>>;
    readonly sku: string | null;
    readonly prices: {
      readonly bankPaymentPriceMinorUnits: string;
      readonly regularCardPriceMinorUnits: string;
      readonly bankPaymentSavingsMinorUnits: string;
      readonly currency: string;
    } | null;
  }[];
}

/** The option that is decided for the customer, excluded from the selectors.
 *  Matched case-insensitively because a merchant may rename it. */
function isCenterSizeOptionName(name: string): boolean {
  return name.trim().toLowerCase().replace(/[^a-z]/g, "") === "centerstonesize";
}

/** Lowest price wins the "from" figure. Compared as a NUMBER but returned as
 *  the original string, so no money is reformatted or rounded on the way
 *  through — CLAUDE.md rule 6 applies to display as well as arithmetic. */
function lowestPrice(prices: readonly (string | null)[]): string | null {
  let best: { n: number; s: string } | null = null;
  for (const p of prices) {
    if (p === null) continue;
    const n = Number(p);
    if (!Number.isFinite(n)) continue;
    if (best === null || n < best.n) best = { n, s: p };
  }
  return best?.s ?? null;
}

/** One SKU for the whole group, or null when the group disagrees. George's
 *  SKUs do not encode ring size, so a group normally shares one. */
function oneSku(ds: readonly VariantDisplay[]): string | null {
  const skus = new Set(ds.map((d) => d.sku ?? null));
  if (skus.size !== 1) return null;
  return [...skus][0] ?? null;
}

/** The group's cheapest Regular/Card price, with ITS bank figure and saving.
 *  Taken as a set rather than three independent minima, so the three numbers
 *  on the card always belong to the same real variant. */
function lowestPrices(ds: readonly VariantDisplay[]) {
  let best: VariantDisplay["prices"] = null;
  for (const d of ds) {
    const p = d.prices;
    if (!p) continue;
    if (best === null || BigInt(p.regularCardPriceMinorUnits) < BigInt(best.regularCardPriceMinorUnits)) {
      best = p;
    }
  }
  return best ?? null;
}

/**
 * Group matches into one card per mounting + matched centre size.
 *
 * @param matches  every compatible variant the matcher returned
 * @param display  display data, keyed by variant gid
 */
export function groupMountings(
  matches: readonly MatchedVariant[],
  display: ReadonlyMap<string, VariantDisplay>
): readonly MountingCard[] {
  const groups = new Map<string, { match: MatchedVariant[]; display: VariantDisplay[] }>();

  for (const m of matches) {
    const d = display.get(m.variantGid);
    // A variant with no display data cannot be rendered or bought. Dropped
    // rather than shown as a card with no title or price.
    if (!d) continue;

    // Product AND profile. Grouping by product alone would merge two centre
    // sizes of the same ring into one card and lose which size was matched.
    const key = `${d.productGid}::${m.centerSizeProfileId ?? "none"}`;
    const g = groups.get(key) ?? { match: [], display: [] };
    g.match.push(m);
    g.display.push(d);
    groups.set(key, g);
  }

  const cards: MountingCard[] = [];

  for (const { match, display: ds } of groups.values()) {
    const first = match[0]!;
    const firstD = ds[0]!;

    // A group's variants all share one profile, so they share one verdict.
    // If they somehow disagree, the WEAKER one wins: telling a customer
    // "matches" when part of the group only warranted review would overstate
    // what we know about their stone.
    const anyReview = match.some((m) => m.status === "review_required");
    const status: CompatibilityStatus = anyReview ? "review_required" : first.status;
    const label = anyReview
      ? match.find((m) => m.status === "review_required")!.label
      : first.label;

    // Option values in Shopify's own order, de-duplicated, centre size removed.
    const optionOrder: string[] = [];
    const valuesByOption = new Map<string, string[]>();
    for (const d of ds) {
      for (const [name, value] of Object.entries(d.selections)) {
        if (isCenterSizeOptionName(name)) continue;
        if (!valuesByOption.has(name)) {
          valuesByOption.set(name, []);
          optionOrder.push(name);
        }
        const list = valuesByOption.get(name)!;
        if (!list.includes(value)) list.push(value);
      }
    }

    cards.push({
      productGid: firstD.productGid,
      productTitle: firstD.productTitle,
      productHandle: firstD.productHandle,
      featuredImageUrl: firstD.featuredImageUrl,
      status,
      label,
      matchedCenterSize: `${first.nominalLengthMm} × ${first.nominalWidthMm} mm`,
      centerSizeProfileId: first.centerSizeProfileId,
      priceFrom: lowestPrice(ds.map((d) => d.price)),
      currencyCode: firstD.currencyCode,
      options: optionOrder.map((name) => {
        const seen = valuesByOption.get(name)!;
        const canonical = firstD.optionOrder?.[name];
        // Shopify's order, filtered to the values that actually matched.
        // Falls back to first-seen if the reader did not supply an order.
        const values = canonical
          ? canonical.filter((v) => seen.includes(v))
          : seen;
        return { name, values: values.length > 0 ? values : seen };
      }),
      sku: oneSku(ds),
      pricesFrom: lowestPrices(ds),
      variants: ds.map((d) => ({
        variantGid: d.variantGid,
        price: d.price,
        availableForSale: d.availableForSale,
        selections: d.selections,
        sku: d.sku ?? null,
        prices: d.prices ?? null,
      })),
    });
  }

  // Automatic matches before review-required ones: a customer should see what
  // fits before what might.
  return cards.sort((a, b) => {
    if (a.status !== b.status) return a.status === "automatic" ? -1 : 1;
    return a.productTitle.localeCompare(b.productTitle);
  });
}
