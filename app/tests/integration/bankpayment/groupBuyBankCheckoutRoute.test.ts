import { createHmac, randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { computeGroupBuyTierLinePrice, type GroupBuyTierPricingProfile } from "~/domain/bankpayment/groupBuyTierPrice";
import type { RoundingRuleId } from "~/domain/money/rounding";
import type { PriceEndingRuleId, RegularCardPriceRuleId } from "~/domain/pricing/types";
import { getQualifyingUnits } from "~/jobs/groupbuy/unitLedger.server";
import { openGroupBuyCampaign } from "~/jobs/groupbuy/openCampaign.server";
import { handleGroupBuyOrderCreateWebhook } from "~/shopify/webhooks/groupBuyOrderHandler.server";
import type { ReceivedWebhookEvent } from "~/shopify/webhooks/receive.server";
import type {
  CancelDraftOrderInput,
  CompleteDraftOrderInput,
  CompletedDraftOrder,
  CreateDraftOrderInput,
  CreatedDraftOrder,
  DraftOrderPort,
  SendDraftOrderInvoiceInput,
} from "~/shopify/admin/draftOrderAdapter.server";
import { action, __setDraftOrderPortForTests } from "~/routes/apps.carat.group-buy-bank-checkout";
import {
  action as bankCheckoutAction,
  __setDraftOrderPortForTests as __setBankCheckoutDraftOrderPortForTests,
} from "~/routes/apps.carat.bank-checkout";

/**
 * The Group Buy Bank Payment checkout route, against real Postgres. Shopify
 * itself is faked (`fakeDraftOrderPort` below) — same reasoning as
 * `bankCheckoutRoute.test.ts`: this route's job is deciding WHAT to send and
 * WHAT to persist, not the Admin API serialisation contract, which is
 * `draftOrderAdapter.test.ts`'s own tested surface.
 */

const ASOF = new Date("2026-09-27T00:00:00Z");
const SHOP = "caratforus-dev.myshopify.com";
const DEFAULT_CUSTOMER_ID = "222222";
const DEFAULT_CUSTOMER_GID = `gid://shopify/Customer/${DEFAULT_CUSTOMER_ID}`;

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;
let numericSeq = 1;
function nextNumericId(): string {
  numericSeq += 1;
  return `${Date.now()}${numericSeq}`;
}

function signedPost(path: string, queryParams: Record<string, string>, body: unknown): Request {
  const secret = process.env.SHOPIFY_API_SECRET as string;
  const message = Object.entries(queryParams)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  const signature = createHmac("sha256", secret).update(message, "utf8").digest("hex");

  const url = new URL(`https://shop.example.com${path}`);
  for (const [k, v] of Object.entries(queryParams)) url.searchParams.set(k, v);
  url.searchParams.set("signature", signature);

  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function checkoutRequest(overrides: Partial<{ query: Record<string, string>; body: unknown }> = {}) {
  return signedPost(
    "/apps/carat/group-buy-bank-checkout",
    overrides.query ?? { shop: SHOP, logged_in_customer_id: DEFAULT_CUSTOMER_ID },
    overrides.body
  );
}

const SHIPPING_ADDRESS = {
  firstName: "Ada",
  lastName: "Lovelace",
  address1: "1 Analytical Engine Way",
  city: "London",
  zip: "SW1A 1AA",
  countryCode: "GB",
};

function fakeDraftOrderPort(): DraftOrderPort & {
  createCalls: CreateDraftOrderInput[];
  completeCalls: CompleteDraftOrderInput[];
} {
  const createCalls: CreateDraftOrderInput[] = [];
  const completeCalls: CompleteDraftOrderInput[] = [];
  return {
    createCalls,
    completeCalls,
    async createDraftOrder(input: CreateDraftOrderInput): Promise<CreatedDraftOrder> {
      createCalls.push(input);
      const id = randomUUID();
      return { draftOrderGid: `gid://shopify/DraftOrder/${id}`, invoiceUrl: `https://${SHOP}/invoice/${id}` };
    },
    async sendInvoice(_input: SendDraftOrderInvoiceInput) {
      throw new Error("sendInvoice is not exercised by this route — see its own module comment");
    },
    async completeDraftOrder(input: CompleteDraftOrderInput): Promise<CompletedDraftOrder> {
      completeCalls.push(input);
      const id = randomUUID();
      return { orderGid: `gid://shopify/Order/${id}`, orderName: `#${completeCalls.length}` };
    },
    async cancelDraftOrder(_input: CancelDraftOrderInput) {
      throw new Error("cancelDraftOrder is not exercised by this route's tests");
    },
  };
}

const createdMasterProductIds: string[] = [];

afterEach(async () => {
  __setDraftOrderPortForTests(null);
  __setBankCheckoutDraftOrderPortForTests(null);
  if (createdMasterProductIds.length === 0) return;
  await prisma.masterVariant.updateMany({
    where: { masterProductId: { in: createdMasterProductIds } },
    data: { status: "archived" },
  });
  createdMasterProductIds.length = 0;
});

/**
 * A DEDICATED, FRESH product/variant per fixture — never the shared
 * "heaviest active variant" other Group Buy suites pick, and never given a
 * `shopifyProductGid` — so `openGroupBuyCampaign`'s own tier-1 publish (a
 * side effect unrelated to anything this file tests) finds the variant
 * unlinked and skips calling Shopify at all; no fake `ShopifyPriceSyncPort`
 * is needed anywhere in this file for that reason. 50g of gold gives enough
 * absolute margin for a 1% tier discount to still clear the minimum-profit
 * floor, same reasoning `orderCreateWebhook.test.ts`'s identical fixture
 * documents.
 */
async function createGroupBuyVariant() {
  const suffix = uniq();
  const product = await prisma.masterProduct.create({
    data: {
      name: `gb-bank-checkout fixture ${suffix}`,
      category: "ring",
      sizeAxis: "none",
      allowedSizeMin: "0",
      allowedSizeMax: "0",
      sizeIncrement: "1",
      baseSize: "0",
      offeredMetals: ["gold"],
      status: "active",
    },
  });
  createdMasterProductIds.push(product.id);

  const shopifyVariantGid = `gid://shopify/ProductVariant/${nextNumericId()}`;
  const variant = await prisma.masterVariant.create({
    data: {
      masterProductId: product.id,
      metal: "gold",
      purity: "GOLD_14K",
      baseWeightGrams: "50.0000",
      weightPerFullSizeGrams: "0.0000",
      status: "active",
      laborSource: "india",
      shopifyVariantGid,
      isLuxurySteal: true, // excluded from every other suite's shared "heaviest, non-Luxury-Steal" fixture query
    },
  });

  return { product, variant };
}

/** A synced Buy Now variant (no Group Buy campaign at all) — for the "not a Group Buy variant" refusal tests. */
async function createPlainBuyNowVariant() {
  return createGroupBuyVariant();
}

const TIERS = [
  { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
  { tierNumber: 2, minQualifyingUnits: 5, priceMultiplier: "0.990000" },
] as const;

async function openCampaignFixture(masterVariantId: string, status: "draft" | "open" = "open") {
  const campaign = await prisma.groupBuyCampaign.create({
    data: {
      code: `gb-bank-checkout-${uniq()}`,
      name: "group buy bank checkout fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: { create: [...TIERS] },
      variants: {
        create: [{ masterVariantId, frozenBaseBankPaymentPriceMinorUnits: 200_000n, frozenLandedCostMinorUnits: 100_000n }],
      },
    },
  });

  if (status === "open") {
    await openGroupBuyCampaign({ campaignId: campaign.id, openedBy: "staff", asOf: ASOF });
  }
  return campaign;
}

/**
 * `openGroupBuyCampaign` RECOMPUTES each variant's frozen base from REAL
 * current cost inputs (`computeBuyNowPrice`) at open time — it does not
 * trust the placeholder passed into `frozenBaseBankPaymentPriceMinorUnits`
 * at campaign creation (see `openCampaign.server.ts`). So this test file
 * cannot hardcode an expected price; it reads back the REAL frozen base and
 * profile the campaign actually opened with, and computes the expected
 * figure through the same pure pipeline the route itself uses
 * (`computeGroupBuyTierLinePrice`) — an independent call against real data,
 * not a copy of the route's own arithmetic.
 */
async function computeExpectedTierPrice(campaignId: string, masterVariantId: string, tierNumber: number) {
  const campaign = await prisma.groupBuyCampaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: { pricingProfile: true, tiers: true },
  });
  const campaignVariant = await prisma.groupBuyCampaignVariant.findUniqueOrThrow({
    where: { campaignId_masterVariantId: { campaignId, masterVariantId } },
  });
  const tier = campaign.tiers.find((t) => t.tierNumber === tierNumber)!;
  const profile: GroupBuyTierPricingProfile = {
    roundingRuleId: campaign.pricingProfile!.roundingRuleId as RoundingRuleId,
    priceEndingRuleId: campaign.pricingProfile!.priceEndingRuleId as PriceEndingRuleId,
    regularCardPriceRuleId: campaign.pricingProfile!.regularCardPriceRuleId as RegularCardPriceRuleId,
    fixedCardUpliftRate: campaign.pricingProfile!.fixedCardUpliftRate.toString(),
  };
  return computeGroupBuyTierLinePrice(
    campaignVariant.frozenBaseBankPaymentPriceMinorUnits,
    { tierNumber: tier.tierNumber, minQualifyingUnits: tier.minQualifyingUnits, priceMultiplier: tier.priceMultiplier.toString() },
    profile,
    campaign.currency
  );
}

function receivedOrderEvent(rawBody: string): ReceivedWebhookEvent {
  return {
    shopifyEventId: randomUUID(),
    topic: "orders/create",
    shopDomain: SHOP,
    rawBody,
    payload: JSON.parse(rawBody) as unknown,
  };
}

function buildOrderRawBody(orderGid: string, lines: { lineId: string; variantGid: string; quantity: number }[]): string {
  const lineItemsJson = lines
    .map(
      (l) =>
        `{"id":${l.lineId},"admin_graphql_api_id":"gid://shopify/LineItem/${l.lineId}","variant_id":"${l.variantGid}","quantity":${l.quantity}}`
    )
    .join(",");
  return `{"admin_graphql_api_id":"${orderGid}","created_at":"2026-09-27T00:00:00Z","line_items":[${lineItemsJson}]}`;
}

describe("docs/REQUIRED-CUSTOMER-ACCOUNTS.md §4 — no anonymous Group Buy Bank Payment checkout", () => {
  it("refuses an anonymous request with 401 authentication_required, before any body validation, and creates no draft order", async () => {
    const { variant } = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const response = await action({
      request: checkoutRequest({
        query: { shop: SHOP },
        body: {
          mode: "bank",
          campaignCode: campaign.code,
          email: `Buyer-${uniq()}@Example.com`,
          shippingAddress: SHIPPING_ADDRESS,
          lines: [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 1 }],
        },
      }),
      params: {},
      context: {},
    } as never);

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("authentication_required");
    expect(body.message).toBe("Please sign in or create a CaratForUs account to continue.");
    expect(port.createCalls).toHaveLength(0);
  });

  it("rejects an unsigned request with 401 before anything else", async () => {
    const url = new URL(`https://shop.example.com/apps/carat/group-buy-bank-checkout?shop=${SHOP}`);
    const response = await action({
      request: new Request(url, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" }),
      params: {},
      context: {},
    } as never);
    expect(response.status).toBe(401);
  });
});

describe("campaign eligibility", () => {
  it("refuses an unknown campaign code", async () => {
    const { variant } = await createGroupBuyVariant();
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const response = await action({
      request: checkoutRequest({
        body: {
          mode: "bank",
          campaignCode: `does-not-exist-${uniq()}`,
          email: `Buyer-${uniq()}@Example.com`,
          shippingAddress: SHIPPING_ADDRESS,
          lines: [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 1 }],
        },
      }),
      params: {},
      context: {},
    } as never);

    expect(response.status).toBe(400);
    expect((await response.json())).toMatchObject({ error: "campaign_not_open" });
    expect(port.createCalls).toHaveLength(0);
  });

  it("refuses a campaign that is still in draft — pricing is not frozen yet", async () => {
    const { variant } = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id, "draft");
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const response = await action({
      request: checkoutRequest({
        body: {
          mode: "bank",
          campaignCode: campaign.code,
          email: `Buyer-${uniq()}@Example.com`,
          shippingAddress: SHIPPING_ADDRESS,
          lines: [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 1 }],
        },
      }),
      params: {},
      context: {},
    } as never);

    expect(response.status).toBe(400);
    expect((await response.json())).toMatchObject({ error: "campaign_not_open" });
    expect(port.createCalls).toHaveLength(0);
  });

  it("refuses a variant that is NOT part of this open campaign (an ordinary Buy Now variant) — the mirror of criterion 76", async () => {
    const { variant: groupBuyVariant } = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(groupBuyVariant.id);
    const { variant: plainVariant } = await createPlainBuyNowVariant();
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const response = await action({
      request: checkoutRequest({
        body: {
          mode: "bank",
          campaignCode: campaign.code,
          email: `Buyer-${uniq()}@Example.com`,
          shippingAddress: SHIPPING_ADDRESS,
          lines: [{ shopifyVariantId: plainVariant.shopifyVariantGid, quantity: 1 }],
        },
      }),
      params: {},
      context: {},
    } as never);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; shopifyVariantIds: string[] };
    expect(body.error).toBe("not_group_buy_variant");
    expect(body.shopifyVariantIds).toEqual([plainVariant.shopifyVariantGid]);
    expect(port.createCalls).toHaveLength(0);
  });

  it("refuses a variant belonging to a DIFFERENT open campaign than the one named", async () => {
    const { variant: variantA } = await createGroupBuyVariant();
    await openCampaignFixture(variantA.id);
    const { variant: variantB } = await createGroupBuyVariant();
    const campaignB = await openCampaignFixture(variantB.id);
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const response = await action({
      request: checkoutRequest({
        body: {
          mode: "bank",
          campaignCode: campaignB.code,
          email: `Buyer-${uniq()}@Example.com`,
          shippingAddress: SHIPPING_ADDRESS,
          // variantA belongs to campaign A, not campaign B named above.
          lines: [{ shopifyVariantId: variantA.shopifyVariantGid, quantity: 1 }],
        },
      }),
      params: {},
      context: {},
    } as never);

    expect(response.status).toBe(400);
    expect((await response.json())).toMatchObject({ error: "not_group_buy_variant" });
  });

  it("the reverse guard still holds — apps.carat.bank-checkout.tsx still refuses this Group Buy variant", async () => {
    const { variant } = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const port = fakeDraftOrderPort();
    __setBankCheckoutDraftOrderPortForTests(port);

    const response = await bankCheckoutAction({
      request: signedPost(
        "/apps/carat/bank-checkout",
        { shop: SHOP, logged_in_customer_id: DEFAULT_CUSTOMER_ID },
        {
          mode: "bank",
          email: `Buyer-${uniq()}@Example.com`,
          shippingAddress: SHIPPING_ADDRESS,
          lines: [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 1 }],
        }
      ),
      params: {},
      context: {},
    } as never);

    expect(response.status).toBe(400);
    expect((await response.json())).toMatchObject({ error: "group_buy_variant_present" });
    expect(port.createCalls).toHaveLength(0);
    void campaign;
  });
});

describe("pricing — from the frozen snapshot at the CURRENT tier, never getPublishedVariantPrice", () => {
  it("at tier 1, charges the frozen base's tier-1 Bank Payment Price and persists both figures", async () => {
    const { variant } = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);
    const expected = await computeExpectedTierPrice(campaign.id, variant.id, 1);

    const response = await action({
      request: checkoutRequest({
        body: {
          mode: "bank",
          campaignCode: campaign.code,
          email: `Buyer-${uniq()}@Example.com`,
          shippingAddress: SHIPPING_ADDRESS,
          lines: [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 2 }],
        },
      }),
      params: {},
      context: {},
    } as never);

    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      groupBuyBankPaymentOrderId: string;
      tierNumber: number;
      shopifyOrderGid: string;
      quotedAt: string;
      paymentDueBy: string;
      lines: { quotedBankPaymentPriceMinorUnits: string }[];
    };
    expect(body.tierNumber).toBe(1);
    expect(body.lines[0]!.quotedBankPaymentPriceMinorUnits).toBe(expected.bankPaymentPriceMinorUnits.toString());
    expect(new Date(body.paymentDueBy).getTime() - new Date(body.quotedAt).getTime()).toBe(96 * 60 * 60 * 1000);

    // The adapter was told to charge the SAME figure, and completed
    // immediately — see the route's own module comment on why this differs
    // from Buy Now.
    expect(port.createCalls).toHaveLength(1);
    expect(port.createCalls[0]!.lineItems[0]!.unitPrice.amountMinorUnits).toBe(expected.bankPaymentPriceMinorUnits);
    expect(port.completeCalls).toHaveLength(1);

    const stored = await prisma.groupBuyBankPaymentOrder.findUniqueOrThrow({ where: { id: body.groupBuyBankPaymentOrderId } });
    expect(stored.shopifyOrderGid).toBe(body.shopifyOrderGid);
    expect(stored.customerGid).toBe(DEFAULT_CUSTOMER_GID);
    expect(stored.tierNumberAtQuote).toBe(1);
    expect(stored.status).toBe("active");

    const lines = await prisma.groupBuyBankPaymentOrderLine.findMany({ where: { groupBuyBankPaymentOrderId: stored.id } });
    expect(lines).toHaveLength(1);
    expect(lines[0]!.quantity).toBe(2);
    expect(lines[0]!.quotedBankPaymentPriceMinorUnits).toBe(expected.bankPaymentPriceMinorUnits);
    expect(lines[0]!.quotedRegularCardPriceMinorUnits).toBe(expected.regularCardPriceMinorUnits);
  });

  it("once the campaign reaches tier 2, a NEW checkout charges the lower tier-2 price — this order's own price is still whatever it locked in earlier", async () => {
    const { variant } = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    // First customer, at tier 1.
    const firstResponse = await action({
      request: checkoutRequest({
        body: {
          mode: "bank",
          campaignCode: campaign.code,
          email: `Buyer-${uniq()}@Example.com`,
          shippingAddress: SHIPPING_ADDRESS,
          lines: [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 1 }],
        },
      }),
      params: {},
      context: {},
    } as never);
    expect(firstResponse.status).toBe(200);
    const firstBody = (await firstResponse.json()) as { tierNumber: number; shopifyOrderGid: string };
    expect(firstBody.tierNumber).toBe(1);

    // Advance the REAL campaign progress via the REAL orders/create webhook
    // handler — the same mechanism a completed Group Buy Bank Payment order
    // feeds in production — to reach tier 2 (threshold: 5 units).
    await handleGroupBuyOrderCreateWebhook(
      receivedOrderEvent(
        buildOrderRawBody(`gid://shopify/Order/${nextNumericId()}`, [
          { lineId: nextNumericId(), variantGid: variant.shopifyVariantGid!, quantity: 5 },
        ])
      )
    );
    // The FIRST order's own webhook delivery was never simulated (a separate
    // test proves that wiring) — only this deliberate 5-unit event feeds the
    // ledger here, which alone crosses the tier-2 threshold (5).
    expect((await getQualifyingUnits(campaign.id)).total).toBe(5);
    const expectedTier2 = await computeExpectedTierPrice(campaign.id, variant.id, 2);

    // Second customer, now at tier 2.
    const secondResponse = await action({
      request: checkoutRequest({
        query: { shop: SHOP, logged_in_customer_id: "333333" },
        body: {
          mode: "bank",
          campaignCode: campaign.code,
          email: `Buyer-${uniq()}@Example.com`,
          shippingAddress: SHIPPING_ADDRESS,
          lines: [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 1 }],
        },
      }),
      params: {},
      context: {},
    } as never);
    expect(secondResponse.status).toBe(200);
    const secondBody = (await secondResponse.json()) as {
      tierNumber: number;
      lines: { quotedBankPaymentPriceMinorUnits: string }[];
    };
    const expectedTier1 = await computeExpectedTierPrice(campaign.id, variant.id, 1);
    expect(secondBody.tierNumber).toBe(2);
    expect(secondBody.lines[0]!.quotedBankPaymentPriceMinorUnits).toBe(expectedTier2.bankPaymentPriceMinorUnits.toString());
    expect(expectedTier2.bankPaymentPriceMinorUnits).toBeLessThan(expectedTier1.bankPaymentPriceMinorUnits);
  });
});

describe("a pending Group Buy Bank Payment order counts toward campaign progress immediately", () => {
  it("feeding the completed order's own shopifyOrderGid through the real orders/create webhook records a qualifying unit before any payment", async () => {
    const { variant } = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    expect((await getQualifyingUnits(campaign.id)).total).toBe(0);

    const response = await action({
      request: checkoutRequest({
        body: {
          mode: "bank",
          campaignCode: campaign.code,
          email: `Buyer-${uniq()}@Example.com`,
          shippingAddress: SHIPPING_ADDRESS,
          lines: [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 3 }],
        },
      }),
      params: {},
      context: {},
    } as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { shopifyOrderGid: string };

    // Not paid, not verified — this order is UNPAID from the moment it is
    // created (owner §24) — yet counting is unconditional on that.
    const stored = await prisma.groupBuyBankPaymentOrder.findUniqueOrThrow({ where: { shopifyOrderGid: body.shopifyOrderGid } });
    expect(stored.status).toBe("active");

    // In production, Shopify itself fires `orders/create` for the order
    // `completeDraftOrder` just created; here that delivery is simulated
    // with the REAL handler against the REAL order gid this route produced.
    await handleGroupBuyOrderCreateWebhook(
      receivedOrderEvent(
        buildOrderRawBody(body.shopifyOrderGid, [
          { lineId: nextNumericId(), variantGid: variant.shopifyVariantGid!, quantity: 3 },
        ])
      )
    );

    expect((await getQualifyingUnits(campaign.id)).total).toBe(3);
  });
});

describe("idempotent replay", () => {
  it("a repeated identical submission returns the SAME order and creates no second draft order or completion", async () => {
    const { variant } = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const email = `Buyer-${uniq()}@Example.com`;
    const body = {
      mode: "bank",
      campaignCode: campaign.code,
      email,
      shippingAddress: SHIPPING_ADDRESS,
      lines: [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 1 }],
    };

    const first = await action({ request: checkoutRequest({ body }), params: {}, context: {} } as never);
    const second = await action({ request: checkoutRequest({ body }), params: {}, context: {} } as never);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual(await first.json());

    expect(port.createCalls).toHaveLength(1);
    expect(port.completeCalls).toHaveLength(1);

    const orders = await prisma.groupBuyBankPaymentOrder.count({ where: { campaignId: campaign.id, customerGid: DEFAULT_CUSTOMER_GID } });
    expect(orders).toBe(1);
  });
});

describe("unpurchasable and malformed requests", () => {
  it("refuses an unknown Shopify variant id", async () => {
    const { variant } = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const response = await action({
      request: checkoutRequest({
        body: {
          mode: "bank",
          campaignCode: campaign.code,
          email: `Buyer-${uniq()}@Example.com`,
          shippingAddress: SHIPPING_ADDRESS,
          lines: [{ shopifyVariantId: `gid://shopify/ProductVariant/does-not-exist-${uniq()}`, quantity: 1 }],
        },
      }),
      params: {},
      context: {},
    } as never);

    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; lines: { reason: string }[] };
    expect(body.error).toBe("unpurchasable_lines");
    expect(body.lines[0]!.reason).toBe("unknown_variant");
  });

  it("rejects mode \"card\" — this endpoint creates Bank Payment orders only", async () => {
    const { variant } = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const response = await action({
      request: checkoutRequest({
        body: {
          mode: "card",
          campaignCode: campaign.code,
          email: `Buyer-${uniq()}@Example.com`,
          shippingAddress: SHIPPING_ADDRESS,
          lines: [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 1 }],
        },
      }),
      params: {},
      context: {},
    } as never);

    expect(response.status).toBe(400);
    expect(port.createCalls).toHaveLength(0);
  });

  it("rejects an empty lines array", async () => {
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const response = await action({
      request: checkoutRequest({
        body: {
          mode: "bank",
          campaignCode: `whatever-${uniq()}`,
          email: `Buyer-${uniq()}@Example.com`,
          shippingAddress: SHIPPING_ADDRESS,
          lines: [],
        },
      }),
      params: {},
      context: {},
    } as never);

    expect(response.status).toBe(400);
  });
});
