import { readFileSync } from "node:fs";
import { join } from "node:path";

import { renderToStaticMarkup } from "react-dom/server";
import { RouterProvider, createMemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";

import PricingSettingsPage from "./app.pricing-settings";

/**
 * THE PRICING SETTINGS SCREEN — rendering, and the authorization boundary.
 *
 * Same technique as `app.custom-jewelry.$id.test.tsx`: nothing is mocked and
 * only the loader's RESULT is supplied, because running the real loader would
 * call `authenticate.admin` and query a live session. The write path's real
 * behaviour — versioning, validation, audit, append-only, frozen campaigns —
 * is exercised against a real database in
 * `tests/integration/pricing/pricingSettingsOperatorPath.test.ts` and
 * `pricingConfigurationPropagation.test.ts`.
 *
 * WHAT THIS FILE COVERS THAT THOSE CANNOT: that the operator is actually
 * shown the current values and told the truth about scope and about what
 * saving does. A settings screen that silently displays stale values, or
 * implies a save moved the storefront, is its own defect regardless of how
 * correct the persistence underneath is.
 */

const ROUTE_ID = "pricing-settings";

const DATA = {
  apiKey: "test-key",
  profile: {
    version: 5,
    targetMarkupPercent: "40",
    minGrossMarginPercent: "20",
    minDollarProfit: "100.00",
    currency: "USD",
    effectiveFrom: "2026-09-18T00:00:00.000Z",
    cardRule: "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1",
    marginModel: "MARKUP_ON_COST_V1",
  },
  metals: [
    { metal: "gold", pricePerGram: "82.7", currency: "USD", effectiveFrom: "2026-01-01T00:00:00.000Z", source: "manual" },
  ],
  labor: [{ source: "india", ratePerGram: "4.5", currency: "USD", effectiveFrom: "2026-01-01T00:00:00.000Z" }],
  stones: [
    {
      stoneType: "lab_diamond",
      shape: "round",
      band: "0.9–1.1",
      cost: "420.00 USD per stone",
      qualifiers: "any (wildcard)",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
    },
  ],
  components: [
    {
      componentType: "packaging",
      basis: "cost_side",
      valueKind: "fixed",
      value: "6.00 USD",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
    },
    {
      componentType: "warranty_reserve",
      basis: "cost_side",
      valueKind: "percentage",
      value: "0.02",
      effectiveFrom: "2026-01-01T00:00:00.000Z",
    },
  ],
  componentTypes: ["metal_loss", "casting", "packaging", "warranty_reserve"],
  autoPublishEnabled: false,
};

/** `profile` is deliberately nullable: the loader returns null when none is provisioned. */
type PageData = Omit<typeof DATA, "profile"> & { profile: (typeof DATA)["profile"] | null };

function render(over: Partial<PageData> = {}): string {
  const data: PageData = { ...DATA, ...over };
  const router = createMemoryRouter(
    [{ id: ROUTE_ID, path: "/app/pricing-settings", Component: PricingSettingsPage, loader: () => data }],
    {
      initialEntries: ["/app/pricing-settings"],
      hydrationData: { loaderData: { [ROUTE_ID]: data } },
    }
  );
  return renderToStaticMarkup(<RouterProvider router={router} />);
}

describe("current settings render", () => {
  const html = render();

  it("shows the active profile version and its effective date", () => {
    expect(html).toContain("version 5");
    expect(html).toContain("2026-09-18T00:00:00.000Z");
  });

  it("pre-fills the three values as percentages and an amount", () => {
    expect(html).toContain('value="40"');
    expect(html).toContain('value="20"');
    expect(html).toContain('value="100.00"');
  });

  it("shows the card rule rather than hiding what else the profile carries", () => {
    // The operator is changing three fields on a row that holds more than
    // three. Showing the inherited card rule is how they know it is inherited.
    expect(html).toContain("BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1");
  });

  it("lists the currently applicable metal, labor and stone values", () => {
    expect(html).toContain("82.7");
    expect(html).toContain("4.5");
    expect(html).toContain("420.00 USD per stone");
  });

  it("says a blank stone qualifier is a wildcard", () => {
    expect(html).toContain("wildcard");
  });

  it("survives a missing profile without crashing", () => {
    const empty = render({ profile: null });
    expect(empty).toContain("No active pricing profile is provisioned");
  });
});

describe("the screen tells the truth about scope", () => {
  const html = render();

  it("does not claim these settings are Buy Now only", () => {
    // Only `buy_now` is ever resolved, and Custom Jewelry reads the same
    // profile. Labelling the screen "Buy Now settings" would be false.
    expect(html).not.toMatch(/Buy Now only/i);
  });

  it("names Custom Jewelry and future Group Buy campaigns as affected", () => {
    expect(html).toContain("Custom Jewelry");
    expect(html).toMatch(/future.{0,40}Group Buy/is);
  });

  it("states that existing Group Buy campaigns are not repriced", () => {
    expect(html).toMatch(/retain the pricing configuration frozen/i);
  });
});

describe("the screen tells the truth about what saving does", () => {
  it("says prices update at the next recalculation, not immediately", () => {
    expect(render()).toMatch(/next recalculation/i);
  });

  it("with auto-publish off, says nothing reaches Shopify without approval", () => {
    expect(render()).toMatch(/approval and sync controls/i);
  });

  it("with auto-publish ON, says so instead of repeating the safe message", () => {
    // If someone ever turns the flag on, the screen must stop promising a
    // review step that is no longer happening.
    const html = render({ autoPublishEnabled: true });
    expect(html).toMatch(/auto-publish is currently ENABLED/i);
    expect(html).not.toMatch(/approval and sync controls/i);
  });

  it("no longer claims components are unmanaged, now that they are", () => {
    expect(render()).not.toMatch(/not yet managed from/i);
  });
});

describe("cost components", () => {
  const html = render();

  it("lists the currently effective components", () => {
    expect(html).toContain("packaging");
    expect(html).toContain("6.00 USD");
    expect(html).toContain("warranty_reserve");
  });

  it("offers only the component types the loader supplied", () => {
    // The loader filters INERT_COMPONENT_TYPES out, so the page cannot offer
    // a type whose value would silently affect no price.
    expect(html).toContain('value="metal_loss"');
    expect(html).not.toContain('value="payment_adjustment"');
  });

  it("explains the value-kind split rather than letting the operator guess", () => {
    expect(html).toMatch(/0\.029 means 2\.9%/);
  });
});

describe("the authorization boundary", () => {
  /**
   * Comments stripped before scanning: this file's own documentation names
   * the things it forbids. Fourth time this trap has appeared in this
   * project — see `faqSurface.test.ts`.
   */
  const source = readFileSync(join(process.cwd(), "app", "routes", "app.pricing-settings.tsx"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");

  it("the stripper actually strips", () => {
    expect(source).toContain("WHY THIS EXISTS");
    expect(code).not.toContain("WHY THIS EXISTS");
  });

  it("authenticates every loader and action through the embedded boundary", () => {
    const calls = code.match(/authenticate\.admin\s*\(/g) ?? [];
    expect(calls.length).toBeGreaterThanOrEqual(2);
  });

  it("refuses a non-POST mutation", () => {
    expect(code).toMatch(/request\.method\s*!==\s*"POST"/);
  });

  it("requires an ONLINE session with an associated user before writing", () => {
    // An unattributable change to pricing policy is not one anyone can
    // defend later, so the action refuses rather than recording nobody.
    expect(code).toMatch(/onlineAccessInfo\?\.associated_user/);
    expect(code).toMatch(/status:\s*401/);
  });

  it("never derives the actor from the submitted form", () => {
    expect(code).not.toMatch(/actorRef:\s*text\(/);
    expect(code).not.toMatch(/form\.get\(["']actor/);
    expect(code).toMatch(/actorRef,/);
  });

  it("is not an App Proxy endpoint and verifies no proxy signature", () => {
    expect(code).not.toMatch(/verifyAppProxySignature/);
  });

  it("writes nothing to Shopify", () => {
    // Configuration -> recalculation -> intent -> Shopify. This route is the
    // first step only.
    expect(code).not.toMatch(/admin\.graphql/);
    expect(code).not.toMatch(/syncApprovedPriceSyncIntent/);
    expect(code).not.toMatch(/unauthenticated\.admin/);
  });

  it("validates every enum-like field at RUNTIME, not with a cast", () => {
    // `as never` is erased at build time. A crafted POST carrying
    // `metal=unobtanium` previously reached the database layer unexamined;
    // it now fails at the boundary with a 400 naming the field.
    expect(code).not.toMatch(/as never/);
    for (const field of ["Metal", "LaborSource", "StoneType", "StoneCostKind", "CostComponentType", "CostComponentBasis", "CostComponentValueKind"]) {
      expect(code, `${field} is not runtime-validated`).toMatch(
        new RegExp(String.raw`parseEnumValue\(\s*${field}\b`)
      );
    }
  });

  it("validates currency on every path that reaches a repository", () => {
    /**
     * The column is `char(3)` and Postgres PADS a short value, so "US" would
     * be stored as "US " with no error at any layer — corruption rather than
     * a rejected request. Every currency must therefore be validated before
     * it reaches a write.
     *
     * TWO legitimate routes to that, and an earlier version of this fence
     * failed a correct one by only recognising the first: the three cost
     * libraries call `parseCurrency` directly, while the profile path hands
     * the raw value to `validatePricingProfileSettings`, which applies the
     * same three-letter check one layer down. Both are validated; a blanket
     * ban on `currency: text(` flagged the second.
     *
     * Kept deliberately structural rather than clever: two earlier attempts
     * matched a TypeScript interface declaration and a correctly-validated
     * call respectively. The BEHAVIOUR — that a two-letter currency is
     * refused rather than padded — is pinned where it belongs, in
     * `pricingSettingsOperatorPath.test.ts` against a real database. This
     * only checks the wiring exists.
     */
    // One per cost library: metal, labor, stone. Components add a fourth.
    expect((code.match(/parseCurrency\(/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect(code).toMatch(/validatePricingProfileSettings\(/);
  });

  it("does not let the operator choose a version number", () => {
    expect(code).not.toMatch(/name="version"/);
    expect(code).not.toMatch(/text\(form,\s*"version"\)/);
  });

  it("does not expose future-dating in MVP1", () => {
    // Effective date is server time. The architecture still supports
    // scheduling; the form deliberately does not.
    expect(code).not.toMatch(/name="effectiveFrom"/);
    expect(code).toMatch(/effectiveFrom:\s*now/);
  });
});
