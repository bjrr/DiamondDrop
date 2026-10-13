/**
 * 2C-6 STOREFRONT LIVE GATE — teardown.
 *
 * The important one is the price mapping: the gate attached a Bank Payment
 * Price to "The Complete Snowboard", a REAL catalogue product on the dev
 * store. Left in place it would keep quoting $1,188 for a $699.95 snowboard,
 * so the master variant is archived and its published-price anchor cleared.
 */
import { prisma } from "~/db/client.server";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;

async function main() {
  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);
  const gql = async (q: string, v: Record<string, unknown> = {}) =>
    (await (await admin.graphql(q, { variables: v })).json()) as any;

  // 1. Draft orders this gate created.
  const drafts = await prisma.bankPaymentOrder.findMany({
    where: { customerEmail: { startsWith: "storefront-" } },
    select: { id: true, shopifyDraftOrderGid: true, status: true },
  });
  for (const d of drafts) {
    const r = await gql(
      `#graphql
       mutation ($input: DraftOrderDeleteInput!) {
         draftOrderDelete(input: $input) { deletedId userErrors { message } }
       }`,
      { input: { id: d.shopifyDraftOrderGid } }
    ).catch((e) => ({ errors: [String(e)] }));
    console.log("  draft delete", d.shopifyDraftOrderGid, JSON.stringify(r.data?.draftOrderDelete ?? r.errors));
    if (d.status === "open") {
      await prisma.bankPaymentOrder.update({
        where: { id: d.id },
        data: {
          status: "cancelled",
          cancelledAt: new Date(),
          cancellationReason: "2C-6 storefront live gate fixture, cancelled during teardown",
        },
      });
    }
  }

  // 2. The price mapping on a real catalogue product — the one that matters.
  const mapped = await prisma.masterProduct.findMany({
    where: { name: { startsWith: "ZZ livegate storefront" } },
    select: { id: true },
  });
  for (const mp of mapped) {
    await prisma.masterVariant.updateMany({
      where: { masterProductId: mp.id },
      data: { status: "archived", lastSyncedPriceCalculationId: null },
    });
    await prisma.masterProduct.update({ where: { id: mp.id }, data: { status: "archived" } });
    console.log("  price mapping archived:", mp.id);
  }
  const alsoMapped = await prisma.masterProduct.findMany({
    where: { name: { startsWith: "storefront storefront-" } },
    select: { id: true },
  });
  for (const mp of alsoMapped) {
    await prisma.masterVariant.updateMany({
      where: { masterProductId: mp.id },
      data: { status: "archived", lastSyncedPriceCalculationId: null },
    });
    await prisma.masterProduct.update({ where: { id: mp.id }, data: { status: "archived" } });
    console.log("  unused fixture archived:", mp.id);
  }

  // 3. The throwaway Shopify product from part 1 (never published, unused).
  const ps = await gql(`#graphql
    query { products(first: 50, query: "title:ZZ*") { nodes { id title } } }`);
  for (const node of ps.data?.products?.nodes ?? []) {
    if (!/^ZZ Livegate/i.test(node.title)) continue;
    const r = await gql(
      `#graphql
       mutation ($input: ProductDeleteInput!) {
         productDelete(input: $input) { deletedProductId userErrors { message } }
       }`,
      { input: { id: node.id } }
    ).catch((e) => ({ errors: [String(e)] }));
    console.log("  product delete", node.title, JSON.stringify(r.data?.productDelete ?? r.errors));
  }

  // 4. Confirm the real product carries no live Bank Payment price any more.
  const snowboard = await prisma.masterVariant.findFirst({
    where: { shopifyVariantGid: "gid://shopify/ProductVariant/52375385309485" },
    select: { status: true, lastSyncedPriceCalculationId: true },
  });
  console.log("\n  The Complete Snowboard mapping:", JSON.stringify(snowboard));

  await prisma.idempotencyKey.deleteMany({ where: { operationType: "bank_payment_checkout" } });
  console.log("  idempotency keys cleared");
}

main()
  .catch((e) => {
    console.error("\nABORTED:", (e as Error).message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
