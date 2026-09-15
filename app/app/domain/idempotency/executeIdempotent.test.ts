import { describe, expect, it, vi } from "vitest";

import { IdempotentOperationFailedError, InDoubtIdempotencyError } from "./errors";
import { executeIdempotent } from "./executeIdempotent";
import type { IdempotencyRecord, IdempotencyRepository } from "./types";

function createFakeRepository(seed?: IdempotencyRecord) {
  const records = new Map<string, IdempotencyRecord>();
  if (seed) records.set(seed.key, seed);

  const repository: IdempotencyRepository = {
    async tryCreatePending(key, operationType, requestPayload) {
      if (records.has(key)) return false;
      records.set(key, {
        key,
        operationType,
        status: "pending",
        requestPayload,
        resultPayload: null,
        errorMessage: null,
      });
      return true;
    },
    async findByKey(key) {
      return records.get(key) ?? null;
    },
    async recordSuccess(key, result) {
      const existing = records.get(key);
      if (existing) records.set(key, { ...existing, status: "succeeded", resultPayload: result });
    },
    async recordFailure(key, errorMessage) {
      const existing = records.get(key);
      if (existing) records.set(key, { ...existing, status: "failed", errorMessage });
    },
    async recordInDoubt(key, errorMessage) {
      const existing = records.get(key);
      if (existing) records.set(key, { ...existing, status: "in_doubt", errorMessage });
    },
  };

  return { repository, records };
}

describe("executeIdempotent", () => {
  it("executes the operation exactly once for a fresh key and records success", async () => {
    const { repository, records } = createFakeRepository();
    const operation = vi.fn().mockResolvedValue({ refundId: "r_1" });

    const result = await executeIdempotent(repository, "key-1", "refund", { amount: 100 }, operation);

    expect(result).toEqual({ refundId: "r_1" });
    expect(operation).toHaveBeenCalledTimes(1);
    expect(records.get("key-1")?.status).toBe("succeeded");
  });

  it("returns the stored result on a sequential retry without calling the operation again", async () => {
    const { repository } = createFakeRepository();
    const operation = vi.fn().mockResolvedValue({ refundId: "r_1" });

    const first = await executeIdempotent(repository, "key-1", "refund", {}, operation);
    const second = await executeIdempotent(repository, "key-1", "refund", {}, operation);

    expect(first).toEqual(second);
    expect(operation).toHaveBeenCalledTimes(1);
  });

  it("records failure and rethrows the original error, without marking succeeded (definitive classification)", async () => {
    const { repository, records } = createFakeRepository();
    const operation = vi.fn().mockRejectedValue(new Error("processor declined"));

    await expect(
      executeIdempotent(repository, "key-1", "refund", {}, operation, () => "failed")
    ).rejects.toThrow("processor declined");
    expect(records.get("key-1")?.status).toBe("failed");
  });

  it("retrying a previously failed key throws without re-executing the operation", async () => {
    const { repository } = createFakeRepository();
    const failingOperation = vi.fn().mockRejectedValue(new Error("processor declined"));
    await expect(
      executeIdempotent(repository, "key-1", "refund", {}, failingOperation, () => "failed")
    ).rejects.toThrow();

    const retryOperation = vi.fn();
    await expect(executeIdempotent(repository, "key-1", "refund", {}, retryOperation)).rejects.toThrow(
      IdempotentOperationFailedError
    );
    expect(retryOperation).not.toHaveBeenCalled();
  });

  // Finding 2 (architect review, 2026-09-14): an ambiguous failure must
  // never be recorded as `failed` — that invites staff to retry with a
  // fresh key, which is how duplicate customer value (e.g. a double
  // refund) gets created.
  it("defaults to recording an unclassified error as in_doubt, not failed", async () => {
    const { repository, records } = createFakeRepository();
    const operation = vi.fn().mockRejectedValue(new Error("ECONNRESET"));

    await expect(executeIdempotent(repository, "key-1", "refund", {}, operation)).rejects.toThrow(
      "ECONNRESET"
    );
    expect(records.get("key-1")?.status).toBe("in_doubt");
  });

  it("records in_doubt when the caller's classifier explicitly says so, and does not treat it as a terminal failure", async () => {
    const { repository, records } = createFakeRepository();
    const timeoutError = new Error("request timed out");
    const operation = vi.fn().mockRejectedValue(timeoutError);
    const classifyError = (error: unknown) =>
      error instanceof Error && error.message.includes("timed out") ? ("in_doubt" as const) : ("failed" as const);

    await expect(
      executeIdempotent(repository, "key-1", "refund", {}, operation, classifyError)
    ).rejects.toThrow("request timed out");
    expect(records.get("key-1")?.status).toBe("in_doubt");
  });

  it("a caller's classifier can still mark a recognized definitive error as failed", async () => {
    const { repository, records } = createFakeRepository();
    const validationError = new Error("invalid refund amount");
    const operation = vi.fn().mockRejectedValue(validationError);
    const classifyError = (error: unknown) =>
      error instanceof Error && error.message.includes("invalid") ? ("failed" as const) : ("in_doubt" as const);

    await expect(
      executeIdempotent(repository, "key-1", "refund", {}, operation, classifyError)
    ).rejects.toThrow("invalid refund amount");
    expect(records.get("key-1")?.status).toBe("failed");
  });

  it("a retried key left in_doubt is not treated as a terminal failure and still refuses to auto-retry", async () => {
    const { repository } = createFakeRepository();
    const operation = vi.fn().mockRejectedValue(new Error("ECONNRESET"));
    await expect(executeIdempotent(repository, "key-1", "refund", {}, operation)).rejects.toThrow();

    const retryOperation = vi.fn();
    await expect(executeIdempotent(repository, "key-1", "refund", {}, retryOperation)).rejects.toThrow(
      InDoubtIdempotencyError
    );
    expect(retryOperation).not.toHaveBeenCalled();
  });

  it("surfaces a pending key with no recorded result as in-doubt and never auto-retries", async () => {
    const { repository } = createFakeRepository({
      key: "key-1",
      operationType: "refund",
      status: "pending",
      requestPayload: {},
      resultPayload: null,
      errorMessage: null,
    });
    const operation = vi.fn();

    await expect(executeIdempotent(repository, "key-1", "refund", {}, operation)).rejects.toThrow(
      InDoubtIdempotencyError
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it("never executes the operation when a concurrent caller already committed the pending row", async () => {
    // Simulates the loser of a real create-race: another process already
    // committed the pending row a moment before this call ran.
    const { repository } = createFakeRepository({
      key: "key-1",
      operationType: "refund",
      status: "pending",
      requestPayload: {},
      resultPayload: null,
      errorMessage: null,
    });
    const operation = vi.fn();

    await expect(executeIdempotent(repository, "key-1", "refund", {}, operation)).rejects.toThrow(
      InDoubtIdempotencyError
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it("treats an explicit in_doubt status the same way as pending — no auto-retry", async () => {
    const { repository } = createFakeRepository({
      key: "key-1",
      operationType: "refund",
      status: "in_doubt",
      requestPayload: {},
      resultPayload: null,
      errorMessage: null,
    });
    const operation = vi.fn();

    await expect(executeIdempotent(repository, "key-1", "refund", {}, operation)).rejects.toThrow(
      InDoubtIdempotencyError
    );
    expect(operation).not.toHaveBeenCalled();
  });

  it("different keys execute independently", async () => {
    const { repository } = createFakeRepository();
    const operation = vi.fn().mockImplementation(async () => ({ id: Math.random() }));

    await executeIdempotent(repository, "key-a", "refund", {}, operation);
    await executeIdempotent(repository, "key-b", "refund", {}, operation);

    expect(operation).toHaveBeenCalledTimes(2);
  });
});
