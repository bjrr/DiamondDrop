import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";

// Acceptance criterion 9: editing a live policy creates a NEW
// policy_version row; acknowledgments already recorded against the prior
// version must still resolve to the exact text that was displayed at the
// time — never the edited text.
describe("policy version editing", () => {
  it("keeps a prior acknowledgment resolving to the prior exact text after a new version is created", async () => {
    const slug = `policy-versioning-${randomUUID()}`;

    const v1 = await prisma.policyVersion.create({
      data: { slug, version: 1, effectiveFrom: new Date(), text: "Version 1 text", contentHash: "h1" },
    });

    const ack = await prisma.acknowledgment.create({
      data: {
        exactText: v1.text,
        policyVersionId: v1.id,
        acknowledgedAt: new Date(),
        affirmativeActionLabel: "Clicked accept",
      },
    });

    // "Editing" a live policy means creating a new version row — it can
    // never mean mutating v1 (the append-only trigger would reject that
    // anyway; see appendOnlyTriggers.test.ts).
    const v2 = await prisma.policyVersion.create({
      data: { slug, version: 2, effectiveFrom: new Date(), text: "Version 2 text", contentHash: "h2" },
    });

    const resolved = await prisma.acknowledgment.findUniqueOrThrow({
      where: { id: ack.id },
      include: { policyVersion: true },
    });

    expect(resolved.policyVersion.text).toBe("Version 1 text");
    expect(resolved.policyVersion.version).toBe(1);
    expect(v2.text).toBe("Version 2 text");
    expect(v2.id).not.toBe(v1.id);
  });
});
