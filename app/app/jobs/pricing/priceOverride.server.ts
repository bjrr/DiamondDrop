import { prisma } from "~/db/client.server";
import { MoneyDecimal } from "~/domain/money/decimal";
import { partitionRevenueSide } from "~/domain/pricing/cost";
import { evaluateFloors } from "~/domain/pricing/solve";
import type { BuyNowPricingInputs, FloorId } from "~/domain/pricing/types";
import { logger } from "~/lib/logger.server";

/**
 * D14 (owner-directed 2026-09-17): manual owner overrides are permitted even
 * when they violate the pricing floors, "subject to warning, confirmation,
 * reason and audit".
 *
 * All four are enforced here, and the ORDER matters:
 *
 *   1. WARNING      — the floors are evaluated against the proposed price and
 *                     the specific breaches are named. Not "this may be below
 *                     margin" but "this is 4.2 points under the 20% floor".
 *   2. CONFIRMATION — a breaching override requires `confirmBreach: true`. The
 *                     flag is separate from the reason on purpose: a reason can
 *                     be typed without reading the warning, an explicit
 *                     acknowledgement cannot be supplied by accident.
 *   3. REASON       — required for every override, breaching or not.
 *   4. AUDIT        — written append-only, including the warning text actually
 *                     shown, before the override takes effect.
 *
 * WHAT THIS DELIBERATELY DOES NOT DO: it does not modify the price_calculation
 * it departs from. The engine's answer stays on the record unchanged, and the
 * override sits beside it. Editing the calculation would make "what did the
 * engine compute?" unanswerable the moment anyone intervened — which is exactly
 * when the question gets asked.
 */

export interface PriceOverrideRequest {
  masterVariantId: string;
  overridePriceMinorUnits: bigint;
  currency: string;
  reason: string;
  overriddenBy: string;
  /** Must be true when the proposed price breaches a floor (step 2 above). */
  confirmBreach?: boolean;
  /** Reference calculation. Resolved from the latest one when omitted. */
  priceCalculationId?: string;
}

export interface FloorBreach {
  floor: FloorId;
  /** Human-readable, e.g. "gross margin 15.80% is below the 20.00% floor". */
  detail: string;
}

export interface PriceOverridePreview {
  breaches: readonly FloorBreach[];
  /** Null when nothing is breached — there is no warning to show. */
  warning: string | null;
  grossMargin: string;
  contributionMinorUnits: string;
  /** The calculation the override was evaluated against. */
  priceCalculationId: string;
}

export class PriceOverrideReasonRequiredError extends Error {
  constructor() {
    super("A manual price override requires a reason (D14).");
    this.name = "PriceOverrideReasonRequiredError";
  }
}

export class PriceOverrideActorRequiredError extends Error {
  constructor() {
    super("A manual price override must name the person making it (D14).");
    this.name = "PriceOverrideActorRequiredError";
  }
}

/**
 * Thrown when a breaching override arrives without explicit confirmation. It
 * carries the breaches so the caller can show the operator exactly what they
 * are being asked to confirm rather than a generic refusal.
 */
export class PriceOverrideConfirmationRequiredError extends Error {
  constructor(
    readonly breaches: readonly FloorBreach[],
    readonly warning: string
  ) {
    super(`This override breaches a pricing floor and requires explicit confirmation.\n${warning}`);
    this.name = "PriceOverrideConfirmationRequiredError";
  }
}

export class PriceOverrideCurrencyMismatchError extends Error {
  constructor(expected: string, actual: string) {
    super(`Override currency ${actual} does not match the variant's pricing currency ${expected}.`);
    this.name = "PriceOverrideCurrencyMismatchError";
  }
}

/**
 * Evaluates a proposed override WITHOUT writing anything. This is what produces
 * the warning, and it is exported so an operator surface can show the
 * consequences before asking for confirmation — rather than discovering them
 * from a rejected write.
 */
export async function previewPriceOverride(
  request: Pick<
    PriceOverrideRequest,
    "masterVariantId" | "overridePriceMinorUnits" | "currency" | "priceCalculationId"
  >
): Promise<PriceOverridePreview> {
  // Evaluated against the CALCULATION BEING OVERRIDDEN, using the inputs stored
  // in its snapshot — not against a fresh resolve. Re-resolving would compare
  // the operator's number to today's costs, so an override reviewed on Tuesday
  // and confirmed on Wednesday could be warned about differently each time, for
  // reasons having nothing to do with the price they typed. §5.6's snapshot
  // exists precisely so a past calculation can be re-examined exactly as it was.
  const calculation = await findCalculationToOverride(
    request.masterVariantId,
    request.priceCalculationId
  );

  const payload = calculation.snapshot.payload as unknown as {
    inputs: BuyNowPricingInputs;
  };
  const inputs = payload.inputs;

  if (inputs.currency !== request.currency) {
    throw new PriceOverrideCurrencyMismatchError(inputs.currency, request.currency);
  }

  const revenueSide = partitionRevenueSide(inputs.components);
  const profile = inputs.profile;
  const variantFloor = inputs.variantFloor?.amountMinorUnits ?? "0";

  // The SAME predicate the engine uses (§5.5). Re-implementing the floor check
  // here would let the override path and the pricing path drift apart, and the
  // override path is precisely where an inconsistency would go unnoticed.
  const evaluation = evaluateFloors({
    priceMinorUnits: request.overridePriceMinorUnits,
    landedCostMinorUnits: new MoneyDecimal(calculation.landedCostMinorUnits.toString()),
    revenueRate: revenueSide.rate,
    revenueFixedMinorUnits: revenueSide.fixedMinorUnits,
    minGrossMarginRate: new MoneyDecimal(profile.minGrossMarginRate),
    minDollarProfitMinorUnits: new MoneyDecimal(profile.minDollarProfit.amountMinorUnits),
    variantFloorMinorUnits: new MoneyDecimal(variantFloor),
  });

  const breaches: FloorBreach[] = evaluation.failing.map((floor) => ({
    floor,
    detail: describeBreach(floor, evaluation, profile, variantFloor),
  }));

  return {
    breaches,
    warning: breaches.length === 0 ? null : buildWarning(breaches),
    grossMargin: evaluation.grossMargin,
    contributionMinorUnits: evaluation.contribution,
    priceCalculationId: calculation.id,
  };
}

export class NoCalculationToOverrideError extends Error {
  constructor(readonly masterVariantId: string) {
    super(
      `No computed price calculation exists for variant ${masterVariantId}, so there is nothing to override.`
    );
    this.name = "NoCalculationToOverrideError";
  }
}

export class CalculationVariantMismatchError extends Error {
  constructor(priceCalculationId: string, masterVariantId: string) {
    super(
      `Calculation ${priceCalculationId} does not belong to variant ${masterVariantId}; refusing to evaluate an override against another variant's cost basis.`
    );
    this.name = "CalculationVariantMismatchError";
  }
}

async function findCalculationToOverride(masterVariantId: string, priceCalculationId?: string) {
  if (priceCalculationId) {
    const named = await prisma.priceCalculation.findUniqueOrThrow({
      where: { id: priceCalculationId },
      include: { snapshot: true },
    });

    // A calculation id is caller-supplied, so it is checked rather than
    // trusted. Without this, passing another variant's calculation would
    // evaluate the floors against the wrong cost and could report a breaching
    // price as clean — silently, and with an audit row claiming otherwise.
    if (named.masterVariantId !== masterVariantId) {
      throw new CalculationVariantMismatchError(priceCalculationId, masterVariantId);
    }
    if (named.status !== "computed") {
      throw new NoCalculationToOverrideError(masterVariantId);
    }
    return named;
  }

  // Only a `computed` calculation is a valid basis: a `failed` row carries no
  // inputs, so overriding "against" one would evaluate the floors against
  // nothing and report no breaches — the most dangerous possible false green.
  const latest = await prisma.priceCalculation.findFirst({
    where: { masterVariantId, status: "computed" },
    orderBy: { createdAt: "desc" },
    include: { snapshot: true },
  });

  if (!latest) throw new NoCalculationToOverrideError(masterVariantId);
  return latest;
}

export async function applyPriceOverride(request: PriceOverrideRequest): Promise<{
  id: string;
  breaches: readonly FloorBreach[];
}> {
  // Attribution and justification are checked first: neither depends on the
  // numbers, and refusing early keeps an unusable request from doing any work.
  if (!request.reason || request.reason.trim() === "") {
    throw new PriceOverrideReasonRequiredError();
  }
  if (!request.overriddenBy || request.overriddenBy.trim() === "") {
    throw new PriceOverrideActorRequiredError();
  }

  const preview = await previewPriceOverride(request);

  if (preview.breaches.length > 0 && request.confirmBreach !== true) {
    throw new PriceOverrideConfirmationRequiredError(preview.breaches, preview.warning ?? "");
  }

  const override = await prisma.priceOverride.create({
    data: {
      masterVariantId: request.masterVariantId,
      // The calculation the preview evaluated against, not the caller's
      // optional hint: the audit row must name the basis actually used.
      priceCalculationId: preview.priceCalculationId,
      overridePriceMinorUnits: request.overridePriceMinorUnits,
      currency: request.currency,
      breachedFloors: preview.breaches.map((b) => b.floor),
      // The warning text as actually shown. Null when there was nothing to warn
      // about, which is different from an empty warning.
      warningShown: preview.warning,
      reason: request.reason.trim(),
      overriddenBy: request.overriddenBy.trim(),
    },
  });

  // Logged at WARN even when nothing is breached: a human overriding the
  // pricing engine is an exceptional event regardless of whether the number
  // they chose happens to clear the floors.
  logger.warn("pricing.manual_override", {
    overrideId: override.id,
    masterVariantId: request.masterVariantId,
    overriddenBy: request.overriddenBy,
    breachedFloors: preview.breaches.map((b) => b.floor),
    // No price, cost or margin values in logs (criterion 30).
  });

  return { id: override.id, breaches: preview.breaches };
}

function describeBreach(
  floor: FloorId,
  evaluation: { grossMargin: string; contribution: string },
  profile: { minGrossMarginRate: string; minDollarProfit: { amountMinorUnits: string } },
  variantFloorMinorUnits: string
): string {
  switch (floor) {
    case "min_gross_margin":
      return `gross margin ${asPercent(evaluation.grossMargin)} is below the ${asPercent(
        profile.minGrossMarginRate
      )} floor`;
    case "min_dollar_profit":
      return `contribution ${asMoney(evaluation.contribution)} is below the ${asMoney(
        profile.minDollarProfit.amountMinorUnits
      )} minimum`;
    case "variant_floor":
      return `price is below this variant's configured floor of ${asMoney(variantFloorMinorUnits)}`;
  }
}

function buildWarning(breaches: readonly FloorBreach[]): string {
  return [
    "WARNING — this override breaches pricing floors approved by the owner:",
    ...breaches.map((b) => `  - ${b.detail}`),
    "Proceeding requires explicit confirmation and a stated reason, and will be recorded.",
  ].join("\n");
}

/** Display only. String arithmetic so a money value never touches a float. */
function asPercent(rate: string): string {
  return `${new MoneyDecimal(rate).times(100).toDecimalPlaces(2).toString()}%`;
}

function asMoney(minorUnits: string): string {
  const whole = new MoneyDecimal(minorUnits).dividedBy(100).toDecimalPlaces(2).toString();
  return `$${whole}`;
}
