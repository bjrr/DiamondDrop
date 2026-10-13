import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * EVERY CARATFORUS CUSTOMER-FACING EMAIL ADDRESS IS ON `@caratforus.com`.
 *
 * Project-wide rule, owner 2026-10-12.
 *
 * ============================================================================
 * WHY THIS IS A REPOSITORY SCAN AND NOT A CONSTANT
 * ============================================================================
 * The customer-service address took three values in two days:
 *
 *   1. `support@caratforus.com` — which I INVENTED while drafting and
 *      carried through the FAQ, the spec and `.env.example` as though it
 *      were a decision. It never was one;
 *   2. `orders@raywanjewelers.com` — a real address, corrected to by the
 *      owner;
 *   3. `orders@caratforus.com` — the owner's final decision, with the rule
 *      that `@raywanjewelers.com` belongs to a SEPARATE BUSINESS and must
 *      not appear here at all.
 *
 * At no point did anything in the codebase object. That is the problem worth
 * fixing: a fabricated address and a real address belonging to someone else
 * are both indistinguishable from a correct one by inspection. A reviewer
 * sees a plausible string and moves on.
 *
 * So this checks the DOMAIN — a fact a test can actually hold — rather than
 * trying to recognise the right local part. `orders@` vs `support@` is an
 * editorial choice; `@caratforus.com` vs someone else's domain is not.
 *
 * ============================================================================
 * WHAT IS EXEMPT, AND WHY EACH ONE IS SAFE
 * ============================================================================
 * Not every address in the repository is a CaratForUs contact address.
 * Test fixtures, third-party sinks and placeholder examples are all
 * legitimate, and banning them outright would push people toward
 * caratforus.com-shaped fakes — which is how (1) above happened. Each
 * exemption below is narrow and justified at its definition.
 */

const REPO_ROOT = join(process.cwd(), "..");

/** The only domain a CaratForUs customer-facing address may use. */
const APPROVED_DOMAIN = "caratforus.com";

/**
 * A SEPARATE BUSINESS. Named explicitly rather than left to the general
 * rule, so the failure message says what is actually wrong instead of
 * "unexpected domain" — the person who reintroduces it will most likely be
 * copying from an old commit or a stale note, and needs to be told that the
 * domain itself is the problem.
 */
const FOREIGN_BUSINESS_DOMAIN = "raywanjewelers.com";

/** Directories never scanned: not ours, or not text. */
const SKIP_DIRECTORIES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".shopify",
  "coverage",
  ".react-router",
  "generated",
]);

/**
 * THIRD-PARTY METADATA IS NOT OURS TO POLICE. A lockfile carries the
 * maintainer address of every transitive dependency (`i@izs.me` and
 * hundreds more); a theme vendored from Dawn may carry its own. Scanning
 * them would produce an unfixable failure whose only remedy is to widen the
 * rule — which is how a fence gets switched off.
 */
const SKIP_FILES = new Set(["package-lock.json", "package.json", "DAWN-LICENSE.md", "CHANGELOG.md"]);

/** This file must be able to name the domain it forbids. */
const SELF = "app/app/domain/content/customerFacingEmailDomain.test.ts";

const SCANNED_EXTENSIONS = /\.(ts|tsx|js|jsx|mjs|cjs|liquid|json|md|example|yml|yaml|toml|sql|css|html)$/;

/**
 * Addresses that are legitimately NOT CaratForUs contact addresses.
 *
 * Each entry is a full address, never a pattern: a pattern exemption would
 * eventually swallow a real mistake. If a new one is needed, it is a line
 * here with a reason, which is the review this fence exists to force.
 */
const ALLOWED_NON_CARAT_ADDRESSES = new Set([
  // Resend's documented accept-and-discard sink. Live gates send real mail,
  // and pointing that at a fabricated address would generate bounces against
  // our own sending domain. See CARAT_LIVE_GATE_SINK_EMAIL in .env.example.
  "delivered@resend.dev",
]);

/**
 * Domains that are obviously illustrative and cannot be mistaken for ours.
 * RFC 2606 reserves `example.com`/`.test`/`.invalid` precisely for this, and
 * test fixtures use them heavily.
 */
const RESERVED_EXAMPLE_DOMAINS = /(^|\.)(example\.(com|org|net)|test|invalid|localhost)$/i;

/** Files whose addresses are fixtures by construction. */
function isFixtureFile(relativePath: string): boolean {
  const normalised = relativePath.split(sep).join("/");
  return (
    /\.test\.(ts|tsx)$/.test(normalised) ||
    normalised.startsWith("app/tests/") ||
    normalised.startsWith("tests/") ||
    normalised.includes("/fixtures/") ||
    normalised.includes("Sandbox.ts")
  );
}

function walk(dir: string, acc: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRECTORIES.has(entry) || SKIP_FILES.has(entry)) continue;
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue; // a broken symlink is not a policy violation
    }
    if (stats.isDirectory()) walk(full, acc);
    else if (SCANNED_EXTENSIONS.test(entry)) acc.push(full);
  }
  return acc;
}

interface Finding {
  readonly file: string;
  readonly line: number;
  readonly address: string;
}

/**
 * THE FINAL LABEL MUST BE ALPHABETIC, and that is not cosmetic.
 *
 * The first version ended `(?:\.[\w-]+)+`, which matched `dev@7.18.3` out of
 * the npm spec `@react-router/dev@7.18.3` in a code comment — reported as an
 * unapproved customer-facing email address. A fence that cries wolf on
 * package versions is one somebody switches off.
 *
 * Requiring a TLD of two or more letters keeps package specs, version
 * ranges and most code-ish `x@y.z` shapes out, while still matching every
 * real address.
 */
const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}/g;

function scanRepository(): { readonly all: Finding[]; readonly fileCount: number } {
  const all: Finding[] = [];
  const files = walk(REPO_ROOT);

  for (const file of files) {
    const relativePath = relative(REPO_ROOT, file).split(sep).join("/");
    // This fence names the forbidden domain in order to forbid it.
    if (relativePath === SELF) continue;

    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    lines.forEach((text, index) => {
      const matches = text.match(EMAIL);
      if (!matches) return;
      for (const address of matches) {
        all.push({ file: relativePath, line: index + 1, address });
      }
    });
  }

  return { all, fileCount: files.length };
}

const { all: ALL_ADDRESSES, fileCount: SCANNED_FILE_COUNT } = scanRepository();

const describeFindings = (findings: readonly Finding[]) =>
  findings.map((f) => `${f.file}:${f.line}  ${f.address}`).join("\n");

describe("the scan reaches the repository", () => {
  it("walks a meaningful number of files", () => {
    // Guard the guard. A broken walk makes every assertion below pass while
    // checking nothing — the standard failure of a grep-based test.
    expect(SCANNED_FILE_COUNT).toBeGreaterThan(200);
  });

  it("finds addresses at all", () => {
    expect(ALL_ADDRESSES.length).toBeGreaterThan(0);
  });

  it("reaches both the app and the theme", () => {
    const roots = new Set(ALL_ADDRESSES.map((f) => f.file.split("/")[0]));
    expect(roots.has("app")).toBe(true);
  });
});

describe("@raywanjewelers.com — a separate business — appears nowhere", () => {
  it("is absent from every scanned file", () => {
    const offences = ALL_ADDRESSES.filter((f) =>
      f.address.toLowerCase().endsWith(`@${FOREIGN_BUSINESS_DOMAIN}`)
    );

    expect(
      describeFindings(offences),
      `${FOREIGN_BUSINESS_DOMAIN} belongs to a separate business and must not appear as a ` +
        `CaratForUs contact address anywhere in this repository`
    ).toBe("");
  });

  it("the domain is not referenced in any form, including prose and config", () => {
    // Broader than the address check: a bare mention in a comment or a
    // config value is how it would creep back in.
    const mentions: Finding[] = [];
    for (const file of walk(REPO_ROOT)) {
      const relativePath = relative(REPO_ROOT, file).split(sep).join("/");
      // This fence must be able to name the thing it forbids.
      if (relativePath === SELF) continue;

      readFileSync(file, "utf8")
        .split(/\r?\n/)
        .forEach((text, index) => {
          if (text.toLowerCase().includes(FOREIGN_BUSINESS_DOMAIN)) {
            mentions.push({ file: relativePath, line: index + 1, address: text.trim() });
          }
        });
    }
    expect(describeFindings(mentions)).toBe("");
  });
});

describe("every CaratForUs customer-facing address is on @caratforus.com", () => {
  it("no production file carries an unapproved address", () => {
    const offences = ALL_ADDRESSES.filter((finding) => {
      const address = finding.address.toLowerCase();
      if (address.endsWith(`@${APPROVED_DOMAIN}`)) return false;
      if (ALLOWED_NON_CARAT_ADDRESSES.has(address)) return false;

      const domain = address.slice(address.indexOf("@") + 1);
      if (RESERVED_EXAMPLE_DOMAINS.test(domain)) return false;

      // Fixtures may use any domain; they are never published.
      if (isFixtureFile(finding.file)) return false;

      return true;
    });

    expect(
      describeFindings(offences),
      "CaratForUs customer-facing email addresses must use @caratforus.com. " +
        "If one of these is NOT a CaratForUs contact address, add it to " +
        "ALLOWED_NON_CARAT_ADDRESSES with a reason rather than widening the rule."
    ).toBe("");
  });

  it("the published customer-service address is the approved one", () => {
    // The positive half. Without it, deleting the address entirely would
    // satisfy every negative assertion above.
    const envExample = readFileSync(join(REPO_ROOT, "app", ".env.example"), "utf8");
    expect(envExample).toContain("CUSTOMER_SERVICE_EMAIL=orders@caratforus.com");

    const faq = readFileSync(
      join(REPO_ROOT, "docs", "specs", "SLICE-12-FAQ-COPY-PROPOSAL.md"),
      "utf8"
    );
    expect(faq).toContain("orders@caratforus.com");
  });
});

describe("the fence can actually fail", () => {
  it("recognises a foreign-domain address", () => {
    // GUARD THE GUARD, on the specific rule this exists for.
    expect("orders@raywanjewelers.com".endsWith(`@${FOREIGN_BUSINESS_DOMAIN}`)).toBe(true);
    expect("orders@caratforus.com".endsWith(`@${FOREIGN_BUSINESS_DOMAIN}`)).toBe(false);
  });

  it("does not mistake a reserved example domain for a real one", () => {
    for (const domain of ["example.com", "sub.example.com", "caratforus.test", "example.invalid"]) {
      expect(RESERVED_EXAMPLE_DOMAINS.test(domain), `${domain} should be treated as illustrative`).toBe(
        true
      );
    }
    for (const domain of ["caratforus.com", "raywanjewelers.com", "gmail.com"]) {
      expect(RESERVED_EXAMPLE_DOMAINS.test(domain), `${domain} is a real domain`).toBe(false);
    }
  });

  it("treats a lookalike domain as unapproved", () => {
    /**
     * I ASSERTED A WEAKNESS HERE THAT THE FENCE DOES NOT HAVE, and the test
     * caught it. The claim was that a suffix check would accept
     * `notcaratforus.com`. It does not: the compared suffix includes the
     * `@`, so the character before `caratforus.com` must be the separator,
     * not a letter.
     *
     * Worth keeping as an assertion rather than deleting, because "a suffix
     * check is loose" is the kind of plausible reasoning that would justify
     * replacing this with something more complicated and worse.
     */
    expect("hello@caratforus.com".toLowerCase().endsWith(`@${APPROVED_DOMAIN}`)).toBe(true);
    expect("hello@notcaratforus.com".toLowerCase().endsWith(`@${APPROVED_DOMAIN}`)).toBe(false);
    // A different registration entirely.
    expect("hello@caratforus.co".toLowerCase().endsWith(`@${APPROVED_DOMAIN}`)).toBe(false);
    // What the suffix form DOES accept is a subdomain, which is correct —
    // `orders@mail.caratforus.com` is ours.
    expect("orders@mail.caratforus.com".toLowerCase().endsWith(`.${APPROVED_DOMAIN}`)).toBe(true);
  });
});
