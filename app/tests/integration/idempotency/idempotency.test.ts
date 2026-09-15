import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { idempotencyKeyRepository } from "~/db/repositories/idempotencyKeyRepository.server";
import { executeIdempotent } from "~/domain/idempotency";

describe("outbound idempotency wrapper against real Postgres", () => {
  it("executes the operation once; a sequential retry returns the stored result with no second call", async () => {
    const key = randomUUID();
    let callCount = 0;
    const operation = async () => {
      callCount += 1;
      return { refundId: `r_${key}` };
    };

    const first = await executeIdempotent(idempotencyKeyRepository, key, "refund_test", { amount: 100 }, operation);
    const second = await executeIdempotent(idempotencyKeyRepository, key, "refund_test", { amount: 100 }, operation);

    expect(first).toEqual(second);
    expect(callCount).toBe(1);
  });

  it("refuses a concurrent same-key caller as in-doubt while the first is still in flight, without re-executing", async () => {
    const key = randomUUID();
    let callCount = 0;

    let enter!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });

    const operation = async () => {
      callCount += 1;
      enter();
      await gate;
      return { refundId: `r_${key}` };
    };

    // Hold the first call inside the operation so the key is provably
    // `pending` when the second arrives. A timing-based version of this is
    // flaky: if the first call finishes first, the second correctly returns
    // the stored result instead — also right, but it leaves the
    // pending/in-doubt branch untested.
    const first = executeIdempotent(idempotencyKeyRepository, key, "refund_test", {}, operation);
    await entered;

    await expect(
      executeIdempotent(idempotencyKeyRepository, key, "refund_test", {}, operation)
    ).rejects.toThrow(/in-doubt/i);
    expect(callCount).toBe(1); // the second caller never ran the operation

    open();
    await expect(first).resolves.toEqual({ refundId: `r_${key}` });
    expect(callCount).toBe(1);
  });

  it("executes exactly once under genuinely simultaneous same-key calls, whatever the interleaving", async () => {
    const key = randomUUID();
    let callCount = 0;
    const operation = async () => {
      callCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { refundId: `r_${key}` };
    };

    const results = await Promise.allSettled([
      executeIdempotent(idempotencyKeyRepository, key, "refund_test", {}, operation),
      executeIdempotent(idempotencyKeyRepository, key, "refund_test", {}, operation),
    ]);

    // The UNIQUE constraint on idempotency_key.key — not application
    // logic — is what decides this: exactly one caller ever runs the
    // operation, regardless of timing. The loser either reads back the
    // stored result (winner already recorded success) or is refused as
    // in-doubt (winner still pending). Both are correct and neither
    // re-executes, so which one happens must not be asserted.
    expect(callCount).toBe(1);
    for (const result of results) {
      if (result.status === "fulfilled") {
        expect(result.value).toEqual({ refundId: `r_${key}` });
      } else {
        expect(String(result.reason)).toMatch(/in-doubt/i);
      }
    }
  });

  it("surfaces a crashed (pending-forever) key as in-doubt without auto-retrying", async () => {
    const key = randomUUID();
    // Simulate a crash: commit the pending row directly, bypassing
    // executeIdempotent's own operation call, so nothing ever records a result.
    const created = await idempotencyKeyRepository.tryCreatePending(key, "refund_test", { amount: 500 });
    expect(created).toBe(true);

    const operation = async () => {
      throw new Error("must not be called for an in-doubt key");
    };

    await expect(
      executeIdempotent(idempotencyKeyRepository, key, "refund_test", { amount: 500 }, operation)
    ).rejects.toThrow(/in-doubt/i);
  });

  it("recordFailure marks the key failed and a retry throws without re-executing", async () => {
    const key = randomUUID();
    const failingOperation = async () => {
      throw new Error("processor declined");
    };

    await expect(
      executeIdempotent(
        idempotencyKeyRepository,
        key,
        "refund_test",
        {},
        failingOperation,
        () => "failed" // a definitive provider rejection
      )
    ).rejects.toThrow("processor declined");

    const stored = await idempotencyKeyRepository.findByKey(key);
    expect(stored?.status).toBe("failed");

    let retried = false;
    await expect(
      executeIdempotent(idempotencyKeyRepository, key, "refund_test", {}, async () => {
        retried = true;
        return {};
      })
    ).rejects.toThrow(/previously failed/i);
    expect(retried).toBe(false);
  });

  // Finding 2 (architect review, 2026-09-14): an ambiguous error (timeout,
  // aborted connection) must be persisted as in_doubt against the real
  // idempotency_key table, never as failed, so staff never see a false
  // "definitely did not happen" and retry into a duplicate refund.
  it("records an ambiguous error as in_doubt (not failed) and a retry stays blocked without re-executing", async () => {
    const key = randomUUID();
    const timeoutOperation = async () => {
      throw new Error("ETIMEDOUT contacting payment processor");
    };

    // No classifier supplied: default must be the safe choice, in_doubt.
    await expect(
      executeIdempotent(idempotencyKeyRepository, key, "refund_test", {}, timeoutOperation)
    ).rejects.toThrow("ETIMEDOUT");

    const stored = await idempotencyKeyRepository.findByKey(key);
    expect(stored?.status).toBe("in_doubt");
    expect(stored?.errorMessage).toContain("ETIMEDOUT");

    let retried = false;
    await expect(
      executeIdempotent(idempotencyKeyRepository, key, "refund_test", {}, async () => {
        retried = true;
        return {};
      })
    ).rejects.toThrow(/in-doubt/i);
    expect(retried).toBe(false);
  });
});
