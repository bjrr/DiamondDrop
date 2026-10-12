import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { getLatestPolicyVersion } from "~/db/repositories/policyVersionRepository.server";
import { PUBLISHED_POLICY_TERMS } from "~/domain/content/publishedPolicyTerms";
import { loader } from "~/routes/apps.carat.policies";

/**
 * The published policy terms endpoint — what a storefront policy page quotes.
 *
 * ============================================================================
 * WHAT ONLY A REAL DATABASE PROVES
 * ============================================================================
 * That the text served to a customer reading a policy page is BYTE-IDENTICAL
 * to the text in the `policy_version` row they would later acknowledge. A
 * unit test with a stubbed repository proves the plumbing; only this proves
 * there is genuinely one copy.
 *
 * It also proves the allowlist holds against the real table, which contains
 * rows (`sample-policy`, and every future internal policy) that must never
 * reach a storefront URL.
 */

function signed(params: Record<string, string>): URL {
  const secret = process.env.SHOPIFY_API_SECRET as string;
  const message = Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  const signature = createHmac("sha256", secret).update(message, "utf8").digest("hex");
  const url = new URL("https://shop.example.com/apps/carat/policies");
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("signature", signature);
  return url;
}

function call(params: Record<string, string> = {}) {
  return loader({
    request: new Request(signed({ shop: "caratforus-dev.myshopify.com", ...params })),
    params: {},
    context: {},
  } as unknown as Parameters<typeof loader>[0]);
}

interface Body {
  terms: { slug: string; title: string; group: string; version: number; text: string }[];
  incomplete: boolean;
}

describe("the App Proxy boundary", () => {
  it("REJECTS an unsigned request", async () => {
    const response = await loader({
      request: new Request("https://shop.example.com/apps/carat/policies"),
      params: {},
      context: {},
    } as unknown as Parameters<typeof loader>[0]);
    expect(response.status).toBe(401);
  });

  it("accepts a correctly signed request", async () => {
    expect((await call()).status).toBe(200);
  });
});

describe("the served text IS the acknowledged text", () => {
  it("returns every published term, complete", async () => {
    const body = (await (await call()).json()) as Body;
    expect(body.terms).toHaveLength(PUBLISHED_POLICY_TERMS.length);
    expect(body.incomplete).toBe(false);
  });

  it("matches the policy_version row BYTE FOR BYTE, for every term", async () => {
    // THE ASSERTION THIS FILE EXISTS FOR. If a policy page could quote
    // anything but this exact string, a dispute could put our own page
    // against our own evidence.
    const body = (await (await call()).json()) as Body;

    for (const term of body.terms) {
      const row = await getLatestPolicyVersion(term.slug);
      expect(row, `no policy_version row for ${term.slug}`).not.toBeNull();
      expect(term.text).toBe(row!.text);
      expect(term.version).toBe(row!.version);
    }
  });

  it("serves the CURRENT version — the highest, not the first", async () => {
    // Custom Jewelry final approval is at version 2 (migration
    // 20261012010000). A page quoting version 1 would show words that were
    // deliberately replaced.
    const body = (await (await call({ slug: "custom-jewelry-final-approval" })).json()) as Body;
    expect(body.terms).toHaveLength(1);
    expect(body.terms[0]!.version).toBeGreaterThanOrEqual(2);
    expect(body.terms[0]!.text).toMatch(/Design Deposit credit applied to it/);
  });
});

describe("the allowlist holds against the real table", () => {
  it("does NOT serve sample-policy, which exists in the database", async () => {
    // A Slice 0 fixture, present in every environment, and exactly the kind
    // of row that must not become world-readable.
    expect(await getLatestPolicyVersion("sample-policy")).not.toBeNull();

    const body = (await (await call({ slug: "sample-policy" })).json()) as Body;
    expect(body.terms).toEqual([]);
  });

  it("returns EMPTY rather than 404 for an unpublished slug — no probing", async () => {
    // A 404 would distinguish "real but unpublished" from "nonexistent",
    // turning this into an oracle for what slugs exist.
    const real = await call({ slug: "sample-policy" });
    const fake = await call({ slug: "no-such-policy-at-all" });

    expect(real.status).toBe(fake.status);
    expect(await real.text()).toBe(await fake.text());
  });

  it("never serves a slug outside the allowlist, whatever is asked for", async () => {
    const allowed = new Set(PUBLISHED_POLICY_TERMS.map((t) => t.slug));
    for (const slug of ["sample-policy", "../sample-policy", "", "custom-jewelry-final-approval-x"]) {
      const body = (await (await call({ slug })).json()) as Body;
      for (const term of body.terms) expect(allowed.has(term.slug)).toBe(true);
    }
  });
});

describe("grouping", () => {
  it("narrows to one group", async () => {
    const body = (await (await call({ group: "quote-match" })).json()) as Body;
    expect(body.terms.length).toBeGreaterThan(0);
    expect(body.terms.every((t) => t.group === "quote-match")).toBe(true);
  });

  it("ignores an unknown group rather than returning nothing", async () => {
    // A theme asking for a group that does not exist has a bug; serving
    // everything is a visible wrong answer, and serving nothing looks like a
    // policy page with no policies on it.
    const body = (await (await call({ group: "not-a-group" })).json()) as Body;
    expect(body.terms).toHaveLength(PUBLISHED_POLICY_TERMS.length);
  });

  it("preserves the editorial order within a group", async () => {
    const body = (await (await call({ group: "custom-jewelry" })).json()) as Body;
    const expected = PUBLISHED_POLICY_TERMS.filter((t) => t.group === "custom-jewelry").map((t) => t.slug);
    expect(body.terms.map((t) => t.slug)).toEqual(expected);
  });
});

describe("nothing private reaches this public endpoint", () => {
  it("returns no cost, customer, order or internal data", async () => {
    const raw = await (await call()).text();
    const lower = raw.toLowerCase();
    for (const forbidden of ["landedcost", "grossmargin", "wholesale", "supplier", "customer_ref", "orderref"]) {
      expect(lower).not.toContain(forbidden);
    }
  });

  it("is publicly cacheable — these are the same words every customer sees", async () => {
    expect((await call()).headers.get("Cache-Control")).toMatch(/public/);
  });
});
