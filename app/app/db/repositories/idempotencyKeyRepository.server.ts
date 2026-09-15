import { Prisma } from "@prisma/client";

import type { IdempotencyRecord, IdempotencyRepository } from "~/domain/idempotency";

import { prisma } from "../client.server";

/** Prisma-backed implementation of the domain's IdempotencyRepository interface. */
export const idempotencyKeyRepository: IdempotencyRepository = {
  async tryCreatePending(key, operationType, requestPayload) {
    try {
      await prisma.idempotencyKey.create({
        data: {
          key,
          operationType,
          requestPayload: (requestPayload ?? undefined) as Prisma.InputJsonValue | undefined,
          status: "pending",
        },
      });
      return true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        return false;
      }
      throw error;
    }
  },

  async findByKey(key): Promise<IdempotencyRecord | null> {
    const row = await prisma.idempotencyKey.findUnique({ where: { key } });
    if (!row) return null;
    return {
      key: row.key,
      operationType: row.operationType,
      status: row.status,
      requestPayload: row.requestPayload,
      resultPayload: row.resultPayload,
      errorMessage: row.errorMessage,
    };
  },

  async recordSuccess(key, result) {
    await prisma.idempotencyKey.update({
      where: { key },
      data: {
        status: "succeeded",
        resultPayload: (result ?? undefined) as Prisma.InputJsonValue | undefined,
        completedAt: new Date(),
      },
    });
  },

  async recordFailure(key, errorMessage) {
    await prisma.idempotencyKey.update({
      where: { key },
      data: { status: "failed", errorMessage, completedAt: new Date() },
    });
  },

  // Ambiguous outcome (spec §0.7 item 6): deliberately does NOT set
  // completedAt. An in-doubt key is unresolved, not finished — completedAt
  // is reserved for a terminal, known outcome (succeeded/failed), so staff
  // triage tooling can tell "we know what happened" apart from "we don't".
  async recordInDoubt(key, errorMessage) {
    await prisma.idempotencyKey.update({
      where: { key },
      data: { status: "in_doubt", errorMessage },
    });
  },
};

/**
 * Staff-review primitives for resolving an in-doubt key. No admin route
 * exists yet — Slice 0's non-goals explicitly exclude admin screens beyond
 * health — these are the building blocks a later slice's admin UI wires
 * up to actually resolve a crashed/ambiguous idempotency key.
 *
 * Both `pending` (committed, crashed before any result was recorded) and
 * `in_doubt` (a classified ambiguous error) are unresolved states that
 * require the same staff review — neither may be auto-retried.
 */
export async function findPendingIdempotencyKeys() {
  return prisma.idempotencyKey.findMany({
    where: { status: { in: ["pending", "in_doubt"] } },
    orderBy: { createdAt: "asc" },
  });
}

export async function resolveIdempotencyKeyByStaff(
  key: string,
  resolution: { status: "succeeded" | "failed" | "in_doubt"; resultPayload?: unknown; errorMessage?: string }
) {
  await prisma.idempotencyKey.update({
    where: { key },
    data: {
      status: resolution.status,
      resultPayload: (resolution.resultPayload ?? undefined) as Prisma.InputJsonValue | undefined,
      errorMessage: resolution.errorMessage ?? null,
      completedAt: new Date(),
    },
  });
}
