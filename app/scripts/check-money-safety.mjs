#!/usr/bin/env node
// Repository-wide check for float-arithmetic and ad-hoc-rounding hazards on
// money (Slice 0 spec acceptance criterion 6; hardened per Slice 0 finding
// F-1, docs/specs/SLICE-0-FINDINGS.md, and docs/specs/SLICE-1-PRICING.md §8.1).
//
// DIVISION OF LABOUR — read this before trusting (or extending) this file.
//
// Criterion 6's first clause, "no float arithmetic on monetary values", is
// satisfied by app/domain/money/money.ts's TYPE BOUNDARY, not by this scan:
// `Money.amountMinorUnits` is a `bigint`, TypeScript raises a compile error
// on any arithmetic operator mixing `bigint` and `number`, and the only
// sanctioned entry points from decimal.js (`MoneyDecimal`) into `Money`
// require an explicit, named rounding rule. That is a static guarantee a
// lexical/text scan cannot provide — no regex can prove an absence of float
// arithmetic, because "is this expression a float" is a type-system
// question, not a text pattern.
//
// What THIS SCAN catches is narrower and purely lexical: literal source
// patterns that are either (a) an alternate, un-centralized way to round a
// number, bypassing app/domain/money/rounding.ts, or (b) a way to smuggle a
// value out of the bigint/decimal.js world into a JS `number`/float, where
// the type boundary above no longer protects it (e.g. a `Prisma.Decimal`
// pulled out via `.toNumber()`, or a bigint widened via `Number(...)`).
//
// What NEITHER catches:
//   - Plain float arithmetic that never calls a flagged function at all,
//     e.g. `price * 1.08` or `total / 3` written directly against a JS
//     `number` that was never a `Money`/`MoneyDecimal` to begin with. If a
//     value is a `number` from the start, nothing here notices it being
//     used arithmetically. The `Money`/`MoneyDecimal` type boundary is the
//     actual defense; this scan only watches the boundary's known holes.
//   - Patterns hidden behind string concatenation, `eval`, dynamically
//     built property names other than the literal `Math[` form below, or
//     any transformation that doesn't appear as one of the fixed substrings
//     matched here.
//   - Matches inside comments or string literals are NOT excluded — this
//     scan does no tokenization. A comment that mentions `.toFixed(` will
//     be flagged like real code. Prefer rewording the comment over adding
//     an allow-list entry for a comment.
//
// TWO TIERS.
//
// Tier 1 (repository-wide) flags ad-hoc rounding/truncation regardless of
// location: Math.round/floor/ceil/trunc (including computed member access
// and aliasing), `.toFixed(`, `parseFloat(`, and the bitwise-truncation
// idioms `~~`, `>> 0`, `| 0`.
//
// Tier 2 (money-adjacent paths only — see isMoneyAdjacentPath below)
// additionally flags `.toNumber(` and `Number(`, because those are exactly
// how a `Prisma.Decimal` or a `bigint` becomes a lossy JS `number`, and
// that hazard is only realistic where money/pricing values actually flow.
// Banning `Number(` repository-wide would flag ordinary non-money code
// (parsing a page-size query param, etc.) for no safety benefit.
//
// ALLOW-LIST. A small, structured, printed exceptions list for lines that
// intentionally use an otherwise-forbidden pattern for a non-hazardous
// reason (e.g. decimal.js's own exact `Decimal.prototype.toFixed`, which is
// unrelated to the lossy `Number.prototype.toFixed`). Adding an entry is an
// architect-reviewed change — see ALLOW_LIST below.
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appRoot = path.resolve(__dirname, "..");

const SCAN_DIRS = ["app", "tests", "prisma"];
const IGNORE_DIRS = new Set(["node_modules", "build", ".cache", "migrations"]);

/**
 * Structured allow-list. Each entry silences exactly one (path, pattern)
 * pair, is REQUIRED to carry a reason, and is printed by every run (whether
 * or not it actually fired) so an allowance is visible, never invisible.
 *
 * Adding an entry here is an architect-reviewed change (docs/specs/
 * SLICE-1-PRICING.md §8.1) — do not add one to silence a scan hit you
 * merely find inconvenient.
 *
 * @type {{ path: string, pattern: string, reason: string }[]}
 */
const ALLOW_LIST = [
  {
    path: "app/domain/money/rounding.ts",
    pattern: ".toFixed(",
    reason: "decimal.js's own exact toFixed, not Number.prototype.toFixed",
  },
  {
    // Basis points, not money: an integer bounded by the tolerance comparison
    // and stored in an INTEGER column, converted once at the persistence edge.
    // The tolerance decision itself is made on the exact MoneyDecimal BEFORE
    // this conversion, so no pricing comparison depends on the JS number.
    // Reviewed by the QA & security reviewer during Slice 1 T10 and found
    // substantively justified: this is the "plain integer" category §4.1
    // permits as a JSON number.
    path: "app/jobs/pricing/decideSync.ts",
    pattern: "Number(",
    reason: "basis-point integer for an INTEGER column; the tolerance decision is made on the exact decimal first",
  },
];

/**
 * Tier 1: repository-wide hazards. Each pattern is matched literally against
 * file text (no comment/string exclusion — see header). `| 0` and `>> 0`
 * are the bitwise-truncation-to-integer idiom; `~~` is its unary-operator
 * form.
 *
 * The `| 0` pattern deliberately excludes a numeric literal immediately to
 * its left (`(?<!\d\s*)`) and a following `|` (`(?!\s*\|)`), because
 * `-1 | 0 | 1` is a common TypeScript numeric-literal-union TYPE (e.g. a
 * `compareTo`-style return type), not a runtime bitwise-OR-with-zero
 * truncation — and the scan must not force a type signature to be reworded
 * around a lexical false positive. This does not fully solve the general
 * problem (a union of a named type with literal `0`, e.g. `SomeEnum | 0`,
 * would still false-positive) — it resolves the concrete collision that
 * exists in this codebase today. A real accidental false-positive should be
 * fixed here, in the pattern, not worked around with the allow-list.
 */
const TIER1_PATTERNS = [
  { pattern: /Math\.round\s*\(/g, describe: () => "Math.round(" },
  { pattern: /Math\.floor\s*\(/g, describe: () => "Math.floor(" },
  { pattern: /Math\.ceil\s*\(/g, describe: () => "Math.ceil(" },
  { pattern: /Math\.trunc\s*\(/g, describe: () => "Math.trunc(" },
  { pattern: /Math\[/g, describe: () => "Math[ (computed member access on Math)" },
  {
    pattern: /=\s*Math\.(round|floor|ceil|trunc)\b(?!\s*\()/g,
    describe: (m) => `= Math.${m[1]} (aliased reference, not called)`,
  },
  { pattern: /\.toFixed\s*\(/g, describe: () => ".toFixed(" },
  { pattern: /parseFloat\s*\(/g, describe: () => "parseFloat(" },
  { pattern: /~~/g, describe: () => "~~ (double bitwise-NOT truncation)" },
  { pattern: />>\s*0\b/g, describe: () => ">> 0 (bitwise-shift truncation)" },
  {
    pattern: /(?<!\d\s*)\|\s*0\b(?!\s*\|)/g,
    describe: () => "| 0 (bitwise-OR truncation)",
  },
];

/**
 * Tier 2: additional hazards banned only in money-adjacent paths (see
 * isMoneyAdjacentPath). These are exactly the two ways a Prisma.Decimal or
 * a bigint becomes a lossy JS number (spec §4.1, R6/R19).
 */
const TIER2_PATTERNS = [
  { pattern: /\.toNumber\s*\(/g, describe: () => ".toNumber(" },
  { pattern: /\bNumber\s*\(/g, describe: () => "Number(" },
];

/**
 * Directory prefixes (relative to this package's root, forward-slash
 * normalized) that are money-adjacent regardless of filename. Written as
 * prefix checks rather than a directory listing so paths that don't exist
 * yet (app/domain/pricing, app/jobs/pricing — both land later in Slice 1)
 * are covered correctly the moment they appear, with no edit needed here.
 *
 * The groupbuy prefixes were added at the close of Slice 1 (T11 condition C2).
 * They are NOT reachable through TIER2_FILENAME_PATTERN below: tiers.ts,
 * tierSafety.ts, refunds.ts, campaignProgress.ts and refundLedger.server.ts
 * all move real money and none of their filenames match that pattern. No
 * violation existed when the prefixes were added — the point is to close the
 * hole before Slice 6 pours more code into it.
 */
const TIER2_DIR_PREFIXES = [
  "app/domain/money/",
  "app/domain/pricing/",
  "app/jobs/pricing/",
  "app/domain/groupbuy/",
  "app/jobs/groupbuy/",
];

/** Any file anywhere in the repo whose FILENAME (not path) matches this is money-adjacent too. */
const TIER2_FILENAME_PATTERN = /price|cost|metal|stone/i;

function isMoneyAdjacentPath(relPathForwardSlash) {
  if (TIER2_DIR_PREFIXES.some((prefix) => relPathForwardSlash.startsWith(prefix))) return true;
  return TIER2_FILENAME_PATTERN.test(path.basename(relPathForwardSlash));
}

/** @type {string[]} */
const violations = [];
/** @type {Set<string>} keys of `${path}::${pattern}` that actually fired, for allow-list reporting */
const allowListHits = new Set();

function scanFile(fullPath, relPath) {
  const relPathForwardSlash = relPath.split(path.sep).join("/");
  const contents = readFileSync(fullPath, "utf8");
  const tier2 = isMoneyAdjacentPath(relPathForwardSlash);
  const patterns = tier2 ? [...TIER1_PATTERNS, ...TIER2_PATTERNS] : TIER1_PATTERNS;

  for (const { pattern, describe } of patterns) {
    pattern.lastIndex = 0;
    const matches = [...contents.matchAll(pattern)];
    if (matches.length === 0) continue;

    const label = describe(matches[0]);
    // Match allow-list entries by literal pattern-string prefix of the human
    // label, e.g. entry.pattern ".toFixed(" matches label ".toFixed(".
    const allowed = ALLOW_LIST.find(
      (entry) => entry.path === relPathForwardSlash && label.startsWith(entry.pattern)
    );

    if (allowed) {
      allowListHits.add(`${allowed.path}::${allowed.pattern}`);
      continue;
    }

    violations.push(`${relPathForwardSlash}: ${matches.length} forbidden ${label} call/usage(s)`);
  }
}

function walk(dir) {
  for (const entry of readdirSync(dir)) {
    if (IGNORE_DIRS.has(entry)) continue;
    const fullPath = path.join(dir, entry);
    const stats = statSync(fullPath);
    if (stats.isDirectory()) {
      walk(fullPath);
      continue;
    }
    if (!/\.(ts|tsx|mjs|js)$/.test(entry)) continue;
    // NOTE: *.test.ts / *.test.tsx are INTENTIONALLY scanned (Slice 1 §8.1,
    // F-1). A test that rounds with .toFixed() or Number() is a test that
    // can validate a broken implementation, and previously slipped through.

    const relPath = path.relative(appRoot, fullPath);
    scanFile(fullPath, relPath);
  }
}

for (const dir of SCAN_DIRS) {
  const fullDir = path.join(appRoot, dir);
  try {
    if (statSync(fullDir).isDirectory()) walk(fullDir);
  } catch {
    // directory doesn't exist yet — nothing to scan
  }
}

if (allowListHits.size > 0 || ALLOW_LIST.length > 0) {
  console.log("Money safety allow-list:");
  for (const entry of ALLOW_LIST) {
    const key = `${entry.path}::${entry.pattern}`;
    const fired = allowListHits.has(key) ? "ALLOWED (matched this run)" : "present, did not match this run";
    console.log(`  - ${entry.path} :: ${entry.pattern} — ${fired}`);
    console.log(`      reason: ${entry.reason}`);
  }
}

if (violations.length > 0) {
  console.error(
    "\nMoney safety check failed — float-arithmetic / ad-hoc-rounding hazard(s) found:"
  );
  for (const violation of violations) console.error(`  - ${violation}`);
  console.error(
    "\nRoute all rounding through app/domain/money/rounding.ts, and cross the " +
      "Prisma.Decimal / bigint boundary only via `new MoneyDecimal(d.toString())` " +
      "or Money.fromMinorUnits — never .toNumber() / Number() / parseFloat() on a " +
      "money-shaped value. See the header comment in this file for what is and " +
      "isn't covered."
  );
  process.exit(1);
}

console.log("\nMoney safety check passed: no float-arithmetic / ad-hoc-rounding hazards found.");
