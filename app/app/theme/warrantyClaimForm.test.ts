import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Liquid } from "liquidjs";
import { describe, expect, it } from "vitest";

import { loadWarrantyClaimForm } from "./warrantyClaimFormSandbox";

/**
 * Warranty Claim Form order picker + account-required gate (frontend-ux
 * task: "Warranty form order picker and gate").
 *
 * TWO GAPS THIS FILE PROVES ARE CLOSED, MATCHING THE bankPaymentCheckoutForm
 * .test.ts STANDARD IT WAS ASKED TO MATCH:
 *  1. The order-lookup response handling is PURE logic (real module, via
 *     `warrantyClaimFormSandbox.ts`) -- never resolves a malformed/partial
 *     response into something the customer could submit against, and never
 *     surfaces a raw HTTP status or server error code.
 *  2. THE ACCOUNT-REQUIRED GATE (docs/REQUIRED-CUSTOMER-ACCOUNTS.md §5)
 *     actually changes what renders for a signed-out customer, not merely
 *     that a `{%- if %}` tag exists in the source -- proven by rendering the
 *     REAL Liquid with `liquidjs` against signed-in/signed-out fixtures and
 *     diffing the OUTPUT, exactly the R16/2C-6 standard: a source scan can
 *     prove a tag is WRITTEN, not which branch a customer actually sees.
 */

const THEME_ROOT = join(process.cwd(), "..", "theme");
const SECTION = "sections/warranty-claim-form.liquid";

function stripLiquidComments(source: string): string {
  return source.replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/g, "");
}

// `{% style %}...{% endstyle %}` and `{% schema %}...{% endschema %}` are
// Shopify-only tags liquidjs's core engine does not know; neither carries
// any control-flow this file cares about (padding CSS / the editor schema
// JSON), so both are stripped the same way `stripLiquidComments` strips
// comments, rather than registering no-op tag stubs for tags this test
// never needs to exercise.
function stripStyleAndSchema(source: string): string {
  return source
    .replace(/{%-?\s*style\s*-?%}[\s\S]*?{%-?\s*endstyle\s*-?%}/g, "")
    .replace(/{%-?\s*schema\s*-?%}[\s\S]*?{%-?\s*endschema\s*-?%}/g, "");
}

function readLiquid(relativePath: string): string {
  return stripStyleAndSchema(stripLiquidComments(readFileSync(join(THEME_ROOT, relativePath), "utf8")));
}

function locale(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(THEME_ROOT, "locales", "en.default.json"), "utf8")) as Record<string, unknown>;
}

function at(path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => {
    if (node === null || typeof node !== "object") return undefined;
    return (node as Record<string, unknown>)[key];
  }, locale());
}

// -----------------------------------------------------------------------
// 1. Pure order-lookup logic (real module, via warrantyClaimFormSandbox).
// -----------------------------------------------------------------------

describe("CaratWarrantyClaimForm._internal — order lookup response handling", () => {
  it("orderLookupMessageKeyForFailure maps 401 to the sign-in sentence key, and everything else to the generic unavailable key", () => {
    const { _internal } = loadWarrantyClaimForm();
    expect(_internal.orderLookupMessageKeyForFailure(401)).toBe("sign_in_required_message");
    expect(_internal.orderLookupMessageKeyForFailure(400)).toBe("error_service_unavailable");
    expect(_internal.orderLookupMessageKeyForFailure(500)).toBe("error_service_unavailable");
    expect(_internal.orderLookupMessageKeyForFailure(502)).toBe("error_service_unavailable");
  });

  it("normalizeOrderLookupResult passes through a well-formed resolved response", () => {
    const { _internal } = loadWarrantyClaimForm();
    const result = _internal.normalizeOrderLookupResult({
      resolved: true,
      order: {
        orderRef: "gid://shopify/Order/1",
        orderName: "#1001",
        lineItems: [{ lineRef: "gid://shopify/LineItem/1", title: "Ring", quantity: 1 }],
      },
    });
    expect(result).toEqual({
      resolved: true,
      order: {
        orderRef: "gid://shopify/Order/1",
        orderName: "#1001",
        lineItems: [{ lineRef: "gid://shopify/LineItem/1", title: "Ring", quantity: 1 }],
      },
    });
  });

  it("treats the route's own generic { resolved: false } as not resolved", () => {
    const { _internal } = loadWarrantyClaimForm();
    expect(_internal.normalizeOrderLookupResult({ resolved: false })).toEqual({ resolved: false, order: null });
  });

  it.each([
    ["null body", null],
    ["a bare string", "resolved"],
    ["resolved without an order", { resolved: true }],
    ["resolved with a non-array lineItems", { resolved: true, order: { orderRef: "gid://1", orderName: "#1", lineItems: "oops" } }],
    ["resolved with zero line items", { resolved: true, order: { orderRef: "gid://1", orderName: "#1", lineItems: [] } }],
    ["resolved with every line item missing lineRef", { resolved: true, order: { orderRef: "gid://1", orderName: "#1", lineItems: [{ title: "x", quantity: 1 }] } }],
    ["resolved with a missing orderRef", { resolved: true, order: { orderName: "#1", lineItems: [{ lineRef: "gid://l1", title: "x", quantity: 1 }] } }],
  ])("treats %s the same as not resolved, never a partial result", (_label, body) => {
    const { _internal } = loadWarrantyClaimForm();
    expect(_internal.normalizeOrderLookupResult(body)).toEqual({ resolved: false, order: null });
  });

  it("filters out an individual malformed line item while keeping the valid ones from the same order", () => {
    const { _internal } = loadWarrantyClaimForm();
    const result = _internal.normalizeOrderLookupResult({
      resolved: true,
      order: {
        orderRef: "gid://shopify/Order/1",
        orderName: "#1001",
        lineItems: [
          { lineRef: "", title: "bad — no lineRef", quantity: 1 },
          { title: "bad — no lineRef key at all", quantity: 1 },
          { lineRef: "gid://shopify/LineItem/2", title: "Good ring", quantity: 2 },
        ],
      },
    });
    expect(result.resolved).toBe(true);
    expect(result.order?.lineItems).toEqual([{ lineRef: "gid://shopify/LineItem/2", title: "Good ring", quantity: 2 }]);
  });

  it("coerces a non-string title and a non-number quantity to safe defaults rather than propagating them", () => {
    const { _internal } = loadWarrantyClaimForm();
    const result = _internal.normalizeOrderLookupResult({
      resolved: true,
      order: {
        orderRef: "gid://shopify/Order/1",
        orderName: "#1001",
        lineItems: [{ lineRef: "gid://shopify/LineItem/1", title: null, quantity: "two" }],
      },
    });
    expect(result.order?.lineItems).toEqual([{ lineRef: "gid://shopify/LineItem/1", title: "", quantity: 0 }]);
  });

  it("buildLineItemOptionLabel substitutes both placeholders from the template it is given, without reading any global", () => {
    const { _internal } = loadWarrantyClaimForm();
    const label = _internal.buildLineItemOptionLabel("{{ title }} (Qty: {{ quantity }})", { title: "Solitaire Ring", quantity: 2 });
    expect(label).toBe("Solitaire Ring (Qty: 2)");
  });
});

// -----------------------------------------------------------------------
// 2. The account-required gate — real rendering, both branches.
// -----------------------------------------------------------------------

describe("the account-required gate (docs/REQUIRED-CUSTOMER-ACCOUNTS.md §5) — real rendering, both branches", () => {
  const SIGNED_IN_CUSTOMER = { name: "Jane Doe", email: "jane@example.com" };

  function sectionContext(customer: Record<string, unknown> | null) {
    return {
      customer,
      routes: { account_login_url: "/account/login" },
      request: { path: "/pages/warranty-claim" },
      section: {
        id: "test-section",
        settings: {
          heading: "",
          heading_size: "h1",
          color_scheme: "scheme-1",
          padding_top: 36,
          padding_bottom: 36,
        },
      },
    };
  }

  function createSectionEngine(customer: Record<string, unknown> | null): Liquid {
    // The sign-in gate now lives in `snippets/warranty-claim-signin.liquid` so
    // it can render ABOVE the scope paragraph without being written twice, so
    // the engine has to be able to resolve `{% render %}` the way Shopify
    // does. Two things are needed and both are easy to get wrong:
    //
    //   `root`/`extname` — where a bare snippet name resolves to a file.
    //   `globals`        — `render` opens an ISOLATED scope in liquidjs, the
    //                      same as Shopify. Without this the snippet's
    //                      `routes.account_login_url` and `request.path`
    //                      silently render empty and the return-url assertion
    //                      below would pass against an empty string.
    //
    // Resolving for real (rather than inlining the snippet source into the
    // test) is the point: these tests exist to prove the SHIPPED markup, and
    // a hand-copied snippet body would stop tracking the file.
    const engine = new Liquid({
      root: [join(THEME_ROOT, "snippets")],
      extname: ".liquid",
      globals: sectionContext(customer),
    });
    // `t` and `inline_asset_content`, and every other filter this section
    // uses (`asset_url`, `stylesheet_tag`, `escape`, `url_encode`), are
    // deliberately left UNREGISTERED — liquidjs's documented behaviour for
    // an unknown filter is to pass the input through unchanged, so
    // `{{ 'x.y.z' | t }}` renders the LITERAL locale key. This proves
    // CONTROL FLOW (which branch, in which order), not translated copy —
    // the exact-string checks below (against `en.default.json`) prove the
    // words themselves, matching this repo's own R16 division of labour.
    return engine;
  }

  async function renderSection(customer: Record<string, unknown> | null): Promise<string> {
    const engine = createSectionEngine(customer);
    const source = readLiquid(SECTION);
    return engine.parseAndRender(source, sectionContext(customer));
  }

  it("GUARDS THE GUARD: the signed-in and signed-out renders are structurally different outputs, not a vacuous pass either fixture would satisfy", async () => {
    const signedIn = await renderSection(SIGNED_IN_CUSTOMER);
    const signedOut = await renderSection(null);
    expect(signedIn.length).toBeGreaterThan(0);
    expect(signedOut.length).toBeGreaterThan(0);
    expect(signedIn).not.toEqual(signedOut);
    expect(signedIn).toContain('id="WarrantyClaimForm"');
    expect(signedOut).not.toContain('id="WarrantyClaimForm"');
  });

  describe("signed in (a real `customer` object, exactly what Liquid gives an authenticated shopper)", () => {
    it("renders the real form, the order picker, and the hidden order/line-item inputs it fills — not the sign-in gate", async () => {
      const out = await renderSection(SIGNED_IN_CUSTOMER);
      expect(out).toContain('id="WarrantyClaimForm"');
      expect(out).toContain("data-carat-warranty-order-picker");
      expect(out).toContain('id="WarrantyClaimOrderNumber"');
      expect(out).toContain('name="order_id"');
      expect(out).toContain('name="line_item_id"');
      expect(out).toContain("data-carat-warranty-lookup-submit");
      expect(out).toContain("data-carat-warranty-acknowledgment");
      expect(out).not.toContain("data-carat-warranty-signin-required");
      expect(out).not.toContain("templates.warranty_claim.form.sign_in_required_heading");
    });

    it("the customer never sees a raw GID field — order_id/line_item_id are type=\"hidden\", not visible text inputs", async () => {
      const out = await renderSection(SIGNED_IN_CUSTOMER);
      expect(out).toMatch(/<input\s+type="hidden"\s+id="WarrantyClaimOrderId"\s+name="order_id"/);
      expect(out).toMatch(/<input\s+type="hidden"\s+id="WarrantyClaimLineItemId"\s+name="line_item_id"/);
    });

    it("prefills the purchaser fields from the real `customer` object, unchanged from before this task", async () => {
      const out = await renderSection(SIGNED_IN_CUSTOMER);
      expect(out).toContain('value="Jane Doe"');
      expect(out).toContain('value="jane@example.com"');
    });

    it("criterion 156 — the 'please don't send your item yet' notice still renders, unconditionally, ahead of the form", async () => {
      const out = await renderSection(SIGNED_IN_CUSTOMER);
      const noticeIndex = out.indexOf("carat-warranty-claim__notice");
      const formIndex = out.indexOf('id="WarrantyClaimForm"');
      expect(noticeIndex).toBeGreaterThan(-1);
      expect(formIndex).toBeGreaterThan(-1);
      expect(noticeIndex).toBeLessThan(formIndex);
    });
  });

  describe("signed out (`customer` is null, exactly what Liquid gives an anonymous visitor)", () => {
    it("renders the sign-in gate, not the form or the order picker — this is NEW behaviour with no coverage before this gate existed", async () => {
      const out = await renderSection(null);
      expect(out).toContain("data-carat-warranty-signin-required");
      expect(out).toContain("data-carat-warranty-signin-link");
      expect(out).not.toContain('id="WarrantyClaimForm"');
      expect(out).not.toContain("data-carat-warranty-order-picker");
      expect(out).not.toContain('id="WarrantyClaimOrderNumber"');
      expect(out).not.toContain('name="order_id"');
      expect(out).not.toContain('name="line_item_id"');
      expect(out).not.toContain("data-carat-warranty-acknowledgment");
    });

    it("the sign-in link returns the shopper to this exact page, not the account page", async () => {
      const out = await renderSection(null);
      expect(out).toContain('href="/account/login?return_url=%2Fpages%2Fwarranty-claim"');
    });

    it("criterion 156's notice STILL renders even though the form does not — the process disclosure is unconditional", async () => {
      const out = await renderSection(null);
      expect(out).toContain("carat-warranty-claim__notice");
    });

    it("renders a real heading element for the gate, not merely styled text", async () => {
      const out = await renderSection(null);
      expect(out).toMatch(/<h3[^>]*class="carat-warranty-claim__signin-heading"/);
    });
  });

  it("this test file's own claim about client-side gating is honest: the theme files under test never describe themselves as the enforcement", () => {
    // Same guard as bankPaymentCheckoutForm.test.ts's equivalent check — the
    // 401 in apps.carat.warranty-order-lookup.tsx/apps.carat.warranty-
    // claim.tsx is the actual enforcement; this section and its JS only
    // avoid walking a signed-out or GID-less customer into a submission
    // that cannot succeed.
    const sectionSource = readFileSync(join(THEME_ROOT, SECTION), "utf8");
    const jsSource = readFileSync(join(THEME_ROOT, "assets", "warranty-claim-form.js"), "utf8");
    for (const source of [sectionSource, jsSource]) {
      expect(source).not.toMatch(/gating (is|as) (the|an) enforcement/i);
      expect(source).not.toMatch(/this (protects|secures|authorizes)/i);
    }
  });
});

// -----------------------------------------------------------------------
// 3. Locale sanity — every new/renamed key this task introduced actually
//    resolves to a non-empty string, and the pinned sign-in sentence in
//    this namespace matches the one in ownerApprovedCopy.test.ts exactly.
// -----------------------------------------------------------------------

describe("templates.warranty_claim.form — new order-picker/sign-in locale keys resolve", () => {
  const KEYS = [
    "sign_in_required_heading",
    "sign_in_required_message",
    "order_lookup_legend",
    "order_number_label",
    "order_number_placeholder",
    "order_number_help",
    "find_order_button",
    "searching_order",
    "order_lookup_not_found",
    "order_result_found",
    "select_item_legend",
    "line_item_option_label",
    "search_different_order",
    "cant_find_order_help",
    "error_order_number_required",
    "error_order_id_required",
    "error_line_item_id_required",
  ];

  it.each(KEYS)("templates.warranty_claim.form.%s is a non-empty string", (key) => {
    const value = at(`templates.warranty_claim.form.${key}`);
    expect(typeof value, `templates.warranty_claim.form.${key} is missing`).toBe("string");
    expect((value as string).length).toBeGreaterThan(0);
  });

  it("the sign-in sentence is byte-for-byte the owner-approved sentence from docs/REQUIRED-CUSTOMER-ACCOUNTS.md §4", () => {
    expect(at("templates.warranty_claim.form.sign_in_required_message")).toBe(
      "Please sign in or create a CaratForUs account to continue."
    );
  });
});

/**
 * PHOTO UPLOADS — the parts observable without a DOM.
 *
 * The full selection -> destination -> PUT -> checksum chain needs real files
 * and a real bucket, and is live-proven end to end by
 * `tests/live/slice5.warrantyUploadFlow.ts` (10/10 against production). What
 * belongs here is the property that no live gate can easily demonstrate: that
 * a claim with NO photos is a complete claim, and that nothing about uploads
 * leaks into a submission that has none.
 */
describe("photo uploads are optional in a load-bearing way", () => {
  it("collects nothing before any file is chosen", () => {
    const form = loadWarrantyClaimForm();
    expect(form._internal.collectUploads()).toEqual([]);
  });

  it("mints a claim id that is stable for the page", () => {
    // Stability matters: every destination request for one claim must carry
    // the SAME id, or each upload would be bound to a different claim and
    // none of them would verify at submission.
    const form = loadWarrantyClaimForm();
    const first = form._internal.claimIdForUploads();
    const second = form._internal.claimIdForUploads();
    expect(first).toBe(second);
  });

  it("mints a v4-shaped UUID, because the server validates the shape", () => {
    // `apps.carat.warranty-claim-upload-destination.tsx` requires
    // `z.string().uuid()`; a malformed id is refused with 400 before anything
    // is issued, so a bad generator would break uploads entirely.
    const form = loadWarrantyClaimForm();
    expect(form._internal.claimIdForUploads()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
    );
  });

  it("gives a different id to a different page load", () => {
    // A shared id across two claims would make the second submission collide
    // on the primary key and fail — the safe direction, but still broken.
    const a = loadWarrantyClaimForm()._internal.claimIdForUploads();
    const b = loadWarrantyClaimForm()._internal.claimIdForUploads();
    expect(a).not.toBe(b);
  });
});
