/**
 * The two Set Your Own Stone event handlers.
 *
 * The property these tests exist to defend: THE PAYLOAD IS A TRIGGER, NOT A
 * DATA SOURCE. Each subscription's custom query returns usable-looking
 * dimensions, and using them would be faster and wrong — a delivery can be
 * replayed or arrive after a later edit, so a payload-derived write records
 * whatever Shopify's state was at some arbitrary past moment. Several tests
 * below hand the handler a payload whose numbers contradict Shopify and assert
 * that Shopify wins.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("~/lib/logger.server", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const syncProduct = vi.fn();
const syncProductsUsingProfile = vi.fn();
vi.mock("~/jobs/setyourownstone/syncCompatibility.server", () => ({
  syncProduct,
  syncProductsUsingProfile,
}));

const adminClientForShop = vi.fn();
vi.mock("~/shopify/admin/offlineClient.server", () => ({ adminClientForShop }));

const { handleSyosProductEvent, handleSyosProfileEvent } = await import(
  "./syosEventHandlers.server"
);

const PRODUCT = "gid://shopify/Product/111";
const PROFILE = "gid://shopify/Metaobject/55";
const SHOP = "nnb1th-cm.myshopify.com";
const CLIENT = { graphql: vi.fn() };

function event(payload: unknown, shopDomain: string | null = SHOP) {
  return {
    shopifyEventId: "evt-1",
    topic: "Product",
    shopDomain,
    rawBody: JSON.stringify(payload),
    payload,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  adminClientForShop.mockResolvedValue(CLIENT);
  syncProduct.mockResolvedValue({ productGid: PRODUCT, found: true, rowsUpserted: 1 });
  syncProductsUsingProfile.mockResolvedValue([{ productGid: PRODUCT, found: true }]);
});

describe("Product events", () => {
  it("syncs the product named in the delivery", async () => {
    await handleSyosProductEvent(
      event({
        topic: "Product",
        action: "update",
        data: { product: { id: PRODUCT } },
        fields_changed: { updated: ["product.metafield[namespace: 'carat', key: 'syos_eligible']"] },
      })
    );

    expect(syncProduct).toHaveBeenCalledWith(CLIENT, PRODUCT);
  });

  it("uses the DELIVERED shop, not a configured one", async () => {
    // The app is installed on two stores. Syncing a dev-store change against
    // the production token would read the wrong catalogue.
    await handleSyosProductEvent(
      event({ data: { product: { id: PRODUCT } } }, "caratforus-dev.myshopify.com")
    );
    expect(adminClientForShop).toHaveBeenCalledWith("caratforus-dev.myshopify.com");
  });

  it("accepts a delivery with no product id rather than retrying forever", async () => {
    // Returning without throwing marks it processed, which is right: a retry
    // will not conjure a product id.
    await expect(handleSyosProductEvent(event({ action: "update", data: {} }))).resolves.toBeUndefined();
    expect(syncProduct).not.toHaveBeenCalled();
  });

  it("accepts a delivery with no shop domain", async () => {
    await expect(
      handleSyosProductEvent(event({ data: { product: { id: PRODUCT } } }, null))
    ).resolves.toBeUndefined();
    expect(syncProduct).not.toHaveBeenCalled();
  });

  it("THROWS when there is no session, so Shopify retries after a reinstall", async () => {
    // Distinct from the cases above: this one a retry can genuinely fix, and
    // swallowing it would drop a real compatibility change.
    adminClientForShop.mockResolvedValue(null);
    await expect(handleSyosProductEvent(event({ data: { product: { id: PRODUCT } } }))).rejects.toThrow(
      /no offline Shopify session/
    );
  });

  it("tolerates a payload with no fields_changed at all", async () => {
    await handleSyosProductEvent(event({ data: { product: { id: PRODUCT } } }));
    expect(syncProduct).toHaveBeenCalled();
  });
});

describe("Metaobject events — the delivery that prevents a false match", () => {
  it("re-syncs every mounting using the changed profile", async () => {
    await handleSyosProfileEvent(
      event({
        topic: "Metaobject",
        action: "update",
        data: { metaobject: { id: PROFILE, type: "$app:syos_center_size_profile" } },
        fields_changed: {
          updated: ["metaobject[...].field[key: 'nominal_length_mm']"],
        },
      })
    );

    expect(syncProductsUsingProfile).toHaveBeenCalledWith(CLIENT, PROFILE);
  });

  it("refuses a metaobject of the wrong type instead of acting on it", async () => {
    // Re-projecting against something that is not a size profile would write
    // nonsense dimensions.
    await handleSyosProfileEvent(
      event({ data: { metaobject: { id: PROFILE, type: "$app:something_else" } } })
    );
    expect(syncProductsUsingProfile).not.toHaveBeenCalled();
  });

  it("proceeds when the type is absent, since the subscription is type-scoped", async () => {
    await handleSyosProfileEvent(event({ data: { metaobject: { id: PROFILE } } }));
    expect(syncProductsUsingProfile).toHaveBeenCalledWith(CLIENT, PROFILE);
  });

  it("accepts a delivery with no metaobject id", async () => {
    await expect(handleSyosProfileEvent(event({ data: {} }))).resolves.toBeUndefined();
    expect(syncProductsUsingProfile).not.toHaveBeenCalled();
  });

  it("is content when no mounting references the profile yet", async () => {
    syncProductsUsingProfile.mockResolvedValue([]);
    await expect(
      handleSyosProfileEvent(event({ data: { metaobject: { id: PROFILE } } }))
    ).resolves.toBeUndefined();
  });

  it("THROWS when there is no session", async () => {
    adminClientForShop.mockResolvedValue(null);
    await expect(
      handleSyosProfileEvent(event({ data: { metaobject: { id: PROFILE } } }))
    ).rejects.toThrow(/no offline Shopify session/);
  });
});

describe("the payload is a trigger, not a data source", () => {
  it("passes only the ID onward — never a dimension from the payload", async () => {
    // The payload claims 99 x 99. Nothing but the id may reach the sync layer.
    await handleSyosProfileEvent(
      event({
        data: {
          metaobject: {
            id: PROFILE,
            type: "$app:syos_center_size_profile",
            fields: [
              { key: "nominal_length_mm", value: "99" },
              { key: "nominal_width_mm", value: "99" },
            ],
          },
        },
      })
    );

    expect(syncProductsUsingProfile).toHaveBeenCalledWith(CLIENT, PROFILE);
    const args = syncProductsUsingProfile.mock.calls[0] ?? [];
    expect(JSON.stringify(args)).not.toContain("99");
  });

  it("passes only the product id, never its metafields", async () => {
    await handleSyosProductEvent(
      event({
        data: {
          product: {
            id: PRODUCT,
            status: "ACTIVE",
            metafields: { nodes: [{ key: "syos_eligible", value: "true" }] },
          },
        },
      })
    );

    expect(syncProduct).toHaveBeenCalledWith(CLIENT, PRODUCT);
    expect(JSON.stringify(syncProduct.mock.calls[0])).not.toContain("syos_eligible");
  });
});

describe("no matching logic lives in the handlers", () => {
  it("mentions no shape, tolerance or vendor-range rule", async () => {
    const fs = await import("node:fs");
    const source = fs.readFileSync(
      new URL("./syosEventHandlers.server.ts", import.meta.url),
      "utf8"
    );
    const body = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

    // Every rule belongs to the projection layer, where it is unit tested.
    // A rule appearing here is how the two sync paths start to disagree.
    for (const forbidden of ["300", "1000", "prongSetTolerance", "nominalLengthUm", "review_band"]) {
      expect(body, `${forbidden} must not appear`).not.toContain(forbidden);
    }
  });
});
