import { buildPolicyVersionRecord } from "~/domain/evidence/policyVersion";

import { prisma } from "../client.server";

/**
 * Create/read only — policy_version is append-only at the database level
 * (spec §0.5). There is no update or delete method here on purpose.
 */
export async function createPolicyVersion(input: unknown) {
  const record = buildPolicyVersionRecord(input);
  return prisma.policyVersion.create({ data: record });
}

export async function getPolicyVersionById(id: string) {
  return prisma.policyVersion.findUnique({ where: { id } });
}

export async function getPolicyVersionBySlugAndVersion(slug: string, version: number) {
  return prisma.policyVersion.findUnique({ where: { slug_version: { slug, version } } });
}

/** The currently effective version for a slug — highest version number. */
export async function getLatestPolicyVersion(slug: string) {
  return prisma.policyVersion.findFirst({ where: { slug }, orderBy: { version: "desc" } });
}
