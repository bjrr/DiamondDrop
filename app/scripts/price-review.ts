/**
 * Price review CLI (spec §9.5). Run with `npm run price-review -- <verb>`.
 *
 * A DELIBERATE SLICE-1 STOPGAP. Slice 1 ships no admin UI, but a price change
 * still has to be reviewable by a human before it reaches a customer, so this
 * exists to make the slice operable. It is superseded by the admin UI in a
 * later slice — do not build features onto it.
 *
 *   list
 *   approve --intent <id> --actor <staff-id> [--reason <text>]
 *   reject  --intent <id> --actor <staff-id> --reason <text>
 *   verify  --calculation <id>
 *
 * `--actor` is mandatory on approve and reject. There is no anonymous
 * approval: an unattributable sign-off on a price change is not a sign-off.
 *
 * TypeScript rather than plain .mjs so it can import the real modules. The
 * previous .mjs version reached for `../build/server/index.js` and printed
 * "requires the server bundle" while exiting 0 — an operator surface that
 * reported success while doing nothing.
 */
import "dotenv/config";

import { prisma } from "~/db/client.server";
import { decideIntent } from "~/jobs/pricing/intentTransitions.server";
import { verifyPriceCalculation } from "~/jobs/pricing/verify.server";

function arg(name: string): string | undefined {
  const index = process.argv.indexOf(`--${name}`);
  return index === -1 ? undefined : process.argv[index + 1];
}

function fail(message: string): void {
  console.error(`error: ${message}`);
  process.exitCode = 1;
}

/**
 * Display only, and kept as string arithmetic on purpose: a money value must
 * not round-trip through a float even for printing.
 */
function formatMinorUnits(minorUnits: bigint | number, currency: string): string {
  const raw = String(minorUnits);
  const negative = raw.startsWith("-");
  const digits = (negative ? raw.slice(1) : raw).padStart(3, "0");
  return `${negative ? "-" : ""}${digits.slice(0, -2)}.${digits.slice(-2)} ${currency}`;
}

async function list(): Promise<void> {
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
    const placeholder = calc.pricingProfile.isPlaceholder
      ? "  [PLACEHOLDER PROFILE — cannot approve]"
      : "";
    console.log(`intent   ${intent.id}${placeholder}`);
    console.log(
      `  product  ${intent.masterVariant.masterProduct.name} (${intent.masterVariant.metal}/${intent.masterVariant.purity})`
    );
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

async function decide(status: "approved" | "rejected"): Promise<void> {
  const intentId = arg("intent");
  const actor = arg("actor");
  const reason = arg("reason");

  if (!intentId) return fail("--intent <id> is required");
  if (status === "rejected" && !reason) return fail("--reason <text> is required when rejecting");

  // The actor requirement, the allowed-transition check, the D14 placeholder
  // guard and the audit event all live in decideIntent. This CLI previously
  // carried its own inline transaction holding only some of them, which is how
  // a second approve path came to exist without the guard.
  await decideIntent({ intentId, status, actor: actor ?? "", reason });
  console.log(`intent ${intentId} ${status} by ${actor}.`);
}

async function verify(): Promise<void> {
  const calculationId = arg("calculation");
  if (!calculationId) return fail("--calculation <id> is required");
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
