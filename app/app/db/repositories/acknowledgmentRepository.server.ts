import { buildAcknowledgmentRecord } from "~/domain/evidence/acknowledgment";

import { prisma } from "../client.server";

/**
 * Create/read only — acknowledgment is append-only at the database level
 * (spec §0.5). There is no update or delete method here on purpose.
 */
export async function createAcknowledgment(input: unknown) {
  const record = buildAcknowledgmentRecord(input);
  return prisma.acknowledgment.create({ data: record });
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
