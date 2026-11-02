import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { runSyosPdpAsset } from "./syosSessionPropertySandbox";

/**
 * A Set Your Own Stone mounting bought from its own product page must arrive
 * on the order carrying the stone session, so staff can tell the order belongs
 * to an SYOS project and -- for a Review Required stone -- that a jeweler has
 * to inspect the stone before setting it.
 *
 * THIS FILE EXISTS BECAUSE THE FIRST IMPLEMENTATION SILENTLY DID NOTHING.
 * Both the order property and the custom path were gated in Liquid on
 * `request.url | split: 'stone='`. Shopify does not expose the query string to
 * Liquid, so that expression is blank on every request: the markup type-checked,
 * linted, pushed and rendered, and simply never appeared. Measuring the live
 * page is what caught it. The scans below pin the shape that replaced it, and
 * the sandbox runs the real asset so "the property is attached" is proven by
 * execution rather than by reading the source.
 */
const THEME_ROOT = join(process.cwd(), "..", "theme");
const read = (...parts: string[]) => readFileSync(join(THEME_ROOT, ...parts), "utf8");

/** Liquid comments, so a `{% comment %}` mentioning a pattern never satisfies a scan. */
function stripLiquidComments(source: string): string {
  return source.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "");
}

/** JS comments, for the same reason. */
function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const STONE = "SYS-BGBEHDNG";
const PDP = "https://caratforus.myshopify.com/products/a-mounting";

describe("the stone session is never read from Liquid", () => {
  it("no theme file gates SYOS behaviour on request.url", () => {
    // The exact regression. `request.url` is not a Liquid property; a gate on
    // it reads blank forever and takes the behaviour with it.
    for (const file of [
      ["snippets", "buy-buttons.liquid"],
      ["sections", "main-product.liquid"],
      ["snippets", "product-variant-picker.liquid"],
    ]) {
      expect(stripLiquidComments(read(...file)), file.join("/")).not.toMatch(/request\.url/);
    }
  });

  it("the input ships with no name, so a browser without JS submits no property", () => {
    const source = stripLiquidComments(read("snippets", "buy-buttons.liquid"));
    // Present, marked for the asset, and gated on eligibility.
    expect(source).toMatch(/data-carat-syos-session/);
    expect(source).toMatch(/product\.metafields\.carat\.syos_eligible\.value\s*==\s*true/);
    // The property name must NOT be in the server-rendered markup: an input
    // that is already named would post an empty value, which is worse than
    // posting nothing -- it asserts an SYOS order with no session to resolve.
    expect(source).not.toMatch(/name="properties\[_syos_session\]"/);
  });

  it("the asset is loaded for SYOS mountings and names the property itself", () => {
    const section = stripLiquidComments(read("sections", "main-product.liquid"));
    expect(section).toMatch(/carat-syos-pdp\.js/);

    const asset = stripJsComments(read("assets", "carat-syos-pdp.js"));
    expect(asset).toMatch(/properties\[_syos_session\]/);
    // The session reference, and only the session reference. A compatibility
    // verdict posted from a page the customer controls must never be trusted;
    // operations resolves the status server-side from the session.
    expect(asset).not.toMatch(/_syos_compatibility/);
  });
});

describe("carat-syos-pdp.js, executed", () => {
  it("attaches the session as an order property when the URL carries one", () => {
    const run = runSyosPdpAsset(`${PDP}?variant=123&stone=${STONE}`);
    expect(run.input.getAttribute("name")).toBe("properties[_syos_session]");
    expect(run.input.value).toBe(STONE);
  });

  it("attaches nothing when the URL carries no stone", () => {
    const run = runSyosPdpAsset(`${PDP}?variant=123`);
    // Nameless means unsubmitted. Fails closed.
    expect(run.input.getAttribute("name")).toBeNull();
    expect(run.input.value).toBe("");
    expect(run.block.hasAttribute("hidden")).toBe(true);
  });

  it("reveals the custom path and carries the stone into both destinations", () => {
    const run = runSyosPdpAsset(`${PDP}?stone=${STONE}`);
    expect(run.block.hasAttribute("hidden")).toBe(false);

    expect(run.links).toHaveLength(2);
    const [customizeThis, backToStone] = run.links as [
      (typeof run.links)[number],
      (typeof run.links)[number],
    ];
    // The mounting reference the template built must survive alongside the stone.
    expect(customizeThis.getAttribute("href")).toContain("/pages/custom-jewelry");
    expect(customizeThis.getAttribute("href")).toContain("mounting=A");
    expect(customizeThis.getAttribute("href")).toContain(`stone=${STONE}`);
    expect(backToStone.getAttribute("href")).toBe(`/pages/set-your-own-stone?stone=${STONE}`);
  });

  it("keeps the custom path hidden with no session, rather than promising continuity", () => {
    const run = runSyosPdpAsset(PDP);
    expect(run.block.hasAttribute("hidden")).toBe(true);
    expect(run.links[0]?.getAttribute("href")).not.toContain("stone=");
  });

  it("survives a variant change", () => {
    // Dawn replaces the product-info subtree when the customer picks a metal or
    // ring size. If the session were applied once at load, choosing a ring size
    // would quietly drop it from the order.
    const run = runSyosPdpAsset(`${PDP}?stone=${STONE}`);
    run.input.removeAttribute("name");
    run.input.value = "";
    run.block.setAttribute("hidden", "");

    run.rerender();

    expect(run.input.getAttribute("name")).toBe("properties[_syos_session]");
    expect(run.input.value).toBe(STONE);
    expect(run.block.hasAttribute("hidden")).toBe(false);
  });

  it("ignores a blank stone parameter", () => {
    const run = runSyosPdpAsset(`${PDP}?stone=`);
    expect(run.input.getAttribute("name")).toBeNull();
    expect(run.block.hasAttribute("hidden")).toBe(true);
  });

  it("does not re-encode a reference that is already safe", () => {
    const run = runSyosPdpAsset(`${PDP}?stone=${STONE}`);
    expect(run.input.value).toBe(STONE);
    expect(run.input.value).not.toContain("%");
  });
});
