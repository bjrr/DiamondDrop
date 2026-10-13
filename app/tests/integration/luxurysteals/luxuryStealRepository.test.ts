import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import { EmptyLuxuryStealBulkAssignmentError } from "~/domain/luxurysteals/assignment";
import {
  assignLuxurySteal,
  bulkAssignLuxuryStealForProduct,
  getLuxuryStealAssignment,
  getLuxuryStealOrderCheck,
  isMasterVariantLuxurySteal,
  listLuxuryStealAssignmentsForProduct,
  listLuxuryStealOrderChecksForOrder,
  listLuxuryStealProductAssignments,
  recordLuxuryStealOrderCheck,
  setLuxuryStealAssignment,
  unassignLuxurySteal,
} from "~/db/repositories/luxuryStealRepository.server";

/**
 * Slice 3 task 3-1 — M11 (variant-level assignment) and M12 (order-check
 * evidence) against a real database. Money-critical / evidence-critical per
 * the assigning message: criterion 147 (a mixed variant set) is asserted
 * directly, and the append-only trigger is proven at the database level, not
 * merely by application-level discipline — same reasoning as
 * `tests/integration/db/appendOnlyTriggers.test.ts`.
 */

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${(seq += 1)}`;

async function createProduct(name = "luxury steal fixture") {
  return prisma.masterProduct.create({
    data: {
      name: `${name} ${uniq()}`,
      category: "ring",
      sizeAxis: "none",
      allowedSizeMin: "0",
      allowedSizeMax: "0",
      sizeIncrement: "1",
      baseSize: "0",
      offeredMetals: ["gold"],
      status: "active",
    },
  });
}

async function createVariant(masterProductId: string, overrides: { shopifyVariantGid?: string } = {}) {
  return prisma.masterVariant.create({
    data: {
      masterProductId,
      metal: "gold",
      purity: "GOLD_14K",
      baseWeightGrams: "3.0000",
      weightPerFullSizeGrams: "0.0000",
      status: "active",
      laborSource: "india",
      shopifyVariantGid: overrides.shopifyVariantGid,
    },
  });
}

async function createAcknowledgment() {
  const policy = await prisma.policyVersion.create({
    data: {
      slug: `luxury-steals-final-sale-${uniq()}`,
      version: 1,
      effectiveFrom: new Date(),
      text: "FINAL SALE ACKNOWLEDGMENT",
      contentHash: `hash-${uniq()}`,
    },
  });
  return prisma.acknowledgment.create({
    data: {
      exactText: "I understand that this item is a Luxury Steal and is FINAL SALE.",
      policyVersionId: policy.id,
      acknowledgedAt: new Date(),
      affirmativeActionLabel: "I Understand & Agree",
    },
  });
}

describe("M11 — variant-level Luxury Steal assignment", () => {
  it("defaults to false on a newly created variant", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id);

    expect(variant.isLuxurySteal).toBe(false);
    await expect(isMasterVariantLuxurySteal(variant.id)).resolves.toBe(false);
  });

  it("round-trips assign and unassign through the controlled admin path", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id);

    const assigned = await assignLuxurySteal(variant.id);
    expect(assigned.isLuxurySteal).toBe(true);
    await expect(isMasterVariantLuxurySteal(variant.id)).resolves.toBe(true);

    const unassigned = await unassignLuxurySteal(variant.id);
    expect(unassigned.isLuxurySteal).toBe(false);
    await expect(isMasterVariantLuxurySteal(variant.id)).resolves.toBe(false);
  });

  it("setLuxuryStealAssignment writes the exact requested value", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id);

    const result = await setLuxuryStealAssignment(variant.id, true);
    expect(result).toEqual({ masterVariantId: variant.id, isLuxurySteal: true });
  });

  it("returns false for a variant id that does not exist (criterion 150's fail-safe read)", async () => {
    await expect(isMasterVariantLuxurySteal(randomUUID())).resolves.toBe(false);
  });

  it("criterion 147 — one assigned variant does not make normal sibling variants Final Sale", async () => {
    const product = await createProduct("mixed variant set");
    const assignedVariant = await createVariant(product.id);
    const siblingA = await createVariant(product.id);
    const siblingB = await createVariant(product.id);

    await assignLuxurySteal(assignedVariant.id);

    await expect(isMasterVariantLuxurySteal(assignedVariant.id)).resolves.toBe(true);
    await expect(isMasterVariantLuxurySteal(siblingA.id)).resolves.toBe(false);
    await expect(isMasterVariantLuxurySteal(siblingB.id)).resolves.toBe(false);

    const assignments = await listLuxuryStealAssignmentsForProduct(product.id);
    expect(assignments).toHaveLength(3);
    expect(assignments.find((a) => a.masterVariantId === assignedVariant.id)?.isLuxurySteal).toBe(true);
    expect(assignments.find((a) => a.masterVariantId === siblingA.id)?.isLuxurySteal).toBe(false);
    expect(assignments.find((a) => a.masterVariantId === siblingB.id)?.isLuxurySteal).toBe(false);
  });

  it("the bulk 'apply to all variants' helper writes every variant of the product and nothing else", async () => {
    const product = await createProduct("bulk apply target");
    const v1 = await createVariant(product.id);
    const v2 = await createVariant(product.id);
    const v3 = await createVariant(product.id);

    const otherProduct = await createProduct("unrelated product");
    const unrelatedVariant = await createVariant(otherProduct.id);

    const result = await bulkAssignLuxuryStealForProduct(product.id, true);

    expect(new Set(result.updatedMasterVariantIds)).toEqual(new Set([v1.id, v2.id, v3.id]));
    await expect(isMasterVariantLuxurySteal(v1.id)).resolves.toBe(true);
    await expect(isMasterVariantLuxurySteal(v2.id)).resolves.toBe(true);
    await expect(isMasterVariantLuxurySteal(v3.id)).resolves.toBe(true);
    // Nothing else — the unrelated product's variant is untouched.
    await expect(isMasterVariantLuxurySteal(unrelatedVariant.id)).resolves.toBe(false);
  });

  it("the bulk helper also clears every variant when unassigning", async () => {
    const product = await createProduct("bulk clear target");
    const v1 = await createVariant(product.id);
    const v2 = await createVariant(product.id);
    await bulkAssignLuxuryStealForProduct(product.id, true);

    const result = await bulkAssignLuxuryStealForProduct(product.id, false);

    expect(new Set(result.updatedMasterVariantIds)).toEqual(new Set([v1.id, v2.id]));
    await expect(isMasterVariantLuxurySteal(v1.id)).resolves.toBe(false);
    await expect(isMasterVariantLuxurySteal(v2.id)).resolves.toBe(false);
  });

  it("the bulk helper refuses a product with no variants rather than silently writing nothing", async () => {
    const emptyProduct = await createProduct("no variants yet");
    await expect(bulkAssignLuxuryStealForProduct(emptyProduct.id, true)).rejects.toBeInstanceOf(
      EmptyLuxuryStealBulkAssignmentError
    );
  });

  it("listLuxuryStealAssignmentsForProduct reports every variant, including its Shopify gid, for the metafield sync to consume", async () => {
    const product = await createProduct("sync consumer fixture");
    const gid = `gid://shopify/ProductVariant/${uniq()}`;
    const variant = await createVariant(product.id, { shopifyVariantGid: gid });
    await assignLuxurySteal(variant.id);

    const assignments = await listLuxuryStealAssignmentsForProduct(product.id);
    expect(assignments).toEqual([
      { masterVariantId: variant.id, shopifyVariantGid: gid, isLuxurySteal: true },
    ]);
  });

  it("getLuxuryStealAssignment reads one variant's current state — task 3-2b's per-sync read", async () => {
    const product = await createProduct("single read fixture");
    const gid = `gid://shopify/ProductVariant/${uniq()}`;
    const variant = await createVariant(product.id, { shopifyVariantGid: gid });
    await assignLuxurySteal(variant.id);

    const assignment = await getLuxuryStealAssignment(variant.id);
    expect(assignment).toEqual({ masterVariantId: variant.id, shopifyVariantGid: gid, isLuxurySteal: true });
  });

  it("getLuxuryStealAssignment returns null for an unknown variant id, rather than throwing", async () => {
    await expect(getLuxuryStealAssignment(randomUUID())).resolves.toBeNull();
  });

  it("listLuxuryStealProductAssignments lists every product with its variants — the admin page's read", async () => {
    const product = await createProduct("admin listing fixture");
    const v1 = await createVariant(product.id);
    const v2 = await createVariant(product.id);
    await assignLuxurySteal(v1.id);

    const listing = await listLuxuryStealProductAssignments(product.name);
    expect(listing).toHaveLength(1);
    expect(listing[0]?.masterProductId).toBe(product.id);
    const variantIds = new Set(listing[0]?.variants.map((v) => v.masterVariantId));
    expect(variantIds).toEqual(new Set([v1.id, v2.id]));
    expect(listing[0]?.variants.find((v) => v.masterVariantId === v1.id)?.isLuxurySteal).toBe(true);
    expect(listing[0]?.variants.find((v) => v.masterVariantId === v2.id)?.isLuxurySteal).toBe(false);
  });

  it("listLuxuryStealProductAssignments filters by a case-insensitive product-name query", async () => {
    const product = await createProduct("Searchable Sapphire Ring");
    await createVariant(product.id);

    const matched = await listLuxuryStealProductAssignments("sapphire");
    expect(matched.some((p) => p.masterProductId === product.id)).toBe(true);

    const unmatched = await listLuxuryStealProductAssignments(`no-such-product-${uniq()}`);
    expect(unmatched.some((p) => p.masterProductId === product.id)).toBe(false);
  });
});

describe("M12 — order-boundary evidence (luxury_steal_order_check)", () => {
  it("records a matched outcome with the acknowledgment reference", async () => {
    const product = await createProduct();
    const variant = await createVariant(product.id);
    await assignLuxurySteal(variant.id);
    const ack = await createAcknowledgment();

    const orderRef = `gid://shopify/Order/${uniq()}`;
    const lineRef = `gid://shopify/LineItem/${uniq()}`;

    const result = await recordLuxuryStealOrderCheck({
      orderRef,
      lineRef,
      variantRef: variant.id,
      matchedAcknowledgmentId: ack.id,
    });

    expect(result.outcome).toBe("matched");
    expect(result.created).toBe(true);

    const recorded = await getLuxuryStealOrderCheck(orderRef, lineRef);
    expect(recorded?.outcome).toBe("matched");
    expect(recorded?.matchedAcknowledgmentId).toBe(ack.id);
  });

  it("records an unmatched outcome — criterion 140: whether a line matched is recorded either way", async () => {
    const orderRef = `gid://shopify/Order/${uniq()}`;
    const lineRef = `gid://shopify/LineItem/${uniq()}`;

    const result = await recordLuxuryStealOrderCheck({
      orderRef,
      lineRef,
      variantRef: randomUUID(),
      matchedAcknowledgmentId: null,
    });

    expect(result.outcome).toBe("unmatched");

    const recorded = await getLuxuryStealOrderCheck(orderRef, lineRef);
    expect(recorded?.outcome).toBe("unmatched");
    expect(recorded?.matchedAcknowledgmentId).toBeNull();
  });

  it("criterion 139 — a redelivered orders/create does not create a second check row", async () => {
    const orderRef = `gid://shopify/Order/${uniq()}`;
    const lineRef = `gid://shopify/LineItem/${uniq()}`;
    const variantRef = randomUUID();

    const first = await recordLuxuryStealOrderCheck({
      orderRef,
      lineRef,
      variantRef,
      matchedAcknowledgmentId: null,
    });
    const redelivered = await recordLuxuryStealOrderCheck({
      orderRef,
      lineRef,
      variantRef,
      matchedAcknowledgmentId: null,
    });

    expect(redelivered.created).toBe(false);
    expect(redelivered.id).toBe(first.id);

    const rowCount = await prisma.luxuryStealOrderCheck.count({ where: { orderRef, lineRef } });
    expect(rowCount).toBe(1);
  });

  it("listLuxuryStealOrderChecksForOrder returns every line checked for that order", async () => {
    const orderRef = `gid://shopify/Order/${uniq()}`;
    await recordLuxuryStealOrderCheck({
      orderRef,
      lineRef: `gid://shopify/LineItem/${uniq()}`,
      variantRef: randomUUID(),
      matchedAcknowledgmentId: null,
    });
    await recordLuxuryStealOrderCheck({
      orderRef,
      lineRef: `gid://shopify/LineItem/${uniq()}`,
      variantRef: randomUUID(),
      matchedAcknowledgmentId: null,
    });

    const checks = await listLuxuryStealOrderChecksForOrder(orderRef);
    expect(checks).toHaveLength(2);
    expect(checks.every((c) => c.orderRef === orderRef)).toBe(true);
  });

  it("rejects UPDATE and DELETE at the database level (append-only)", async () => {
    const orderRef = `gid://shopify/Order/${uniq()}`;
    const lineRef = `gid://shopify/LineItem/${uniq()}`;
    const created = await recordLuxuryStealOrderCheck({
      orderRef,
      lineRef,
      variantRef: randomUUID(),
      matchedAcknowledgmentId: null,
    });

    await expect(
      prisma.luxuryStealOrderCheck.update({ where: { id: created.id }, data: { outcome: "matched" } })
    ).rejects.toThrow();
    await expect(prisma.luxuryStealOrderCheck.delete({ where: { id: created.id } })).rejects.toThrow();
  });

  it("rejects TRUNCATE at the database level", async () => {
    await expect(
      prisma.$executeRawUnsafe(`TRUNCATE TABLE "luxury_steal_order_check"`)
    ).rejects.toThrow();
  });

  it("the database CHECK constraint refuses a matched outcome with no acknowledgment id, even bypassing the repository", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "luxury_steal_order_check" (id, order_ref, line_ref, variant_ref, matched_acknowledgment_id, outcome) ` +
          `VALUES (gen_random_uuid(), $1, $2, $3, NULL, 'matched')`,
        `gid://shopify/Order/${uniq()}`,
        `gid://shopify/LineItem/${uniq()}`,
        randomUUID()
      )
    ).rejects.toThrow();
  });

  it("the database CHECK constraint refuses an unmatched outcome that still names an acknowledgment", async () => {
    const ack = await createAcknowledgment();
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "luxury_steal_order_check" (id, order_ref, line_ref, variant_ref, matched_acknowledgment_id, outcome) ` +
          `VALUES (gen_random_uuid(), $1, $2, $3, $4, 'unmatched')`,
        `gid://shopify/Order/${uniq()}`,
        `gid://shopify/LineItem/${uniq()}`,
        randomUUID(),
        ack.id
      )
    ).rejects.toThrow();
  });
});
