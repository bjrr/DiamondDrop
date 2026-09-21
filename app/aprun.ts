/**
 * Runs the REAL recalculation pipeline, scoped to the auto-publish fixture
 * variant, and reports what the engine computed plus the decision it reached.
 *
 * Auto-publish state is whatever the environment says — this script never
 * forces it, so the same script is used for the OFF baseline and the ON tests
 * and the only variable is the flag.
 */
import { PrismaClient } from "@prisma/client";

import { runPriceRecalculation } from "./app/jobs/pricing/runRecalculation.server";
import {
  createProductionMetafieldPublishDeps,
  createProductionPriceSyncPort,
} from "./app/shopify/admin/productionPriceSyncPort.server";

const prisma = new PrismaClient();
const VARIANT_ID = process.env.AP_VARIANT_ID!;

const before = await prisma.masterVariant.findUnique({
  where: { id: VARIANT_ID },
  include: { lastSyncedPriceCalculation: true },
});
console.log("--- before ---");
console.log(
  "  published bank:",
  before?.lastSyncedPriceCalculation?.bankPaymentPriceMinorUnits?.toString() ?? "(none)"
);
console.log("  AUTO_PUBLISH env:", process.env.PRICE_AUTO_PUBLISH_ENABLED ?? "(unset)");

const autoPublishEnabled = process.env.PRICE_AUTO_PUBLISH_ENABLED === "true";
// Build the REAL production port exactly as the cron route does, so this
// harness exercises the same path production takes rather than a stand-in.
const syncPort = autoPublishEnabled ? await createProductionPriceSyncPort() : undefined;
const metafields = autoPublishEnabled ? await createProductionMetafieldPublishDeps() : undefined;

const result = await runPriceRecalculation({
  asOf: new Date(),
  variantIds: [VARIANT_ID],
  autoPublishEnabled,
  syncPort,
  metafields,
});

console.log("\n--- run result ---");
console.log(JSON.stringify(result, null, 1));

const calcs = await prisma.priceCalculation.findMany({
  where: { masterVariantId: VARIANT_ID },
  orderBy: { createdAt: "desc" },
  take: 2,
  select: { id: true, bankPaymentPriceMinorUnits: true, status: true, failureReason: true },
});
console.log("\n--- latest calculations ---");
for (const c of calcs) {
  console.log(
    "  ",
    c.id.slice(0, 8),
    "bank",
    c.bankPaymentPriceMinorUnits.toString(),
    c.status,
    c.failureReason ?? ""
  );
}

const intents = await prisma.priceSyncIntent.findMany({
  where: { masterVariantId: VARIANT_ID },
  orderBy: { createdAt: "desc" },
  take: 3,
  select: { id: true, decision: true, status: true, deltaBps: true, syncedAt: true },
});
console.log("\n--- sync intents ---");
for (const i of intents) {
  console.log(
    "  ",
    i.id.slice(0, 8),
    "decision:",
    i.decision,
    "status:",
    i.status,
    "delta_bps:",
    i.deltaBps ?? "-",
    "syncedAt:",
    i.syncedAt?.toISOString().slice(11, 19) ?? "-"
  );
}

const after = await prisma.masterVariant.findUnique({
  where: { id: VARIANT_ID },
  include: { lastSyncedPriceCalculation: true },
});
console.log(
  "\n--- after: published bank:",
  after?.lastSyncedPriceCalculation?.bankPaymentPriceMinorUnits?.toString() ?? "(none)"
);

await prisma.$disconnect();
