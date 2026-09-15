import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";

// Acceptance criterion 8: UPDATE/DELETE against policy_version,
// acknowledgment, snapshot, or audit_event must fail at the database
// level — not merely be blocked by application code. Every assertion here
// goes straight through the Prisma client (no repository layer) precisely
// to prove the database itself refuses the mutation.
describe("append-only evidence tables (database-level enforcement)", () => {
  let policyVersionId: string;

  beforeAll(async () => {
    const policy = await prisma.policyVersion.create({
      data: {
        slug: `trigger-test-${randomUUID()}`,
        version: 1,
        effectiveFrom: new Date(),
        text: "Original text",
        contentHash: "test-hash",
      },
    });
    policyVersionId = policy.id;
  });

  it("rejects UPDATE on policy_version", async () => {
    await expect(
      prisma.policyVersion.update({ where: { id: policyVersionId }, data: { text: "Edited text" } })
    ).rejects.toThrow();
  });

  it("rejects DELETE on policy_version", async () => {
    await expect(prisma.policyVersion.delete({ where: { id: policyVersionId } })).rejects.toThrow();
  });

  it("rejects UPDATE and DELETE on acknowledgment", async () => {
    const ack = await prisma.acknowledgment.create({
      data: {
        exactText: "I acknowledge this is a Final Sale purchase.",
        policyVersionId,
        acknowledgedAt: new Date(),
        affirmativeActionLabel: "Clicked 'I Acknowledge'",
      },
    });

    await expect(
      prisma.acknowledgment.update({ where: { id: ack.id }, data: { exactText: "Edited" } })
    ).rejects.toThrow();
    await expect(prisma.acknowledgment.delete({ where: { id: ack.id } })).rejects.toThrow();
  });

  it("rejects UPDATE and DELETE on snapshot", async () => {
    const snap = await prisma.snapshot.create({
      data: { kind: "test", payload: { a: 1 }, contentHash: "hash" },
    });

    await expect(
      prisma.snapshot.update({ where: { id: snap.id }, data: { contentHash: "changed" } })
    ).rejects.toThrow();
    await expect(prisma.snapshot.delete({ where: { id: snap.id } })).rejects.toThrow();
  });

  it("rejects UPDATE and DELETE on audit_event", async () => {
    const event = await prisma.auditEvent.create({
      data: {
        actorType: "system",
        action: "test.action",
        entityType: "test_entity",
        entityId: "1",
      },
    });

    await expect(
      prisma.auditEvent.update({ where: { id: event.id }, data: { reason: "changed" } })
    ).rejects.toThrow();
    await expect(prisma.auditEvent.delete({ where: { id: event.id } })).rejects.toThrow();
  });

  // Finding 3 (architect review, 2026-09-14): row-level BEFORE UPDATE/DELETE
  // triggers do not fire on TRUNCATE — Postgres treats it as a distinct
  // statement type. A BEFORE TRUNCATE ... FOR EACH STATEMENT trigger closes
  // that gap. Exercised via raw SQL since Prisma's client has no TRUNCATE
  // API — this is exactly the "careless raw SQL" scenario being defended
  // against.
  it("rejects TRUNCATE on all four evidence tables", async () => {
    await expect(prisma.$executeRawUnsafe(`TRUNCATE TABLE "policy_version"`)).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe(`TRUNCATE TABLE "acknowledgment"`)).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe(`TRUNCATE TABLE "snapshot"`)).rejects.toThrow();
    await expect(prisma.$executeRawUnsafe(`TRUNCATE TABLE "audit_event"`)).rejects.toThrow();
  });

  it("rejects a multi-table TRUNCATE that includes even one evidence table", async () => {
    await expect(
      prisma.$executeRawUnsafe(`TRUNCATE TABLE "policy_version", "snapshot"`)
    ).rejects.toThrow();
  });

  it("still allows normal INSERT (create) on all four tables", async () => {
    // Sanity check: the trigger targets UPDATE/DELETE only, not INSERT.
    await expect(
      prisma.policyVersion.create({
        data: {
          slug: `trigger-test-insert-${randomUUID()}`,
          version: 1,
          effectiveFrom: new Date(),
          text: "Insert should still work",
          contentHash: "insert-hash",
        },
      })
    ).resolves.toBeDefined();
  });
});
