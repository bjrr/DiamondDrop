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
}

const REGISTRY: Record<PriceEndingRuleId, PriceEndingRule> = {
  NONE_V1: {
    id: "NONE_V1",
    apply: (priceMinorUnits) => priceMinorUnits,
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
