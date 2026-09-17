#!/usr/bin/env node
/**
 * Price review CLI (spec §9.5).
 *
 * A DELIBERATE SLICE-1 STOPGAP. Slice 1 ships no admin UI, but a price change
 * still has to be reviewable by a human before it reaches a customer, so this
 * exists to make the slice operable. It is superseded by the admin UI in a
 * later slice — do not build features onto it.
 *
 * Verbs:
 *   list
 *   approve --intent <id> --actor <staff-id> [--reason <text>]
 *   reject  --intent <id> --actor <staff-id> --reason <text>
 *   verify  --calculation <id>
 *
 * `--actor` is mandatory on approve and reject. There is no anonymous
 * approval: an unattributable sign-off on a price change is not a sign-off.
 */
import "dotenv/config";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message) {
  console.error(`error: ${message}`);
  process.exitCode = 1;
}

function formatMinorUnits(minorUnits, currency) {
  // Display only. Kept as string arithmetic on purpose: this is a money value
  // and must not round-trip through a float even for printing.
  const s = String(minorUnits);
  const negative = s.startsWith("-");
  const digits = (negative ? s.slice(1) : s).padStart(3, "0");
  const major = digits.slice(0, -2);
  const minor = digits.slice(-2);
  return `${negative ? "-" : ""}${major}.${minor} ${currency}`;
}

async function list() {
  const intents = await prisma.priceSyncIntent.findMany({
    where: { status: "pending_approval" },
    orderBy: { createdAt: "asc" },
    include: {
      priceCalculation: { include: { pricingProfile: true } },
      masterVariant: { include: { masterProduct: true } },
    },
  });

  if (intents.length === 0) {
    console.log("No intents are awaiting approval.");
    return;
  }

  console.log(`${intents.length} intent(s) awaiting approval:\n`);
  for (const intent of intents) {
    const calc = intent.priceCalculation;
    const placeholder = calc.pricingProfile.isPlaceholder ? "  [PLACEHOLDER PROFILE — cannot approve]" : "";
    console.log(`intent   ${intent.id}${placeholder}`);
    console.log(`  product  ${intent.masterVariant.masterProduct.name} (${intent.masterVariant.metal}/${intent.masterVariant.purity})`);
    console.log(`  variant  ${intent.masterVariantId}`);
    console.log(
      `  old      ${
        intent.previousPriceMinorUnits === null
          ? "(none — first price)"
          : formatMinorUnits(intent.previousPriceMinorUnits, intent.previousPriceCurrency ?? "")
      }`
    );
    console.log(`  new      ${formatMinorUnits(calc.computedPriceMinorUnits, calc.currency)}`);
    console.log(`  delta    ${intent.deltaBps === null ? "n/a" : `${intent.deltaBps} bps`}`);
    console.log(`  reason   ${intent.reason ?? ""}\n`);
  }
}

async function decide(status) {
  const intentId = arg("intent");
  const actor = arg("actor");
  const reason = arg("reason");

  if (!intentId) return fail("--intent <id> is required");
  if (!actor || actor.trim() === "") return fail("--actor <staff-id> is required — there is no anonymous approval");
  if (status === "rejected" && !reason) return fail("--reason <text> is required when rejecting");

  const intent = await prisma.priceSyncIntent.findUnique({
    where: { id: intentId },
    include: { priceCalculation: { include: { pricingProfile: true } } },
  });
  if (!intent) return fail(`no intent with id ${intentId}`);

  if (intent.status !== "pending_approval") {
    return fail(`intent ${intentId} is ${intent.status}, not pending_approval`);
  }

  // THE GUARD THAT MATTERS WHILE D14 IS OPEN. The seeded profile carries
  // deliberately absurd placeholder margins; approving a price computed from
  // one would put an invented number in front of a customer. Rejection is
  // allowed — clearing a bad intent out of the queue is always safe.
  if (status === "approved" && intent.priceCalculation.pricingProfile.isPlaceholder) {
    return fail(
      `intent ${intentId} was computed from a PLACEHOLDER pricing profile ` +
        `(${intent.priceCalculation.pricingProfile.code} v${intent.priceCalculation.pricingProfile.version}). ` +
        "Owner decision D14 (target/minimum margin, minimum dollar profit, tolerance) is unresolved. " +
        "Seed a real profile before approving any price."
    );
  }

  await prisma.$transaction(async (tx) => {
    await tx.priceSyncIntent.update({
      where: { id: intentId },
      data: { status, decidedBy: actor, decidedAt: new Date(), reason: reason ?? null },
    });
    await tx.auditEvent.create({
      data: {
        actorType: "staff",
        actorRef: actor,
        action: `price_sync_intent.${status}`,
        entityType: "price_sync_intent",
        entityId: intentId,
        reason: reason ?? `Intent ${status} by ${actor}`,
      },
    });
  });

  console.log(`intent ${intentId} ${status} by ${actor}.`);
}

async function verify() {
  const calculationId = arg("calculation");
  if (!calculationId) return fail("--calculation <id> is required");

  const { verifyPriceCalculation } = await import("../build/server/index.js")
    .then((m) => m)
    .catch(() => ({}));

  if (typeof verifyPriceCalculation !== "function") {
    console.log(
      "verify requires the server bundle. Run `npm run build`, or call " +
        "verifyPriceCalculation() from app/jobs/pricing/verify.server.ts directly."
    );
    return;
  }

  console.log(JSON.stringify(await verifyPriceCalculation(calculationId), null, 2));
}

const verb = process.argv[2];
const run =
  verb === "list"
    ? list
    : verb === "approve"
      ? () => decide("approved")
      : verb === "reject"
        ? () => decide("rejected")
        : verb === "verify"
          ? verify
          : null;

if (!run) {
  console.log("usage: price-review <list|approve|reject|verify> [options]");
  process.exitCode = 1;
} else {
  run()
    .catch((error) => fail(error instanceof Error ? error.message : String(error)))
    .finally(() => prisma.$disconnect());
}
