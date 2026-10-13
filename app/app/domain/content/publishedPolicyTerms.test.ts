import { describe, expect, it } from "vitest";

import { PUBLISHED_POLICY_TERMS, isPublishedPolicySlug } from "./publishedPolicyTerms";
import { REQUIRED_POLICY_VERSIONS } from "../evidence/requiredPolicyVersions";

/**
 * The published-terms allowlist.
 *
 * ============================================================================
 * THE ASSERTION THAT MATTERS MOST
 * ============================================================================
 * Every slug published to a storefront policy page must ALSO be one that
 * `/health` already requires to exist. Otherwise a policy page can quote a
 * term whose absence nothing detects: the route omits it, logs an error
 * nobody reads, and the page renders a section short — looking complete,
 * because a missing paragraph looks exactly like a paragraph that was never
 * there.
 *
 * The other direction is deliberately NOT asserted. A required policy need
 * not be published; plenty are acknowledgment mechanics rather than terms a
 * page would quote, and forcing every one onto a public page would be the
 * opposite of an allowlist.
 */

describe("every published term is one /health already guards", () => {
  const requiredSlugs = new Set(REQUIRED_POLICY_VERSIONS.map((p) => p.slug));

  it("publishes no slug outside REQUIRED_POLICY_VERSIONS", () => {
    const unguarded = PUBLISHED_POLICY_TERMS.filter((t) => !requiredSlugs.has(t.slug)).map((t) => t.slug);
    expect(unguarded).toEqual([]);
  });

  it("the check can actually fail — the required set is not empty", () => {
    // Guard the guard: if REQUIRED_POLICY_VERSIONS were empty or unimportable,
    // the assertion above would pass vacuously while protecting nothing.
    expect(requiredSlugs.size).toBeGreaterThan(10);
  });
});

describe("the allowlist is a list, not a pattern", () => {
  it("accepts a slug it names", () => {
    expect(isPublishedPolicySlug(PUBLISHED_POLICY_TERMS[0]!.slug)).toBe(true);
  });

  it("REFUSES a slug it does not name, however plausible", () => {
    for (const slug of [
      "internal-staff-handbook",
      "custom-jewelry-final-approval-draft",
      "sample-policy",
      "",
      "..",
    ]) {
      expect(isPublishedPolicySlug(slug)).toBe(false);
    }
  });

  it("refuses a near-miss of a real slug", () => {
    // A prefix/suffix match would be the natural shortcut and is wrong: it
    // would publish `...-internal` the moment someone added it.
    const real = PUBLISHED_POLICY_TERMS[0]!.slug;
    expect(isPublishedPolicySlug(`${real}-internal`)).toBe(false);
    expect(isPublishedPolicySlug(real.slice(0, -1))).toBe(false);
  });
});

describe("the list itself is coherent", () => {
  it("names each slug once", () => {
    const slugs = PUBLISHED_POLICY_TERMS.map((t) => t.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it("gives every term a non-empty title and group", () => {
    for (const term of PUBLISHED_POLICY_TERMS) {
      expect(term.title.trim().length).toBeGreaterThan(0);
      expect(term.group.trim().length).toBeGreaterThan(0);
    }
  });

  it("carries NO policy text — the words come from the database", () => {
    // THE WHOLE POINT. A `text` field here would be the second copy this
    // module exists to prevent, and it would be the one nobody updates.
    for (const term of PUBLISHED_POLICY_TERMS) {
      expect(Object.keys(term).sort()).toEqual(["group", "slug", "title"]);
    }
  });

  it("titles are wayfinding, not restatements — none is a sentence", () => {
    // A title that ends in a full stop is drifting toward restating the term
    // it labels, which is exactly the duplication this module forbids.
    for (const term of PUBLISHED_POLICY_TERMS) {
      expect(term.title.endsWith(".")).toBe(false);
      expect(term.title.length).toBeLessThan(60);
    }
  });
});
