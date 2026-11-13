import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE HEADER NAVIGATION — ten items fitted, not hidden.
 *
 * ===========================================================================
 * THE REGRESSION THIS FILE NOW EXISTS FOR
 * ===========================================================================
 * The first attempt at fitting ten items moved Dawn's inline-nav/hamburger
 * switch from 990px up to 1280px. It passed every measurement — and it was
 * wrong, because it deleted the desktop navigation on ordinary laptops. A
 * 1366px screen at Windows' default 125% display scaling reports a CSS
 * viewport of ~1092px; a 1440px screen at 125% reports ~1152px. Both landed
 * under 1280 and got the hamburger. The owner saw a mobile header on a
 * desktop machine.
 *
 * So the tests here are deliberately TWO-SIDED. The old file only checked
 * that the breakpoint was high enough to avoid wrapping; this one also
 * checks it is low enough to keep the navigation on real laptops. A
 * breakpoint can fail in both directions and only one of them is visible in
 * a screenshot of a wide monitor.
 *
 * ===========================================================================
 * THE CASCADE BUG, WHICH MEASURING CAUGHT AND REASONING DID NOT
 * ===========================================================================
 * base.css sets the header's horizontal padding with
 *
 *     .header:not(.drawer-menu).page-width { padding-inline: 5rem }
 *
 * — three class-weight components. The override was first written as
 * `.header.header--middle-left`, which is two, so it silently lost and the
 * padding stayed at 50px a side. That is 60px of a budget where the whole
 * fix was worth ~200px. Nothing errored; the only symptom was the header
 * still not fitting. Pinned below.
 */

const THEME = join(process.cwd(), "..", "theme");
const HEADER = readFileSync(join(THEME, "sections", "header.liquid"), "utf8");
const NAV_CSS = readFileSync(join(THEME, "assets", "carat-header-nav.css"), "utf8");

/** CSS with comment blocks removed, so prose cannot satisfy an assertion. */
const CSS = NAV_CSS.replace(/\/\*[\s\S]*?\*\//g, "");

/** Crude class-weight count — enough to compare two selectors' specificity. */
function classWeight(selector: string): number {
  return (selector.match(/\.[A-Za-z][\w-]*/g) ?? []).length;
}

describe("the stylesheet is loaded where it can win", () => {
  it("is loaded by the header section", () => {
    expect(HEADER).toContain("carat-header-nav.css");
  });

  it("comes after the inline style block that hides the drawer", () => {
    // Equal specificity means source order decides, and the rule being
    // overridden (`header-drawer { display: none }`) lives in the inline
    // <style> above. Move this link up and a 1000px tablet loses its
    // navigation entirely, with nothing in the console.
    const drawerHidden = HEADER.indexOf("header-drawer {");
    const stylesheet = HEADER.indexOf("carat-header-nav.css");
    expect(drawerHidden).toBeGreaterThan(-1);
    expect(stylesheet).toBeGreaterThan(drawerHidden);
  });
});

describe("the header padding override actually outranks Dawn", () => {
  /**
   * The selector list of whichever rule sets the header's horizontal
   * padding. Found by the DECLARATION rather than by the selector, so the
   * test cannot be satisfied by a rule that happens to look right.
   */
  function paddingRuleSelectors(): string[] {
    // Both sides brace-free. `[^}]*` for the declarations would let the
    // match run straight through the nested rule's opening brace and capture
    // the `@media` line as if it were a selector list — which it did, and
    // the whole assertion quietly became meaningless.
    const rule = CSS.match(/([^{}]+)\{[^{}]*padding-left:\s*clamp\(2rem/);
    // A throw rather than an expect: this narrows the type for the callers,
    // and a missing rule is a setup failure rather than a behavioural one.
    if (!rule?.[1]) throw new Error("no rule sets the header's horizontal padding with a clamp");
    return rule[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }

  it("scopes EVERY selector in the padding rule through .page-width", () => {
    // THE BUG THIS PINS, and the first version of this assertion did not.
    // It matched the rule if ANY selector in the comma list carried
    // `.page-width`, so a mutation that dropped it from only the first
    // selector passed — which is precisely the shape the real bug had.
    // Every selector has to outrank Dawn, not just one of them.
    const selectors = paddingRuleSelectors();
    expect(selectors.length).toBeGreaterThan(0);
    for (const selector of selectors) {
      expect(selector, `${selector} is outranked by base.css`).toContain(".page-width");
    }
  });

  it("gives every selector at least as much class weight as the rule it overrides", () => {
    // base.css: `.header:not(.drawer-menu).page-width` = 3 class components.
    for (const selector of paddingRuleSelectors()) {
      expect(classWeight(selector), `${selector} has too little specificity`).toBeGreaterThanOrEqual(3);
    }
  });

  it("does not resort to !important", () => {
    // Winning on specificity keeps this file overridable in turn; an
    // !important here would make the next person's fix impossible.
    expect(CSS).not.toContain("!important");
  });
});

describe("the desktop navigation never wraps or clips", () => {
  it("forbids the flex wrap that made the original failure silent", () => {
    // `.list-menu--inline { flex-wrap: wrap }` meant the menu never
    // overflowed — it just quietly became two rows.
    expect(CSS).toMatch(/flex-wrap:\s*nowrap/);
    expect(CSS).toMatch(/white-space:\s*nowrap/);
  });

  it("sizes the icons with width, not a min-width floor", () => {
    // base.css sets `.header__icon { width: 4.4rem }`, so a min-width floor
    // of 40px changes nothing — a floor cannot shrink an element that is
    // already wider. The first attempt used min-width and the icons never
    // moved.
    const iconRule = CSS.match(/\.header__icons[^{]*\{([^}]*)\}/);
    expect(iconRule, "icon sizing rule is missing").toBeTruthy();
    expect(iconRule![1]).toMatch(/\bwidth:\s*clamp/);
    expect(iconRule![1]).not.toMatch(/min-width/);
  });

  it("scales spacing fluidly rather than in steps", () => {
    // clamp() on padding, gap, item padding, logo and icons, so a wide
    // screen keeps the approved spacing and only narrow ones compress.
    const clamps = CSS.match(/clamp\(/g) ?? [];
    expect(clamps.length).toBeGreaterThanOrEqual(6);
  });

  it("never reduces the nav font size", () => {
    // The brief: do not materially reduce legibility to save space. The nav
    // links already compute to 9.375px, so there is nothing to give.
    expect(CSS).not.toMatch(/font-size/);
  });

  it("keeps a floor under the logo", () => {
    // "Do not make the logo disproportionately large" cuts both ways: it
    // must not shrink away either. The clamp floor is what stops a narrow
    // viewport from scaling it into a thumbnail.
    const logo = CSS.match(/header__heading-logo-wrapper\s*\{[^}]*width:\s*clamp\((\d+)px/);
    expect(logo, "logo width clamp is missing").toBeTruthy();
    expect(Number(logo![1])).toBeGreaterThanOrEqual(130);
  });
});

describe("the hamburger appears only when the header genuinely cannot fit", () => {
  const band = CSS.match(
    /@media screen and \(min-width:\s*990px\) and \(max-width:\s*(\d+)(?:\.\d+)?px\)\s*\{([\s\S]*?)\n\}/
  );

  it("has a band that restores the mobile header", () => {
    expect(band, "the 990px-to-breakpoint band is missing").toBeTruthy();
    expect(band![2]).toMatch(/\.header__inline-menu\s*\{\s*display:\s*none/);
    expect(band![2]).toMatch(/header-drawer\s*\{\s*display:\s*block/);
    // Without the mobile grid the drawer lands in a column the desktop
    // layout does not reserve for it, and the nav falls to a second row.
    expect(band![2]).toMatch(/grid-template-areas:\s*'left-icons heading icons'/);
  });

  it("does not steal the navigation from laptops", () => {
    // THE TWO-SIDED ASSERTION. 1280 was too high: a 1366px laptop at 125%
    // scaling reports ~1092px CSS, and a 1440px at 125% reports ~1152px.
    // Anything above ~1025 starts eating real desktop users.
    expect(Number(band![1])).toBeLessThanOrEqual(1025);
  });

  it("still leaves tablets on the drawer", () => {
    // iPad landscape is exactly 1024px and is a tablet, so the desktop nav
    // must start above it rather than at it.
    expect(Number(band![1])).toBeGreaterThanOrEqual(1024);
    expect(CSS).toMatch(/@media screen and \(min-width:\s*1025px\)/);
  });
});
