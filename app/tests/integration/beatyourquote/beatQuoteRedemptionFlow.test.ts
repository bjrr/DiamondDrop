import { createHmac, randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { getPublishedVariantPrice } from "~/db/repositories/publishedPriceRepository.server";
import { fallbackExpiresAt } from "~/domain/beatyourquote/fallbackBenefit";
import { action as redeemAction } from "~/routes/apps.carat.beat-quote-redeem";
import type { AdminGraphqlClient } from "~/shopify/admin/productClient.server";
import type {
  CreateRedemptionDraftOrderInput,
  CreatedDraftOrder,
  DraftOrderPort,
} from "~/shopify/admin/draftOrderAdapter.server";
import {
  BEAT_QUOTE_REDEMPTION_ORDER_TAG_PREFIX,
  handleBeatQuoteRedemptionOrderPaidWebhook,
} from "~/shopify/webhooks/beatQuoteRedemptionOrderHandler.server";
import type { ReceivedWebhookEvent } from "~/shopify/webhooks/receive.server";

/**
 * The redemption flow end to end: App Proxy request -> reservation -> draft
 * order -> paid order -> benefit spent exactly once.
 *
 * ============================================================================
 * WHAT THESE TESTS ARE FOR, GIVEN THE UNIT TESTS ALREADY EXIST
 * ============================================================================
 * `beatQuoteRedemption.test.ts` proves the reservation state machine against
 * real Postgres. `draftOrderRedemption.test.ts` proves the adapter's echo
 * check. Neither proves the part that has actually broken in this codebase
 * before: the WIRING. A route that trusts a posted price, a webhook that reads
 * a tag as authorisation, a handler whose payload schema silently fails to
 * parse — all three have happened here, and all three are invisible to a unit
 * test of either end.
 *
 * So these tests drive the real route function with a real signed App Proxy
 * request against a real database, and the real webhook handler against a real
 * Shopify-shaped payload.
 */

const SHOP = "caratforus-dev.myshopify.com";
const CUSTOMER_ID = "4242";
const CUSTOMER_GID = `gid://shopify/Customer/${CUSTOMER_ID}`;
const OTHER_CUSTOMER_ID = "9999";

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;

function signedPost(query: Record<string, string>, body: unknown): Request {
  const secret = process.env.SHOPIFY_API_SECRET as string;
  const message = Object.entries(query)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("");
  const signature = createHmac("sha256", secret).update(message, "utf8").digest("hex");
  const url = new URL("https://shop.example.com/apps/carat/beat-quote-redeem");
  for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
  url.searchParams.set("signature", signature);
  return new Request(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function call(request: Request) {
  return redeemAction({ request, params: {}, context: {} } as never);
}

/**
 * The seeded active Buy Now profile, never a bespoke one.
 *
 * `bankCheckoutRoute.test.ts` explains why at length and the reasoning holds
 * here: creating a profile per test is how carat_dev accumulated 110 junk
 * profiles, and the seeded one carries the real tiered card rule that the
 * price assertions below depend on.
 */
function activeProfile() {
  return prisma.pricingProfile.findFirstOrThrow({
    where: { code: "buy_now", isPlaceholder: false },
    orderBy: { version: "desc" },
  });
}

/**
 * A purchasable variant whose published CARD price is the figure asked for.
 *
 * ============================================================================
 * THE CARD PRICE IS DERIVED, SO THE FIXTURE SETS THE BANK PRICE
 * ============================================================================
 * `getPublishedVariantPrice` computes the Regular/Card Price from the Bank
 * Payment Price using the profile's own uplift rule — Bank Payment Price is the
 * authoritative underlying figure (CLAUDE.md rule 11) and nothing may write a
 * card price directly. So this helper writes a bank price and then READS BACK
 * what the real derivation produced, returning that as the card price the
 * assertions use.
 *
 * Inverting the uplift arithmetically here would mean reimplementing the
 * tiered rule in a test fixture, which is how a fixture ends up asserting its
 * own version of the pricing engine.
 */
async function seedVariant(options: {
  bankPaymentPriceMinorUnits: bigint;
  isLuxurySteal?: boolean;
  inOpenCampaign?: boolean;
}): Promise<{
  masterVariantId: string;
  shopifyVariantGid: string;
  numericVariantId: string;
  cardPriceMinorUnits: bigint;
}> {
  const suffix = uniq();
  const numericVariantId = `${900_000_000 + ++seq}`;
  const shopifyVariantGid = `gid://shopify/ProductVariant/${numericVariantId}`;
  const profile = await activeProfile();

  const product = await prisma.masterProduct.create({
    data: {
      name: `bq-redemption fixture ${suffix}`,
      category: "ring",
      sizeAxis: "none",
      allowedSizeMin: "0",
      allowedSizeMax: "0",
      sizeIncrement: "1",
      baseSize: "0",
      offeredMetals: ["gold"],
      status: "active",
      shopifyProductGid: `gid://shopify/Product/${numericVariantId}`,
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
      shopifyVariantGid,
      bankPaymentDiscountEligible: true,
      isLuxurySteal: options.isLuxurySteal ?? false,
    },
  });

  const snapshot = await prisma.snapshot.create({
    data: { kind: "pricing.it", payload: {}, contentHash: `bq-redemption-${randomUUID()}` },
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
      landedCostMinorUnits: options.bankPaymentPriceMinorUnits / 2n,
      bankPaymentPriceMinorUnits: options.bankPaymentPriceMinorUnits,
      currency: "USD",
      status: "computed",
    },
  });
  await prisma.masterVariant.update({
    where: { id: variant.id },
    data: { lastSyncedPriceCalculationId: calc.id },
  });

  if (options.inOpenCampaign) {
    // DRAFT FIRST, THEN THE VARIANT, THEN OPEN — the real sequence, because
    // the database enforces it both ways and taught this fixture twice:
    //
    //   `group_buy_campaign_open_is_frozen` refuses a non-draft campaign with
    //   no pricing profile, profile version, snapshot or frozen as-of. An open
    //   campaign whose pricing was never frozen is precisely the bug it exists
    //   to prevent.
    //
    //   A trigger then refuses INSERTing an eligible variant into an ALREADY
    //   open campaign: "its tiers and eligible-variant prices are frozen".
    //
    // Shortcutting either would have meant a fixture asserting a campaign
    // state the application cannot produce.
    const campaign = await prisma.groupBuyCampaign.create({
      data: {
        code: `GB-BQ-${suffix}`,
        name: "Open campaign fixture",
        status: "draft",
        currency: "USD",
        createdBy: "integration-test",
      },
    });
    await prisma.groupBuyCampaignVariant.create({
      data: {
        campaignId: campaign.id,
        masterVariantId: variant.id,
        frozenBaseBankPaymentPriceMinorUnits: options.bankPaymentPriceMinorUnits,
        frozenLandedCostMinorUnits: options.bankPaymentPriceMinorUnits / 2n,
      },
    });
    await prisma.groupBuyCampaign.update({
      where: { id: campaign.id },
      data: {
        status: "open",
        openedAt: new Date(),
        pricingProfileId: profile.id,
        profileVersion: profile.version,
        snapshotId: snapshot.id,
        frozenAsOf: new Date(),
      },
    });
  }

  // Read back what the real derivation produced — see the header.
  const published = await getPublishedVariantPrice(variant.id);
  if (published.kind !== "purchasable") {
    throw new Error(`fixture variant ${variant.id} is not purchasable: ${published.reason}`);
  }

  return {
    masterVariantId: variant.id,
    shopifyVariantGid,
    numericVariantId,
    cardPriceMinorUnits: published.price.regularCardPriceMinorUnits,
  };
}

/** 10% of an eligible subtotal, capped at $100 — the figure to assert against. */
function expectedDiscount(subtotalMinorUnits: bigint): bigint {
  const tenth = subtotalMinorUnits / 10n;
  return tenth > 10_000n ? 10_000n : tenth;
}

/** A verified submission CaratForUs could not beat, plus the benefit it earned. */
async function seedBenefit(
  overrides: { customerRef?: string; expiresAt?: Date; revokedAt?: Date } = {}
): Promise<{ id: string; benefitCode: string }> {
  const issuedAt = new Date("2026-10-10T12:00:00.000Z");
  const submission = await prisma.beatQuoteSubmission.create({
    data: {
      submissionReference: `BQ-${uniq()}`,
      customerRef: overrides.customerRef ?? CUSTOMER_GID,
      firstName: "Ada",
      lastName: "Lovelace",
      email: `ada-${uniq()}@example.com`,
      kind: "custom_quote",
      quoteIssuedOn: new Date("2026-10-05T00:00:00.000Z"),
      submittedOn: new Date("2026-10-09T00:00:00.000Z"),
      submittedAt: new Date("2026-10-09T15:00:00.000Z"),
      calendarZone: "America/New_York",
      quoteAgeCalendarDays: 4,
      treatment: "guarantee",
      verification: "verified",
      verifiedAt: issuedAt,
      verifiedByActorRef: "staff:reviewer",
      status: "declined_cannot_beat",
      decisionReason: "below floor",
    },
  });
  const benefit = await prisma.beatQuoteFallbackBenefit.create({
    data: {
      submissionId: submission.id,
      benefitCode: `BQ10-${uniq()}`,
      customerRef: overrides.customerRef ?? CUSTOMER_GID,
      percent: 10,
      maxDiscountMinorUnits: 10_000n,
      currency: "USD",
      issuedAt,
      expiresAt: overrides.expiresAt ?? fallbackExpiresAt(issuedAt),
      issuedByActorType: "staff",
      issuedByActorRef: "staff:reviewer",
      ...(overrides.revokedAt ? { revokedAt: overrides.revokedAt, revokedReason: "fabricated quote" } : {}),
    },
  });
  return { id: benefit.id, benefitCode: benefit.benefitCode };
}

/**
 * A draft-order port that records what it was asked to create.
 *
 * It ECHOES BACK WHAT IT WAS GIVEN, which is exactly why the adapter's own echo
 * check cannot be tested here and is tested against a fake client in
 * `draftOrderRedemption.test.ts` instead. What this fake IS good for is proving
 * the route computed the right discount and lines before calling it.
 */
function recordingPort(options: { fail?: boolean } = {}): DraftOrderPort & {
  calls: CreateRedemptionDraftOrderInput[];
} {
  const calls: CreateRedemptionDraftOrderInput[] = [];
  return {
    calls,
    async createRedemptionDraftOrder(input: CreateRedemptionDraftOrderInput): Promise<CreatedDraftOrder> {
      calls.push(input);
      if (options.fail) throw new Error("Shopify said no");
      return {
        draftOrderGid: `gid://shopify/DraftOrder/${uniq()}`,
        invoiceUrl: "https://caratforus-dev.myshopify.com/invoice/redeem",
      };
    },
    async createServiceDraftOrder(): Promise<never> {
      throw new Error("not expected");
    },
    async createDraftOrder(): Promise<never> {
      throw new Error("not expected");
    },
    async sendInvoice(): Promise<never> {
      throw new Error("not expected");
    },
    async completeDraftOrder(): Promise<never> {
      throw new Error("not expected");
    },
    async cancelDraftOrder(): Promise<never> {
      throw new Error("not expected");
    },
  };
}

/**
 * The route builds its own port from a real Shopify session, which no
 * integration test has. `__setDraftOrderPortForTests` is the seam.
 */
async function withPort<T>(
  port: DraftOrderPort,
  run: () => Promise<T>
): Promise<T> {
  const mod = await import("~/routes/apps.carat.beat-quote-redeem");
  mod.__setDraftOrderPortForTests(port);
  try {
    return await run();
  } finally {
    mod.__setDraftOrderPortForTests(null);
  }
}

function redeemBody(
  benefitCode: string,
  lines: { shopifyVariantId: string; quantity: number }[]
): Record<string, unknown> {
  return {
    benefitCode,
    email: "ada@example.com",
    shippingAddress: {
      firstName: "Ada",
      lastName: "Lovelace",
      address1: "1 Analytical Engine Way",
      city: "London",
      zip: "SW1A 1AA",
      countryCode: "GB",
    },
    lines,
  };
}

const proxyQuery = (customerId: string = CUSTOMER_ID) => ({
  shop: SHOP,
  logged_in_customer_id: customerId,
  path_prefix: "/apps/carat",
  timestamp: "1760000000",
});

describe("the request supplies what to buy, and nothing else", () => {
  it("computes the discount from the PUBLISHED price, not from anything posted", async () => {
    const benefit = await seedBenefit();
    const variant = await seedVariant({ bankPaymentPriceMinorUnits: 50_000n }); // $500.00
    const port = recordingPort();

    const response = await withPort(port, () =>
      call(
        signedPost(
          proxyQuery(),
          redeemBody(benefit.benefitCode, [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 1 }])
        )
      )
    );

    expect(response.status).toBe(201);
    const json = (await response.json()) as Record<string, string>;
    // 10% of the PUBLISHED card price, which the fixture read back from the
    // real derivation rather than asserting its own.
    expect(json.eligibleSubtotalMinorUnits).toBe(variant.cardPriceMinorUnits.toString());
    expect(json.discountMinorUnits).toBe(expectedDiscount(variant.cardPriceMinorUnits).toString());
    // Money as strings, never as JSON numbers.
    expect(typeof json.discountMinorUnits).toBe("string");
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]!.discount.amountMinorUnits).toBe(expectedDiscount(variant.cardPriceMinorUnits));
    // The line reached Shopify at the published price, not a posted one.
    expect(port.calls[0]!.lineItems[0]!.unitPrice.amountMinorUnits).toBe(variant.cardPriceMinorUnits);
  });

  it("REJECTS a body that tries to name its own discount", async () => {
    // `.strict()` — the field is refused outright rather than accepted and
    // ignored, because an accepted-and-ignored field is one somebody later
    // wires up.
    const benefit = await seedBenefit();
    const variant = await seedVariant({ bankPaymentPriceMinorUnits: 50_000n });
    const port = recordingPort();

    const body = redeemBody(benefit.benefitCode, [
      { shopifyVariantId: variant.shopifyVariantGid, quantity: 1 },
    ]);
    const response = await withPort(port, () =>
      call(signedPost(proxyQuery(), { ...body, discountMinorUnits: "10000" }))
    );

    expect(response.status).toBe(400);
    expect(port.calls).toHaveLength(0);
    // Nothing reserved, so the benefit is untouched.
    expect(await prisma.beatQuoteRedemptionIntent.count({ where: { benefitId: benefit.id } })).toBe(0);
  });

  it.each([
    ["unitPrice", { unitPrice: "1" }],
    ["eligibleSubtotalMinorUnits", { eligibleSubtotalMinorUnits: "9999999" }],
    ["surface", { surface: "group_buy" }],
    ["customerRef", { customerRef: `gid://shopify/Customer/${OTHER_CUSTOMER_ID}` }],
    ["stackingExpresslyAuthorized", { stackingExpresslyAuthorized: true }],
    ["ineligibleBecause", { ineligibleBecause: null }],
  ])("REJECTS a body carrying %s", async (_label, extra) => {
    const benefit = await seedBenefit();
    const variant = await seedVariant({ bankPaymentPriceMinorUnits: 50_000n });
    const port = recordingPort();
    const response = await withPort(port, () =>
      call(
        signedPost(proxyQuery(), {
          ...redeemBody(benefit.benefitCode, [
            { shopifyVariantId: variant.shopifyVariantGid, quantity: 1 },
          ]),
          ...extra,
        })
      )
    );
    expect(response.status).toBe(400);
    expect(port.calls).toHaveLength(0);
  });

  it("requires a signed-in customer — a non-transferable benefit needs an identity", async () => {
    const benefit = await seedBenefit();
    const variant = await seedVariant({ bankPaymentPriceMinorUnits: 50_000n });
    const port = recordingPort();

    const response = await withPort(port, () =>
      call(
        signedPost(
          { shop: SHOP, path_prefix: "/apps/carat", timestamp: "1760000000" },
          redeemBody(benefit.benefitCode, [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 1 }])
        )
      )
    );

    expect(response.status).toBe(401);
    expect(((await response.json()) as { error: string }).error).toBe("authentication_required");
    expect(port.calls).toHaveLength(0);
  });

  it("rejects an unsigned request", async () => {
    const benefit = await seedBenefit();
    const variant = await seedVariant({ bankPaymentPriceMinorUnits: 50_000n });
    const url = new URL("https://shop.example.com/apps/carat/beat-quote-redeem?shop=x&signature=bogus");
    const port = recordingPort();
    const response = await withPort(port, () =>
      call(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(
            redeemBody(benefit.benefitCode, [
              { shopifyVariantId: variant.shopifyVariantGid, quantity: 1 },
            ])
          ),
        })
      )
    );
    expect(response.status).toBe(401);
    expect(port.calls).toHaveLength(0);
  });
});

describe("eligibility is classified server-side from our own data", () => {
  it("EXCLUDES a Luxury Steal line from the discount basis", async () => {
    const benefit = await seedBenefit();
    const eligible = await seedVariant({ bankPaymentPriceMinorUnits: 20_000n }); // $200
    const steal = await seedVariant({ bankPaymentPriceMinorUnits: 400_000n, isLuxurySteal: true }); // $4,000
    const port = recordingPort();

    const response = await withPort(port, () =>
      call(
        signedPost(
          proxyQuery(),
          redeemBody(benefit.benefitCode, [
            { shopifyVariantId: eligible.shopifyVariantGid, quantity: 1 },
            { shopifyVariantId: steal.shopifyVariantGid, quantity: 1 },
          ])
        )
      )
    );

    expect(response.status).toBe(201);
    const json = (await response.json()) as { discountMinorUnits: string; excludedLines: { reason: string }[] };
    // Without the exclusion the $4,000 line would have capped this at $100;
    // with it, the discount is 10% of the eligible line alone.
    expect(json.discountMinorUnits).toBe(expectedDiscount(eligible.cardPriceMinorUnits).toString());
    expect(BigInt(json.discountMinorUnits)).toBeLessThan(10_000n);
    expect(json.excludedLines).toEqual([
      { shopifyVariantId: steal.shopifyVariantGid, reason: "luxury_steal" },
    ]);
  });

  it("EXCLUDES a line in an OPEN Group Buy campaign", async () => {
    const benefit = await seedBenefit();
    const eligible = await seedVariant({ bankPaymentPriceMinorUnits: 30_000n });
    const groupBuy = await seedVariant({ bankPaymentPriceMinorUnits: 900_000n, inOpenCampaign: true });
    const port = recordingPort();

    const response = await withPort(port, () =>
      call(
        signedPost(
          proxyQuery(),
          redeemBody(benefit.benefitCode, [
            { shopifyVariantId: eligible.shopifyVariantGid, quantity: 1 },
            { shopifyVariantId: groupBuy.shopifyVariantGid, quantity: 1 },
          ])
        )
      )
    );

    expect(response.status).toBe(201);
    const json = (await response.json()) as { discountMinorUnits: string; excludedLines: { reason: string }[] };
    expect(json.discountMinorUnits).toBe(expectedDiscount(eligible.cardPriceMinorUnits).toString());
    expect(BigInt(json.discountMinorUnits)).toBeLessThan(10_000n);
    expect(json.excludedLines[0]!.reason).toBe("group_buy");
  });

  it("REFUSES a cart of nothing but excluded lines rather than reserving zero", async () => {
    const benefit = await seedBenefit();
    const steal = await seedVariant({ bankPaymentPriceMinorUnits: 400_000n, isLuxurySteal: true });
    const port = recordingPort();

    const response = await withPort(port, () =>
      call(
        signedPost(
          proxyQuery(),
          redeemBody(benefit.benefitCode, [{ shopifyVariantId: steal.shopifyVariantGid, quantity: 1 }])
        )
      )
    );

    expect(response.status).toBe(409);
    const json = (await response.json()) as { reason: string; message: string };
    expect(json.reason).toBe("calculation_refused");
    expect(json.message).toMatch(/Luxury Steals/);
    // The benefit is NOT spent.
    expect(await prisma.beatQuoteRedemptionIntent.count({ where: { benefitId: benefit.id } })).toBe(0);
  });

  it("REFUSES an unknown variant rather than silently dropping the line", async () => {
    // Dropping it would shrink the eligible subtotal, and the discount with it:
    // the customer would be charged for a benefit they did not receive.
    const benefit = await seedBenefit();
    const eligible = await seedVariant({ bankPaymentPriceMinorUnits: 50_000n });
    const port = recordingPort();

    const response = await withPort(port, () =>
      call(
        signedPost(
          proxyQuery(),
          redeemBody(benefit.benefitCode, [
            { shopifyVariantId: eligible.shopifyVariantGid, quantity: 1 },
            { shopifyVariantId: "gid://shopify/ProductVariant/404404404", quantity: 1 },
          ])
        )
      )
    );

    expect(response.status).toBe(400);
    const json = (await response.json()) as { error: string; lines: { reason: string }[] };
    expect(json.error).toBe("unpurchasable_lines");
    expect(json.lines[0]!.reason).toBe("unknown_variant");
    expect(port.calls).toHaveLength(0);
  });
});

describe("the benefit belongs to the authenticated customer", () => {
  it("REFUSES a code belonging to someone else, with the same wording as an unknown code", async () => {
    // Saying "that belongs to another account" would confirm the code is real,
    // making this endpoint an oracle for guessing one.
    const benefit = await seedBenefit({ customerRef: `gid://shopify/Customer/${OTHER_CUSTOMER_ID}` });
    const variant = await seedVariant({ bankPaymentPriceMinorUnits: 50_000n });
    const port = recordingPort();

    const stolen = await withPort(port, () =>
      call(
        signedPost(
          proxyQuery(CUSTOMER_ID),
          redeemBody(benefit.benefitCode, [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 1 }])
        )
      )
    );
    const unknown = await withPort(port, () =>
      call(
        signedPost(
          proxyQuery(CUSTOMER_ID),
          redeemBody(`BQ10-NOSUCH-${uniq()}`, [
            { shopifyVariantId: variant.shopifyVariantGid, quantity: 1 },
          ])
        )
      )
    );

    expect(stolen.status).toBe(400);
    expect(unknown.status).toBe(400);
    const a = (await stolen.json()) as { message: string };
    const b = (await unknown.json()) as { message: string };
    expect(a.message).toBe(b.message);
    expect(port.calls).toHaveLength(0);
  });

  it("REFUSES an expired benefit", async () => {
    const benefit = await seedBenefit({ expiresAt: new Date("2026-10-11T00:00:00.000Z") });
    const variant = await seedVariant({ bankPaymentPriceMinorUnits: 50_000n });
    const port = recordingPort();
    const response = await withPort(port, () =>
      call(
        signedPost(
          proxyQuery(),
          redeemBody(benefit.benefitCode, [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 1 }])
        )
      )
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { reason: string }).reason).toBe("expired");
  });

  it("REFUSES a revoked benefit", async () => {
    const benefit = await seedBenefit({ revokedAt: new Date("2026-10-11T00:00:00.000Z") });
    const variant = await seedVariant({ bankPaymentPriceMinorUnits: 50_000n });
    const port = recordingPort();
    const response = await withPort(port, () =>
      call(
        signedPost(
          proxyQuery(),
          redeemBody(benefit.benefitCode, [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 1 }])
        )
      )
    );
    expect(response.status).toBe(400);
    expect(((await response.json()) as { reason: string }).reason).toBe("revoked");
  });
});

describe("concurrency and failure", () => {
  it("TWO CONCURRENT requests produce ONE usable checkout", async () => {
    const benefit = await seedBenefit();
    const variant = await seedVariant({ bankPaymentPriceMinorUnits: 50_000n });
    const port = recordingPort();

    const body = redeemBody(benefit.benefitCode, [
      { shopifyVariantId: variant.shopifyVariantGid, quantity: 1 },
    ]);
    const [a, b] = await withPort(port, () =>
      Promise.all([call(signedPost(proxyQuery(), body)), call(signedPost(proxyQuery(), body))])
    );

    expect([a.status, b.status].sort()).toEqual([201, 409]);
    // Only ONE draft order was created — the loser never reached Shopify.
    expect(port.calls).toHaveLength(1);
    expect(
      await prisma.beatQuoteRedemptionIntent.count({ where: { benefitId: benefit.id, status: "reserved" } })
    ).toBe(1);
  });

  it("RELEASES the reservation when the draft order fails, so the customer can retry", async () => {
    // A transient Shopify failure must not lock the benefit until a human
    // notices: the customer got no checkout, so they must be able to try again.
    const benefit = await seedBenefit();
    const variant = await seedVariant({ bankPaymentPriceMinorUnits: 50_000n });
    const failing = recordingPort({ fail: true });

    const response = await withPort(failing, () =>
      call(
        signedPost(
          proxyQuery(),
          redeemBody(benefit.benefitCode, [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 1 }])
        )
      )
    );

    expect(response.status).toBe(502);
    const json = (await response.json()) as { message: string };
    expect(json.message).toMatch(/has not been used/);

    const intents = await prisma.beatQuoteRedemptionIntent.findMany({ where: { benefitId: benefit.id } });
    expect(intents).toHaveLength(1);
    expect(intents[0]!.status).toBe("released");
    expect(intents[0]!.releaseReason).toContain("checkout_failed");

    // And the benefit is usable again, immediately.
    const retryPort = recordingPort();
    const retry = await withPort(retryPort, () =>
      call(
        signedPost(
          proxyQuery(),
          redeemBody(benefit.benefitCode, [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 1 }])
        )
      )
    );
    expect(retry.status).toBe(201);
  });

  it("the benefit is NOT marked redeemed merely because a draft order exists", async () => {
    // The owner's instruction, asserted directly.
    const benefit = await seedBenefit();
    const variant = await seedVariant({ bankPaymentPriceMinorUnits: 50_000n });
    const port = recordingPort();

    const response = await withPort(port, () =>
      call(
        signedPost(
          proxyQuery(),
          redeemBody(benefit.benefitCode, [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 1 }])
        )
      )
    );
    expect(response.status).toBe(201);

    const after = await prisma.beatQuoteFallbackBenefit.findUniqueOrThrow({ where: { id: benefit.id } });
    expect(after.redeemedAt).toBeNull();
    expect(after.redemptionOrderRef).toBeNull();
  });
});

// ============================================================================
// ORDER TIME
// ============================================================================

function fakeAdmin(
  resultingOrderGidByDraft: Map<string, string | null>,
  options: { fail?: boolean } = {}
): () => Promise<AdminGraphqlClient> {
  const client: AdminGraphqlClient = {
    async graphql(_query: string, opts?: { variables?: Record<string, unknown> }) {
      const id = String(opts?.variables?.id ?? "");
      if (options.fail) {
        // Shopify reports failures on HTTP 200 with a top-level `errors`.
        return { json: async () => ({ errors: [{ message: "Throttled" }] }) } as Response;
      }
      const order = resultingOrderGidByDraft.get(id) ?? null;
      return {
        json: async () => ({ data: { draftOrder: { id, order: order ? { id: order } : null } } }),
      } as Response;
    },
  };
  return async () => client;
}

function orderPaidEvent(payload: Record<string, unknown>): ReceivedWebhookEvent {
  const rawBody = JSON.stringify(payload);
  return {
    shopifyEventId: randomUUID(),
    topic: "orders/paid",
    shopDomain: SHOP,
    rawBody,
    payload: JSON.parse(rawBody) as unknown,
  };
}

/** A reserved redemption with a draft order attached, ready to be paid. */
async function reservedRedemption(options: { bankPaymentPriceMinorUnits?: bigint } = {}) {
  const benefit = await seedBenefit();
  const variant = await seedVariant({ bankPaymentPriceMinorUnits: options.bankPaymentPriceMinorUnits ?? 50_000n });
  const port = recordingPort();
  const response = await withPort(port, () =>
    call(
      signedPost(
        proxyQuery(),
        redeemBody(benefit.benefitCode, [{ shopifyVariantId: variant.shopifyVariantGid, quantity: 1 }])
      )
    )
  );
  expect(response.status).toBe(201);
  const json = (await response.json()) as { redemptionId: string; discountMinorUnits: string };
  const intent = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({
    where: { id: json.redemptionId },
  });
  return { benefit, variant, intent, discountMinorUnits: json.discountMinorUnits };
}

/** Integer minor units to the decimal string Shopify sends. No float. */
function decimalOf(minorUnits: bigint): string {
  return `${minorUnits / 100n}.${(minorUnits % 100n).toString().padStart(2, "0")}`;
}

function paidOrderPayload(options: {
  orderGid: string;
  intentId: string;
  numericVariantId: string;
  /** What the order ACTUALLY carries. Defaults to the reserved figure. */
  reservedDiscountMinorUnits?: bigint;
  discounts?: string;
  customerGid?: string | null;
  currency?: string;
  discountCodes?: { code: string }[];
  tags?: string;
  /** When the money moved. Defaults to now; `null` omits it entirely. */
  processedAt?: string | null;
}): Record<string, unknown> {
  return {
    admin_graphql_api_id: options.orderGid,
    // The benefit's expiry is judged against THIS, not against delivery time.
    ...(options.processedAt === null
      ? {}
      : { processed_at: options.processedAt ?? new Date().toISOString() }),
    tags: options.tags ?? `${BEAT_QUOTE_REDEMPTION_ORDER_TAG_PREFIX}${options.intentId}`,
    currency: options.currency ?? "USD",
    current_total_discounts: options.discounts ?? decimalOf(options.reservedDiscountMinorUnits ?? 0n),
    total_discounts: options.discounts ?? decimalOf(options.reservedDiscountMinorUnits ?? 0n),
    discount_codes: options.discountCodes ?? [],
    customer:
      options.customerGid === null
        ? null
        : { admin_graphql_api_id: options.customerGid ?? CUSTOMER_GID },
    line_items: [{ variant_id: options.numericVariantId }],
  };
}

describe("order-time verification", () => {
  it("COMPLETES when everything agrees, spending the benefit exactly once", async () => {
    const { benefit, variant, intent } = await reservedRedemption();
    const orderGid = `gid://shopify/Order/${uniq()}`;

    await handleBeatQuoteRedemptionOrderPaidWebhook(
      orderPaidEvent(
        paidOrderPayload({
          orderGid,
          intentId: intent.id,
          numericVariantId: variant.numericVariantId,
          reservedDiscountMinorUnits: intent.discountMinorUnits,
        })
      ),
      { adminGraphql: fakeAdmin(new Map([[intent.draftOrderGid!, orderGid]])) }
    );

    const after = await prisma.beatQuoteFallbackBenefit.findUniqueOrThrow({ where: { id: benefit.id } });
    expect(after.redeemedAt).not.toBeNull();
    expect(after.redemptionOrderRef).toBe(orderGid);
    expect(after.redemptionDiscountMinorUnits).toBe(intent.discountMinorUnits);
    const completed = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(completed.status).toBe("completed");
  });

  it("DUPLICATE delivery does not redeem twice", async () => {
    const { benefit, variant, intent } = await reservedRedemption();
    const orderGid = `gid://shopify/Order/${uniq()}`;
    const event = orderPaidEvent(
      paidOrderPayload({
          orderGid,
          intentId: intent.id,
          numericVariantId: variant.numericVariantId,
          reservedDiscountMinorUnits: intent.discountMinorUnits,
        })
    );
    const deps = { adminGraphql: fakeAdmin(new Map([[intent.draftOrderGid!, orderGid]])) };

    await handleBeatQuoteRedemptionOrderPaidWebhook(event, deps);
    const firstRedeemedAt = (
      await prisma.beatQuoteFallbackBenefit.findUniqueOrThrow({ where: { id: benefit.id } })
    ).redeemedAt;

    // Twice more, as Shopify would on a retry.
    await handleBeatQuoteRedemptionOrderPaidWebhook(event, deps);
    await handleBeatQuoteRedemptionOrderPaidWebhook(event, deps);

    const after = await prisma.beatQuoteFallbackBenefit.findUniqueOrThrow({ where: { id: benefit.id } });
    // The timestamp did not move: the second delivery wrote nothing at all.
    expect(after.redeemedAt?.toISOString()).toBe(firstRedeemedAt?.toISOString());
    expect(
      await prisma.beatQuoteRedemptionIntent.count({ where: { benefitId: benefit.id, status: "completed" } })
    ).toBe(1);
  });

  it("IGNORES an order that is none of its business, without building an Admin client", async () => {
    // Every Buy Now, Group Buy and deposit order lands on this topic too.
    let built = 0;
    await handleBeatQuoteRedemptionOrderPaidWebhook(
      orderPaidEvent({
        admin_graphql_api_id: "gid://shopify/Order/999",
        tags: "carat-project-ABC",
        currency: "USD",
        current_total_discounts: "0.00",
        line_items: [],
      }),
      {
        adminGraphql: async () => {
          built += 1;
          throw new Error("should not have been built");
        },
      }
    );
    expect(built).toBe(0);
  });

  it("THROWS on an unparseable payload so Shopify redelivers", async () => {
    // Returning quietly would discard a real redemption. This is the defect
    // that silently ignored every deposit payment for a day.
    await expect(
      handleBeatQuoteRedemptionOrderPaidWebhook(orderPaidEvent({ not: "an order" }), {
        adminGraphql: async () => {
          throw new Error("not expected");
        },
      })
    ).rejects.toThrow(/did not match the expected shape/);
  });

  it("THROWS on an Admin API failure, because redelivery is the right answer", async () => {
    const { variant, intent } = await reservedRedemption();
    const orderGid = `gid://shopify/Order/${uniq()}`;
    await expect(
      handleBeatQuoteRedemptionOrderPaidWebhook(
        orderPaidEvent(
          paidOrderPayload({
          orderGid,
          intentId: intent.id,
          numericVariantId: variant.numericVariantId,
          reservedDiscountMinorUnits: intent.discountMinorUnits,
        })
        ),
        { adminGraphql: fakeAdmin(new Map(), { fail: true }) }
      )
    ).rejects.toThrow(/could not resolve the resulting order/);
    // Still reserved — an API blip must not become a permanent verdict.
    const after = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(after.status).toBe("reserved");
  });
});

describe("the tag is a lookup hint, never an authorisation", () => {
  it("REFUSES to redeem when Shopify says the draft order became a DIFFERENT order", async () => {
    // This is the exact shape a forged redemption takes: an attacker tags their
    // own order with somebody's redemption id.
    const { benefit, variant, intent } = await reservedRedemption();
    const attackerOrderGid = `gid://shopify/Order/attacker-${uniq()}`;
    const realOrderGid = `gid://shopify/Order/real-${uniq()}`;

    await handleBeatQuoteRedemptionOrderPaidWebhook(
      orderPaidEvent(
        paidOrderPayload({
          orderGid: attackerOrderGid,
          intentId: intent.id,
          numericVariantId: variant.numericVariantId,
          reservedDiscountMinorUnits: intent.discountMinorUnits,
        })
      ),
      { adminGraphql: fakeAdmin(new Map([[intent.draftOrderGid!, realOrderGid]])) }
    );

    const after = await prisma.beatQuoteFallbackBenefit.findUniqueOrThrow({ where: { id: benefit.id } });
    expect(after.redeemedAt).toBeNull();
    const stillReserved = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(stillReserved.status).toBe("reserved");
    // Recorded where staff can find it, keyed on the order — the only
    // identifier that is certainly correct when the intent is in doubt.
    const anomalies = await prisma.auditEvent.findMany({
      where: { entityType: "beat_quote_redemption", entityId: attackerOrderGid },
    });
    expect(anomalies).toHaveLength(1);
    expect(anomalies[0]!.reason).toMatch(/Shopify does not agree is its own/);
  });

  it("REFUSES a tag naming an intent that does not exist", async () => {
    const orderGid = `gid://shopify/Order/${uniq()}`;
    const madeUp = randomUUID();
    await handleBeatQuoteRedemptionOrderPaidWebhook(
      orderPaidEvent(
        paidOrderPayload({ orderGid, intentId: madeUp, numericVariantId: "123" })
      ),
      {
        adminGraphql: async () => {
          throw new Error("should not reach Shopify for an unknown intent");
        },
      }
    );
    const anomalies = await prisma.auditEvent.findMany({
      where: { entityType: "beat_quote_redemption", entityId: orderGid },
    });
    expect(anomalies[0]!.reason).toMatch(/does not exist/);
  });

  it("REFUSES an order carrying TWO redemption tags rather than picking one", async () => {
    const { variant, intent } = await reservedRedemption();
    const orderGid = `gid://shopify/Order/${uniq()}`;
    await handleBeatQuoteRedemptionOrderPaidWebhook(
      orderPaidEvent(
        paidOrderPayload({
          orderGid,
          intentId: intent.id,
          numericVariantId: variant.numericVariantId,
          reservedDiscountMinorUnits: intent.discountMinorUnits,
          tags: `${BEAT_QUOTE_REDEMPTION_ORDER_TAG_PREFIX}${intent.id},${BEAT_QUOTE_REDEMPTION_ORDER_TAG_PREFIX}${randomUUID()}`,
        })
      ),
      {
        adminGraphql: async () => {
          throw new Error("should not reach Shopify for an ambiguous tag");
        },
      }
    );
    const anomalies = await prisma.auditEvent.findMany({
      where: { entityType: "beat_quote_redemption", entityId: orderGid },
    });
    expect(anomalies[0]!.reason).toMatch(/exactly one intent/);
  });
});

describe("any mismatch fails closed to STAFF REVIEW", () => {
  it.each([
    ["the discount is not what we reserved", { discounts: "5.00" }, /does not equal the reserved/i],
    [
      "the order belongs to another customer",
      { customerGid: `gid://shopify/Customer/${OTHER_CUSTOMER_ID}` },
      /is not the reserving customer/i,
    ],
    ["the order has no customer at all", { customerGid: null }, /is not the reserving customer/i],
    ["the currency differs", { currency: "CAD" }, /currency/i],
    ["a discount code was applied", { discountCodes: [{ code: "SUMMER10" }] }, /another promotional discount/i],
  ])("%s", async (_label, overrides, pattern) => {
    const { benefit, variant, intent } = await reservedRedemption();
    const orderGid = `gid://shopify/Order/${uniq()}`;

    await handleBeatQuoteRedemptionOrderPaidWebhook(
      orderPaidEvent(
        paidOrderPayload({
          orderGid,
          intentId: intent.id,
          numericVariantId: variant.numericVariantId,
          reservedDiscountMinorUnits: intent.discountMinorUnits,
          ...overrides,
        })
      ),
      { adminGraphql: fakeAdmin(new Map([[intent.draftOrderGid!, orderGid]])) }
    );

    const after = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(after.status).toBe("failed_review");
    expect(after.reviewReason).toMatch(pattern);
    // NOT redeemed — a wrong discount must not consume the customer's one use.
    const fallback = await prisma.beatQuoteFallbackBenefit.findUniqueOrThrow({ where: { id: benefit.id } });
    expect(fallback.redeemedAt).toBeNull();
    // AND NOT released: the order may already have been honoured.
    expect(after.status).not.toBe("released");
    // Findable from the order as well as from the staff queue.
    const anomalies = await prisma.auditEvent.findMany({
      where: { entityType: "beat_quote_redemption", entityId: orderGid },
    });
    expect(anomalies).toHaveLength(1);
  });

  it("fails closed when the PAID order contains a Luxury Steal", async () => {
    // Re-derived from our own database at order time, not taken from the order:
    // a Final Sale item on a discounted order did not honour the terms,
    // however it got there.
    const { benefit, intent } = await reservedRedemption();
    const steal = await seedVariant({ bankPaymentPriceMinorUnits: 400_000n, isLuxurySteal: true });
    const orderGid = `gid://shopify/Order/${uniq()}`;

    await handleBeatQuoteRedemptionOrderPaidWebhook(
      orderPaidEvent(
        paidOrderPayload({
          orderGid,
          intentId: intent.id,
          numericVariantId: steal.numericVariantId,
          reservedDiscountMinorUnits: intent.discountMinorUnits,
        })
      ),
      { adminGraphql: fakeAdmin(new Map([[intent.draftOrderGid!, orderGid]])) }
    );

    const after = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(after.status).toBe("failed_review");
    expect(after.reviewReason).toMatch(/Group Buy or Luxury Steals/);
    expect(
      (await prisma.beatQuoteFallbackBenefit.findUniqueOrThrow({ where: { id: benefit.id } })).redeemedAt
    ).toBeNull();
    // The anomaly names WHICH line, which the domain function cannot know.
    const anomalies = await prisma.auditEvent.findMany({
      where: { entityType: "beat_quote_redemption", entityId: orderGid },
    });
    expect(anomalies[0]!.reason).toMatch(/Luxury Steal/);
  });

  it("fails closed on a variant this app does not price", async () => {
    // An unclassifiable line is not evidence that it was eligible.
    const { intent } = await reservedRedemption();
    const orderGid = `gid://shopify/Order/${uniq()}`;
    await handleBeatQuoteRedemptionOrderPaidWebhook(
      orderPaidEvent(
        paidOrderPayload({
          orderGid,
          intentId: intent.id,
          numericVariantId: "404404404",
          reservedDiscountMinorUnits: intent.discountMinorUnits,
        })
      ),
      { adminGraphql: fakeAdmin(new Map([[intent.draftOrderGid!, orderGid]])) }
    );
    const after = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(after.status).toBe("failed_review");
  });
});

describe("the handler reads when the order was PAID", () => {
  it("fails closed when the order carries no readable payment timestamp", async () => {
    // Falling back to `now` would silently reintroduce the bug `orderPaidAt`
    // exists to prevent — judging a benefit's expiry by when Shopify happened
    // to deliver the webhook. A paid order with no timestamp is strange enough
    // to look at instead.
    const { benefit: b, variant, intent } = await reservedRedemption();
    const orderGid = `gid://shopify/Order/${uniq()}`;

    await handleBeatQuoteRedemptionOrderPaidWebhook(
      orderPaidEvent(
        paidOrderPayload({
          orderGid,
          intentId: intent.id,
          numericVariantId: variant.numericVariantId,
          reservedDiscountMinorUnits: intent.discountMinorUnits,
          processedAt: null,
        })
      ),
      { adminGraphql: fakeAdmin(new Map([[intent.draftOrderGid!, orderGid]])) }
    );

    // Nothing written: still reserved, benefit untouched.
    const after = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(after.status).toBe("reserved");
    expect(
      (await prisma.beatQuoteFallbackBenefit.findUniqueOrThrow({ where: { id: b.id } })).redeemedAt
    ).toBeNull();
    const anomalies = await prisma.auditEvent.findMany({
      where: { entityType: "beat_quote_redemption", entityId: orderGid },
    });
    expect(anomalies[0]!.reason).toMatch(/no readable processed_at/);
  });

  it("completes an order PAID in time even when the delivery is late", async () => {
    // End-to-end counterpart of the unit-level regression: the webhook runs
    // against `new Date()` internally, so the only way this passes is if the
    // expiry really is judged against `processed_at`.
    const { benefit: b, variant, intent } = await reservedRedemption();
    const orderGid = `gid://shopify/Order/${uniq()}`;

    await handleBeatQuoteRedemptionOrderPaidWebhook(
      orderPaidEvent(
        paidOrderPayload({
          orderGid,
          intentId: intent.id,
          numericVariantId: variant.numericVariantId,
          reservedDiscountMinorUnits: intent.discountMinorUnits,
          // Comfortably inside the 90-day window.
          processedAt: new Date("2026-10-20T00:00:00.000Z").toISOString(),
        })
      ),
      { adminGraphql: fakeAdmin(new Map([[intent.draftOrderGid!, orderGid]])) }
    );

    expect(
      (await prisma.beatQuoteFallbackBenefit.findUniqueOrThrow({ where: { id: b.id } })).redeemedAt
    ).not.toBeNull();
  });

  it("fails closed on an order PAID after the benefit expired", async () => {
    const { benefit: b, variant, intent } = await reservedRedemption();
    const orderGid = `gid://shopify/Order/${uniq()}`;

    await handleBeatQuoteRedemptionOrderPaidWebhook(
      orderPaidEvent(
        paidOrderPayload({
          orderGid,
          intentId: intent.id,
          numericVariantId: variant.numericVariantId,
          reservedDiscountMinorUnits: intent.discountMinorUnits,
          // Well past the 90 days from the 2026-10-10 issue date.
          processedAt: new Date("2027-06-01T00:00:00.000Z").toISOString(),
        })
      ),
      { adminGraphql: fakeAdmin(new Map([[intent.draftOrderGid!, orderGid]])) }
    );

    const after = await prisma.beatQuoteRedemptionIntent.findUniqueOrThrow({ where: { id: intent.id } });
    expect(after.status).toBe("failed_review");
    expect(after.reviewReason).toMatch(/expired/i);
    expect(
      (await prisma.beatQuoteFallbackBenefit.findUniqueOrThrow({ where: { id: b.id } })).redeemedAt
    ).toBeNull();
  });
});
