import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * FULL BLEED MUST NOT BE BUILT OUT OF `100vw`.
 *
 * `100vw` is the viewport width INCLUDING the classic vertical scrollbar.
 * The containing block of an in-flow element is the width EXCLUDING it. On
 * every browser that reserves scrollbar space (Windows Chrome reserves 12px
 * at the owner's display scaling) the two differ, so
 *
 *     width: 100vw;
 *     margin: 0 calc(50% - 50vw);
 *
 * produces a band one scrollbar wider than the page content box, pulled half
 * a scrollbar past the left edge.
 *
 * THIS SHIPPED ON BOTH FIRST ACCESS PAGES and is what the owner reported as
 * form pages looking distorted. Measured 2026-11-25 on `/pages/first-access`
 * and `/pages/first-access-v1`, identically at 1440, 1280, 1024, 390 and 375:
 *
 *   - `documentElement.scrollWidth` (373) !== `clientWidth` (367): 6px of
 *     horizontal overflow on a page that should have none;
 *   - the band sat at `left: -6.08px`, so every band was 6px off centre and
 *     its right 6px was clipped by the rule's own `overflow-x: hidden`;
 *   - text inside landed on fractional pixels (`.fa2-display` at
 *     `left: 11.92px`), which at a 1.5625 device pixel ratio puts glyphs on
 *     half device pixels. That is why the type looked soft.
 *
 * Neither page needed the trick at all: both render through
 * `layout/first-access.liquid`, which has no header, footer or page shell, so
 * `main` and `.shopify-section` are already full width and unpadded. The fix
 * was to delete the `vw` arithmetic and let normal flow do it.
 *
 * A fence rather than a one-off fix because the pattern had already been
 * copied once, from `first-access.css` into `first-access-v2.css`, and the
 * stale comment on both ("cancels the theme page shell") explained a cause
 * that was not real, which is exactly how it survived review.
 *
 * `svw`/`dvw` are fenced alongside `vw`: all three include the scrollbar, so
 * swapping units would reintroduce the identical 6px.
 *
 * NOT IN SCOPE: `position: fixed` overlays. A fixed element is out of flow and
 * contributes nothing to `documentElement.scrollWidth`, so `width: 100vw` on
 * the cart drawer cannot produce this defect. Verified by measurement: `/cart`
 * reports `scrollWidth === clientWidth`. That one file is allowlisted below.
 *
 * Font sizing with `vw` (`clamp(3.2rem, 6.4vw, 5.4rem)`) is also out of scope.
 * A scrollbar-sensitive font size is at most a sub pixel difference in glyph
 * size; it cannot move a layout box or create overflow.
 */

const THEME = join(process.cwd(), "..", "theme");

/** Where a layout rule can actually reach a customer. */
const STYLE_DIRS = ["assets", "sections", "snippets", "templates", "layout"];

/**
 * Out of flow, so it cannot widen the document. See NOT IN SCOPE above.
 */
const OUT_OF_FLOW_ALLOWLIST = ["assets/component-cart-drawer.css"];

/**
 * The two halves of the broken idiom, each fenced on its own so a failure
 * message names which one came back.
 *
 * `BOX_SIZE` deliberately matches only the properties that establish a box's
 * width, not `font-size`, `padding` or `gap`, where a `vw` unit is a
 * sizing choice rather than a layout-breaking one.
 */
const FORBIDDEN: Array<{ label: string; pattern: RegExp }> = [
  {
    label: "a bare viewport-width box size (width/min-width/max-width: 100vw)",
    // Deliberately only the WHOLE value, terminated by `;` or the rule's `}`.
    // Two things must not be caught. `max-width: calc(100vw - 3rem)` and
    // `width: min(52rem, calc(100vw - 2.4rem))` are CAPS: they can only make
    // a box narrower than the viewport, never wider than the content box, so
    // they cannot create overflow. And responsive image descriptors such as
    // `sizes="(min-width: 750px) 38vw, 100vw"` are not CSS declarations at
    // all; an earlier draft of this fence matched them because its gap
    // expression ran from `min-width:` straight across into the descriptor.
    pattern: /(?:^|[;{\s])(?:min-|max-)?width\s*:\s*100(?:vw|svw|dvw)\s*(?:!important\s*)?[;}]/i,
  },
  {
    label: "the half-viewport negative margin, calc(50% - 50vw)",
    pattern: /calc\(\s*50%\s*-\s*50(?:vw|svw|dvw)\s*\)/i,
  },
];

function walk(dir: string): string[] {
  let out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out = out.concat(walk(full));
    else out.push(full);
  }
  return out;
}

/**
 * Strips CSS and JS comments. Essential here, not cosmetic: the fix left a
 * long comment in both stylesheets explaining why `100vw` is banned, and that
 * comment names the very units being fenced. Without stripping, the fence
 * would fail on its own documentation.
 */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

function rel(file: string): string {
  return file.slice(THEME.length + 1).replace(/\\/g, "/");
}

function styleBearingFiles(): string[] {
  return STYLE_DIRS.flatMap((d) => {
    try {
      return walk(join(THEME, d));
    } catch {
      return [];
    }
  }).filter((f) => /\.(css|liquid|json)$/i.test(f));
}

describe("full bleed is never built from viewport width units", () => {
  for (const { label, pattern } of FORBIDDEN) {
    it(`no in-flow theme rule uses ${label}`, () => {
      const offenders = styleBearingFiles()
        .filter((f) => !OUT_OF_FLOW_ALLOWLIST.includes(rel(f)))
        .filter((f) => pattern.test(stripComments(readFileSync(f, "utf8"))))
        .map(rel);

      expect(
        offenders,
        `100vw/100svw/100dvw includes the vertical scrollbar; the containing ` +
          `block of an in-flow element does not. Using it for full bleed makes ` +
          `the element one scrollbar wider than the page, breaking ` +
          `documentElement.scrollWidth === clientWidth and putting all text on ` +
          `fractional pixels. These templates render without a page shell, so ` +
          `full bleed needs no width arithmetic at all. Offending files: ` +
          `${offenders.join(", ")}`
      ).toEqual([]);
    });
  }

  /**
   * Guards against the fence passing because the rules it protects were
   * deleted or renamed. Both First Access roots must still exist and must
   * still be the full-bleed ivory ground; they just have to achieve it
   * without `vw`.
   */
  it("both First Access page roots still exist and still run edge to edge", () => {
    for (const [file, selector] of [
      ["assets/first-access-v2.css", ".fa2 {"],
      ["assets/first-access.css", ".carat-fa {"],
    ] as const) {
      const source = readFileSync(join(THEME, file), "utf8");
      expect(source.includes(selector), `${file} no longer defines ${selector}`).toBe(true);

      const rule = source.slice(source.indexOf(selector), source.indexOf("}", source.indexOf(selector)));
      const body = stripComments(rule);
      expect(body, `${file}: ${selector} should still clip its own overflow`).toContain("overflow-x");
      expect(/\b100(?:vw|svw|dvw)\b/.test(body), `${file}: ${selector} reintroduced a viewport width`).toBe(
        false
      );
    }
  });
});
