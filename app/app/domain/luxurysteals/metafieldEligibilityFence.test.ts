import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * REGRESSION FENCE for criteria 127/150 (docs/specs/SLICE-3-LUXURY-STEALS.md
 * §4.1/§4.7): Luxury Steal ELIGIBILITY is authoritative ONLY in Postgres
 * (`master_variant.is_luxury_steal`). `carat.luxury_steal` is a variant
 * metafield synced FROM that column as a presentation cache for the
 * storefront theme — never the other direction, and never a second source of
 * truth. The two files fenced below are today satisfying that rule "by
 * construction": neither imports anything that can read a metafield, so
 * there is no code path for a stale or tampered cache to influence them. That
 * is stronger than a runtime check in one sense — it is currently
 * IMPOSSIBLE, not merely correct — but weaker in another: nothing before this
 * fence would FAIL if someone later added a metafield read "just to
 * short-circuit the lookup," a plausible-sounding optimisation from someone
 * who has not read this comment. The reasoning already lives in both files'
 * own doc comments; comments do not fail builds. This file is the version of
 * that reasoning that does.
 *
 * WHY THESE TWO FILES SPECIFICALLY. They are the only two places a client
 * request can reach a Luxury Steal eligibility DECISION:
 *
 *   - `apps.carat.luxury-acknowledgment.tsx` decides whether a variant may
 *     receive a Final Sale acknowledgment at all (criteria 133-136, 150).
 *   - `luxuryStealOrderHandler.server.ts` decides, at `orders/create`,
 *     whether a line's acknowledgment is verified or the order is held
 *     (criteria 137-140, 150). D6 (docs/specs/SLICE-3-LUXURY-STEALS.md)
 *     explicitly declined a Cart/Checkout Validation Function for MVP1 —
 *     nothing inside Shopify's own checkout can refuse an un-acknowledged
 *     line, which makes this file the LAST enforcement standing between a
 *     bypassed storefront and a silently fulfilled Final Sale item. If this
 *     one ever trusted a client-influenced cache, there would be nothing left
 *     to catch the bypass at all.
 *
 * WHY A METAFIELD READ HERE WOULD BE UNSAFE, NOT MERELY REDUNDANT. The cache
 * can be STALE (a sync failure or lag leaves it behind Postgres — criterion
 * 127 says the server must still be right when that happens) and, on the
 * order-time path specifically, is reachable by a request that already
 * bypassed the storefront gate the cache was meant to serve — there is no
 * reason to assume it reflects anything trustworthy by the time this code
 * runs. Querying `isMasterVariantLuxurySteal` (Postgres) is the only read
 * that is safe here, and it is what both files already do.
 *
 * WALKS THE SOURCE of the two files directly rather than hand-maintaining a
 * list of "safe" imports elsewhere — same reasoning as
 * `app/shopify/webhooks/boundaryPreserved.test.ts` and
 * `app/routes/csrfResourceRouteFence.test.ts`: an allowlist of what is
 * PERMITTED rots the moment someone adds something new and forgets to check
 * it; a denylist of the THREE ways a metafield can leak in (an import from
 * the metafields module, the literal metafield key, or a `.metafields`
 * property read) fails on the new code itself, whatever form it takes.
 */

const APP_DIR = join(process.cwd(), "app");

/** The only two client-reachable Luxury Steal eligibility decision points — see the module doc comment for why each is here and why there are only two. */
const FENCED_FILES: Readonly<Record<string, string>> = {
  "shopify/webhooks/luxuryStealOrderHandler.server.ts":
    "the orders/create enforcement path (criteria 137-140) — the last thing standing " +
    "between a storefront bypass and a silently fulfilled Final Sale item, since D6 " +
    "declined a Cart/Checkout Validation Function for MVP1.",
  "routes/apps.carat.luxury-acknowledgment.tsx":
    "the Final Sale acknowledgment capture gate (criteria 133-136) — decides whether a " +
    "variant may receive an acknowledgment at all before any order exists.",
};

/** Block and line comments removed, so prose ABOUT the rule (this file's own doc comment, and both fenced files' own) cannot trip the fence for saying the right thing — same discipline as `boundaryPreserved.test.ts`. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

/** Matches an import specifier naming the metafields module, however it is reached (alias or relative). */
const METAFIELD_IMPORT_PATTERN = /from\s+["'][^"']*shopify\/metafields[^"']*["']/;
/** The exact metafield namespace.key (docs/specs/SLICE-3-LUXURY-STEALS.md criterion 149) — a literal reference to it is itself a smell, even outside an import. */
const METAFIELD_KEY_PATTERN = /carat\.luxury_steal/;
/** A `.metafields` property read — the shape a Liquid-style or Admin-API-shaped access would take in TypeScript (`variant.metafields...`). */
const METAFIELDS_PROPERTY_PATTERN = /\.metafields\b/;

interface FenceResult {
  violated: boolean;
  reasons: string[];
}

/** PURE — no I/O. The detector, exported implicitly through the tests below so its own behaviour is proven, not just trusted. */
function checkMetafieldEligibilityFence(source: string): FenceResult {
  const code = stripComments(source);
  const reasons: string[] = [];
  if (METAFIELD_IMPORT_PATTERN.test(code)) reasons.push("imports from a shopify/metafields module");
  if (METAFIELD_KEY_PATTERN.test(code)) reasons.push('references the metafield key "carat.luxury_steal"');
  if (METAFIELDS_PROPERTY_PATTERN.test(code)) reasons.push("reads a .metafields property");
  return { violated: reasons.length > 0, reasons };
}

const WHY_THIS_MATTERS =
  "Luxury Steal eligibility is authoritative ONLY in Postgres (master_variant.is_luxury_steal, " +
  "criteria 127/150, docs/specs/SLICE-3-LUXURY-STEALS.md). carat.luxury_steal is a PRESENTATION " +
  "CACHE synced FROM that column for the storefront theme — it can be stale (sync lag or failure) " +
  "and, on the order-time enforcement path, is reached only after a request has already bypassed " +
  "the storefront gate the cache exists to serve. D6 explicitly declined a Cart/Checkout " +
  "Validation Function for MVP1, which makes this file one of the LAST enforcement points " +
  "standing between an un-acknowledged Luxury Steal and a fulfilled Final Sale order. If you are " +
  'adding a metafield read here to "short-circuit the lookup" or as a performance optimisation: ' +
  "don't — query Postgres directly (isMasterVariantLuxurySteal), exactly as this file already " +
  "does. A metafield read on this path reopens the exact fail-unsafe hole criteria 127/150 exist " +
  "to close.";

describe("Luxury Steal eligibility fence — enforcement paths never read the metafield", () => {
  it("finds both files it is supposed to check", () => {
    // Guards the guard: an empty/shrunk list would make the it.each below
    // vacuously pass, which is exactly how this fence would rot silently if
    // a file were ever renamed without updating FENCED_FILES.
    expect(Object.keys(FENCED_FILES)).toHaveLength(2);
    for (const relativePath of Object.keys(FENCED_FILES)) {
      expect(
        () => readFileSync(join(APP_DIR, relativePath), "utf8"),
        `${relativePath} could not be read — has it moved? FENCED_FILES must track it.`
      ).not.toThrow();
    }
  });

  it.each(Object.entries(FENCED_FILES))("%s never reads the metafield", (relativePath, why) => {
    const source = readFileSync(join(APP_DIR, relativePath), "utf8");
    const result = checkMetafieldEligibilityFence(source);

    expect(
      result.violated,
      `${relativePath} ${result.reasons.join("; ")}.\n\n` +
        `This file is ${why}\n\n${WHY_THIS_MATTERS}`
    ).toBe(false);
  });
});

describe("guard the guard — the detector actually catches each violation shape", () => {
  it("flags an import from a shopify/metafields module (aliased)", () => {
    const violating = `import { setLuxuryStealMetafields } from "~/shopify/metafields/luxuryStealMetafield.server";`;
    expect(checkMetafieldEligibilityFence(violating).violated).toBe(true);
  });

  it("flags an import from a shopify/metafields module (relative)", () => {
    const violating = `import { setLuxuryStealMetafields } from "../shopify/metafields/luxuryStealMetafield.server";`;
    expect(checkMetafieldEligibilityFence(violating).violated).toBe(true);
  });

  it("flags a bare reference to the carat.luxury_steal metafield key", () => {
    const violating = `const key = "carat.luxury_steal";`;
    expect(checkMetafieldEligibilityFence(violating).violated).toBe(true);
  });

  it("flags reading a .metafields property directly", () => {
    const violating = `if (variant.metafields.carat.luxury_steal.value) { grantEligibility(); }`;
    expect(checkMetafieldEligibilityFence(violating).violated).toBe(true);
  });

  it("is not fooled by a mention only in a comment — matches this repo's existing discipline", () => {
    const documented = `
      // We deliberately never read variant.metafields.carat.luxury_steal here —
      // see criteria 127/150. Query isMasterVariantLuxurySteal instead.
      import { isMasterVariantLuxurySteal } from "~/db/repositories/luxuryStealRepository.server";
    `;
    expect(checkMetafieldEligibilityFence(documented).violated).toBe(false);
  });

  it("does not flag legitimate Postgres-only code", () => {
    const clean = `
      import { isMasterVariantLuxurySteal } from "~/db/repositories/luxuryStealRepository.server";
      const isLuxurySteal = await isMasterVariantLuxurySteal(variant.id);
    `;
    expect(checkMetafieldEligibilityFence(clean).violated).toBe(false);
  });

  it("does not flag an unrelated variable or word that merely contains 'metafields' as a substring of something else", () => {
    const clean = `const notMetafieldsRelatedAtAll = 1;`;
    expect(checkMetafieldEligibilityFence(clean).violated).toBe(false);
  });
});
