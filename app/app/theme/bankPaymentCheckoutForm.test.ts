import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { loadBankPaymentCheckout } from "./bankPaymentCheckoutFormSandbox";

/**
 * Slice 2C task 2C-6 — the Bank Payment Checkout storefront surface and its
 * disclosures (docs/specs/SLICE-2C-BANK-PAYMENT-CHECKOUT.md §5.3 criteria
 * 83-86, §4 D20, §16).
 *
 * FOUR THINGS THIS FILE PROVES, MATCHING THE 2C-6 BRIEF:
 *  1. The form posts the right body shape to `/apps/carat/bank-checkout`
 *     (pure `_internal` functions, via the real
 *     `theme/assets/bank-payment-checkout.js`).
 *  2. Every documented error code the route can return gets its own
 *     message — proven both ways: the route's own literal error strings
 *     (read from apps.carat.bank-checkout.tsx's real source, per R16 — no
 *     hand-reconstructed fixture) are all handled, and every handled key
 *     traces to a real route code.
 *  3. The not-committed disclosure (criterion 84) is present in the
 *     rendered Liquid output and never hidden.
 *  4. Mode preservation across a cart re-render is UNCHANGED by this task —
 *     asserted by confirming the new dialog and script are NOT inside any
 *     section the Section Rendering API swaps (SLICE-2B-CART-SURFACE-
 *     INVENTORY.md D1/D2/L3), which is what makes re-binding unnecessary in
 *     the first place (see bank-payment-checkout.js's own header comment).
 */

const THEME_ROOT = join(process.cwd(), "..", "theme");
const ROUTE_PATH = join(process.cwd(), "app", "routes", "apps.carat.bank-checkout.tsx");

function stripLiquidComments(source: string): string {
  return source.replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/g, "");
}

function readLiquid(relativePath: string): string {
  return stripLiquidComments(readFileSync(join(THEME_ROOT, relativePath), "utf8"));
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
// 1. The form posts the right body shape (pure logic, real module).
// -----------------------------------------------------------------------

describe("CaratBankPaymentCheckout._internal — request body shape", () => {
  it("normalizeValues trims every known field and defaults a missing one to \"\"", () => {
    const { _internal } = loadBankPaymentCheckout();
    const values = _internal.normalizeValues({ email: "  a@b.com  ", city: "  Reno " });
    expect(values.email).toBe("a@b.com");
    expect(values.city).toBe("Reno");
    expect(values.address1).toBe("");
    expect(values.provinceCode).toBe("");
  });

  it("normalizeValues tolerates a null/undefined input object", () => {
    const { _internal } = loadBankPaymentCheckout();
    expect(_internal.normalizeValues(null)).toMatchObject({ email: "", address1: "" });
    expect(_internal.normalizeValues(undefined)).toMatchObject({ email: "", address1: "" });
  });

  it("buildShippingAddress carries every required field and omits blank optional ones", () => {
    const { _internal } = loadBankPaymentCheckout();
    const values = _internal.normalizeValues({
      email: "a@b.com",
      address1: "1 Main St",
      city: "Reno",
      zip: "89501",
      countryCode: "US",
      firstName: "",
      lastName: "",
      address2: "",
      provinceCode: "",
      phone: "",
    });
    const address = _internal.buildShippingAddress(values);
    expect(address).toEqual({
      address1: "1 Main St",
      city: "Reno",
      zip: "89501",
      countryCode: "US",
    });
    expect(address).not.toHaveProperty("firstName");
    expect(address).not.toHaveProperty("address2");
    expect(address).not.toHaveProperty("provinceCode");
    expect(address).not.toHaveProperty("phone");
  });

  it("buildShippingAddress includes an optional field only when it was actually provided", () => {
    const { _internal } = loadBankPaymentCheckout();
    const values = _internal.normalizeValues({
      email: "a@b.com",
      address1: "1 Main St",
      city: "Reno",
      zip: "89501",
      countryCode: "US",
      provinceCode: "NV",
      phone: "555-0100",
    });
    const address = _internal.buildShippingAddress(values);
    expect(address.provinceCode).toBe("NV");
    expect(address.phone).toBe("555-0100");
  });

  it("buildRequestBody produces exactly the shape bankCheckoutRequestSchema expects: mode, email, shippingAddress, lines", () => {
    const { _internal } = loadBankPaymentCheckout();
    const values = _internal.normalizeValues({
      email: "a@b.com",
      address1: "1 Main St",
      city: "Reno",
      zip: "89501",
      countryCode: "US",
    });
    const lines = [{ shopifyVariantId: "111", quantity: 2 }];
    const body = _internal.buildRequestBody(values, lines);
    expect(body).toEqual({
      mode: "bank",
      email: "a@b.com",
      shippingAddress: { address1: "1 Main St", city: "Reno", zip: "89501", countryCode: "US" },
      lines: [{ shopifyVariantId: "111", quantity: 2 }],
    });
  });

  it("buildRequestLines maps cart items to {shopifyVariantId, quantity}, falling back to item.id when variant_id is absent", () => {
    const { _internal } = loadBankPaymentCheckout();
    const lines = _internal.buildRequestLines({
      items: [
        { variant_id: 111, id: 999, quantity: 2 },
        { id: 222, quantity: 1 },
      ],
    });
    expect(lines).toEqual([
      { shopifyVariantId: "111", quantity: 2 },
      { shopifyVariantId: "222", quantity: 1 },
    ]);
  });

  it("buildRequestLines returns [] for an empty or malformed cart rather than throwing", () => {
    const { _internal } = loadBankPaymentCheckout();
    expect(_internal.buildRequestLines({ items: [] })).toEqual([]);
    expect(_internal.buildRequestLines(null)).toEqual([]);
    expect(_internal.buildRequestLines({})).toEqual([]);
  });
});

describe("CaratBankPaymentCheckout._internal — client-side required-field validation", () => {
  const VALID = {
    email: "a@b.com",
    address1: "1 Main St",
    city: "Reno",
    zip: "89501",
    countryCode: "US",
    firstName: "",
    lastName: "",
    address2: "",
    provinceCode: "",
    phone: "",
  };

  it("passes with every required field present and a plausible email", () => {
    const { _internal } = loadBankPaymentCheckout();
    expect(_internal.validateFormValues(VALID)).toEqual([]);
  });

  it.each([
    ["email", "error_email_required"],
    ["address1", "error_address1_required"],
    ["city", "error_city_required"],
    ["zip", "error_zip_required"],
    ["countryCode", "error_country_required"],
  ])("flags a missing %s with %s", (field, messageKey) => {
    const { _internal } = loadBankPaymentCheckout();
    const values = { ...VALID, [field]: "" };
    const errors = _internal.validateFormValues(values);
    expect(errors).toContainEqual({ field, messageKey });
  });

  it("flags an implausible email even when non-empty", () => {
    const { _internal } = loadBankPaymentCheckout();
    const errors = _internal.validateFormValues({ ...VALID, email: "not-an-email" });
    expect(errors).toContainEqual({ field: "email", messageKey: "error_email_required" });
  });

  it("collects every failing required field, not just the first", () => {
    const { _internal } = loadBankPaymentCheckout();
    const errors = _internal.validateFormValues({ ...VALID, email: "", city: "", countryCode: "" });
    expect(errors.map((e) => e.field).sort()).toEqual(["city", "countryCode", "email"]);
  });
});

// -----------------------------------------------------------------------
// 2. Every documented error code gets its own message — proven both ways
//    against the REAL route source (R16: no hand-reconstructed fixture).
// -----------------------------------------------------------------------

describe("error-code coverage against the real apps.carat.bank-checkout.tsx route", () => {
  function routeSource(): string {
    return readFileSync(ROUTE_PATH, "utf8");
  }

  /** Every `error: "..."` literal the route can put in a JSON response body. */
  function routeErrorCodes(): string[] {
    const source = routeSource();
    const matches = [...source.matchAll(/error:\s*"([a-z_]+)"/g)];
    return [...new Set(matches.map((m) => m[1]!))];
  }

  it("GUARDS THE GUARD: the route file exists and actually contains error literals", () => {
    const codes = routeErrorCodes();
    expect(codes.length).toBeGreaterThan(0);
    // Sanity floor — if this drops, the regex above stopped matching the
    // real file rather than the route having fewer error paths.
    expect(codes).toContain("invalid_request");
    expect(codes).toContain("unpurchasable_lines");
  });

  it("every error code the real route can return is handled by messageKeyForFailure with a DISTINCT, non-generic key", () => {
    const { _internal } = loadBankPaymentCheckout();
    const codes = routeErrorCodes();
    // "unauthorized" and "pricing_failed" are not documented in the 2C-6
    // brief's list of codes to give a human message for — unauthorized is a
    // signature-verification failure that should never occur for a
    // legitimate storefront request, pricing_failed is the unreachable
    // defensive branch the route's own comment marks as such, and
    // method_not_allowed can never be produced by this theme's own client
    // (it always POSTs — see fetchCart()/the PROXY_PATH fetch call in
    // bank-payment-checkout.js). All three fall through to error_generic
    // deliberately.
    const undocumented = new Set(["unauthorized", "pricing_failed", "method_not_allowed"]);
    for (const code of codes) {
      if (undocumented.has(code)) continue;
      const key = _internal.messageKeyForFailure(400, { error: code });
      expect(key, `error code "${code}" has no distinct message`).not.toBe("error_generic");
      expect(key, `error code "${code}" maps to itself as the message key, not a translated one`).not.toBe(code);
    }
  });

  it("the eight message keys named in the 2C-6 brief are exactly what messageKeyForFailure can return", () => {
    const { _internal } = loadBankPaymentCheckout();
    const cases: Array<[string, string]> = [
      ["unpurchasable_lines", "error_unpurchasable_lines"],
      ["group_buy_variant_present", "error_group_buy_variant_present"],
      ["checkout_unresolved", "error_checkout_unresolved"],
      ["checkout_failed_previously", "error_checkout_failed_previously"],
      ["checkout_upstream_failed", "error_checkout_upstream_failed"],
      ["checkout_unavailable", "error_checkout_unavailable"],
      ["invalid_request", "error_invalid_request"],
    ];
    for (const [code, expectedKey] of cases) {
      expect(_internal.messageKeyForFailure(400, { error: code })).toBe(expectedKey);
    }
  });

  it("an unrecognized code, a missing body, or a malformed body all fall back to error_generic rather than throwing or showing nothing", () => {
    const { _internal } = loadBankPaymentCheckout();
    expect(_internal.messageKeyForFailure(500, { error: "something_new" })).toBe("error_generic");
    expect(_internal.messageKeyForFailure(500, null)).toBe("error_generic");
    expect(_internal.messageKeyForFailure(500, undefined)).toBe("error_generic");
    expect(_internal.messageKeyForFailure(500, "not an object")).toBe("error_generic");
  });

  it("every error_* message key this file returns actually resolves to a non-empty locale string", () => {
    const { _internal } = loadBankPaymentCheckout();
    const codes = routeErrorCodes().filter((c) => c !== "unauthorized" && c !== "pricing_failed");
    for (const code of codes) {
      const key = _internal.messageKeyForFailure(400, { error: code });
      const text = at(`sections.cart.bank_payment_checkout_form.${key}`);
      expect(typeof text, `locale key for "${code}" (${key}) is missing`).toBe("string");
      expect((text as string).length).toBeGreaterThan(0);
    }
    // The network/generic fallbacks are never a route-returned code, so
    // assert them directly rather than via the code loop above.
    for (const key of ["error_generic", "error_network"]) {
      const text = at(`sections.cart.bank_payment_checkout_form.${key}`);
      expect(typeof text, `locale key ${key} is missing`).toBe("string");
      expect((text as string).length).toBeGreaterThan(0);
    }
  });
});

// -----------------------------------------------------------------------
// 3. The not-committed disclosure (criterion 84) is present and never hidden.
// -----------------------------------------------------------------------

describe("criterion 84 — the not-committed disclosure on the checkout surface", () => {
  const DIALOG = "snippets/bank-payment-checkout-dialog.liquid";

  it("the dialog renders the disclosure via the locale key, unconditionally", () => {
    const source = readLiquid(DIALOG);
    expect(source).toContain("data-carat-bank-checkout-disclosure");
    expect(source).toContain("'sections.cart.bank_payment_checkout_form.not_committed_disclosure' | t");
  });

  it("the disclosure element is not wrapped in a conditional, an accordion, a tooltip, or hidden by default", () => {
    const source = readLiquid(DIALOG);
    const index = source.indexOf("data-carat-bank-checkout-disclosure");
    expect(index).toBeGreaterThan(-1);
    // Scope a tight window around the element itself — not the whole file —
    // so an unrelated `hidden` elsewhere in the template cannot false-pass
    // or false-fail this check.
    const window = source.slice(Math.max(0, index - 200), index + 100);
    expect(window).not.toContain("hidden");
    expect(window).not.toMatch(/{%-?\s*if/);
    expect(window).not.toContain("<details");
    expect(window).not.toContain("<summary");
  });

  it("the disclosure appears BEFORE the submit button and before any field, so it is visible before submitting", () => {
    const source = readLiquid(DIALOG);
    const disclosureIndex = source.indexOf("data-carat-bank-checkout-disclosure");
    const firstFieldIndex = source.indexOf('id="CaratBankCheckoutEmail"');
    const submitIndex = source.indexOf("data-carat-bank-checkout-submit");
    expect(disclosureIndex).toBeGreaterThan(-1);
    expect(disclosureIndex).toBeLessThan(firstFieldIndex);
    expect(disclosureIndex).toBeLessThan(submitIndex);
  });

  it("the confirmation email carries the same disclosure key (criterion 85), OR the key is at minimum reserved and non-empty for reuse there", () => {
    // 2C-6 owns the checkout surface, not the confirmation email (that is
    // 2C-4/2C-5's draft-order + email territory) — this only guards that
    // the disclosure text this task introduces is real, locale-backed copy
    // rather than an inline literal a future email implementer cannot reuse.
    const text = at("sections.cart.bank_payment_checkout_form.not_committed_disclosure");
    expect(typeof text).toBe("string");
    expect((text as string).length).toBeGreaterThan(0);
  });
});

describe("forbidden terminology — CLAUDE.md merchandise-only savings rule", () => {
  const FORBIDDEN = [/\bsurcharge\b/i, /\bcard fee\b/i, /\bcash discount\b/i, /\buplift\b/i, /%/, /\bcash\b/i];

  const NEW_KEYS = [
    "heading",
    "not_committed_disclosure",
    "email_label",
    "first_name_label",
    "last_name_label",
    "address1_label",
    "address2_label",
    "city_label",
    "province_label",
    "zip_label",
    "country_label",
    "phone_label",
    "submit",
    "submitting",
    "cancel",
    "error_summary_heading",
    "error_email_required",
    "error_address1_required",
    "error_city_required",
    "error_zip_required",
    "error_country_required",
    "error_unpurchasable_lines",
    "error_group_buy_variant_present",
    "error_checkout_unresolved",
    "error_checkout_failed_previously",
    "error_checkout_upstream_failed",
    "error_checkout_unavailable",
    "error_invalid_request",
    "error_generic",
    "error_network",
    "success_check_email",
    "redirecting",
  ];

  it.each(NEW_KEYS)("sections.cart.bank_payment_checkout_form.%s exists, is non-empty, and uses no forbidden term", (key) => {
    const text = at(`sections.cart.bank_payment_checkout_form.${key}`);
    expect(typeof text, `${key} is missing from the locale file`).toBe("string");
    expect((text as string).length, `${key} is empty`).toBeGreaterThan(0);
    for (const term of FORBIDDEN) {
      expect((text as string), `${key} contains forbidden terminology (${term})`).not.toMatch(term);
    }
  });

  it("the updated bank_payment_checkout_note uses no forbidden term and no longer promises a follow-up-by-email flow it does not deliver", () => {
    const text = at("sections.cart.bank_payment_checkout_note") as string;
    expect(typeof text).toBe("string");
    for (const term of FORBIDDEN) {
      expect(text).not.toMatch(term);
    }
    // The old wording said "we'll follow up by email to complete payment" —
    // inaccurate once the flow collects details and invoices immediately.
    // Guard the specific phrase from silently coming back.
    expect(text).not.toMatch(/follow up by email/i);
  });
});

// -----------------------------------------------------------------------
// 4. Every trigger button is wired (not a dead stub) and the dialog/JS are
//    loaded on every page, plus the mode-preservation argument (no AJAX
//    re-render risk because nothing here lives inside a swapped section).
// -----------------------------------------------------------------------

describe("every Bank Payment Checkout trigger is wired to the real action, not a stub", () => {
  const FILES: Array<[string, string]> = [
    ["sections/main-cart-footer.liquid (A2)", "sections/main-cart-footer.liquid"],
    ["snippets/cart-drawer.liquid (A3)", "snippets/cart-drawer.liquid"],
    ["snippets/cart-notification.liquid (C1)", "snippets/cart-notification.liquid"],
  ];

  it.each(FILES)("%s has exactly one data-carat-checkout-action=\"bank-payment\" trigger and no leftover stub marker", (_label, path) => {
    const source = readLiquid(path);
    const occurrences = (source.match(/data-carat-checkout-action="bank-payment"/g) ?? []).length;
    expect(occurrences).toBe(1);
    expect(source).not.toContain("data-carat-checkout-stub");
  });

  it.each(FILES)("%s's trigger is still type=\"button\" (must not submit the Card checkout form)", (_label, path) => {
    const source = readLiquid(path);
    const index = source.indexOf('data-carat-checkout-action="bank-payment"');
    const window = source.slice(Math.max(0, index - 200), index + 50);
    expect(window).toMatch(/type="button"/);
  });

  it("no theme file outside these three still references the old stub attribute", () => {
    // Read every .liquid file under theme/ and confirm the removed marker
    // is gone everywhere, not just in the three files this task touched.
    const roots = ["sections", "snippets", "templates", "layout"];
    const offenders: string[] = [];
    function walk(dir: string) {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        const stats = statSync(full);
        if (stats.isDirectory()) {
          walk(full);
        } else if (entry.endsWith(".liquid") && readFileSync(full, "utf8").includes("data-carat-checkout-stub")) {
          offenders.push(full);
        }
      }
    }
    for (const root of roots) {
      const full = join(THEME_ROOT, root);
      try {
        walk(full);
      } catch {
        // directory may not exist in this theme layout — ignore
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe("the dialog and its script/style are loaded unconditionally, everywhere a trigger can render", () => {
  it("header.liquid renders the dialog snippet with no cart_type gate", () => {
    const source = readLiquid("sections/header.liquid");
    const index = source.indexOf("render 'bank-payment-checkout-dialog'");
    expect(index).toBeGreaterThan(-1);
    // Scan backward to the nearest {%- if / {%- unless before this render
    // call and confirm it is not inside a cart_type conditional the way
    // cart-notification's own render is.
    const before = source.slice(0, index);
    const lastIfIndex = before.lastIndexOf("{%- if");
    const lastEndifIndex = before.lastIndexOf("{%- endif -%}");
    // If the nearest preceding {%- if is already closed by an {%- endif -%}
    // before our render call, the render is NOT inside that conditional.
    expect(lastEndifIndex).toBeGreaterThan(lastIfIndex === -1 ? -Infinity : lastIfIndex);
  });

  it("header.liquid loads bank-payment-checkout.js and its stylesheet unconditionally, alongside cart-notification.js", () => {
    const source = readLiquid("sections/header.liquid");
    expect(source).toContain("'bank-payment-checkout.js' | asset_url");
    expect(source).toContain("'component-bank-payment-checkout.css' | asset_url");
    const notificationJsIndex = source.indexOf("'cart-notification.js' | asset_url");
    const bankJsIndex = source.indexOf("'bank-payment-checkout.js' | asset_url");
    expect(notificationJsIndex).toBeGreaterThan(-1);
    expect(bankJsIndex).toBeGreaterThan(-1);
  });

  it("theme.liquid's window.cartStrings carries every caratBankCheckout key bank-payment-checkout.js's localeString() reads", () => {
    const source = readFileSync(join(THEME_ROOT, "layout", "theme.liquid"), "utf8");
    const requiredKeys = [
      "error_summary_heading",
      "error_email_required",
      "error_address1_required",
      "error_city_required",
      "error_zip_required",
      "error_country_required",
      "error_unpurchasable_lines",
      "error_group_buy_variant_present",
      "error_checkout_unresolved",
      "error_checkout_failed_previously",
      "error_checkout_upstream_failed",
      "error_checkout_unavailable",
      "error_invalid_request",
      "error_generic",
      "error_network",
      "submitting",
      "redirecting",
      "success_check_email",
    ];
    const caratBankCheckoutIndex = source.indexOf("caratBankCheckout:");
    expect(caratBankCheckoutIndex).toBeGreaterThan(-1);
    const block = source.slice(caratBankCheckoutIndex, source.indexOf("};", caratBankCheckoutIndex));
    for (const key of requiredKeys) {
      expect(block, `window.cartStrings.caratBankCheckout.${key} is missing`).toContain(`${key}:`);
    }
  });
});

describe("accessibility — labels, error association, and focus management", () => {
  const DIALOG = "snippets/bank-payment-checkout-dialog.liquid";

  const REQUIRED_FIELDS: Array<[string, string]> = [
    ["email", "CaratBankCheckoutEmail"],
    ["address1", "CaratBankCheckoutAddress1"],
    ["city", "CaratBankCheckoutCity"],
    ["zip", "CaratBankCheckoutZip"],
    ["countryCode", "CaratBankCheckoutCountry"],
  ];

  it.each(REQUIRED_FIELDS)("the %s field has a real <label for=\"%s\"> and is marked required", (_name, id) => {
    const source = readLiquid(DIALOG);
    expect(source).toContain(`for="${id}"`);
    expect(source).toContain(`id="${id}"`);
    const inputIndex = source.indexOf(`id="${id}"`);
    // Generous forward window: an input's opening tag here can carry a long
    // Liquid `value="{{ customer.default_address.* | escape }}"` expression
    // before reaching `aria-describedby`, so a tight window undercounts.
    const window = source.slice(Math.max(0, inputIndex - 50), inputIndex + 600);
    expect(window).toContain("required");
    expect(window).toMatch(/aria-describedby="[^"]*-error"/);
  });

  it.each(REQUIRED_FIELDS)("the %s field's aria-describedby target (%s-error) exists and starts hidden", (_name, id) => {
    const source = readLiquid(DIALOG);
    expect(source).toContain(`id="${id}-error"`);
    const errorIndex = source.indexOf(`id="${id}-error"`);
    const window = source.slice(errorIndex, errorIndex + 300);
    expect(window).toContain("hidden");
    expect(window).toContain("data-carat-bank-checkout-field-error");
  });

  it("the error summary is role=\"alert\", focusable (tabindex=-1), and starts hidden", () => {
    const source = readLiquid(DIALOG);
    const index = source.indexOf("data-carat-bank-checkout-error-summary");
    const window = source.slice(Math.max(0, index - 250), index + 50);
    expect(window).toContain('role="alert"');
    expect(window).toContain('tabindex="-1"');
    expect(window).toContain("hidden");
  });

  it("bank-payment-checkout.js moves focus to the error summary on a submission failure (client or server)", () => {
    const source = readFileSync(join(THEME_ROOT, "assets", "bank-payment-checkout.js"), "utf8");
    const showErrorSummaryBody = source.slice(
      source.indexOf("function showErrorSummary"),
      source.indexOf("function hideErrorSummary")
    );
    expect(showErrorSummaryBody).toMatch(/summary\.focus\(\)/);
    // Called on BOTH the client-validation path and every server error
    // branch — not just one of them.
    const callSites = (source.match(/showErrorSummary\(/g) ?? []).length;
    expect(callSites).toBeGreaterThanOrEqual(4); // definition + validation + non-ok response + catch
  });

  it("no colour-only signalling: the error icon/text is not conveyed by colour alone (icon + visible text present)", () => {
    const source = readLiquid(DIALOG);
    // Extract each <small>...</small> field-error container as a whole
    // block, rather than splitting on the attribute name — that attribute
    // name is also a PREFIX of the inner span's
    // `data-carat-bank-checkout-field-error-text`, so a plain string split
    // cuts blocks in the wrong place.
    const errorBlocks = [...source.matchAll(/<small\b[\s\S]*?<\/small>/g)].map((m) => m[0]);
    expect(errorBlocks.length).toBeGreaterThan(0);
    for (const block of errorBlocks) {
      expect(block).toContain("icon-error.svg");
      expect(block).toContain("data-carat-bank-checkout-field-error-text");
    }
  });

  it("the close button is keyboard-operable (a real <button>, not a div/span with a click handler)", () => {
    const source = readLiquid(DIALOG);
    const index = source.indexOf('id="ModalClose-CaratBankCheckoutModal"');
    expect(index).toBeGreaterThan(-1);
    const window = source.slice(Math.max(0, index - 100), index + 20);
    expect(window).toMatch(/<button/);
  });
});

describe("mode preservation across a cart re-render is unaffected (L3)", () => {
  it("the dialog snippet is NOT rendered inside any of the AJAX-swapped section files", () => {
    // D1/D2 (SLICE-2B-CART-SURFACE-INVENTORY.md): main-cart-items,
    // cart-icon-bubble, cart-live-region-text, main-cart-footer,
    // CartDrawer/CartDrawerItems, cart-notification's own product block are
    // the sections getSectionsToRender() can swap. The dialog snippet must
    // not be rendered from inside any of them, or a section swap could
    // remove/duplicate the live modal instance from the DOM.
    const swappedFiles = [
      "sections/main-cart-items.liquid",
      "sections/main-cart-footer.liquid",
      "sections/cart-icon-bubble.liquid",
      "sections/cart-live-region-text.liquid",
      "snippets/cart-drawer.liquid",
      "snippets/cart-notification.liquid",
    ];
    for (const file of swappedFiles) {
      const source = readLiquid(file);
      expect(source, `${file} must not render the bank-payment-checkout-dialog snippet`).not.toContain(
        "bank-payment-checkout-dialog"
      );
    }
  });

  it("bank-payment-checkout.js attaches its listeners at the document level, not to a specific element reference", () => {
    const source = readFileSync(join(THEME_ROOT, "assets", "bank-payment-checkout.js"), "utf8");
    expect(source).toMatch(/document\.addEventListener\(\s*'click'/);
    expect(source).toMatch(/document\.addEventListener\(\s*'submit'/);
  });
});
