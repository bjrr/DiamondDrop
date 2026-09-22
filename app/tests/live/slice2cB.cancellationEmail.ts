/**
 * SLICE 2C-b LIVE GATE — the cancellation email, end to end through Resend.
 *
 * Touches NO Shopify surface: the guarantee sweep is purely database plus
 * email, so this harness creates nothing on caratforus-dev's store. It does
 * send REAL email, to the owner's own verified inbox.
 *
 * Every fixture it creates is left in a terminal, inert state (cancelled
 * orders, archived variants); the append-only quote lines and calculations
 * cannot be removed and are expected to remain.
 */
import { randomUUID } from "node:crypto";

import { prisma } from "~/db/client.server";
import { PINNED } from "~/domain/bankpayment/guaranteeCancellationEmail";
import { runGuaranteeSweep } from "~/jobs/bankpayment/guaranteeSweep.server";
import { resolveEmailPort } from "~/lib/email/configuredPort.server";

const OWNER_INBOX = "orders@caratforus.com";

let pass = 0;
let fail = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
};

const createdMasterProductIds: string[] = [];
const createdOrderIds: string[] = [];

let fixtureSequence = 0;

const QUOTED = 100_000n; // $1,000.00
const REPRICED = 110_000n; // $1,100.00 — a human-approved rise

/**
 * A bank order past its guarantee whose price moved through a HUMAN-APPROVED
 * publication — the one shape D22 cancels on.
 */
async function anOrderDueForCancellation(customerEmail: string) {
  // A plain counter, not Math.random/Math.floor — the money-safety scan
  // bans those outright rather than trying to tell money rounding from
  // fixture noise, and a counter is more deterministic anyway.
  const suffix = `${Date.now() % 900_000}-${(fixtureSequence += 1)}`;
  const profile = await prisma.pricingProfile.findFirstOrThrow({
    where: { code: "buy_now", isPlaceholder: false },
    orderBy: { version: "desc" },
  });
  const product = await prisma.masterProduct.create({
    data: {
      name: `2cb livegate ${suffix}`,
      category: "ring",
      sizeAxis: "none",
      allowedSizeMin: "0",
      allowedSizeMax: "0",
      sizeIncrement: "1",
      baseSize: "0",
      offeredMetals: ["gold"],
      status: "active",
      shopifyProductGid: `gid://shopify/Product/2cb-${suffix}`,
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
      shopifyVariantGid: `gid://shopify/ProductVariant/2cb-${suffix}`,
      bankPaymentDiscountEligible: true,
    },
  });

  const makeCalc = async (bank: bigint) => {
    const snapshot = await prisma.snapshot.create({
      data: { kind: "pricing.livegate2cb", payload: {}, contentHash: `2cb-${randomUUID()}` },
    });
    return prisma.priceCalculation.create({
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
        landedCostMinorUnits: 40_000n,
        bankPaymentPriceMinorUnits: bank,
        currency: "USD",
        status: "computed",
      },
    });
  };

  const quotedCalc = await makeCalc(QUOTED);
  const quotedAt = new Date(Date.now() - 25 * 60 * 60 * 1000);
  const order = await prisma.bankPaymentOrder.create({
    data: {
      shopifyDraftOrderGid: `gid://shopify/DraftOrder/2cb-${suffix}`,
      customerEmail,
      status: "open",
      quotedAt,
      guaranteeExpiresAt: new Date(quotedAt.getTime() + 24 * 60 * 60 * 1000),
      lines: {
        create: [
          {
            masterVariantId: variant.id,
            priceCalculationId: quotedCalc.id,
            quantity: 1,
            quotedBankPaymentPriceMinorUnits: QUOTED,
            quotedRegularCardPriceMinorUnits: 105_000n,
            currency: "USD",
            eligibleAtQuoteTime: true,
          },
        ],
      },
    },
  });
  createdOrderIds.push(order.id);

  // The price moves, and a HUMAN approves the publication — the historical
  // fact D22 turns on.
  const repricedCalc = await makeCalc(REPRICED);
  await prisma.masterVariant.update({
    where: { id: variant.id },
    data: { lastSyncedPriceCalculationId: repricedCalc.id },
  });
  await prisma.priceSyncIntent.create({
    data: {
      masterVariantId: variant.id,
      priceCalculationId: repricedCalc.id,
      decision: "needs_approval",
      status: "synced",
      decidedBy: "livegate-admin",
      decidedAt: new Date(quotedAt.getTime() + 60_000),
      syncedAt: new Date(quotedAt.getTime() + 120_000),
      shopifyVariantGid: variant.shopifyVariantGid,
    },
  });

  return { order, variant };
}

async function main() {
  console.log("\n=== configuration ===");
  const resolution = resolveEmailPort();
  if (!resolution.configured) {
    throw new Error(`email channel not configured: ${resolution.reason}`);
  }
  check("Resend channel is configured", true, `from ${resolution.from} -> staff ${resolution.recipients.join(", ")}`);

  // ---------------------------------------------------------------- happy
  console.log("\n=== 1. cancellation + a real Resend send ===");
  const { order: goodOrder } = await anOrderDueForCancellation(OWNER_INBOX);
  const first = await runGuaranteeSweep({ now: new Date() });
  console.log("  sweep:", JSON.stringify(first));
  check("the order was cancelled", first.cancelled >= 1);

  const cancelled = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: goodOrder.id } });
  check("status is cancelled with a reason", cancelled.status === "cancelled" && !!cancelled.cancellationReason);
  console.log("  reason:", cancelled.cancellationReason);
  check(
    "Resend ACCEPTED the customer email",
    cancelled.cancellationEmailStatus === "sent",
    String(cancelled.cancellationEmailStatus)
  );
  check(
    "the provider message id is recorded",
    typeof cancelled.cancellationEmailProviderMessageId === "string" &&
      cancelled.cancellationEmailProviderMessageId.length > 0,
    cancelled.cancellationEmailProviderMessageId ?? "(null)"
  );
  check("the attempt timestamp is recorded", cancelled.cancellationEmailAttemptedAt !== null);

  console.log("\n  THE EXACT COPY SENT (check the inbox against this):");
  console.log("  subject:", PINNED.subject);
  console.log(
    "  body   :\n" +
      PINNED.body(goodOrder.id)
        .split("\n")
        .map((l) => `    ${l}`)
        .join("\n")
  );

  // ------------------------------------------------------------- failure
  console.log("\n=== 2. a delivery failure must NOT reverse the cancellation ===");
  // A genuinely invalid recipient, rejected by Resend itself rather than by a
  // mock — the point is to exercise the real provider's failure path.
  const { order: badOrder } = await anOrderDueForCancellation("not-a-valid-address");
  const second = await runGuaranteeSweep({ now: new Date() });
  console.log("  sweep:", JSON.stringify(second));

  const failedOrder = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: badOrder.id } });
  check(
    "the cancellation STANDS despite the delivery failure",
    failedOrder.status === "cancelled" && !!failedOrder.cancelledAt,
    failedOrder.status
  );
  check(
    "the failure is persisted, not just logged",
    failedOrder.cancellationEmailStatus === "failed",
    String(failedOrder.cancellationEmailStatus)
  );
  check(
    "no provider message id is claimed for a failed send",
    failedOrder.cancellationEmailProviderMessageId === null
  );
  check(
    "the persistent record is queryable by an admin",
    (await prisma.bankPaymentOrder.count({
      where: { status: "cancelled", cancellationEmailStatus: { not: "sent" } },
    })) >= 1
  );

  // --------------------------------------------------------------- retry
  console.log("\n=== 3. a retry must not duplicate anything ===");
  const before = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: goodOrder.id } });
  const third = await runGuaranteeSweep({ now: new Date() });
  console.log("  sweep:", JSON.stringify(third));
  const after = await prisma.bankPaymentOrder.findUniqueOrThrow({ where: { id: goodOrder.id } });

  check("the re-run considered no open orders", third.ordersConsidered === 0, String(third.ordersConsidered));
  check("nothing was cancelled a second time", third.cancelled === 0);
  check(
    "the recorded delivery is byte-identical to the first run",
    after.cancellationEmailProviderMessageId === before.cancellationEmailProviderMessageId &&
      after.cancellationEmailAttemptedAt?.getTime() === before.cancellationEmailAttemptedAt?.getTime(),
    after.cancellationEmailProviderMessageId ?? "(null)"
  );

  console.log(`\n=== RESULT: ${pass} passed, ${fail} failed ===`);
}

async function cleanup() {
  console.log("\n=== CLEANUP ===");
  // Orders are already cancelled by the sweep; archive the fixture variants so
  // nothing live points at synthetic Shopify ids. Quote lines and price
  // calculations are append-only and remain, as expected.
  for (const id of createdMasterProductIds) {
    await prisma.masterVariant.updateMany({
      where: { masterProductId: id },
      data: { status: "archived", lastSyncedPriceCalculationId: null },
    });
    await prisma.masterProduct.update({ where: { id }, data: { status: "archived" } });
  }
  const stillOpen = await prisma.bankPaymentOrder.count({ where: { id: { in: createdOrderIds }, status: "open" } });
  if (stillOpen > 0) {
    await prisma.bankPaymentOrder.updateMany({
      where: { id: { in: createdOrderIds }, status: "open" },
      data: {
        status: "cancelled",
        cancelledAt: new Date(),
        cancellationReason: "2C-b live gate fixture, cancelled during teardown",
      },
    });
  }
  console.log(`  ${createdMasterProductIds.length} fixture product(s) archived; ${stillOpen} order(s) closed in teardown`);
}

main()
  .catch((e) => {
    fail += 1;
    console.error("\nABORTED:", (e as Error).message);
  })
  .finally(async () => {
    await cleanup().catch((e) => console.error("cleanup error:", e));
    await prisma.$disconnect();
    console.log(`\nFINAL: ${pass} passed, ${fail} failed`);
    process.exit(fail > 0 ? 1 : 0);
  });
