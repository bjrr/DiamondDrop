import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE HEADER NAVIGATION — ten items on one line, or the hamburger.
 *
 * ===========================================================================
 * WHAT WENT WRONG, MEASURED
 * ===========================================================================
 * The launch menu is ten items and several labels are long. Measured in the
 * browser, they need ~823px of intrinsic width; the rest of the header needs
 * ~413px (logo 185, icons 128, padding 100). Dawn switches to the hamburger
 * at 990px, which for this menu is far too late — at 1229px the items were
 * ALREADY WRAPPING ONTO A SECOND ROW.
 *
 * The fix is two rules and one deliberate omission, all in
 * assets/carat-header-nav.css. This file pins the parts that are easy to
 * undo by accident.
 *
 * ===========================================================================
 * THE ORDERING DEPENDENCY, WHICH IS THE SUBTLE ONE
 * ===========================================================================
 * sections/header.liquid contains an inline <style> block that sets
 * `header-drawer { display: none }` from 990px. The override that shows the
 * drawer again between 990px and 1280px has the SAME specificity, so it wins
 * only on source order — the stylesheet link has to come AFTER that block.
 *
 * Move the link higher in the file "to group the stylesheets together" and
 * the hamburger silently disappears in that band, leaving a header with no
 * navigation at all on a 1024px tablet. Nothing errors. That is exactly the
 * kind of regression a test should hold.
 */

const THEME = join(process.cwd(), "..", "theme");
const HEADER = readFileSync(join(THEME, "sections", "header.liquid"), "utf8");
const NAV_CSS = readFileSync(join(THEME, "assets", "carat-header-nav.css"), "utf8");

/** CSS with comment blocks removed. */
const CSS_CODE = NAV_CSS.replace(/\/\*[\s\S]*?\*\//g, "");

describe("the navigation stylesheet is loaded where it can win", () => {
  it("is loaded by the header section", () => {
    expect(HEADER).toContain("carat-header-nav.css");
  });

  it("comes after the inline style block that hides the drawer", () => {
    // THE CORE ASSERTION. Equal specificity means source order decides, and
    // the thing being overridden (`header-drawer { display: none }`) lives
    // in the inline <style> above.
    const drawerHidden = HEADER.indexOf("header-drawer {");
    const stylesheet = HEADER.indexOf("carat-header-nav.css");
    expect(drawerHidden).toBeGreaterThan(-1);
    expect(stylesheet).toBeGreaterThan(drawerHidden);
  });
});

describe("the desktop navigation never wraps", () => {
  it("forbids the flex wrap that let it fall onto a second row", () => {
    // `.list-menu--inline { flex-wrap: wrap }` in base.css is what made the
    // original failure silent: the menu did not overflow, it just quietly
    // became two rows. Forbidding the wrap turns any future regression — an
    // eleventh item, a longer label, a wider logo — into something visible.
    expect(CSS_CODE).toMatch(/flex-wrap:\s*nowrap/);
    expect(CSS_CODE).toMatch(/white-space:\s*nowrap/);
  });

  it("trims item spacing rather than shrinking the type", () => {
    // The brief allows "a very small font-size adjustment", but the nav
    // links already compute to 9.375px. Taking anything off that buys a few
    // pixels and costs legibility on the one element every visitor uses.
    expect(CSS_CODE).toMatch(/padding-left:\s*0\.9rem/);
    expect(CSS_CODE).toMatch(/padding-right:\s*0\.9rem/);
    expect(CSS_CODE, "the nav font-size must not be reduced").not.toMatch(/font-size/);
  });

  it("leaves the logo alone", () => {
    // "Preserve the logo size and luxury appearance" — so this stylesheet
    // has no business touching the heading or its logo wrapper.
    expect(CSS_CODE).not.toMatch(/header__heading-logo|\.header__heading\b/);
  });
});

describe("the switch to the hamburger happens before the nav gets tight", () => {
  it("hides the inline menu and shows the drawer between 990px and 1280px", () => {
    // Dawn's desktop rules live in a `min-width: 990px` block, so the band
    // has to undo exactly those: the grid, the visible inline menu, and the
    // hidden drawer.
    const band = CSS_CODE.match(
      /@media screen and \(min-width:\s*990px\) and \(max-width:\s*1279\.98px\)\s*\{[\s\S]*?\n\}/
    );
    expect(band, "the 990-1280px band is missing").toBeTruthy();
    const rules = band![0];
    expect(rules).toMatch(/\.header__inline-menu\s*\{\s*display:\s*none/);
    expect(rules).toMatch(/header-drawer\s*\{\s*display:\s*block/);
    // Without restoring the mobile grid the drawer lands in a column the
    // desktop layout does not reserve for it.
    expect(rules).toMatch(/grid-template-areas:\s*'left-icons heading icons'/);
  });

  it("switches above Dawn's own 990px, not below it", () => {
    // Pinning the direction of the change: the whole point is that 990px is
    // too LATE for a ten-item menu. A future edit that lowers this back
    // toward 990 reintroduces the wrap.
    const max = CSS_CODE.match(/max-width:\s*(\d+)(?:\.\d+)?px/);
    expect(max).toBeTruthy();
    expect(Number(max![1])).toBeGreaterThanOrEqual(1279);
  });
});
