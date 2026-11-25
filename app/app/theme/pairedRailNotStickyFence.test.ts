import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE PAIRED INFORMATION RAIL MUST NOT BE STICKY.
 *
 * `carat-editorial.css` lays the rail beside a form by turning Dawn's
 * `#MainContent` into a two column grid, because Shopify sections are
 * siblings and a 600 line form section cannot be wrapped from the template.
 * The rail also carried `position: sticky; top: 3rem`.
 *
 * A sticky grid item is held by its containing block, and that turned out to
 * be the WHOLE grid, not the paired row. Measured 2026-11-25 on
 * `/pages/custom-jewelry` at 2201px:
 *
 *   pair row ended at document y = 1595
 *   rail travelled to a bottom of y = 2565
 *   #MainContent's own bottom     = 124 + 2441 = 2565
 *
 * So the rail escaped the pair by 970px, exactly the height of the
 * full-width row beneath it, and painted over that row. A hit test
 * (`document.elementFromPoint`) found 21 points where the rail covered the
 * terms section, including "I authorize the $49 Design Deposit" and "I have
 * reviewed and approve the design". Legal and approval text a customer is
 * being asked to accept was sitting underneath another section.
 *
 * WHY A FENCE. Bounding box, `scrollWidth` and element geometry tests all
 * PASS while this is broken: both sections keep their boxes and their widths,
 * and one simply paints on top of the other. The defect is invisible to every
 * measurement the previous layout work relied on, so the only durable guard
 * is to forbid the declaration itself.
 *
 * Reintroducing sticky would require a wrapper bounded to the paired row, and
 * the inability to nest Shopify sections is the reason this grid exists at
 * all. Normal scrolling is the correct behaviour (owner decision 2026-11-25).
 *
 * NOT IN SCOPE: sticky anywhere else in the theme. Dawn's header is legitimately
 * sticky and is unrelated to this grid.
 */

const THEME = join(process.cwd(), "..", "theme");
const CSS = join(THEME, "assets", "carat-editorial.css");

/** The rule that places the rail in the grid, comments stripped. */
function pairedLeadRule(): string {
  const source = readFileSync(CSS, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
  const selector = "#MainContent:has(.carat-pair--lead) > .shopify-section:has(.carat-pair--lead)";
  // The adjacent-sibling rule starts with the same text, so match the one
  // whose selector ends at the brace rather than continuing into " + ".
  const re = new RegExp(
    selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "\\s*\\{([^}]*)\\}",
    "g"
  );
  const match = re.exec(source);
  if (!match?.[1]) throw new Error("paired lead rule not found in carat-editorial.css");
  return match[1];
}

describe("the paired information rail scrolls with the page", () => {
  it("never declares position: sticky", () => {
    expect(
      /position\s*:\s*sticky/i.test(pairedLeadRule()),
      "A sticky rail is bounded by the whole #MainContent grid, not the paired " +
        "row, so it slides over the full-width sections below and covers their " +
        "text (measured: 21 covered points including the $49 Design Deposit " +
        "authorisation). Let the rail scroll normally."
    ).toBe(false);
  });

  it("never declares position: fixed either", () => {
    expect(/position\s*:\s*fixed/i.test(pairedLeadRule())).toBe(false);
  });

  it("still places the rail in column 1, so the pairing survives", () => {
    expect(pairedLeadRule()).toMatch(/grid-column\s*:\s*1\s*;/);
  });

  /**
   * Stops the fence passing because the two column layout was deleted rather
   * than fixed. The grid is the feature; only the sticky was the bug.
   */
  it("keeps the desktop two column grid", () => {
    const source = readFileSync(CSS, "utf8").replace(/\/\*[\s\S]*?\*\//g, " ");
    const grid = /#MainContent:has\(\.carat-pair--lead\)\s*\{([^}]*)\}/.exec(source);
    expect(grid, "the #MainContent paired grid rule is gone").not.toBeNull();
    expect(grid![1]).toMatch(/display\s*:\s*grid/);
    expect(grid![1]).toMatch(/grid-template-columns\s*:\s*36fr\s+64fr/);
    expect(source).toMatch(/min-width:\s*990px/);
  });
});
