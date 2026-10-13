import type { Prisma } from "@prisma/client";

import { buildAcknowledgmentRecord } from "~/domain/evidence/acknowledgment";

import { prisma } from "../client.server";

/**
 * Create/read only — acknowledgment is append-only at the database level
 * (spec §0.5). There is no update or delete method here on purpose.
 *
 * Accepts an optional transaction client so an acknowledgment can be written
 * in the SAME transaction as the thing that references it. Without it, a
 * caller whose own insert fails leaves an orphaned acknowledgment row behind
 * — and since the table is append-only, an orphan can never be cleaned up.
 */
export async function createAcknowledgment(
  input: unknown,
  tx: Prisma.TransactionClient | typeof prisma = prisma
) {
  const record = buildAcknowledgmentRecord(input);
  return tx.acknowledgment.create({ data: record });
}

export async function getAcknowledgmentById(id: string) {
  return prisma.acknowledgment.findUnique({ where: { id }, include: { policyVersion: true } });
}

export async function listAcknowledgmentsByOrderRef(orderRef: string) {
  return prisma.acknowledgment.findMany({ where: { orderRef }, include: { policyVersion: true } });
}

export async function listAcknowledgmentsByCampaignRef(campaignRef: string) {
  return prisma.acknowledgment.findMany({ where: { campaignRef }, include: { policyVersion: true } });
}
