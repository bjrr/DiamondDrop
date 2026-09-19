import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * CRITERION 34 — the layering boundary, asserted mechanically rather than left
 * to convention (spec §4.0).
 *
 * L3 and L5 depend on nothing: every input arrives as an argument. That is what
 * makes a stored price_calculation reproducible from its snapshot without a
 * database, and what keeps the engine free of a clock it could disagree with.
 *
 * The directory is read at RUNTIME so a file added later is covered
 * automatically — a hardcoded list would silently stop protecting the boundary
 * the moment someone adds a module.
 *
 * Test files are excluded from the assertion: this very file needs node:fs to
 * perform the check, and tests are not shipped in the server bundle.
 */

const PRICING_DIR = join(process.cwd(), "app", "domain", "pricing");

const FORBIDDEN_IMPORTS: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /from\s+["']~\/db\//, why: "imports the persistence layer (L2/L6)" },
  { pattern: /from\s+["']@prisma\/client["']/, why: "imports the Prisma client" },
  { pattern: /from\s+["'][^"']*\.server["']/, why: "imports a server-only module" },
  { pattern: /from\s+["']node:/, why: "imports a Node built-in" },
];

const FORBIDDEN_REFERENCES: readonly { pattern: RegExp; why: string }[] = [
  { pattern: /process\.env/, why: "reads the environment" },
  { pattern: /Date\.now\s*\(/, why: "reads the system clock (asOf is an input)" },
  { pattern: /new\s+Date\s*\(/, why: "constructs a Date from the clock (asOf is an input)" },
];

function productionFiles(): string[] {
  return readdirSync(PRICING_DIR)
    .filter((name) => name.endsWith(".ts"))
    .filter((name) => !name.endsWith(".test.ts"));
}

describe("criterion 34 — app/domain/pricing is pure", () => {
  it("finds the production modules to check", () => {
    const files = productionFiles();
    // Guards against the check silently passing because the glob broke.
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(files).toContain("engine.ts");
  });

  it.each(productionFiles())("%s imports nothing from outside the pure domain", (name) => {
    const source = readFileSync(join(PRICING_DIR, name), "utf8");
    for (const { pattern, why } of FORBIDDEN_IMPORTS) {
      expect(
        pattern.test(source),
        `${name} ${why}. L3/L5 receive every input as an argument (§4.0).`
      ).toBe(false);
    }
  });

  it.each(productionFiles())("%s reads no clock and no environment", (name) => {
    const source = readFileSync(join(PRICING_DIR, name), "utf8");
    // Strip comments so prose mentioning `new Date(` does not trip the check.
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    for (const { pattern, why } of FORBIDDEN_REFERENCES) {
      expect(
        pattern.test(code),
        `${name} ${why}. Reproducing a stored calculation must not depend on when it is re-run (§5.6).`
      ).toBe(false);
    }
  });
});

describe("criterion 29 — the pricing slice never reaches the Shopify Admin API", () => {
  /**
   * THE CRITERION'S ORIGINAL PROXY NO LONGER WORKS, so this replaces it with
   * one that does.
   *
   * §10 criterion 29 read "`package.json` contains no `@shopify/*`
   * dependency". That was a sound proxy when nothing Shopify existed. It stopped
   * being one when the owner directed the app shell, OAuth and Prisma session
   * storage to be installed — `@shopify/shopify-app-react-router` and
   * `@shopify/shopify-app-session-storage-prisma` are both present and belong
   * there.
   *
   * The GUARANTEE behind the criterion is unchanged and is what matters: no
   * pricing, Group Buy or persistence code calls the Admin API, so a price
   * cannot reach a live store by accident before slice 2 wires the sync
   * deliberately. That is asserted directly here, over the three directories
   * the guarantee is about, rather than inferred from a dependency list that
   * now legitimately contains the package.
   *
   * A QA review read the stale criterion, checked `package.json`, and reported
   * criterion 29 as passing. It was not. A proxy that has drifted from its
   * guarantee is worse than no proxy: it answers confidently and wrongly.
   */
  const FENCED_DIRECTORIES = ["domain", "jobs", "db"];

  function sourceFilesUnder(relative: string): string[] {
    const root = join(process.cwd(), "app", relative);
    const found: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) found.push(full);
      }
    };
    walk(root);
    return found;
  }

  it("finds the files to check", () => {
    // Guards the guard: a broken walk would make every assertion below vacuous.
    const all = FENCED_DIRECTORIES.flatMap(sourceFilesUnder);
    expect(all.length).toBeGreaterThan(20);
  });

  it.each(FENCED_DIRECTORIES)("no file under app/%s imports @shopify/*", (relative) => {
    for (const file of sourceFilesUnder(relative)) {
      const code = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/\/\/.*$/gm, "");

      // The import form specifically. A bare mention in a string — the
      // PriceSyncNotImplementedError message names the package deliberately, to
      // tell whoever hits it which slice owns the work — is not a dependency.
      expect(
        /(?:from|import)\s*\(?\s*["']@shopify\//.test(code),
        `${file} imports @shopify/*. Slice 1 must not reach the Admin API; the ` +
          `sync port is implemented in slice 2 (§9.6 scope fence).`
      ).toBe(false);
    }
  });

  it("wires the THROWING sync port in production, not a silent no-op", async () => {
    // The other half of the criterion, and the half that actually protects a
    // customer: if slice 1 somehow tried to publish a price, it must fail
    // loudly. A no-op would mark intents `synced`, leaving an audit trail
    // claiming a price reached Shopify when none did.
    const { UnimplementedPriceSyncPort, PriceSyncNotImplementedError } = await import("~/jobs/pricing/ports");

    await expect(
      new UnimplementedPriceSyncPort().applyVariantPrice()
    ).rejects.toBeInstanceOf(PriceSyncNotImplementedError);
  });
});

describe("criterion 35 — engine.ts performs no arithmetic of its own", () => {
  it("contains no decimal or money operator calls", () => {
    const source = readFileSync(join(PRICING_DIR, "engine.ts"), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    // Every + - x / on a money or decimal quantity belongs in cost.ts,
    // solve.ts, weight.ts or Money. If engine.ts contains a formula, the
    // formula is in the wrong file.
    for (const op of [".plus(", ".minus(", ".times(", ".dividedBy("]) {
      expect(code.includes(op), `engine.ts calls ${op} — move it into a named function (§5.0)`).toBe(
        false
      );
    }
  });
});

/**
 * The margin-model seam (architect follow-up N1).
 *
 * The first version of the two-model solve named each model and each rate in
 * engine.ts, so adding a third margin model meant editing the engine — a seam
 * violation that would only have been noticed when the third model arrived.
 * The registry in solve.ts fixed it, and these tests are what keep it fixed:
 * engine.ts must know that a margin model EXISTS without knowing which ones do.
 */
describe("engine.ts is agnostic to which margin models exist", () => {
  const source = readFileSync(join(PRICING_DIR, "engine.ts"), "utf8");

  it("names no specific margin model", () => {
    expect(source).not.toMatch(/MARKUP_ON_COST_V1|TARGET_GROSS_MARGIN_V1/);
  });

  it("names no model-specific rate", () => {
    // These belong to individual models. engine.ts passes the profile whole and
    // lets each model read its own; if either name reappears here, the engine
    // has started making per-model decisions again.
    expect(source).not.toMatch(/targetMarkupRate|targetGrossMarginRate/);
  });

  it("finds the source it is checking", () => {
    // Guards the guard: a bad path would make every assertion above vacuous.
    expect(source).toMatch(/solveExactBankPaymentPrice/);
    expect(source.length).toBeGreaterThan(500);
  });
});
