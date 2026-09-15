export type IdempotencyStatus = "pending" | "succeeded" | "failed" | "in_doubt";

export interface IdempotencyRecord<TResult = unknown> {
  key: string;
  operationType: string;
  status: IdempotencyStatus;
  requestPayload: unknown;
  resultPayload: TResult | null;
  errorMessage: string | null;
}

/**
 * Storage boundary for the idempotency wrapper (spec §0.7). Defined here,
 * in domain/, as a pure interface with no I/O of its own — the real
 * implementation (Prisma-backed) lives in
 * app/db/repositories/idempotencyKeyRepository.server.ts. This keeps
 * executeIdempotent itself fully unit-testable against an in-memory fake.
 */
export interface IdempotencyRepository {
  /**
   * Atomically creates a pending row iff `key` does not already exist.
   * Must be backed by a UNIQUE database constraint, not a read-then-write
   * check, so concurrent callers cannot both receive `true`.
   *
   * @returns true if this call created the row; false if a row for this key already existed.
   */
  tryCreatePending(key: string, operationType: string, requestPayload: unknown): Promise<boolean>;
  findByKey(key: string): Promise<IdempotencyRecord | null>;
  recordSuccess(key: string, result: unknown): Promise<void>;
  /** Definitive provider rejection — the operation is known not to have taken effect. */
  recordFailure(key: string, errorMessage: string): Promise<void>;
  /**
   * Ambiguous outcome (timeout, aborted connection, unrecognized/unclassified
   * error) — the operation may have actually succeeded at the provider
   * before the response was lost. Never auto-retried; surfaces for staff
   * review the same way a crashed pending key does.
   */
  recordInDoubt(key: string, errorMessage: string): Promise<void>;
}

/**
 * Caller-supplied classification of a thrown error, used to decide whether
 * `executeIdempotent` records `failed` (spec §0.7 item 6) or `in_doubt`.
 * The wrapper is domain-agnostic and cannot itself know whether a given
 * provider error proves the operation did not happen, so it asks the
 * caller — and defaults to the safe answer (`in_doubt`) for anything the
 * caller doesn't recognize or doesn't supply a classifier for at all.
 */
export type IdempotentErrorClassification = "failed" | "in_doubt";
export type ClassifyIdempotentError = (error: unknown) => IdempotentErrorClassification;
