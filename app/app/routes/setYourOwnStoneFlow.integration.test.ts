/**
 * Set Your Own Stone — the whole flow, end to end across the route layer.
 *
 * Authoritative requirements: docs/SET-YOUR-OWN-STONE.md §8, §9, §10, §11.
 *
 * ---------------------------------------------------------------------------
 * WHAT THIS COVERS THAT THE UNIT TESTS CANNOT
 * ---------------------------------------------------------------------------
 * `matching.test.ts` proves the rules are right. These tests prove the rules
 * are the ones actually reaching the customer, through three separate HTTP
 * endpoints and a reference that has to survive the jump between two pages:
 *
 *   create → match → select → resume → hand off to Custom Jewelry
 *
 * THE PROXY SIGNATURE IS REAL HERE, NOT MOCKED. `verifyAppProxySignature` is
 * the trust boundary for every one of these routes, and a test that stubs it
 * out proves the handler works for callers who are already trusted — which is
 * not the interesting population. Signing with the real HMAC means an
 * unsigned or tampered request fails the way it would in production, and the
 * `logged_in_customer_id` the ownership checks depend on is the signed one.
 *
 * The repository layer IS mocked, because there is no local Postgres and the
 * migrations are unapplied. That is a real limit on these tests: they verify
 * the routes compose the domain service and persistence correctly, not that
 * the SQL runs. The CHECK constraints in the migrations remain unexercised
 * until a database exists.
 */
import { createHmac } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-proxy-secret";
const SHOP = "caratforus-test.myshopify.com";

vi.mock("~/lib/env.server", () => ({
  getEnv: () => ({
    SHOPIFY_API_SECRET: SECRET,
    SHOPIFY_SHOP_DOMAIN: SHOP,
  }),
}));

vi.mock("~/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const createStoneSession = vi.fn();
const findStoneSessionByReference = vi.fn();
const recordSettingSelection = vi.fn();
const markHandedToCustom = vi.fn();

vi.mock("~/db/repositories/stoneSessionRepository.server", async () => {
  const actual = await vi.importActual<
    typeof import("~/db/repositories/stoneSessionRepository.server")
  >("~/db/repositories/stoneSessionRepository.server");
  return {
    // `toStoneSessionView` is a pure projection, so the real one is used: it
    // is part of what the storefront receives and worth asserting against.
    toStoneSessionView: actual.toStoneSessionView,
    createStoneSession,
    findStoneSessionByReference,
    recordSettingSelection,
    markHandedToCustom,
  };
});

const findEligibleSettingsForShape = vi.fn();
const findSettingByVariantGid = vi.fn();

vi.mock("~/db/repositories/readySettingRepository.server", () => ({
  findEligibleSettingsForShape,
  findSettingByVariantGid,
}));

/**
 * The owner-configurable matching policy, swappable per test.
 *
 * `resolveMatchingPolicy` ships returning both dials at zero, and that is the
 * state the storefront launches in. A few tests below need to see what
 * happens once the owner opens a review band, so this stands in for that
 * future decision without pretending it has already been made.
 */
const policy = vi.hoisted(() => ({
  current: { approvedToleranceUmByShape: {}, reviewBandUm: 0 } as {
    approvedToleranceUmByShape: Record<string, number>;
    reviewBandUm: number;
  },
}));

vi.mock("~/domain/setyourownstone/policy.server", () => ({
  resolveMatchingPolicy: async () => policy.current,
}));

const { action: createAction } = await import("./apps.carat.stone-session");
const { action: selectAction } = await import("./apps.carat.stone-setting-select");

// --------------------------------------------------------------------- signing

/** The real App Proxy signing algorithm, so these requests are indistinguishable
 *  from Shopify's own. */
function signedUrl(path: string, extra: Record<string, string> = {}): string {
  const params: Record<string, string> = {
    shop: SHOP,
    path_prefix: "/apps/carat",
    timestamp: "1762000000",
    ...extra,
  };
  const message = Object.keys(params)
    .sort()
    .map((key) => `${key}=${params[key]}`)
    .join("");
  const signature = createHmac("sha256", SECRET).update(message, "utf8").digest("hex");

  const sp = new URLSearchParams(params);
  sp.set("signature", signature);
  return `https://app.example.com${path}?${sp.toString()}`;
}

/** The nth call's first argument, asserting the call happened.
 *
 *  `mock.calls[n][0]` is the obvious spelling, but under `noUncheckedIndexedAccess`
 *  it is also two possibly-undefined accesses, and silently reading
 *  `undefined.compatibilityStatus` would fail with a confusing TypeError
 *  instead of "the route never called the repository". */
function callArg(fn: { mock: { calls: unknown[][] } }, nth = 0): Record<string, unknown> {
  const call = fn.mock.calls[nth];
  expect(call, `expected at least ${nth + 1} call(s)`).toBeDefined();
  return call![0] as Record<string, unknown>;
}

function post(path: string, body: unknown, extra: Record<string, string> = {}): Request {
  return new Request(signedUrl(path, extra), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// ----------------------------------------------------------------- fixtures

/** A 2.34 ct oval: 10.12 × 7.08 mm. */
const OVAL_BODY = {
  stoneType: "natural_diamond" as const,
  shape: "oval" as const,
  caratWeight: "2.34",
  lengthMm: "10.12",
  widthMm: "7.08",
  depthMm: "4.55",
  mountedState: "LOOSE" as const,
};

const STORED_OVAL = {
  id: "cuid-session-1",
  sessionReference: "SYS-7KQ2M4XB",
  customerRef: null,
  status: "describing",
  stoneType: "natural_diamond",
  shape: "oval",
  caratWeight: "2.34",
  lengthUm: 10120,
  widthUm: 7080,
  depthUm: 4550,
  certLab: null,
  certNumber: null,
  mountedState: "LOOSE",
  stoneRemovalSelected: false,
  notes: null,
  selectedProductGid: null,
  selectedVariantGid: null,
  selectedOptions: null,
  compatibilityStatus: null,
  compatibilityRule: null,
  createdAt: new Date("2026-10-31T12:00:00Z"),
  updatedAt: new Date("2026-10-31T12:00:00Z"),
};

/** An exact-nominal oval setting: the one case that is an unambiguous yes. */
const EXACT_SETTING = {
  id: "cuid-setting-1",
  shopifyProductGid: "gid://shopify/Product/111",
  shopifyVariantGid: "gid://shopify/Variant/222",
  shape: "oval",
  nominalLengthUm: 10120,
  nominalWidthUm: 7080,
  // UNDEFINED, NOT NULL. These fixtures stand in for what the repository
  // hands the domain, and it converts Prisma's nulls to undefined precisely
  // so "no vendor range" and "a range with missing halves" stay
  // distinguishable. Writing null here would be testing a shape the domain
  // is never given.
  minLengthUm: undefined,
  maxLengthUm: undefined,
  minWidthUm: undefined,
  maxWidthUm: undefined,
  eligibleForSetYourOwnStone: true,
};

/**
 * 0.3 mm off nominal with no vendor range and no approved tolerance.
 *
 * Under the shipping policy — both dials at zero, §6.2's strictest reading —
 * this is `no_match`, because a zero review band means nothing is "near
 * enough to look at" on the strength of a tolerance this system invented.
 * It becomes `review_required` only once the owner sets a band, which the
 * test below exercises explicitly. The one thing it can never be is an
 * automatic match, and that is what §5 is actually insisting on.
 */
const NEAR_SETTING = {
  ...EXACT_SETTING,
  id: "cuid-setting-2",
  shopifyVariantGid: "gid://shopify/Variant/333",
  nominalLengthUm: 10420,
  nominalWidthUm: 7080,
};

beforeEach(() => {
  vi.clearAllMocks();
  // Back to the shipping policy before every test, so one test opening a
  // review band cannot quietly loosen the next one.
  policy.current = { approvedToleranceUmByShape: {}, reviewBandUm: 0 };
  createStoneSession.mockResolvedValue(STORED_OVAL);
  findStoneSessionByReference.mockResolvedValue(STORED_OVAL);
  findEligibleSettingsForShape.mockResolvedValue([]);
  findSettingByVariantGid.mockResolvedValue(EXACT_SETTING);
  recordSettingSelection.mockImplementation(async (input: Record<string, unknown>) => ({
    ...STORED_OVAL,
    ...input,
    status: "setting_selected",
  }));
  markHandedToCustom.mockResolvedValue({ ...STORED_OVAL, status: "handed_to_custom" });
});

// =========================================================== the trust boundary

describe("Set Your Own Stone — the trust boundary (§11)", () => {
  it("rejects an unsigned session request", async () => {
    const request = new Request("https://app.example.com/apps/carat/stone-session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(OVAL_BODY),
    });

    const response = await createAction({ request } as never);

    expect(response.status).toBe(401);
    expect(createStoneSession).not.toHaveBeenCalled();
  });

  it("rejects a request whose customer id was tampered with after signing", async () => {
    // Signed for customer 1, then rewritten to claim customer 999. The HMAC
    // covers logged_in_customer_id, so this must not verify.
    const url = new URL(signedUrl("/apps/carat/stone-session", { logged_in_customer_id: "1" }));
    url.searchParams.set("logged_in_customer_id", "999");

    const response = await createAction({
      request: new Request(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(OVAL_BODY),
      }),
    } as never);

    expect(response.status).toBe(401);
  });

  it("ignores a compatibility status supplied in the selection request", async () => {
    // The body claims the near-size setting is an automatic match. `.strict()`
    // refuses the unknown key outright; what matters is that no path exists
    // for a client-asserted verdict to be stored.
    findSettingByVariantGid.mockResolvedValue(NEAR_SETTING);

    const response = await selectAction({
      request: post("/apps/carat/stone-setting-select", {
        sessionReference: STORED_OVAL.sessionReference,
        variantGid: NEAR_SETTING.shopifyVariantGid,
        productGid: NEAR_SETTING.shopifyProductGid,
        compatibilityStatus: "automatic",
      }),
    } as never);

    expect(response.status).toBe(400);
    expect(recordSettingSelection).not.toHaveBeenCalled();
  });

  it("derives the stored verdict from the database, not the request", async () => {
    // The stored stone is 0.3 mm off this setting's nominal size, and under
    // the shipping policy that is a plain no. Recorded honestly rather than
    // refused: staff review every project, and "they chose this and it did
    // not match" is more useful to them than a 400 (§8).
    findSettingByVariantGid.mockResolvedValue(NEAR_SETTING);

    const response = await selectAction({
      request: post("/apps/carat/stone-setting-select", {
        sessionReference: STORED_OVAL.sessionReference,
        variantGid: NEAR_SETTING.shopifyVariantGid,
        productGid: NEAR_SETTING.shopifyProductGid,
      }),
    } as never);

    expect(response.status).toBe(200);
    const recorded = callArg(recordSettingSelection);
    expect(recorded.compatibilityStatus).toBe("no_match");

    const payload = await response.json();
    expect(payload.compatibility.status).toBe("no_match");
    expect(payload.compatibility.label).not.toMatch(/fits|guaranteed/i);
  });
});

// ================================================================ create + match

describe("create → match (§4, §5, §10)", () => {
  it("returns the session reference and an exact match for an exact-size setting", async () => {
    findEligibleSettingsForShape.mockResolvedValue([EXACT_SETTING]);

    const response = await createAction({
      request: post("/apps/carat/stone-session", OVAL_BODY),
    } as never);

    expect(response.status).toBe(200);
    const payload = await response.json();

    expect(payload.session.sessionReference).toBe("SYS-7KQ2M4XB");
    expect(payload.matches.automatic).toHaveLength(1);
    expect(payload.matches.reviewRequired).toHaveLength(0);
    expect(payload.matches.customRecommended).toBe(false);
    expect(payload.qualifier).toMatch(/confirm compatibility before you send/i);
    // Round-tripped through integer micrometres and back.
    expect(payload.display.lengthMm).toBe("10.12");
    expect(payload.display.widthMm).toBe("7.08");
  });

  it("never reaches the matcher with carat weight", async () => {
    findEligibleSettingsForShape.mockResolvedValue([EXACT_SETTING]);

    await createAction({ request: post("/apps/carat/stone-session", OVAL_BODY) } as never);

    // Carat is persisted for display and staff review...
    expect(callArg(createStoneSession).caratWeight).toBe("2.34");
    // ...and the matcher's input type has no field for it, so there is nowhere
    // for it to go. Asserted on the stored shape as the readable form of §15.5.
    const stored = callArg(createStoneSession);
    expect(stored.lengthUm).toBe(10120);
    expect(stored.widthUm).toBe(7080);
  });

  it("never surfaces a near-size setting as a match under the shipping policy", async () => {
    findEligibleSettingsForShape.mockResolvedValue([NEAR_SETTING]);

    const payload = await (
      await createAction({ request: post("/apps/carat/stone-session", OVAL_BODY) } as never)
    ).json();

    // Zero review band: 0.3 mm off nominal is not offered at all, and the
    // customer is sent to the custom path instead of being shown a setting
    // whose fit we invented a tolerance to justify.
    expect(payload.matches.automatic).toHaveLength(0);
    expect(payload.matches.reviewRequired).toHaveLength(0);
    expect(payload.matches.customRecommended).toBe(true);
  });

  it("surfaces it as review required — never a match — once the owner opens a band", async () => {
    // 0.5 mm band: wide enough to reach the 0.3 mm deviation. The point is
    // what it CANNOT do — widening the band moves a setting into review, and
    // nothing short of an exact size or a published vendor range can make it
    // automatic (§5, §6.2).
    policy.current = { approvedToleranceUmByShape: {}, reviewBandUm: 500 };
    findEligibleSettingsForShape.mockResolvedValue([NEAR_SETTING]);

    const payload = await (
      await createAction({ request: post("/apps/carat/stone-session", OVAL_BODY) } as never)
    ).json();

    expect(payload.matches.automatic).toHaveLength(0);
    expect(payload.matches.reviewRequired).toHaveLength(1);
    expect(payload.matches.reviewRequired[0].label).not.toMatch(/fits|guaranteed/i);
  });

  it("recommends the custom path when nothing qualifies — the launch state (§6.4)", async () => {
    findEligibleSettingsForShape.mockResolvedValue([]);

    const payload = await (
      await createAction({ request: post("/apps/carat/stone-session", OVAL_BODY) } as never)
    ).json();

    expect(payload.matches.customRecommended).toBe(true);
    // A session still exists, so the reference can carry into Custom Jewelry
    // even though no ready setting was offered.
    expect(payload.session.sessionReference).toBe("SYS-7KQ2M4XB");
  });

  it("filters by shape in the query, so a mismatched shape is never scored", async () => {
    findEligibleSettingsForShape.mockResolvedValue([EXACT_SETTING]);

    await createAction({
      request: post("/apps/carat/stone-session", { ...OVAL_BODY, shape: "pear" }),
    } as never);

    expect(findEligibleSettingsForShape).toHaveBeenCalledWith("pear");
  });

  it("refuses swapped length and width with a message that says so", async () => {
    const response = await createAction({
      request: post("/apps/carat/stone-session", {
        ...OVAL_BODY,
        lengthMm: "7.08",
        widthMm: "10.12",
      }),
    } as never);

    expect(response.status).toBe(400);
    expect((await response.json()).message).toMatch(/swapped/i);
    expect(createStoneSession).not.toHaveBeenCalled();
  });

  it("refuses a millimetre value with more precision than we measure", async () => {
    const response = await createAction({
      request: post("/apps/carat/stone-session", { ...OVAL_BODY, lengthMm: "10.12345" }),
    } as never);

    expect(response.status).toBe(400);
    expect(createStoneSession).not.toHaveBeenCalled();
  });

  it("stores no customer reference for an anonymous visitor, and the signed one otherwise", async () => {
    await createAction({ request: post("/apps/carat/stone-session", OVAL_BODY) } as never);
    expect(callArg(createStoneSession).customerRef).toBeNull();

    await createAction({
      request: post("/apps/carat/stone-session", OVAL_BODY, { logged_in_customer_id: "4242" }),
    } as never);
    expect(callArg(createStoneSession, 1).customerRef).toBe(
      "gid://shopify/Customer/4242"
    );
  });
});

// ===================================================== select, resume, ownership

describe("select → resume (§8, §10)", () => {
  it("records the selection against the same session and reports the next step", async () => {
    const response = await selectAction({
      request: post("/apps/carat/stone-setting-select", {
        sessionReference: STORED_OVAL.sessionReference,
        variantGid: EXACT_SETTING.shopifyVariantGid,
        productGid: EXACT_SETTING.shopifyProductGid,
        selectedOptions: { Metal: "18k yellow gold", Size: "6.5" },
      }),
    } as never);

    expect(response.status).toBe(200);
    const recorded = callArg(recordSettingSelection);
    expect(recorded.sessionReference).toBe("SYS-7KQ2M4XB");
    expect(recorded.selectedOptions).toEqual({ Metal: "18k yellow gold", Size: "6.5" });
    expect(recorded.compatibilityStatus).toBe("automatic");

    const payload = await response.json();
    expect(payload.nextStep).toMatch(/before you send us your stone/i);
  });

  it("refuses a session reference that does not exist", async () => {
    findStoneSessionByReference.mockResolvedValue(null);

    const response = await selectAction({
      request: post("/apps/carat/stone-setting-select", {
        sessionReference: "SYS-NOTREAL",
        variantGid: EXACT_SETTING.shopifyVariantGid,
        productGid: EXACT_SETTING.shopifyProductGid,
      }),
    } as never);

    expect(response.status).toBe(400);
    expect(recordSettingSelection).not.toHaveBeenCalled();
  });

  it("refuses a setting that is not registered for Set Your Own Stone", async () => {
    findSettingByVariantGid.mockResolvedValue(null);

    const response = await selectAction({
      request: post("/apps/carat/stone-setting-select", {
        sessionReference: STORED_OVAL.sessionReference,
        variantGid: "gid://shopify/Variant/999999",
        productGid: EXACT_SETTING.shopifyProductGid,
      }),
    } as never);

    expect(response.status).toBe(400);
    expect(recordSettingSelection).not.toHaveBeenCalled();
  });

  it("lets another visitor act on an anonymous session, but not on an owned one", async () => {
    // Anonymous sessions stay claimable — the customer who described the stone
    // may not have been signed in when they did it.
    const anonymous = await selectAction({
      request: post(
        "/apps/carat/stone-setting-select",
        {
          sessionReference: STORED_OVAL.sessionReference,
          variantGid: EXACT_SETTING.shopifyVariantGid,
          productGid: EXACT_SETTING.shopifyProductGid,
        },
        { logged_in_customer_id: "777" }
      ),
    } as never);
    expect(anonymous.status).toBe(200);

    // Once a session belongs to someone, a different signed-in customer is
    // refused — a guessed reference must not expose another person's stone.
    findStoneSessionByReference.mockResolvedValue({
      ...STORED_OVAL,
      customerRef: "gid://shopify/Customer/4242",
    });

    const impostor = await selectAction({
      request: post(
        "/apps/carat/stone-setting-select",
        {
          sessionReference: STORED_OVAL.sessionReference,
          variantGid: EXACT_SETTING.shopifyVariantGid,
          productGid: EXACT_SETTING.shopifyProductGid,
        },
        { logged_in_customer_id: "777" }
      ),
    } as never);
    expect(impostor.status).toBe(403);
  });
});

// ================================================================= copy discipline

describe("what the customer is told (§13)", () => {
  it("never promises a fit, insurance, appraisal or inscription check", async () => {
    findEligibleSettingsForShape.mockResolvedValue([EXACT_SETTING, NEAR_SETTING]);

    const created = await (
      await createAction({ request: post("/apps/carat/stone-session", OVAL_BODY) } as never)
    ).json();
    const selected = await (
      await selectAction({
        request: post("/apps/carat/stone-setting-select", {
          sessionReference: STORED_OVAL.sessionReference,
          variantGid: EXACT_SETTING.shopifyVariantGid,
          productGid: EXACT_SETTING.shopifyProductGid,
        }),
      } as never)
    ).json();

    const everythingTheCustomerSees = JSON.stringify(created) + JSON.stringify(selected);
    for (const banned of [
      /guaranteed fit/i,
      /guarantee[sd]? (?:a )?fit/i,
      /insur/i,
      /apprais/i,
      /inscription/i,
      /chain of custody/i,
    ]) {
      expect(everythingTheCustomerSees).not.toMatch(banned);
    }
  });

  it("leaks no rule internals — no tolerance, no vendor range", async () => {
    findEligibleSettingsForShape.mockResolvedValue([EXACT_SETTING]);

    const payload = await (
      await createAction({ request: post("/apps/carat/stone-session", OVAL_BODY) } as never)
    ).json();

    const candidate = payload.matches.automatic[0];
    expect(Object.keys(candidate).sort()).toEqual([
      "label",
      "nominalLengthMm",
      "nominalWidthMm",
      "status",
      "variantGid",
    ]);
  });
});
