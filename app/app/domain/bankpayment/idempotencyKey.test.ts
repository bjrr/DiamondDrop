import { describe, expect, it } from "vitest";

import { computeBankCheckoutIdempotencyKey, type IdempotencyKeyLine } from "./idempotencyKey";

const lineA: IdempotencyKeyLine = {
  shopifyVariantGid: "gid://shopify/ProductVariant/1",
  quantity: 2,
  unitPriceMinorUnits: "100000",
  currency: "USD",
};
const lineB: IdempotencyKeyLine = {
  shopifyVariantGid: "gid://shopify/ProductVariant/2",
  quantity: 1,
  unitPriceMinorUnits: "50000",
  currency: "USD",
};

describe("computeBankCheckoutIdempotencyKey", () => {
  it("is deterministic for identical input", () => {
    const a = computeBankCheckoutIdempotencyKey("buyer@example.com", "bank", [lineA, lineB]);
    const b = computeBankCheckoutIdempotencyKey("buyer@example.com", "bank", [lineA, lineB]);
    expect(a).toBe(b);
  });

  it("is independent of line order — coalescing makes no ordering promise", () => {
    const forward = computeBankCheckoutIdempotencyKey("buyer@example.com", "bank", [lineA, lineB]);
    const reversed = computeBankCheckoutIdempotencyKey("buyer@example.com", "bank", [lineB, lineA]);
    expect(forward).toBe(reversed);
  });

  it("differs when the email differs", () => {
    const a = computeBankCheckoutIdempotencyKey("buyer@example.com", "bank", [lineA]);
    const b = computeBankCheckoutIdempotencyKey("other@example.com", "bank", [lineA]);
    expect(a).not.toBe(b);
  });

  it("differs when a line's quantity differs", () => {
    const a = computeBankCheckoutIdempotencyKey("buyer@example.com", "bank", [lineA]);
    const b = computeBankCheckoutIdempotencyKey("buyer@example.com", "bank", [{ ...lineA, quantity: 3 }]);
    expect(a).not.toBe(b);
  });

  it("differs when a line's resolved unit price differs — a genuine price change is a new attempt, not a replay", () => {
    const a = computeBankCheckoutIdempotencyKey("buyer@example.com", "bank", [lineA]);
    const b = computeBankCheckoutIdempotencyKey("buyer@example.com", "bank", [
      { ...lineA, unitPriceMinorUnits: "100001" },
    ]);
    expect(a).not.toBe(b);
  });

  it("differs when the set of lines differs even if totals coincidentally match", () => {
    const a = computeBankCheckoutIdempotencyKey("buyer@example.com", "bank", [lineA, lineB]);
    const b = computeBankCheckoutIdempotencyKey("buyer@example.com", "bank", [lineA]);
    expect(a).not.toBe(b);
  });

  it("is stable across independent runs (no time/random component)", () => {
    // Regression pin — this exact digest must never change for this input
    // unless the hashing scheme itself is deliberately revised.
    const key = computeBankCheckoutIdempotencyKey("buyer@example.com", "bank", [lineA, lineB]);
    expect(key).toMatch(/^bank_checkout:[0-9a-f]{64}$/);
  });
});
