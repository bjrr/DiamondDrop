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
 *   override --variant <id> --price <minor-units> --actor <staff-id>
 *            --reason <text> [--calculation <id>] [--confirm-breach]
 *   revoke   --variant <id> --actor <staff-id> --reason <text>
 *
 * `--actor` is mandatory on approve, reject and override. There is no anonymous
 * approval: an unattributable sign-off on a price change is not a sign-off.
 *
 * `override` is D14's manual owner override. Run WITHOUT --confirm-breach it
 * previews: it prints what floors the price would breach and writes nothing.
 * That is the default on purpose — the warning has to be seen before it can be
 * acknowledged, and a flag that defaults to "proceed" is not a confirmation.
 *
 * TypeScript rather than plain .mjs so it can import the real modules. The
 * previous .mjs version reached for `../build/server/index.js` and printed
 * "requires the server bundle" while exiting 0 — an operator surface that
 * reported success while doing nothing.
 */
import "dotenv/config";

import { prisma } from "~/db/client.server";
import { MoneyDecimal } from "~/domain/money/decimal";
import { decideIntent } from "~/jobs/pricing/intentTransitions.server";
import {
  applyPriceOverride,
  previewPriceOverride,
  resolveActiveOverride,
  revokePriceOverride,
} from "~/jobs/pricing/priceOverride.server";
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
    // Labelled "bank" on both sides because the auto-apply delta is measured
    // bank-to-bank. An unqualified "old/new" leaves an operator to assume these
    // are the prices a customer sees, which they are not — the advertised price
    // is the Regular/Card Price derived from the new one.
    console.log(
      `  old bank ${
        intent.previousBankPaymentPriceMinorUnits === null
          ? "(none — first price)"
          : formatMinorUnits(intent.previousBankPaymentPriceMinorUnits, intent.previousBankPaymentPriceCurrency ?? "")
      }`
    );
    console.log(`  new bank ${formatMinorUnits(calc.bankPaymentPriceMinorUnits, calc.currency)}`);
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

/**
 * D14 manual override. Two-step by construction: the first invocation shows the
 * warning and refuses, the second carries --confirm-breach.
 */
async function override(): Promise<void> {
  const masterVariantId = arg("variant");
  const price = arg("price");
  const actor = arg("actor");
  const reason = arg("reason");

  if (!masterVariantId) return fail("--variant <id> is required");
  if (!price) return fail("--price <minor-units> is required");
  if (!actor) return fail("--actor <staff-id> is required");
  if (!reason) return fail("--reason <text> is required (D14)");

  if (!/^[0-9]+$/.test(price)) {
    // Parsed as a bigint from an exact digit string. A price typed as "349.00"
    // would need a decimal conversion here, and that conversion is exactly the
    // kind of ad-hoc money handling the slice keeps out of operator scripts.
    return fail("--price must be whole MINOR units (e.g. 34900 for $349.00)");
  }

  const request = {
    masterVariantId,
    priceCalculationId: arg("calculation"),
    overrideBankPaymentPriceMinorUnits: BigInt(price),
    currency: arg("currency") ?? "USD",
    reason,
    overriddenBy: actor,
    confirmBreach: process.argv.includes("--confirm-breach"),
  };

  const active = await resolveActiveOverride(masterVariantId);
  if (active) {
    // Shown because "override" after an existing override REPLACES it, and an
    // operator who does not know one is in force cannot judge whether that is
    // what they meant.
    console.log(
      `currently in effect: ${formatMinorUnits(active.overrideBankPaymentPriceMinorUnits ?? 0n, active.currency)} ` +
        `(set by ${active.overriddenBy}: ${active.reason}) — this will supersede it`
    );
  }

  const preview = await previewPriceOverride(request);

  // BOTH PRICES, because an operator typing a bank price is also setting the
  // advertised card price, and reviewing one without the other means approving
  // half the decision.
  console.log(`calculation:        ${preview.priceCalculationId}`);
  console.log(
    `bank payment price: ${formatMinorUnits(request.overrideBankPaymentPriceMinorUnits, request.currency)}`
  );
  console.log(
    `regular/card price: ${formatMinorUnits(BigInt(preview.resultingRegularCardPriceMinorUnits), request.currency)}`
  );
  console.log(
    `customer saving:    ${formatMinorUnits(BigInt(preview.resultingBankPaymentSavingsMinorUnits), request.currency)}`
  );
  // Truncated for DISPLAY only. The exact decimal is what the floor check
  // used; printing all 40 significant digits at an operator is noise they have
  // to squint past to see the number that matters.
  console.log(
    `bank gross margin:  ${new MoneyDecimal(preview.bankPaymentGrossMarginRate).times(100).toDecimalPlaces(2).toString()}%`
  );
  console.log(
    `bank contribution:  ${formatMinorUnits(BigInt(preview.bankPaymentContributionMinorUnits.split(".")[0] ?? "0"), request.currency)}`
  );

  if (preview.warning) {
    console.log("");
    console.log(preview.warning);
    console.log("");
  }

  if (preview.breaches.length > 0 && !request.confirmBreach) {
    return fail(
      "this override breaches the floors above. Re-run with --confirm-breach to proceed; it will be recorded."
    );
  }

  const result = await applyPriceOverride(request);
  console.log(`override ${result.id} recorded by ${actor}.`);
  // Says plainly what did NOT happen. An operator reading "recorded" will
  // otherwise assume the price changed — the same class of false claim as a
  // sync status reported without a sync having occurred.
  console.log(
    "NOTE: this is an AUDIT RECORD ONLY. It does not change any calculated, " +
      "approved or published price, and the next recalculation will not consult it. " +
      "Wiring overrides into price sync is Slice 2 work."
  );
}

/**
 * D14 / N3. Returns a variant to its calculated price by appending a
 * revocation. The override being withdrawn stays on the record.
 */
async function revoke(): Promise<void> {
  const masterVariantId = arg("variant");
  const actor = arg("actor");
  const reason = arg("reason");

  if (!masterVariantId) return fail("--variant <id> is required");
  if (!actor) return fail("--actor <staff-id> is required");
  if (!reason) return fail("--reason <text> is required (D14)");

  const active = await resolveActiveOverride(masterVariantId);
  if (!active) {
    return fail("no override is in effect for that variant — nothing to revoke");
  }

  console.log(
    `revoking override ${active.id}: ${formatMinorUnits(active.overrideBankPaymentPriceMinorUnits ?? 0n, active.currency)}`
  );

  const result = await revokePriceOverride({ masterVariantId, reason, revokedBy: actor });
  console.log(`revocation ${result.id} recorded by ${actor}.`);
  console.log(
    "The variant returns to its CALCULATED price. The revoked override remains " +
      "on the record; nothing was deleted."
  );
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
          : verb === "override"
            ? override
            : verb === "revoke"
              ? revoke
              : null;

if (!run) {
  console.log("usage: price-review <list|approve|reject|verify|override|revoke> [options]");
  process.exitCode = 1;
} else {
  run()
    .catch((error) => fail(error instanceof Error ? error.message : String(error)))
    .finally(() => prisma.$disconnect());
}
