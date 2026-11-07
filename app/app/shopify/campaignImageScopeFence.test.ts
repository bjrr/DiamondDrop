import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE SCOPE CHANGE, AND ITS LIMIT.
 *
 * `read_files` was approved by the owner on 2026-11-06 because the Group Buy
 * campaign builder has a concrete need for it: Shopify's native file picker
 * (`pick:shopify/File`) returns ONLY an array of file ids, so turning a
 * merchant's selection into something renderable — or confirming it is an
 * image belonging to this shop rather than an id a tampered form invented —
 * means resolving those ids against the Admin API.
 *
 * `write_files` was explicitly NOT approved. Merchants upload through Shopify
 * Files, or through whatever upload affordance Shopify's own picker offers,
 * which is Shopify's permission rather than ours. This app never creates,
 * replaces or deletes a merchant's file.
 *
 * A scope is the easiest thing in a codebase to widen by accident: it is one
 * word in a config file, it makes an error message go away, and nothing fails
 * when it is added. This fence is the thing that fails.
 */

const APP_TOML = join(process.cwd(), "shopify.app.caratforus-development.toml");
const CONFIG = readFileSync(APP_TOML, "utf8");

/** The `scopes = "..."` value, which is the only line that grants anything. */
function declaredScopes(): readonly string[] {
  // Anchored on a line start so a `scopes` word inside the surrounding
  // explanatory comments cannot be mistaken for the declaration. The comments
  // in that file discuss scopes at length, which is exactly how a naive
  // pattern would read the wrong thing.
  const match = CONFIG.match(/^scopes\s*=\s*"([^"]*)"/m);
  expect(match, "scopes declaration not found in shopify.app.caratforus-development.toml").not.toBeNull();
  return match![1]!
    .split(",")
    .map((scope) => scope.trim())
    .filter((scope) => scope !== "");
}

describe("the file scope", () => {
  const scopes = declaredScopes();

  it("requests read_files, which the native picker's id-only response requires", () => {
    expect(scopes).toContain("read_files");
  });

  it("does NOT request write_files", () => {
    expect(scopes).not.toContain("write_files");
  });

  it("requests no other file or media write scope", () => {
    const writeScopes = scopes.filter((scope) => /^write_/.test(scope));
    expect(writeScopes).not.toContain("write_files");
    // Nothing media-shaped either: a `write_media` or similar would be the
    // same privilege under a different name.
    expect(scopes.filter((scope) => /media/i.test(scope))).toEqual([]);
  });

  it("adds exactly one scope beyond the set that existed before this change", () => {
    // The pre-change set, recorded so that a future scope addition has to
    // come here and be justified rather than slipping in alongside an
    // unrelated feature.
    const BEFORE = [
      "read_products",
      "write_products",
      "read_inventory",
      "read_customers",
      "write_customers",
      "write_draft_orders",
      "read_orders",
      "write_payment_terms",
      "write_orders",
      "read_merchant_managed_fulfillment_orders",
      "write_merchant_managed_fulfillment_orders",
      "read_metaobjects",
    ];
    const added = scopes.filter((scope) => !BEFORE.includes(scope));
    expect(added).toEqual(["read_files"]);
  });

  it("declares no optional scopes", () => {
    expect(CONFIG).toMatch(/^optional_scopes\s*=\s*\[\s*\]/m);
  });

  it("records why read_files is needed, next to the declaration", () => {
    // A scope with no stated reason is a scope nobody can later audit.
    expect(CONFIG).toMatch(/read_files/);
    expect(CONFIG).toMatch(/pick:shopify\/File/);
    expect(CONFIG).toMatch(/write_files is deliberately NOT requested/);
  });
});
