import { createHmac, randomUUID } from "node:crypto";

import { afterEach, describe, expect, it, vi } from "vitest";

import { prisma } from "~/db/client.server";
import { computeGroupBuyTierLinePrice, type GroupBuyTierPricingProfile } from "~/domain/bankpayment/groupBuyTierPrice";
import {
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_LINE_ITEM_PROPERTY_NAME,
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG,
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_TEXT,
} from "~/domain/groupbuy/cancellationAcknowledgmentText";
import type { RoundingRuleId } from "~/domain/money/rounding";
import type { PriceEndingRuleId, RegularCardPriceRuleId } from "~/domain/pricing/types";
import { getQualifyingUnits } from "~/jobs/groupbuy/unitLedger.server";
import { openGroupBuyCampaign } from "~/jobs/groupbuy/openCampaign.server";
import type { LuxuryStealOrderReviewPort } from "~/shopify/admin/luxuryStealOrderReviewAdapter.server";
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

// Lets one test force the route's 503 branch WITHOUT touching the database.
// policy_version is append-only at the DB level, so deleting the real,
// migration-provisioned Group Buy cancellation row to simulate a
// misprovisioned environment is not possible — and should not be. vi.hoisted,
// NOT a plain `let`: vi.mock factories are hoisted above module scope, so a
// factory closing over an ordinary top-level variable cannot see later
// assignments to it. Mirrors `rmaIntakeRoute.test.ts`'s identical fixture,
// adapted: unlike that route, `apps.carat.group-buy-bank-checkout.tsx`
// IMPORTS `getLatestPolicyVersion` directly (rather than redefining a local
// wrapper around it), so mocking this module intercepts the real call site.
const mockState = vi.hoisted(() => ({ cancellationAcknowledgmentUnavailable: false }));
vi.mock("~/db/repositories/policyVersionRepository.server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/db/repositories/policyVersionRepository.server")>();
  return {
    ...actual,
    getLatestPolicyVersion: async (...args: Parameters<typeof actual.getLatestPolicyVersion>) =>
      mockState.cancellationAcknowledgmentUnavailable ? null : actual.getLatestPolicyVersion(...args),
  };
});
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
    // Not exercised by this suite. Throws rather than returning a stub value,

    // so an accidental call is loud instead of silently succeeding.
    // The fallback-benefit redemption path. Refused rather than stubbed
    // permissively: no Bank Payment, deposit or admin flow should ever create a
    // redemption draft order, so a call here is a defect worth failing on.
    // The Custom Jewelry final-purchase path. Refused rather than stubbed
    // permissively: no Bank Payment, Group Buy, redemption or deposit flow
    // should ever create a custom jewelry draft order, so a call here is a
    // defect worth failing on.
    async createCustomJewelryDraftOrder(): Promise<never> {
      throw new Error("createCustomJewelryDraftOrder is not expected in this test");
    },
    async createRedemptionDraftOrder(): Promise<never> {
      throw new Error("createRedemptionDraftOrder is not expected in this test");
    },

    async createServiceDraftOrder(): Promise<never> {

      throw new Error("createServiceDraftOrder is not expected in this test");

    },

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
  mockState.cancellationAcknowledgmentUnavailable = false;
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

/**
 * A Group Buy line verifies ONLY if it carries the acknowledgment property
 * AND the order names the customer that acknowledgment was recorded for.
 * BOTH are required: the handler builds its expected context from the ORDER'S
 * OWN customer and checks the candidate against that, so a correct property on
 * an order with no customer still fails. A line missing either is held and
 * counts ZERO units — the locked rule working, not a bug.
 */
function buildOrderRawBody(
  orderGid: string,
  lines: { lineId: string; variantGid: string; quantity: number; ackId?: string }[],
  extra: { customerId?: string } = {}
): string {
  const lineItemsJson = lines
    .map((l) => {
      const propertiesJson = l.ackId
        ? `[{"name":${JSON.stringify(GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_LINE_ITEM_PROPERTY_NAME)},"value":${JSON.stringify(l.ackId)}}]`
        : `[]`;
      return `{"id":${l.lineId},"admin_graphql_api_id":"gid://shopify/LineItem/${l.lineId}","variant_id":"${l.variantGid}","quantity":${l.quantity},"properties":${propertiesJson}}`;
    })
    .join(",");
  const customerJson = extra.customerId
    ? `,"customer":{"id":${extra.customerId},"admin_graphql_api_id":"gid://shopify/Customer/${extra.customerId}"}`
    : "";
  return `{"admin_graphql_api_id":"${orderGid}","created_at":"2026-09-27T00:00:00Z"${customerJson},"line_items":[${lineItemsJson}]}`;
}

/** A genuine, verifiable acknowledgment for a campaign — the same shape the checkout route writes. */
async function seedCancellationAcknowledgment(campaignCode: string, customerGid: string = DEFAULT_CUSTOMER_GID) {
  const pv = await prisma.policyVersion.findFirstOrThrow({
    where: { slug: GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG },
    orderBy: { version: "desc" },
  });
  return prisma.acknowledgment.create({
    data: {
      exactText: pv.text,
      policyVersionId: pv.id,
      acknowledgedAt: new Date(),
      affirmativeActionLabel: GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
      customerRef: customerGid,
      campaignRef: campaignCode,
    },
  });
}


/**
 * The order-create handler reconciles Shopify review state (tag, and a hold
 * on any acknowledgment-failed line) AFTER counting units, resolving its port
 * through `unauthenticated.admin()` by default. There is no Shopify session
 * in an integration run, so that default throws
 * "Could not find a session for shop ..." and takes the whole webhook with
 * it. These tests drive the REAL handler to advance REAL campaign progress;
 * the Shopify-side tagging is a consequence of verification, not the thing
 * under test here, so the port is injected as a recording fake.
 *
 * `listFulfillmentOrders` returns [] deliberately: nothing is held in these
 * tests, so `holdFulfillmentOrder` must never be reached, and the recorded
 * arrays below let a test assert that. Mirrors
 * `tests/integration/groupbuy/orderCreateWebhook.test.ts`s `fakeReviewPort`,
 * kept local because that one is not exported.
 */
function fakeReviewPortDeps() {
  const tagCalls: { orderGid: string; tags: string[] }[] = [];
  const holdCalls: { fulfillmentOrderGid: string }[] = [];
  const port: LuxuryStealOrderReviewPort = {
    async addOrderTags({ orderGid, tags }) {
      tagCalls.push({ orderGid, tags: [...tags] });
    },
    async listFulfillmentOrders() {
      return [];
    },
    async holdFulfillmentOrder({ fulfillmentOrderGid }) {
      holdCalls.push({ fulfillmentOrderGid });
      return { status: "ON_HOLD", recognizedVia: "applied" as const, userErrorCodes: [] };
    },
  };
  return { deps: { resolveReviewPort: async () => port }, tagCalls, holdCalls };
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
          cancellationAcknowledgmentAccepted: true,
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
          cancellationAcknowledgmentAccepted: true,
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
          cancellationAcknowledgmentAccepted: true,
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
          cancellationAcknowledgmentAccepted: true,
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
          cancellationAcknowledgmentAccepted: true,
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
          cancellationAcknowledgmentAccepted: true,
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
      quotedAt: string;
      paymentDueBy: string;
      lines: { quotedBankPaymentPriceMinorUnits: string }[];
    };
    expect(body.tierNumber).toBe(1);
    expect(body.lines[0]!.quotedBankPaymentPriceMinorUnits).toBe(expected.bankPaymentPriceMinorUnits.toString());
    // 48 HOURS — the CUSTOMER deadline, matching the instructions email and
    // the locked "You have 48 hours" sentence. The 96-hour value is the
    // INACTIVATION instant: internal lifecycle timing that must never appear
    // on a customer surface. Asserted in both directions so swapping them
    // fails loudly rather than shipping a date four days out.
    expect(new Date(body.paymentDueBy).getTime() - new Date(body.quotedAt).getTime()).toBe(48 * 60 * 60 * 1000);
    expect(new Date(body.paymentDueBy).getTime() - new Date(body.quotedAt).getTime()).not.toBe(96 * 60 * 60 * 1000);

    // The adapter was told to charge the SAME figure, and completed
    // immediately — see the route's own module comment on why this differs
    // from Buy Now.
    expect(port.createCalls).toHaveLength(1);
    expect(port.createCalls[0]!.lineItems[0]!.unitPrice.amountMinorUnits).toBe(expected.bankPaymentPriceMinorUnits);
    expect(port.completeCalls).toHaveLength(1);

    const stored = await prisma.groupBuyBankPaymentOrder.findUniqueOrThrow({ where: { id: body.groupBuyBankPaymentOrderId } });
    // The Shopify handle is PERSISTED but no longer RETURNED (register D12):
    // it is a live handle to a real unpaid order and the customer has no use
    // for it. Read it from the row, which is where staff reconciliation reads
    // it too.
    expect(stored.shopifyOrderGid).toBe(port.completeCalls[0]!.orderGid ?? stored.shopifyOrderGid);
    expect(stored.shopifyOrderGid.startsWith("gid://shopify/Order/")).toBe(true);
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
          cancellationAcknowledgmentAccepted: true,
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
        // Synthetic order, but a GENUINE acknowledgment: this event only
        // exists to advance real campaign progress to tier 2, and an
        // unacknowledged line counts zero units, so it would advance nothing.
        buildOrderRawBody(
          `gid://shopify/Order/${nextNumericId()}`,
          [
            {
              lineId: nextNumericId(),
              variantGid: variant.shopifyVariantGid!,
              quantity: 5,
              ackId: (await seedCancellationAcknowledgment(campaign.code)).id,
            },
          ],
          { customerId: DEFAULT_CUSTOMER_ID }
        )
      ),
      fakeReviewPortDeps().deps
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
          cancellationAcknowledgmentAccepted: true,
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
          cancellationAcknowledgmentAccepted: true,
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
    const body = (await response.json()) as { groupBuyBankPaymentOrderId: string };

    // Not paid, not verified — this order is UNPAID from the moment it is
    // created (owner §24) — yet counting is unconditional on that.
    //
    // Looked up by the CaratForUs reference rather than the Shopify handle:
    // the handle is persisted but no longer returned to the customer
    // (register D12). The webhook below still uses the REAL handle, read
    // from the row — which is the end-to-end property this test exists for.
    const stored = await prisma.groupBuyBankPaymentOrder.findUniqueOrThrow({ where: { id: body.groupBuyBankPaymentOrderId } });
    expect(stored.status).toBe("active");

    // In production, Shopify itself fires `orders/create` for the order
    // `completeDraftOrder` just created; here that delivery is simulated
    // with the REAL handler against the REAL order gid this route produced.
    await handleGroupBuyOrderCreateWebhook(
      receivedOrderEvent(
        // THE END-TO-END PROOF, and the reason this test is worth its runtime.
        // The property carries the id the ROUTE itself persisted, read back
        // from the row above — not a value this test invented. That is what
        // makes this exercise the real production path: route mints the id and
        // sends it to Shopify on every line, Shopify returns it as a line
        // property, the webhook resolves it and counts the units. Before the
        // draft-order lines carried this attribute at all, this arrived as
        // `no_candidate` -> `unmatched` -> HELD at ZERO units.
        buildOrderRawBody(
          stored.shopifyOrderGid,
          [
            {
              lineId: nextNumericId(),
              variantGid: variant.shopifyVariantGid!,
              quantity: 3,
              ackId: stored.cancellationAcknowledgmentId,
            },
          ],
          { customerId: DEFAULT_CUSTOMER_ID }
        )
      ),
      fakeReviewPortDeps().deps
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
      cancellationAcknowledgmentAccepted: true,
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
          cancellationAcknowledgmentAccepted: true,
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
          cancellationAcknowledgmentAccepted: true,
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

describe("Group Buy cancellation acknowledgment — required, server-side, fail closed", () => {
  it("rejects cancellationAcknowledgmentAccepted: false (not literal true) with 400 and creates no draft order", async () => {
    const { variant } = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const response = await action({
      request: checkoutRequest({
        body: {
          mode: "bank",
          cancellationAcknowledgmentAccepted: false,
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
    const orders = await prisma.groupBuyBankPaymentOrder.count({ where: { campaignId: campaign.id } });
    expect(orders).toBe(0);
  });

  it("rejects cancellationAcknowledgmentAccepted missing entirely with 400 — never inferred from absence, and creates no draft order", async () => {
    const { variant } = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const response = await action({
      request: checkoutRequest({
        body: {
          mode: "bank",
          // cancellationAcknowledgmentAccepted deliberately omitted.
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

  it("the checkbox statement, label and policy version recorded are byte-identical to the pinned owner-approved copy, and the timestamp/identity come from the request, not the client", async () => {
    const { variant } = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const before = new Date();
    const response = await action({
      request: checkoutRequest({
        body: {
          mode: "bank",
          cancellationAcknowledgmentAccepted: true,
          campaignCode: campaign.code,
          email: `Buyer-${uniq()}@Example.com`,
          shippingAddress: SHIPPING_ADDRESS,
          lines: [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 1 }],
        },
      }),
      params: {},
      context: {},
    } as never);
    const after = new Date();

    expect(response.status).toBe(200);
    const body = (await response.json()) as { groupBuyBankPaymentOrderId: string };

    const stored = await prisma.groupBuyBankPaymentOrder.findUniqueOrThrow({
      where: { id: body.groupBuyBankPaymentOrderId },
    });
    expect(stored.cancellationAcknowledgmentId).toBeTruthy();

    const acknowledgment = await prisma.acknowledgment.findUniqueOrThrow({
      where: { id: stored.cancellationAcknowledgmentId },
      include: { policyVersion: true },
    });

    // BYTE-IDENTICAL to the pinned constant — compared programmatically, not
    // eyeballed (the assigning instruction's own explicit requirement).
    expect(acknowledgment.exactText).toBe(GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_TEXT);
    expect(acknowledgment.affirmativeActionLabel).toBe(GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL);
    expect(acknowledgment.affirmativeActionLabel).toBe("I Understand & Agree");
    expect(acknowledgment.policyVersion.text).toBe(GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_TEXT);

    // Reviewer-independent identity — the AUTHENTICATED customer from the
    // signed App Proxy `logged_in_customer_id`, never a client-supplied field
    // (there is none in the request body at all).
    expect(acknowledgment.customerRef).toBe(DEFAULT_CUSTOMER_GID);
    expect(acknowledgment.campaignRef).toBe(campaign.code);

    // A real timestamp taken at request time, bounded by the test's own
    // before/after window — not a client-supplied value.
    expect(acknowledgment.acknowledgedAt.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(acknowledgment.acknowledgedAt.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  it("an idempotent replay records exactly one acknowledgment, not one per request", async () => {
    const { variant } = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const body = {
      mode: "bank",
      cancellationAcknowledgmentAccepted: true,
      campaignCode: campaign.code,
      email: `Buyer-${uniq()}@Example.com`,
      shippingAddress: SHIPPING_ADDRESS,
      lines: [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 1 }],
    };

    const first = await action({ request: checkoutRequest({ body }), params: {}, context: {} } as never);
    const second = await action({ request: checkoutRequest({ body }), params: {}, context: {} } as never);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const orderCount = await prisma.groupBuyBankPaymentOrder.count({
      where: { campaignId: campaign.id, customerGid: DEFAULT_CUSTOMER_GID },
    });
    expect(orderCount).toBe(1);

    const acknowledgmentCount = await prisma.acknowledgment.count({ where: { campaignRef: campaign.code } });
    expect(acknowledgmentCount).toBe(1);
  });
});

describe("Group Buy cancellation acknowledgment gate — the fail-closed guard for a MISPROVISIONED environment", () => {
  it("returns 503 acknowledgment_copy_pending_approval and creates no order or draft order when the policy cannot be resolved", async () => {
    const { variant } = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    mockState.cancellationAcknowledgmentUnavailable = true;
    try {
      const response = await action({
        request: checkoutRequest({
          body: {
            mode: "bank",
            cancellationAcknowledgmentAccepted: true,
            campaignCode: campaign.code,
            email: `Buyer-${uniq()}@Example.com`,
            shippingAddress: SHIPPING_ADDRESS,
            lines: [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 1 }],
          },
        }),
        params: {},
        context: {},
      } as never);

      expect(response.status).toBe(503);
      const body = (await response.json()) as { error: string };
      expect(body.error).toBe("acknowledgment_copy_pending_approval");
      expect(port.createCalls).toHaveLength(0);
      const orders = await prisma.groupBuyBankPaymentOrder.count({ where: { campaignId: campaign.id } });
      expect(orders).toBe(0);
    } finally {
      mockState.cancellationAcknowledgmentUnavailable = false;
    }
  });

  it("GUARDS THE GUARD — the same request succeeds once the policy is available again", async () => {
    const { variant } = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const response = await action({
      request: checkoutRequest({
        body: {
          mode: "bank",
          cancellationAcknowledgmentAccepted: true,
          campaignCode: campaign.code,
          email: `Buyer-${uniq()}@Example.com`,
          shippingAddress: SHIPPING_ADDRESS,
          lines: [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 1 }],
        },
      }),
      params: {},
      context: {},
    } as never);

    expect(response.status).toBe(200);
  });
});

describe("the acknowledgment id reaches Shopify on every line — without it, ZERO units are ever counted", () => {
  // REGRESSION, and the most consequential one in this file. The
  // `orders/create` handler resolves a Group Buy line's acknowledgment candidate
  // from the `_carat_gb_cancel_ack` line-item property and from NOTHING else.
  // This route creates a DRAFT order, and `DraftOrderLineItemInput` carried no
  // attribute field at all, so every Bank Payment order historically reached
  // the webhook with no property -> `no_candidate` -> `unmatched` -> HELD at
  // ZERO qualifying units, silently breaking the locked rule that a placed
  // Group Buy order counts toward public progress immediately INCLUDING
  // pending Bank Payment orders.
  //
  // Asserting the property is PRESENT is not enough: a property carrying the
  // wrong id fails verification exactly like a missing one. So this asserts the
  // value EQUALS the acknowledgment row actually persisted for the order.
  it("attaches _carat_gb_cancel_ack to every line, valued as the acknowledgment row actually persisted", async () => {
    const { variant } = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const response = await action({
      request: checkoutRequest({
        query: { shop: SHOP, logged_in_customer_id: DEFAULT_CUSTOMER_ID },
        body: {
          mode: "bank",
          cancellationAcknowledgmentAccepted: true,
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
    const body = (await response.json()) as { groupBuyBankPaymentOrderId: string };

    // By CaratForUs reference: the Shopify handle is persisted but no
    // longer returned to the customer (register D12).
    const stored = await prisma.groupBuyBankPaymentOrder.findUniqueOrThrow({
      where: { id: body.groupBuyBankPaymentOrderId },
    });
    expect(stored.cancellationAcknowledgmentId).toBeTruthy();

    expect(port.createCalls).toHaveLength(1);
    const sentLines = port.createCalls[0]!.lineItems;
    expect(sentLines.length).toBeGreaterThan(0);
    for (const line of sentLines) {
      const attr = line.customAttributes?.find(
        (a) => a.key === GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_LINE_ITEM_PROPERTY_NAME
      );
      expect(attr, `line ${line.shopifyVariantGid} carries no acknowledgment property`).toBeDefined();
      // THE ID THE WEBHOOK WILL LOOK UP === THE ID WE ACTUALLY STORED.
      expect(attr!.value).toBe(stored.cancellationAcknowledgmentId);
    }

    // THE ORDER MUST BELONG TO THE AUTHENTICATED CUSTOMER, not to whoever
    // Shopify matches from the email. A draft order created with only an
    // email gets a customer matched or CREATED from it — a different record
    // for the same person. That shipped, and the Slice 6 live gate caught it:
    // the `orders/create` handler compared the customer Shopify attached
    // against the acknowledgment recorded for the authenticated caller, found
    // `customer_mismatch`, held the line and counted ZERO units. The
    // acknowledgment check was right; the order was attached to the wrong
    // person. It also kept the order out of the customer's own account, which
    // docs/REQUIRED-CUSTOMER-ACCOUNTS.md requires.
    //
    // No unit test could have found this: a fake draft-order port echoes back
    // whatever it is handed, so the two customer records only diverge against
    // real Shopify. What this test CAN do is pin that the route sends the
    // authenticated gid at all.
    expect(port.createCalls[0]!.customerGid).toBe(DEFAULT_CUSTOMER_GID);

    // And the row is genuinely resolvable by that id — the webhook's own read.
    const ack = await prisma.acknowledgment.findUnique({ where: { id: stored.cancellationAcknowledgmentId } });
    expect(ack).not.toBeNull();
    expect(ack!.customerRef).toBe(DEFAULT_CUSTOMER_GID);
    expect(ack!.campaignRef).toBe(campaign.code);
  });
});

/**
 * D12 — THE CUSTOMER RESPONSE CONTRACT.
 *
 * This route returned its PERSISTED result DTO verbatim, which carried
 * `draftOrderGid` and `shopifyOrderGid`: live handles to a real, unpaid,
 * participation-counting Shopify order. And it stated no payment
 * instructions at all — those reached the customer only by email, so an
 * email-provider outage produced a customer holding a real order with no
 * idea where to send funds.
 *
 * Fake coordinates come from setupEnv.ts, same as the Buy Now suite.
 */
const GB_FAKE_ZELLE = "test-pay@example.invalid";
const GB_FAKE_WIRE_VALUES = [
  "TEST BANK — NOT REAL",
  "TEST ACCOUNT — NOT REAL",
  "000000000",
  "000000000000",
];

interface GroupBuyCustomerBody {
  groupBuyBankPaymentOrderId: string;
  campaignCode: string;
  tierNumber: number;
  paymentDueBy: string;
  instructions: {
    flow: string;
    reference: string;
    formattedAmountDue: string;
    currency: string;
    paymentDeadline: string;
    methods: Array<Record<string, string>>;
    commitmentNotice: string;
    extensionNotice: string | null;
    supportEmail: string;
  };
}

describe("D12 — the Group Buy customer response states how to pay, and leaks no Shopify handle", () => {
  async function placeOrder() {
    const { variant } = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const response = await action({
      request: checkoutRequest({
        body: {
          mode: "bank",
          cancellationAcknowledgmentAccepted: true,
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
    const raw = JSON.stringify(await response.clone().json());
    const body = (await response.json()) as GroupBuyCustomerBody;
    return { raw, body, campaign, port };
  }

  it("carries the FULL instruction set — both methods — so email is not the only channel", async () => {
    const { raw, body } = await placeOrder();

    expect(body.instructions.flow).toBe("group_buy");
    expect(body.instructions.reference).toBe(body.groupBuyBankPaymentOrderId);
    expect(body.instructions.supportEmail).toBe("orders@caratforus.com");

    const zelle = body.instructions.methods.find((m) => m.kind === "zelle");
    expect(zelle?.recipient).toBe(GB_FAKE_ZELLE);
    expect(body.instructions.methods.find((m) => m.kind === "domestic_wire")).toBeDefined();
    for (const value of GB_FAKE_WIRE_VALUES) expect(raw).toContain(value);
  });

  it("leaks NEITHER Shopify handle, nor the internal campaign id", async () => {
    const { raw } = await placeOrder();
    // Both are live handles to a real unpaid order. `campaignId` is an
    // internal primary key; `campaignCode` is the customer-facing one.
    expect(raw).not.toContain("draftOrderGid");
    expect(raw).not.toContain("shopifyOrderGid");
    expect(raw).not.toContain("gid://shopify/Order/");
    expect(raw).not.toContain("gid://shopify/DraftOrder/");
    expect(raw).not.toContain("campaignId");
    expect(raw).not.toContain("priceCalculationId");
  });

  it("states GROUP BUY's commitment language, never Buy Now's", async () => {
    const { body } = await placeOrder();
    // A Group Buy Bank Payment order IS created and DOES count toward the
    // campaign immediately (owner §24). Telling this customer their order
    // "is not committed" — Buy Now's correct sentence — would be false.
    expect(body.instructions.commitmentNotice).toContain("counts toward this campaign");
    expect(body.instructions.commitmentNotice).not.toContain("not committed");
    expect(body.instructions.commitmentNotice).not.toContain("not reserved");
  });

  it("states the 48h + one automatic 48h extension, which Buy Now does not have", async () => {
    const { body } = await placeOrder();
    expect(body.instructions.extensionNotice).toBeTruthy();
    expect(body.instructions.extensionNotice).toContain("48 hours");
  });

  it("the instructions deadline is the 48-HOUR customer deadline, not the 96-hour inactivation instant", async () => {
    const { body } = await placeOrder();
    // One date, stated once. The two used to be able to disagree because
    // nothing rendered `paymentDueBy`; now two surfaces do.
    expect(body.instructions.paymentDeadline).toBe(body.paymentDueBy);
  });

  it("states the amount due on screen, as a decimal string", async () => {
    const { body } = await placeOrder();
    expect(body.instructions.formattedAmountDue).toMatch(/^\d+\.\d{2}$/);
  });

  it("the persisted idempotency resultPayload contains NO coordinate and no composed instructions", async () => {
    const { body } = await placeOrder();

    const rows = await prisma.idempotencyKey.findMany({
      where: {
        operationType: "group_buy_bank_payment_checkout",
        resultPayload: { path: ["groupBuyBankPaymentOrderId"], equals: body.groupBuyBankPaymentOrderId },
      },
    });
    expect(rows).toHaveLength(1);
    const persisted = JSON.stringify(rows[0]);
    // Guards the guard: we really read the payload.
    expect(persisted).toContain(body.groupBuyBankPaymentOrderId);
    expect(persisted).toContain("formattedAmountDue");
    // The coordinate boundary. `paymentInstructionsView.ts`: "THIS OBJECT IS
    // NEVER PERSISTED. NOT ANYWHERE." The envelope is composed AFTER
    // `executeIdempotent` precisely so this stays true.
    expect(persisted).not.toContain(GB_FAKE_ZELLE);
    expect(persisted).not.toContain("instructions");
    for (const value of GB_FAKE_WIRE_VALUES) expect(persisted).not.toContain(value);
  });

  it("no coordinate reaches the stored order, its lines, or the acknowledgment row", async () => {
    const { body } = await placeOrder();
    const stored = await prisma.groupBuyBankPaymentOrder.findUniqueOrThrow({
      where: { id: body.groupBuyBankPaymentOrderId },
      include: { lines: true },
    });
    const ack = await prisma.acknowledgment.findUniqueOrThrow({
      where: { id: stored.cancellationAcknowledgmentId },
    });
    const dump = JSON.stringify({ stored, ack }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    expect(dump).not.toContain(GB_FAKE_ZELLE);
    for (const value of GB_FAKE_WIRE_VALUES) expect(dump).not.toContain(value);
  });

  it("a replay returns the same body — and recomposes the coordinates rather than replaying a stored copy", async () => {
    const { variant } = await createGroupBuyVariant();
    const campaign = await openCampaignFixture(variant.id);
    __setDraftOrderPortForTests(fakeDraftOrderPort());
    const requestBody = {
      mode: "bank",
      cancellationAcknowledgmentAccepted: true,
      campaignCode: campaign.code,
      email: `Buyer-${uniq()}@Example.com`,
      shippingAddress: SHIPPING_ADDRESS,
      lines: [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 1 }],
    };

    const first = await action({ request: checkoutRequest({ body: requestBody }), params: {}, context: {} } as never);
    const second = await action({ request: checkoutRequest({ body: requestBody }), params: {}, context: {} } as never);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);

    const firstBody = (await first.json()) as GroupBuyCustomerBody;
    const secondBody = (await second.json()) as GroupBuyCustomerBody;
    expect(secondBody).toEqual(firstBody);
    expect(secondBody.instructions.methods.find((m) => m.kind === "zelle")?.recipient).toBe(GB_FAKE_ZELLE);

    // And exactly one order exists — the replay created nothing.
    const orders = await prisma.groupBuyBankPaymentOrder.count({ where: { campaignId: campaign.id } });
    expect(orders).toBe(1);
  });
});
