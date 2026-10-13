/**
 * Proves the ONE part of the approved copy the main 2C-b gate could not: the
 * dynamic first name.
 *
 * That gate's fixtures use synthetic draft-order gids, so the Shopify lookup
 * correctly returns null and the email falls back to "Hi there,". The fallback
 * is real behaviour worth having, but it is not the owner's requirement. This
 * creates a REAL draft order carrying a real first name and checks what the
 * customer would actually read.
 *
 * Sends no email: Resend delivery is already proven by the main gate. A
 * capturing port records the body while the REAL Shopify resolver runs, which
 * is the part under test here.
 */
import { createHmac, randomUUID } from "node:crypto";

import { prisma } from "~/db/client.server";
import { runGuaranteeSweep } from "~/jobs/bankpayment/guaranteeSweep.server";
import type { EmailPortResolution } from "~/lib/email/configuredPort.server";
import { action } from "~/routes/apps.carat.bank-checkout";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;
const FIRST_NAME = "Ada";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const created = { productGids: [] as string[], draftGids: [] as string[], masterProductIds: [] as string[] };
let gql: ((q: string, v?: Record<string, unknown>) => Promise<any>) | null = null;

async function main() {
  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);
  gql = async (q: string, v: Record<string, unknown> = {}) =>
    (await (await admin.graphql(q, { variables: v })).json()) as any;

  const stamp = `firstname-${Date.now()}`;
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
  created.productGids.push(product.id);
  const variantGid: string = product.variants.nodes[0].id;
  await gql(
    `#graphql
     mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
       productVariantsBulkUpdate(productId: $productId, variants: $variants) { userErrors { message } }
     }`,
    { productId: product.id, variants: [{ id: variantGid, price: "500.00", inventoryPolicy: "CONTINUE" }] }
  );

  const profile = await prisma.pricingProfile.findFirstOrThrow({
    where: { code: "buy_now", isPlaceholder: false },
    orderBy: { version: "desc" },
  });
  const mp = await prisma.masterProduct.create({
    data: {
      name: `firstname ${stamp}`,
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

  const mkCalc = async (bank: bigint) => {
    const snap = await prisma.snapshot.create({
      data: { kind: "pricing.firstname", payload: {}, contentHash: `fn-${randomUUID()}` },
    });
    return prisma.priceCalculation.create({
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
        landedCostMinorUnits: 20_000n,
        bankPaymentPriceMinorUnits: bank,
        currency: "USD",
        status: "computed",
      },
    });
  };

  const quoted = await mkCalc(50_000n);
  await prisma.masterVariant.update({ where: { id: mv.id }, data: { lastSyncedPriceCalculationId: quoted.id } });

  // A REAL draft order, through the real checkout route, carrying a real name.
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
          firstName: FIRST_NAME,
          lastName: "Lovelace",
          address1: "1 Test Way",
          city: "London",
          zip: "SW1A 1AA",
          countryCode: "GB",
        },
        lines: [{ shopifyVariantId: variantGid, quantity: 1 }],
      }),
    }),
    params: {},
    context: {},
  } as never);
  const out = (await res.json()) as any;
  if (res.status !== 200) throw new Error("checkout failed: " + JSON.stringify(out));
  created.draftGids.push(out.draftOrderGid);
  check("a real draft order exists carrying a real shipping first name", true, out.draftOrderGid);

  const order = await prisma.bankPaymentOrder.findFirstOrThrow({
    where: { shopifyDraftOrderGid: out.draftOrderGid },
  });
  const quotedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await prisma.bankPaymentOrder.update({
    where: { id: order.id },
    data: { quotedAt, guaranteeExpiresAt: new Date(quotedAt.getTime() + 86_400_000) },
  });

  const repriced = await mkCalc(60_000n);
  await prisma.masterVariant.update({ where: { id: mv.id }, data: { lastSyncedPriceCalculationId: repriced.id } });
  await prisma.priceSyncIntent.create({
    data: {
      masterVariantId: mv.id,
      priceCalculationId: repriced.id,
      decision: "needs_approval",
      status: "synced",
      decidedBy: "livegate-admin",
      decidedAt: new Date(quotedAt.getTime() + 60_000),
      syncedAt: new Date(quotedAt.getTime() + 120_000),
      shopifyVariantGid: variantGid,
    },
  });

  const sent: { subject: string; text: string }[] = [];
  const resolveEmailPort = (): EmailPortResolution => ({
    configured: true,
    from: "CaratForUs <orders@caratforus.com>",
    recipients: ["orders@caratforus.com"],
    port: {
      async send(input) {
        sent.push({ subject: input.subject, text: input.text });
        return { providerMessageId: `captured-${randomUUID()}` };
      },
    },
  });

  const sweep = await runGuaranteeSweep({ now: new Date(), resolveEmailPort });
  console.log("  sweep:", JSON.stringify(sweep));
  check("the order was cancelled", sweep.cancelled >= 1);
  check("exactly one customer email was built", sent.length === 1, String(sent.length));

  const body = sent[0]?.text ?? "";
  console.log("  greeting line:", JSON.stringify(body.split("\n")[0]));
  check("the greeting uses the REAL first name read from Shopify", body.startsWith(`Hi ${FIRST_NAME},`));
  check("it did NOT fall back to the neutral greeting", !body.startsWith("Hi there,"));

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
}

async function cleanup() {
  console.log("\n=== CLEANUP ===");
  if (gql) {
    for (const id of created.draftGids) {
      const r = await gql(
        `#graphql
         mutation ($input: DraftOrderDeleteInput!) { draftOrderDelete(input: $input) { deletedId userErrors { message } } }`,
        { input: { id } }
      ).catch((e) => ({ errors: [String(e)] }));
      console.log("  draft delete", id, JSON.stringify(r.data?.draftOrderDelete ?? r.errors));
    }
    for (const id of created.productGids) {
      const r = await gql(
        `#graphql
         mutation ($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId userErrors { message } } }`,
        { input: { id } }
      ).catch((e) => ({ errors: [String(e)] }));
      console.log("  product delete", id, JSON.stringify(r.data?.productDelete ?? r.errors));
    }
  }
  for (const id of created.masterProductIds) {
    await prisma.masterVariant.updateMany({
      where: { masterProductId: id },
      data: { status: "archived", lastSyncedPriceCalculationId: null },
    });
    await prisma.masterProduct.update({ where: { id }, data: { status: "archived" } });
  }
  await prisma.idempotencyKey.deleteMany({ where: { operationType: "bank_payment_checkout" } }).catch(() => {});
  console.log("  db fixtures archived");
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
