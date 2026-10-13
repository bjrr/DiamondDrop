import { createHmac, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  LUXURY_STEALS_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL,
  LUXURY_STEALS_ACKNOWLEDGMENT_POLICY_SLUG,
  LUXURY_STEALS_ACKNOWLEDGMENT_TEXT,
} from "~/domain/luxurysteals/acknowledgmentText";
import * as luxuryAcknowledgmentRoute from "~/routes/apps.carat.luxury-acknowledgment";
import { action } from "~/routes/apps.carat.luxury-acknowledgment";

/**
 * Slice 3 task 3-3 — the Final Sale acknowledgment capture endpoint against
 * real Postgres (docs/specs/SLICE-3-LUXURY-STEALS.md §4.3, criteria 133-136,
 * 146, 150). Evidence-critical, same reasoning as `bankCheckoutRoute.test.ts`
 * and `luxuryStealRepository.test.ts`: the hard constraint (never record an
 * acknowledgment for a non-Luxury-Steal variant) and the exact-text/
 * policy-version/timestamp/label evidence shape are both asserted directly
 * against the database, not mocked.
 *
 * `prisma/seed.ts`'s `seedLuxuryStealsAcknowledgmentPolicy` must have run
 * against this database before this file — `tests/integration/globalSetup.ts`
 * runs migrations + seed once for the whole integration run, same as every
 * other integration suite that depends on seeded policy_version/pricing_profile
 * rows.
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
    "/apps/carat/luxury-acknowledgment",
    overrides.query ?? { shop: SHOP },
    overrides.body,
    overrides.rawBody !== undefined ? { rawBody: overrides.rawBody } : {}
  );
}

async function createProduct(overrides: { shopifyProductGid?: string } = {}) {
  const suffix = uniq();
  return prisma.masterProduct.create({
    data: {
      name: `luxury acknowledgment fixture ${suffix}`,
      category: "ring",
      sizeAxis: "none",
      allowedSizeMin: "0",
      allowedSizeMax: "0",
      sizeIncrement: "1",
      baseSize: "0",
      offeredMetals: ["gold"],
      status: "active",
      shopifyProductGid: overrides.shopifyProductGid ?? `gid://shopify/Product/${suffix}`,
    },
  });
}

async function createVariant(
  masterProductId: string,
  overrides: { shopifyVariantGid?: string; isLuxurySteal?: boolean } = {}
) {
  const suffix = uniq();
  return prisma.masterVariant.create({
    data: {
      masterProductId,
      metal: "gold",
      purity: "GOLD_14K",
      baseWeightGrams: "3.0000",
      weightPerFullSizeGrams: "0.0000",
      status: "active",
      laborSource: "india",
      shopifyVariantGid: overrides.shopifyVariantGid ?? `gid://shopify/ProductVariant/${suffix}`,
      isLuxurySteal: overrides.isLuxurySteal ?? false,
    },
  });
}

describe("resource-route shape", () => {
  it("has no default export (F-23 — a default export would 400 every real caller in production)", () => {
    expect("default" in luxuryAcknowledgmentRoute).toBe(false);
    expect(typeof luxuryAcknowledgmentRoute.action).toBe("function");
  });
});

describe("method and signature guards", () => {
  it("rejects a non-POST request with 405", async () => {
    const url = new URL(`https://shop.example.com/apps/carat/luxury-acknowledgment?shop=${SHOP}`);
    const request = new Request(url, { method: "GET" });
    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(405);
  });

  it("rejects an unsigned request with 401, before any body validation", async () => {
    const url = new URL(`https://shop.example.com/apps/carat/luxury-acknowledgment?shop=${SHOP}`);
    const request = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(401);
  });

  it("rejects a request with a tampered signature with 401", async () => {
    const url = new URL(`https://shop.example.com/apps/carat/luxury-acknowledgment?shop=${SHOP}`);
    url.searchParams.set("signature", "0".repeat(64));
    const request = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ shopifyVariantId: "123" }),
    });
    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(401);
  });
});

describe("malformed or hostile bodies are rejected, not partially processed", () => {
  it("rejects invalid JSON with 400 and records no acknowledgment", async () => {
    const before = await prisma.acknowledgment.count();
    const request = acknowledgmentRequest({ rawBody: "{not json" });
    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(400);
    await expect(prisma.acknowledgment.count()).resolves.toBe(before);
  });

  it("rejects a body missing shopifyVariantId with 400", async () => {
    const request = acknowledgmentRequest({ body: { cartRef: "abc" } });
    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("invalid_request");
  });

  it("rejects an empty-string shopifyVariantId with 400", async () => {
    const request = acknowledgmentRequest({ body: { shopifyVariantId: "" } });
    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(400);
  });

  it("ignores an unexpected client-supplied isLuxurySteal flag rather than trusting it", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: false });

    const request = acknowledgmentRequest({
      body: { shopifyVariantId: variant.shopifyVariantGid, isLuxurySteal: true },
    });
    const response = await action({ request, params: {}, context: {} } as never);

    // The schema has no such field — a hostile/naive client cannot use it to
    // bypass the server-side Postgres check below.
    expect(response.status).toBe(422);
  });
});

describe("criterion 150 — Postgres is the only source of truth", () => {
  it("returns 404 for a shopifyVariantId that does not map to any master_variant", async () => {
    const request = acknowledgmentRequest({ body: { shopifyVariantId: `gid://shopify/ProductVariant/${randomUUID()}` } });
    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(404);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("unknown_variant");
  });

  it("refuses to record an acknowledgment for a variant that is not a Luxury Steal, and creates no row", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: false });
    const before = await prisma.acknowledgment.count();

    const request = acknowledgmentRequest({ body: { shopifyVariantId: variant.shopifyVariantGid } });
    const response = await action({ request, params: {}, context: {} } as never);

    expect(response.status).toBe(422);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("not_a_luxury_steal");
    await expect(prisma.acknowledgment.count()).resolves.toBe(before);
  });

  it("accepts a bare numeric variant id, normalized the same way apps.carat.cart.tsx does", async () => {
    const product = await createProduct();
    const bareId = `${Date.now()}${seq}`;
    const variant = await createVariant(product.id, {
      shopifyVariantGid: `gid://shopify/ProductVariant/${bareId}`,
      isLuxurySteal: true,
    });

    const request = acknowledgmentRequest({ body: { shopifyVariantId: bareId } });
    const response = await action({ request, params: {}, context: {} } as never);

    expect(response.status).toBe(201);
    const body = (await response.json()) as { acknowledgmentId: string };
    const row = await prisma.acknowledgment.findUnique({ where: { id: body.acknowledgmentId } });
    expect(row?.variantRef).toBe(variant.shopifyVariantGid);
  });
});

describe("criteria 134-136 — the evidence row a successful call writes", () => {
  it("persists exact text, policy version, timestamp, affirmative action label and refs; returns the id", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: true });
    const before = Date.now();

    const request = acknowledgmentRequest({
      query: { shop: SHOP, logged_in_customer_id: "778899" },
      body: { shopifyVariantId: variant.shopifyVariantGid, cartRef: "cart-token-abc123" },
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
    expect(row?.exactText).toBe(LUXURY_STEALS_ACKNOWLEDGMENT_TEXT);
    expect(row?.affirmativeActionLabel).toBe(LUXURY_STEALS_ACKNOWLEDGMENT_AFFIRMATIVE_ACTION_LABEL);
    expect(row?.policyVersion.slug).toBe(LUXURY_STEALS_ACKNOWLEDGMENT_POLICY_SLUG);
    expect(row?.productRef).toBe(product.shopifyProductGid);
    expect(row?.variantRef).toBe(variant.shopifyVariantGid);
    expect(row?.cartRef).toBe("cart-token-abc123");
    expect(row?.customerRef).toBe("gid://shopify/Customer/778899");
    expect(row?.acknowledgedAt.getTime()).toBeGreaterThanOrEqual(before - 1000);
    expect(row?.acknowledgedAt.getTime()).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it("leaves cartRef and customerRef null when neither is available (no cart yet, guest visitor)", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: true });

    const request = acknowledgmentRequest({ body: { shopifyVariantId: variant.shopifyVariantGid } });
    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(201);

    const body = (await response.json()) as { acknowledgmentId: string };
    const row = await prisma.acknowledgment.findUnique({ where: { id: body.acknowledgmentId } });
    expect(row?.cartRef).toBeNull();
    expect(row?.customerRef).toBeNull();
  });

  it("does not leak cost, margin, or any pricing field in the response", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: true });

    const request = acknowledgmentRequest({ body: { shopifyVariantId: variant.shopifyVariantGid } });
    const response = await action({ request, params: {}, context: {} } as never);
    const text = await response.text();

    expect(text).not.toMatch(/cost|margin|landedCost|price/i);
  });

  it("a second acknowledgment for the same variant creates a second, independent evidence row", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id, { isLuxurySteal: true });

    const first = await action({
      request: acknowledgmentRequest({ body: { shopifyVariantId: variant.shopifyVariantGid } }),
      params: {},
      context: {},
    } as never);
    const second = await action({
      request: acknowledgmentRequest({ body: { shopifyVariantId: variant.shopifyVariantGid } }),
      params: {},
      context: {},
    } as never);

    const firstBody = (await first.json()) as { acknowledgmentId: string };
    const secondBody = (await second.json()) as { acknowledgmentId: string };
    expect(firstBody.acknowledgmentId).not.toBe(secondBody.acknowledgmentId);
  });
});
