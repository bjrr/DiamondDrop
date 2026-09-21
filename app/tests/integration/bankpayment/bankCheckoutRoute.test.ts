import { createHmac, randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import type {
  CompleteDraftOrderInput,
  CompletedDraftOrder,
  CancelDraftOrderInput,
  CreateDraftOrderInput,
  CreatedDraftOrder,
  DraftOrderPort,
  SendDraftOrderInvoiceInput,
} from "~/shopify/admin/draftOrderAdapter.server";
import { action, __setDraftOrderPortForTests } from "~/routes/apps.carat.bank-checkout";

/**
 * Slice 2C task 2C-3 — the Bank Payment Checkout route, against real
 * Postgres. Shopify itself is faked (`fakeDraftOrderPort` below):
 * `write_draft_orders` is not yet granted on the dev store (spec §7/§11),
 * and the adapter's own serialisation contract is 2C-1's tested surface,
 * not this route's — see `draftOrderAdapter.test.ts`.
 */

let fixtureSequence = 0;
const uniq = (): string => `${Date.now() % 900_000}-${(fixtureSequence += 1)}`;

const SHOP = "caratforus-dev.myshopify.com";

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

function checkoutRequest(overrides: Partial<{ path: string; query: Record<string, string>; body: unknown }> = {}) {
  return signedPost(overrides.path ?? "/apps/carat/bank-checkout", overrides.query ?? { shop: SHOP }, overrides.body);
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
  invoiceCalls: SendDraftOrderInvoiceInput[];
} {
  const createCalls: CreateDraftOrderInput[] = [];
  const invoiceCalls: SendDraftOrderInvoiceInput[] = [];
  return {
    createCalls,
    invoiceCalls,
    async createDraftOrder(input: CreateDraftOrderInput): Promise<CreatedDraftOrder> {
      createCalls.push(input);
      // A fresh, globally-unique id per call (not a per-instance counter
      // starting at 1) — `shopify_draft_order_gid` is UNIQUE in the shared
      // disposable database, and every test in this file runs against the
      // SAME database, so two tests both minting "DraftOrder/1" collide.
      const id = randomUUID();
      return {
        draftOrderGid: `gid://shopify/DraftOrder/${id}`,
        invoiceUrl: `https://${SHOP}/invoice/${id}`,
      };
    },
    async sendInvoice(input: SendDraftOrderInvoiceInput) {
      invoiceCalls.push(input);
      return { invoiceSentAt: new Date() };
    },
    async completeDraftOrder(_input: CompleteDraftOrderInput): Promise<CompletedDraftOrder> {
      throw new Error("completeDraftOrder is not exercised by this route's tests");
    },
    async cancelDraftOrder(_input: CancelDraftOrderInput) {
      throw new Error("cancelDraftOrder is not exercised by this route's tests");
    },
  };
}

const createdMasterProductIds: string[] = [];

afterEach(async () => {
  __setDraftOrderPortForTests(null);
  if (createdMasterProductIds.length === 0) return;
  await prisma.masterVariant.updateMany({
    where: { masterProductId: { in: createdMasterProductIds } },
    data: { status: "archived" },
  });
  createdMasterProductIds.length = 0;
});

/**
 * USES THE SEEDED PROFILE; DOES NOT MINT ONE.
 *
 * This used to create a fresh `pricing_profile` with code "buy_now", a
 * Date.now()-derived version and effectiveFrom 2020, once per fixture. That
 * quietly hijacked profile resolution for EVERY OTHER FILE in the suite: the
 * engine resolves "the active buy_now profile", and these fixtures kept
 * becoming it. Other suites then reproduced their stored calculations against
 * a profile they had never seen and reported "diverged" — a failure that
 * pointed at the pricing engine and was actually this fixture.
 *
 * It is also how carat_dev accumulated 110 junk profiles (finding F-29).
 *
 * Nothing here needs a bespoke profile: the calculations are written directly
 * with an explicit pricingProfileId, so the seeded active profile serves, and
 * it carries the real tiered card rule the price assertions depend on.
 */
async function makeProfile() {
  return prisma.pricingProfile.findFirstOrThrow({
    where: { code: "buy_now", isPlaceholder: false },
    orderBy: { version: "desc" },
  });
}

/** A synced, purchasable variant at the given Bank Payment Price, ready to check out. */
async function makeSyncedVariant(opts: { bankPaymentPriceMinorUnits: bigint; bankPaymentDiscountEligible?: boolean }) {
  const suffix = uniq();
  const profile = await makeProfile();
  const product = await prisma.masterProduct.create({
    data: {
      name: `bank-checkout fixture ${suffix}`,
      category: "ring",
      sizeAxis: "none",
      allowedSizeMin: "0",
      allowedSizeMax: "0",
      sizeIncrement: "1",
      baseSize: "0",
      offeredMetals: ["gold"],
      status: "active",
      shopifyProductGid: `gid://shopify/Product/${suffix}`,
    },
  });
  createdMasterProductIds.push(product.id);

  const variant = await prisma.masterVariant.create({
    data: {
      masterProductId: product.id,
      metal: "gold",
      purity: "GOLD_14K",
      baseWeightGrams: "3.0000",
      weightPerFullSizeGrams: "0.0000",
      status: "active",
      laborSource: "india",
      shopifyVariantGid: `gid://shopify/ProductVariant/${suffix}`,
      bankPaymentDiscountEligible: opts.bankPaymentDiscountEligible ?? true,
    },
  });

  const snapshot = await prisma.snapshot.create({
    data: { kind: "pricing.it", payload: {}, contentHash: `bank-checkout-${randomUUID()}` },
  });
  const calc = await prisma.priceCalculation.create({
    data: {
      runId: randomUUID(),
      masterVariantId: variant.id,
      pricingProfileId: profile.id,
      profileVersion: profile.version,
      engineVersion: "BUY_NOW_PRICING_V1",
      roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
      priceEndingRuleId: "NONE_V1",
      asOf: new Date(),
      snapshotId: snapshot.id,
      landedCostMinorUnits: 1000n,
      bankPaymentPriceMinorUnits: opts.bankPaymentPriceMinorUnits,
      currency: "USD",
      status: "computed",
    },
  });
  await prisma.masterVariant.update({
    where: { id: variant.id },
    data: { lastSyncedPriceCalculationId: calc.id },
  });

  return { product, variant, calc };
}

/** A variant with NO synced calculation — never purchasable. */
async function makeUnsyncedVariant() {
  const suffix = uniq();
  const product = await prisma.masterProduct.create({
    data: {
      name: `bank-checkout unsynced fixture ${suffix}`,
      category: "ring",
      sizeAxis: "none",
      allowedSizeMin: "0",
      allowedSizeMax: "0",
      sizeIncrement: "1",
      baseSize: "0",
      offeredMetals: ["gold"],
      status: "active",
      shopifyProductGid: `gid://shopify/Product/${suffix}`,
    },
  });
  createdMasterProductIds.push(product.id);

  const variant = await prisma.masterVariant.create({
    data: {
      masterProductId: product.id,
      metal: "gold",
      purity: "GOLD_14K",
      baseWeightGrams: "3.0000",
      weightPerFullSizeGrams: "0.0000",
      status: "active",
      laborSource: "india",
      shopifyVariantGid: `gid://shopify/ProductVariant/${suffix}`,
    },
  });

  return { product, variant };
}

/**
 * STATUS IS AN EXPLICIT ARGUMENT, because it is the whole boundary.
 * Criterion 76 keeps a variant that is being sold through Group Buy RIGHT NOW
 * out of a Buy Now bank order, and that is `open` — the state in which
 * pricing freezes. A `draft`, `closed` or `cancelled` campaign leaves the
 * variant an ordinary Buy Now product that the engine still prices and the
 * storefront still advertises, so refusing it at checkout would lose a
 * legitimate sale after the customer had already filled in the form.
 */
/**
 * WHY THIS INSERTS AN OPEN CAMPAIGN DIRECTLY INSTEAD OF CALLING
 * `openGroupBuyCampaign`, which was the first thing tried.
 *
 * The real service refuses these fixtures, and refuses them correctly. Its
 * tier-safety rules require at least two tiers forming a strictly falling
 * price ladder that still clears the minimum-profit floor; the synthetic
 * variants here price around $354 with very little headroom, so a 1% tier
 * breaches the floor while a 0.01% tier is entirely absorbed by the $5 card
 * rounding and the ladder stops falling. There is no multiplier that
 * satisfies both. Giving the fixtures artificial margin just to get past that
 * would be inventing a product to suit a test.
 *
 * Those rules are Group Buy's, and `freezeAtOpen.test.ts` already proves them
 * against variants with the right shape. What THIS file needs is only a
 * campaign in a given status pointing at a given variant.
 *
 * So the fixture takes the legal path and writes the frozen basis itself:
 * born draft, variant attached, then draft -> open -> closed by UPDATE. Every
 * database rule still applies — `group_buy_campaign_open_is_frozen` is
 * satisfied rather than evaded, and the status-transition trigger still vets
 * each hop. Only the service's tier-safety opinion is bypassed, and that is
 * the one part of opening a campaign this file is not testing.
 */
async function makeGroupBuyVariant(
  masterVariantId: string,
  status: "draft" | "open" | "closed" = "open"
) {
  const base = {
    code: `gb-bank-checkout-${uniq()}`,
    name: "bank-checkout mixed-cart fixture",
    currency: "USD",
    createdBy: "integration-test",
    variants: {
      create: [
        { masterVariantId, frozenBaseBankPaymentPriceMinorUnits: 1n, frozenLandedCostMinorUnits: 0n },
      ],
    },
  };

  // ALWAYS BORN AS A DRAFT, because a campaign that is already open refuses
  // to accept eligible-variant rows at all — its own freeze trigger rejects
  // the INSERT. Draft first, variant attached, then transitioned.
  const campaign = await prisma.groupBuyCampaign.create({ data: base });
  if (status === "draft") return campaign;

  const profile = await prisma.pricingProfile.findFirstOrThrow({
    where: { code: "buy_now" },
    orderBy: { version: "desc" },
  });
  const snapshot = await prisma.snapshot.create({
    data: {
      kind: "group_buy_campaign_freeze",
      payload: { fixture: "bank-checkout" },
      contentHash: `fixture-${uniq()}`,
    },
  });

  // draft -> open, the only legal way in, with the frozen basis the
  // `group_buy_campaign_open_is_frozen` CHECK requires.
  await prisma.groupBuyCampaign.update({
    where: { id: campaign.id },
    data: {
      status: "open",
      pricingProfileId: profile.id,
      profileVersion: profile.version,
      snapshotId: snapshot.id,
      frozenAsOf: new Date(),
      openedAt: new Date(),
    },
  });

  if (status === "closed") {
    await prisma.groupBuyCampaign.update({
      where: { id: campaign.id },
      data: { status: "closed", closedAt: new Date() },
    });
  }
  return campaign;
}

describe("signature verification", () => {
  it("rejects an unsigned request with 401, before any body validation", async () => {
    const url = new URL("https://shop.example.com/apps/carat/bank-checkout?shop=" + SHOP);
    const request = new Request(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(401);
  });
});

describe("criteria 71/72/52 — server-side reprice, eligible and ineligible lines", () => {
  it("charges the Bank Payment Price for an eligible line and the Regular/Card Price for an ineligible one", async () => {
    const eligible = await makeSyncedVariant({ bankPaymentPriceMinorUnits: 100_000n, bankPaymentDiscountEligible: true });
    const ineligible = await makeSyncedVariant({ bankPaymentPriceMinorUnits: 200_000n, bankPaymentDiscountEligible: false });
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const request = checkoutRequest({
      body: {
        mode: "bank",
        email: `Buyer-${uniq()}@Example.com`,
        shippingAddress: SHIPPING_ADDRESS,
        lines: [
          { shopifyVariantId: eligible.variant.shopifyVariantGid, quantity: 1 },
          { shopifyVariantId: ineligible.variant.shopifyVariantGid, quantity: 1 },
        ],
      },
    });

    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      bankPaymentOrderId: string;
      lines: { shopifyVariantId: string; quotedBankPaymentPriceMinorUnits: string; eligibleAtQuoteTime: boolean }[];
    };

    const eligibleLine = body.lines.find((l) => l.shopifyVariantId === eligible.variant.shopifyVariantGid)!;
    const ineligibleLine = body.lines.find((l) => l.shopifyVariantId === ineligible.variant.shopifyVariantGid)!;
    expect(eligibleLine.eligibleAtQuoteTime).toBe(true);
    expect(ineligibleLine.eligibleAtQuoteTime).toBe(false);

    // The adapter received the ACTUAL charged price per line: bank price for
    // the eligible line, card price (derived, $5-ceilinged) for the ineligible one.
    const sentEligible = port.createCalls[0]!.lineItems.find(
      (li) => li.shopifyVariantGid === eligible.variant.shopifyVariantGid
    )!;
    const sentIneligible = port.createCalls[0]!.lineItems.find(
      (li) => li.shopifyVariantGid === ineligible.variant.shopifyVariantGid
    )!;
    expect(sentEligible.unitPrice.amountMinorUnits).toBe(100_000n); // bank price, unrounded
    expect(sentIneligible.unitPrice.amountMinorUnits).toBe(208_000n); // card price: $2,000 * 1.04 (4.0% tier), already an exact $5 multiple

    // Persisted lines carry BOTH figures regardless of which was actually charged (M6/M7).
    const persistedLines = await prisma.bankPaymentOrderLine.findMany({
      where: { bankPaymentOrderId: body.bankPaymentOrderId },
    });
    const persistedEligible = persistedLines.find((l) => l.masterVariantId === eligible.variant.id)!;
    const persistedIneligible = persistedLines.find((l) => l.masterVariantId === ineligible.variant.id)!;
    expect(persistedEligible.quotedBankPaymentPriceMinorUnits).toBe(100_000n);
    expect(persistedIneligible.quotedRegularCardPriceMinorUnits).toBe(208_000n);
    expect(persistedEligible.eligibleAtQuoteTime).toBe(true);
    expect(persistedIneligible.eligibleAtQuoteTime).toBe(false);
  });

  it("a tampered/extra field in the request body never changes what a line costs", async () => {
    const variant = await makeSyncedVariant({ bankPaymentPriceMinorUnits: 150_000n, bankPaymentDiscountEligible: true });
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const request = checkoutRequest({
      body: {
        mode: "bank",
        email: `Buyer-${uniq()}@Example.com`,
        shippingAddress: SHIPPING_ADDRESS,
        lines: [
          {
            shopifyVariantId: variant.variant.shopifyVariantGid,
            quantity: 1,
            // Not part of the contract — a client attempting to smuggle a
            // price must be silently ignored, never honoured.
            unitPriceMinorUnits: "1",
            quotedBankPaymentPriceMinorUnits: "1",
          },
        ],
      },
    });

    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(200);
    const sent = port.createCalls[0]!.lineItems[0]!;
    expect(sent.unitPrice.amountMinorUnits).toBe(150_000n);
  });
});

describe("criterion 72 — duplicate variants are coalesced before the adapter is called", () => {
  it("sums quantity into ONE line item for a variant requested twice", async () => {
    const variant = await makeSyncedVariant({ bankPaymentPriceMinorUnits: 80_000n });
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const request = checkoutRequest({
      body: {
        mode: "bank",
        email: `Buyer-${uniq()}@Example.com`,
        shippingAddress: SHIPPING_ADDRESS,
        lines: [
          { shopifyVariantId: variant.variant.shopifyVariantGid, quantity: 2 },
          { shopifyVariantId: variant.variant.shopifyVariantGid, quantity: 3 },
        ],
      },
    });

    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(200);
    expect(port.createCalls).toHaveLength(1);
    expect(port.createCalls[0]!.lineItems).toHaveLength(1);
    expect(port.createCalls[0]!.lineItems[0]!.quantity).toBe(5);

    const body = (await response.json()) as { bankPaymentOrderId: string };
    const persistedLines = await prisma.bankPaymentOrderLine.findMany({
      where: { bankPaymentOrderId: body.bankPaymentOrderId },
    });
    expect(persistedLines).toHaveLength(1);
    expect(persistedLines[0]!.quantity).toBe(5);
  });
});

describe("criterion 76 — a Group Buy variant refuses the request server-side", () => {
  it("refuses even a single Group Buy variant, whole request, even when the theme guard would have blocked it client-side", async () => {
    const variant = await makeSyncedVariant({ bankPaymentPriceMinorUnits: 90_000n });
    await makeGroupBuyVariant(variant.variant.id);
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const request = checkoutRequest({
      body: {
        mode: "bank",
        email: `Buyer-${uniq()}@Example.com`,
        shippingAddress: SHIPPING_ADDRESS,
        lines: [{ shopifyVariantId: variant.variant.shopifyVariantGid, quantity: 1 }],
      },
    });

    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string };
    expect(body.error).toBe("group_buy_variant_present");
    expect(port.createCalls).toHaveLength(0);
  });

  it("refuses a MIXED cart of one Buy Now and one Group Buy variant, not just a pure Group Buy one", async () => {
    const buyNow = await makeSyncedVariant({ bankPaymentPriceMinorUnits: 90_000n });
    const groupBuy = await makeSyncedVariant({ bankPaymentPriceMinorUnits: 70_000n });
    await makeGroupBuyVariant(groupBuy.variant.id);
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const request = checkoutRequest({
      body: {
        mode: "bank",
        email: `Buyer-${uniq()}@Example.com`,
        shippingAddress: SHIPPING_ADDRESS,
        lines: [
          { shopifyVariantId: buyNow.variant.shopifyVariantGid, quantity: 1 },
          { shopifyVariantId: groupBuy.variant.shopifyVariantGid, quantity: 1 },
        ],
      },
    });

    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(400);
    expect(port.createCalls).toHaveLength(0);
  });
});

/**
 * THE OTHER HALF OF CRITERION 76, and the half that costs money if it is
 * wrong in the permissive-looking direction.
 *
 * "Refuse any variant a campaign has ever touched" is the tempting reading.
 * It is also a silent sales defect: the pricing engine only leaves OPEN
 * campaigns alone (`OpenCampaignExclusionSource`), so a variant in a draft,
 * closed or cancelled campaign is priced normally, is published to Shopify,
 * and is advertised under "As low as" on the collection page. Refusing it at
 * checkout would let a customer browse, choose, fill in an address and only
 * then be told no.
 *
 * These two tests exist so that narrowing cannot be quietly undone.
 */
describe("criterion 76 — a campaign that is NOT open leaves the variant buyable", () => {
  it("allows a variant whose campaign is still in draft", async () => {
    const variant = await makeSyncedVariant({ bankPaymentPriceMinorUnits: 90_000n });
    await makeGroupBuyVariant(variant.variant.id, "draft");
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const response = await action({
      request: checkoutRequest({
        body: {
          mode: "bank",
          email: `Buyer-${uniq()}@Example.com`,
          shippingAddress: SHIPPING_ADDRESS,
          lines: [{ shopifyVariantId: variant.variant.shopifyVariantGid, quantity: 1 }],
        },
      }),
      params: {},
      context: {},
    } as never);

    expect(response.status).toBe(200);
    expect(port.createCalls).toHaveLength(1);
  });

  it("allows a variant whose campaign has closed — it is an ordinary Buy Now product again", async () => {
    const variant = await makeSyncedVariant({ bankPaymentPriceMinorUnits: 90_000n });
    await makeGroupBuyVariant(variant.variant.id, "closed");
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const response = await action({
      request: checkoutRequest({
        body: {
          mode: "bank",
          email: `Buyer-${uniq()}@Example.com`,
          shippingAddress: SHIPPING_ADDRESS,
          lines: [{ shopifyVariantId: variant.variant.shopifyVariantGid, quantity: 1 }],
        },
      }),
      params: {},
      context: {},
    } as never);

    expect(response.status).toBe(200);
    expect(port.createCalls).toHaveLength(1);
  });
});

/**
 * The tag is the only thread back from an orphaned Shopify draft to the
 * idempotency key an admin has to clear, so it is asserted on what the
 * adapter actually received rather than on the helper in isolation.
 */
describe("an in_doubt key stays resolvable — the draft carries our correlation tag", () => {
  it("tags the draft order with the truncated idempotency key", async () => {
    const variant = await makeSyncedVariant({ bankPaymentPriceMinorUnits: 60_000n });
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const response = await action({
      request: checkoutRequest({
        body: {
          mode: "bank",
          email: `Buyer-${uniq()}@Example.com`,
          shippingAddress: SHIPPING_ADDRESS,
          lines: [{ shopifyVariantId: variant.variant.shopifyVariantGid, quantity: 1 }],
        },
      }),
      params: {},
      context: {},
    } as never);

    expect(response.status).toBe(200);
    const tags = port.createCalls[0]?.tags ?? [];
    expect(tags).toHaveLength(1);
    expect(tags[0]).toMatch(/^carat-idem-[0-9a-f]{24}$/);
  });
});

describe("criteria 75/105/106 — idempotent replay", () => {
  it("a repeated identical submission returns the SAME draft order and sends no second invoice", async () => {
    const variant = await makeSyncedVariant({ bankPaymentPriceMinorUnits: 60_000n });
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const email = `Buyer-${uniq()}@Example.com`;
    const body = {
      mode: "bank",
      email,
      shippingAddress: SHIPPING_ADDRESS,
      lines: [{ shopifyVariantId: variant.variant.shopifyVariantGid, quantity: 1 }],
    };

    const first = await action({
      request: checkoutRequest({ body }),
      params: {},
      context: {},
    } as never);
    const second = await action({
      request: checkoutRequest({ body }),
      params: {},
      context: {},
    } as never);

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const firstBody = await first.json();
    const secondBody = await second.json();
    expect(secondBody).toEqual(firstBody);

    expect(port.createCalls).toHaveLength(1);
    expect(port.invoiceCalls).toHaveLength(1);

    const orders = await prisma.bankPaymentOrder.count({
      where: { customerEmail: email.toLowerCase() },
    });
    expect(orders).toBe(1);
  });
});

describe("criteria 97-99 — the shipping address is sent to Shopify and never persisted", () => {
  it("createDraftOrder receives the address exactly, but neither the response body nor the persisted row carries it", async () => {
    const variant = await makeSyncedVariant({ bankPaymentPriceMinorUnits: 55_000n });
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const request = checkoutRequest({
      body: {
        mode: "bank",
        email: `Buyer-${uniq()}@Example.com`,
        shippingAddress: SHIPPING_ADDRESS,
        lines: [{ shopifyVariantId: variant.variant.shopifyVariantGid, quantity: 1 }],
      },
    });

    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(200);
    const body = (await response.json()) as { bankPaymentOrderId: string };

    // Sent to Shopify, exactly as submitted —
    expect(port.createCalls[0]!.shippingAddress).toEqual(SHIPPING_ADDRESS);

    // — but the response body carries no address field at all.
    const responseJson = JSON.stringify(body).toLowerCase();
    expect(responseJson).not.toContain("address1");
    expect(responseJson).not.toContain("firstname");
    expect(responseJson).not.toContain("lovelace");

    // The persisted row's own keys are exactly the schema's columns — no
    // address field EXISTS to select, which is the actual guarantee (a
    // Prisma model literally cannot return a column it does not define).
    // customerEmail is the one stored exception (criterion 98).
    const stored = await prisma.bankPaymentOrder.findUniqueOrThrow({
      where: { id: body.bankPaymentOrderId },
    });
    expect(Object.keys(stored).map((k) => k.toLowerCase())).not.toContain("address");
    expect(JSON.stringify(stored).toLowerCase()).not.toContain("lovelace");
    expect(stored.customerEmail).toMatch(/@example\.com$/);
  });
});

describe("unpurchasable and malformed requests", () => {
  it("refuses an unknown Shopify variant id", async () => {
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const request = checkoutRequest({
      body: {
        mode: "bank",
        email: `Buyer-${uniq()}@Example.com`,
        shippingAddress: SHIPPING_ADDRESS,
        lines: [{ shopifyVariantId: `gid://shopify/ProductVariant/does-not-exist-${uniq()}`, quantity: 1 }],
      },
    });

    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; lines: { reason: string }[] };
    expect(body.error).toBe("unpurchasable_lines");
    expect(body.lines[0]!.reason).toBe("unknown_variant");
    expect(port.createCalls).toHaveLength(0);
  });

  it("refuses a variant with no synced calculation", async () => {
    const unsynced = await makeUnsyncedVariant();
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const request = checkoutRequest({
      body: {
        mode: "bank",
        email: `Buyer-${uniq()}@Example.com`,
        shippingAddress: SHIPPING_ADDRESS,
        lines: [{ shopifyVariantId: unsynced.variant.shopifyVariantGid, quantity: 1 }],
      },
    });

    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(400);
    const body = (await response.json()) as { error: string; lines: { reason: string }[] };
    expect(body.error).toBe("unpurchasable_lines");
    expect(body.lines[0]!.reason).toBe("unsynced");
    expect(port.createCalls).toHaveLength(0);
  });

  it("rejects mode \"card\" — this endpoint creates Bank Payment orders only", async () => {
    const variant = await makeSyncedVariant({ bankPaymentPriceMinorUnits: 40_000n });
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const request = checkoutRequest({
      body: {
        mode: "card",
        email: `Buyer-${uniq()}@Example.com`,
        shippingAddress: SHIPPING_ADDRESS,
        lines: [{ shopifyVariantId: variant.variant.shopifyVariantGid, quantity: 1 }],
      },
    });

    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(400);
    expect(port.createCalls).toHaveLength(0);
  });

  it("rejects an empty lines array", async () => {
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const request = checkoutRequest({
      body: {
        mode: "bank",
        email: `Buyer-${uniq()}@Example.com`,
        shippingAddress: SHIPPING_ADDRESS,
        lines: [],
      },
    });

    const response = await action({ request, params: {}, context: {} } as never);
    expect(response.status).toBe(400);
  });
});

describe("criterion 77 — quote and guarantee timestamps", () => {
  it("stores guaranteeExpiresAt exactly 24 hours after quotedAt", async () => {
    const variant = await makeSyncedVariant({ bankPaymentPriceMinorUnits: 45_000n });
    const port = fakeDraftOrderPort();
    __setDraftOrderPortForTests(port);

    const request = checkoutRequest({
      body: {
        mode: "bank",
        email: `Buyer-${uniq()}@Example.com`,
        shippingAddress: SHIPPING_ADDRESS,
        lines: [{ shopifyVariantId: variant.variant.shopifyVariantGid, quantity: 1 }],
      },
    });

    const response = await action({ request, params: {}, context: {} } as never);
    const body = (await response.json()) as { quotedAt: string; guaranteeExpiresAt: string };

    const quotedAt = new Date(body.quotedAt).getTime();
    const guaranteeExpiresAt = new Date(body.guaranteeExpiresAt).getTime();
    expect(guaranteeExpiresAt - quotedAt).toBe(24 * 60 * 60 * 1000);
  });
});
