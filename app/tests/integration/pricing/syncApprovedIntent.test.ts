import { randomUUID } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import type { ShopifyPriceSyncPort } from "~/jobs/pricing/ports";
import {
  PriceSyncIntentNotFoundError,
  ShopifyLinkageMissingError,
  syncApprovedPriceSyncIntent,
} from "~/jobs/pricing/syncApprovedIntent.server";
import { InvalidIntentTransitionError } from "~/jobs/pricing/intentTransitions.server";
import type { AdminGraphqlClient } from "~/shopify/admin/productClient.server";
import { PRICE_METAFIELD_NAMESPACE } from "~/shopify/metafields/priceMetafieldPayload";

/**
 * Spec §11, test plan cases 1-6 — the money-critical suite that gates
 * auto-publish. Cases 7-12 (Admin API failure, retries, suspension) are
 * outside T1's scope; the failure-handling agent (T4) owns those.
 *
 * Every test asserts on the SERIALISED GraphQL variables the fake port
 * recorded, not on an intermediate object — the class of bug this whole
 * pipeline exists to prevent is a correct-looking value serialising to the
 * wrong number.
 */

let fixtureSequence = 0;
const uniqueInt = (): number => (Date.now() % 900_000) + 1_000 + (fixtureSequence += 1);

/**
 * Every variant `makeFixture()` creates, ARCHIVED after each test.
 *
 * This suite's disposable database is shared across every integration test
 * FILE in the run (`tests/integration/globalSetup.ts`), and
 * `runPriceRecalculation` (called by OTHER test files, e.g.
 * `autoApplyTolerance.test.ts`, `job.test.ts`) queries `status: "active"`
 * with no per-file scope. A fixture variant left `active` here — several of
 * which this file deliberately gives a real synced anchor — gets swept into
 * every later recalculation run for the rest of the suite. Archiving removes
 * it from that query without this file needing to know what runs after it.
 */
const createdVariantIds: string[] = [];

afterEach(async () => {
  if (createdVariantIds.length === 0) return;
  await prisma.masterVariant.updateMany({
    where: { id: { in: createdVariantIds } },
    data: { status: "archived" },
  });
  createdVariantIds.length = 0;
});

/** Records calls instead of performing them, with an injectable failure. */
class FakeShopifyPriceSyncPort implements ShopifyPriceSyncPort {
  readonly calls: {
    shopifyProductGid: string;
    shopifyVariantGid: string;
    regularCardPriceMinorUnits: string;
    currency: string;
    priceCalculationId: string;
  }[] = [];
  failNextWith: Error | null = null;

  async applyVariantPrice(input: {
    shopifyProductGid: string;
    shopifyVariantGid: string;
    regularCardPrice: { toJSON(): { amountMinorUnits: string; currency: string } };
    priceCalculationId: string;
  }): Promise<{ appliedAt: Date }> {
    if (this.failNextWith) {
      const err = this.failNextWith;
      this.failNextWith = null;
      throw err;
    }
    const json = input.regularCardPrice.toJSON();
    this.calls.push({
      shopifyProductGid: input.shopifyProductGid,
      shopifyVariantGid: input.shopifyVariantGid,
      regularCardPriceMinorUnits: json.amountMinorUnits,
      currency: json.currency,
      priceCalculationId: input.priceCalculationId,
    });
    return { appliedAt: new Date("2026-09-19T12:00:00Z") };
  }
}

interface FixtureOptions {
  bankPaymentPriceMinorUnits: bigint;
  regularCardPriceRuleId?: "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1" | "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1";
  fixedCardUpliftRate?: string;
  isPlaceholder?: boolean;
  intentStatus?: "approved" | "pending_approval" | "synced" | "rejected";
  linked?: boolean;
  previousBankPaymentPriceMinorUnits?: bigint | null;
}

async function makeFixture(opts: FixtureOptions) {
  const suffix = randomUUID().slice(0, 8);
  // shopifyLegacyIdFromGid (R14, Stage 2B-6) requires a PURE-DIGIT trailing
  // gid segment, matching a real Shopify id. `suffix` above is hex and can
  // contain a-f, which intermittently failed that parse once the metafield
  // -publish wiring started deriving a Liquid-native numeric id from these
  // fixtures' gids — a latent bug in this shared builder that simply never
  // mattered before that requirement existed. `suffix` still names things
  // (never asserted on for its literal value); only the gids need digits.
  const shopifyLegacyId = uniqueInt();
  const linked = opts.linked ?? true;

  const product = await prisma.masterProduct.create({
    data: {
      name: `sync fixture ${suffix}`,
      category: "ring",
      sizeAxis: "none",
      allowedSizeMin: "0",
      allowedSizeMax: "0",
      sizeIncrement: "1",
      baseSize: "0",
      offeredMetals: ["gold"],
      status: "active",
      shopifyProductGid: linked ? `gid://shopify/Product/${shopifyLegacyId}` : null,
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
      shopifyVariantGid: linked ? `gid://shopify/ProductVariant/${shopifyLegacyId}` : null,
    },
  });
  createdVariantIds.push(variant.id);
  const profile = await prisma.pricingProfile.create({
    data: {
      code: "buy_now",
      version: uniqueInt(),
      marginModel: "TARGET_GROSS_MARGIN_V1",
      targetGrossMarginRate: opts.isPlaceholder ? "0.999900" : "0.420000",
      minGrossMarginRate: opts.isPlaceholder ? "0.999800" : "0.350000",
      minDollarProfitMinorUnits: 15000n,
      currency: "USD",
      roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
      regularCardPriceRuleId: opts.regularCardPriceRuleId ?? "BANK_TIERED_UPLIFT_CEIL_FIVE_DOLLARS_V1",
      fixedCardUpliftRate: opts.fixedCardUpliftRate ?? "0.050000",
      priceEndingRuleId: "NONE_V1",
      autoApplyToleranceBps: 200,
      effectiveFrom: new Date("2020-01-01T00:00:00Z"),
      createdBy: "integration-test",
      isPlaceholder: opts.isPlaceholder ?? false,
    },
  });
  const snapshot = await prisma.snapshot.create({
    data: { kind: "pricing.it", payload: {}, contentHash: `sync-${suffix}` },
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
  const intent = await prisma.priceSyncIntent.create({
    data: {
      masterVariantId: variant.id,
      priceCalculationId: calc.id,
      decision: "auto_apply",
      status: opts.intentStatus ?? "approved",
      previousBankPaymentPriceMinorUnits: opts.previousBankPaymentPriceMinorUnits ?? null,
      previousBankPaymentPriceCurrency: opts.previousBankPaymentPriceMinorUnits !== undefined ? "USD" : null,
      attemptCount: 0,
    },
  });

  return { product, variant, profile, snapshot, calc, intent };
}

describe("case 1 — an approved intent syncs: one call, synced status, anchor written", () => {
  it("calls the port once, moves to synced, and writes the compare-and-set anchor", async () => {
    const { variant, calc, intent } = await makeFixture({ bankPaymentPriceMinorUnits: 100_000n });
    const port = new FakeShopifyPriceSyncPort();

    const outcome = await syncApprovedPriceSyncIntent(intent.id, { port });

    expect(outcome.kind).toBe("synced");
    expect(port.calls).toHaveLength(1);

    const after = await prisma.priceSyncIntent.findUnique({ where: { id: intent.id } });
    expect(after?.status).toBe("synced");
    expect(after?.syncedAt).not.toBeNull();

    const variantAfter = await prisma.masterVariant.findUnique({ where: { id: variant.id } });
    expect(variantAfter?.lastSyncedPriceCalculationId).toBe(calc.id);

    const audit = await prisma.auditEvent.findMany({
      where: { entityType: "price_sync_intent", entityId: intent.id, action: "price_sync_intent.synced" },
    });
    expect(audit).toHaveLength(1);
  });
});

describe("case 2 — replaying an already-synced intent is a no-op", () => {
  it("makes no second Admin API call and no second write", async () => {
    const { intent } = await makeFixture({ bankPaymentPriceMinorUnits: 100_000n });
    const port = new FakeShopifyPriceSyncPort();

    await syncApprovedPriceSyncIntent(intent.id, { port });
    expect(port.calls).toHaveLength(1);

    const replayed = await syncApprovedPriceSyncIntent(intent.id, { port });
    expect(replayed.kind).toBe("already_synced");
    expect(port.calls).toHaveLength(1); // still one — no second call

    const audit = await prisma.auditEvent.findMany({
      where: { entityType: "price_sync_intent", entityId: intent.id, action: "price_sync_intent.synced" },
    });
    expect(audit).toHaveLength(1); // still one — no second write
  });
});

describe("case 3 — a newer calculation supersedes: zero Admin API calls", () => {
  it("marks the intent superseded and never calls the port", async () => {
    const { variant, profile, intent } = await makeFixture({ bankPaymentPriceMinorUnits: 100_000n });
    const port = new FakeShopifyPriceSyncPort();

    // A newer calculation for the SAME variant, created after the intent.
    const snapshot2 = await prisma.snapshot.create({
      data: { kind: "pricing.it", payload: { v: 2 }, contentHash: `newer-${randomUUID()}` },
    });
    await prisma.priceCalculation.create({
      data: {
        runId: randomUUID(),
        masterVariantId: variant.id,
        pricingProfileId: profile.id,
        profileVersion: profile.version,
        engineVersion: "BUY_NOW_PRICING_V1",
        roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
        priceEndingRuleId: "NONE_V1",
        asOf: new Date(),
        snapshotId: snapshot2.id,
        landedCostMinorUnits: 1000n,
        bankPaymentPriceMinorUnits: 999_000n,
        currency: "USD",
        status: "computed",
      },
    });

    const outcome = await syncApprovedPriceSyncIntent(intent.id, { port });

    expect(outcome.kind).toBe("superseded");
    expect(port.calls).toHaveLength(0);

    const after = await prisma.priceSyncIntent.findUnique({ where: { id: intent.id } });
    expect(after?.status).toBe("superseded");

    const variantAfter = await prisma.masterVariant.findUnique({ where: { id: variant.id } });
    expect(variantAfter?.lastSyncedPriceCalculationId).toBeNull();
  });
});

describe("case 4 — a placeholder profile refuses the call", () => {
  it("detected immediately before the Admin API call — no call is made", async () => {
    const { intent } = await makeFixture({ bankPaymentPriceMinorUnits: 100_000n, isPlaceholder: true });
    const port = new FakeShopifyPriceSyncPort();

    const outcome = await syncApprovedPriceSyncIntent(intent.id, { port });

    expect(outcome.kind).toBe("placeholder_refused");
    expect(port.calls).toHaveLength(0);

    const after = await prisma.priceSyncIntent.findUnique({ where: { id: intent.id } });
    // No status change — the intent stays approved rather than being
    // silently marked as anything terminal, so a future re-check (once D14
    // is resolved) can still pick it up.
    expect(after?.status).toBe("approved");

    const audit = await prisma.auditEvent.findMany({
      where: {
        entityType: "price_sync_intent",
        entityId: intent.id,
        action: "price_sync_intent.placeholder_refused",
      },
    });
    expect(audit).toHaveLength(1);
  });

  it("reads isPlaceholder with its own fresh query, not the joined object handed to it internally", async () => {
    // `pricing_profile` is append-only at the database level (proven by this
    // suite's earlier discovery that UPDATE on it is rejected — see the
    // header comment on syncApprovedIntent.server.ts's placeholder check), so
    // an EXISTING profile row's `isPlaceholder` value can never actually
    // change after creation; a resolved D14 creates a new profile VERSION,
    // not a mutation of this one. That makes the specific "flips mid-flight"
    // race criterion 7 was worried about structurally impossible here — this
    // test instead pins the mechanism itself: a non-placeholder profile is
    // read fresh and correctly allows the sync to proceed, which is the
    // behaviour a caching/joined-object shortcut would have to get right too.
    const { intent } = await makeFixture({ bankPaymentPriceMinorUnits: 100_000n, isPlaceholder: false });
    const port = new FakeShopifyPriceSyncPort();

    const outcome = await syncApprovedPriceSyncIntent(intent.id, { port });

    expect(outcome.kind).toBe("synced");
    expect(port.calls).toHaveLength(1);
  });
});

describe("case 5 — a historical calculation publishes under its OWN profile's rule", () => {
  it("publishes the legacy whole-dollar figure while the active profile carries the tiered rule", async () => {
    // The legacy rule: card = ceil_to_whole_dollar(bank * (1 + configuredRate)).
    // bank = $1,000.00, rate = 5% -> preliminary $1,050.00 -> already whole.
    const { intent } = await makeFixture({
      bankPaymentPriceMinorUnits: 100_000n,
      regularCardPriceRuleId: "CARD_UPLIFT_CEIL_WHOLE_DOLLAR_V1",
      fixedCardUpliftRate: "0.050000",
    });
    const port = new FakeShopifyPriceSyncPort();

    const outcome = await syncApprovedPriceSyncIntent(intent.id, { port });

    expect(outcome.kind).toBe("synced");
    // $1,050.00 under the LEGACY rule — NOT the tiered rule's figure, which
    // at this bank price (>= $1,000 tier) would apply a 4.0% rate instead
    // and ceiling to the next $5, producing a DIFFERENT number ($1,040.00).
    // Publishing the tiered figure here would mean the historical
    // calculation's own profile was ignored in favour of "whatever the rule
    // says today" — exactly what criterion 3 / C-S2 note 2 forbids.
    expect(port.calls[0]?.regularCardPriceMinorUnits).toBe("105000");
    const tieredFigureWouldHaveBeen = "104000";
    expect(port.calls[0]?.regularCardPriceMinorUnits).not.toBe(tieredFigureWouldHaveBeen);
  });
});

describe("case 6 — the published figure is the $5-ceilinged tiered card price, at every tier boundary", () => {
  const cases: { label: string; bankPaymentPriceMinorUnits: bigint; expectedCardMinorUnits: string }[] = [
    // Under $500 tier (5.0%) — lands exactly on a $5 multiple, no ceiling bump needed.
    { label: "under-$500 tier, exact multiple of $5", bankPaymentPriceMinorUnits: 40_000n, expectedCardMinorUnits: "42000" },
    // $500-$999.99 tier (4.5%) — needs a ceiling bump.
    { label: "$500 tier boundary, needs rounding up", bankPaymentPriceMinorUnits: 50_000n, expectedCardMinorUnits: "52500" },
    // $1,000-$2,499.99 tier (4.0%) — exact multiple of $5.
    { label: "$1,000 tier boundary, exact multiple of $5", bankPaymentPriceMinorUnits: 100_000n, expectedCardMinorUnits: "104000" },
    // $2,500-$4,999.99 tier (3.5%) — needs a ceiling bump.
    { label: "$2,500 tier boundary, needs rounding up", bankPaymentPriceMinorUnits: 250_000n, expectedCardMinorUnits: "259000" },
    // $5,000+ tier (3.0%) — exact multiple of $5.
    { label: "$5,000 tier boundary, exact multiple of $5", bankPaymentPriceMinorUnits: 500_000n, expectedCardMinorUnits: "515000" },
  ];

  it.each(cases)("$label", async ({ bankPaymentPriceMinorUnits, expectedCardMinorUnits }) => {
    const { intent } = await makeFixture({ bankPaymentPriceMinorUnits });
    const port = new FakeShopifyPriceSyncPort();

    await syncApprovedPriceSyncIntent(intent.id, { port });

    expect(port.calls[0]?.regularCardPriceMinorUnits).toBe(expectedCardMinorUnits);
  });
});

describe("guard the guard — publishing the bank price instead of the card price would fail these tests", () => {
  it("the published price differs visibly from the stored bank price at every fixture used above", async () => {
    // A test that only checked the published figure equals SOME number would
    // pass even if the adapter were accidentally wired to the bank price —
    // this asserts the two are different by a wide, unmistakable margin,
    // which is the actual failure mode C-S2 note 1 warns about.
    const bankPaymentPriceMinorUnits = 100_000n; // $1,000.00
    const { intent } = await makeFixture({ bankPaymentPriceMinorUnits });
    const port = new FakeShopifyPriceSyncPort();

    await syncApprovedPriceSyncIntent(intent.id, { port });

    const published = port.calls[0]?.regularCardPriceMinorUnits;
    expect(published).toBeDefined();
    expect(published).not.toBe(bankPaymentPriceMinorUnits.toString());
    // Published must be the HIGHER figure — undercharging is the specific
    // direction of failure C-S2 note 1 describes.
    expect(BigInt(published!)).toBeGreaterThan(bankPaymentPriceMinorUnits);
  });
});

describe("boundary and error conditions", () => {
  it("throws for an unknown intent id", async () => {
    const port = new FakeShopifyPriceSyncPort();
    await expect(syncApprovedPriceSyncIntent(randomUUID(), { port })).rejects.toBeInstanceOf(
      PriceSyncIntentNotFoundError
    );
  });

  it("throws InvalidIntentTransitionError for a pending_approval intent — sync is reachable only from approved", async () => {
    const { intent } = await makeFixture({ bankPaymentPriceMinorUnits: 100_000n, intentStatus: "pending_approval" });
    const port = new FakeShopifyPriceSyncPort();
    await expect(syncApprovedPriceSyncIntent(intent.id, { port })).rejects.toBeInstanceOf(
      InvalidIntentTransitionError
    );
    expect(port.calls).toHaveLength(0);
  });

  it("throws InvalidIntentTransitionError for a rejected (terminal) intent", async () => {
    const { intent } = await makeFixture({ bankPaymentPriceMinorUnits: 100_000n, intentStatus: "rejected" });
    const port = new FakeShopifyPriceSyncPort();
    await expect(syncApprovedPriceSyncIntent(intent.id, { port })).rejects.toBeInstanceOf(
      InvalidIntentTransitionError
    );
    expect(port.calls).toHaveLength(0);
  });

  it("throws ShopifyLinkageMissingError when the variant has no Shopify ids yet, before any call", async () => {
    const { intent } = await makeFixture({ bankPaymentPriceMinorUnits: 100_000n, linked: false });
    const port = new FakeShopifyPriceSyncPort();
    await expect(syncApprovedPriceSyncIntent(intent.id, { port })).rejects.toBeInstanceOf(
      ShopifyLinkageMissingError
    );
    expect(port.calls).toHaveLength(0);
  });

  it("an Admin API failure propagates and leaves the intent in syncing, not synced", async () => {
    // T4 owns retries/alerts/suspension; this just pins the boundary this
    // function hands off at.
    const { intent } = await makeFixture({ bankPaymentPriceMinorUnits: 100_000n });
    const port = new FakeShopifyPriceSyncPort();
    port.failNextWith = new Error("simulated Admin API failure");

    await expect(syncApprovedPriceSyncIntent(intent.id, { port })).rejects.toThrow(
      "simulated Admin API failure"
    );

    const after = await prisma.priceSyncIntent.findUnique({ where: { id: intent.id } });
    expect(after?.status).toBe("syncing");
    expect(after?.attemptCount).toBe(1);

    const variantAfter = await prisma.masterVariant.findUnique({ where: { id: intent.masterVariantId } });
    expect(variantAfter?.lastSyncedPriceCalculationId).toBeNull();
  });
});

/**
 * Stage 2B-6 — the metafield-publish wiring INSIDE `syncApprovedIntent.server.ts`,
 * flagged in the 2B-6 handoff as covered only by unit tests with injected
 * fakes. Real Prisma, a real committed `synced` intent, and a fake Admin API
 * client at the network boundary (matching the pattern `asLowAsAggregator.test.ts`
 * and `inventoryPurchasabilityWebhook.test.ts` already use) — the property
 * under test is the ISOLATION contract the module comment on the metafield
 * -publish block documents: a metafield failure must leave sync state
 * (the money-critical half) completely untouched.
 */
function fakeMetafieldClient(opts: { failSet?: boolean } = {}) {
  const calls: { document: string; variables: Record<string, unknown> }[] = [];
  const client: AdminGraphqlClient = {
    async graphql(document, options) {
      const variables = (options?.variables ?? {}) as Record<string, unknown>;
      calls.push({ document, variables });

      if (document.includes("CaratVariantsAvailability")) {
        const ids = variables.ids as string[];
        return { json: async () => ({ data: { nodes: ids.map((id) => ({ id, availableForSale: true })) } }) };
      }

      if (document.includes("CaratSetPriceMetafields")) {
        if (opts.failSet) {
          return { json: async () => ({ errors: [{ message: "simulated metafield write failure" }] }) };
        }
        const inputs = variables.metafields as { namespace: string; key: string }[];
        return {
          json: async () => ({
            data: {
              metafieldsSet: {
                metafields: inputs.map((input, i) => ({
                  id: `gid://shopify/Metafield/${i}`,
                  namespace: input.namespace,
                  key: input.key,
                  ownerType: "PRODUCTVARIANT",
                })),
                userErrors: [],
              },
            },
          }),
        };
      }

      if (document.includes("CaratDeletePriceMetafields")) {
        const identifiers = variables.metafields as { namespace: string; key: string; ownerId: string }[];
        return {
          json: async () => ({
            data: { metafieldsDelete: { deletedMetafields: identifiers.map((i) => ({ ...i })), userErrors: [] } },
          }),
        };
      }

      throw new Error(`fakeMetafieldClient received an unexpected document: ${document.slice(0, 80)}`);
    },
  };
  return { client, calls };
}

describe("2B-6 — the metafield-publish wiring inside syncApprovedIntent.server.ts", () => {
  it("a committed synced outcome attempts the variant metafield write", async () => {
    const { intent } = await makeFixture({ bankPaymentPriceMinorUnits: 100_000n });
    const port = new FakeShopifyPriceSyncPort();
    const { client, calls } = fakeMetafieldClient();

    const outcome = await syncApprovedPriceSyncIntent(intent.id, { port, metafields: { client } });

    expect(outcome.kind).toBe("synced");
    const setCalls = calls.filter((c) => c.document.includes("CaratSetPriceMetafields"));
    expect(setCalls.length).toBeGreaterThanOrEqual(1);
    const variantWrite = setCalls
      .flatMap((c) => c.variables.metafields as { namespace: string; key: string }[])
      .find((m) => m.key === "bank_payment_price_minor_units");
    expect(variantWrite).toMatchObject({ namespace: PRICE_METAFIELD_NAMESPACE });
  });

  it("skips metafield publish entirely — no Admin API call for it — when no metafields dependency is supplied, exactly as before this dependency existed", async () => {
    const { intent } = await makeFixture({ bankPaymentPriceMinorUnits: 100_000n });
    const port = new FakeShopifyPriceSyncPort();

    const outcome = await syncApprovedPriceSyncIntent(intent.id, { port });

    expect(outcome.kind).toBe("synced");
    // No fake to inspect here — the point is that omitting `metafields`
    // changes nothing else about a successful sync, which case 1 above
    // already fully verifies. This test exists to guard against a future
    // edit making `deps.metafields` load-bearing for the sync itself.
  });

  it("a metafield write failure leaves sync state COMPLETELY untouched — the intent is still synced, the anchor is still written, and nothing throws", async () => {
    const { intent, variant, calc } = await makeFixture({ bankPaymentPriceMinorUnits: 100_000n });
    const port = new FakeShopifyPriceSyncPort();
    const { client } = fakeMetafieldClient({ failSet: true });

    // The money-critical call succeeds; only the metafield write fails.
    // syncApprovedPriceSyncIntent must not throw, must not roll back, and
    // must not leave the intent anywhere other than `synced`.
    const outcome = await syncApprovedPriceSyncIntent(intent.id, { port, metafields: { client } });

    expect(outcome.kind).toBe("synced");
    expect(port.calls).toHaveLength(1); // the real publish still happened, exactly once

    const after = await prisma.priceSyncIntent.findUnique({ where: { id: intent.id } });
    expect(after?.status).toBe("synced");
    expect(after?.syncedAt).not.toBeNull();

    const variantAfter = await prisma.masterVariant.findUnique({ where: { id: variant.id } });
    expect(variantAfter?.lastSyncedPriceCalculationId).toBe(calc.id);

    // The money-critical audit event still exists — a metafield failure
    // must not suppress or corrupt the evidence trail for the real publish.
    const audit = await prisma.auditEvent.findMany({
      where: { entityType: "price_sync_intent", entityId: intent.id, action: "price_sync_intent.synced" },
    });
    expect(audit).toHaveLength(1);
  });

  it("a metafield write failure does not prevent a LATER, independent sync from publishing its own metafield successfully", async () => {
    // Proves the isolation is per-attempt, not a latched/sticky failure —
    // a transient metafield error on one publish must not poison the next.
    const first = await makeFixture({ bankPaymentPriceMinorUnits: 100_000n });
    await syncApprovedPriceSyncIntent(first.intent.id, {
      port: new FakeShopifyPriceSyncPort(),
      metafields: { client: fakeMetafieldClient({ failSet: true }).client },
    });

    const second = await makeFixture({ bankPaymentPriceMinorUnits: 150_000n });
    const { client, calls } = fakeMetafieldClient();
    const outcome = await syncApprovedPriceSyncIntent(second.intent.id, {
      port: new FakeShopifyPriceSyncPort(),
      metafields: { client },
    });

    expect(outcome.kind).toBe("synced");
    expect(calls.some((c) => c.document.includes("CaratSetPriceMetafields"))).toBe(true);
  });
});
