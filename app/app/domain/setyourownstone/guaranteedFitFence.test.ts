/**
 * docs/SET-YOUR-OWN-STONE.md §6.3 ends with four words: 'Do not use
 * "Guaranteed fit".'
 *
 * §15.17 then makes it an acceptance criterion. A promise of physical fit
 * derived from arithmetic is the one claim this feature must never make,
 * because the arithmetic cannot see the stone — only a person holding it
 * can. A customer who reads "guaranteed" and posts a diamond on the strength
 * of it has been told something we had no way to know.
 *
 * This fence makes that unsayable rather than merely discouraged. It scans
 * the real source — storefront and application — for the claim in any
 * phrasing a reasonable person would write it in.
 *
 * It also pins the companion requirement: an automatic match must be
 * accompanied by the qualifier that CaratForUs confirms compatibility first
 * (§6.3, §15.16).
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  COMPATIBILITY_LABELS,
  COMPATIBILITY_QUALIFIER,
} from "./matching";

/** Repo root from app/app/domain/setyourownstone. */
const ROOT = join(__dirname, "..", "..", "..", "..");

const SEARCH_ROOTS = [
  join(ROOT, "theme", "sections"),
  join(ROOT, "theme", "snippets"),
  join(ROOT, "theme", "assets"),
  join(ROOT, "theme", "templates"),
  join(ROOT, "theme", "locales"),
  join(ROOT, "app", "app"),
];

const EXTENSIONS = [".liquid", ".js", ".ts", ".tsx", ".json"];

/**
 * The claim, in the shapes someone would actually write. Deliberately not a
 * bare search for "guarantee": the word is legitimate elsewhere in this
 * business — the Beat Your Quote guarantee is a real, locked promise — and a
 * fence that cries wolf gets deleted. What is banned is guaranteeing FIT.
 */
const BANNED = [
  /guaranteed\s+fit/i,
  /guarantee[sd]?\s+(?:a\s+)?(?:perfect\s+)?fit/i,
  /fit\s+is\s+guaranteed/i,
  /guaranteed\s+to\s+fit/i,
  /we\s+guarantee\s+(?:it\s+)?(?:will\s+)?fit/i,
];

function walk(dir: string): string[] {
  let out: string[] = [];
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out; // A directory that does not exist is not a violation.
  }
  for (const entry of entries) {
    if (entry === "node_modules" || entry === ".git") continue;
    const full = join(dir, entry);
    const st = statSync(full);
    if (st.isDirectory()) {
      out = out.concat(walk(full));
    } else if (EXTENSIONS.some((e) => entry.endsWith(e))) {
      out.push(full);
    }
  }
  return out;
}

/** This file necessarily contains the banned strings in order to ban them. */
function isThisFence(path: string): boolean {
  return path.endsWith("guaranteedFitFence.test.ts");
}

/**
 * Strip comments before scanning.
 *
 * Without this the fence fails on the prose that EXPLAINS the ban — the
 * matcher's own header says the labels must never promise a guaranteed fit,
 * and the route comment says `Never "guaranteed fit"`. Both are the rule
 * being documented, not the rule being broken, and a fence that fires on its
 * own justification teaches people to delete fences.
 *
 * The identical mistake was shipped once on `beatQuoteAcknowledgmentParity`,
 * where the banned-construct check matched `parseFloat` inside the comment
 * explaining why `parseFloat` is not used. Fixed there the same way.
 *
 * Deliberately crude: block comments, line comments and Liquid comments. It
 * only has to be good enough that a real customer-facing string survives,
 * and every form of quoted string does.
 */
function stripComments(source: string): string {
  return source
    .replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/.*$/gm, "$1")
    .replace(/^\s*#.*$/gm, " ");
}

describe('the phrase "Guaranteed fit" cannot reach a customer (§6.3, §15.17)', () => {
  const files = SEARCH_ROOTS.flatMap(walk).filter((f) => !isThisFence(f));

  it("scans a non-trivial number of files, so a passing result means something", () => {
    // Guards the fence itself: a path typo that found nothing would
    // otherwise pass silently forever and prove the opposite of what it
    // claims to prove.
    expect(files.length).toBeGreaterThan(100);
  });

  it("finds the claim nowhere in the theme or the application", () => {
    const violations: string[] = [];
    for (const file of files) {
      const text = stripComments(readFileSync(file, "utf8"));
      for (const pattern of BANNED) {
        if (pattern.test(text)) {
          violations.push(`${file.slice(ROOT.length + 1)} matches ${pattern}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("catches the claim when it is introduced, in each phrasing", () => {
    // Proves the patterns work rather than trusting that zero hits means
    // zero risk.
    const wouldViolate = [
      "Guaranteed fit",
      "guaranteed fit for your stone",
      "This setting guarantees a perfect fit",
      "The fit is guaranteed",
      "guaranteed to fit your diamond",
      "we guarantee it will fit",
    ];
    for (const sample of wouldViolate) {
      expect(BANNED.some((p) => p.test(sample))).toBe(true);
    }
  });

  it("still catches the claim in a real string, after comment stripping", () => {
    // The stripper must not become an escape hatch: a banned phrase inside
    // an actual quoted string has to survive it.
    const code = `const label = "Guaranteed fit for your stone";`;
    const stripped = stripComments(code);
    expect(BANNED.some((p) => p.test(stripped))).toBe(true);
  });

  it("removes the prose that explains the ban", () => {
    const explaining = `/* The label must never say guaranteed fit. */\nconst x = 1;`;
    expect(BANNED.some((p) => p.test(stripComments(explaining)))).toBe(false);
  });

  it("does not flag the legitimate Beat Your Quote guarantee", () => {
    // A fence that fires on unrelated correct copy gets switched off.
    const legitimate = [
      "A recent written custom quote carries our guarantee.",
      "without the same guarantee attached",
      "guaranteed lowest price on a qualifying written quote",
    ];
    for (const sample of legitimate) {
      expect(BANNED.some((p) => p.test(sample))).toBe(false);
    }
  });
});

describe("an automatic match always carries the confirmation qualifier (§6.3, §15.16)", () => {
  it("states that CaratForUs confirms before the stone is sent", () => {
    expect(COMPATIBILITY_QUALIFIER).toMatch(/confirm/i);
    expect(COMPATIBILITY_QUALIFIER).toMatch(/before you send/i);
  });

  it("offers no label that asserts a physical fit", () => {
    for (const label of Object.values(COMPATIBILITY_LABELS)) {
      expect(BANNED.some((p) => p.test(label))).toBe(false);
      expect(label.toLowerCase()).not.toContain("guarantee");
    }
  });
});
