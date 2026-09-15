export class InDoubtIdempotencyError extends Error {
  constructor(public readonly key: string) {
    super(
      `Idempotency key "${key}" is in-doubt: it was committed but has no recorded result. ` +
        "This can mean another call is genuinely still in flight, or that the process performing " +
        "the operation crashed mid-flight — both look identical from here. This never auto-retries " +
        "the underlying operation; it must be resolved by staff review."
    );
    this.name = "InDoubtIdempotencyError";
  }
}

export class IdempotentOperationFailedError extends Error {
  constructor(
    public readonly key: string,
    public readonly originalMessage: string | null
  ) {
    super(`Idempotency key "${key}" previously failed: ${originalMessage ?? "unknown error"}`);
    this.name = "IdempotentOperationFailedError";
  }
}
