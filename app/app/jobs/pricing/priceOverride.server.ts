import { prisma } from "~/db/client.server";
import { MoneyDecimal } from "~/domain/money/decimal";
import { deriveRegularCardPrice } from "~/domain/pricing/regularCardPrice";
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

/**
 * The override currently in effect for a variant, resolved by NAME rather than
 * by an unstated "latest row wins" convention (architect follow-up N3).
 *
 * Returns null when there is no override, and — importantly — also when the
 * most recent entry is a revocation. Both mean the calculated price applies,
 * and callers should not have to know that a revoke row exists in order to get
 * that right.
 */
export async function resolveActiveOverride(masterVariantId: string) {
  // The head of the chain is the row nothing supersedes. Using that rather than
  // ORDER BY created_at means two rows written in the same millisecond cannot
  // silently swap places, and the unique index on supersedes_id guarantees
  // there is at most one head.
  const head = await prisma.priceOverride.findFirst({
    where: { masterVariantId, supersededBy: null },
    orderBy: { createdAt: "desc" },
  });

  if (!head || head.kind === "revoke") return null;
  return head;
}

export class NothingToRevokeError extends Error {
  constructor(readonly masterVariantId: string) {
    super(`Variant ${masterVariantId} has no override in effect, so there is nothing to revoke.`);
    this.name = "NothingToRevokeError";
  }
}

/**
 * Returns a variant to its calculated price by APPENDING a revocation, never by
 * deleting the override it revokes. The override that was in force stays on the
 * record, along with who withdrew it and why — a price that was charged and
 * then withdrawn is exactly the history a dispute asks about.
 */
export async function revokePriceOverride(request: {
  masterVariantId: string;
  reason: string;
  revokedBy: string;
}): Promise<{ id: string; revokedOverrideId: string }> {
  if (!request.reason || request.reason.trim() === "") {
    throw new PriceOverrideReasonRequiredError();
  }
  if (!request.revokedBy || request.revokedBy.trim() === "") {
    throw new PriceOverrideActorRequiredError();
  }

  const active = await resolveActiveOverride(request.masterVariantId);
  if (!active) throw new NothingToRevokeError(request.masterVariantId);

  const revocation = await prisma.priceOverride.create({
    data: {
      masterVariantId: request.masterVariantId,
      kind: "revoke",
      supersedesId: active.id,
      priceCalculationId: active.priceCalculationId,
      // No price: a revocation restores the calculated one. The CHECK
      // constraint refuses a revoke row that carries a price.
      overrideBankPaymentPriceMinorUnits: null,
      currency: active.currency,
      breachedFloors: [],
      warningShown: null,
      reason: request.reason.trim(),
      overriddenBy: request.revokedBy.trim(),
    },
  });

  logger.warn("pricing.override_revoked", {
    overrideId: revocation.id,
    revokedOverrideId: active.id,
    masterVariantId: request.masterVariantId,
    revokedBy: request.revokedBy,
  });

  return { id: revocation.id, revokedOverrideId: active.id };
}

export interface PriceOverrideRequest {
  masterVariantId: string;
  overrideBankPaymentPriceMinorUnits: bigint;
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
  /** Measured on the Bank Payment Price, gross of payment expense. */
  bankPaymentGrossMarginRate: string;
  bankPaymentContributionMinorUnits: string;
  /**
   * What the customer would be shown if this override took effect: the
   * Regular/Card Price derived from the proposed bank price, and the saving
   * between the two. Included so the operator reviews the numbers a shopper
   * actually sees, not only the internal one they typed.
   *
   * Both come straight from the versioned rule. An earlier revision called
   * `.toString()` on the rule's RESULT OBJECT and stored "[object Object]" here
   * — which typechecked, because the field is a string, and which no test
   * caught because nothing asserted the value.
   */
  resultingRegularCardPriceMinorUnits: string;
  resultingBankPaymentSavingsMinorUnits: string;
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
    "masterVariantId" | "overrideBankPaymentPriceMinorUnits" | "currency" | "priceCalculationId"
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

  const profile = inputs.profile;
  const variantFloor = inputs.variantFloor?.amountMinorUnits ?? "0";

  // The SAME predicate the engine uses (§5.5). Re-implementing the floor check
  // here would let the override path and the pricing path drift apart, and the
  // override path is precisely where an inconsistency would go unnoticed.
  //
  // NO REVENUE-SIDE DEDUCTION. The floors are measured on the bank price gross
  // of payment expense, so an operator is warned against the same numbers the
  // engine enforces. Previously this subtracted the processing component, which
  // understated the margin an override would achieve by about three points —
  // meaning some overrides were warned about when they were in fact compliant.
  const evaluation = evaluateFloors({
    bankPaymentPriceMinorUnits: request.overrideBankPaymentPriceMinorUnits,
    landedCostMinorUnits: new MoneyDecimal(calculation.landedCostMinorUnits.toString()),
    minGrossMarginRate: new MoneyDecimal(profile.minGrossMarginRate),
    minDollarProfitMinorUnits: new MoneyDecimal(profile.minDollarProfit.amountMinorUnits),
    variantFloorMinorUnits: new MoneyDecimal(variantFloor),
  });

  const breaches: FloorBreach[] = evaluation.failing.map((floor) => ({
    floor,
    detail: describeBreach(floor, evaluation, profile, variantFloor),
  }));

  // Shown so the operator can see what the CUSTOMER will see. They are typing a
  // bank price — that is what the floors bind — but the storefront headline is
  // the derived card price, and an override reviewed without it is an override
  // reviewed against a number no shopper is ever quoted.
  const card = deriveRegularCardPrice(
    request.overrideBankPaymentPriceMinorUnits,
    new MoneyDecimal(profile.fixedCardUpliftRate),
    profile.regularCardPriceRuleId
  );

  return {
    breaches,
    warning: breaches.length === 0 ? null : buildWarning(breaches),
    bankPaymentGrossMarginRate: evaluation.bankPaymentGrossMarginRate,
    bankPaymentContributionMinorUnits: evaluation.bankPaymentContributionMinorUnits,
    resultingRegularCardPriceMinorUnits: card.regularCardPriceMinorUnits.toString(),
    resultingBankPaymentSavingsMinorUnits: card.bankPaymentSavingsMinorUnits.toString(),
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

  // Chains onto the override currently in effect, so the history is a single
  // ordered sequence per variant rather than a pile of rows with an implicit
  // winner. Note this reads the HEAD of the chain, including a revoke row —
  // a new override after a revocation supersedes the revocation.
  const head = await prisma.priceOverride.findFirst({
    where: { masterVariantId: request.masterVariantId, supersededBy: null },
    orderBy: { createdAt: "desc" },
  });

  const override = await prisma.priceOverride.create({
    data: {
      masterVariantId: request.masterVariantId,
      kind: "set",
      supersedesId: head?.id ?? null,
      // The calculation the preview evaluated against, not the caller's
      // optional hint: the audit row must name the basis actually used.
      priceCalculationId: preview.priceCalculationId,
      overrideBankPaymentPriceMinorUnits: request.overrideBankPaymentPriceMinorUnits,
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

/**
 * Every figure says BANK PAYMENT explicitly. An operator warned that
 * "margin is 18%" has to know which price that is a margin on before the
 * warning means anything — and the whole point of the confirmation step is that
 * they understood what they were confirming.
 */
function describeBreach(
  floor: FloorId,
  evaluation: { bankPaymentGrossMarginRate: string; bankPaymentContributionMinorUnits: string },
  profile: { minGrossMarginRate: string; minDollarProfit: { amountMinorUnits: string } },
  variantFloorMinorUnits: string
): string {
  switch (floor) {
    case "min_gross_margin":
      return `bank payment gross margin ${asPercent(evaluation.bankPaymentGrossMarginRate)} is below the ${asPercent(
        profile.minGrossMarginRate
      )} floor`;
    case "min_dollar_profit":
      return `bank payment contribution ${asMoney(evaluation.bankPaymentContributionMinorUnits)} is below the ${asMoney(
        profile.minDollarProfit.amountMinorUnits
      )} minimum`;
    case "variant_floor":
      return `bank payment price is below this variant's configured floor of ${asMoney(
        variantFloorMinorUnits
      )}`;
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
