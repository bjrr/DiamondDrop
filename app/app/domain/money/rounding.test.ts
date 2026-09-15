import { describe, expect, it } from "vitest";

import { MoneyDecimal } from "./decimal";
import { DEFAULT_ROUNDING_RULE_ID, getRoundingRule, UnknownRoundingRuleError } from "./rounding";

describe("rounding rule registry", () => {
  it("resolves the default rule by its stable id", () => {
    const rule = getRoundingRule(DEFAULT_ROUNDING_RULE_ID);
    expect(rule.id).toBe("HALF_UP_MINOR_UNIT_V1");
  });

  it("throws UnknownRoundingRuleError for an unregistered id", () => {
    // @ts-expect-error -- intentionally invalid id to exercise the runtime guard
    expect(() => getRoundingRule("DOES_NOT_EXIST")).toThrow(UnknownRoundingRuleError);
  });

  it("rounds ties away from zero for positive amounts", () => {
    const rule = getRoundingRule(DEFAULT_ROUNDING_RULE_ID);
    expect(rule.round(new MoneyDecimal("100.5"))).toBe(101n);
    expect(rule.round(new MoneyDecimal("100.4"))).toBe(100n);
    expect(rule.round(new MoneyDecimal("100.6"))).toBe(101n);
  });

  it("rounds ties away from zero for negative amounts", () => {
    const rule = getRoundingRule(DEFAULT_ROUNDING_RULE_ID);
    expect(rule.round(new MoneyDecimal("-100.5"))).toBe(-101n);
    expect(rule.round(new MoneyDecimal("-100.4"))).toBe(-100n);
  });

  it("passes exact integer amounts through unchanged", () => {
    const rule = getRoundingRule(DEFAULT_ROUNDING_RULE_ID);
    expect(rule.round(new MoneyDecimal("42"))).toBe(42n);
    expect(rule.round(new MoneyDecimal("0"))).toBe(0n);
  });
});
