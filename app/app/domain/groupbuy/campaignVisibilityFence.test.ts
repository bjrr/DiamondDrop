import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE FENCE `campaignVisibility.ts` HAS BEEN PROMISING.
 *
 * Its header says: "`campaignVisibilityFence.test.ts` requires any new
 * campaign-listing query to use one of these rather than an inline
 * condition." That file did not exist until the public Past Group Buys
 * archive was built — which is exactly the surface it was written to protect,
 * and exactly when a second inline copy of the fixture predicate would have
 * been easiest to write.
 *
 * ============================================================================
 * WHAT IT ENFORCES, AND WHY A FENCE RATHER THAN A CODE REVIEW
 * ============================================================================
 * Two predicates must have ONE definition each (archive-lifecycle design,
 * acceptance criterion 7):
 *
 *   - the fixture-code exclusion, so a live-gate campaign can never reach a
 *     customer or a business total;
 *   - the archived exclusion, so staff tidying a dashboard cannot erase
 *     public history — and so the two are never confused for each other.
 *
 * The failure mode is silent in both directions. An inline
 * `code: { not: { startsWith: "zz-live-gate-" } }` works perfectly until the
 * prefix changes, and then a test campaign appears on a storefront with
 * nothing failing. An inline `archivedAt: null` on the PUBLIC archive looks
 * tidy and quietly deletes real campaigns from customer-visible history the
 * moment staff archive them.
 *
 * Neither shows up as a broken test, which is why this is a grep and not a
 * convention.
 */

/**
 * `tests/` AND `scripts/` ARE SCANNED TOO, not just `app/`.
 *
 * That is where the first real offence was: `groupBuyTestCampaignSetup.ts`
 * CREATED a live-gate campaign with the prefix typed inline. A divergence
 * there would have minted a campaign every production filter treats as real
 * business — on a live store, permanently, because a campaign carrying units
 * cannot be deleted. The dangerous copy was outside the application code, so
 * a fence that only watched `app/` would have missed it.
 */
const SCANNED_ROOTS = ["app", "tests", "scripts"].map((dir) => join(process.cwd(), dir));

/**
 * The ONE place each predicate may be spelled out — and each one's own test,
 * which exists precisely to assert the literal value. A fence that forbade
 * the definition's test from naming the thing it defines would force that
 * test to assert the constant against itself, which proves nothing.
 */
const DEFINITION_FILES = new Set([
  join("domain", "groupbuy", "campaignVisibility.ts"),
  join("domain", "groupbuy", "campaignVisibility.test.ts"),
  join("domain", "groupbuy", "testFixtureCampaign.ts"),
  join("domain", "groupbuy", "testFixtureCampaign.test.ts"),
]);

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      walk(full, acc);
    } else if (/\.tsx?$/.test(entry)) {
      acc.push(full);
    }
  }
  return acc;
}

interface Offence {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

function scannedFiles(): { full: string; relative: string }[] {
  const files: { full: string; relative: string }[] = [];
  for (const root of SCANNED_ROOTS) {
    // `scripts/` need not exist for the fence to be meaningful.
    let entries: string[];
    try {
      entries = walk(root);
    } catch {
      continue;
    }
    for (const full of entries) files.push({ full, relative: full.slice(root.length + 1) });
  }
  return files;
}

function scan(pattern: RegExp): Offence[] {
  const offences: Offence[] = [];
  for (const { full: file, relative } of scannedFiles()) {
    if (DEFINITION_FILES.has(relative)) continue;
    // A fence test's own documentation of the thing it forbids is not a use
    // of it, and neither is a test asserting the fragments' contents.
    if (/campaignVisibility(Fence)?\.test\.tsx?$/.test(relative)) continue;

    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((text, index) => {
      // A COMMENT NAMING THE PREFIX IS DOCUMENTATION, NOT A PREDICATE.
      // Explaining why a campaign code starts with `zz-live-gate-` is exactly
      // the sort of thing these files should say, and a fence that forbade it
      // would push the explanation out of the code rather than the duplication.
      if (/^\s*(\/\/|\/\*|\*)/.test(text)) return;
      if (pattern.test(text)) offences.push({ file: relative, line: index + 1, text: text.trim() });
    });
  }
  return offences;
}

const describeOffences = (offences: readonly Offence[]) =>
  offences.map((o) => `${o.file}:${o.line}  ${o.text}`).join("\n");

/**
 * `archivedAt: null` is only a VISIBILITY DECISION when it narrows a query.
 * Two other things look identical and are not:
 *
 *   - a WRITE clearing the annotation (`data: { archivedAt: null, ... }`) —
 *     that is `unarchiveGroupBuyCampaign` doing its job;
 *   - a VIEW MODEL field or fixture describing one campaign.
 *
 * Both are recognised narrowly: a `data:` on the same line with no `where:`
 * beside it, or a bare field declaration. Anything that mentions `where:`
 * stays an offence no matter what else is on the line, so the exemption
 * cannot be used to smuggle a filter past the fence.
 */
function isNotAFilter(text: string): boolean {
  if (/\bwhere\s*:/.test(text)) return false;
  if (/\bdata\s*:/.test(text)) return true;
  return /^(readonly\s+)?archived(At|By)\??\s*:/.test(text);
}

describe("the fixture-campaign prefix has exactly one definition", () => {
  it("is never spelled inline outside testFixtureCampaign.ts", () => {
    // The literal prefix. Anywhere else must import the constant or the
    // Prisma fragment.
    const offences = scan(/["'`]zz-live-gate-/);
    expect(describeOffences(offences)).toBe("");
  });
});

describe("the archived-campaign predicate has exactly one definition", () => {
  it("is never written inline as a Prisma filter outside campaignVisibility.ts", () => {
    // `archivedAt: null` / `archived_at: null` as a query condition. Reading
    // or rendering the FIELD is fine — comparing it in a filter is what must
    // go through the shared fragment, because getting the audience wrong is
    // the mistake that cannot be seen.
    const offences = scan(/archived_?[Aa]t\s*:\s*(null|\{\s*not\s*:)/).filter((o) => !isNotAFilter(o.text));
    expect(describeOffences(offences)).toBe("");
  });
});

describe("the fence can actually fail", () => {
  it("detects an inline fixture prefix when one is present", () => {
    // GUARD THE GUARD. A fence whose pattern matches nothing passes forever
    // and protects nothing — the failure mode of every grep-based test.
    const pattern = /["'`]zz-live-gate-/;
    expect(pattern.test(`code: { not: { startsWith: "zz-live-gate-" } }`)).toBe(true);
    expect(pattern.test(`import { EXCLUDE_TEST_FIXTURE_CAMPAIGNS } from "./campaignVisibility";`)).toBe(
      false
    );
  });

  it("detects an inline archived filter, and ignores writes and view models", () => {
    const pattern = /archived_?[Aa]t\s*:\s*(null|\{\s*not\s*:)/;
    expect(pattern.test(`where: { archivedAt: null },`)).toBe(true);
    expect(pattern.test(`where: { archivedAt: { not: null } },`)).toBe(true);

    // A FILTER IS STILL AN OFFENCE even on a line that also says `data:` —
    // otherwise the exemption would be a way through the fence.
    expect(isNotAFilter(`where: { archivedAt: null }, data: { x: 1 }`)).toBe(false);
    // A write clearing the annotation is not a visibility decision.
    expect(isNotAFilter(`data: { archivedAt: null, archivedBy: null },`)).toBe(true);
    // Nor is a view model's own field.
    expect(isNotAFilter(`archivedAt: null,`)).toBe(true);
  });

  it("walks a non-trivial number of files, so an empty result means something", () => {
    // If the walk broke, every scan would return nothing and both fences
    // would pass vacuously.
    expect(scannedFiles().length).toBeGreaterThan(100);
  });
});
