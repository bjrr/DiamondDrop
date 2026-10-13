/**
 * 2C-6 STOREFRONT LIVE GATE, part 1 — a real, purchasable product with a
 * published Bank Payment Price, so the cart can actually show Bank Payment
 * pricing and offer Bank Payment Checkout.
 *
 * Part 2 is a browser session against the unpublished preview theme.
 */
import { randomUUID } from "node:crypto";

import { prisma } from "~/db/client.server";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;

async function main() {
  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);
  const gql = async (q: string, v: Record<string, unknown> = {}) =>
    (await (await admin.graphql(q, { variables: v })).json()) as any;

  const stamp = `storefront-${Date.now()}`;
  const pc = await gql(
    `#graphql
     mutation ($input: ProductInput!) {
       productCreate(input: $input) {
         product { id handle variants(first: 1) { nodes { id } } }
         userErrors { message }
       }
     }`,
    {
      input: {
        title: `ZZ Livegate Storefront Ring ${stamp}`,
        status: "ACTIVE",
        // Published to the Online Store so the preview theme can render it.
        productType: "Ring",
      },
    }
  );
  if (pc.errors?.length || pc.data?.productCreate?.userErrors?.length) {
    throw new Error("productCreate: " + JSON.stringify(pc.errors ?? pc.data.productCreate.userErrors));
  }
  const product = pc.data.productCreate.product;
  const variantGid: string = product.variants.nodes[0].id;

  const vu = await gql(
    `#graphql
     mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
       productVariantsBulkUpdate(productId: $productId, variants: $variants) {
         productVariants { id price availableForSale }
         userErrors { message }
       }
     }`,
    {
      productId: product.id,
      // CONTINUE so availability never gates the gate itself.
      variants: [{ id: variantGid, price: "1234.00", inventoryPolicy: "CONTINUE" }],
    }
  );
  if (vu.data?.productVariantsBulkUpdate?.userErrors?.length) {
    throw new Error("variant update: " + JSON.stringify(vu.data.productVariantsBulkUpdate.userErrors));
  }

  // Publish to the Online Store channel, or the preview theme cannot show it.
  // Multi-line deliberately: `#graphql` on a single line comments the whole
  // query out, since # runs to end of line in GraphQL.
  // Best-effort: listing publications needs read_publications, which is not
  // granted and is not worth requesting for a fixture. Most dev stores publish
  // new products to the Online Store by default; if this lookup is denied we
  // simply check visibility in the browser instead of guessing.
  const pubs = await gql(`#graphql
    query { publications(first: 10) { nodes { id name } } }`).catch(() => null);
  const online = (pubs?.data?.publications?.nodes ?? []).find((p: any) => /online store/i.test(p.name));
  if (online) {
    const pub = await gql(
      `#graphql
       mutation ($id: ID!, $input: [PublicationInput!]!) {
         publishablePublish(id: $id, input: $input) { userErrors { message } }
       }`,
      { id: product.id, input: [{ publicationId: online.id }] }
    );
    console.log("  published to Online Store:", JSON.stringify(pub.data?.publishablePublish?.userErrors ?? "ok"));
  }

  const profile = await prisma.pricingProfile.findFirstOrThrow({
    where: { code: "buy_now", isPlaceholder: false },
    orderBy: { version: "desc" },
  });
  const mp = await prisma.masterProduct.create({
    data: {
      name: `storefront ${stamp}`,
      category: "ring",
      sizeAxis: "none",
      allowedSizeMin: "0",
      allowedSizeMax: "0",
      sizeIncrement: "1",
      baseSize: "0",
      offeredMetals: ["gold"],
      status: "active",
      shopifyProductGid: product.id,
    },
  });
  const mv = await prisma.masterVariant.create({
    data: {
      masterProductId: mp.id,
      metal: "gold",
      purity: "GOLD_14K",
      baseWeightGrams: "3.0000",
      weightPerFullSizeGrams: "0.0000",
      status: "active",
      laborSource: "india",
      shopifyVariantGid: variantGid,
      bankPaymentDiscountEligible: true,
    },
  });
  const snap = await prisma.snapshot.create({
    data: { kind: "pricing.2c6", payload: {}, contentHash: `2c6-${randomUUID()}` },
  });
  const calc = await prisma.priceCalculation.create({
    data: {
      runId: randomUUID(),
      masterVariantId: mv.id,
      pricingProfileId: profile.id,
      profileVersion: profile.version,
      engineVersion: "BUY_NOW_PRICING_V1",
      roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
      priceEndingRuleId: "NONE_V1",
      asOf: new Date(),
      snapshotId: snap.id,
      landedCostMinorUnits: 50_000n,
      bankPaymentPriceMinorUnits: 118_800n, // $1,188.00 — distinct from the $1,234 card price
      currency: "USD",
      status: "computed",
    },
  });
  await prisma.masterVariant.update({
    where: { id: mv.id },
    data: { lastSyncedPriceCalculationId: calc.id },
  });

  console.log("\n  product        :", product.id);
  console.log("  handle         :", product.handle);
  console.log("  variant        :", variantGid);
  console.log("  masterProduct  :", mp.id);
  console.log("  card price     : USD 1234.00");
  console.log("  bank price     : USD 1188.00");
  console.log("\n  STOREFRONT (preview theme):");
  console.log(`  https://caratforus-dev.myshopify.com/products/${product.handle}?preview_theme_id=182944989485`);
}

main()
  .catch((e) => {
    console.error("\nABORTED:", (e as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
