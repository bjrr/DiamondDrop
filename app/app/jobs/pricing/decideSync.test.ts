import { describe, expect, it } from "vitest";

import { decideSync } from "./decideSync";

/**
 * CRITERION 25 — the sync decision table (spec §9.3).
 *
 * decideSync is pure and is the gate between "a price was computed" and "a
 * price publishes without a human looking at it", so every branch is asserted
 * individually rather than by sampling.
 *
 * This file exists because the QA review found it missing: the auto_apply
 * branch of the job was entirely untested, which is how a defect marking
 * changed prices as `synced` survived.
 */

const usd = (amountMinorUnits: string) => ({ amountMinorUnits, currency: "USD" });

describe("first-ever price", () => {
  it("always needs approval, whatever the tolerance", () => {
    // There is no prior price to sanity-check the magnitude against, so a
    // brand-new price is always a human decision — even with a huge tolerance.
    for (const toleranceBps of [0, 50, 100_000]) {
      const result = decideSync({ newPrice: usd("136833"), lastSyncedPrice: null, toleranceBps });
      expect(result.decision).toBe("needs_approval");
      expect(result.deltaBps).toBeNull();
      expect(result.unchanged).toBe(false);
    }
  });

  it("treats undefined the same as null", () => {
    expect(decideSync({ newPrice: usd("1000"), toleranceBps: 50 }).decision).toBe("needs_approval");
  });
});

describe("unchanged price", () => {
  it("auto-applies as a no-op so the queue stays empty", () => {
    const result = decideSync({
      newPrice: usd("136833"),
      lastSyncedPrice: usd("136833"),
      toleranceBps: 50,
    });
    expect(result.decision).toBe("auto_apply");
    expect(result.unchanged).toBe(true);
    expect(result.deltaBps).toBe(0);
  });

  it("is unchanged even at a zero tolerance", () => {
    const result = decideSync({
      newPrice: usd("500"),
      lastSyncedPrice: usd("500"),
      toleranceBps: 0,
    });
    expect(result.unchanged).toBe(true);
    expect(result.decision).toBe("auto_apply");
  });
});

describe("the tolerance boundary is inclusive", () => {
  // 100000 -> 100500 is exactly +50 bps.
  it("auto-applies exactly AT the tolerance", () => {
    const result = decideSync({
      newPrice: usd("100500"),
      lastSyncedPrice: usd("100000"),
      toleranceBps: 50,
    });
    expect(result.decision).toBe("auto_apply");
    expect(result.deltaBps).toBe(50);
  });

  it("requires approval one basis point over", () => {
    const result = decideSync({
      newPrice: usd("100510"),
      lastSyncedPrice: usd("100000"),
      toleranceBps: 50,
    });
    expect(result.decision).toBe("needs_approval");
    expect(result.deltaBps).toBe(51);
  });

  it("auto-applies just under the tolerance", () => {
    const result = decideSync({
      newPrice: usd("100490"),
      lastSyncedPrice: usd("100000"),
      toleranceBps: 50,
    });
    expect(result.decision).toBe("auto_apply");
  });
});

describe("increases and decreases are symmetric", () => {
  it("treats -51 bps exactly like +51 bps", () => {
    const up = decideSync({ newPrice: usd("100510"), lastSyncedPrice: usd("100000"), toleranceBps: 50 });
    const down = decideSync({ newPrice: usd("99490"), lastSyncedPrice: usd("100000"), toleranceBps: 50 });
    expect(up.decision).toBe("needs_approval");
    expect(down.decision).toBe("needs_approval");
    expect(down.deltaBps).toBe(-51);
  });

  it("requires approval for a large DROP", () => {
    // A 90% price collapse is as likely to be a data-entry error as a 90%
    // rise, and auto-publishing it would quietly sell far below cost.
    const result = decideSync({
      newPrice: usd("10000"),
      lastSyncedPrice: usd("100000"),
      toleranceBps: 50,
    });
    expect(result.decision).toBe("needs_approval");
    expect(result.deltaBps).toBe(-9000);
  });
});

describe("degenerate prior price", () => {
  it("requires approval when the prior price was zero", () => {
    // Relative change against zero is undefined; refusing is the only safe
    // answer, and dividing would throw or produce Infinity.
    const result = decideSync({
      newPrice: usd("100000"),
      lastSyncedPrice: usd("0"),
      toleranceBps: 50,
    });
    expect(result.decision).toBe("needs_approval");
    expect(result.deltaBps).toBeNull();
  });
});

describe("the comparison is exact, not floating point", () => {
  it("does not misclassify a boundary case on a price with awkward arithmetic", () => {
    // 333333 -> 334999 is 49.98 bps: inside 50, but a float path computing
    // 1666/333333*10000 can land on the wrong side of the boundary.
    const result = decideSync({
      newPrice: usd("334999"),
      lastSyncedPrice: usd("333333"),
      toleranceBps: 50,
    });
    expect(result.decision).toBe("auto_apply");
  });
});
