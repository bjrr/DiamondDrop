import { readFileSync } from "node:fs";
import { join } from "node:path";

import { Liquid, type TagToken } from "liquidjs";
import { describe, expect, it } from "vitest";

import { loadGroupBuyCampaign, type GroupBuyVariant } from "./groupBuyCampaignSandbox";

/**
 * The Group Buy campaign storefront page
 * (sections/group-buy-campaign.liquid + assets/group-buy-campaign.js).
 *
 * MATCHES THE warrantyClaimForm.test.ts / bankPaymentCheckoutForm.test.ts
 * STANDARD:
 *  1. Pure `_internal` logic (the real module, via `groupBuyCampaignSandbox`)
 *     — the single-active-price switch, native Shopify variant matching, the
 *     campaign-options table-column selection, and the order-action gate —
 *     tested directly rather than only inferred from markup.
 *  2. THE ACCOUNT-REQUIRED GATE (docs/REQUIRED-CUSTOMER-ACCOUNTS.md §4)
 *     actually changes what renders for a signed-out customer, proven by
 *     rendering the REAL Liquid with `liquidjs` against signed-in/signed-out
 *     fixtures and diffing the OUTPUT — a source scan proves a tag is
 *     WRITTEN, not which branch a customer actually sees.
 *  3. The public comparison table/progress area render identically
 *     regardless of sign-in state (browsing is not gated) — only the order
 *     action differs.
 *  4. No forbidden Bank/Card terminology anywhere in the new section, JS, or
 *     locale keys this task introduced.
 */

const THEME_ROOT = join(process.cwd(), "..", "theme");
const SECTION = "sections/group-buy-campaign.liquid";

function stripLiquidComments(source: string): string {
  return source.replace(/{%-?\s*comment\s*-?%}[\s\S]*?{%-?\s*endcomment\s*-?%}/g, "");
}

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

/** Forbidden per CLAUDE.md rule 13 / docs/BANK-CARD-PRICING.md §6. */
const FORBIDDEN_TERMS = [/cash discount/i, /cash price/i, /card fee/i, /credit card fee/i, /surcharge/i, /\bcash\b/i];

// ---------------------------------------------------------------------------
// 1. Pure logic
// ---------------------------------------------------------------------------

describe("CaratGroupBuyCampaign._internal — pure logic", () => {
  it("activePriceMinorUnits reads the Regular/Card figure for 'card' and the Bank Payment figure for 'bank' — never both at once", () => {
    const { _internal } = loadGroupBuyCampaign();
    const data = {
      groupBuyRegularCardPriceMinorUnits: "226000",
      groupBuyBankPaymentPriceMinorUnits: "214900",
    };
    expect(_internal.activePriceMinorUnits(data, "card")).toBe("226000");
    expect(_internal.activePriceMinorUnits(data, "bank")).toBe("214900");
  });

  it("formatMoney never uses a float divide and pads sub-dollar minor units correctly", () => {
    const { _internal } = loadGroupBuyCampaign();
    expect(_internal.formatMoney("5", "${{amount}}")).toBe("$0.05");
    expect(_internal.formatMoney("226000", "${{amount}}")).toBe("$2,260.00");
  });

  it("firstAvailableOrFirstVariant prefers an available variant, matching Shopify's own selected_or_first_available_variant", () => {
    const { _internal } = loadGroupBuyCampaign();
    const variants: GroupBuyVariant[] = [
      { id: 1, option1: "14K", available: false },
      { id: 2, option1: "18K", available: true },
    ];
    expect(_internal.firstAvailableOrFirstVariant(variants)?.id).toBe(2);
  });

  it("firstAvailableOrFirstVariant falls back to the first variant when none are available", () => {
    const { _internal } = loadGroupBuyCampaign();
    const variants: GroupBuyVariant[] = [
      { id: 1, option1: "14K", available: false },
      { id: 2, option1: "18K", available: false },
    ];
    expect(_internal.firstAvailableOrFirstVariant(variants)?.id).toBe(1);
  });

  it("firstAvailableOrFirstVariant returns null for an empty/missing variant list", () => {
    const { _internal } = loadGroupBuyCampaign();
    expect(_internal.firstAvailableOrFirstVariant([])).toBeNull();
  });

  describe("resolveVariantForOptionValues — native Shopify option1/option2/option3 matching", () => {
    const variants: GroupBuyVariant[] = [
      { id: 101, option1: "14K", option2: "6" },
      { id: 102, option1: "18K", option2: "6" },
      { id: 103, option1: "18K", option2: "7" },
    ];

    it("finds the exact matching variant", () => {
      const { _internal } = loadGroupBuyCampaign();
      expect(_internal.resolveVariantForOptionValues(variants, ["18K", "7"])?.id).toBe(103);
    });

    it("returns null when no variant matches the full combination", () => {
      const { _internal } = loadGroupBuyCampaign();
      expect(_internal.resolveVariantForOptionValues(variants, ["14K", "7"])).toBeNull();
    });

    it("never invents a match from a partial/empty selection", () => {
      const { _internal } = loadGroupBuyCampaign();
      // An empty selectedValues array matches by vacuous truth on every
      // variant's zero compared positions -- the caller (onOptionSelectChange)
      // always supplies one value per real product option, so this documents
      // the boundary rather than exercising a realistic input.
      expect(_internal.resolveVariantForOptionValues([], ["14K"])).toBeNull();
    });
  });

  describe("parseCampaignOptionsJson — defensive shape check, never throws", () => {
    it("accepts a well-formed schemaVersion 1 payload", () => {
      const { _internal } = loadGroupBuyCampaign();
      const raw = JSON.stringify({
        schemaVersion: 1,
        campaign: { productType: "ring" },
        optionDimensions: [],
        validCombinations: [],
        tableView: { columns: ["Metal", "Ring Size"] },
        orderingFlow: { steps: ["Metal", "Ring Size"] },
      });
      expect(_internal.parseCampaignOptionsJson(raw)).not.toBeNull();
    });

    it.each([
      ["null input", null],
      ["empty string", ""],
      ["malformed JSON", "{not json"],
      ["a bare string literal", JSON.stringify("hello")],
      ["an unknown schema version", JSON.stringify({ schemaVersion: 2, tableView: { columns: [] } })],
      ["missing tableView entirely", JSON.stringify({ schemaVersion: 1 })],
      ["tableView.columns not an array", JSON.stringify({ schemaVersion: 1, tableView: { columns: "Metal" } })],
      // The forbidden-pricing-key sweep itself lives server-side in
      // campaignOptions.ts (app/app/domain/groupbuy) and is out of scope for
      // a storefront asset -- but a payload smuggling one is still shaped
      // like valid JSON, so this documents that this lightweight client-side
      // parse does not attempt that check; it only prevents a malformed blob
      // from crashing table rendering.
    ])("returns null for %s rather than throwing", (_label, raw) => {
      const { _internal } = loadGroupBuyCampaign();
      expect(_internal.parseCampaignOptionsJson(raw as string | null)).toBeNull();
    });
  });

  it("buildTableHeaderLabels produces exactly ONE price column, never a second Bank Payment column (owner §10)", () => {
    const { _internal } = loadGroupBuyCampaign();
    const headers = _internal.buildTableHeaderLabels(["Metal", "Ring Size"]);
    const priceHeaders = headers.filter((label) => /Price/i.test(label));
    expect(priceHeaders).toEqual(["Group Buy Price"]);
    expect(headers.some((label) => /Bank Payment/i.test(label))).toBe(false);
  });

  describe("buildTableColumns — always a subset of the product's OWN option names", () => {
    it("uses the JSON's column order when every named column matches a real product option", () => {
      const { _internal } = loadGroupBuyCampaign();
      const columns = _internal.buildTableColumns(["Metal", "Ring Size", "Stone Size"], {
        tableView: { columns: ["Stone Size", "Metal"] },
      });
      expect(columns).toEqual(["Stone Size", "Metal"]);
    });

    it("matches case-insensitively", () => {
      const { _internal } = loadGroupBuyCampaign();
      const columns = _internal.buildTableColumns(["Metal", "Ring Size"], { tableView: { columns: ["metal"] } });
      expect(columns).toEqual(["Metal"]);
    });

    it("never invents a column absent from the real product options", () => {
      const { _internal } = loadGroupBuyCampaign();
      const columns = _internal.buildTableColumns(["Metal", "Ring Size"], {
        tableView: { columns: ["Clasp Style"] },
      });
      // "Clasp Style" matches nothing on this product -- falls back to every
      // real option rather than rendering an empty or fabricated column.
      expect(columns).toEqual(["Metal", "Ring Size"]);
    });

    it("falls back to every product option, in the product's own order, when no campaign-options JSON is supplied", () => {
      const { _internal } = loadGroupBuyCampaign();
      expect(_internal.buildTableColumns(["Metal", "Ring Size"], null)).toEqual(["Metal", "Ring Size"]);
    });
  });

  describe("canSubmitOrder — the required-Payment-Type + sign-in + availability + acknowledgment gate", () => {
    const availableVariant: GroupBuyVariant = { id: 1, available: true };
    const soldOutVariant: GroupBuyVariant = { id: 2, available: false };

    it("allows Card or Bank Payment once a variant is resolved, available, signed in, and acknowledged", () => {
      const { _internal } = loadGroupBuyCampaign();
      expect(
        _internal.canSubmitOrder({ variant: availableVariant, paymentType: "card", signedIn: true, acknowledged: true })
      ).toBe(true);
      expect(
        _internal.canSubmitOrder({ variant: availableVariant, paymentType: "bank", signedIn: true, acknowledged: true })
      ).toBe(true);
    });

    it("refuses without a resolved variant", () => {
      const { _internal } = loadGroupBuyCampaign();
      expect(
        _internal.canSubmitOrder({ variant: null, paymentType: "card", signedIn: true, acknowledged: true })
      ).toBe(false);
    });

    it("refuses a sold-out variant", () => {
      const { _internal } = loadGroupBuyCampaign();
      expect(
        _internal.canSubmitOrder({ variant: soldOutVariant, paymentType: "card", signedIn: true, acknowledged: true })
      ).toBe(false);
    });

    it("refuses without a Payment Type selection — required before ordering (README/owner §9)", () => {
      const { _internal } = loadGroupBuyCampaign();
      expect(
        _internal.canSubmitOrder({ variant: availableVariant, paymentType: null, signedIn: true, acknowledged: true })
      ).toBe(false);
    });

    it("refuses when not signed in, defense in depth even though Liquid already hides the control", () => {
      const { _internal } = loadGroupBuyCampaign();
      expect(
        _internal.canSubmitOrder({ variant: availableVariant, paymentType: "card", signedIn: false, acknowledged: true })
      ).toBe(false);
    });

    it("refuses the Group Buy cancellation-policy acknowledgment (owner spec 2026-09-27/28) — a UX gate, never pre-checked, but required before either action", () => {
      const { _internal } = loadGroupBuyCampaign();
      expect(
        _internal.canSubmitOrder({ variant: availableVariant, paymentType: "card", signedIn: true, acknowledged: false })
      ).toBe(false);
      expect(
        _internal.canSubmitOrder({ variant: availableVariant, paymentType: "bank", signedIn: true, acknowledged: false })
      ).toBe(false);
    });
  });
});

// ---------------------------------------------------------------------------
// 2. The account-required gate — real rendering, both branches.
// ---------------------------------------------------------------------------

describe("the account-required gate (docs/REQUIRED-CUSTOMER-ACCOUNTS.md §4) — real rendering, both branches", () => {
  const SIGNED_IN_CUSTOMER = { name: "Jane Doe", email: "jane@example.com" };

  const FIXTURE_PRODUCT = {
    title: "Solitaire Group Buy Ring",
    handle: "solitaire-group-buy-ring",
    options_with_values: [
      { name: "Metal", values: ["14K", "18K"] },
      { name: "Ring Size", values: ["6", "7"] },
    ],
    variants: [
      { id: 101, option1: "14K", option2: "6", available: true },
      { id: 102, option1: "18K", option2: "7", available: true },
    ],
  };

  function sectionContext(customer: Record<string, unknown> | null) {
    return {
      customer,
      routes: { account_login_url: "/account/login", cart_add_url: "/cart/add.js", cart_url: "/cart" },
      request: { path: "/pages/summer-group-buy", design_mode: false },
      canonical_url: "https://example.com/pages/summer-group-buy",
      shop: { money_format: "${{amount}}" },
      section: {
        id: "test-section",
        settings: {
          product: FIXTURE_PRODUCT,
          campaign_code: "SUMMER26",
          heading: "",
          subheading: "",
          heading_size: "h1",
          color_scheme: "scheme-1",
          padding_top: 36,
          padding_bottom: 36,
          campaign_options_json: "",
          bank_payment_contact_url: "",
        },
      },
    };
  }

  /**
   * `{% render 'loading-spinner' %}` and `{% render 'bank-checkout-country-
   * options', ... %}`-style calls don't appear here, but `{%- render
   * 'loading-spinner' -%}` inside the Card add-to-cart button does — this
   * inert stub is copied from `bankPaymentCheckoutForm.test.ts`'s own
   * `NoopRenderTag` for the identical reason: liquidjs's REAL `render` tag
   * would try to resolve the snippet from disk and throw ENOENT, and the
   * spinner markup is irrelevant to every branch this file asserts on.
   */
  class NoopRenderTag {
    parse(_tagToken: TagToken): void {}
    render(): string {
      return "";
    }
  }

  function createSectionEngine(): Liquid {
    // `t`, `asset_url`, `stylesheet_tag`, `escape`, `url_encode`,
    // `inline_asset_content` are deliberately left UNREGISTERED --
    // liquidjs's documented behaviour for an unknown filter is to pass the
    // input through unchanged. `json` IS needed for real structural output
    // (the embedded variant/option `<script>` payloads), so it alone is
    // registered to the real `JSON.stringify`; every other filter proves
    // CONTROL FLOW (which branch, in which order), matching this repo's own
    // R16 division of labour -- exact translated copy is proven separately
    // below via `en.default.json`.
    const engine = new Liquid();
    engine.registerFilter("json", (value: unknown) => JSON.stringify(value));
    engine.registerTag("render", new NoopRenderTag());
    return engine;
  }

  async function renderSection(customer: Record<string, unknown> | null): Promise<string> {
    const engine = createSectionEngine();
    const source = readLiquid(SECTION);
    return engine.parseAndRender(source, sectionContext(customer));
  }

  it("GUARDS THE GUARD: the signed-in and signed-out renders are structurally different, not a vacuous pass either fixture would satisfy", async () => {
    const signedIn = await renderSection(SIGNED_IN_CUSTOMER);
    const signedOut = await renderSection(null);
    expect(signedIn.length).toBeGreaterThan(0);
    expect(signedOut.length).toBeGreaterThan(0);
    expect(signedIn).not.toEqual(signedOut);
    expect(signedIn).toContain("data-carat-gb-add-to-cart-form");
    expect(signedOut).not.toContain("data-carat-gb-add-to-cart-form");
  });

  describe("signed in", () => {
    it("renders the order form/action, not the sign-in gate", async () => {
      const out = await renderSection(SIGNED_IN_CUSTOMER);
      expect(out).toContain("data-carat-gb-order");
      expect(out).toContain("data-carat-gb-add-to-cart-form");
      expect(out).toContain("data-carat-gb-bank-contact");
      expect(out).not.toContain("data-carat-gb-signin-required");
    });

    it("still renders the public comparison table, configurator and progress area — browsing was never gated", async () => {
      const out = await renderSection(SIGNED_IN_CUSTOMER);
      expect(out).toContain("data-carat-gb-table");
      expect(out).toContain("data-carat-gb-configurator");
      expect(out).toContain("data-carat-gb-progress");
    });
  });

  describe("signed out", () => {
    it("renders the sign-in gate INSTEAD of the order action", async () => {
      const out = await renderSection(null);
      expect(out).toContain("data-carat-gb-signin-required");
      expect(out).toContain("data-carat-gb-signin-link");
      expect(out).not.toContain("data-carat-gb-order");
      expect(out).not.toContain("data-carat-gb-add-to-cart-form");
      expect(out).not.toContain("data-carat-gb-bank-contact");
    });

    it("the sign-in link returns the shopper to this exact page", async () => {
      const out = await renderSection(null);
      expect(out).toContain('href="/account/login?return_url=%2Fpages%2Fsummer-group-buy"');
    });

    it("the comparison table, configurator and progress area STILL render — browsing signed out is fine", async () => {
      const out = await renderSection(null);
      expect(out).toContain("data-carat-gb-table");
      expect(out).toContain("data-carat-gb-configurator");
      expect(out).toContain("data-carat-gb-progress");
    });
  });

  it("the Payment Type radios are never pre-checked, in either sign-in state", async () => {
    for (const customer of [SIGNED_IN_CUSTOMER, null]) {
      const out = await renderSection(customer);
      const radioButtons = out.match(/<input[^>]*data-carat-gb-payment-type[^>]*>/g) ?? [];
      expect(radioButtons.length).toBe(2);
      for (const radio of radioButtons) {
        expect(radio).not.toMatch(/\schecked\b/);
      }
    }
  });

  it("the table's <thead>/<tbody> are empty at server-render time — no price column, correct or otherwise, is ever hardcoded in the template", async () => {
    // The single-price-column guarantee (owner §10) is enforced in
    // `buildTableHeaderLabels`'s own pure-logic test above; this asserts the
    // template side of that split: the table is entirely JS-populated
    // (`group-buy-campaign.js`'s `init()`), so there is no server-rendered
    // markup that could duplicate or hardcode a second price column in the
    // first place.
    const out = await renderSection(SIGNED_IN_CUSTOMER);
    expect(out).toMatch(/<thead[^>]*data-carat-gb-table-head[^>]*>\s*<\/thead>/);
    expect(out).toMatch(/<tbody[^>]*data-carat-gb-table-body[^>]*>\s*<\/tbody>/);
    expect(out).not.toMatch(/Bank Payment Price/);
  });

  it("the Group Buy cancellation-acknowledgment checkbox is never pre-checked, and its hidden ack-id input starts empty", async () => {
    const out = await renderSection(SIGNED_IN_CUSTOMER);
    const checkboxes = out.match(/<input[^>]*data-carat-gb-cancel-ack-checkbox[^>]*>/g) ?? [];
    expect(checkboxes.length).toBe(1);
    expect(checkboxes[0]).not.toMatch(/\schecked\b/);

    const hiddenInputs = out.match(/<input[^>]*data-carat-gb-cancel-ack-input[^>]*>/g) ?? [];
    expect(hiddenInputs.length).toBe(1);
    expect(hiddenInputs[0]).toMatch(/value=""/);
  });

  it("renders the pinned cancellation disclosure/checkbox/label copy verbatim, matching the domain module", async () => {
    const out = await renderSection(SIGNED_IN_CUSTOMER);
    // `t` is unregistered in this test's Liquid engine (see createSectionEngine's
    // own comment) — an unknown filter passes its input through unchanged, so
    // the rendered output contains the LOCALE KEY itself, not the resolved
    // string. This still proves the template names the right keys; exact
    // wording is proven separately by `cancellationAcknowledgmentText.test.ts`'s
    // locale-file fence.
    expect(out).toContain("templates.group_buy_campaign.cancellation_disclosure");
    expect(out).toContain("templates.group_buy_campaign.cancellation_checkbox_label");
    expect(out).toContain("templates.group_buy_campaign.cancellation_affirm_label");
  });

  it("this file never claims client-side gating is the enforcement", () => {
    const sectionSource = readFileSync(join(THEME_ROOT, SECTION), "utf8");
    const jsSource = readFileSync(join(THEME_ROOT, "assets", "group-buy-campaign.js"), "utf8");
    for (const source of [sectionSource, jsSource]) {
      expect(source).not.toMatch(/gating (is|as) (the|an) enforcement/i);
      expect(source).not.toMatch(/this (protects|secures|authorizes)/i);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Locale sanity + forbidden terminology.
// ---------------------------------------------------------------------------

describe("templates.group_buy_campaign — new locale keys resolve", () => {
  const KEYS = [
    "onboarding_missing_settings",
    "share_label",
    "loading",
    "noscript",
    "table_heading",
    "bank_note",
    "configure_heading",
    "payment_type_legend",
    "payment_type_card",
    "payment_type_bank",
    "order_heading",
    "order_hint",
    "add_to_cart",
    "bank_contact_cta",
    "sign_in_required_heading",
    "sign_in_required_message",
    "cancellation_disclosure",
    "cancellation_checkbox_label",
    "cancellation_affirm_label",
    "cancellation_ack_error",
  ];

  it.each(KEYS)("templates.group_buy_campaign.%s is a non-empty string", (key) => {
    const value = at(`templates.group_buy_campaign.${key}`);
    expect(typeof value, `templates.group_buy_campaign.${key} is missing`).toBe("string");
    expect((value as string).length).toBeGreaterThan(0);
  });

  it("the sign-in sentence is byte-for-byte the owner-approved sentence from docs/REQUIRED-CUSTOMER-ACCOUNTS.md §4", () => {
    expect(at("templates.group_buy_campaign.sign_in_required_message")).toBe(
      "Please sign in or create a CaratForUs account to continue."
    );
  });

  it("the note beside the table/price matches owner §9/§10's exact required wording", () => {
    expect(at("templates.group_buy_campaign.bank_note")).toBe("Lower pricing is available with Bank Payment.");
  });
});

describe("no forbidden Bank/Card terminology in the new section, JS, or locale keys", () => {
  const sectionSource = stripLiquidComments(readFileSync(join(THEME_ROOT, SECTION), "utf8"));
  const jsSource = readFileSync(join(THEME_ROOT, "assets", "group-buy-campaign.js"), "utf8");
  const localeGroupBuyCampaign = JSON.stringify(at("templates.group_buy_campaign"));

  it.each([
    ["sections/group-buy-campaign.liquid", sectionSource],
    ["assets/group-buy-campaign.js", jsSource],
    ["locales/en.default.json templates.group_buy_campaign", localeGroupBuyCampaign],
  ])("%s contains no forbidden terminology", (_label, source) => {
    for (const term of FORBIDDEN_TERMS) {
      expect(source).not.toMatch(term);
    }
  });

  it("never displays the internal Bank/Card percentage anywhere in the JS", () => {
    // The JS only ever reads *MinorUnits fields from the server response and
    // formats them as money -- it has no field, constant or computation for
    // a percentage at all.
    expect(jsSource).not.toMatch(/\d+(\.\d+)?\s*%/);
  });
});
