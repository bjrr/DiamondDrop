import { describe, expect, it } from "vitest";

import { Money } from "~/domain/money";

import { buildSnapshotRecord, InvalidSnapshotError } from "./snapshot";

describe("buildSnapshotRecord", () => {
  it("computes identical hashes for identical payloads", () => {
    const a = buildSnapshotRecord({ kind: "campaign_snapshot", payload: { price: 100, tier: 1 } });
    const b = buildSnapshotRecord({ kind: "campaign_snapshot", payload: { tier: 1, price: 100 } });
    expect(a.contentHash).toBe(b.contentHash);
  });

  it("computes a different hash for any payload difference", () => {
    const a = buildSnapshotRecord({ kind: "campaign_snapshot", payload: { price: 100 } });
    const b = buildSnapshotRecord({ kind: "campaign_snapshot", payload: { price: 101 } });
    expect(a.contentHash).not.toBe(b.contentHash);
  });

  it("rejects a missing kind", () => {
    expect(() => buildSnapshotRecord({ kind: "", payload: { a: 1 } })).toThrow(InvalidSnapshotError);
  });

  // SnapshotInput.payload was widened from JsonValue to unknown (architect
  // review, 2026-09-14, finding 4 follow-up) precisely so a caller can pass
  // a payload carrying a Date or Money directly, with no cast — the
  // canonical-JSON hasher underneath is now the real guard.
  it("accepts a payload containing a Date and Money without casting, and hashes deterministically", () => {
    const a = buildSnapshotRecord({
      kind: "campaign_snapshot",
      payload: { capturedAt: new Date("2026-09-14T00:00:00.000Z"), price: Money.fromMinorUnits(1999n, "USD") },
    });
    const b = buildSnapshotRecord({
      kind: "campaign_snapshot",
      payload: { price: Money.fromMinorUnits(1999n, "USD"), capturedAt: new Date("2026-09-14T00:00:00.000Z") },
    });
    expect(a.contentHash).toBe(b.contentHash);
  });
});
