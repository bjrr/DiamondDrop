/**
 * 2C-6 STOREFRONT LIVE GATE, part 1b.
 *
 * The fixture product created in part 1 is not on the Online Store channel,
 * and publishing it needs `read_publications`/`write_publications` — scopes
 * not worth requesting for a test fixture. So the Bank Payment price is mapped
 * onto a product the store ALREADY publishes, which is closer to reality
 * anyway: a real catalogue item a customer can reach.
 */
import { randomUUID } from "node:crypto";

import { prisma } from "~/db/client.server";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;
const TARGET_TITLE = "The Complete Snowboard";

async function main() {
  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);
  const gql = async (q: string, v: Record<string, unknown> = {}) =>
    (await (await admin.graphql(q, { variables: v })).json()) as any;

  const found = await gql(
    `#graphql
     query ($q: String!) {
       products(first: 5, query: $q) {
         nodes {
           id title handle
           variants(first: 1) { nodes { id title price availableForSale } }
         }
       }
     }`,
    { q: `title:'${TARGET_TITLE}'` }
  );
  const product = (found.data?.products?.nodes ?? [])[0];
  if (!product) throw new Error(`could not find ${TARGET_TITLE}`);
  const variant = product.variants.nodes[0];
  console.log("  target:", product.title, "|", product.handle);
  console.log("  variant:", variant.id, "| card price", variant.price, "| available", variant.availableForSale);

  // Reuse the master variant if this has been run before.
  const existing = await prisma.masterVariant.findFirst({
    where: { shopifyVariantGid: variant.id },
    include: { masterProduct: true },
  });

  const profile = await prisma.pricingProfile.findFirstOrThrow({
    where: { code: "buy_now", isPlaceholder: false },
    orderBy: { version: "desc" },
  });

  let mv = existing;
  if (!mv) {
    const mp = await prisma.masterProduct.create({
      data: {
        name: `ZZ livegate storefront ${Date.now()}`,
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
    mv = (await prisma.masterVariant.create({
      data: {
        masterProductId: mp.id,
        metal: "gold",
        purity: "GOLD_14K",
        baseWeightGrams: "3.0000",
        weightPerFullSizeGrams: "0.0000",
        status: "active",
        laborSource: "india",
        shopifyVariantGid: variant.id,
        bankPaymentDiscountEligible: true,
      },
      include: { masterProduct: true },
    })) as typeof existing;
  } else {
    await prisma.masterVariant.update({
      where: { id: mv.id },
      data: { status: "active", bankPaymentDiscountEligible: true },
    });
    await prisma.masterProduct.update({ where: { id: mv.masterProductId }, data: { status: "active" } });
  }

  const snap = await prisma.snapshot.create({
    data: { kind: "pricing.2c6", payload: {}, contentHash: `2c6-${randomUUID()}` },
  });
  const calc = await prisma.priceCalculation.create({
    data: {
      runId: randomUUID(),
      masterVariantId: mv!.id,
      pricingProfileId: profile.id,
      profileVersion: profile.version,
      engineVersion: "BUY_NOW_PRICING_V1",
      roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
      priceEndingRuleId: "NONE_V1",
      asOf: new Date(),
      snapshotId: snap.id,
      landedCostMinorUnits: 30_000n,
      bankPaymentPriceMinorUnits: 118_800n, // $1,188.00
      currency: "USD",
      status: "computed",
    },
  });
  await prisma.masterVariant.update({
    where: { id: mv!.id },
    data: { lastSyncedPriceCalculationId: calc.id },
  });

  console.log("\n  masterVariant   :", mv!.id);
  console.log("  masterProduct   :", mv!.masterProductId);
  console.log("  bank price      : USD 1188.00");
  console.log("\n  STOREFRONT (local theme dev server):");
  console.log(`  http://127.0.0.1:9292/products/${product.handle}`);
}

main()
  .catch((e) => {
    console.error("\nABORTED:", (e as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
