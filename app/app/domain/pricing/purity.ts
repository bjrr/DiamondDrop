import { MoneyDecimal, type MoneyDecimalValue } from "~/domain/money/decimal";

/**
 * L2 — the explicit alloy definition (purity → fineness).
 *
 * THE MODEL. Staff enter ONE reference price per gram for each PURE metal.
 * The cost of an alloyed piece is:
 *
 *     pure_reference_price_per_gram x fineness x weight_grams
 *
 * WHY THIS REPLACED PER-PURITY PRICES. The previous model stored a separate
 * price for each karat, which let them drift out of step with one another
 * silently. The seeded data demonstrated it: 14k at $48.25/g and 18k at
 * $62.00/g both imply pure gold around $82.7/g, while 10k at $29.50/g implies
 * $70.80/g. Three karats, two different underlying gold prices, no error
 * anywhere — 10k was simply mispriced by about 17% and nothing could detect it.
 * One reference price makes that class of inconsistency unrepresentable.
 *
 * FINENESS IS A PHYSICAL FACT, NOT A BUSINESS NUMBER. Karat is defined as
 * parts-per-24 of gold by mass, so 14k is exactly 14/24. These are not prices
 * and are not the owner's to set, which is why they live in a versioned code
 * registry rather than in an effective-dated table alongside market data.
 *
 * WHAT THIS DELIBERATELY IGNORES. The non-precious alloying metals in 14k gold
 * have a cost of their own, and refiners charge a premium over pure content.
 * Neither is modelled: the owner's rule is `pure x purity x grams` exactly.
 * Those costs, where they matter, belong in the cost components (metal_loss,
 * supplier_fee) where they are visible in the breakdown rather than buried in
 * a fudged fineness figure.
 *
 * VERSIONED, same contract as the rounding and margin registries: an id
 * referenced by a stored calculation may never change meaning. If a fineness
 * ever needs to differ from its physical value, that is a NEW id.
 */

export type PurityId = "SILVER_925" | "GOLD_10K" | "GOLD_14K" | "GOLD_18K" | "PLATINUM_950";

export type PurityFactorSetId = "PHYSICAL_FINENESS_V1";

/**
 * Exact decimal strings, never numbers: these are multiplied by money.
 *
 * 10k and 14k are non-terminating in decimal (10/24 = 0.41666…), so they are
 * carried to six places — the same scale the database stores rates at. The
 * rounding that matters happens once, at the single boundary in the engine,
 * not here.
 */
const PHYSICAL_FINENESS_V1: Readonly<Record<PurityId, string>> = {
  /** Sterling silver: 925 parts per 1000. */
  SILVER_925: "0.925000",
  /** 10/24 by mass. */
  GOLD_10K: "0.416667",
  /** 14/24 by mass. */
  GOLD_14K: "0.583333",
  /** 18/24 by mass, which is exact. */
  GOLD_18K: "0.750000",
  /** Platinum 950: 950 parts per 1000. */
  PLATINUM_950: "0.950000",
};

const REGISTRY: Readonly<Record<PurityFactorSetId, Readonly<Record<PurityId, string>>>> = {
  PHYSICAL_FINENESS_V1,
};

export const CURRENT_PURITY_FACTOR_SET: PurityFactorSetId = "PHYSICAL_FINENESS_V1";

export class UnknownPurityError extends Error {
  constructor(readonly purity: string) {
    super(
      `Unknown purity "${purity}". Every purity must have an explicit fineness — ` +
        `defaulting to 1.0 would price an alloy as if it were pure metal.`
    );
    this.name = "UnknownPurityError";
  }
}

export class UnknownPurityFactorSetError extends Error {
  constructor(readonly id: string) {
    super(`Unknown purity factor set "${id}". Ids are versioned and must be registered.`);
    this.name = "UnknownPurityFactorSetError";
  }
}

/** The fineness as an exact decimal string. Throws rather than assuming 1.0. */
export function purityFineness(
  purity: string,
  setId: PurityFactorSetId = CURRENT_PURITY_FACTOR_SET
): string {
  const set = REGISTRY[setId];
  if (!set) throw new UnknownPurityFactorSetError(setId);

  const fineness = set[purity as PurityId];
  if (!fineness) throw new UnknownPurityError(purity);
  return fineness;
}

/**
 * The alloyed price per gram: pure reference x fineness.
 *
 * Exact throughout — no rounding here. Rounding an intermediate per-gram price
 * would compound across the weight multiplication, so it waits for the single
 * boundary in the engine.
 */
export function alloyedPricePerGram(
  pureReferencePerGram: MoneyDecimalValue,
  purity: string,
  setId: PurityFactorSetId = CURRENT_PURITY_FACTOR_SET
): MoneyDecimalValue {
  return new MoneyDecimal(pureReferencePerGram).times(purityFineness(purity, setId));
}
