import type { PriceEndingRuleId } from "./types";

/**
 * Price-ending registry (spec §5.4).
 *
 * Slice 1 contains exactly one rule: `NONE_V1`, the identity. Charm pricing
 * (.99 endings) is deliberately NOT introduced. The registry exists so that
 * adding one later is a versioned, reviewable act with its own id recorded on
 * every affected calculation — rather than an edit to the engine that silently
 * changes every historical price's reproducibility.
 *
 * Same contract as the rounding registry: an id, once referenced by a stored
 * calculation, may never change behaviour. Add a new id instead.
 */

export interface PriceEndingRule {
  readonly id: PriceEndingRuleId;
  readonly apply: (priceMinorUnits: bigint) => bigint;
  /**
   * The granularity this rule produces, and therefore the step the §5.5 floor
   * loop must bump by.
   *
   * Without this the loop nudges by one minor unit, which would turn a
   * whole-dollar price into $140.01 the moment a floor bites — quietly
   * undoing the rounding rule that had just been applied.
   */
  readonly stepMinorUnits: bigint;
}

const REGISTRY: Record<PriceEndingRuleId, PriceEndingRule> = {
  NONE_V1: {
    id: "NONE_V1",
    apply: (priceMinorUnits) => priceMinorUnits,
    stepMinorUnits: 1n,
  },

  /**
   * Whole dollars, rounding UP (D14, owner-resolved 2026-09-17).
   *
   * Deliberately ceiling rather than nearest. Rounding to nearest can move a
   * price DOWN by up to 49 minor units, below the target markup and possibly
   * below a hard floor — which the floor loop would then have to climb back
   * out of. Rounding up can only ever increase the price, so it can never
   * breach a floor, and a price is never quietly reduced below what the
   * configured markup asked for.
   */
  WHOLE_DOLLAR_UP_V1: {
    id: "WHOLE_DOLLAR_UP_V1",
    apply: (priceMinorUnits) => {
      const remainder = priceMinorUnits % 100n;
      if (remainder === 0n) return priceMinorUnits;
      // Negative prices are not a pricing outcome, but round away from zero
      // consistently rather than silently producing a smaller magnitude.
      return priceMinorUnits < 0n
        ? priceMinorUnits - (100n + remainder)
        : priceMinorUnits + (100n - remainder);
    },
    stepMinorUnits: 100n,
  },
};

export class UnknownPriceEndingRuleError extends Error {
  constructor(readonly id: string) {
    super(`Unknown price ending rule id "${id}". Ids are versioned and must be registered.`);
    this.name = "UnknownPriceEndingRuleError";
  }
}

export function getPriceEndingRule(id: PriceEndingRuleId): PriceEndingRule {
  const rule = REGISTRY[id];
  if (!rule) throw new UnknownPriceEndingRuleError(id);
  return rule;
}

export function applyPriceEnding(priceMinorUnits: bigint, ruleId: PriceEndingRuleId): bigint {
  return getPriceEndingRule(ruleId).apply(priceMinorUnits);
}
