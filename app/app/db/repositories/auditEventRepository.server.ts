import type { Prisma } from "@prisma/client";

import { buildAuditEventRecord, type AuditEventInput } from "~/domain/evidence/auditEvent";

import { prisma } from "../client.server";

/**
 * Create/read only — audit_event is append-only at the database level
 * (spec §0.5). There is no update or delete method here on purpose.
 */
export async function createAuditEvent(input: AuditEventInput) {
  const record = buildAuditEventRecord(input);
  return prisma.auditEvent.create({
    data: {
      actorType: record.actorType,
      actorRef: record.actorRef ?? null,
      action: record.action,
      entityType: record.entityType,
      entityId: record.entityId,
      before: (record.before ?? undefined) as Prisma.InputJsonValue | undefined,
      after: (record.after ?? undefined) as Prisma.InputJsonValue | undefined,
      reason: record.reason ?? null,
    },
  });
}

export async function getAuditEventById(id: string) {
  return prisma.auditEvent.findUnique({ where: { id } });
}

export async function listAuditEventsForEntity(entityType: string, entityId: string) {
  return prisma.auditEvent.findMany({
    where: { entityType, entityId },
    orderBy: { createdAt: "asc" },
  });
}
