import { describe, expect, it } from "vitest";

import { hashCanonicalJson } from "~/domain/evidence/hash";
import { Money } from "~/domain/money/money";
import { createSnapshot, getSnapshotById } from "~/db/repositories/snapshotRepository.server";

/**
 * Integration test proving that a snapshot containing both a Date and a Money
 * round-trips through Postgres, re-canonicalizes identically, and produces the
 * same content hash. This demonstrates the invariant that makes a snapshot
 * usable as dispute evidence: JSON serialization via Prisma (which honors
 * toJSON()) preserves both the Date (as ISO 8601 string) and Money
 * ({amountMinorUnits: string, currency}), so re-hashing the read-back payload
 * reproduces the original stored contentHash.
 *
 * See docs/specs/SLICE-0-FOUNDATION.md "Deferred verification" item 5.
 */
describe("snapshot round-trip (Date + Money)", () => {
  it("stores a Date as ISO 8601 string and re-hashes to the same contentHash", async () => {
    const timestamp = new Date("2026-09-14T12:34:56.789Z");
    const payload = {
      timestamp,
      description: "Test snapshot with date",
    };

    const created = await createSnapshot({
      kind: "test.date_roundtrip",
      payload,
    });

    const retrieved = await getSnapshotById(created.id);
    expect(retrieved).toBeDefined();

    // The stored payload should have the Date serialized as an ISO 8601 string
    expect(retrieved?.payload).toEqual({
      timestamp: "2026-09-14T12:34:56.789Z",
      description: "Test snapshot with date",
    });

    // Re-hashing the retrieved payload should produce the exact same contentHash
    const recomputedHash = hashCanonicalJson(retrieved?.payload);
    expect(recomputedHash).toBe(created.contentHash);
  });

  it("stores Money as {amountMinorUnits: string, currency} and re-hashes to the same contentHash", async () => {
    const amount = Money.fromMinorUnits(12345n, "USD");
    const payload = {
      amount,
      description: "Test snapshot with money",
    };

    const created = await createSnapshot({
      kind: "test.money_roundtrip",
      payload,
    });

    const retrieved = await getSnapshotById(created.id);
    expect(retrieved).toBeDefined();

    // The stored payload should have Money serialized as {amountMinorUnits: string, currency}
    expect(retrieved?.payload).toEqual({
      amount: { amountMinorUnits: "12345", currency: "USD" },
      description: "Test snapshot with money",
    });

    // Re-hashing the retrieved payload should produce the exact same contentHash
    const recomputedHash = hashCanonicalJson(retrieved?.payload);
    expect(recomputedHash).toBe(created.contentHash);
  });

  it("preserves nested Date and Money in objects inside arrays after round-trip", async () => {
    const date1 = new Date("2026-01-15T08:00:00.000Z");
    const date2 = new Date("2026-02-20T16:30:45.123Z");
    const money1 = Money.fromMinorUnits(50000n, "USD");
    const money2 = Money.fromMinorUnits(75000n, "EUR");

    const payload = {
      events: [
        {
          eventId: "evt-001",
          timestamp: date1,
          amount: money1,
          description: "First event",
        },
        {
          eventId: "evt-002",
          timestamp: date2,
          amount: money2,
          description: "Second event",
        },
      ],
      metadata: {
        createdAt: new Date("2026-09-14T00:00:00.000Z"),
      },
    };

    const created = await createSnapshot({
      kind: "test.nested_roundtrip",
      payload,
    });

    const retrieved = await getSnapshotById(created.id);
    expect(retrieved).toBeDefined();

    // Verify nested structures are preserved with proper serialization
    expect(retrieved?.payload).toEqual({
      events: [
        {
          eventId: "evt-001",
          timestamp: "2026-01-15T08:00:00.000Z",
          amount: { amountMinorUnits: "50000", currency: "USD" },
          description: "First event",
        },
        {
          eventId: "evt-002",
          timestamp: "2026-02-20T16:30:45.123Z",
          amount: { amountMinorUnits: "75000", currency: "EUR" },
          description: "Second event",
        },
      ],
      metadata: {
        createdAt: "2026-09-14T00:00:00.000Z",
      },
    });

    // Re-hashing should reproduce the original contentHash
    const recomputedHash = hashCanonicalJson(retrieved?.payload);
    expect(recomputedHash).toBe(created.contentHash);
  });

  it("produces identical hashes for identical payloads built with different key insertion order", async () => {
    const sharedDate = new Date("2026-09-14T12:00:00.000Z");
    const sharedMoney = Money.fromMinorUnits(99999n, "GBP");

    // Build payload 1: order is date, money, id, name
    const payload1 = {
      timestamp: sharedDate,
      amount: sharedMoney,
      id: "test-id",
      name: "Test",
    };

    // Build payload 2: same content, different insertion order (name, id, money, date)
    const payload2: Record<string, unknown> = {};
    payload2.name = "Test";
    payload2.id = "test-id";
    payload2.amount = sharedMoney;
    payload2.timestamp = sharedDate;

    const created1 = await createSnapshot({
      kind: "test.key_order_1",
      payload: payload1,
    });

    const created2 = await createSnapshot({
      kind: "test.key_order_2",
      payload: payload2,
    });

    const retrieved1 = await getSnapshotById(created1.id);
    const retrieved2 = await getSnapshotById(created2.id);

    expect(retrieved1).toBeDefined();
    expect(retrieved2).toBeDefined();

    // After round-trip and re-hashing, both should produce identical hashes
    // (because canonical JSON sorts keys alphabetically)
    const recomputedHash1 = hashCanonicalJson(retrieved1?.payload);
    const recomputedHash2 = hashCanonicalJson(retrieved2?.payload);

    expect(recomputedHash1).toBe(recomputedHash2);
    // And both should match their original stored hashes
    expect(recomputedHash1).toBe(created1.contentHash);
    expect(recomputedHash2).toBe(created2.contentHash);
  });

  it("produces different hashes when money amount differs by one minor unit", async () => {
    const baseDate = new Date("2026-09-14T10:00:00.000Z");

    const payload1 = {
      timestamp: baseDate,
      amount: Money.fromMinorUnits(50000n, "USD"),
      reference: "test",
    };

    const payload2 = {
      timestamp: baseDate,
      amount: Money.fromMinorUnits(50001n, "USD"), // One cent different
      reference: "test",
    };

    const created1 = await createSnapshot({
      kind: "test.money_diff",
      payload: payload1,
    });

    const created2 = await createSnapshot({
      kind: "test.money_diff",
      payload: payload2,
    });

    const retrieved1 = await getSnapshotById(created1.id);
    const retrieved2 = await getSnapshotById(created2.id);

    expect(retrieved1).toBeDefined();
    expect(retrieved2).toBeDefined();

    // Even one minor unit difference should change the hash
    const recomputedHash1 = hashCanonicalJson(retrieved1?.payload);
    const recomputedHash2 = hashCanonicalJson(retrieved2?.payload);

    expect(recomputedHash1).not.toBe(recomputedHash2);
    expect(recomputedHash1).toBe(created1.contentHash);
    expect(recomputedHash2).toBe(created2.contentHash);
  });

  it("produces different hashes when date differs by one millisecond", async () => {
    const date1 = new Date("2026-09-14T12:34:56.123Z");
    const date2 = new Date("2026-09-14T12:34:56.124Z"); // One millisecond different

    const payload1 = {
      timestamp: date1,
      amount: Money.fromMinorUnits(10000n, "USD"),
      reference: "test",
    };

    const payload2 = {
      timestamp: date2,
      amount: Money.fromMinorUnits(10000n, "USD"),
      reference: "test",
    };

    const created1 = await createSnapshot({
      kind: "test.date_diff",
      payload: payload1,
    });

    const created2 = await createSnapshot({
      kind: "test.date_diff",
      payload: payload2,
    });

    const retrieved1 = await getSnapshotById(created1.id);
    const retrieved2 = await getSnapshotById(created2.id);

    expect(retrieved1).toBeDefined();
    expect(retrieved2).toBeDefined();

    // Even one millisecond difference should change the hash
    const recomputedHash1 = hashCanonicalJson(retrieved1?.payload);
    const recomputedHash2 = hashCanonicalJson(retrieved2?.payload);

    expect(recomputedHash1).not.toBe(recomputedHash2);
    expect(recomputedHash1).toBe(created1.contentHash);
    expect(recomputedHash2).toBe(created2.contentHash);
  });
});
