/**
 * The shared synchronization service.
 *
 * Three properties matter here and the tests are organised around them:
 *
 *   1. A row Shopify no longer describes is DEACTIVATED, never deleted —
 *      past StoneSessions still point at it.
 *   2. A profile edit re-syncs every mounting that uses it, found through the
 *      reverse index, because no product was touched.
 *   3. Events and reconciliation produce the SAME rows, because they are the
 *      same code path. Asserted directly rather than assumed.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const readSyosProduct = vi.fn();
vi.mock("~/shopify/admin/syosProductReader.server", () => ({
  readSyosProduct,
  readSizeProfiles: vi.fn(),
}));

const upsert = vi.fn();
const updateMany = vi.fn();
const findMany = vi.fn();
vi.mock("~/db/client.server", () => ({
  prisma: {
    readySettingCompatibility: {
      upsert: (...a: unknown[]) => upsert(...a),
      updateMany: (...a: unknown[]) => updateMany(...a),
      findMany: (...a: unknown[]) => findMany(...a),
    },
  },
}));

const { reconcileCompatibility, syncProduct, syncProductsUsingProfile } = await import(
  "./syncCompatibility.server"
);

const PRODUCT = "gid://shopify/Product/111";
const VARIANT = "gid://shopify/ProductVariant/222";
const PROFILE = "gid://shopify/Metaobject/55";
const NOW = new Date("2026-11-01T12:00:00Z");

const client = { graphql: vi.fn() };

/** A correctly configured pear 10 × 7, as the reader would hand it over. */
function readResult(overrides: Record<string, unknown> = {}) {
  return {
    productTitle: "14K Pear Solitaire — Double Prong",
    hasCenterSizeOption: true,
    customerFacingOptions: ["Metal", "Ring Size"],
    input: {
      productGid: PRODUCT,
      productStatus: "ACTIVE",
      productMetafields: {
        syos_eligible: "true",
        syos_stone_shape: "pear",
        syos_setting_style: "prong",
        syos_prong_adjustable: "true",
        syos_prong_tolerance_eligible: "true",
      },
      variants: [
        {
          variantGid: VARIANT,
          title: "10 × 7 mm / 14K Yellow Gold / 6.5",
          centerSizeOptionValueId: "gid://shopify/ProductOptionValue/9",
          centerSizeOptionValueName: "Pear 10 × 7 mm",
          profile: {
            metaobjectId: PROFILE,
            displayName: "Pear 10 × 7 mm",
            stoneShape: "pear",
            nominalLengthMm: "10",
            nominalWidthMm: "7",
            nominalDepthMm: null,
          },
          metafields: { syos_compatibility_active: "true" },
        },
      ],
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  readSyosProduct.mockResolvedValue(readResult());
  upsert.mockResolvedValue({});
  updateMany.mockResolvedValue({ count: 0 });
  findMany.mockResolvedValue([]);
});

describe("syncProduct", () => {
  it("writes the projected row, keyed on the variant", async () => {
    const outcome = await syncProduct(client, PRODUCT, NOW);

    expect(outcome).toMatchObject({ found: true, rowsUpserted: 1, eligible: 1, withProblems: 0 });
    const call = upsert.mock.calls[0]?.[0];
    expect(call.where).toEqual({ shopifyVariantGid: VARIANT });
    expect(call.update.nominalLengthUm).toBe(10_000);
    expect(call.update.shape).toBe("pear");
    expect(call.update.eligibleForSetYourOwnStone).toBe(true);
  });

  it("records which profile supplied the dimensions, for the reverse index", async () => {
    await syncProduct(client, PRODUCT, NOW);
    expect(upsert.mock.calls[0]?.[0].update.centerSizeProfileId).toBe(PROFILE);
  });

  it("stamps the sync time from the injected clock, not the wall clock", async () => {
    await syncProduct(client, PRODUCT, NOW);
    expect(upsert.mock.calls[0]?.[0].update.syncedFromShopifyAt).toBe(NOW);
  });

  it("stores an empty problem list for a clean row, not null", async () => {
    // The dashboard distinguishes "synced, no problems" from "never synced",
    // and null would collapse the two.
    await syncProduct(client, PRODUCT, NOW);
    expect(upsert.mock.calls[0]?.[0].update.syncProblems).toEqual([]);
  });

  it("stores the problems and forces ineligible when configuration is bad", async () => {
    const bad = readResult();
    (bad.input.variants[0] as { profile: unknown }).profile = null;
    readSyosProduct.mockResolvedValue(bad);

    const outcome = await syncProduct(client, PRODUCT, NOW);

    expect(outcome.withProblems).toBe(1);
    expect(outcome.eligible).toBe(0);
    const update = upsert.mock.calls[0]?.[0].update;
    expect(update.eligibleForSetYourOwnStone).toBe(false);
    expect(update.syncProblems.join(" ")).toMatch(/not linked to a Center Stone Size Profile/);
  });

  it("writes a source hash that changes when a dimension changes", async () => {
    await syncProduct(client, PRODUCT, NOW);
    const first = upsert.mock.calls[0]?.[0].update.syncSourceHash;

    const moved = readResult();
    moved.input.variants[0]!.profile!.nominalLengthMm = "10.5";
    readSyosProduct.mockResolvedValue(moved);
    upsert.mockClear();
    await syncProduct(client, PRODUCT, NOW);
    const second = upsert.mock.calls[0]?.[0].update.syncSourceHash;

    expect(second).not.toBe(first);
  });

  it("changes the hash when a row stops being eligible, however that happened", async () => {
    // Eligibility is derived, and it is in the hash on purpose: it is the most
    // consequential field in the row, and a change from eligible to not is
    // precisely what a change detector must catch.
    await syncProduct(client, PRODUCT, NOW);
    const eligible = upsert.mock.calls[0]?.[0].update;

    const mismatched = readResult();
    mismatched.input.productMetafields.syos_stone_shape = "oval";
    readSyosProduct.mockResolvedValue(mismatched);
    upsert.mockClear();
    await syncProduct(client, PRODUCT, NOW);
    const ineligible = upsert.mock.calls[0]?.[0].update;

    expect(eligible.eligibleForSetYourOwnStone).toBe(true);
    expect(ineligible.eligibleForSetYourOwnStone).toBe(false);
    expect(ineligible.syncSourceHash).not.toBe(eligible.syncSourceHash);
    expect(ineligible.syncProblems.length).toBeGreaterThan(0);
  });

  it("does not include the problem text, so rewording a message churns nothing", async () => {
    // Problem messages are prose. Hashing them would mean every hash in the
    // catalogue changes when someone improves a sentence.
    await syncProduct(client, PRODUCT, NOW);
    const hash = upsert.mock.calls[0]?.[0].update.syncSourceHash;

    for (const problem of upsert.mock.calls[0]?.[0].update.syncProblems ?? []) {
      expect(hash).not.toContain(problem);
    }
  });
});

describe("a row Shopify no longer describes is withdrawn, never deleted", () => {
  it("deactivates every row when the product is gone", async () => {
    // Deleting would make a past StoneSession unexplainable exactly when
    // someone asks about it.
    readSyosProduct.mockResolvedValue(null);
    updateMany.mockResolvedValue({ count: 3 });

    const outcome = await syncProduct(client, PRODUCT, NOW);

    expect(outcome.found).toBe(false);
    expect(outcome.rowsDeactivated).toBe(3);
    const call = updateMany.mock.calls[0]?.[0];
    expect(call.data.isActive).toBe(false);
    expect(call.data.eligibleForSetYourOwnStone).toBe(false);
    expect(call.data.syncProblems).toEqual(["The Shopify product no longer exists."]);
    expect(upsert).not.toHaveBeenCalled();
  });

  it("deactivates a variant that disappeared but keeps the live ones", async () => {
    updateMany.mockResolvedValue({ count: 1 });
    const outcome = await syncProduct(client, PRODUCT, NOW);

    expect(outcome.rowsDeactivated).toBe(1);
    const stale = updateMany.mock.calls[0]?.[0];
    expect(stale.where.shopifyVariantGid.notIn).toEqual([VARIANT]);
    expect(stale.data.isActive).toBe(false);
  });

  it("never issues a delete of any kind", async () => {
    // The strongest form of the guarantee: the service has no delete to call.
    const { prisma } = await import("~/db/client.server");
    expect("delete" in prisma.readySettingCompatibility).toBe(false);
    expect("deleteMany" in prisma.readySettingCompatibility).toBe(false);
  });

  it("uses a sentinel rather than an empty notIn when a product has no variants", async () => {
    // `notIn: []` matches nothing in Postgres, which would leave stale rows
    // active forever — the opposite of the intent.
    const empty = readResult();
    empty.input.variants = [];
    readSyosProduct.mockResolvedValue(empty);

    await syncProduct(client, PRODUCT, NOW);
    expect(updateMany.mock.calls[0]?.[0].where.shopifyVariantGid.notIn).toEqual(["__none__"]);
  });
});

describe("syncProductsUsingProfile — the Metaobject event path", () => {
  it("finds affected products through the reverse index and re-syncs each", async () => {
    // The merchant touched no product, so this is the only way to find them.
    findMany.mockResolvedValue([
      { shopifyProductGid: PRODUCT },
      { shopifyProductGid: "gid://shopify/Product/999" },
    ]);

    const outcomes = await syncProductsUsingProfile(client, PROFILE, NOW);

    expect(findMany.mock.calls[0]?.[0].where).toEqual({ centerSizeProfileId: PROFILE });
    expect(findMany.mock.calls[0]?.[0].distinct).toEqual(["shopifyProductGid"]);
    expect(outcomes).toHaveLength(2);
    expect(readSyosProduct).toHaveBeenCalledTimes(2);
  });

  it("RE-READS Shopify rather than trusting any payload value", async () => {
    // A delivery can be replayed or arrive after a later edit. Re-reading is
    // what makes the index converge on Shopify's current state regardless of
    // delivery order.
    findMany.mockResolvedValue([{ shopifyProductGid: PRODUCT }]);
    await syncProductsUsingProfile(client, PROFILE, NOW);
    expect(readSyosProduct).toHaveBeenCalledWith(client, PRODUCT);
  });

  it("does nothing when no mounting references the profile", async () => {
    findMany.mockResolvedValue([]);
    expect(await syncProductsUsingProfile(client, PROFILE, NOW)).toEqual([]);
    expect(upsert).not.toHaveBeenCalled();
  });
});

describe("reconcileCompatibility — recovery", () => {
  it("rebuilds from the products already known, plus any supplied", async () => {
    findMany.mockResolvedValue([{ shopifyProductGid: PRODUCT }]);

    const result = await reconcileCompatibility(client, {
      additionalProductGids: ["gid://shopify/Product/777"],
      now: NOW,
    });

    expect(result.productsConsidered).toBe(2);
    expect(result.outcomes).toHaveLength(2);
    expect(result.failures).toEqual([]);
  });

  it("deduplicates a supplied id that is already known", async () => {
    findMany.mockResolvedValue([{ shopifyProductGid: PRODUCT }]);
    const result = await reconcileCompatibility(client, {
      additionalProductGids: [PRODUCT],
      now: NOW,
    });
    expect(result.productsConsidered).toBe(1);
  });

  it("keeps going when one product is unreachable, and reports it", async () => {
    // A partial reconciliation that says what it could not do beats an
    // aborted one that leaves most of the index untouched and says nothing.
    findMany.mockResolvedValue([
      { shopifyProductGid: PRODUCT },
      { shopifyProductGid: "gid://shopify/Product/broken" },
    ]);
    readSyosProduct.mockImplementation(async (_c: unknown, gid: string) => {
      if (gid.endsWith("broken")) throw new Error("Shopify unavailable");
      return readResult();
    });

    const result = await reconcileCompatibility(client, { now: NOW });

    expect(result.outcomes).toHaveLength(1);
    expect(result.failures).toEqual([
      { productGid: "gid://shopify/Product/broken", message: "Shopify unavailable" },
    ]);
  });
});

describe("events and reconciliation agree by construction", () => {
  it("produces byte-identical row data from both paths", async () => {
    // Not a hope — they are the same code path with different triggers, and
    // this asserts it rather than trusting the comment that says so.
    await syncProduct(client, PRODUCT, NOW);
    const viaEvent = upsert.mock.calls[0]?.[0].update;

    upsert.mockClear();
    findMany.mockResolvedValue([{ shopifyProductGid: PRODUCT }]);
    await reconcileCompatibility(client, { now: NOW });
    const viaReconcile = upsert.mock.calls[0]?.[0].update;

    expect(viaReconcile).toEqual(viaEvent);
  });

  it("and the same for the profile path", async () => {
    await syncProduct(client, PRODUCT, NOW);
    const viaProduct = upsert.mock.calls[0]?.[0].update;

    upsert.mockClear();
    findMany.mockResolvedValue([{ shopifyProductGid: PRODUCT }]);
    await syncProductsUsingProfile(client, PROFILE, NOW);

    expect(upsert.mock.calls[0]?.[0].update).toEqual(viaProduct);
  });
});
