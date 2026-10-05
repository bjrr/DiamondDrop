import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  consumeUploadDestination,
  recordIssuedUploadDestination,
} from "~/db/repositories/uploadDestinationRepository.server";

/**
 * The SHARED issued-destination service, against real Postgres.
 *
 * These are the security proofs that used to live in the warranty-specific
 * repository's own suite. They are preserved case for case — the refactor to
 * one implementation must not quietly cost a single guarantee — and extended
 * with the cross-purpose cases that only became possible, and necessary, once
 * one table served more than one flow.
 */

const FUTURE = () => new Date(Date.now() + 15 * 60 * 1000);
const PAST = () => new Date(Date.now() - 60 * 1000);

async function issue(
  overrides: Partial<{
    purpose: "warranty_claim" | "custom_jewelry_project";
    ownerId: string;
    customerRef: string;
    storageKey: string;
    expiresAt: Date;
  }> = {}
) {
  const input = {
    purpose: overrides.purpose ?? ("warranty_claim" as const),
    ownerId: overrides.ownerId ?? randomUUID(),
    customerRef: overrides.customerRef ?? `gid://shopify/Customer/${Date.now()}`,
    kind: "photo" as const,
    contentType: "image/jpeg",
    storageKey: overrides.storageKey ?? `evidence/${randomUUID()}/photo/${randomUUID()}.jpg`,
    expiresAt: overrides.expiresAt ?? FUTURE(),
  };
  await recordIssuedUploadDestination(input);
  return input;
}

describe("an issued destination is persisted with exactly what it was issued for", () => {
  it("records purpose, owner, customer and key", async () => {
    const input = await issue();
    const row = await prisma.warrantyClaimUploadDestination.findUniqueOrThrow({
      where: { storageKey: input.storageKey },
    });
    expect(row.purpose).toBe("warranty_claim");
    expect(row.ownerId).toBe(input.ownerId);
    expect(row.customerRef).toBe(input.customerRef);
    expect(row.consumedAt).toBeNull();
  });
});

describe("consumption refuses everything it should, identically", () => {
  it("a key never issued is refused", async () => {
    const refused = await consumeUploadDestination({
      purpose: "warranty_claim",
      ownerId: randomUUID(),
      customerRef: "gid://shopify/Customer/1",
      storageKey: `evidence/${randomUUID()}.jpg`,
    });
    expect(refused).toBe(false);
  });

  it("a key issued for a DIFFERENT owner is refused", async () => {
    const input = await issue();
    expect(
      await consumeUploadDestination({ ...input, ownerId: randomUUID() })
    ).toBe(false);
  });

  it("CUSTOMER A CANNOT USE CUSTOMER B'S DESTINATION", async () => {
    const input = await issue({ customerRef: "gid://shopify/Customer/AAA" });
    expect(
      await consumeUploadDestination({ ...input, customerRef: "gid://shopify/Customer/BBB" })
    ).toBe(false);
    // ...and the destination is still unspent, so the rightful owner is not
    // locked out by someone else's failed attempt.
    expect(await consumeUploadDestination(input)).toBe(true);
  });

  it("an expired destination is refused", async () => {
    const input = await issue({ expiresAt: PAST() });
    expect(await consumeUploadDestination(input)).toBe(false);
  });

  it("a destination is SINGLE USE", async () => {
    const input = await issue();
    expect(await consumeUploadDestination(input)).toBe(true);
    expect(await consumeUploadDestination(input)).toBe(false);
  });

  it("RACE SAFETY: of two concurrent attempts on the same key, exactly one succeeds", async () => {
    // The whole reason consumption is one atomic conditional UPDATE rather
    // than a read-then-write.
    const input = await issue();
    const [a, b] = await Promise.all([consumeUploadDestination(input), consumeUploadDestination(input)]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });
});

/**
 * CROSS-PURPOSE ISOLATION (owner-required 2026-10-05).
 *
 * One table now serves warranty claims and Custom Jewelry enquiries. A
 * destination issued for one must be unusable on the other, and that must
 * hold because the row does not match — not because a caller remembered to
 * compare a field.
 */
describe("a destination cannot cross purposes", () => {
  it("a WARRANTY-issued key is rejected by Custom Jewelry", async () => {
    const input = await issue({ purpose: "warranty_claim" });
    expect(await consumeUploadDestination({ ...input, purpose: "custom_jewelry_project" })).toBe(false);
    // Still unspent: the failed cross-purpose attempt must not burn it.
    expect(await consumeUploadDestination(input)).toBe(true);
  });

  it("a CUSTOM JEWELRY-issued key is rejected by Warranty", async () => {
    const input = await issue({ purpose: "custom_jewelry_project" });
    expect(await consumeUploadDestination({ ...input, purpose: "warranty_claim" })).toBe(false);
    expect(await consumeUploadDestination(input)).toBe(true);
  });

  it("the same owner id under two purposes yields two independent destinations", async () => {
    // Owner ids are UUIDs from different tables and could collide in
    // principle. Purpose is what keeps them apart, so this asserts the
    // collision case directly rather than trusting improbability.
    const ownerId = randomUUID();
    const customerRef = "gid://shopify/Customer/SHARED";
    const warranty = await issue({ purpose: "warranty_claim", ownerId, customerRef });
    const custom = await issue({ purpose: "custom_jewelry_project", ownerId, customerRef });

    expect(await consumeUploadDestination(warranty)).toBe(true);
    // Consuming the warranty one must leave the Custom Jewelry one untouched.
    expect(await consumeUploadDestination(custom)).toBe(true);
  });

  it("every refusal looks identical from outside — not an enumeration oracle", async () => {
    const real = await issue({ purpose: "warranty_claim" });
    const wrongPurpose = await consumeUploadDestination({ ...real, purpose: "custom_jewelry_project" });
    const wrongCustomer = await consumeUploadDestination({ ...real, customerRef: "gid://shopify/Customer/ZZZ" });
    const neverIssued = await consumeUploadDestination({
      ...real,
      storageKey: `evidence/${randomUUID()}.jpg`,
    });
    // A caller cannot tell which condition failed, which is what stops this
    // being usable to probe for another customer's storage key.
    expect([wrongPurpose, wrongCustomer, neverIssued]).toEqual([false, false, false]);
  });
});
