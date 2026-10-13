import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * L1 REGRESSION FENCE (docs/specs/SLICE-2B-CART-SURFACE-INVENTORY.md,
 * "LOCKED STAGE 2B ARCHITECTURE REQUIREMENTS" §L1).
 *
 * Shopify's cart and line objects — `cart.items_subtotal_price`,
 * `cart.total_price`, `cart.original_total_price`, `item.final_line_price`,
 * `item.original_line_price`, `item.final_price`, `item.original_price` —
 * are **Card-basis inputs, never display values**. There is no mode-aware
 * cart object in Shopify to read: Bank-mode presentation has to be derived
 * from one authoritative mode-aware pricing source, and every cart money
 * surface must consume that source rather than one of the objects above
 * directly.
 *
 * THE FAILURE THIS PREVENTS. A cart money surface renders one of these
 * objects straight from Liquid. It looks correct in Card mode, because the
 * object genuinely does hold the Card price. In Bank Payment mode it is
 * simply wrong — a customer who chose Bank Payment sees the higher Card
 * figure, silently, with nothing on screen to contradict it (see A4 /
 * `cart-live-region-text.liquid` in the inventory, which is worse still:
 * invisible to a sighted reviewer). And because `assets/cart.js` and
 * `assets/cart-drawer.js` re-render cart sections through Shopify's Section
 * Rendering API and swap `innerHTML` wholesale (inventory D1/D2), a surface
 * "fixed" by hand-editing the rendered HTML reverts to raw Card pricing on
 * the very next quantity change. Only a Liquid-level source fix survives
 * that round trip.
 *
 * WALKS THE SOURCE rather than hand-maintaining a file list — same approach
 * as csrfResourceRouteFence.test.ts and priceAffectingColumnsFence.test.ts,
 * for the same reason: a hardcoded list stops protecting the boundary the
 * moment someone adds a file and forgets to update it.
 *
 * SHAPE OF THE FENCE. The inventory identified exactly four existing
 * surfaces that render these objects today (A1-A4) — Dawn does this natively
 * and Stage 2B has not converted them yet. Those four are listed below as
 * KNOWN_UNCONVERTED_CART_MONEY_SURFACES, each tied to its inventory id. That
 * list may only shrink: a later task that converts a surface to the
 * mode-aware source must remove its entry here, and this file will then fail
 * loudly if the entry is stale (the file no longer matches, i.e. it was
 * fixed without updating this list) via the "still matches" test below. Any
 * file NOT in the list — including a brand-new one — is held to the L1 rule
 * immediately and fails outright if it renders one of these objects.
 *
 * SCOPE. This fence walks `.liquid` templates. Confirmed by grep across
 * theme/assets/*.js (cart.js, cart-drawer.js, cart-notification.js,
 * price-per-item.js, standard-actions-override.js): none of them read these
 * money fields directly in JS — they fetch and swap server-rendered HTML
 * from the Section Rendering API, so the Liquid-level check is where the
 * actual read of these objects happens. If a future change makes any theme
 * JS read `.total_price`/`.final_price`/etc. directly from a fetched cart
 * JSON payload, that is a new violation this fence does not yet cover and
 * would need extending to `assets/*.js`.
 *
 * KNOWN BLIND SPOT. The patterns below match the literal `cart.` / `item.`
 * prefixes named in L1 (and the actual `item` loop-variable name used by
 * every fenced file's `for item in cart.items`). A future file that
 * aliases the cart object (`{% assign c = cart %}{{ c.total_price }}`) or
 * renames its loop variable would not be caught. Documented rather than
 * solved, matching the csrfResourceRouteFence's non-recursive-directory
 * note — if that pattern appears, extend the regex bank rather than trust
 * it silently.
 */

const THEME_ROOT = join(process.cwd(), "..", "theme");
const LIQUID_ROOT_DIRS = ["layout", "sections", "snippets", "templates"] as const;

const CART_MONEY_OBJECT_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "cart.items_subtotal_price", pattern: /\bcart\.items_subtotal_price\b/ },
  { name: "cart.total_price", pattern: /\bcart\.total_price\b/ },
  { name: "cart.original_total_price", pattern: /\bcart\.original_total_price\b/ },
  { name: "item.final_line_price", pattern: /\bitem\.final_line_price\b/ },
  { name: "item.original_line_price", pattern: /\bitem\.original_line_price\b/ },
  { name: "item.final_price", pattern: /\bitem\.final_price\b/ },
  { name: "item.original_price", pattern: /\bitem\.original_price\b/ },
];

/**
 * The four surfaces the C4 inventory found rendering these objects today, at the point
 * this fence was written (Task 1 of 2B-2, BEFORE any template was converted). All four
 * were converted in task 2B-3, per R12's DOM contract: every cart money node in these
 * files now carries `data-carat-money` (one of `line-unit`, `line-total`, `cart-subtotal`,
 * `cart-total`), starts `data-carat-mode-pending`, and is populated by client-side JS from
 * the `/apps/carat/cart` proxy response rather than from any Shopify cart/line price
 * object — so this map is empty. Remove an entry here only when the corresponding surface
 * has been converted to read the single mode-aware pricing source instead; add one back,
 * with its own reasoned entry, only for a surface genuinely mid-conversion.
 */
const KNOWN_UNCONVERTED_CART_MONEY_SURFACES: Readonly<Record<string, { inventoryId: string; reason: string }>> = {};

function walkLiquidFiles(absoluteDir: string): string[] {
  const entries = readdirSync(absoluteDir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const absolutePath = join(absoluteDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkLiquidFiles(absolutePath));
    } else if (entry.isFile() && entry.name.endsWith(".liquid")) {
      files.push(absolutePath);
    }
  }
  return files;
}

/** Relative path using forward slashes, matching the keys used above and in the inventory doc. */
function toRelativeKey(absolutePath: string): string {
  return relative(THEME_ROOT, absolutePath).split("\\").join("/");
}

function allThemeLiquidFiles(): string[] {
  return LIQUID_ROOT_DIRS.flatMap((dir) => walkLiquidFiles(join(THEME_ROOT, dir)));
}

function matchedObjectNames(source: string): string[] {
  return CART_MONEY_OBJECT_PATTERNS.filter(({ pattern }) => pattern.test(source)).map(({ name }) => name);
}

describe("L1 fence — no cart money surface renders a Shopify cart money object directly", () => {
  it("GUARDS THE GUARD: the walk actually found theme .liquid files, in every root directory", () => {
    // If this silently found nothing (a wrong THEME_ROOT, a renamed directory), every
    // check below would vacuously pass while covering nothing.
    const files = allThemeLiquidFiles();
    expect(files.length).toBeGreaterThanOrEqual(80);
    for (const dir of LIQUID_ROOT_DIRS) {
      const absoluteDir = join(THEME_ROOT, dir);
      expect(
        files.some((f) => f.startsWith(absoluteDir)),
        `expected at least one .liquid file under theme/${dir}/ — the walk found none, ` +
          "so this fence is not actually checking that directory."
      ).toBe(true);
    }
  });

  it("GUARDS THE GUARD: every known-unconverted surface was found by the walk and still contains " +
    "the object it is listed for", () => {
    const walkedKeys = new Set(allThemeLiquidFiles().map(toRelativeKey));

    for (const [relativePath, { inventoryId }] of Object.entries(KNOWN_UNCONVERTED_CART_MONEY_SURFACES)) {
      expect(
        walkedKeys.has(relativePath),
        `${relativePath} (inventory ${inventoryId}) is listed in KNOWN_UNCONVERTED_CART_MONEY_SURFACES ` +
          "but the walk did not find it under theme/ — either it was renamed/moved (update this fence) " +
          "or deleted (remove the entry)."
      ).toBe(true);

      const source = readFileSync(join(THEME_ROOT, relativePath), "utf8");
      const matches = matchedObjectNames(source);
      expect(
        matches.length,
        `${relativePath} (inventory ${inventoryId}) is listed as known-unconverted but no longer ` +
          "matches any Shopify cart money object pattern. That means it was already converted — " +
          "REMOVE its entry from KNOWN_UNCONVERTED_CART_MONEY_SURFACES rather than leaving it here; " +
          "a stale entry hides the fact that this surface is no longer covered by the strict check below."
      ).toBeGreaterThan(0);
    }
  });

  it("every known-unconverted entry (if any remain) names a real inventory row (A1-A4), not a made-up one", () => {
    // All four original rows were converted in task 2B-3, so this is normally empty — see the
    // map's own doc comment. Asserted as a subset rather than an exact-match set (the way this
    // test read before 2B-3) so it keeps protecting against a fabricated inventory id on any
    // FUTURE entry without itself requiring the map to be non-empty.
    const inventoryIds = Object.values(KNOWN_UNCONVERTED_CART_MONEY_SURFACES).map((v) => v.inventoryId);
    for (const id of inventoryIds) {
      expect(["A1", "A2", "A3", "A4"]).toContain(id);
    }
  });

  const knownUnconvertedKeys = new Set(Object.keys(KNOWN_UNCONVERTED_CART_MONEY_SURFACES));
  const candidateFiles = allThemeLiquidFiles().map((absolutePath) => ({
    absolutePath,
    relativeKey: toRelativeKey(absolutePath),
  }));

  it.each(candidateFiles.filter((f) => !knownUnconvertedKeys.has(f.relativeKey)))(
    "$relativeKey does not render a Shopify cart money object directly",
    ({ absolutePath, relativeKey }) => {
      const source = readFileSync(absolutePath, "utf8");
      const matches = matchedObjectNames(source);

      expect(
        matches,
        `theme/${relativeKey} renders Shopify cart money object(s) directly: ${matches.join(", ")}. ` +
          "Per L1 (docs/specs/SLICE-2B-CART-SURFACE-INVENTORY.md), these objects are Card-basis " +
          "INPUTS, never display values — a customer in Bank Payment mode will see the Card price " +
          "on this surface with nothing to indicate the mismatch. Route this value through the single " +
          "mode-aware pricing source instead. If this surface is a newly-discovered case that is " +
          "genuinely mid-conversion, add it to KNOWN_UNCONVERTED_CART_MONEY_SURFACES with its own " +
          "reasoned entry rather than silencing this failure — and note that assets/cart.js and " +
          "assets/cart-drawer.js re-render sections through the Section Rendering API, so a fix applied " +
          "only to server-rendered HTML (rather than to this template) will not survive the next " +
          "quantity change."
      ).toEqual([]);
    }
  );
});

describe("guard the guard — the classifier actually detects the violation it exists to catch", () => {
  it("flags a new surface rendering cart.total_price", () => {
    const VIOLATING_SOURCE = `<p>{{ cart.total_price | money_with_currency }}</p>`;
    expect(matchedObjectNames(VIOLATING_SOURCE)).toContain("cart.total_price");
  });

  it("flags a new surface rendering item.final_line_price", () => {
    const VIOLATING_SOURCE = `{%- for item in cart.items -%}{{ item.final_line_price | money }}{%- endfor -%}`;
    expect(matchedObjectNames(VIOLATING_SOURCE)).toContain("item.final_line_price");
  });

  it("distinguishes cart.total_price from cart.original_total_price (no substring false-positive)", () => {
    expect(matchedObjectNames("{{ cart.original_total_price | money }}")).toEqual(["cart.original_total_price"]);
  });

  it("distinguishes item.original_price from item.original_line_price", () => {
    expect(matchedObjectNames("{{ item.original_price | money }}")).toEqual(["item.original_price"]);
    expect(matchedObjectNames("{{ item.original_line_price | money }}")).toEqual(["item.original_line_price"]);
  });

  it("does not flag a mode-aware helper with a similar-looking but different name", () => {
    const SAFE_SOURCE = `{{ mode_aware_cart.total_price_for_mode | money }}`;
    expect(matchedObjectNames(SAFE_SOURCE)).toEqual([]);
  });

  it("is not fooled by the object mentioned only in a Liquid comment", () => {
    const COMMENTED = `{% comment %} do not use cart.total_price here {% endcomment %}`;
    // Documented limitation, not a false pass we rely on: this fence does not strip Liquid
    // comments (unlike the CSRF fence, which strips JS comments), so a comment mentioning one
    // of these objects DOES currently trip the check. That is a deliberate false-positive bias
    // (over-flagging is safer than under-flagging for a money-display fence) rather than a gap —
    // recorded here so a future reader does not "fix" it into a false negative.
    expect(matchedObjectNames(COMMENTED)).toContain("cart.total_price");
  });
});
