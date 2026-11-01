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
      options: optionOrder.map((name) => ({ name, values: valuesByOption.get(name)! })),
      variants: ds.map((d) => ({
        variantGid: d.variantGid,
        price: d.price,
        availableForSale: d.availableForSale,
        selections: d.selections,
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
