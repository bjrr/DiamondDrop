/**
 * SLICE 2C-a LIVE GATE — the completion step only.
 *
 * The rest of 2C-a was proven in `slice2cA.livegate.ts`; completion was the
 * single check that could not run, because `draftOrderComplete` returns the
 * order it created and that field is gated on `read_orders`.
 *
 * Real store, throwaway data, teardown in a finally block.
 */
import { createHmac, randomUUID } from "node:crypto";

import { prisma } from "~/db/client.server";
import { completeBankPaymentOrder } from "~/domain/bankpayment/completeOrder.server";
import { action } from "~/routes/apps.carat.bank-checkout";
import { ShopifyDraftOrderAdapter } from "~/shopify/admin/draftOrderAdapter.server";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;
const SECRET = process.env.SHOPIFY_API_SECRET!;

const created = {
  productGids: [] as string[],
  orderGids: [] as string[],
  draftOrderGids: [] as string[],
  masterProductIds: [] as string[],
};

let gql: ((q: string, v?: Record<string, unknown>) => Promise<any>) | null = null;
let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const SHIPPING_ADDRESS = {
  firstName: "Completion",
  lastName: "Throwaway",
  address1: "9 Teardown Street",
  city: "Bristol",
  zip: "BS1 4DJ",
  countryCode: "GB",
};

function signedPost(body: unknown): Request {
  const signature = createHmac("sha256", SECRET).update(`shop=${SHOP}`, "utf8").digest("hex");
  const url = new URL("https://shop.example.com/apps/carat/bank-checkout");
  url.searchParams.set("shop", SHOP);
  url.searchParams.set("signature", signature);
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function main() {
  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);
  gql = async (q: string, variables: Record<string, unknown> = {}) =>
    (await (await admin.graphql(q, { variables })).json()) as any;

  console.log("\n=== scope check ===");
  const session = await prisma.session.findFirstOrThrow({ select: { scope: true } });
  console.log("  granted:", session.scope);
  if (!session.scope?.includes("read_orders")) {
    throw new Error("read_orders is NOT granted — protected customer data access is still pending");
  }
  check("read_orders is granted", true, session.scope);

  console.log("\n=== fixture ===");
  const stamp = `completion-${Date.now()}`;
  const pc = await gql(
    `#graphql
     mutation ($input: ProductInput!) {
       productCreate(input: $input) {
         product { id variants(first: 1) { nodes { id } } }
         userErrors { field message }
       }
     }`,
    { input: { title: `ZZ Livegate throwaway ${stamp}`, status: "ACTIVE" } }
  );
  const product = pc.data.productCreate.product;
  created.productGids.push(product.id);
  const variantGid: string = product.variants.nodes[0].id;
  await gql(
    `#graphql
     mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
       productVariantsBulkUpdate(productId: $productId, variants: $variants) {
         userErrors { field message }
       }
     }`,
    { productId: product.id, variants: [{ id: variantGid, price: "999.00", inventoryPolicy: "CONTINUE" }] }
  );

  const profile = await prisma.pricingProfile.findFirstOrThrow({
    where: { code: "buy_now", isPlaceholder: false },
    orderBy: { version: "desc" },
  });
  const mp = await prisma.masterProduct.create({
    data: {
      name: `livegate ${stamp}`,
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
  created.masterProductIds.push(mp.id);
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
    data: { kind: "pricing.livegate", payload: {}, contentHash: `completion-${randomUUID()}` },
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
      landedCostMinorUnits: 40_000n,
      bankPaymentPriceMinorUnits: 87_654n, // $876.54
      currency: "USD",
      status: "computed",
    },
  });
  await prisma.masterVariant.update({
    where: { id: mv.id },
    data: { lastSyncedPriceCalculationId: calc.id },
  });

  console.log("\n=== a real bank order ===");
  const email = `${stamp}@example.com`;
  const res = await action({
    request: signedPost({
      mode: "bank",
      email,
      shippingAddress: SHIPPING_ADDRESS,
      lines: [{ shopifyVariantId: variantGid, quantity: 1 }],
    }),
    params: {},
    context: {},
  } as never);
  const out = (await res.json()) as any;
  if (res.status !== 200) throw new Error("checkout failed: " + JSON.stringify(out));
  created.draftOrderGids.push(out.draftOrderGid);
  console.log("  draft:", out.draftOrderGid);

  const bankOrder = await prisma.bankPaymentOrder.findFirstOrThrow({
    where: { shopifyDraftOrderGid: out.draftOrderGid },
  });

  console.log("\n=== §22: completion is refused before verification ===");
  const port = new ShopifyDraftOrderAdapter(admin as never);
  let refused = false;
  try {
    await completeBankPaymentOrder({ bankPaymentOrderId: bankOrder.id, port });
  } catch (e) {
    refused = (e as Error).name === "BankPaymentOrderNotVerifiedError";
  }
  check("an unverified order refuses to complete (§22)", refused);

  // The admin's manual verification, recorded exactly as criterion 87 requires.
  await prisma.bankPaymentOrder.update({
    where: { id: bankOrder.id },
    data: {
      verifiedPaymentAmountMinorUnits: 87_654n,
      verifiedPaymentCurrency: "USD",
      verifiedPaymentMethod: "zelle",
      verifiedPaymentReference: `livegate-${stamp}`,
      verifiedAt: new Date(),
      // D23: verified_by is now the authenticated Shopify staff identity
      // (user id + email), not a typed name.
      verifiedByShopifyUserId: 1n,
      verifiedByEmail: "livegate-admin@example.com",
    },
  });

  console.log("\n=== completion ===");
  const completed = await completeBankPaymentOrder({ bankPaymentOrderId: bankOrder.id, port });
  created.orderGids.push(completed.shopifyOrderGid);
  console.log("  ->", JSON.stringify(completed));
  check(
    "draftOrderComplete succeeded and the order id is readable",
    typeof completed.shopifyOrderGid === "string" && completed.shopifyOrderGid.includes("/Order/"),
    completed.shopifyOrderGid
  );

  const persisted = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: bankOrder.id } });
  check(
    "the EXACT gid is persisted to shopify_order_gid",
    persisted.shopifyOrderGid === completed.shopifyOrderGid,
    `${persisted.shopifyOrderGid}`
  );
  check("status is completed and completedAt is set", persisted.status === "completed" && !!persisted.completedAt);

  const oq = await gql(
    `#graphql
     query ($id: ID!) {
       order(id: $id) {
         id name displayFinancialStatus
         totalPriceSet { shopMoney { amount currencyCode } }
         lineItems(first: 5) { nodes { quantity originalUnitPriceSet { shopMoney { amount } } } }
       }
     }`,
    { id: completed.shopifyOrderGid }
  );
  const order = oq.data?.order;
  console.log("  ORDER AS SHOPIFY HAS IT:", JSON.stringify(order));
  check("the order gid round-trips from Shopify", order?.id === completed.shopifyOrderGid);
  check(
    "the order is UNPAID — not accidentally marked paid (§22)",
    order?.displayFinancialStatus === "PENDING",
    order?.displayFinancialStatus
  );
  check(
    "the order carries the Bank Payment Price",
    order?.lineItems?.nodes?.[0]?.originalUnitPriceSet?.shopMoney?.amount === "876.54",
    order?.lineItems?.nodes?.[0]?.originalUnitPriceSet?.shopMoney?.amount
  );

  console.log("\n=== replay ===");
  const replay = await completeBankPaymentOrder({ bankPaymentOrderId: bankOrder.id, port });
  check("a replay reports alreadyCompleted", replay.alreadyCompleted === true);
  check("a replay returns the same gid", replay.shopifyOrderGid === completed.shopifyOrderGid);

  const ordersForDraft = await gql(
    `#graphql
     query { orders(first: 50, sortKey: CREATED_AT, reverse: true) { nodes { id email } } }`
  );
  const mine = (ordersForDraft.data?.orders?.nodes ?? []).filter((o: any) => o.email === email);
  check(
    "the replay created NO second Shopify order",
    mine.length === 1,
    `${mine.length} order(s) for ${email}`
  );

  console.log("\n=== PII ===");
  const row = JSON.stringify(persisted, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  const leaked = ["9 Teardown Street", "Bristol", "BS1 4DJ", "Completion", "Throwaway"].filter((s) =>
    row.includes(s)
  );
  check("no address or name anywhere on the bank order row", leaked.length === 0, leaked.join(",") || "none");
  check("email is the only customer identifier stored", persisted.customerEmail === email.toLowerCase());
  const lineRows = await prisma.bankPaymentOrderLine.findMany({ where: { bankPaymentOrderId: bankOrder.id } });
  const lineJson = JSON.stringify(lineRows, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  check(
    "no customer data on the quote lines either",
    !/Teardown|Bristol|BS1|@example\.com/.test(lineJson)
  );

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
}

async function cleanup() {
  console.log("\n=== CLEANUP ===");
  if (gql) {
    for (const id of created.orderGids) {
      const c = await gql(
        `#graphql
         mutation ($id: ID!) {
           orderCancel(orderId: $id, reason: OTHER, restock: true, notifyCustomer: false, staffNote: "livegate teardown") {
             userErrors { message }
           }
         }`,
        { id }
      ).catch((e) => ({ errors: [{ message: (e as Error).message }] }));
      console.log("  order cancel", id, JSON.stringify(c.data?.orderCancel?.userErrors ?? c.errors ?? "ok"));
      const d = await gql(
        `#graphql
         mutation ($id: ID!) { orderDelete(orderId: $id) { deletedId userErrors { message } } }`,
        { id }
      ).catch((e) => ({ errors: [{ message: (e as Error).message }] }));
      console.log("  order delete", id, JSON.stringify(d.data?.orderDelete ?? d.errors));
    }
    // Any draft that survived (a failed run never completes its draft).
    const sweep = await gql(
      `#graphql
       query { draftOrders(first: 50, sortKey: UPDATED_AT, reverse: true) { nodes { id email tags } } }`
    ).catch(() => null);
    for (const n of sweep?.data?.draftOrders?.nodes ?? []) {
      if ((n.tags ?? []).some((t: string) => /^carat-idem-/.test(t))) {
        const r = await gql(
          `#graphql
           mutation ($input: DraftOrderDeleteInput!) { draftOrderDelete(input: $input) { deletedId userErrors { message } } }`,
          { input: { id: n.id } }
        ).catch((e) => ({ errors: [{ message: (e as Error).message }] }));
        console.log("  draft delete", n.id, JSON.stringify(r.data?.draftOrderDelete ?? r.errors));
      }
    }
    const ps = await gql(
      `#graphql
       query { products(first: 100) { nodes { id title } } }`
    ).catch(() => null);
    for (const n of ps?.data?.products?.nodes ?? []) {
      if (/^ZZ Livegate/i.test(n.title)) {
        const r = await gql(
          `#graphql
           mutation ($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId userErrors { message } } }`,
          { input: { id: n.id } }
        ).catch((e) => ({ errors: [{ message: (e as Error).message }] }));
        console.log("  product delete", n.title, JSON.stringify(r.data?.productDelete ?? r.errors));
      }
    }
  }
  // Append-only rows cannot be removed; archive so nothing live points at a
  // deleted Shopify product.
  for (const id of created.masterProductIds) {
    await prisma.masterVariant.updateMany({
      where: { masterProductId: id },
      data: { status: "archived", lastSyncedPriceCalculationId: null },
    });
    await prisma.masterProduct.update({ where: { id }, data: { status: "archived" } });
    console.log("  db fixture archived:", id);
  }
  await prisma.idempotencyKey
    .deleteMany({ where: { operationType: "bank_payment_checkout" } })
    .then((r) => console.log("  idempotency keys removed:", r.count))
    .catch(() => {});
}

main()
  .catch((e) => {
    fail += 1;
    console.error("\nABORTED:", (e as Error).message);
  })
  .finally(async () => {
    await cleanup().catch((e) => console.error("cleanup error:", e));
    await prisma.$disconnect();
    console.log(`\nFINAL: ${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  });
