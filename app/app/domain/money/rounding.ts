import { MoneyDecimal, type MoneyDecimalValue } from "./decimal";

/**
 * Rounding rules are identified by a stable, versioned id (spec §0.4,
 * acceptance criterion 5). Add new ids rather than redefining an existing
 * one's behavior — an id's rounding behavior must never change once a
 * pricing profile or price_calculation row references it.
 */
export type RoundingRuleId = "HALF_UP_MINOR_UNIT_V1";

export interface RoundingRule {
  readonly id: RoundingRuleId;
  readonly description: string;
  /**
   * Rounds a decimal amount already expressed in minor units (e.g. cents,
   * possibly fractional) down to an integer minor-unit bigint.
   */
  round(decimalMinorUnits: MoneyDecimalValue): bigint;
}

const HALF_UP_MINOR_UNIT_V1: RoundingRule = {
  id: "HALF_UP_MINOR_UNIT_V1",
  description:
    "Round to the nearest whole minor unit (e.g. cent); exact ties round away from zero (half up). " +
    "MVP1 default per docs/specs/SLICE-0-FOUNDATION.md §0.4.",
  round(decimalMinorUnits) {
    return BigInt(decimalMinorUnits.toDecimalPlaces(0, MoneyDecimal.ROUND_HALF_UP).toFixed(0));
  },
};

const ROUNDING_RULE_REGISTRY: Record<RoundingRuleId, RoundingRule> = {
  HALF_UP_MINOR_UNIT_V1,
};

/**
 * The MVP1 default rounding rule. Callers must pass this (or another
 * explicit id) themselves — there is no implicit fallback inside
 * getRoundingRule, so changing what "the default" means anywhere in the
 * codebase is a deliberate, single-line, reviewable change, not something
 * buried in the registry.
 */
export const DEFAULT_ROUNDING_RULE_ID: RoundingRuleId = "HALF_UP_MINOR_UNIT_V1";

export class UnknownRoundingRuleError extends Error {
  constructor(id: string) {
    super(
      `Unknown rounding rule id: "${id}". Rounding rules must be registered in app/domain/money/rounding.ts.`
    );
    this.name = "UnknownRoundingRuleError";
  }
}

/** Looks up a rounding rule by its stable, versioned id. Throws if the id is not registered. */
export function getRoundingRule(id: RoundingRuleId): RoundingRule {
  const rule = ROUNDING_RULE_REGISTRY[id];
  if (!rule) throw new UnknownRoundingRuleError(id);
  return rule;
}
