import { describe, expect, it } from "vitest";

import { decideOrderCheckOutcome } from "./orderCheck";

describe("decideOrderCheckOutcome", () => {
  it("returns matched when an acknowledgment id was found", () => {
    expect(decideOrderCheckOutcome({ matchedAcknowledgmentId: "ack-123" })).toBe("matched");
  });

  it("returns unmatched when no acknowledgment id was found (criterion 140 — recorded either way)", () => {
    expect(decideOrderCheckOutcome({ matchedAcknowledgmentId: null })).toBe("unmatched");
  });
});
