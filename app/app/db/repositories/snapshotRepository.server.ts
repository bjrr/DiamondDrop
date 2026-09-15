import type { Prisma } from "@prisma/client";

import { buildSnapshotRecord, type SnapshotInput } from "~/domain/evidence/snapshot";

import { prisma } from "../client.server";

/**
 * Create/read only — snapshot is append-only at the database level (spec
 * §0.5). There is no update or delete method here on purpose.
 */
export async function createSnapshot(input: SnapshotInput) {
  const record = buildSnapshotRecord(input);
  return prisma.snapshot.create({
    data: {
      kind: record.kind,
      payload: record.payload as Prisma.InputJsonValue,
      contentHash: record.contentHash,
    },
  });
}

export async function getSnapshotById(id: string) {
  return prisma.snapshot.findUnique({ where: { id } });
}

export async function listSnapshotsByKind(kind: string) {
  return prisma.snapshot.findMany({ where: { kind }, orderBy: { createdAt: "asc" } });
}
