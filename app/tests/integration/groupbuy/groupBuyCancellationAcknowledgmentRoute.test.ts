import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG,
  GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_TEXT,
} from "~/domain/groupbuy/cancellationAcknowledgmentText";
import { openGroupBuyCampaign } from "~/jobs/groupbuy/openCampaign.server";
import type { ShopifyPriceSyncPort } from "~/jobs/pricing/ports";
import { RecordingPriceSyncPort } from "~/jobs/pricing/ports";
import * as groupBuyCancellationAcknowledgmentRoute from "~/routes/apps.carat.group-buy-cancellation-acknowledgment";
import { action } from "~/routes/apps.carat.group-buy-cancellation-acknowledgment";

/**
 * The Group Buy cancellation-acknowledgment CAPTURE endpoint (owner spec
 * 2026-09-27/28) against real Postgres. Mirrors
 * `luxuryAcknowledgmentRoute.test.ts`'s shape and discipline — evidence
 * -critical, so the exact-text/policy-version/timestamp/label/identity shape
 * is asserted directly against the database, never mocked.
 *
 * THE ONE MATERIAL DIFFERENCE FROM THAT SUITE: this route has NO GUEST PATH
 * at all (see the route's own module comment) — an anonymous request is
 * refused with 401, not recorded with a null `customerRef`.
 */

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${(seq += 1)}`;

const SHOP = "caratforus-dev.myshopify.com";

function signedPost(
  path: string,
  queryParams: Record<string, string>,
  body: unknown,
  options: { rawBody?: string } = {}
): Request {
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
    body: options.rawBody ?? JSON.stringify(body),
  });
}

function acknowledgmentRequest(
  overrides: Partial<{ query: Record<string, string>; body: unknown; rawBody: string }> = {}
) {
  return signedPost(
    "/apps/carat/group-buy-cancellation-acknowledgment",
    overrides.query ?? { shop: SHOP, logged_in_customer_id: "112233" },
    overrides.body,
    overrides.rawBody !== undefined ? { rawBody: overrides.rawBody } : {}
  );
}

/**
 * A GENUINELY open campaign — real freeze via `openGroupBuyCampaign`
 * (`group_buy_campaign_open_is_frozen` CHECK requires `pricingProfileId`/
 * `profileVersion`/`snapshotId`/`frozenAsOf`/`openedAt` together, which only
 * that job populates; directly writing `status: "open"` violates it). No
 * Shopify linkage on the variant, so `resolveSyncPort` is never called — same
 * "opens with zero linked variants" shape every other Group Buy fixture in
 * this suite uses.
 */
async function createOpenCampaign() {
  const product = await prisma.masterProduct.create({
    data: {
      name: `gb cancel ack campaign fixture ${uniq()}`,
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
  const variant = await prisma.masterVariant.create({
    data: {
      masterProductId: product.id,
      metal: "gold",
      purity: "GOLD_14K",
      baseWeightGrams: "50.0000",
      weightPerFullSizeGrams: "0.0000",
      status: "active",
      laborSource: "india",
      // Deliberately NO shopifyVariantGid — unlinked, so open() never attempts a real Shopify call.
    },
  });

  const draft = await prisma.groupBuyCampaign.create({
    data: {
      code: `gb-cancel-ack-${uniq()}`,
      name: "cancellation ack fixture",
      currency: "USD",
      createdBy: "integration-test",
      tiers: {
        create: [
          { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
          { tierNumber: 2, minQualifyingUnits: 5, priceMultiplier: "0.990000" },
        ],
      },
      variants: {
        create: [{ masterVariantId: variant.id, frozenBaseBankPaymentPriceMinorUnits: 1n, frozenLandedCostMinorUnits: 0n }],
      },
    },
  });

  const noopPort: ShopifyPriceSyncPort = new RecordingPriceSyncPort();
  await openGroupBuyCampaign({
    campaignId: draft.id,
    openedBy: "integration-test",
    asOf: new Date("2026-09-18T12:00:00Z"),
    resolveSyncPort: async () => noopPort,
  });

  return prisma.groupBuyCampaign.findUniqueOrThrow({ where: { id: draft.id } });
}

async function createDraftCampaign() {
  const code = `gb-cancel-ack-draft-${uniq()}`;
  return prisma.groupBuyCampaign.create({
    data: { code, name: "draft fixture", currency: "USD", createdBy: "integration-test" },
  });
}

describe("resource-route shape", () => {
  it("has no default export", () => {
    expect("default" in groupBuyCancellationAcknowledgmentRoute).toBe(false);
    expect(typeof groupBuyCancellationAcknowledgmentRoute.action).toBe("function");
  });
});

describe("method, signature, and authentication guards", () => {
  it("rejects a non-POST request with 405", async () => {
    const url = new URL(`https://shop.example.com/apps/carat/group-buy-cancellation-acknowledgment?shop=${SHOP}`);
    const response = await action({ request: new Request(url, { method: "GET" }), params: {}, context: {} } as never);
    expect(response.status).toBe(405);
  });

  it("rejects an unsigned request with 401, before any body validation", async () => {
    const url = new URL(`https://shop.example.com/apps/carat/group-buy-cancellation-acknowledgment?shop=${SHOP}`);
    const request = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(401);
  });

  it("rejects a tampered signature with 401", async () => {
    const url = new URL(`https://shop.example.com/apps/carat/group-buy-cancellation-acknowledgment?shop=${SHOP}`);
    url.searchParams.set("logged_in_customer_id", "112233");
    url.searchParams.set("signature", "0".repeat(64));
    const request = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ campaignCode: "whatever" }),
    });
    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(401);
  });

  it("NO GUEST PATH — refuses an anonymous (signed, but no logged_in_customer_id) request with 401 and records no acknowledgment", async () => {
    const campaign = await createOpenCampaign();
    const before = await prisma.acknowledgment.count();

    const request = signedPost(
      "/apps/carat/group-buy-cancellation-acknowledgment",
      { shop: SHOP }, // no logged_in_customer_id
      { campaignCode: campaign.code }
    );
    const response = await action({ request, params: {}, context: {} } as never);

    expect(response.status).toBe(401);
    const body = (await response.json()) as { error: string; message: string };
    expect(body.error).toBe("authentication_required");
    expect(body.message).toBe("Please sign in or create a CaratForUs account to continue.");
    await expect(prisma.acknowledgment.count()).resolves.toBe(before);
  });
});

describe("malformed bodies are rejected, not partially processed", () => {
  it("rejects invalid JSON with 400 and records no acknowledgment", async () => {
    const before = await prisma.acknowledgment.count();
    const request = acknowledgmentRequest({ rawBody: "{not json" });
    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(400);
    await expect(prisma.acknowledgment.count()).resolves.toBe(before);
  });

  it("rejects a body missing campaignCode with 400", async () => {
    const request = acknowledgmentRequest({ body: { cartRef: "abc" } });
    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(400);
  });

  it("rejects an empty-string campaignCode with 400", async () => {
    const request = acknowledgmentRequest({ body: { campaignCode: "" } });
    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(400);
  });
});

describe("only a genuinely open campaign gets evidence recorded", () => {
  it("returns 422 campaign_not_open for an unknown campaign code, and records nothing", async () => {
    const before = await prisma.acknowledgment.count();
    const request = acknowledgmentRequest({ body: { campaignCode: `does-not-exist-${uniq()}` } });
    const response = await action({ request, params: {}, context: {} } as never);

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("campaign_not_open");
    await expect(prisma.acknowledgment.count()).resolves.toBe(before);
  });

  it("returns 422 campaign_not_open for a campaign still in draft, and records nothing", async () => {
    const campaign = await createDraftCampaign();
    const before = await prisma.acknowledgment.count();
    const request = acknowledgmentRequest({ body: { campaignCode: campaign.code } });
    const response = await action({ request, params: {}, context: {} } as never);

    expect(response.status).toBe(422);
    await expect(prisma.acknowledgment.count()).resolves.toBe(before);
  });
});

describe("the evidence row a successful call writes", () => {
  it("persists exact text, policy version, timestamp, affirmative action label, and the AUTHENTICATED customer/campaign refs; returns the id", async () => {
    const campaign = await createOpenCampaign();
    const before = Date.now();

    const request = acknowledgmentRequest({
      query: { shop: SHOP, logged_in_customer_id: "778899" },
      body: { campaignCode: campaign.code, cartRef: "cart-token-abc123" },
    });
    const response = await action({ request, params: {}, context: {} } as never);

    expect(response.status).toBe(201);
    const body = (await response.json()) as { acknowledgmentId: string };
    expect(typeof body.acknowledgmentId).toBe("string");

    const row = await prisma.acknowledgment.findUnique({
      where: { id: body.acknowledgmentId },
      include: { policyVersion: true },
    });
    expect(row).not.toBeNull();
    expect(row?.exactText).toBe(GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_TEXT);
    expect(row?.affirmativeActionLabel).toBe(GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL);
    expect(row?.policyVersion.slug).toBe(GROUP_BUY_CANCELLATION_ACKNOWLEDGMENT_POLICY_SLUG);
    expect(row?.campaignRef).toBe(campaign.code);
    expect(row?.cartRef).toBe("cart-token-abc123");
    // THE AUTHENTICATED identity — never a client-supplied field (there is
    // none in the request body at all).
    expect(row?.customerRef).toBe("gid://shopify/Customer/778899");
    expect(row?.acknowledgedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row?.acknowledgedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("resolves productRef/variantRef best-effort when a known shopifyVariantId is given, but never gates creation on it", async () => {
    const campaign = await createOpenCampaign();
    const product = await prisma.masterProduct.create({
      data: {
        name: `gb cancel ack variant fixture ${uniq()}`,
        category: "ring",
        sizeAxis: "none",
        allowedSizeMin: "0",
        allowedSizeMax: "0",
        sizeIncrement: "1",
        baseSize: "0",
        offeredMetals: ["gold"],
        status: "active",
        shopifyProductGid: `gid://shopify/Product/${uniq()}`,
      },
    });
    const variant = await prisma.masterVariant.create({
      data: {
        masterProductId: product.id,
        metal: "gold",
        purity: "GOLD_14K",
        baseWeightGrams: "3.0000",
        weightPerFullSizeGrams: "0.0000",
        status: "active",
        laborSource: "india",
        shopifyVariantGid: `gid://shopify/ProductVariant/${uniq()}`,
      },
    });

    const request = acknowledgmentRequest({
      body: { campaignCode: campaign.code, shopifyVariantId: variant.shopifyVariantGid },
    });
    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(201);

    const body = (await response.json()) as { acknowledgmentId: string };
    const row = await prisma.acknowledgment.findUnique({ where: { id: body.acknowledgmentId } });
    expect(row?.variantRef).toBe(variant.shopifyVariantGid);
    expect(row?.productRef).toBe(product.shopifyProductGid);
  });

  it("an unknown shopifyVariantId is a best-effort no-op — still records the acknowledgment successfully", async () => {
    const campaign = await createOpenCampaign();
    const request = acknowledgmentRequest({
      body: { campaignCode: campaign.code, shopifyVariantId: "gid://shopify/ProductVariant/does-not-exist" },
    });
    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(201);

    const body = (await response.json()) as { acknowledgmentId: string };
    const row = await prisma.acknowledgment.findUnique({ where: { id: body.acknowledgmentId } });
    expect(row?.variantRef).toBeNull();
    expect(row?.productRef).toBeNull();
    expect(row?.campaignRef).toBe(campaign.code);
  });

  it("does not leak cost, margin, or any pricing field in the response", async () => {
    const campaign = await createOpenCampaign();
    const request = acknowledgmentRequest({ body: { campaignCode: campaign.code } });
    const response = await action({ request, params: {}, context: {} } as never);
    const text = await response.text();
    expect(text).not.toMatch(/cost|margin|landedCost|price/i);
  });

  it("a second acknowledgment for the same customer and campaign creates a second, independent evidence row", async () => {
    const campaign = await createOpenCampaign();

    const first = await action({
      request: acknowledgmentRequest({ body: { campaignCode: campaign.code } }),
      params: {},
      context: {},
    } as never);
    const second = await action({
      request: acknowledgmentRequest({ body: { campaignCode: campaign.code } }),
      params: {},
      context: {},
    } as never);

    const firstBody = (await first.json()) as { acknowledgmentId: string };
    const secondBody = (await second.json()) as { acknowledgmentId: string };
    expect(firstBody.acknowledgmentId).not.toBe(secondBody.acknowledgmentId);
  });
});
