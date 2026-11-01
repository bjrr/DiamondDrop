/**
 * The ready-mount admin screen.
 *
 * Covers the two things a unit test on the input module cannot: that the route
 * refuses bad input WITHOUT WRITING ANYTHING, and that withdrawal is a
 * deactivation rather than a delete.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/lib/env.server", () => ({
  getEnv: () => ({ SHOPIFY_API_KEY: "test-key" }),
}));

vi.mock("~/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const authenticateAdmin = vi.fn();
vi.mock("~/shopify.server", () => ({
  authenticate: { admin: authenticateAdmin },
}));

const listReadySettings = vi.fn();
const findReadySettingById = vi.fn();
const upsertReadySetting = vi.fn();
const setReadySettingActive = vi.fn();

vi.mock("~/db/repositories/readySettingWrites.server", () => ({
  listReadySettings,
  findReadySettingById,
  upsertReadySetting,
  setReadySettingActive,
}));

const { action, loader } = await import("./app.ready-settings._index");

const ROW = {
  id: "row-1",
  shopifyProductGid: "gid://shopify/Product/111",
  shopifyVariantGid: "gid://shopify/ProductVariant/222",
  shape: "oval",
  nominalLengthUm: 10_000,
  nominalWidthUm: 7_000,
  nominalDepthUm: null,
  minLengthUm: null,
  maxLengthUm: null,
  minWidthUm: null,
  maxWidthUm: null,
  vendorRangeSource: null,
  eligibleForSetYourOwnStone: true,
  prongSetToleranceEligible: true,
  isActive: true,
};

function post(fields: Record<string, string>): Request {
  const body = new URLSearchParams(fields);
  return new Request("https://app.example.com/app/ready-settings", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
}

const VALID_FORM = {
  intent: "save",
  shopifyProductGid: "gid://shopify/Product/111",
  shopifyVariantGid: "gid://shopify/ProductVariant/222",
  shape: "oval",
  nominalLengthMm: "10",
  nominalWidthMm: "7",
  eligibleForSetYourOwnStone: "on",
  prongSetToleranceEligible: "on",
  isActive: "on",
};

beforeEach(() => {
  vi.clearAllMocks();
  authenticateAdmin.mockResolvedValue({ session: { shop: "test.myshopify.com" } });
  listReadySettings.mockResolvedValue([]);
  findReadySettingById.mockResolvedValue(ROW);
  upsertReadySetting.mockImplementation(async (input) => ({ ...ROW, ...input }));
  setReadySettingActive.mockImplementation(async (id, isActive) => ({ ...ROW, id, isActive }));
});

describe("authentication", () => {
  it("authenticates the admin before reading anything", async () => {
    await loader({ request: new Request("https://app.example.com/app/ready-settings") } as never);
    expect(authenticateAdmin).toHaveBeenCalled();
  });

  it("authenticates before writing anything", async () => {
    // If `authenticate.admin` rejects, nothing downstream may run. Ordering
    // matters more than the error: a write that happens before the check is
    // an unauthenticated write.
    authenticateAdmin.mockRejectedValue(new Response(null, { status: 302 }));
    await expect(action({ request: post(VALID_FORM) } as never)).rejects.toBeDefined();
    expect(upsertReadySetting).not.toHaveBeenCalled();
  });
});

describe("saving a mounting", () => {
  it("stores integer micrometres, converted from the operator's millimetres", async () => {
    await action({ request: post({ ...VALID_FORM, nominalLengthMm: "10.25", nominalWidthMm: "7.08" }) } as never);

    const input = upsertReadySetting.mock.calls[0]?.[0];
    expect(input.nominalLengthUm).toBe(10_250);
    expect(input.nominalWidthUm).toBe(7_080);
  });

  it("writes NOTHING when any field is invalid", async () => {
    // Partial saves are the failure that matters here: a row with a good
    // length and a defaulted width would match confidently and wrongly.
    const response = await action({ request: post({ ...VALID_FORM, nominalWidthMm: "abc" }) } as never);

    expect(response.status).toBe(200);
    const payload = await response.json();
    expect(payload.fieldErrors).toHaveProperty("nominalWidthMm");
    expect(payload.formError).toMatch(/nothing was saved/i);
    expect(upsertReadySetting).not.toHaveBeenCalled();
  });

  it("carries the prong flag through exactly as ticked", async () => {
    const { prongSetToleranceEligible, ...unticked } = VALID_FORM;
    await action({ request: post(unticked) } as never);
    expect(upsertReadySetting.mock.calls[0]?.[0].prongSetToleranceEligible).toBe(false);
  });

  it("refuses an unrecognised intent rather than guessing", async () => {
    const response = await action({ request: post({ ...VALID_FORM, intent: "delete-everything" }) } as never);
    expect((await response.json()).formError).toBeDefined();
    expect(upsertReadySetting).not.toHaveBeenCalled();
    expect(setReadySettingActive).not.toHaveBeenCalled();
  });
});

describe("withdrawing a mounting", () => {
  it("deactivates rather than deletes, and flips the current state", async () => {
    const response = await action({ request: post({ intent: "toggle-active", id: "row-1" }) } as never);

    expect(setReadySettingActive).toHaveBeenCalledWith("row-1", false);
    expect((await response.json()).saved).toMatch(/now inactive/i);
  });

  it("restores an inactive record", async () => {
    findReadySettingById.mockResolvedValue({ ...ROW, isActive: false });
    await action({ request: post({ intent: "toggle-active", id: "row-1" }) } as never);
    expect(setReadySettingActive).toHaveBeenCalledWith("row-1", true);
  });

  it("reports a missing record instead of throwing", async () => {
    findReadySettingById.mockResolvedValue(null);
    const response = await action({ request: post({ intent: "toggle-active", id: "gone" }) } as never);
    expect((await response.json()).formError).toMatch(/no longer exists/i);
    expect(setReadySettingActive).not.toHaveBeenCalled();
  });
});
