import { Prisma } from "@prisma/client";

import { prisma } from "../client.server";

/**
 * The notification dedup ledger (Slice 2 stage 2A, owner §7/§15). Pairs
 * with `admin_alert_notification`'s own unique constraint on
 * `(source_kind, source_id, event)` — see the migration and model doc
 * comments in `schema.prisma`.
 *
 * INSERT-AND-CATCH-UNIQUE IS THE DEDUP, not a read-then-write check (same
 * discipline `idempotency_key` and `webhook_event` already use in this
 * codebase). `recordAlertNotification` always attempts the insert; a
 * unique-constraint collision means this (episode, event) pair has already
 * been notified, and is reported back as `recorded: false` rather than
 * thrown — a duplicate notification attempt is an expected outcome of a
 * retried job step, not an error condition.
 */

export interface RecordAlertNotificationInput {
  sourceKind: "calculation_failure" | "sync_failure";
  sourceId: string;
  event: "opened" | "suspended" | "resolved";
  masterVariantId: string;
  emailDeliveryStatus: "sent" | "skipped_unconfigured" | "failed";
  /** Required for `skipped_unconfigured`/`failed`; must be null for `sent`. */
  emailDeliveryReason: string | null;
  /** Required for `sent`; must be null otherwise. */
  emailProviderMessageId: string | null;
  now?: Date;
}

export interface RecordAlertNotificationResult {
  /** False when a row for this (sourceKind, sourceId, event) already existed — the dedup firing, not an error. */
  recorded: boolean;
  notificationId?: string;
}

export async function recordAlertNotification(
  input: RecordAlertNotificationInput
): Promise<RecordAlertNotificationResult> {
  const now = input.now ?? new Date();

  try {
    const created = await prisma.adminAlertNotification.create({
      data: {
        sourceKind: input.sourceKind,
        sourceId: input.sourceId,
        event: input.event,
        masterVariantId: input.masterVariantId,
        emailDeliveryStatus: input.emailDeliveryStatus,
        emailDeliveryReason: input.emailDeliveryReason,
        emailProviderMessageId: input.emailProviderMessageId,
        createdAt: now,
      },
    });

    return { recorded: true, notificationId: created.id };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      return { recorded: false };
    }
    throw error;
  }
}
