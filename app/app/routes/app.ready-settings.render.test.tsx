/**
 * What the ready-mount admin screen actually renders.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS SEPARATELY FROM THE ACTION TESTS
 * ---------------------------------------------------------------------------
 * `app.ready-settings._index.test.tsx` proves the writes are correct. It says
 * nothing about whether a staff member can SEE the data — and these are
 * fields where a display bug is indistinguishable from a data bug. A nominal
 * size shown as "10000" instead of "10", a vendor range rendered as
 * "9.8–undefined", a prong column reading "yes" for a mounting whose vendor
 * range overrides it: each would be read as "the matching rules are wrong" by
 * whoever noticed.
 *
 * Server-rendered rather than driven in a browser, because the owner's
 * in-browser check needs an authenticated Shopify Admin session that is not
 * available here. This covers the markup; it does not cover the embedded
 * iframe, and that gap is reported rather than papered over.
 */
import { renderToString } from "react-dom/server";
import { createStaticHandler, createStaticRouter, StaticRouterProvider } from "react-router";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("~/lib/env.server", () => ({ getEnv: () => ({ SHOPIFY_API_KEY: "test-key" }) }));
vi.mock("~/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("~/shopify.server", () => ({ authenticate: { admin: vi.fn() } }));
vi.mock("~/db/repositories/readySettingWrites.server", () => ({
  listReadySettings: vi.fn(),
  findReadySettingById: vi.fn(),
  upsertReadySetting: vi.fn(),
  setReadySettingActive: vi.fn(),
}));

const Page = (await import("./app.ready-settings._index")).default;

const BASE = {
  shopifyProductGid: "gid://shopify/Product/111",
  nominalDepthUm: null,
  minLengthUm: null,
  maxLengthUm: null,
  minWidthUm: null,
  maxWidthUm: null,
  vendorRangeSource: null,
  eligibleForSetYourOwnStone: true,
  prongSetToleranceEligible: false,
  isActive: true,
};

/** An oval 10 × 7 × 4.2, prong-adjustable, active — the ordinary case. */
const PRONG_OVAL = {
  ...BASE,
  id: "row-1",
  shopifyVariantGid: "gid://shopify/ProductVariant/222",
  shape: "oval",
  nominalLengthUm: 10_000,
  nominalWidthUm: 7_000,
  nominalDepthUm: 4_200,
  prongSetToleranceEligible: true,
};

/** A cushion with a published vendor range, not eligible, and withdrawn. */
const RANGED_INACTIVE = {
  ...BASE,
  id: "row-2",
  shopifyVariantGid: "gid://shopify/ProductVariant/333",
  shape: "cushion",
  nominalLengthUm: 9_500,
  nominalWidthUm: 9_500,
  minLengthUm: 9_300,
  maxLengthUm: 9_700,
  minWidthUm: 9_300,
  maxWidthUm: 9_750,
  vendorRangeSource: "Vendor spec sheet p.4",
  prongSetToleranceEligible: true,
  eligibleForSetYourOwnStone: false,
  isActive: false,
};

/**
 * Server-render the route with its loader — and optionally its action —
 * already resolved.
 *
 * `createRoutesStub` + `renderToString` returns an EMPTY STRING here: the stub
 * resolves loaders asynchronously and `renderToString` does not await them, so
 * every assertion silently passed against "". The static handler is the
 * documented SSR path and awaits the data first, which is the difference
 * between testing the markup and testing nothing. Worth stating, because the
 * first version of this file "passed" that way.
 */
async function render(settings: unknown[], actionData?: unknown): Promise<string> {
  const routes = [
    {
      id: "ready-settings",
      path: "/app/ready-settings",
      Component: Page,
      loader: () => ({ apiKey: "test-key", settings }),
      action: () => actionData ?? null,
    },
  ];

  const handler = createStaticHandler(routes);
  const init: RequestInit = actionData
    ? { method: "POST", body: new URLSearchParams({ intent: "save" }) }
    : { method: "GET" };
  const context = await handler.query(new Request("http://localhost/app/ready-settings", init));
  if (context instanceof Response) throw new Error("unexpected redirect instead of data");

  const router = createStaticRouter(handler.dataRoutes, context);
  return renderToString(<StaticRouterProvider router={router} context={context} />);
}

/**
 * The markup a person actually sees.
 *
 * Two things have to go before asserting on displayed text:
 *
 *   `<!-- -->` — React emits a comment between adjacent JSX text nodes, so
 *   "10 × 7 × 4.2" is really `10<!-- --> × <!-- -->7<!-- --> × 4.2` in the
 *   HTML. Asserting on the raw string tests React's serialiser, not the page.
 *
 *   The hydration script — `__staticRouterHydrationData` carries the loader
 *   payload verbatim, micrometres and all. A check that the page never shows
 *   "10000" passes or fails on that JSON rather than on the table, which is
 *   the opposite of what it is for.
 */
function visible(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/g, " ")
    .replace(/<!--\s*-->/g, "");
}

describe("the empty state", () => {
  let html = "";
  beforeAll(async () => {
    html = await render([]);
  });

  it("renders at all", () => {
    // Guards the harness itself. If the SSR setup regresses to returning "",
    // every other assertion in this file becomes vacuous.
    expect(html.length).toBeGreaterThan(2000);
  });

  it("says plainly that nothing is recorded, and what that means", () => {
    // The launch state. It must not look like a broken table, and it should
    // say why every customer is being routed to Custom Jewelry.
    expect(html).toMatch(/No ready mountings are recorded yet/i);
    expect(html).toMatch(/routed to Custom Jewelry/i);
  });

  it("still renders the create form, which is the only way out of empty", () => {
    expect(html).toContain('name="shopifyVariantGid"');
    expect(html).toContain('name="shopifyProductGid"');
    expect(html).toContain('name="nominalLengthMm"');
    expect(html).toContain('name="nominalWidthMm"');
    expect(html).toContain('name="nominalDepthMm"');
    expect(html).toContain('name="shape"');
    expect(html).toContain('name="prongSetToleranceEligible"');
    expect(html).toContain('name="eligibleForSetYourOwnStone"');
    expect(html).toContain('name="isActive"');
    expect(html).toContain('name="vendorRangeSource"');
    for (const bound of ["minLengthMm", "maxLengthMm", "minWidthMm", "maxWidthMm"]) {
      expect(html).toContain(`name="${bound}"`);
    }
  });

  it("offers every shape the matcher knows", () => {
    for (const shape of ["round", "oval", "cushion", "princess", "emerald", "marquise"]) {
      expect(html).toContain(`value="${shape}"`);
    }
  });
});

describe("the list", () => {
  let html = "";
  beforeAll(async () => {
    html = await render([PRONG_OVAL, RANGED_INACTIVE]);
  });

  it("renders a row per mounting", () => {
    expect(html).toContain("222");
    expect(html).toContain("333");
    expect(html).toMatch(/oval/);
    expect(html).toMatch(/cushion/);
  });

  it("shows nominal dimensions in millimetres, not micrometres", () => {
    // The bug this catches is "10000 × 7000" on screen.
    expect(visible(html)).toContain("10 × 7 × 4.2");
    expect(visible(html)).toContain("9.5 × 9.5");
    expect(visible(html)).not.toContain("10000");
    expect(visible(html)).not.toContain("7000");
  });

  it("shows a vendor range in millimetres, both bounds on both axes", () => {
    expect(visible(html)).toContain("9.3–9.7 × 9.3–9.75");
  });

  it("renders no undefined, NaN or null anywhere a person can see", () => {
    expect(visible(html)).not.toMatch(/undefined|NaN|>null</);
  });

  it("renders an em dash where there is no vendor range", async () => {
    const rowless = visible(await render([PRONG_OVAL]));
    expect(rowless).toContain("—");
    expect(rowless).not.toMatch(/undefined|NaN/);
  });

  it("does NOT claim the ±0.3 mm allowance applies when a vendor range overrides it", () => {
    // RANGED_INACTIVE is flagged prong-adjustable AND has a published range.
    // The range wins at match time, so printing "yes" would misdescribe what
    // the matcher actually does.
    expect(html).toContain("n/a — vendor range");
  });

  it("shows the allowance as yes/no when no vendor range overrides it", async () => {
    const html2 = await render([PRONG_OVAL]);
    expect(html2).toMatch(/>yes</);
  });

  it("distinguishes active from withdrawn, naming the action", () => {
    expect(html).toMatch(/Active — withdraw/);
    expect(html).toMatch(/Inactive — restore/);
  });

  it("carries the record id on the toggle, so it acts on one row", () => {
    expect(html).toContain('value="row-1"');
    expect(html).toContain('value="row-2"');
    expect(html).toContain('value="toggle-active"');
  });

  it("shows both eligibility states legibly", () => {
    expect(html).toMatch(/>yes</);
    expect(html).toMatch(/>no</);
  });
});

describe("errors are shown against the fields that caused them", () => {
  let html = "";
  beforeAll(async () => {
    html = await render([], {
      formError: "Nothing was saved. Correct the fields below and submit again.",
      fieldErrors: {
        nominalWidthMm: "Width cannot exceed length — check whether these two are swapped.",
        vendorRangeSource: "Record where this range came from.",
      },
    });
  });

  it("renders the summary and each field message", () => {
    expect(html).toMatch(/Nothing was saved/);
    expect(html).toMatch(/check whether these two are swapped/);
    expect(html).toMatch(/Record where this range came from/);
  });

  it("marks the offending inputs invalid for assistive technology", () => {
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('id="nominalWidthMm-error"');
  });
});

describe("embedded layout", () => {
  let html = "";
  beforeAll(async () => {
    html = await render([PRONG_OVAL, RANGED_INACTIVE]);
  });

  it("confines the wide table to its own horizontal scroller", () => {
    // The embedded admin iframe is narrow. The table must scroll inside its
    // container rather than making the whole page scroll sideways.
    expect(html).toMatch(/overflow-x:auto|overflow-x:\s*auto/);
  });

  it("bounds the page width rather than letting it stretch", () => {
    expect(html).toMatch(/max-width:64rem|max-width:\s*64rem/);
  });

  it("states the matching rules it is collecting data for", () => {
    expect(html).toMatch(/±0\.3 mm/);
    expect(html).toMatch(/1\.0 mm/);
    expect(html).toMatch(/SET-YOUR-OWN-STONE\.md/);
  });

  it("never promises a fit", () => {
    expect(html).not.toMatch(/guaranteed fit/i);
  });
});
