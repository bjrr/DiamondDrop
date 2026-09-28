import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * FENCE — `refundLedger.server.ts` is the SINGLE owner of Group Buy refund
 * computation and the single writer of `group_buy_refund`.
 *
 * WHY A FENCE AND NOT A CONVENTION. This codebase has already had two
 * independently-built refund implementations living at once — one in
 * `groupBuyRepository.server.ts`, one in `refundLedger.server.ts` — with
 * their own formulas for the same money. They were consolidated on
 * 2026-09-28. Nothing structural stopped that from happening, and nothing
 * structural would stop it happening again: the second implementation is
 * never written as "a second refund formula", it is written as a small
 * convenience on the repository, or a quick total on an admin route, by
 * someone who does not know the first one exists.
 *
 * Two independent formulas for one refund is not a tidiness problem. It is a
 * money problem: they agree until the day they do not, and the day they do
 * not, one customer is refunded the wrong amount and both code paths look
 * correct in isolation.
 *
 * WHAT THIS PINS, and why these two specific things:
 *
 *   1. WHO WRITES THE ROW. A refund amount that reaches the database without
 *      passing through the ledger is, by definition, computed somewhere else.
 *      Pinning the write surface catches the second implementation at the
 *      only point it must eventually touch.
 *
 *   2. WHO IMPORTS THE FORMULA. A caller that imports `computeTierRefund`
 *      directly is computing a refund outside the ledger even if it never
 *      writes a row — a number that reaches a screen, an email, or an export
 *      is just as wrong as one that reaches a table.
 *
 * The database is the backstop for actual VALUES (`group_buy_refund`'s own
 * CHECK constraints tie the amount to its inputs, and `not_owed` to a zero
 * amount). This fence is the backstop for WHERE THE CODE LIVES, which no
 * constraint can express.
 *
 * TO ADD A LEGITIMATE WRITER: edit the allowlist and say why in the same
 * commit. The point is not that this can never change — it is that changing
 * it is a decision somebody makes on purpose, in a diff a reviewer sees.
 */

const APP_DIR = fileURLToPath(new URL("../..", import.meta.url));

/** Files permitted to write `group_buy_refund` rows. */
const ALLOWED_WRITERS = new Set(["jobs/groupbuy/refundLedger.server.ts"]);

/**
 * Files permitted to import the refund formula. `domain/groupbuy/refunds.ts`
 * is where it is DEFINED, so it appears in its own right rather than as an
 * importer.
 */
const ALLOWED_FORMULA_USERS = new Set([
  "domain/groupbuy/refunds.ts",
  "jobs/groupbuy/refundLedger.server.ts",
]);

const WRITE_CALL = /\bgroupBuyRefund\s*\.\s*(create|createMany|update|updateMany|upsert|delete|deleteMany)\b/;
const FORMULA_REFERENCE = /\bcomputeTierRefund\b/;

/** `APP_DIR` with forward slashes and exactly one trailing slash, so prefix-stripping is exact. */
const APP_DIR_PREFIX = `${APP_DIR.replaceAll("\\", "/").replace(/\/+$/, "")}/`;

function sourceFiles(): string[] {
  return readdirSync(APP_DIR, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => `${(entry.parentPath ?? entry.path).replaceAll("\\", "/")}/${entry.name}`)
    .filter((path) => /\.tsx?$/.test(path) && !/\.test\.tsx?$/.test(path))
    // Strip the scanned root by PREFIX, never by searching for "/app/" inside
    // the absolute path — this repo is itself at .../DiamondDrop/app/app, so a
    // search finds the wrong occurrence and yields paths that do not exist.
    .map((path) => (path.startsWith(APP_DIR_PREFIX) ? path.slice(APP_DIR_PREFIX.length) : path))
    .filter((path) => path.length > 0 && !path.startsWith("/") && !/^[A-Za-z]:/.test(path));
}

function readRelative(relativePath: string): string {
  return readFileSync(`${APP_DIR}/${relativePath}`, "utf8");
}

describe("refund computation has exactly one owner", () => {
  it("finds a real source tree — the guard cannot pass by scanning nothing", () => {
    // GUARD THE GUARD. If the path resolution above were wrong, every
    // assertion below would pass by finding no files at all: the precise
    // shape of a fence that can never fire.
    const files = sourceFiles();
    expect(files.length).toBeGreaterThan(100);
    expect(files).toContain("jobs/groupbuy/refundLedger.server.ts");
    expect(files).toContain("domain/groupbuy/refunds.ts");
  });

  it("only refundLedger.server.ts writes group_buy_refund rows", () => {
    const writers = sourceFiles().filter((path) => WRITE_CALL.test(readRelative(path)));

    // The ledger must be among them — if it stopped writing, this fence would
    // otherwise go quiet while the real owner moved somewhere unpinned.
    expect(writers).toContain("jobs/groupbuy/refundLedger.server.ts");

    const unexpected = writers.filter((path) => !ALLOWED_WRITERS.has(path));
    expect(
      unexpected,
      unexpected.length === 0
        ? ""
        : `These files write group_buy_refund rows but are not the refund ledger:\n` +
            unexpected.map((p) => `  - ${p}`).join("\n") +
            `\n\nGroup Buy refund amounts are computed in ONE place: ` +
            `app/jobs/groupbuy/refundLedger.server.ts. A write from anywhere else means a ` +
            `second implementation of the same money — the exact situation consolidated away ` +
            `on 2026-09-28, when two independently-written formulas coexisted.\n\n` +
            `Route the write through the ledger, or add the file to ALLOWED_WRITERS in this ` +
            `test with a comment saying why it is not a second formula.`
    ).toEqual([]);
  });

  it("only the ledger and the formula's own module reference computeTierRefund", () => {
    const users = sourceFiles().filter((path) => FORMULA_REFERENCE.test(readRelative(path)));

    expect(users).toContain("jobs/groupbuy/refundLedger.server.ts");
    expect(users).toContain("domain/groupbuy/refunds.ts");

    const unexpected = users.filter((path) => !ALLOWED_FORMULA_USERS.has(path));
    expect(
      unexpected,
      unexpected.length === 0
        ? ""
        : `These files compute a Group Buy refund outside the ledger:\n` +
            unexpected.map((p) => `  - ${p}`).join("\n") +
            `\n\nA refund number that reaches a screen, an email or an export is just as ` +
            `wrong as one that reaches a table. Call the ledger instead.`
    ).toEqual([]);
  });
});
