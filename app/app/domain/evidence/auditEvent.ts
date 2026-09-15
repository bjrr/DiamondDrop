import type { ActorType } from "./types";

export interface AuditEventInput {
  actorType: ActorType;
  actorRef?: string | null;
  action: string;
  entityType: string;
  entityId: string;
  /**
   * Widened to `unknown` (corrected 2026-09-14, architect review finding 4
   * follow-up) — see the matching comment on `SnapshotInput.payload` in
   * snapshot.ts for the full reasoning. `null` remains a legal value
   * (trivially, since `null` is a subtype of `unknown`) for "there was no
   * prior/resulting state."
   */
  before?: unknown;
  after?: unknown;
  reason?: string | null;
}

export class InvalidAuditEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAuditEventError";
  }
}

/** Validates that the minimum required audit fields are present and non-blank. */
export function buildAuditEventRecord(input: AuditEventInput): AuditEventInput {
  if (!input.action || input.action.trim() === "") {
    throw new InvalidAuditEventError("action is required");
  }
  if (!input.entityType || input.entityType.trim() === "") {
    throw new InvalidAuditEventError("entityType is required");
  }
  if (!input.entityId || input.entityId.trim() === "") {
    throw new InvalidAuditEventError("entityId is required");
  }
  return input;
}
