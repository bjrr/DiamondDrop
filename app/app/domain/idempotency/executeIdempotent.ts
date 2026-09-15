import { IdempotentOperationFailedError, InDoubtIdempotencyError } from "./errors";
import type { ClassifyIdempotentError, IdempotencyRepository } from "./types";

/**
 * Default classifier: safe-by-default. Spec §0.7 item 6 requires that an
 * error the wrapper cannot prove is a definitive provider rejection must be
 * recorded as `in_doubt`, never `failed` — recording an ambiguous failure
 * as `failed` is exactly what invites staff to retry with a fresh key and
 * create duplicate customer value (e.g. a duplicate refund).
 */
const defaultClassifyError: ClassifyIdempotentError = () => "in_doubt";

/**
 * Generic outbound money-operation idempotency wrapper (spec §0.7). Every
 * future value-moving operation (refund, merchandise credit,
 * discount/benefit issuance) routes through this — nothing here is
 * coupled to any one domain.
 *
 * Sequence:
 *   1. Commit a UNIQUE idempotency_key row BEFORE the external call.
 *   2. Perform the operation.
 *   3. Record the result against the key.
 *
 * A retry with the same key returns the stored result and performs no
 * second external call (acceptance criterion 16). A key that exists with
 * no recorded result is — by construction — indistinguishable between
 * "another call is genuinely still in flight" and "the process that owned
 * it crashed mid-operation": the row is committed (not held under an
 * open transaction) specifically so a crash leaves it durably visible
 * rather than locked forever, which is what makes it recoverable at all,
 * but it also means a live concurrent caller looks identical to a dead
 * one. This wrapper treats both cases the same way — surface as in-doubt
 * for staff review — rather than guess (acceptance criteria 17, 18).
 *
 * ARCHITECT RULING, 2026-09-14 (slice 0 acceptance review). This replaces
 * the earlier "flagged for architect review" note. The ruling has two
 * halves, and they are not the same kind of statement:
 *
 * 1. THE BEHAVIOUR IS UPHELD, PERMANENTLY. A key that exists with no
 *    recorded result must NEVER auto-retry the operation, and both "a
 *    concurrent caller is live" and "the owner crashed" must refuse to
 *    execute. No later slice may add an age threshold that RE-EXECUTES a
 *    stale pending key. That proposal is rejected in advance, so that a
 *    future reader who notices the stale-reclaim pattern in
 *    `claimWebhookEventForProcessing` does not port it here: reclaiming a
 *    crashed *webhook* claim is safe only because event processing is
 *    required to be idempotent (CLAUDE.md), and a `refundCreate` is
 *    precisely the thing that is not. The asymmetry between the two
 *    modules is deliberate. Re-executing a pending money operation on the
 *    assumption that the previous owner died is how a customer gets
 *    refunded twice.
 *
 * 2. THE OBSERVABILITY IS NOT UPHELD — REQUIRED BEFORE SLICE 4 (the first
 *    slice that moves money; not required for slices 1–3). Collapsing both
 *    states into a single `InDoubtIdempotencyError`, and enrolling both
 *    into one staff queue via `findPendingIdempotencyKeys()`, means two
 *    calls a second apart during a staff double-click put a key into
 *    manual review that needs none. Once slice 8 batches Group Buy
 *    equalization refunds across a whole campaign, that noise is what
 *    makes staff stop reading the queue — and the queue is where the
 *    genuinely in-doubt refunds live. A safety mechanism that is routinely
 *    wrong is a safety mechanism that gets ignored. Required change:
 *      - distinguish by the existing `createdAt` age — a `pending` row
 *        younger than a short threshold is IN FLIGHT, older is CRASHED;
 *      - throw two distinct error types: an in-flight error (transient,
 *        caller may back off and re-poll, NOT surfaced to staff) and an
 *        in-doubt error (crashed, or a classified `in_doubt`, staff review
 *        required);
 *      - NEITHER type executes the operation. The distinction is for
 *        triage only, never for control flow around the money movement;
 *      - `findPendingIdempotencyKeys()` filters to `in_doubt` plus
 *        `pending` older than the threshold.
 *    Tracked as F-5's sibling in docs/specs/SLICE-0-FINDINGS.md.
 *
 * Also unresolved and untested (same gate): if `recordSuccess` throws
 * after the operation already succeeded, the catch below classifies the
 * *persistence* error, defaults to `in_doubt`, and if `recordInDoubt` also
 * fails the row stays `pending`. That is the correct safe direction — an
 * unresolved key blocks rather than duplicates — but it is currently
 * neither documented behaviour nor covered by a test.
 *
 * `classifyError` (corrected 2026-09-14, spec §0.7 item 6): a definitive
 * provider rejection (validation error, explicit error response proving the
 * operation did not occur) may be classified `failed`. A network timeout,
 * aborted connection, or ambiguous 5xx — where the operation may have
 * actually succeeded before the response was lost — must be classified
 * `in_doubt`. Defaults to `in_doubt` for every error when the caller
 * supplies no classifier, or for any error the caller's classifier doesn't
 * explicitly call out: default to safe, not to convenient.
 */
export async function executeIdempotent<TResult>(
  repository: IdempotencyRepository,
  key: string,
  operationType: string,
  requestPayload: unknown,
  operation: () => Promise<TResult>,
  classifyError: ClassifyIdempotentError = defaultClassifyError
): Promise<TResult> {
  const created = await repository.tryCreatePending(key, operationType, requestPayload);

  if (created) {
    try {
      const result = await operation();
      await repository.recordSuccess(key, result);
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (classifyError(error) === "failed") {
        await repository.recordFailure(key, message);
      } else {
        await repository.recordInDoubt(key, message);
      }
      throw error;
    }
  }

  // Another caller already holds this key. Never execute a second time —
  // read back what happened (or hasn't happened yet) instead.
  const existing = await repository.findByKey(key);
  if (!existing) {
    // Vanishingly unlikely race between the failed create and this read;
    // treat conservatively rather than assume anything about it.
    throw new InDoubtIdempotencyError(key);
  }

  switch (existing.status) {
    case "succeeded":
      return existing.resultPayload as TResult;
    case "failed":
      throw new IdempotentOperationFailedError(key, existing.errorMessage);
    case "pending":
    case "in_doubt":
    default:
      throw new InDoubtIdempotencyError(key);
  }
}
