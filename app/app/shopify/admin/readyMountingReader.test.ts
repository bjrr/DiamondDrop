/**
 * Reading a ready-mounting product for the dashboard.
 *
 * Two things are worth testing here and nothing else is: that a Shopify
 * refusal is not mistaken for success (a mutation — and a query with a bad
 * field — returns HTTP 200 with the problem in the envelope), and that the
 * reader stays read-only. The second matters more than it looks: the moment a
 * write reappears in this module, staff have two places to edit the same
 * product and the single-source-of-truth rule is gone.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { readReadyMountingProduct } from "./readyMountingReader.server";

const PRODUCT = "gid://shopify/Product/111";

function clientReturning(envelope: unknown) {
  const calls: { query: string; variables: Record<string, unknown> }[] = [];
  const client = {
    graphql: vi.fn(async (query: string, options?: { variables?: Record<string, unknown> }) => {
      calls.push({ query, variables: options?.variables ?? {} });
      return { json: async () => envelope };
    }),
  };
  return { client, calls };
}

const MEDIA_IMAGE = {
  id: "gid://shopify/MediaImage/1",
  alt: "Pear solitaire, three-quarter view",
  mediaContentType: "IMAGE",
  status: "READY",
  preview: { image: { url: "https://cdn.shopify.com/preview-1.jpg" } },
  mediaErrors: [],
};

const ENVELOPE = {
  data: {
    product: {
      id: PRODUCT,
      title: "14K Pear Solitaire — Double Prong",
      handle: "14k-pear-solitaire-double-prong",
      descriptionHtml: "<p>Double-prong pear head.</p>",
      status: "DRAFT",
      vendor: "CaratForUs",
      productType: "Ready Mounting",
      media: {
        nodes: [MEDIA_IMAGE, { ...MEDIA_IMAGE, id: "gid://shopify/Video/2", mediaContentType: "VIDEO" }],
      },
      // The three-option model: centre size, metal, ring size.
      options: [
        { name: "Center Stone Size", optionValues: [{ name: "9 × 6 mm" }, { name: "10 × 7 mm" }] },
        { name: "Metal", optionValues: [{ name: "14K White Gold" }, { name: "14K Yellow Gold" }] },
        { name: "Ring Size", optionValues: [{ name: "6" }, { name: "6.5" }] },
      ],
      variants: {
        nodes: [
          {
            id: "gid://shopify/ProductVariant/222",
            title: "10 × 7 mm / 14K Yellow Gold / 6.5",
            sku: "RM-PR-10X7-14Y-65",
            price: "880.00",
          },
        ],
      },
    },
  },
};

describe("readReadyMountingProduct", () => {
  it("returns everything the dashboard needs in one read", async () => {
    const { client } = clientReturning(ENVELOPE);
    const product = await readReadyMountingProduct(client, PRODUCT);

    expect(product?.title).toBe("14K Pear Solitaire — Double Prong");
    expect(product?.status).toBe("DRAFT");
    expect(product?.media).toHaveLength(2);
    expect(product?.variants[0]?.sku).toBe("RM-PR-10X7-14Y-65");
  });

  it("surfaces the three-option model as named options and values", async () => {
    // The dashboard reports which centre-size configurations exist, so it has
    // to see the option by name rather than inferring it from variant titles.
    const { client } = clientReturning(ENVELOPE);
    const product = await readReadyMountingProduct(client, PRODUCT);

    expect(product?.options.map((o) => o.name)).toEqual([
      "Center Stone Size",
      "Metal",
      "Ring Size",
    ]);
    expect(product?.options[0]?.values).toEqual(["9 × 6 mm", "10 × 7 mm"]);
  });

  it("distinguishes images from videos, so missing media can be reported precisely", async () => {
    const { client } = clientReturning(ENVELOPE);
    const product = await readReadyMountingProduct(client, PRODUCT);

    const types = product?.media.map((m) => m.mediaContentType);
    expect(types).toContain("IMAGE");
    expect(types).toContain("VIDEO");
  });

  it("reports a media item Shopify failed to process", async () => {
    const { client } = clientReturning({
      data: {
        product: {
          ...ENVELOPE.data.product,
          media: {
            nodes: [
              { ...MEDIA_IMAGE, status: "FAILED", mediaErrors: [{ message: "Video could not be processed" }] },
            ],
          },
        },
      },
    });

    const product = await readReadyMountingProduct(client, PRODUCT);
    expect(product?.media[0]?.status).toBe("FAILED");
    expect(product?.media[0]?.errors).toEqual(["Video could not be processed"]);
  });

  it("returns null for a product that no longer exists", async () => {
    // A deleted product must be distinguishable from one with no media, since
    // the dashboard reports the two very differently.
    const { client } = clientReturning({ data: { product: null } });
    expect(await readReadyMountingProduct(client, PRODUCT)).toBeNull();
  });

  it("tolerates a product with no media, options or variants", async () => {
    const { client } = clientReturning({
      data: {
        product: {
          id: PRODUCT,
          title: "Bare",
          handle: "bare",
          descriptionHtml: null,
          status: "DRAFT",
          vendor: null,
          productType: null,
        },
      },
    });

    const product = await readReadyMountingProduct(client, PRODUCT);
    expect(product?.media).toEqual([]);
    expect(product?.options).toEqual([]);
    expect(product?.variants).toEqual([]);
    expect(product?.descriptionHtml).toBe("");
  });

  it("throws on a top-level GraphQL error rather than returning a blank product", async () => {
    const { client } = clientReturning({ errors: [{ message: "Access denied" }] });
    await expect(readReadyMountingProduct(client, PRODUCT)).rejects.toThrow(/Access denied/);
  });

  it("throws when the envelope carries no data", async () => {
    const { client } = clientReturning({});
    await expect(readReadyMountingProduct(client, PRODUCT)).rejects.toThrow(/no data/);
  });
});

describe("the reader stays read-only", () => {
  const source = readFileSync(join(__dirname, "readyMountingReader.server.ts"), "utf8");
  const body = source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:])\/\/.*$/gm, "$1");

  it("contains no mutation of any kind", () => {
    // Shopify Product Admin is the authoring surface. A write here means two
    // editable sources of truth for the same product.
    expect(body).not.toMatch(/\bmutation\b/);
  });

  it("names none of the product or media mutations an earlier draft had", () => {
    for (const forbidden of [
      "stagedUploadsCreate",
      "productCreate",
      "productUpdate",
      "productReorderMedia",
      "productVariantsBulkUpdate",
      "fileCreate",
      "fileUpdate",
      "fileDelete",
    ]) {
      expect(body, `${forbidden} must not appear`).not.toContain(forbidden);
    }
  });

  it("stores nothing locally — no database, no bucket", () => {
    expect(body).not.toMatch(/~\/db\/|prisma/);
    expect(body).not.toMatch(/r2Client|STORAGE_|createUploadDestination/);
  });
});

// ============================== the variant profile reference takes priority

describe("profile resolution prefers the per-variant reference", () => {
  // Added after productOptionUpdate silently refused to link the pilot
  // mounting's option. The variant reference is the route that works; the
  // linked option value remains the fallback for products where it took.
  it("is the documented order in the module header", () => {
    const src = readFileSync(
      new URL("./syosProductReader.server.ts", import.meta.url),
      "utf8"
    );
    expect(src).toMatch(/AUTHORITATIVE/);
    expect(src).toMatch(/custom\.syos_center_size_profile/);
    // The fallback must still be present, not deleted.
    expect(src).toMatch(/linkedMetafieldValue/);
  });

  it("reads the variant metafield in the product query", () => {
    const src = readFileSync(
      new URL("./syosProductReader.server.ts", import.meta.url),
      "utf8"
    );
    expect(src).toContain('centerSizeProfile: metafield(namespace: "custom", key: "syos_center_size_profile")');
  });

  it("still never derives a dimension from the option label", () => {
    const src = readFileSync(new URL("./syosProductReader.server.ts", import.meta.url), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    // No parsing of "9x7 mm" style text anywhere in the reader.
    expect(src).not.toMatch(/\[x×\]/);
    expect(src).not.toMatch(/parseFloat|parseInt/);
  });
});

// ==================== the $app: type is resolved on read, and must still match

describe("size profile type matching survives Shopify resolving $app:", () => {
  // The bug this pins cost a full pilot sync: we declare the metaobject type
  // as "$app:syos_center_size_profile" and every READ returns
  // "app--424838725633--syos_center_size_profile". Strict equality matched
  // nothing, so all 75 configurations synced as "not linked to a profile"
  // while their metafields were correct the whole time.
  const declared = "$app:syos_center_size_profile";
  const resolved = "app--424838725633--syos_center_size_profile";
  const otherInstall = "app--999999999999--syos_center_size_profile";

  /**
   * The REAL implementation, lifted out of the source and executed.
   *
   * The previous version of this test defined its own copy. The copy was
   * correct and the shipped function was not — an escape had been eaten in
   * transit, so the source read `/^$app:/`, a pattern matching nothing — and
   * this test passed green while every profile in production silently failed
   * to resolve. Testing a reimplementation is testing nothing.
   */
  const source = readFileSync(new URL("./syosProductReader.server.ts", import.meta.url), "utf8");
  const extracted = source.match(/function isSizeProfileType[\s\S]*?\n\}/)?.[0];

  function isSizeProfileType(type: string): boolean {
    if (!extracted) throw new Error("isSizeProfileType not found in the reader source");
    const js = extracted.replace(/: string/g, "").replace(/: boolean/g, "");
    const build = new Function("SYOS_PROFILE_TYPE", `${js}; return isSizeProfileType;`) as (
      t: string
    ) => (type: string) => boolean;
    return build(declared)(type);
  }

  it("accepts the declared $app: spelling", () => {
    expect(isSizeProfileType(declared)).toBe(true);
  });

  it("accepts the resolved app-- spelling Shopify actually returns", () => {
    expect(isSizeProfileType(resolved)).toBe(true);
  });

  it("accepts a different install's app id", () => {
    // The numeric app id differs between installs, so hard-coding ours would
    // break the dev store and any reinstall.
    expect(isSizeProfileType(otherInstall)).toBe(true);
  });

  it("rejects a different metaobject type", () => {
    expect(isSizeProfileType("app--424838725633--something_else")).toBe(false);
    expect(isSizeProfileType("syos_center_size_profile_extra")).toBe(false);
    expect(isSizeProfileType("lookbook")).toBe(false);
  });

  it("is wired into the read path, not merely defined", () => {
    expect(source).toContain("isSizeProfileType(node.type)");
    expect(source).not.toMatch(/node\.type !== SYOS_PROFILE_TYPE/);
  });

  it("uses no regex in its CODE, which is how the escape was lost last time", () => {
    expect(extracted).toBeDefined();
    // Comments are excluded: the explanation of the bug necessarily quotes the
    // broken pattern, and an assertion that fires on its own documentation is
    // the trap `stripComments` already exists for elsewhere in this codebase.
    const code = extracted!
      .replace(/\/\*[\s\S]*?\*\//g, " ")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(code).not.toContain("/^");
  });
});
