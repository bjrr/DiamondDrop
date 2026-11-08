import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

/**
 * THE CAMPAIGN DETAIL PAGE'S PROMISES, ASSERTED AGAINST THE SHIPPED FILES.
 *
 * Four of them, and each is a property no server unit test can see:
 *
 *   1. PRIVACY. The browser may learn ONE Shopify variant id, for a selection
 *      the server already validated. It may not learn a MasterVariant id, a
 *      size band, a mapping signature, a cost, a margin or a floor.
 *   2. NO BROWSER PRICE ARITHMETIC. Prices are rendered, never derived.
 *   3. THE PURCHASE MECHANISMS ARE THE EXISTING ONES. Card still goes through
 *      Shopify's native cart carrying the acknowledgment line property; Bank
 *      still goes to its own endpoint and still holds no acknowledgment id.
 *   4. ONE STATE. The sticky bar renders the same state as the main controls
 *      and cannot offer a purchase they would refuse.
 *
 * Patterns run against source with comments and string literals stripped,
 * except where the thing being asserted IS a string.
 */

const THEME = join(process.cwd(), "..", "theme");
const SECTION = readFileSync(join(THEME, "sections", "group-buy-detail.liquid"), "utf8");
const SCRIPT = readFileSync(join(THEME, "assets", "group-buy-detail.js"), "utf8");
const RESOLVE_ROUTE = readFileSync(
  join(process.cwd(), "app", "routes", "apps.carat.group-buy-resolve.$code.tsx"),
  "utf8"
);

function codeOnly(source: string): string {
  let out = "";
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === "/*") {
      const end = source.indexOf("*/", i + 2);
      i = end === -1 ? source.length : end + 2;
      continue;
    }
    if (two === "//") {
      const end = source.indexOf("\n", i);
      i = end === -1 ? source.length : end;
      continue;
    }
    const ch = source[i]!;
    if (ch === '"' || ch === "'" || ch === "`") {
      i += 1;
      while (i < source.length) {
        if (source[i] === "\\") {
          i += 2;
          continue;
        }
        if (source[i] === ch) {
          i += 1;
          break;
        }
        i += 1;
      }
      out += '""';
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

const CODE = codeOnly(SCRIPT);
const RESOLVE_CODE = codeOnly(RESOLVE_ROUTE);

describe("the comment stripper", () => {
  it("removes comments and strings but keeps code", () => {
    expect(codeOnly("var a; /* masterVariantId */")).not.toContain("masterVariantId");
    expect(codeOnly('var a = "masterVariantId";')).not.toContain("masterVariantId");
    expect(codeOnly("var before = 1; /* c */ var after = 2;")).toContain("var after = 2");
  });

  it("stripped this page's own header", () => {
    expect(SCRIPT).toContain("ONE STATE OBJECT");
    expect(CODE).not.toContain("ONE STATE OBJECT");
  });
});

describe("privacy: what the browser may and may not learn", () => {
  it.each([
    "masterVariantId",
    "bandValue",
    "band_4_6",
    "variantMappings",
    "configurationSignature",
    "landedCost",
    "supplierCost",
    "pricingProfileId",
    "variantFloor",
    "frozenBaseBankPaymentPrice",
  ])("the detail script never references %s", (forbidden) => {
    expect(SCRIPT).not.toContain(forbidden);
  });

  it("the detail script never mentions margin or floor", () => {
    expect(CODE.toLowerCase()).not.toContain("margin");
    expect(CODE.toLowerCase()).not.toContain("floor");
  });

  it("uses the ONE Shopify variant id the server resolved, and asks for no others", () => {
    expect(CODE).toMatch(/state\.resolved\.shopifyVariantId/);
    // There is no bulk mapping in the bootstrap to read from.
    expect(CODE).not.toMatch(/shopifyVariantIds/);
    expect(CODE).not.toMatch(/variantMap/);
  });

  it("posts a SELECTION, never a variant the browser picked", () => {
    // The query-parameter name is a string literal, so it is asserted on the
    // RAW source; the surrounding structure is asserted stripped.
    expect(SCRIPT).toContain("selection=");
    expect(CODE).toMatch(/JSON\.stringify\(state\.selection\)/);
    // No parameter anywhere names a variant the browser chose.
    expect(SCRIPT).not.toContain("?variant=");
    expect(SCRIPT).not.toContain("shopify_variant=");
  });
});

describe("the resolve endpoint is the authority", () => {
  it("validates against the frozen contract before anything else", () => {
    expect(RESOLVE_CODE).toMatch(/resolveSelection\(/);
    expect(RESOLVE_CODE).toMatch(/getFrozenGroupBuyCampaignOptions\(/);
  });

  it("confirms the resolved variant belongs to THIS campaign", () => {
    expect(RESOLVE_CODE).toMatch(/campaign\.variants\.find\(/);
    expect(RESOLVE_ROUTE).toContain("not_eligible_for_campaign");
  });

  it("never falls back to a first or default variant", () => {
    expect(RESOLVE_CODE).not.toMatch(/variants\[0\]/);
    expect(RESOLVE_CODE).not.toMatch(/firstAvailable/);
    expect(RESOLVE_CODE).not.toMatch(/\?\?\s*campaign\.variants/);
  });

  it("refuses a fixture campaign and an unopened campaign", () => {
    expect(RESOLVE_CODE).toMatch(/isTestFixtureCampaignCode\(/);
    // The literal "open" is stripped, so the comparison is asserted
    // structurally and the literal separately.
    expect(RESOLVE_CODE).toMatch(/campaign\.status !== ""/);
    expect(RESOLVE_ROUTE).toMatch(/campaign\.status !== "open"/);
  });

  it("verifies the App Proxy signature before touching the database", () => {
    const verifyAt = RESOLVE_CODE.indexOf("verifyAppProxySignature");
    const dbAt = RESOLVE_CODE.indexOf("prisma.");
    expect(verifyAt).toBeGreaterThan(-1);
    expect(dbAt).toBeGreaterThan(verifyAt);
  });

  it("returns only the narrow customer-safe shape", () => {
    // `available`, `shopifyVariantId`, `price` — and a refusal reason.
    expect(RESOLVE_ROUTE).toContain("available: true");
    expect(RESOLVE_ROUTE).toContain("shopifyVariantId");
    // Scoped to what is RETURNED. The id legitimately appears in a database
    // filter above; what matters is that it never reaches the response.
    const responseAt = RESOLVE_ROUTE.indexOf("{ available: true, shopifyVariantId, price }");
    expect(responseAt).toBeGreaterThan(-1);
    expect(RESOLVE_ROUTE.slice(responseAt, responseAt + 400)).not.toContain("masterVariantId");
    expect(RESOLVE_CODE).not.toMatch(/\.\.\.(eligible|campaign|masterVariant)\b/);
  });

  it("is a resource route, so the CSRF guard does not apply", () => {
    expect(RESOLVE_ROUTE).not.toMatch(/^export default/m);
  });
});

describe("no price arithmetic in the browser", () => {
  it("never divides by 100", () => {
    expect(CODE).not.toMatch(/\/\s*100\b/);
  });

  it("never multiplies by a tier rate or applies an uplift", () => {
    expect(CODE).not.toMatch(/multiplier/i);
    expect(CODE).not.toMatch(/uplift/i);
    expect(CODE).not.toMatch(/\*\s*(?:rate|tier|price)/i);
  });

  it("uses no float-producing conversion on money", () => {
    expect(CODE).not.toMatch(/parseFloat\s*\(/);
    expect(CODE).not.toMatch(/toFixed\s*\(/);
    expect(CODE).not.toMatch(/Number\s*\(\s*\w*[Mm]inorUnits/);
  });

  it("formats by splitting the digit string", () => {
    expect(CODE).toMatch(/slice\(0, -2\)/);
    expect(CODE).toMatch(/slice\(-2\)/);
  });

  it("renders no money in Liquid", () => {
    expect(SECTION).not.toMatch(/\|\s*money/);
    expect(SECTION).not.toMatch(/divided_by|times:/);
  });
});

describe("the Card path is Shopify's own, unchanged", () => {
  it("posts to the theme's cart add URL", () => {
    expect(CODE).toMatch(/cfg\.cartAddUrl/);
    expect(SECTION).toContain("routes.cart_add_url");
  });

  it("carries the existing acknowledgment line property", () => {
    expect(SCRIPT).toContain("_carat_gb_cancel_ack");
    expect(CODE).toMatch(/properties:\s*\{\s*_carat_gb_cancel_ack:\s*state\.ackId\s*\}/);
  });

  it("captures the acknowledgment id BEFORE the order, from the server", () => {
    expect(CODE).toMatch(/cfg\.ackEndpoint/);
    expect(SECTION).toContain("group-buy-cancellation-acknowledgment");
  });

  it("refuses to add to cart without a captured acknowledgment id", () => {
    expect(CODE).toMatch(/if \(!state\.ackId\)/);
  });

  it("introduces no second card checkout", () => {
    expect(CODE).not.toMatch(/checkout\.shopify/);
    expect(SCRIPT).not.toContain("/checkout");
  });
});

describe("the Bank path stays dedicated and holds no acknowledgment id", () => {
  it("posts to the Group Buy bank endpoint, not the cart", () => {
    expect(CODE).toMatch(/cfg\.bankEndpoint/);
    expect(SECTION).toContain("group-buy-bank-checkout");
  });

  it("sends only the affirmative flag — never a browser-held id", () => {
    expect(CODE).toMatch(/cancellationAcknowledgmentAccepted:/);
    // The whole bank payload, isolated, must not carry the Card path's id.
    const payloadStart = CODE.indexOf("cancellationAcknowledgmentAccepted");
    const payloadWindow = CODE.slice(Math.max(0, payloadStart - 900), payloadStart + 200);
    expect(payloadWindow).not.toContain("ackId");
  });

  it("keeps the existing payload shape", () => {
    expect(SCRIPT).toContain('mode: "bank"');
    expect(CODE).toMatch(/campaignCode:/);
    expect(CODE).toMatch(/shippingAddress:/);
    expect(CODE).toMatch(/lines:\s*\[\{\s*shopifyVariantId:/);
  });

  it("does not route Bank through the cart", () => {
    const bankStart = CODE.indexOf("openBankSheet");
    const bankBody = CODE.slice(bankStart);
    expect(bankBody).not.toMatch(/cartAddUrl/);
  });

  it("refuses a duplicate submission", () => {
    expect(CODE).toMatch(/if \(state\.submitting\) return/);
  });
});

describe("ordering is gated, and the gate is one predicate", () => {
  it("requires sign-in, a resolved configuration, payment and acknowledgment", () => {
    const gate = CODE.slice(CODE.indexOf("function canOrder()"), CODE.indexOf("function ctaState()"));
    expect(gate).toMatch(/cfg\.signedIn/);
    expect(gate).toMatch(/state\.resolved/);
    expect(gate).toMatch(/state\.acknowledged/);
    expect(gate).toMatch(/state\.paymentType/);
    // And never while a price is still being resolved.
    expect(gate).toMatch(/state\.resolving/);
  });

  it("is consulted by both purchase paths", () => {
    expect(CODE).toMatch(/function joinWithCard\(\)\s*\{\s*if \(!canOrder\(\)/);
    expect(CODE).toMatch(/function openBankSheet\(\)\s*\{\s*if \(!canOrder\(\)/);
  });

  it("never preselects a payment method", () => {
    expect(CODE).toMatch(/paymentType:\s*null/);
  });

  it("never pre-checks the acknowledgment", () => {
    expect(CODE).toMatch(/acknowledged:\s*false/);
    expect(SECTION).not.toMatch(/type="checkbox"[^>]*checked/);
  });

  it("clears a captured acknowledgment when the configuration changes", () => {
    // The captured id is bound to a variant; a different ring needs a new one.
    const choose = CODE.slice(CODE.indexOf("function choose("), CODE.indexOf("function renderPrice("));
    expect(choose).toMatch(/state\.ackId = null/);
  });

  it("clears it when the payment method changes", () => {
    const payment = CODE.slice(CODE.indexOf("function renderPayment("));
    expect(payment).toMatch(/state\.ackId = null/);
  });
});

describe("the sticky bar is a second rendering, not a second state machine", () => {
  it("reads the same predicate and the same resolved price", () => {
    const stickyFn = CODE.slice(CODE.indexOf("function renderSticky()"), CODE.indexOf("function handleCta("));
    expect(stickyFn).toMatch(/ctaState\(\)/);
    expect(stickyFn).toMatch(/state\.resolved/);
    expect(stickyFn).toMatch(/state\.paymentType/);
  });

  it("holds no state of its own", () => {
    expect(CODE).not.toMatch(/stickyState/);
    expect(CODE).not.toMatch(/var stickySelection/);
  });

  it("respects the iOS safe area", () => {
    const css = readFileSync(join(THEME, "assets", "component-group-buy.css"), "utf8");
    expect(css).toMatch(/\.gb-sticky[\s\S]*?env\(safe-area-inset-bottom/);
  });
});

describe("rapid option changes cannot show the wrong price", () => {
  it("sequences responses and ignores stale ones", () => {
    expect(CODE).toMatch(/resolveSeq/);
    expect(CODE).toMatch(/if \(seq !== resolveSeq\) return/);
  });

  it("aborts the in-flight request", () => {
    expect(CODE).toMatch(/AbortController/);
    expect(CODE).toMatch(/resolveAbort\.abort\(\)/);
  });

  it("does not leave a stale price looking authoritative", () => {
    const resolveFn = CODE.slice(CODE.indexOf("function resolve()"), CODE.indexOf("function onAckChange("));
    expect(resolveFn).toMatch(/state\.resolving = true/);
  });
});

describe("no campaign content in Theme Editor", () => {
  const schema = SECTION.slice(SECTION.indexOf("{% schema %}"));

  it.each(["campaign_code", "campaign_options_json", "heading", "subheading"])(
    "has no %s setting",
    (setting) => {
      expect(schema).not.toContain(`"id": "${setting}"`);
    }
  );

  it("has no product picker", () => {
    expect(schema).not.toContain('"type": "product"');
  });

  it("keeps only presentation settings", () => {
    const ids = [...schema.matchAll(/"id":\s*"([a-z_]+)"/g)].map((m) => m[1]!);
    expect(ids.sort()).toEqual(["color_scheme", "padding_bottom", "padding_top"].sort());
  });

  it("takes the campaign from the URL", () => {
    expect(CODE).toMatch(/URLSearchParams\(window\.location\.search\)\.get\(""\)/);
    expect(SCRIPT).toContain(".get(\"campaign\")");
  });
});

describe("gallery and imagery", () => {
  it("prefers the mobile hero, then the hero, then the gallery", () => {
    expect(CODE).toMatch(/campaign\.mobileHeroImage \|\| campaign\.heroImage/);
    expect(CODE).toMatch(/campaign\.galleryImages/);
  });

  it("preserves Shopify alt text", () => {
    expect(CODE).toMatch(/image\.altText/);
  });

  it("eager-loads only the first image and lazy-loads the rest", () => {
    expect(SCRIPT).toContain('index === 0 ? "eager" : "lazy"');
    expect(SCRIPT).toContain("fetchpriority");
  });

  it("never advances on its own", () => {
    expect(CODE).not.toMatch(/setInterval/);
    expect(CODE).not.toMatch(/autoplay/i);
  });

  it("adds no carousel library", () => {
    expect(SECTION).not.toMatch(/swiper|flickity|glide|splide/i);
  });
});

describe("honest failure states", () => {
  it("keeps selections when a price lookup fails and offers a retry", () => {
    expect(SCRIPT).toContain("We couldn't load the price. Try again.");
    expect(CODE).toMatch(/state\.resolveError/);
  });

  it("says a configuration is unavailable rather than guessing", () => {
    expect(SCRIPT).toContain("This configuration is currently unavailable.");
  });

  it("never leaves a permanent loading state", () => {
    expect(CODE).toMatch(/\.catch\(/);
    expect(SCRIPT).toContain("could not be loaded");
  });

  it("surfaces no raw server detail on a bank failure", () => {
    const bank = SCRIPT.slice(SCRIPT.indexOf("function openBankSheet"));
    expect(bank).toContain("Please check your details and try again.");
    expect(codeOnly(bank)).not.toMatch(/error\.message/);
    expect(codeOnly(bank)).not.toMatch(/body\.error/);
  });
});

describe("signed-out browsing", () => {
  it("gates only ordering, not viewing or pricing", () => {
    const gate = CODE.slice(CODE.indexOf("function canOrder()"), CODE.indexOf("function ctaState()"));
    expect(gate).toMatch(/cfg\.signedIn/);
    // Resolution — and therefore the price — never consults sign-in.
    const resolveFn = CODE.slice(CODE.indexOf("function resolve()"), CODE.indexOf("function onAckChange("));
    expect(resolveFn).not.toMatch(/signedIn/);
  });

  it("returns the shopper to this campaign after signing in", () => {
    expect(SCRIPT).toContain("return_url");
    expect(CODE).toMatch(/window\.location\.search/);
  });
});

describe("sharing", () => {
  it("uses the native share sheet with a copy-link fallback", () => {
    expect(CODE).toMatch(/navigator\.share/);
    expect(CODE).toMatch(/navigator\.clipboard/);
  });

  it("adds no third-party social SDK", () => {
    expect(SCRIPT).not.toMatch(/facebook|twitter|pinterest|addthis|sharethis/i);
  });
});

describe("related campaigns", () => {
  it("reuses the hub summary feed and excludes the current campaign", () => {
    expect(CODE).toMatch(/cfg\.hubEndpoint/);
    expect(CODE).toMatch(/c\.code !== code/);
    expect(CODE).toMatch(/\.slice\(0, 3\)/);
  });
});

describe("closed campaigns", () => {
  it("render history and offer no purchase controls", () => {
    expect(CODE).toMatch(/campaign\.status === ""/);
    expect(SCRIPT).toMatch(/campaign\.status === "closed"/);
    expect(SCRIPT).toContain("Campaign Closed");
    expect(SCRIPT).toContain("View Active Group Buys");
  });

  it("hide the sticky purchase bar", () => {
    const stickyFn = SCRIPT.slice(SCRIPT.indexOf("function renderSticky()"));
    expect(stickyFn).toMatch(/status === "closed"[\s\S]{0,160}hidden = true/);
  });
});

describe("no O(variants) requests on load", () => {
  it("bootstraps once and resolves only on a complete selection", () => {
    expect(CODE).toMatch(/cfg\.bootstrapBase/);
    const resolveFn = CODE.slice(CODE.indexOf("function resolve()"), CODE.indexOf("function onAckChange("));
    expect(resolveFn).toMatch(/isComplete\(state\.options, state\.selection\)/);
  });

  it("carries no per-variant comparison table", () => {
    expect(CODE).not.toMatch(/priceCellsByVariantId/);
    expect(SCRIPT).not.toContain("Compare configurations");
  });
});
