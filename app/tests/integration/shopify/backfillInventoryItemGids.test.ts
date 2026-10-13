import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { backfillInventoryItemGids } from "~/shopify/admin/backfillInventoryItemGids.server";
import type { AdminGraphqlClient } from "~/shopify/admin/productClient.server";

/**
 * R17 (owner ruling, 2026-09-20) — the backfill's real DB-touching path.
 * The pure matcher is covered with no database at all in
 * `app/shopify/admin/backfillInventoryItemGids.test.ts`; this is the rest —
 * real Prisma, a fake Admin API client at the network boundary.
 */

let fixtureSequence = 0;
const uniqueInt = (): number => (Date.now() % 900_000) + 1_000 + (fixtureSequence += 1);

const createdVariantIds: string[] = [];

afterEach(async () => {
  if (createdVariantIds.length === 0) return;
  await prisma.masterVariant.updateMany({
    where: { id: { in: createdVariantIds } },
    data: { status: "archived" },
  });
  createdVariantIds.length = 0;
});

async function makeLinkedProduct(variantCount: number) {
  const suffix = randomUUID();
  const productLegacyId = uniqueInt();
  const product = await prisma.masterProduct.create({
    data: {
      name: `backfill fixture ${suffix}`,
      category: "ring",
      sizeAxis: "none",
      allowedSizeMin: "0",
      allowedSizeMax: "0",
      sizeIncrement: "1",
      baseSize: "0",
      offeredMetals: ["gold"],
      status: "active",
      shopifyProductGid: `gid://shopify/Product/${productLegacyId}`,
    },
  });

  const variants = [];
  for (let i = 0; i < variantCount; i++) {
    const variantLegacyId = uniqueInt();
    const variant = await prisma.masterVariant.create({
      data: {
        masterProductId: product.id,
        metal: i % 2 === 0 ? "gold" : "sterling_silver",
        purity: i % 2 === 0 ? "GOLD_14K" : "SILVER_925",
        baseWeightGrams: "3.0000",
        weightPerFullSizeGrams: "0.0000",
        status: "active",
        laborSource: "india",
        shopifyVariantGid: `gid://shopify/ProductVariant/${variantLegacyId}`,
      },
    });
    createdVariantIds.push(variant.id);
    variants.push(variant);
  }

  return { product, variants };
}

function fakeAdminClient(
  responder: (productGid: string) => { id: string; inventoryItemId: string | null; backwardConfirms: boolean }[]
) {
  const calls: string[] = [];
  const client: AdminGraphqlClient = {
    async graphql(document, options) {
      const variables = (options?.variables ?? {}) as { id: string };
      calls.push(variables.id);
      if (!document.includes("CaratBackfillInventoryItemIds")) {
        throw new Error(`unexpected document: ${document.slice(0, 60)}`);
      }
      const rows = responder(variables.id);
      return {
        json: async () => ({
          data: {
            product: {
              variants: {
                nodes: rows.map((row) => ({
                  id: row.id,
                  inventoryItem: row.inventoryItemId
                    ? {
                        id: row.inventoryItemId,
                        variants: { nodes: row.backwardConfirms ? [{ id: row.id }] : [] },
                      }
                    : null,
                })),
              },
            },
          },
        }),
      };
    },
  };
  return { client, calls };
}

/**
 * Re-reads a product's CURRENT candidate shape straight from Prisma and
 * scopes `loadCandidateProducts` to exactly it. REQUIRED here: this suite's
 * disposable database is shared across every integration test FILE in the
 * run (`tests/integration/globalSetup.ts`), and several sibling fixtures in
 * this same directory create `active`, linked variants that also lack
 * `shopifyInventoryItemGid` — legitimate candidates for the REAL, unscoped
 * `defaultLoadCandidateProducts` query. Without this scoping, exact-count
 * assertions below would depend on which other test files happened to run
 * in the same process, which is exactly the contended-suite failure mode
 * this stage already diagnosed once (see the 2B-6 handoff).
 */
async function scopedCandidates(...productIds: string[]) {
  const products = await prisma.masterProduct.findMany({
    where: { id: { in: productIds } },
    select: {
      id: true,
      shopifyProductGid: true,
      variants: { select: { id: true, shopifyVariantGid: true, shopifyInventoryItemGid: true } },
    },
  });
  return async () =>
    products.map((p) => ({ id: p.id, shopifyProductGid: p.shopifyProductGid!, variants: p.variants }));
}

describe("backfillInventoryItemGids", () => {
  it("maps every unmapped, linked variant from a confirmed Admin API response", async () => {
    const { product, variants } = await makeLinkedProduct(2);
    const { client } = fakeAdminClient(() => [
      { id: variants[0]!.shopifyVariantGid!, inventoryItemId: "gid://shopify/InventoryItem/1", backwardConfirms: true },
      { id: variants[1]!.shopifyVariantGid!, inventoryItemId: "gid://shopify/InventoryItem/2", backwardConfirms: true },
    ]);

    const result = await backfillInventoryItemGids(client, {
      loadCandidateProducts: await scopedCandidates(product.id),
    });

    expect(result.variantsUpdated).toBe(2);
    expect(result.variantsUnresolved).toHaveLength(0);

    const after = await prisma.masterVariant.findMany({
      where: { id: { in: [variants[0]!.id, variants[1]!.id] } },
      select: { id: true, shopifyInventoryItemGid: true },
    });
    expect(after.find((v) => v.id === variants[0]!.id)?.shopifyInventoryItemGid).toBe(
      "gid://shopify/InventoryItem/1"
    );
    expect(after.find((v) => v.id === variants[1]!.id)?.shopifyInventoryItemGid).toBe(
      "gid://shopify/InventoryItem/2"
    );
  });

  it("skips a variant that is already mapped — no Admin API disagreement can overwrite it", async () => {
    const { product, variants } = await makeLinkedProduct(1);
    await prisma.masterVariant.update({
      where: { id: variants[0]!.id },
      data: { shopifyInventoryItemGid: "gid://shopify/InventoryItem/already-mapped" },
    });
    const { client } = fakeAdminClient(() => [
      {
        id: variants[0]!.shopifyVariantGid!,
        inventoryItemId: "gid://shopify/InventoryItem/DIFFERENT",
        backwardConfirms: true,
      },
    ]);

    const result = await backfillInventoryItemGids(client, {
      loadCandidateProducts: await scopedCandidates(product.id),
    });

    expect(result.variantsAlreadyMapped).toBe(1);
    expect(result.variantsUpdated).toBe(0);
    const after = await prisma.masterVariant.findUnique({ where: { id: variants[0]!.id } });
    expect(after?.shopifyInventoryItemGid).toBe("gid://shopify/InventoryItem/already-mapped");
  });

  it("leaves a variant UNRESOLVED (never guesses) when the backward variants connection does not confirm the pairing", async () => {
    const { product, variants } = await makeLinkedProduct(1);
    const { client } = fakeAdminClient(() => [
      {
        id: variants[0]!.shopifyVariantGid!,
        inventoryItemId: "gid://shopify/InventoryItem/1",
        backwardConfirms: false, // the R17 verification failing
      },
    ]);

    const result = await backfillInventoryItemGids(client, {
      loadCandidateProducts: await scopedCandidates(product.id),
    });

    expect(result.variantsUpdated).toBe(0);
    expect(result.variantsUnresolved).toEqual([variants[0]!.id]);
    const after = await prisma.masterVariant.findUnique({ where: { id: variants[0]!.id } });
    expect(after?.shopifyInventoryItemGid).toBeNull();
  });

  it("one product's Admin API failure does not abort backfilling the rest of the catalogue", async () => {
    const { product: failingProduct, variants: failingVariants } = await makeLinkedProduct(1);
    const { product: okProduct, variants: okVariants } = await makeLinkedProduct(1);
    const failingProductGid = failingProduct.shopifyProductGid!;
    const okProductGid = okProduct.shopifyProductGid!;
    const okVariantGid = okVariants[0]!.shopifyVariantGid!;

    const client: AdminGraphqlClient = {
      async graphql(_document, options) {
        const variables = (options?.variables ?? {}) as { id: string };
        if (variables.id === failingProductGid) {
          return { json: async () => ({ errors: [{ message: "simulated Admin API failure" }] }) };
        }
        if (variables.id === okProductGid) {
          return {
            json: async () => ({
              data: {
                product: {
                  variants: {
                    nodes: [
                      {
                        id: okVariantGid,
                        inventoryItem: {
                          id: "gid://shopify/InventoryItem/ok",
                          variants: { nodes: [{ id: okVariantGid }] },
                        },
                      },
                    ],
                  },
                },
              },
            }),
          };
        }
        throw new Error(`unexpected product gid in test: ${variables.id}`);
      },
    };

    const result = await backfillInventoryItemGids(client, {
      loadCandidateProducts: await scopedCandidates(failingProduct.id, okProduct.id),
    });

    expect(result.variantsUnresolved).toContain(failingVariants[0]!.id);
    expect(result.variantsUpdated).toBe(1);
    const okAfter = await prisma.masterVariant.findUnique({ where: { id: okVariants[0]!.id } });
    expect(okAfter?.shopifyInventoryItemGid).toBe("gid://shopify/InventoryItem/ok");
  });

  it("is a fast no-op when every linked variant is already mapped — the REAL default query excludes a fully-mapped product entirely", async () => {
    const { product, variants } = await makeLinkedProduct(1);
    await prisma.masterVariant.update({
      where: { id: variants[0]!.id },
      data: { shopifyInventoryItemGid: "gid://shopify/InventoryItem/already" },
    });
    // Deliberately uses the REAL, unscoped default — this test's whole point
    // is the SQL-level pre-filter (`variants: { some: { ...gid: null } }`)
    // excluding a fully-mapped product before any Admin API call is made.
    // Asserted by NON-MEMBERSHIP rather than a global empty count, since the
    // shared disposable database can legitimately hold other files'
    // in-flight candidate fixtures at the same time (see scopedCandidates's
    // own doc comment).
    const { client, calls } = fakeAdminClient(() => []);

    await backfillInventoryItemGids(client);

    expect(calls).not.toContain(product.shopifyProductGid);
    const after = await prisma.masterVariant.findUnique({ where: { id: variants[0]!.id } });
    expect(after?.shopifyInventoryItemGid).toBe("gid://shopify/InventoryItem/already");
  });
});
