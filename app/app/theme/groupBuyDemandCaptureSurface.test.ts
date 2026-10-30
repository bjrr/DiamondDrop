import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  BRING_IT_BACK_AFFIRMATIVE_ACTION_LABEL,
  BRING_IT_BACK_POLICY_SLUG,
  NEW_CAMPAIGN_REQUEST_AFFIRMATIVE_ACTION_LABEL,
  NEW_CAMPAIGN_REQUEST_POLICY_SLUG,
} from "~/domain/groupbuy/demandCaptureCopy";

/**
 * THE SLICE 13 THEME SURFACES — Past Group Buys, Bring It Back, and Request
 * a New Group Buy. `sections/past-group-buys.liquid`,
 * `sections/group-buy-request.liquid`, `assets/past-group-buys.js`,
 * `assets/group-buy-interest.js`, `templates/page.past-group-buys.json`.
 *
 * ============================================================================
 * WHAT THESE TESTS ARE FOR
 * ============================================================================
 * The theme cannot be rendered here, so these are not rendering tests. They
 * pin the things that are statically checkable and that fail SILENTLY or
 * EXPENSIVELY if wrong:
 *
 *   1. THE EVIDENCE CONTRACT. Pressing the button is the affirmative action,
 *      and the server records the exact caption pressed and the exact
 *      disclosure shown. If the theme's caption drifts from the server
 *      constant, every acknowledgment row from then on describes a button
 *      nobody saw. Nothing at runtime would notice.
 *   2. THAT THE DISCLOSURE IS FETCHED AND GATES THE BUTTON. A form that can
 *      be submitted while the terms failed to load manufactures false
 *      consent.
 *   3. THAT NO MONEY ARITHMETIC HAPPENS IN THE THEME. Archive prices arrive
 *      as decimal strings derived from integer minor units; a `parseFloat`
 *      here would reintroduce floats on the one surface nobody rechecks.
 *
 * COMMENTS ARE STRIPPED BEFORE SCANNING. This is the fourth time in this
 * project a fence of mine matched its own documentation — the recurring
 * lesson, recorded in `faqSurface.test.ts` too: a text-scanning fence must
 * first reduce the file to the thing it actually governs. Prose that names
 * the forbidden construct is not the forbidden construct.
 */

const THEME = join(process.cwd(), "..", "theme");
const INTEREST_JS = readFileSync(join(THEME, "assets", "group-buy-interest.js"), "utf8");
const ARCHIVE_JS = readFileSync(join(THEME, "assets", "past-group-buys.js"), "utf8");
const ARCHIVE_SECTION = readFileSync(join(THEME, "sections", "past-group-buys.liquid"), "utf8");
const REQUEST_SECTION = readFileSync(join(THEME, "sections", "group-buy-request.liquid"), "utf8");
const TEMPLATE = readFileSync(join(THEME, "templates", "page.past-group-buys.json"), "utf8");

/** Removes `/* … *\/` and `// …` so a fence cannot match an explanation. */
function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

/** Removes `{% comment %} … {% endcomment %}`. */
function stripLiquidComments(source: string): string {
  return source.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, " ");
}

const INTEREST_CODE = stripJsComments(INTEREST_JS);
const ARCHIVE_CODE = stripJsComments(ARCHIVE_JS);

/** The source of `loadDisclosure`, the only function permitted to open the gate. */
function loadDisclosureBody(): string {
  const start = INTEREST_CODE.indexOf("function loadDisclosure");
  expect(start, "loadDisclosure not found").toBeGreaterThan(-1);
  const end = INTEREST_CODE.indexOf("function showProblems", start);
  expect(end, "could not bound loadDisclosure").toBeGreaterThan(start);
  return INTEREST_CODE.slice(start, end);
}

describe("the comment strippers actually strip", () => {
  it("removes JS documentation", () => {
    // Guard the guard: if these returned the input unchanged, every
    // assertion below would be scanning prose. The phrase is chosen to sit
    // on ONE line of the header — the first version of this guard spanned a
    // wrap and never matched, so it was asserting nothing.
    expect(INTEREST_JS).toMatch(/FORM DATA, NOT JSON/);
    expect(INTEREST_CODE).not.toMatch(/FORM DATA, NOT JSON/);
  });

  it("removes Liquid documentation", () => {
    expect(ARCHIVE_SECTION).toMatch(/retype a code/);
    expect(stripLiquidComments(ARCHIVE_SECTION)).not.toMatch(/retype a code/);
  });
});

describe("the evidence contract with the server", () => {
  it("uses the server's exact affirmative-action caption for each kind", () => {
    // The caption is recorded against the captured address. These two
    // strings must be identical to `demandCaptureCopy.ts` or the evidence
    // row describes a button that was never on screen.
    expect(INTEREST_CODE).toContain(`"${BRING_IT_BACK_AFFIRMATIVE_ACTION_LABEL}"`);
    expect(INTEREST_CODE).toContain(`"${NEW_CAMPAIGN_REQUEST_AFFIRMATIVE_ACTION_LABEL}"`);
  });

  it("requests the disclosure under the server's exact policy slug for each kind", () => {
    // A wrong slug returns no term, which disables the button — visible.
    // A slug belonging to the OTHER kind returns a real term and shows the
    // wrong disclosure, which is not.
    expect(INTEREST_CODE).toContain(`"${BRING_IT_BACK_POLICY_SLUG}"`);
    expect(INTEREST_CODE).toContain(`"${NEW_CAMPAIGN_REQUEST_POLICY_SLUG}"`);
  });

  it("pairs each slug with its own caption, not the other kind's", () => {
    const bringItBack = INTEREST_CODE.slice(
      INTEREST_CODE.indexOf("bring_it_back:"),
      INTEREST_CODE.indexOf("new_campaign_request:")
    );
    expect(bringItBack).toContain(BRING_IT_BACK_POLICY_SLUG);
    expect(bringItBack).toContain(BRING_IT_BACK_AFFIRMATIVE_ACTION_LABEL);
    expect(bringItBack).not.toContain(NEW_CAMPAIGN_REQUEST_POLICY_SLUG);
    expect(bringItBack).not.toContain(NEW_CAMPAIGN_REQUEST_AFFIRMATIVE_ACTION_LABEL);
  });

  it("fetches the disclosure rather than carrying a copy of it", () => {
    expect(INTEREST_CODE).toMatch(/\/apps\/carat\/policies/);
    // No settings field and no constant holding disclosure prose. The
    // give-away would be a long sentence about email or notification.
    expect(stripLiquidComments(REQUEST_SECTION)).not.toMatch(/"type":\s*"richtext",\s*"id":\s*"disclosure"/);
  });

  it("creates the submit button disabled", () => {
    expect(INTEREST_CODE).toMatch(/submit\.disabled\s*=\s*true/);
  });

  it("opens the gate in exactly one place, after the term is on the page", () => {
    /**
     * SCOPED TO `loadDisclosure`, which is the only function allowed to open
     * the gate. The first version of this assertion counted every
     * `submit.disabled = false` in the file and failed on three legitimate
     * ones — `submitForm` re-enables the button after a rejected submission
     * so the customer can correct and retry. Those are unreachable while the
     * gate is shut (the handler returns early on a disabled button, and the
     * next test pins that), so counting them was measuring the wrong thing.
     */
    const body = loadDisclosureBody();
    const enables = body.match(/submit\.disabled\s*=\s*false/g) ?? [];
    expect(enables, "loadDisclosure must open the gate exactly once").toHaveLength(1);

    const enableAt = body.indexOf("submit.disabled = false");
    const appendAt = body.indexOf("carat-gb-interest__disclosure-text");
    expect(appendAt, "loadDisclosure never appends the term").toBeGreaterThan(-1);
    expect(enableAt, "the button is enabled before the term is on the page").toBeGreaterThan(appendAt);
  });

  it("opens the gate nowhere else", () => {
    // Every other re-enable must live inside `submitForm`, which cannot run
    // until the gate has already been opened once.
    const outsideLoad = INTEREST_CODE.replace(loadDisclosureBody(), " ");
    const strayEnables = outsideLoad.match(/submit\.disabled\s*=\s*false/g) ?? [];
    const submitBody = outsideLoad.slice(outsideLoad.indexOf("function submitForm"));
    const inSubmit = submitBody.match(/submit\.disabled\s*=\s*false/g) ?? [];
    expect(
      inSubmit.length,
      "a place outside loadDisclosure and submitForm enables the button"
    ).toBe(strayEnables.length);
  });

  it("leaves the button disabled when the disclosure fails to load", () => {
    const catchBlock = INTEREST_CODE.slice(INTEREST_CODE.indexOf("disclosure-error"));
    expect(catchBlock).toMatch(/submit\.disabled\s*=\s*true/);
  });

  it("refuses to submit while the button is disabled, even if something re-enables it", () => {
    // Belt and braces: the submit handler itself checks.
    expect(INTEREST_CODE).toMatch(/if\s*\(parts\.submit\.disabled\)\s*return/);
  });
});

describe("the submission matches what the endpoint parses", () => {
  it("posts FormData, not JSON", () => {
    // The route calls `request.formData()`. JSON produces a 400 listing
    // every field as missing, which reads as a validation bug.
    expect(INTEREST_CODE).toMatch(/new FormData\(\)/);
    expect(INTEREST_CODE).not.toMatch(/JSON\.stringify/);
  });

  it("sends campaignRef for bring-it-back only", () => {
    // A new-campaign request naming an existing campaign is rejected
    // (`campaign_not_allowed`) — correctly, since it is demand for something
    // that is not new.
    const send = INTEREST_CODE.slice(INTEREST_CODE.indexOf("new FormData()"));
    expect(send).toMatch(/kind\s*===\s*"bring_it_back"[\s\S]{0,160}campaignRef/);
  });

  it("handles every problem code the parser can return", () => {
    const parser = readFileSync(
      join(process.cwd(), "app", "domain", "groupbuy", "demandSignal.ts"),
      "utf8"
    );
    const declared = parser
      .slice(parser.indexOf("export type DemandSignalProblem"), parser.indexOf("export type DemandSignalParseResult"))
      .match(/"([a-z_]+)"/g);
    expect(declared, "could not read the problem union").toBeTruthy();

    for (const quoted of declared!) {
      const code = quoted.replaceAll('"', "");
      expect(INTEREST_CODE, `no message for the problem "${code}"`).toContain(`${code}:`);
    }
  });

  it("does not try to distinguish 'recorded' from 'already on file'", () => {
    // The endpoint deliberately returns the same body for both so it cannot
    // be used to ask whether an address is watching a campaign. The theme
    // must not infer the difference back.
    expect(INTEREST_CODE).not.toMatch(/already (registered|on file|subscribed)/i);
  });
});

describe("the archive does no money arithmetic", () => {
  it("never parses or rounds a price", () => {
    for (const banned of [/parseFloat\s*\(/, /parseInt\s*\(/, /Number\s*\(/, /\.toFixed\s*\(/, /Math\.round\s*\(/]) {
      expect(ARCHIVE_CODE, `archive JS uses ${banned}`).not.toMatch(banned);
    }
  });

  it("prints the server's Regular/Card note rather than restating it", () => {
    // CLAUDE.md rule 13. A local copy is a copy that can drift from the
    // policy it restates.
    expect(ARCHIVE_CODE).toMatch(/payload\.regularCardPriceNote/);
    expect(ARCHIVE_CODE).not.toMatch(/Bank Payment/);
    expect(stripLiquidComments(ARCHIVE_SECTION)).not.toMatch(/Bank Payment/);
  });

  it("never names the internal percentage or forbidden fee wording", () => {
    // CLAUDE.md rule 13: never "card fee", "surcharge" or "cash discount".
    for (const src of [ARCHIVE_CODE, stripLiquidComments(ARCHIVE_SECTION)]) {
      expect(src).not.toMatch(/surcharge|card fee|cash discount/i);
    }
  });

  it("says 'From' when the figures are the lowest variant's", () => {
    // Without this, one variant's price reads as what everybody paid.
    expect(ARCHIVE_CODE).toMatch(/priceIsFromLowestVariant/);
    expect(ARCHIVE_CODE).toMatch(/"From "/);
  });

  it("shows a saving only when the server says the price fell", () => {
    expect(ARCHIVE_CODE).toMatch(/if\s*\(campaign\.priceFellBy\)/);
  });
});

describe("markup safety", () => {
  it("neither script ever assigns innerHTML", () => {
    for (const [name, code] of [
      ["group-buy-interest.js", INTEREST_CODE],
      ["past-group-buys.js", ARCHIVE_CODE],
    ] as const) {
      expect(code, `${name} assigns innerHTML`).not.toMatch(/innerHTML/);
    }
  });

  it("routes server values through textContent", () => {
    for (const code of [INTEREST_CODE, ARCHIVE_CODE]) {
      expect(code).toMatch(/textContent/);
    }
  });
});

describe("the sections and the page template", () => {
  it("the archive section mounts the archive and loads both scripts", () => {
    const code = stripLiquidComments(ARCHIVE_SECTION);
    expect(code).toMatch(/data-carat-past-group-buys/);
    expect(code).toMatch(/past-group-buys\.js/);
    // The archive renders per-campaign interest hosts, so the interest
    // script must be present on the same page.
    expect(code).toMatch(/group-buy-interest\.js/);
  });

  it("the request section mounts the new-campaign kind", () => {
    const code = stripLiquidComments(REQUEST_SECTION);
    expect(code).toMatch(/data-carat-group-buy-interest="new_campaign_request"/);
    expect(code).toMatch(/group-buy-interest\.js/);
  });

  it("the archive wires bring-it-back through the campaign's own code", () => {
    // Not a typed-in code: the host carries the campaign it was rendered
    // from, so demand cannot be recorded against the wrong campaign.
    expect(ARCHIVE_CODE).toMatch(/data-campaign-ref["'],\s*campaign\.code/);
    expect(ARCHIVE_CODE).toMatch(/data-carat-group-buy-interest["'],\s*["']bring_it_back["']/);
  });

  it("neither section offers a setting that could add design questions", () => {
    // README: demand capture must not become a custom-design questionnaire.
    for (const src of [ARCHIVE_SECTION, REQUEST_SECTION]) {
      const schema = src.slice(src.indexOf("{% schema %}"));
      expect(schema).not.toMatch(/"id":\s*"(budget|metal|stone|carat|size|timeline)"/);
    }
  });

  it("the template is valid JSON and orders header, archive, then request", () => {
    const parsed = JSON.parse(TEMPLATE) as {
      sections: Record<string, { type: string }>;
      order: string[];
    };
    const types = Object.values(parsed.sections).map((s) => s.type);

    // `carat-pagehead` replaced Dawn's `main-page` across the subpages. The
    // ordering this test protects is unchanged and still the point: header,
    // then the closed campaigns, then the request form underneath them.
    expect(types).toContain("carat-pagehead");
    expect(types).toContain("past-group-buys");
    expect(types).toContain("group-buy-request");
    expect(types, "main-page would reintroduce a second heading").not.toContain("main-page");

    const keyOf = (type: string) =>
      Object.keys(parsed.sections).find((k) => parsed.sections[k]!.type === type)!;
    expect(parsed.order.indexOf(keyOf("carat-pagehead"))).toBeLessThan(
      parsed.order.indexOf(keyOf("past-group-buys"))
    );
    expect(parsed.order.indexOf(keyOf("past-group-buys"))).toBeLessThan(
      parsed.order.indexOf(keyOf("group-buy-request"))
    );
  });

  it("every section setting referenced in the template exists in its schema", () => {
    // A template setting with no schema entry is silently ignored, so the
    // page quietly renders defaults instead of what the template asked for.
    const parsed = JSON.parse(TEMPLATE) as {
      sections: Record<string, { type: string; settings?: Record<string, unknown> }>;
    };
    const schemas: Record<string, string> = {
      "past-group-buys": ARCHIVE_SECTION,
      "group-buy-request": REQUEST_SECTION,
    };

    for (const section of Object.values(parsed.sections)) {
      const source = schemas[section.type];
      if (!source) continue;
      const schema = source.slice(source.indexOf("{% schema %}"));
      for (const key of Object.keys(section.settings ?? {})) {
        expect(schema, `${section.type} has no setting "${key}"`).toContain(`"id": "${key}"`);
      }
    }
  });
});

describe("accessibility", () => {
  it("labels every input", () => {
    // Two labels for bring-it-back's single field and the request's two.
    expect(INTEREST_CODE).toMatch(/setAttribute\("for", emailId\)/);
    expect(INTEREST_CODE).toMatch(/setAttribute\("for", noteId\)/);
  });

  it("gives each field a unique id, since several forms share one page", () => {
    // Every archive entry mounts its own form. Duplicate ids would point
    // every label at the first form's input.
    expect(INTEREST_CODE).toMatch(/data-field-seq/);
  });

  it("announces status changes to assistive technology", () => {
    expect(INTEREST_CODE).toMatch(/aria-live/);
    expect(INTEREST_CODE).toMatch(/role["'],\s*["']status/);
  });

  it("both sections degrade visibly without JavaScript", () => {
    for (const src of [ARCHIVE_SECTION, REQUEST_SECTION]) {
      expect(src).toMatch(/<noscript>/);
    }
  });

  it("the disabled submit is styled, not left to the browser default", () => {
    const css = readFileSync(join(THEME, "assets", "component-group-buy-interest.css"), "utf8");
    expect(css).toMatch(/__submit:disabled/);
    expect(css).toMatch(/:focus-visible/);
  });
});
