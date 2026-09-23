import { randomUUID } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { recordSyncSuccess } from "~/db/repositories/priceSyncFailureRepository.server";
import { runGuaranteeSweep } from "~/jobs/bankpayment/guaranteeSweep.server";
import { gatherVariantPriceFacts } from "~/jobs/bankpayment/guaranteeFacts.server";
import type { EmailPort, SendEmailInput, SendEmailResult } from "~/lib/email/port";
import type { EmailPortResolution } from "~/lib/email/configuredPort.server";

/**
 * Integration tests for the 24-hour guarantee sweep (spec §13/§14, criteria
 * 78-82, 96, 100-102). Every DB write the sweep can make is asserted against
 * the real Postgres schema, including the append-only/coherence triggers
 * `completeOrder.test.ts` already exercises for this table.
 */

let sequence = 0;
const uniq = () => `${Date.now() % 900_000}-${(sequence += 1)}`;
const createdMasterProductIds: string[] = [];
/**
 * `runGuaranteeSweep` scans EVERY open order table-wide — there is no
 * per-test scoping parameter, deliberately, since production has no notion
 * of "this test's orders" either. Any fixture left `open` after a test would
 * silently inflate every later test's `ordersConsidered`/`kept`/`flagged`
 * counts in this same file. Force-closing everything this file created,
 * regardless of what a given test itself did to it, is what keeps the tests
 * isolated from each other without touching the append-only `bank_payment_
 * order_line` rows (which cannot be deleted — see the M7 migration comment —
 * and do not need to be; only the header's `status` matters to the sweep's
 * query).
 */
const createdBankPaymentOrderIds: string[] = [];

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/**
 * `runGuaranteeSweep` deliberately has no per-test scoping (production has
 * no notion of "this test's orders" either), so it also sees whatever OTHER
 * test files left `open` in this run's shared disposable database before
 * this file started — e.g. `completeOrder.test.ts`'s own unverified-order
 * fixtures, which that file has no reason to close since it never calls a
 * table-scanning sweep. Cleared ONCE, before any test in this file runs,
 * rather than worked around with "at least" assertions everywhere below —
 * every other file's own tests have already made their assertions by the
 * time this runs (`fileParallelism: false`), so nothing here can invalidate
 * them.
 */
beforeAll(async () => {
  await prisma.bankPaymentOrder.updateMany({
    where: { status: "open" },
    data: {
      status: "cancelled",
      cancelledAt: new Date(),
      cancellationReason: "cleared before guarantee-sweep integration tests — see this file's beforeAll",
    },
  });
});

afterEach(async () => {
  if (createdBankPaymentOrderIds.length > 0) {
    await prisma.bankPaymentOrder.updateMany({
      where: { id: { in: createdBankPaymentOrderIds }, status: "open" },
      data: { status: "cancelled", cancelledAt: new Date(), cancellationReason: "integration-test cleanup" },
    });
    createdBankPaymentOrderIds.length = 0;
  }
  if (createdMasterProductIds.length === 0) return;
  await prisma.masterVariant.updateMany({
    where: { masterProductId: { in: createdMasterProductIds } },
    data: { status: "archived" },
  });
  createdMasterProductIds.length = 0;
});

/** A fake `EmailPort` that records every send and never actually delivers anything. */
function fakeEmailPort(opts: { failEveryCall?: boolean } = {}) {
  const sent: SendEmailInput[] = [];
  const port: EmailPort = {
    async send(input: SendEmailInput): Promise<SendEmailResult> {
      if (opts.failEveryCall) throw new Error("simulated provider failure");
      sent.push(input);
      return { providerMessageId: `fake-${sent.length}` };
    },
  };
  const resolution: EmailPortResolution = {
    configured: true,
    port,
    from: "no-reply@caratforus.test",
    recipients: ["staff@caratforus.test"],
  };
  return { sent, resolveEmailPort: () => resolution };
}

function unconfiguredEmailPort(): () => EmailPortResolution {
  return () => ({ configured: false, reason: "email not configured: test fixture" });
}

async function aPricingProfile() {
  return prisma.pricingProfile.findFirstOrThrow({
    where: { code: "buy_now", isPlaceholder: false },
    orderBy: { version: "desc" },
  });
}

async function aVariant(profileId: string) {
  const suffix = uniq();
  const product = await prisma.masterProduct.create({
    data: {
      name: `guarantee sweep fixture ${suffix}`,
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
  return { variant, profileId };
}

async function aComputedCalculation(input: {
  masterVariantId: string;
  profileId: string;
  bankPaymentPriceMinorUnits: bigint;
}) {
  const profile = await prisma.pricingProfile.findUniqueOrThrow({ where: { id: input.profileId } });
  const snapshot = await prisma.snapshot.create({
    data: { kind: "pricing.it", payload: {}, contentHash: `sweep-${randomUUID()}` },
  });
  return prisma.priceCalculation.create({
    data: {
      runId: randomUUID(),
      masterVariantId: input.masterVariantId,
      pricingProfileId: profile.id,
      profileVersion: profile.version,
      engineVersion: "BUY_NOW_PRICING_V1",
      roundingRuleId: "HALF_UP_MINOR_UNIT_V1",
      priceEndingRuleId: "NONE_V1",
      asOf: new Date(),
      snapshotId: snapshot.id,
      landedCostMinorUnits: 1000n,
      bankPaymentPriceMinorUnits: input.bankPaymentPriceMinorUnits,
      currency: "USD",
      status: "computed",
    },
  });
}

/** Publishes a calculation as THE currently synced one for a variant — the same anchor `syncApprovedIntent.server.ts` writes on a real sync. */
async function publish(masterVariantId: string, priceCalculationId: string): Promise<void> {
  await prisma.masterVariant.update({
    where: { id: masterVariantId },
    data: { lastSyncedPriceCalculationId: priceCalculationId },
  });
}

/** Records a `price_sync_intent` that reached `synced`, standing in for a real sync job run (this test does not exercise `syncApprovedIntent.server.ts` itself — that module is covered elsewhere). */
async function recordSyncedIntent(input: {
  masterVariantId: string;
  priceCalculationId: string;
  decision: "auto_apply" | "needs_approval";
  syncedAt: Date;
}) {
  return prisma.priceSyncIntent.create({
    data: {
      masterVariantId: input.masterVariantId,
      priceCalculationId: input.priceCalculationId,
      decision: input.decision,
      status: "synced",
      syncedAt: input.syncedAt,
      attemptCount: 1,
    },
  });
}

/** Republishes a NEW calculation for a variant and records the sync intent that (per the fixture) put it there — combining `aComputedCalculation`, `recordSyncedIntent` and `publish`. */
async function republish(input: {
  masterVariantId: string;
  profileId: string;
  bankPaymentPriceMinorUnits: bigint;
  decision: "auto_apply" | "needs_approval";
  syncedAt: Date;
}) {
  const calc = await aComputedCalculation({
    masterVariantId: input.masterVariantId,
    profileId: input.profileId,
    bankPaymentPriceMinorUnits: input.bankPaymentPriceMinorUnits,
  });
  await recordSyncedIntent({
    masterVariantId: input.masterVariantId,
    priceCalculationId: calc.id,
    decision: input.decision,
    syncedAt: input.syncedAt,
  });
  await publish(input.masterVariantId, calc.id);
  return calc;
}

/** Opens a SUSPENDED (withdrawn) sync-failure episode directly — the state `isVariantWithdrawn` reads as unresolvable (D21). */
async function suspendVariantViaSyncFailure(masterVariantId: string, now = new Date()) {
  return prisma.priceSyncFailure.create({
    data: {
      masterVariantId,
      firstFailedAt: new Date(now.getTime() - 49 * HOUR_MS),
      lastAttemptAt: now,
      attemptCount: 12,
      lastError: "simulated Admin API failure",
      suspendedAt: now,
    },
  });
}

async function aQuotedOrder(input: {
  masterVariantId: string;
  priceCalculationId: string;
  quotedBankPaymentPriceMinorUnits: bigint;
  quotedAt: Date;
  guaranteeExpiresAt: Date;
}) {
  const suffix = uniq();
  const order = await prisma.bankPaymentOrder.create({
    data: {
      shopifyDraftOrderGid: `gid://shopify/DraftOrder/${suffix}`,
      customerEmail: `sweep-${suffix}@example.com`,
      status: "open",
      quotedAt: input.quotedAt,
      guaranteeExpiresAt: input.guaranteeExpiresAt,
      lines: {
        create: [
          {
            masterVariantId: input.masterVariantId,
            priceCalculationId: input.priceCalculationId,
            quantity: 1,
            quotedBankPaymentPriceMinorUnits: input.quotedBankPaymentPriceMinorUnits,
            quotedRegularCardPriceMinorUnits: input.quotedBankPaymentPriceMinorUnits + 5_000n,
            currency: "USD",
            eligibleAtQuoteTime: true,
          },
        ],
      },
    },
  });
  createdBankPaymentOrderIds.push(order.id);
  return order;
}

describe("criterion 79/96 — automatic-only changes never cancel", () => {
  it("keeps the order open at its quoted price when only an auto-applied publication happened", async () => {
    const profile = await aPricingProfile();
    const { variant } = await aVariant(profile.id);
    const quotedAt = new Date(Date.now() - 25 * HOUR_MS);
    const guaranteeExpiresAt = new Date(quotedAt.getTime() + DAY_MS);
    const baseCalc = await aComputedCalculation({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 100_000n,
    });
    await publish(variant.id, baseCalc.id);
    const order = await aQuotedOrder({
      masterVariantId: variant.id,
      priceCalculationId: baseCalc.id,
      quotedBankPaymentPriceMinorUnits: 100_000n,
      quotedAt,
      guaranteeExpiresAt,
    });

    // Ordinary metal-drift auto-publish after the quote — no human involved.
    await republish({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 100_300n,
      decision: "auto_apply",
      syncedAt: new Date(quotedAt.getTime() + HOUR_MS),
    });

    const { sent, resolveEmailPort } = fakeEmailPort();
    const summary = await runGuaranteeSweep({ now: new Date(), resolveEmailPort });

    expect(summary.kept).toBe(1);
    expect(summary.cancelled).toBe(0);
    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("open");
    expect(sent).toHaveLength(0);
  });
});

describe("criterion 80/D22 — a human-approved change cancels, no tolerance band", () => {
  it("cancels on a ONE-CENT human-approved change and emails the customer exactly once", async () => {
    const profile = await aPricingProfile();
    const { variant } = await aVariant(profile.id);
    const quotedAt = new Date(Date.now() - 25 * HOUR_MS);
    const guaranteeExpiresAt = new Date(quotedAt.getTime() + DAY_MS);
    const baseCalc = await aComputedCalculation({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 100_000n,
    });
    await publish(variant.id, baseCalc.id);
    const order = await aQuotedOrder({
      masterVariantId: variant.id,
      priceCalculationId: baseCalc.id,
      quotedBankPaymentPriceMinorUnits: 100_000n,
      quotedAt,
      guaranteeExpiresAt,
    });

    await republish({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 100_001n,
      decision: "needs_approval",
      syncedAt: new Date(quotedAt.getTime() + HOUR_MS),
    });

    const { sent, resolveEmailPort } = fakeEmailPort();
    const summary = await runGuaranteeSweep({ now: new Date(), resolveEmailPort });

    expect(summary.cancelled).toBe(1);
    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("cancelled");
    expect(after.cancelledAt).not.toBeNull();
    expect(after.cancellationReason).toContain(variant.id);
    expect(after.cancellationReason).toContain("100000");
    expect(after.cancellationReason).toContain("100001");

    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual([order.customerEmail]);
    expect(sent[0]!.text).toContain(order.id);

    // The delivery outcome is a PERSISTED record, not merely a log line
    // (owner verification list) — including the provider's own message id,
    // proof Resend actually accepted the send.
    expect(after.cancellationEmailStatus).toBe("sent");
    expect(after.cancellationEmailProviderMessageId).toBe("fake-1");
    expect(after.cancellationEmailAttemptedAt).not.toBeNull();
  });

  /**
   * THE ORDERING A CURRENT-STATE CHECK GETS WRONG (D22 §13). A human
   * approves a rise; an automatic publication lands on top of it overnight.
   * The CURRENTLY published calculation is the automatic one, but the
   * historical human approval must still cancel the order.
   */
  it("HUMAN-APPROVAL-THEN-AUTO-PUBLISH: cancels even though the latest publication was automatic", async () => {
    const profile = await aPricingProfile();
    const { variant } = await aVariant(profile.id);
    const quotedAt = new Date(Date.now() - 25 * HOUR_MS);
    const guaranteeExpiresAt = new Date(quotedAt.getTime() + DAY_MS);
    const baseCalc = await aComputedCalculation({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 100_000n,
    });
    await publish(variant.id, baseCalc.id);
    const order = await aQuotedOrder({
      masterVariantId: variant.id,
      priceCalculationId: baseCalc.id,
      quotedBankPaymentPriceMinorUnits: 100_000n,
      quotedAt,
      guaranteeExpiresAt,
    });

    // A human approves a 6% rise...
    await republish({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 106_000n,
      decision: "needs_approval",
      syncedAt: new Date(quotedAt.getTime() + HOUR_MS),
    });
    // ...then ordinary overnight drift auto-publishes ON TOP of it. This is
    // now the CURRENT published calculation.
    await republish({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 106_300n,
      decision: "auto_apply",
      syncedAt: new Date(quotedAt.getTime() + 2 * HOUR_MS),
    });

    const { resolveEmailPort } = fakeEmailPort();
    const summary = await runGuaranteeSweep({ now: new Date(), resolveEmailPort });

    expect(summary.cancelled).toBe(1);
    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("cancelled");
  });

  it("NAMED BOUNDARY CASE — cancels exactly at the 24h instant, not one ms before", async () => {
    const profile = await aPricingProfile();
    const { variant } = await aVariant(profile.id);
    const quotedAt = new Date("2026-01-01T00:00:00.000Z");
    const guaranteeExpiresAt = new Date(quotedAt.getTime() + DAY_MS);
    const baseCalc = await aComputedCalculation({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 100_000n,
    });
    await publish(variant.id, baseCalc.id);
    await aQuotedOrder({
      masterVariantId: variant.id,
      priceCalculationId: baseCalc.id,
      quotedBankPaymentPriceMinorUnits: 100_000n,
      quotedAt,
      guaranteeExpiresAt,
    });
    await republish({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 100_050n,
      decision: "needs_approval",
      syncedAt: new Date(quotedAt.getTime() + HOUR_MS),
    });

    const oneMsBefore = await runGuaranteeSweep({
      now: new Date(guaranteeExpiresAt.getTime() - 1),
      resolveEmailPort: fakeEmailPort().resolveEmailPort,
    });
    expect(oneMsBefore.kept).toBe(1);
    expect(oneMsBefore.cancelled).toBe(0);

    const atExpiry = await runGuaranteeSweep({
      now: new Date(guaranteeExpiresAt.getTime()),
      resolveEmailPort: fakeEmailPort().resolveEmailPort,
    });
    expect(atExpiry.cancelled).toBe(1);
  });
});

describe("D21/criterion 82 — an unresolvable price flags rather than cancels", () => {
  it("leaves the order OPEN and raises an admin alert instead of cancelling", async () => {
    const profile = await aPricingProfile();
    const { variant } = await aVariant(profile.id);
    const quotedAt = new Date(Date.now() - 25 * HOUR_MS);
    const guaranteeExpiresAt = new Date(quotedAt.getTime() + DAY_MS);
    const baseCalc = await aComputedCalculation({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 100_000n,
    });
    await publish(variant.id, baseCalc.id);
    const order = await aQuotedOrder({
      masterVariantId: variant.id,
      priceCalculationId: baseCalc.id,
      quotedBankPaymentPriceMinorUnits: 100_000n,
      quotedAt,
      guaranteeExpiresAt,
    });

    await suspendVariantViaSyncFailure(variant.id);

    const { sent, resolveEmailPort } = fakeEmailPort();
    const summary = await runGuaranteeSweep({ now: new Date(), resolveEmailPort });

    expect(summary.flagged).toBe(1);
    expect(summary.cancelled).toBe(0);
    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("open");
    expect(after.cancelledAt).toBeNull();

    // The admin alert goes to the staff recipients, never the customer.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(["staff@caratforus.test"]);
    expect(sent[0]!.text).toContain(order.id);
  });

  /** D22 review, finding 5: a suspended variant can hold an order in `flag` for the full 48h suspension window — the flag alert must dedupe, not repeat every hour. */
  it("DEDUPES: two consecutive sweeps over the same still-flagged order produce exactly one admin notification", async () => {
    const profile = await aPricingProfile();
    const { variant } = await aVariant(profile.id);
    const quotedAt = new Date(Date.now() - 25 * HOUR_MS);
    const guaranteeExpiresAt = new Date(quotedAt.getTime() + DAY_MS);
    const baseCalc = await aComputedCalculation({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 100_000n,
    });
    await publish(variant.id, baseCalc.id);
    await aQuotedOrder({
      masterVariantId: variant.id,
      priceCalculationId: baseCalc.id,
      quotedBankPaymentPriceMinorUnits: 100_000n,
      quotedAt,
      guaranteeExpiresAt,
    });
    await suspendVariantViaSyncFailure(variant.id);

    const { sent, resolveEmailPort } = fakeEmailPort();
    const first = await runGuaranteeSweep({ now: new Date(), resolveEmailPort });
    const second = await runGuaranteeSweep({ now: new Date(), resolveEmailPort });

    expect(first.flagged).toBe(1);
    expect(second.flagged).toBe(1);

    const notifications = await prisma.adminAlertNotification.findMany({
      // Keyed on the failure EPISODE, not the order — an order id outlives
      // every episode, so keying on it lets the unique index permit only one
      // opened/resolved pair for all time and a second flag goes unreported.
      where: { sourceKind: "bank_payment_guarantee", masterVariantId: variant.id },
    });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]!.event).toBe("opened");
    // One email for the first run's "opened" — the second run's flag finds
    // an already-open alert and sends nothing new.
    expect(sent).toHaveLength(1);
  });

  /**
   * THE FLAP. This is the case an order-keyed alert swallows in silence.
   *
   * `admin_alert_notification` is unique on (sourceKind, sourceId, event).
   * Key it on the ORDER id — which outlives every episode — and the order
   * gets exactly one 'opened' and one 'resolved' for all time: suspend,
   * recover, suspend again, and the index quietly refuses the second
   * 'opened'. The order stays flagged and nobody is told, which is worse
   * than the hourly repetition the dedupe replaced, because noise is
   * visible and silence is not.
   *
   * Keying on the failure episode fixes it, because a second suspension is
   * a second episode. That is exactly what this asserts: three alerts, and
   * the third one is a NEW 'opened' under a different sourceId.
   */
  it("alerts AGAIN when a recovered variant is suspended a second time", async () => {
    const profile = await aPricingProfile();
    const { variant } = await aVariant(profile.id);
    const quotedAt = new Date(Date.now() - 25 * HOUR_MS);
    const guaranteeExpiresAt = new Date(quotedAt.getTime() + DAY_MS);
    const baseCalc = await aComputedCalculation({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 100_000n,
    });
    await publish(variant.id, baseCalc.id);
    await aQuotedOrder({
      masterVariantId: variant.id,
      priceCalculationId: baseCalc.id,
      quotedBankPaymentPriceMinorUnits: 100_000n,
      quotedAt,
      guaranteeExpiresAt,
    });

    const { sent, resolveEmailPort } = fakeEmailPort();

    await suspendVariantViaSyncFailure(variant.id);
    expect((await runGuaranteeSweep({ now: new Date(), resolveEmailPort })).flagged).toBe(1);

    await recordSyncSuccess({ masterVariantId: variant.id });
    expect((await runGuaranteeSweep({ now: new Date(), resolveEmailPort })).flagged).toBe(0);

    // Second, independent episode for the same variant.
    await suspendVariantViaSyncFailure(variant.id);
    expect((await runGuaranteeSweep({ now: new Date(), resolveEmailPort })).flagged).toBe(1);

    const notifications = await prisma.adminAlertNotification.findMany({
      where: { sourceKind: "bank_payment_guarantee", masterVariantId: variant.id },
      orderBy: { createdAt: "asc" },
      select: { event: true, sourceId: true },
    });

    expect(notifications.map((n) => n.event)).toEqual(["opened", "resolved", "opened"]);
    // The re-open is a DIFFERENT episode, which is the whole reason it was
    // allowed through the unique index at all.
    expect(notifications[2]!.sourceId).not.toBe(notifications[0]!.sourceId);
    expect(sent).toHaveLength(3);
  });

  it("emits a 'resolved' notification once the unresolvable price clears, distinct from 'opened'", async () => {
    const profile = await aPricingProfile();
    const { variant } = await aVariant(profile.id);
    const quotedAt = new Date(Date.now() - 25 * HOUR_MS);
    const guaranteeExpiresAt = new Date(quotedAt.getTime() + DAY_MS);
    const baseCalc = await aComputedCalculation({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 100_000n,
    });
    await publish(variant.id, baseCalc.id);
    const order = await aQuotedOrder({
      masterVariantId: variant.id,
      priceCalculationId: baseCalc.id,
      quotedBankPaymentPriceMinorUnits: 100_000n,
      quotedAt,
      guaranteeExpiresAt,
    });
    await suspendVariantViaSyncFailure(variant.id);

    const { sent, resolveEmailPort } = fakeEmailPort();
    const first = await runGuaranteeSweep({ now: new Date(), resolveEmailPort });
    expect(first.flagged).toBe(1);

    // The underlying sync issue resolves — the last-synced calculation is
    // unchanged (still the quoted price), so the next sweep sees NO price
    // difference at all once it can evaluate again.
    await recordSyncSuccess({ masterVariantId: variant.id });

    const second = await runGuaranteeSweep({ now: new Date(), resolveEmailPort });
    expect(second.flagged).toBe(0);
    expect(second.kept).toBe(1);
    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("open");

    const notifications = await prisma.adminAlertNotification.findMany({
      // Keyed on the failure EPISODE, not the order — an order id outlives
      // every episode, so keying on it lets the unique index permit only one
      // opened/resolved pair for all time and a second flag goes unreported.
      where: { sourceKind: "bank_payment_guarantee", masterVariantId: variant.id },
      orderBy: { createdAt: "asc" },
    });
    expect(notifications.map((n) => n.event)).toEqual(["opened", "resolved"]);
    // Both notifications go to staff, never the customer.
    expect(sent).toHaveLength(2);
    for (const s of sent) {
      expect(s.to).toEqual(["staff@caratforus.test"]);
    }
  });
});

describe("criterion 101 — idempotent under two overlapping sweep runs", () => {
  it("cancels the order exactly once and sends exactly one customer email", async () => {
    const profile = await aPricingProfile();
    const { variant } = await aVariant(profile.id);
    const quotedAt = new Date(Date.now() - 25 * HOUR_MS);
    const guaranteeExpiresAt = new Date(quotedAt.getTime() + DAY_MS);
    const baseCalc = await aComputedCalculation({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 100_000n,
    });
    await publish(variant.id, baseCalc.id);
    const order = await aQuotedOrder({
      masterVariantId: variant.id,
      priceCalculationId: baseCalc.id,
      quotedBankPaymentPriceMinorUnits: 100_000n,
      quotedAt,
      guaranteeExpiresAt,
    });
    await republish({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 120_000n,
      decision: "needs_approval",
      syncedAt: new Date(quotedAt.getTime() + HOUR_MS),
    });

    const { sent, resolveEmailPort } = fakeEmailPort();
    const now = new Date();

    // Two overlapping runs racing on the same open order.
    const [a, b] = await Promise.all([
      runGuaranteeSweep({ now, resolveEmailPort }),
      runGuaranteeSweep({ now, resolveEmailPort }),
    ]);

    expect(a.cancelled + b.cancelled).toBeGreaterThanOrEqual(1);
    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("cancelled");
    // Exactly one customer email, however many sweep calls raced to get here.
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual([order.customerEmail]);
  });

  it("a THIRD, later run finds nothing left to do", async () => {
    const profile = await aPricingProfile();
    const { variant } = await aVariant(profile.id);
    const quotedAt = new Date(Date.now() - 25 * HOUR_MS);
    const guaranteeExpiresAt = new Date(quotedAt.getTime() + DAY_MS);
    const baseCalc = await aComputedCalculation({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 100_000n,
    });
    await publish(variant.id, baseCalc.id);
    await aQuotedOrder({
      masterVariantId: variant.id,
      priceCalculationId: baseCalc.id,
      quotedBankPaymentPriceMinorUnits: 100_000n,
      quotedAt,
      guaranteeExpiresAt,
    });
    await republish({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 120_000n,
      decision: "needs_approval",
      syncedAt: new Date(quotedAt.getTime() + HOUR_MS),
    });

    const { sent, resolveEmailPort } = fakeEmailPort();
    await runGuaranteeSweep({ now: new Date(), resolveEmailPort });
    const second = await runGuaranteeSweep({ now: new Date(), resolveEmailPort });

    // The order already left "open" after the first run, so the second run's
    // query never even selects it — the strongest form of "does nothing".
    expect(second.ordersConsidered).toBe(0);
    expect(sent).toHaveLength(1);
  });
});

describe("criterion 102 — one order failing must not abort the sweep", () => {
  it("leaves the failing order untouched, alerts admin, and still processes every other order", async () => {
    const profile = await aPricingProfile();

    const { variant: failingVariant } = await aVariant(profile.id);
    const failingCalc = await aComputedCalculation({
      masterVariantId: failingVariant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 100_000n,
    });
    await publish(failingVariant.id, failingCalc.id);
    const quotedAt = new Date(Date.now() - 25 * HOUR_MS);
    const guaranteeExpiresAt = new Date(quotedAt.getTime() + DAY_MS);
    const failingOrder = await aQuotedOrder({
      masterVariantId: failingVariant.id,
      priceCalculationId: failingCalc.id,
      quotedBankPaymentPriceMinorUnits: 100_000n,
      quotedAt,
      guaranteeExpiresAt,
    });

    // A second, healthy order that should cancel normally in the SAME sweep run.
    const { variant: healthyVariant } = await aVariant(profile.id);
    const healthyCalc = await aComputedCalculation({
      masterVariantId: healthyVariant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 50_000n,
    });
    await publish(healthyVariant.id, healthyCalc.id);
    const healthyOrder = await aQuotedOrder({
      masterVariantId: healthyVariant.id,
      priceCalculationId: healthyCalc.id,
      quotedBankPaymentPriceMinorUnits: 50_000n,
      quotedAt,
      guaranteeExpiresAt,
    });
    await republish({
      masterVariantId: healthyVariant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 55_000n,
      decision: "needs_approval",
      syncedAt: new Date(quotedAt.getTime() + HOUR_MS),
    });

    // A wrapper that throws ONLY for the failing order's variant, delegating
    // to the REAL fact-gatherer for everything else — exercises the actual
    // per-order try/catch in `runGuaranteeSweep`, not a stand-in for it.
    const throwingGatherFacts: typeof gatherVariantPriceFacts = async (masterVariantId, orderQuotedAt) => {
      if (masterVariantId === failingVariant.id) {
        throw new Error("simulated fact-gathering failure");
      }
      return gatherVariantPriceFacts(masterVariantId, orderQuotedAt);
    };

    const { sent, resolveEmailPort } = fakeEmailPort();
    const summary = await runGuaranteeSweep({
      now: new Date(),
      resolveEmailPort,
      gatherVariantPriceFacts: throwingGatherFacts,
    });

    expect(summary.ordersConsidered).toBe(2);
    expect(summary.errored).toBe(1);
    expect(summary.cancelled).toBe(1);

    const failingAfter = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: failingOrder.id } });
    expect(failingAfter.status).toBe("open");
    expect(failingAfter.cancelledAt).toBeNull();

    const healthyAfter = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: healthyOrder.id } });
    expect(healthyAfter.status).toBe("cancelled");

    // One admin alert for the failure, one customer email for the healthy cancellation.
    expect(sent).toHaveLength(2);
    const toAddresses = sent.map((s) => s.to);
    expect(toAddresses).toContainEqual(["staff@caratforus.test"]);
    expect(toAddresses).toContainEqual([healthyOrder.customerEmail]);
  });
});

describe("the cancellation stands even when the notification cannot be delivered", () => {
  it("cancels the order and raises an admin alert when the email channel is unconfigured", async () => {
    const profile = await aPricingProfile();
    const { variant } = await aVariant(profile.id);
    const quotedAt = new Date(Date.now() - 25 * HOUR_MS);
    const guaranteeExpiresAt = new Date(quotedAt.getTime() + DAY_MS);
    const baseCalc = await aComputedCalculation({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 100_000n,
    });
    await publish(variant.id, baseCalc.id);
    const order = await aQuotedOrder({
      masterVariantId: variant.id,
      priceCalculationId: baseCalc.id,
      quotedBankPaymentPriceMinorUnits: 100_000n,
      quotedAt,
      guaranteeExpiresAt,
    });
    await republish({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 130_000n,
      decision: "needs_approval",
      syncedAt: new Date(quotedAt.getTime() + HOUR_MS),
    });

    const summary = await runGuaranteeSweep({ now: new Date(), resolveEmailPort: unconfiguredEmailPort() });

    expect(summary.cancelled).toBe(1);
    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    // The cancellation itself is unaffected by the mail server being down.
    expect(after.status).toBe("cancelled");
    // The outcome is PERSISTED, not just logged — "which cancelled orders
    // never reached their customer" must be a queryable question.
    expect(after.cancellationEmailStatus).toBe("skipped_unconfigured");
    expect(after.cancellationEmailProviderMessageId).toBeNull();
    expect(after.cancellationEmailAttemptedAt).not.toBeNull();
  });

  it("cancels the order and raises an admin alert when the send itself fails", async () => {
    const profile = await aPricingProfile();
    const { variant } = await aVariant(profile.id);
    const quotedAt = new Date(Date.now() - 25 * HOUR_MS);
    const guaranteeExpiresAt = new Date(quotedAt.getTime() + DAY_MS);
    const baseCalc = await aComputedCalculation({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 100_000n,
    });
    await publish(variant.id, baseCalc.id);
    const order = await aQuotedOrder({
      masterVariantId: variant.id,
      priceCalculationId: baseCalc.id,
      quotedBankPaymentPriceMinorUnits: 100_000n,
      quotedAt,
      guaranteeExpiresAt,
    });
    await republish({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 130_000n,
      decision: "needs_approval",
      syncedAt: new Date(quotedAt.getTime() + HOUR_MS),
    });

    const { resolveEmailPort } = fakeEmailPort({ failEveryCall: true });
    const summary = await runGuaranteeSweep({ now: new Date(), resolveEmailPort });

    expect(summary.cancelled).toBe(1);
    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("cancelled");
    expect(after.cancellationEmailStatus).toBe("failed");
    expect(after.cancellationEmailProviderMessageId).toBeNull();
    expect(after.cancellationEmailAttemptedAt).not.toBeNull();
  });

  it("PERSISTENCE ITSELF throwing does not reverse the cancellation, even though the send succeeded", async () => {
    const profile = await aPricingProfile();
    const { variant } = await aVariant(profile.id);
    const quotedAt = new Date(Date.now() - 25 * HOUR_MS);
    const guaranteeExpiresAt = new Date(quotedAt.getTime() + DAY_MS);
    const baseCalc = await aComputedCalculation({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 100_000n,
    });
    await publish(variant.id, baseCalc.id);
    const order = await aQuotedOrder({
      masterVariantId: variant.id,
      priceCalculationId: baseCalc.id,
      quotedBankPaymentPriceMinorUnits: 100_000n,
      quotedAt,
      guaranteeExpiresAt,
    });
    await republish({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 130_000n,
      decision: "needs_approval",
      syncedAt: new Date(quotedAt.getTime() + HOUR_MS),
    });

    const { sent, resolveEmailPort } = fakeEmailPort();
    // A throwing write, standing in for a genuine DB hiccup AFTER the
    // compare-and-set has already committed the cancellation and the email
    // has already been sent — exactly the ordering the module doc comment
    // requires never to roll the cancellation back.
    const throwingRecordCancellationEmail = async (): Promise<void> => {
      throw new Error("simulated write failure recording the cancellation email outcome");
    };

    const summary = await runGuaranteeSweep({
      now: new Date(),
      resolveEmailPort,
      recordCancellationEmailOutcome: throwingRecordCancellationEmail,
    });

    expect(summary.cancelled).toBe(1);
    // The email was sent — this failure is purely in RECORDING that fact.
    expect(sent).toHaveLength(1);

    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    // The cancellation stands, unconditionally.
    expect(after.status).toBe("cancelled");
    expect(after.cancelledAt).not.toBeNull();
    // The delivery record simply never got written — a real, if unwelcome,
    // state (see the migration's own CHECK-constraint comment), not an
    // error this function may correct by inventing a value.
    expect(after.cancellationEmailStatus).toBeNull();
    expect(after.cancellationEmailProviderMessageId).toBeNull();
    expect(after.cancellationEmailAttemptedAt).toBeNull();
  });

  it("a SECOND sweep does not re-cancel, re-email, or re-persist an already-cancelled order", async () => {
    const profile = await aPricingProfile();
    const { variant } = await aVariant(profile.id);
    const quotedAt = new Date(Date.now() - 25 * HOUR_MS);
    const guaranteeExpiresAt = new Date(quotedAt.getTime() + DAY_MS);
    const baseCalc = await aComputedCalculation({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 100_000n,
    });
    await publish(variant.id, baseCalc.id);
    const order = await aQuotedOrder({
      masterVariantId: variant.id,
      priceCalculationId: baseCalc.id,
      quotedBankPaymentPriceMinorUnits: 100_000n,
      quotedAt,
      guaranteeExpiresAt,
    });
    await republish({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 130_000n,
      decision: "needs_approval",
      syncedAt: new Date(quotedAt.getTime() + HOUR_MS),
    });

    const { sent, resolveEmailPort } = fakeEmailPort();
    const first = await runGuaranteeSweep({ now: new Date(), resolveEmailPort });
    expect(first.cancelled).toBe(1);
    const afterFirst = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(afterFirst.cancellationEmailStatus).toBe("sent");
    const firstAttemptedAt = afterFirst.cancellationEmailAttemptedAt;

    const second = await runGuaranteeSweep({ now: new Date(), resolveEmailPort });
    // The order left the `status: "open"` set the sweep queries, so a
    // second run does not even see it — the strongest form of "does nothing".
    expect(second.ordersConsidered).toBe(0);

    const afterSecond = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(afterSecond.status).toBe("cancelled");
    expect(afterSecond.cancellationEmailStatus).toBe("sent");
    expect(afterSecond.cancellationEmailAttemptedAt).toEqual(firstAttemptedAt);
    // Exactly one customer email, ever.
    expect(sent).toHaveLength(1);
  });
});

describe("§22 / payment already verified — the guarantee never cancels a paid order", () => {
  it("keeps an order whose payment was verified before the sweep ran, even with a human-approved price change", async () => {
    const profile = await aPricingProfile();
    const { variant } = await aVariant(profile.id);
    const quotedAt = new Date(Date.now() - 25 * HOUR_MS);
    const guaranteeExpiresAt = new Date(quotedAt.getTime() + DAY_MS);
    const baseCalc = await aComputedCalculation({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 100_000n,
    });
    await publish(variant.id, baseCalc.id);
    const order = await aQuotedOrder({
      masterVariantId: variant.id,
      priceCalculationId: baseCalc.id,
      quotedBankPaymentPriceMinorUnits: 100_000n,
      quotedAt,
      guaranteeExpiresAt,
    });
    await prisma.bankPaymentOrder.update({
      where: { id: order.id },
      data: {
        verifiedPaymentAmountMinorUnits: 100_000n,
        verifiedPaymentCurrency: "USD",
        verifiedPaymentMethod: "zelle",
        verifiedAt: new Date(),
        // D23: verified_by is now the authenticated Shopify staff identity
        // (user id + email), not a typed name.
        verifiedByShopifyUserId: 1n,
        verifiedByEmail: "integration-test@example.com",
      },
    });
    await republish({
      masterVariantId: variant.id,
      profileId: profile.id,
      bankPaymentPriceMinorUnits: 140_000n,
      decision: "needs_approval",
      syncedAt: new Date(quotedAt.getTime() + HOUR_MS),
    });

    const { sent, resolveEmailPort } = fakeEmailPort();
    const summary = await runGuaranteeSweep({ now: new Date(), resolveEmailPort });

    expect(summary.kept).toBe(1);
    const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: order.id } });
    expect(after.status).toBe("open");
    expect(sent).toHaveLength(0);
  });
});
