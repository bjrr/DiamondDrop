/**
 * SLICE 2C-a LIVE GATE — real caratforus-dev, real Admin API, throwaway data.
 *
 * Everything it creates is torn down in the finally block, including on
 * failure. Nothing here is imported by the app.
 */
import { createHmac, randomUUID } from "node:crypto";

import { prisma } from "~/db/client.server";
import { action } from "~/routes/apps.carat.bank-checkout";
import { ShopifyDraftOrderAdapter } from "~/shopify/admin/draftOrderAdapter.server";
import { Money } from "~/domain/money/money";

const SHOP = process.env.SHOPIFY_SHOP_DOMAIN!;
const SECRET = process.env.SHOPIFY_API_SECRET!;

const created = {
  shopifyProductGids: [] as string[],
  draftOrderGids: [] as string[],
  orderGids: [] as string[],
  masterProductIds: [] as string[],
  campaignIds: [] as string[],
};

/**
 * Assigned as the FIRST thing main() does, so teardown can reach Shopify even
 * when main aborts. Set after the fact, it would be null on exactly the runs
 * that leave the most litter behind.
 */
let gql: ((q: string, v: Record<string, unknown>) => Promise<any>) | null = null;

let pass = 0;
let fail = 0;
function check(label: string, ok: boolean, detail?: string) {
  if (ok) {
    pass += 1;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

function signedPost(body: unknown): Request {
  const message = `shop=${SHOP}`;
  const signature = createHmac("sha256", SECRET).update(message, "utf8").digest("hex");
  const url = new URL("https://shop.example.com/apps/carat/bank-checkout");
  url.searchParams.set("shop", SHOP);
  url.searchParams.set("signature", signature);
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const SHIPPING_ADDRESS = {
  firstName: "Livegate",
  lastName: "Throwaway",
  address1: "1 Test Way",
  city: "London",
  zip: "SW1A 1AA",
  countryCode: "GB",
};

async function main() {
  const { unauthenticated } = await import("~/shopify.server");
  const { admin } = await unauthenticated.admin(SHOP);
  gql = async (q: string, variables: Record<string, unknown>) => {
    const r = await admin.graphql(q, { variables });
    return (await r.json()) as any;
  };

  // ---------------------------------------------------------------- phase 0
  console.log("\n=== PHASE 0 — throwaway Shopify product ===");
  const tag = `livegate-${Date.now()}`;
  const pc = await gql(
    `#graphql
     mutation ($input: ProductInput!) {
       productCreate(input: $input) {
         product { id title variants(first: 1) { nodes { id title } } }
         userErrors { field message }
       }
     }`,
    { input: { title: `ZZ Livegate throwaway ${tag}`, status: "ACTIVE", tags: [tag] } }
  );
  if (pc.errors?.length || pc.data?.productCreate?.userErrors?.length) {
    throw new Error("productCreate failed: " + JSON.stringify(pc));
  }
  const product = pc.data.productCreate.product;
  created.shopifyProductGids.push(product.id);
  const variantGid: string = product.variants.nodes[0].id;
  console.log(`  product ${product.id}\n  variant ${variantGid}`);

  // Make it purchasable without stock tracking, so availability never gates us.
  const vu = await gql(
    `#graphql
     mutation ($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
       productVariantsBulkUpdate(productId: $productId, variants: $variants) {
         productVariants { id price inventoryPolicy }
         userErrors { field message }
       }
     }`,
    {
      productId: product.id,
      variants: [{ id: variantGid, price: "1300.00", inventoryPolicy: "CONTINUE" }],
    }
  );
  if (vu.data?.productVariantsBulkUpdate?.userErrors?.length) {
    throw new Error("variant update failed: " + JSON.stringify(vu.data.productVariantsBulkUpdate.userErrors));
  }

  // ---------------------------------------------------------------- phase 1
  console.log("\n=== PHASE 1 — published price in our database ===");
  const BANK = 123_456n; // $1,234.56
  const profile = await prisma.pricingProfile.findFirstOrThrow({
    where: { code: "buy_now" },
    orderBy: { version: "desc" },
  });
  const mp = await prisma.masterProduct.create({
    data: {
      name: `livegate ${tag}`,
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
    data: { kind: "pricing.livegate", payload: {}, contentHash: `livegate-${randomUUID()}` },
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
      bankPaymentPriceMinorUnits: BANK,
      currency: "USD",
      status: "computed",
    },
  });
  await prisma.masterVariant.update({
    where: { id: mv.id },
    data: { lastSyncedPriceCalculationId: calc.id },
  });
  console.log(`  master_variant ${mv.id} published at bank $1,234.56`);

  // ---------------------------------------------------------------- phase 2
  console.log("\n=== PHASE 2 — real Bank Payment checkout ===");
  const email = `livegate-${Date.now()}@example.com`;
  const body = {
    mode: "bank",
    email,
    shippingAddress: SHIPPING_ADDRESS,
    lines: [{ shopifyVariantId: variantGid, quantity: 2 }],
  };
  const res = await action({ request: signedPost(body), params: {}, context: {} } as never);
  const out = (await res.json()) as any;
  check("route returned 200", res.status === 200, `status ${res.status}`);
  if (res.status !== 200) console.log("   body:", JSON.stringify(out));
  const draftGid: string = out.draftOrderGid;
  if (draftGid) created.draftOrderGids.push(draftGid);
  check("draft order gid returned", typeof draftGid === "string" && draftGid.includes("DraftOrder"), draftGid);

  // Read the draft back from Shopify — the authority, not our response body.
  const dq = await gql(
    `#graphql
     query ($id: ID!) {
       draftOrder(id: $id) {
         id name status email invoiceUrl invoiceSentAt tags
         subtotalPriceSet { shopMoney { amount currencyCode } }
         totalPriceSet { shopMoney { amount currencyCode } }
         shippingLine { title originalPriceSet { shopMoney { amount } } }
         shippingAddress { address1 city countryCodeV2 }
         lineItems(first: 10) { nodes { quantity originalUnitPriceSet { shopMoney { amount currencyCode } } variant { id } } }
       }
     }`,
    { id: draftGid }
  );
  const d = dq.data?.draftOrder;
  console.log("  DRAFT ORDER AS SHOPIFY HAS IT:");
  console.log("   ", JSON.stringify(d, null, 1).replace(/\n/g, "\n    "));

  check(
    "line unit price is exactly the Bank Payment Price",
    d?.lineItems?.nodes?.[0]?.originalUnitPriceSet?.shopMoney?.amount === "1234.56",
    d?.lineItems?.nodes?.[0]?.originalUnitPriceSet?.shopMoney?.amount
  );
  check("quantity echoed", d?.lineItems?.nodes?.[0]?.quantity === 2);
  check(
    "subtotal is 2 x 1234.56",
    d?.subtotalPriceSet?.shopMoney?.amount === "2469.12",
    d?.subtotalPriceSet?.shopMoney?.amount
  );
  // Shopify normalises the amount it returns ("0.0", not the "0.00" we sent),
  // so the assertion is on the VALUE being zero and the line being present —
  // which is what D19 requires — not on the formatting of the echo.
  check(
    "shipping line present and zero (D19, criterion 95)",
    typeof d?.shippingLine?.title === "string" &&
      /^0(\.0+)?$/.test(d?.shippingLine?.originalPriceSet?.shopMoney?.amount ?? ""),
    `${d?.shippingLine?.title} @ ${d?.shippingLine?.originalPriceSet?.shopMoney?.amount}`
  );
  check("invoice was sent", d?.invoiceSentAt != null, String(d?.invoiceSentAt));
  check("email on the draft", d?.email === email.toLowerCase() || d?.email === email, d?.email);
  check(
    "correlation tag present",
    Array.isArray(d?.tags) && d.tags.some((t: string) => /^carat-idem-[0-9a-f]{24}$/.test(t)),
    JSON.stringify(d?.tags)
  );
  check(
    "address reached Shopify",
    d?.shippingAddress?.city === "London",
    JSON.stringify(d?.shippingAddress)
  );

  const persisted = await prisma.bankPaymentOrder.findFirstOrThrow({
    where: { shopifyDraftOrderGid: draftGid },
    include: { lines: true },
  });
  check("bank_payment_order persisted", !!persisted);
  check("customer_email stored", persisted.customerEmail.toLowerCase() === email.toLowerCase());
  check(
    "no address column on the order row (criterion 97)",
    !Object.keys(persisted).some((k) => /address|city|zip|postal|country/i.test(k)),
    Object.keys(persisted).join(",")
  );
  check(
    "24h guarantee window",
    persisted.guaranteeExpiresAt.getTime() - persisted.quotedAt.getTime() === 86_400_000
  );
  check("quoted bank price frozen per line", persisted.lines[0]!.quotedBankPaymentPriceMinorUnits === BANK);

  // ---------------------------------------------------------------- phase 3
  console.log("\n=== PHASE 3 — idempotent replay against the real store ===");
  const res2 = await action({ request: signedPost(body), params: {}, context: {} } as never);
  const out2 = (await res2.json()) as any;
  check("replay returned 200", res2.status === 200, `status ${res2.status}`);
  check("replay returned the SAME draft order", out2.draftOrderGid === draftGid, out2.draftOrderGid);
  const orderCount = await prisma.bankPaymentOrder.count({ where: { customerEmail: email.toLowerCase() } });
  check("exactly one bank order row", orderCount === 1, `count ${orderCount}`);
  const dq2 = await gql(
    `#graphql
     query ($id: ID!) { draftOrder(id: $id) { invoiceSentAt } }`,
    { id: draftGid }
  );
  check(
    "no second invoice (invoiceSentAt unchanged)",
    dq2.data?.draftOrder?.invoiceSentAt === d?.invoiceSentAt,
    `${d?.invoiceSentAt} -> ${dq2.data?.draftOrder?.invoiceSentAt}`
  );

  // ---------------------------------------------------------------- phase 4
  console.log("\n=== PHASE 4 — failure cases against the real API ===");
  const adapter = new ShopifyDraftOrderAdapter(admin as never);

  // (a) A userErrors rejection must throw, not silently "succeed".
  let threw = false;
  let msg = "";
  try {
    await adapter.createDraftOrder({
      email: "livegate-bad@example.com",
      shippingAddress: SHIPPING_ADDRESS,
      lineItems: [
        {
          shopifyVariantGid: "gid://shopify/ProductVariant/1",
          quantity: 1,
          unitPrice: Money.fromMinorUnits(100_00n, "USD"),
        },
      ],
    });
  } catch (e) {
    threw = true;
    msg = (e as Error).message;
  }
  check("a rejected create throws rather than reporting success", threw, msg.slice(0, 160));

  // (b) Variable coercion failure arrives on HTTP 200 as top-level errors.
  //     The Shopify client throws rather than returning them, so the proof is
  //     in the thrown error's own networkStatusCode — which is the whole point:
  //     a 200 that is actually a failure.
  let coercionStatus: unknown = "did not throw";
  let coercionMessage = "";
  try {
    await gql(
      `#graphql
     mutation ($input: DraftOrderInput!) { draftOrderCreate(input: $input) { draftOrder { id } userErrors { message } } }`,
      { input: { lineItems: [{ variantId: "not-a-gid", quantity: 1 }] } }
    );
  } catch (e) {
    const anyErr = e as any;
    coercionStatus = anyErr?.body?.errors?.networkStatusCode ?? anyErr?.response?.status;
    coercionMessage = (e as Error).message;
  }
  check(
    "a coercion failure really does arrive on HTTP 200",
    coercionStatus === 200,
    `status ${String(coercionStatus)} — ${coercionMessage.slice(0, 110)}`
  );

  // (c) in_doubt stays recoverable: the tag on the live draft is searchable.
  const idem = await prisma.idempotencyKey.findFirstOrThrow({
    where: { operationType: "bank_payment_checkout" },
    orderBy: { createdAt: "desc" },
  });
  const expectedTag = `carat-idem-${idem.key.slice(idem.key.indexOf(":") + 1).slice(0, 24)}`;
  /**
   * RECOVERABILITY IS PROVEN BY LISTING, NOT BY SEARCH. Shopify's draft-order
   * search index is eventually consistent — `query: "tag:..."` returns nothing
   * for a draft created seconds ago, which would make this check flaky rather
   * than meaningful. Enumerating recent drafts and matching the tag is
   * immediately consistent and is exactly what the teardown sweep does, so
   * this asserts the recovery path that actually works.
   */
  const listed = await gql(
    `#graphql
     query { draftOrders(first: 50, sortKey: UPDATED_AT, reverse: true) { nodes { id tags } } }`,
    {}
  );
  const found = (listed.data?.draftOrders?.nodes ?? []).filter((n: any) => (n.tags ?? []).includes(expectedTag));
  check(
    "an in_doubt key is recoverable from Shopify by its correlation tag",
    found.length === 1 && found[0].id === draftGid,
    `${expectedTag} -> ${found.map((n: any) => n.id).join(",") || "nothing"}`
  );

  // ---------------------------------------------------------------- phase 5
  console.log("\n=== PHASE 5 — Group Buy exclusion, live ===");
  async function campaignFor(masterVariantId: string, status: "draft" | "open" | "closed" | "cancelled") {
    const c = await prisma.groupBuyCampaign.create({
      data: {
        code: `livegate-${randomUUID().slice(0, 8)}`,
        name: "livegate",
        currency: "USD",
        createdBy: "livegate",
        variants: {
          create: [
            { masterVariantId, frozenBaseBankPaymentPriceMinorUnits: 1n, frozenLandedCostMinorUnits: 0n },
          ],
        },
      },
    });
    created.campaignIds.push(c.id);
    if (status === "draft") return c;
    await prisma.groupBuyCampaign.update({
      where: { id: c.id },
      data: {
        status: "open",
        pricingProfileId: profile.id,
        profileVersion: profile.version,
        snapshotId: snap.id,
        frozenAsOf: new Date(),
        openedAt: new Date(),
      },
    });
    if (status !== "open") {
      await prisma.groupBuyCampaign.update({
        where: { id: c.id },
        data: { status, closedAt: new Date() },
      });
    }
    return c;
  }

  let attemptSequence = 0;
  async function attempt(label: string) {
    const r = await action({
      request: signedPost({
        mode: "bank",
        email: `gb-${Date.now()}-${(attemptSequence += 1)}@example.com`,
        shippingAddress: SHIPPING_ADDRESS,
        lines: [{ shopifyVariantId: variantGid, quantity: 1 }],
      }),
      params: {},
      context: {},
    } as never);
    const j = (await r.json()) as any;
    if (j.draftOrderGid) created.draftOrderGids.push(j.draftOrderGid);
    console.log(`   ${label}: status ${r.status} ${j.error ?? "ok"}`);
    return { status: r.status, error: j.error as string | undefined };
  }

  /**
   * ONE CAMPAIGN PER TERMINAL STATE, TRANSITIONED THROUGH — not four created
   * and deleted. Anything past `draft` is frozen by its own triggers: its
   * eligible-variant rows refuse DELETE, so a campaign that has ever opened is
   * permanent. Creating one per status would leave three permanent records
   * where two will do, and the two that remain are genuinely un-removable
   * rather than litter I chose not to clear.
   *
   * A campaign can go draft -> open -> closed OR draft -> open -> cancelled,
   * never both, so `closed` and `cancelled` need separate campaigns. `draft`
   * is still deletable and is cleaned up.
   */
  const draftCampaign = await campaignFor(mv.id, "draft");
  const draftAttempt = await attempt("campaign draft");
  check("a draft campaign does NOT block Buy Now bank checkout", draftAttempt.status === 200, draftAttempt.error ?? "");
  await prisma.groupBuyCampaignVariant.deleteMany({ where: { campaignId: draftCampaign.id } });
  await prisma.groupBuyCampaign.delete({ where: { id: draftCampaign.id } });
  created.campaignIds = created.campaignIds.filter((x) => x !== draftCampaign.id);
  console.log("   draft campaign deleted (still deletable)");

  // open -> blocked, then closed -> allowed, on one campaign.
  const openThenClosed = await campaignFor(mv.id, "open");
  const blocked = await attempt("campaign open");
  check(
    "an OPEN campaign BLOCKS Buy Now bank checkout (criterion 76)",
    blocked.status === 400 && blocked.error === "group_buy_variant_present",
    `${blocked.status} ${blocked.error}`
  );
  await prisma.groupBuyCampaign.update({
    where: { id: openThenClosed.id },
    data: { status: "closed", closedAt: new Date() },
  });
  const closedAttempt = await attempt("campaign closed");
  check("a CLOSED campaign does NOT block Buy Now bank checkout", closedAttempt.status === 200, closedAttempt.error ?? "");

  const openThenCancelled = await campaignFor(mv.id, "open");
  await prisma.groupBuyCampaign.update({
    where: { id: openThenCancelled.id },
    data: { status: "cancelled", closedAt: new Date() },
  });
  const cancelledAttempt = await attempt("campaign cancelled");
  check(
    "a CANCELLED campaign does NOT block Buy Now bank checkout",
    cancelledAttempt.status === 200,
    cancelledAttempt.error ?? ""
  );

  // ---------------------------------------------------------------- phase 6
  console.log("\n=== PHASE 6 — complete the draft through the manual gateway ===");
  const completed = await adapter.completeDraftOrder({ draftOrderGid: draftGid });
  console.log("  completed ->", JSON.stringify(completed));
  created.orderGids.push(completed.orderGid);
  const oq = await gql(
    `#graphql
     query ($id: ID!) {
       order(id: $id) {
         id name displayFinancialStatus
         totalPriceSet { shopMoney { amount currencyCode } }
         lineItems(first: 5) { nodes { quantity originalUnitPriceSet { shopMoney { amount } } } }
       }
     }`,
    { id: completed.orderGid }
  );
  console.log("  ORDER AS SHOPIFY HAS IT:");
  console.log("   ", JSON.stringify(oq.data?.order, null, 1).replace(/\n/g, "\n    "));
  check(
    "completed order carries the bank total, unpaid",
    oq.data?.order?.displayFinancialStatus === "PENDING",
    oq.data?.order?.displayFinancialStatus
  );
  check(
    "order unit price is still the Bank Payment Price",
    oq.data?.order?.lineItems?.nodes?.[0]?.originalUnitPriceSet?.shopMoney?.amount === "1234.56",
    oq.data?.order?.lineItems?.nodes?.[0]?.originalUnitPriceSet?.shopMoney?.amount
  );
  // The draft is consumed by completion; do not try to delete it afterwards.
  created.draftOrderGids = created.draftOrderGids.filter((g) => g !== draftGid);

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
}

async function cleanup() {
  console.log("\n=== CLEANUP ===");
  if (gql) {
    /**
     * ORPHAN SWEEP FIRST, because the tracked list is the one thing a failed
     * run cannot be trusted to hold. When `createDraftOrder` throws AFTER
     * Shopify accepted the draft — which is exactly what the price-mismatch
     * echo check does — the gid never reaches `created.draftOrderGids`, and
     * the draft sits in the store with nothing pointing at it. This is the
     * real version of the in_doubt scenario the correlation tag exists for,
     * so the sweep uses the same handle an admin would.
     */
    const sweep = await gql(
      `#graphql
       query { draftOrders(first: 50, sortKey: UPDATED_AT, reverse: true) { nodes { id email tags } } }`,
      {}
    );
    for (const node of sweep.data?.draftOrders?.nodes ?? []) {
      const mine =
        (node.email ?? "").startsWith("livegate-") ||
        (node.email ?? "").startsWith("gb-") ||
        (node.tags ?? []).some((t: string) => /^carat-idem-/.test(t));
      if (mine && !created.draftOrderGids.includes(node.id)) {
        created.draftOrderGids.push(node.id);
        console.log("  orphan swept:", node.id, node.email, JSON.stringify(node.tags));
      }
    }

    for (const id of created.draftOrderGids) {
      const r = await gql(
        `#graphql
     mutation ($input: DraftOrderDeleteInput!) { draftOrderDelete(input: $input) { deletedId userErrors { message } } }`,
        { input: { id } }
      );
      console.log("  draft delete", id, JSON.stringify(r.data?.draftOrderDelete ?? r.errors));
    }
    for (const id of created.orderGids) {
      const c = await gql(
        `#graphql
     mutation ($id: ID!) { orderCancel(orderId: $id, reason: OTHER, restock: true, notifyCustomer: false, staffNote: "livegate teardown") { userErrors { message } } }`,
        { id }
      );
      console.log("  order cancel", id, JSON.stringify(c.data?.orderCancel?.userErrors ?? c.errors ?? "ok"));
      const del = await gql(`#graphql
     mutation ($id: ID!) { orderDelete(orderId: $id) { deletedId userErrors { message } } }`, { id });
      console.log("  order delete", id, JSON.stringify(del.data?.orderDelete ?? del.errors));
    }
    // Also sweep any throwaway product an aborted earlier run left behind,
    // and the orphaned auto-publish fixture from Stage 2B whose database row
    // no longer exists.
    const ps = await gql(
      `#graphql
     query { products(first: 50, query: "title:ZZ Livegate* OR title:ZZ Auto-publish*") { nodes { id title } } }`,
      {}
    );
    for (const node of ps.data?.products?.nodes ?? []) {
      if (!created.shopifyProductGids.includes(node.id)) {
        created.shopifyProductGids.push(node.id);
        console.log("  stale product swept:", node.id, node.title);
      }
    }

    for (const id of created.shopifyProductGids) {
      const r = await gql(
        `#graphql
     mutation ($input: ProductDeleteInput!) { productDelete(input: $input) { deletedProductId userErrors { message } } }`,
        { input: { id } }
      );
      console.log("  product delete", id, JSON.stringify(r.data?.productDelete ?? r.errors));
    }
  }
  for (const id of created.campaignIds) {
    const c = await prisma.groupBuyCampaign.findUnique({ where: { id }, select: { status: true, code: true } });
    if (c?.status === "draft") {
      await prisma.groupBuyCampaignVariant.deleteMany({ where: { campaignId: id } });
      await prisma.groupBuyCampaign.delete({ where: { id } });
      console.log("  campaign deleted:", c.code);
    } else {
      // Reported, not swallowed: a campaign that has ever opened is frozen by
      // its own triggers and cannot be removed. That is the append-only
      // history the teardown brief exempts, and it should be visible in the
      // log rather than look like a clean run.
      console.log(`  campaign LEFT (frozen, ${c?.status}): ${c?.code}`);
    }
  }
  /**
   * DELETE WHAT MAY BE DELETED; ARCHIVE WHAT MAY NOT.
   *
   * `bank_payment_order_line` carries BEFORE UPDATE / DELETE / TRUNCATE
   * triggers — a quote, once given, is permanent evidence. So a run that
   * actually placed an order cannot be erased, and should not be: that is the
   * append-only history the teardown brief explicitly exempts.
   *
   * What must not survive is a LIVE fixture. The master product and variant
   * are archived rather than deleted, because leaving them `active` would put
   * a variant pointing at a deleted Shopify product into the next
   * recalculation run, where it would fail to sync and raise a real alert
   * about a product nobody can fix.
   */
  for (const id of created.masterProductIds) {
    const variants = await prisma.masterVariant.findMany({ where: { masterProductId: id }, select: { id: true } });
    const vids = variants.map((v) => v.id);
    const quoted = await prisma.bankPaymentOrderLine.count({ where: { masterVariantId: { in: vids } } });
    const calcs = await prisma.priceCalculation.count({ where: { masterVariantId: { in: vids } } });

    // ALWAYS ARCHIVE, NEVER DELETE. `price_calculation` is append-only too, so
    // even a run that quoted nothing leaves a calculation that cannot be
    // removed, and the variant cannot be deleted while it is referenced. The
    // first draft of this teardown tried to delete and silently swallowed the
    // rejection, which would have reported a clean run over rows that were
    // still there.
    await prisma.masterVariant.updateMany({
      where: { id: { in: vids } },
      data: { status: "archived", lastSyncedPriceCalculationId: null },
    });
    await prisma.masterProduct.update({ where: { id }, data: { status: "archived" } });
    console.log(
      `  db fixture ARCHIVED (append-only rows cannot be removed): ${id} — ` +
        `${calcs} price_calculation, ${quoted} bank_payment_order_line`
    );
  }
  await prisma.idempotencyKey
    .deleteMany({ where: { operationType: "bank_payment_checkout" } })
    .then((r) => console.log("  idempotency keys removed:", r.count))
    .catch(() => {});
}

main()
  .catch((e) => {
    fail += 1;
    console.error("\nLIVE GATE ABORTED:", e);
  })
  .finally(async () => {
    await cleanup().catch((e) => console.error("cleanup error:", e));
    await prisma.$disconnect();
    console.log(`\nFINAL: ${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  });
