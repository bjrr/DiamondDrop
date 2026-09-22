/**
 * 2C-c LIVE GATE, part 1 — proves the background auth path survived online
 * tokens, then leaves a real, verifiable Bank Payment order for the admin UI
 * half of the gate to act on in a browser.
 *
 * Prints the admin URL to open. Part 2 is manual-in-browser by necessity: the
 * whole point of D23 is that the verifier is the authenticated human, so the
 * action cannot be driven from a script without defeating what it verifies.
 */
import { createHmac, randomUUID } from "node:crypto";

import { prisma } from "~/db/client.server";
import { action } from "~/routes/apps.carat.bank-checkout";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;

async function main() {
  console.log("\n=== criterion 112 — the offline session still works after useOnlineTokens ===");
  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);
  const probe = await admin.graphql(
    `#graphql
     query { shop { name myshopifyDomain } }`,
    { variables: {} }
  );
  const probed = (await probe.json()) as any;
  console.log("  unauthenticated.admin reached Shopify:", JSON.stringify(probed.data?.shop));
  if (!probed.data?.shop?.myshopifyDomain) {
    throw new Error("the background Admin path is broken — this is what criterion 112 guards");
  }

  const sessions = await prisma.session.findMany({ select: { isOnline: true, userId: true, email: true } });
  console.log("  sessions:", JSON.stringify(sessions.map((s) => ({ ...s, userId: s.userId?.toString() ?? null }))));

  console.log("\n=== a real bank order, ready to verify ===");
  const stamp = `verify-${Date.now()}`;
  const gql = async (q: string, v: Record<string, unknown> = {}) =>
    (await (await admin.graphql(q, { variables: v })).json()) as any;

  const pc = await gql(
    `#graphql
     mutation ($input: ProductInput!) {
       productCreate(input: $input) {
         product { id variants(first: 1) { nodes { id } } }
         userErrors { message }
       }
     }`,
    { input: { title: `ZZ Livegate throwaway ${stamp}`, status: "ACTIVE" } }
  );
  const product = pc.data.productCreate.product;
  const variantGid: string = product.variants.nodes[0].id;
  await gql(
    `#graphql
     mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
       productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { message } }
     }`,
    { productId: product.id, variants: [{ id: variantGid, price: "700.00", inventoryPolicy: "CONTINUE" }] }
  );

  const profile = await prisma.pricingProfile.findFirstOrThrow({
    where: { code: "buy_now", isPlaceholder: false },
    orderBy: { version: "desc" },
  });
  const mp = await prisma.masterProduct.create({
    data: {
      name: `2cc ${stamp}`,
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
    data: { kind: "pricing.2cc", payload: {}, contentHash: `2cc-${randomUUID()}` },
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
      landedCostMinorUnits: 30_000n,
      bankPaymentPriceMinorUnits: 64_200n, // $642.00 — a number nobody would guess
      currency: "USD",
      status: "computed",
    },
  });
  await prisma.masterVariant.update({
    where: { id: mv.id },
    data: { lastSyncedPriceCalculationId: calc.id },
  });

  const sig = createHmac("sha256", process.env.SHOPIFY_API_SECRET!).update(`shop=${SHOP}`, "utf8").digest("hex");
  const url = new URL("https://shop.example.com/apps/carat/bank-checkout");
  url.searchParams.set("shop", SHOP);
  url.searchParams.set("signature", sig);
  const res = await action({
    request: new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        mode: "bank",
        email: `${stamp}@example.com`,
        shippingAddress: {
          firstName: "Grace",
          lastName: "Hopper",
          address1: "1 Compiler Way",
          city: "Arlington",
          provinceCode: "VA",
          zip: "22201",
          countryCode: "US",
        },
        lines: [{ shopifyVariantId: variantGid, quantity: 1 }],
      }),
    }),
    params: {},
    context: {},
  } as never);
  const out = (await res.json()) as any;
  if (res.status !== 200) throw new Error("checkout failed: " + JSON.stringify(out));

  const order = await prisma.bankPaymentOrder.findFirstOrThrow({
    where: { shopifyDraftOrderGid: out.draftOrderGid },
  });

  console.log("\n  bankPaymentOrderId :", order.id);
  console.log("  draft order        :", out.draftOrderGid);
  console.log("  product (teardown) :", product.id);
  console.log("  masterProduct      :", mp.id);
  console.log("  EXPECTED TOTAL     : USD 642.00");
  console.log("\n  OPEN THIS:");
  console.log(`  https://admin.shopify.com/store/caratforus-dev/apps/caratforus-development/app/bank-payments/${order.id}`);
}

main()
  .catch((e) => {
    console.error("\nABORTED:", (e as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
