import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { loader } from "~/routes/apps.carat.group-buy.$code";
import { openGroupBuyCampaign } from "~/jobs/groupbuy/openCampaign.server";
import { recordUnitEvent } from "~/jobs/groupbuy/unitLedger.server";

/**
 * The storefront progress endpoint, served through Shopify's App Proxy.
 *
 * Two things are worth proving against a real request rather than a unit test:
 * that an UNSIGNED caller gets nothing, and that a signed one gets no cost
 * data. The first is the boundary; the second is the standing rule that
 * supplier-private costs and margins never reach a storefront client.
 */

const ASOF = new Date("2026-09-18T12:00:00Z");
let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;

/** Signs query params exactly as Shopify's App Proxy does. */
function signed(path: string, params: Record<string, string>): Request {
  const secret = process.env.SHOPIFY_API_SECRET as string;
  const message = Object.entries(params)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  const signature = createHmac("sha256", secret).update(message, "utf8").digest("hex");

  const url = new URL(`https://shop.example.com${path}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  url.searchParams.set("signature", signature);
  return new Request(url);
}

async function openCampaign(options?: { units?: number; scheduledCloseAt?: Date }) {
  const variant = await prisma.masterVariant.findFirstOrThrow({
    where: { status: "active", masterProduct: { isLuxurySteal: false } },
    orderBy: { baseWeightGrams: "desc" },
  });

  const code = `gb-progress-${uniq()}`;
  const draft = await prisma.groupBuyCampaign.create({
    data: {
      code,
      name: "progress fixture",
      currency: "USD",
      createdBy: "integration-test",
      scheduledCloseAt: options?.scheduledCloseAt ?? null,
      tiers: {
        create: [
          { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
          { tierNumber: 2, minQualifyingUnits: 5, priceMultiplier: "0.990000" },
        ],
      },
      variants: {
        create: [
          { masterVariantId: variant.id, frozenBaseBankPaymentPriceMinorUnits: 1n, frozenLandedCostMinorUnits: 0n },
        ],
      },
    },
  });

  await openGroupBuyCampaign({ campaignId: draft.id, openedBy: "staff", asOf: ASOF });

  if (options?.units) {
    await recordUnitEvent({
      campaignId: draft.id,
      masterVariantId: variant.id,
      kind: "purchased",
      quantity: options.units,
      orderRef: "order-1",
      lineRef: "line-1",
      externalRef: `ext-${uniq()}`,
      occurredAt: ASOF,
      recordedBy: "test",
    });
  }

  return { campaignId: draft.id, code, variantId: variant.id };
}

function call(code: string, params: Record<string, string> = {}) {
  return loader({
    request: signed(`/apps/carat/group-buy/${code}`, { shop: "caratforus-dev.myshopify.com", ...params }),
    params: { code },
    context: {},
  } as unknown as Parameters<typeof loader>[0]);
}

describe("the App Proxy boundary", () => {
  it("REJECTS an unsigned request", async () => {
    const { code } = await openCampaign();
    const response = await loader({
      request: new Request(`https://shop.example.com/apps/carat/group-buy/${code}`),
      params: { code },
      context: {},
    } as unknown as Parameters<typeof loader>[0]);

    expect(response.status).toBe(401);
  });

  it("rejects a request whose signature does not match its parameters", async () => {
    // Tampering with a parameter after signing must invalidate it.
    const { code } = await openCampaign();
    const request = signed(`/apps/carat/group-buy/${code}`, { shop: "caratforus-dev.myshopify.com" });
    const tampered = new URL(request.url);
    tampered.searchParams.set("shop", "evil.example.com");

    const response = await loader({
      request: new Request(tampered),
      params: { code },
      context: {},
    } as unknown as Parameters<typeof loader>[0]);

    expect(response.status).toBe(401);
  });

  it("accepts a correctly signed request", async () => {
    const { code } = await openCampaign({ units: 2 });
    expect((await call(code)).status).toBe(200);
  });
});

describe("what a shopper is shown", () => {
  it("returns the live progress fields", async () => {
    const { code, variantId } = await openCampaign({
      units: 5,
      scheduledCloseAt: new Date("2027-01-01T00:00:00Z"),
    });

    const body = (await (await call(code, { variant: variantId })).json()) as Record<string, unknown>;

    expect(body.qualifyingUnitsSold).toBe(5);
    expect(body.currentTierNumber).toBe(2);
    expect(body.bestPriceUnlocked).toBe(true);
    expect(body.groupBuyRegularCardPriceMinorUnits).toBeTruthy();
    expect(body.groupBuyBankPaymentPriceMinorUnits).toBeTruthy();
    expect(body.buyNowRegularCardPriceMinorUnits).toBeTruthy();
    expect(body.buyNowBankPaymentPriceMinorUnits).toBeTruthy();
    expect(body.tierMarkers).toHaveLength(2);
    expect(body.coreMessage).toMatch(/your final price drops too/);
  });

  it("serves BOTH prices, with the card price derived from the bank one", () => {
    // End to end through the real route, because the tier is applied there from
    // the campaign's FROZEN profile — not in the pure view model, which receives
    // both prices already computed. A unit test cannot reach this.
    const check = async () => {
      const { code } = await openCampaign({ units: 5 });
      const body = (await (await call(code)).json()) as Record<string, string>;

      const bank = BigInt(body.groupBuyBankPaymentPriceMinorUnits!);
      const card = BigInt(body.groupBuyRegularCardPriceMinorUnits!);

      // Recomputed HERE in integer arithmetic, from the published tier table,
      // rather than by calling the same helper the route used — a test that
      // reuses the implementation only proves the route called it.
      const rateNumerator =
        bank >= 500_000n
          ? 1030n
          : bank >= 250_000n
            ? 1035n
            : bank >= 100_000n
              ? 1040n
              : bank >= 50_000n
                ? 1045n
                : 1050n;
      // x rate, then ceiling to the next $5, both without leaving integers.
      const scaled = bank * rateNumerator; // price x 1000
      const prelimCeilCents = scaled / 1000n + (scaled % 1000n === 0n ? 0n : 1n);
      const expected =
        prelimCeilCents % 500n === 0n
          ? prelimCeilCents
          : prelimCeilCents + (500n - (prelimCeilCents % 500n));

      expect(card).toBe(expected);
      expect(card % 500n).toBe(0n);
      expect(card).toBeGreaterThanOrEqual(bank);
    };
    return check();
  });

  it("states no bank/card percentage and no tier rate", () => {
    // Policy §6: the two absolute prices cross the boundary, the rate that
    // relates them does not. Checked on the serialised body, because that is
    // what actually reaches a shopper's browser.
    const check = async () => {
      const { code } = await openCampaign({ units: 3 });
      const text = JSON.stringify(await (await call(code)).json()).toLowerCase();

      for (const leak of ["uplift", "tierlabel", "0.05", "0.045", "0.04", "0.035", "ruleid"]) {
        expect(text, `response must not contain "${leak}"`).not.toContain(leak);
      }
    };
    return check();
  });

  it('serves the "Save $Y with Bank Payment" figure', () => {
    // Policy §9, through the real route: the saving must equal the difference
    // between the two prices the same response carries.
    const check = async () => {
      const { code } = await openCampaign({ units: 5 });
      const body = (await (await call(code)).json()) as Record<string, string>;

      expect(BigInt(body.groupBuyBankPaymentSavingsMinorUnits!)).toBe(
        BigInt(body.groupBuyRegularCardPriceMinorUnits!) -
          BigInt(body.groupBuyBankPaymentPriceMinorUnits!)
      );
    };
    return check();
  });

  it("LEAKS NO cost, margin or profile data", async () => {
    // The standing rule: supplier-private cost data and admin-only margins never
    // reach a storefront client. Asserted on the serialised response, because
    // that is what actually crosses the wire.
    const { code } = await openCampaign({ units: 3 });
    const text = JSON.stringify(await (await call(code)).json()).toLowerCase();

    for (const leak of ["landedcost", "cost", "margin", "profit", "floor", "profile", "multiplier"]) {
      expect(text, `response must not contain "${leak}"`).not.toContain(leak);
    }
  });

  it("is cached privately and briefly, never shared", async () => {
    // Unit counts move as people buy; a shared cache would show one shopper
    // another's stale tier.
    const { code } = await openCampaign();
    const cacheControl = (await call(code)).headers.get("Cache-Control");

    expect(cacheControl).toMatch(/private/);
    expect(cacheControl).not.toMatch(/public/);
  });
});

describe("campaigns a shopper may not see", () => {
  it("404s an unknown code", async () => {
    expect((await call("no-such-campaign")).status).toBe(404);
  });

  it("404s a DRAFT campaign, indistinguishably from one that does not exist", async () => {
    // A storefront has no business learning which campaigns are being planned.
    const variant = await prisma.masterVariant.findFirstOrThrow({ where: { status: "active" } });
    const code = `gb-draft-${uniq()}`;
    await prisma.groupBuyCampaign.create({
      data: {
        code,
        name: "unopened",
        currency: "USD",
        createdBy: "test",
        tiers: {
          create: [
            { tierNumber: 1, minQualifyingUnits: 1, priceMultiplier: "1.000000" },
            { tierNumber: 2, minQualifyingUnits: 5, priceMultiplier: "0.990000" },
          ],
        },
        variants: {
          create: [
            { masterVariantId: variant.id, frozenBaseBankPaymentPriceMinorUnits: 1n, frozenLandedCostMinorUnits: 0n },
          ],
        },
      },
    });

    const response = await call(code);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "not_found" });
  });
});

describe("the theme passes Shopify variant ids, not ours", () => {
  it("resolves a bare Shopify variant id to the campaign's variant", async () => {
    // A theme knows Shopify ids and nothing about our master variants.
    // Requiring the internal id would have made the storefront block
    // unimplementable — the kind of gap only found when wiring it up.
    const { code, variantId } = await openCampaign({ units: 2 });
    await prisma.masterVariant.update({
      where: { id: variantId },
      data: { shopifyVariantGid: "gid://shopify/ProductVariant/987654" },
    });

    const body = (await (await call(code, { shopify_variant: "987654" })).json()) as {
      variantId: string;
    };
    expect(body.variantId).toBe(variantId);
  });

  it("accepts a full gid too", async () => {
    const { code, variantId } = await openCampaign({ units: 1 });
    await prisma.masterVariant.update({
      where: { id: variantId },
      data: { shopifyVariantGid: "gid://shopify/ProductVariant/112233" },
    });

    const body = (await (
      await call(code, { shopify_variant: "gid://shopify/ProductVariant/112233" })
    ).json()) as { variantId: string };
    expect(body.variantId).toBe(variantId);
  });

  it("still renders when the Shopify id is unknown, rather than 404ing", async () => {
    // Shopify ids are null until sync happens, so an unmatched id must fall
    // back to the first eligible variant. Failing here would leave the block
    // permanently broken until Slice 2 finishes.
    const { code, variantId } = await openCampaign({ units: 1 });

    const body = (await (await call(code, { shopify_variant: "does-not-exist" })).json()) as {
      variantId: string;
    };
    expect(body.variantId).toBe(variantId);
  });
});
