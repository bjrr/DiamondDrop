import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { Prisma } from "@prisma/client";

import { prisma } from "~/db/client.server";

/**
 * Slice 11 subset — M-shipment and its append-only address-change history
 * against a real database. No repository layer exists for this yet (a later
 * task, per docs/specs/SLICE-11-SHIPMENT-EVIDENCE.md §8), so these tests use
 * `prisma.shipment.*` directly for fixtures — same convention as
 * `tests/integration/warranty/warrantyClaimSchema.test.ts`.
 */

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${(seq += 1)}`;

function shipmentData(overrides: Partial<Prisma.ShipmentUncheckedCreateInput> = {}): Prisma.ShipmentUncheckedCreateInput {
  return {
    orderRef: `gid://shopify/Order/${uniq()}`,
    carrier: "USPS",
    service: "Priority Mail",
    trackingNumber: `TRACK-${uniq()}`,
    shipDate: new Date("2026-09-25"),
    addressLine1: "123 Main St",
    addressCity: "Springfield",
    addressRegion: "IL",
    addressPostalCode: "62704",
    addressCountry: "US",
    enteredByActorRef: "staff:alice",
    ...overrides,
  };
}

async function createShipment(overrides: Partial<Prisma.ShipmentUncheckedCreateInput> = {}) {
  return prisma.shipment.create({ data: shipmentData(overrides) });
}

describe("M-shipment: required fields and defaults", () => {
  it("creates a well-formed shipment with signatureRequired defaulting to false", async () => {
    const shipment = await createShipment();
    expect(shipment.trackingNumber).toBeTruthy();
    expect(shipment.signatureRequired).toBe(false);
    expect(shipment.insuredValueMinorUnits).toBeNull();
  });

  it("criterion 172 — a shipment cannot be created without a tracking number", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "shipment" (
           id, order_ref, carrier, tracking_number, ship_date,
           address_line1, address_city, address_postal_code, address_country,
           entered_by_actor_ref, updated_at
         ) VALUES (
           gen_random_uuid(), $1, 'USPS', NULL, '2026-09-25',
           'x', 'y', 'z', 'US', 'staff:alice', CURRENT_TIMESTAMP
         )`,
        `gid://shopify/Order/${uniq()}`
      )
    ).rejects.toThrow();
  });

  it("criterion 172 — a shipment cannot be created without a ship date", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "shipment" (
           id, order_ref, carrier, tracking_number, ship_date,
           address_line1, address_city, address_postal_code, address_country,
           entered_by_actor_ref, updated_at
         ) VALUES (
           gen_random_uuid(), $1, 'USPS', 'TRACK-1', NULL,
           'x', 'y', 'z', 'US', 'staff:alice', CURRENT_TIMESTAMP
         )`,
        `gid://shopify/Order/${uniq()}`
      )
    ).rejects.toThrow();
  });
});

describe("shipment_insured_value_coherent / shipment_insured_value_positive — criterion 173", () => {
  it("accepts a shipment with no insured value at all", async () => {
    const shipment = await createShipment();
    expect(shipment.insuredValueMinorUnits).toBeNull();
    expect(shipment.insuredValueCurrency).toBeNull();
  });

  it("accepts a well-formed positive insured value with currency", async () => {
    const shipment = await createShipment({ insuredValueMinorUnits: 250_000n, insuredValueCurrency: "USD" });
    expect(shipment.insuredValueMinorUnits).toBe(250_000n);
    expect(shipment.insuredValueCurrency).toBe("USD");
  });

  it("refuses an insured amount with no currency, even bypassing the application via raw SQL", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "shipment" (
           id, order_ref, carrier, tracking_number, ship_date,
           insured_value_minor_units, insured_value_currency,
           address_line1, address_city, address_postal_code, address_country,
           entered_by_actor_ref, updated_at
         ) VALUES (
           gen_random_uuid(), $1, 'USPS', $2, '2026-09-25',
           100000, NULL,
           'x', 'y', 'z', 'US', 'staff:alice', CURRENT_TIMESTAMP
         )`,
        `gid://shopify/Order/${uniq()}`,
        `TRACK-${uniq()}`
      )
    ).rejects.toThrow();
  });

  it("refuses a currency with no insured amount", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "shipment" (
           id, order_ref, carrier, tracking_number, ship_date,
           insured_value_minor_units, insured_value_currency,
           address_line1, address_city, address_postal_code, address_country,
           entered_by_actor_ref, updated_at
         ) VALUES (
           gen_random_uuid(), $1, 'USPS', $2, '2026-09-25',
           NULL, 'USD',
           'x', 'y', 'z', 'US', 'staff:alice', CURRENT_TIMESTAMP
         )`,
        `gid://shopify/Order/${uniq()}`,
        `TRACK-${uniq()}`
      )
    ).rejects.toThrow();
  });

  it("refuses a zero insured amount", async () => {
    await expect(createShipment({ insuredValueMinorUnits: 0n, insuredValueCurrency: "USD" })).rejects.toThrow();
  });

  it("refuses a negative insured amount", async () => {
    await expect(createShipment({ insuredValueMinorUnits: -1n, insuredValueCurrency: "USD" })).rejects.toThrow();
  });
});

describe("shipment_signature_required_provenance_coherent — criterion 174", () => {
  it("accepts a shipment with no signature-requirement provenance recorded (default false, never decided)", async () => {
    const shipment = await createShipment();
    expect(shipment.signatureRequiredSetByActorRef).toBeNull();
    expect(shipment.signatureRequiredSetAt).toBeNull();
  });

  it("accepts a shipment with a complete staff decision recorded", async () => {
    const shipment = await createShipment({
      signatureRequired: true,
      signatureRequiredSetByActorRef: "staff:alice",
      signatureRequiredSetAt: new Date(),
    });
    expect(shipment.signatureRequired).toBe(true);
    expect(shipment.signatureRequiredSetByActorRef).toBe("staff:alice");
  });

  it("refuses an actor with no timestamp, even bypassing the application via raw SQL", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "shipment" (
           id, order_ref, carrier, tracking_number, ship_date,
           signature_required, signature_required_set_by_actor_ref, signature_required_set_at,
           address_line1, address_city, address_postal_code, address_country,
           entered_by_actor_ref, updated_at
         ) VALUES (
           gen_random_uuid(), $1, 'USPS', $2, '2026-09-25',
           true, 'staff:alice', NULL,
           'x', 'y', 'z', 'US', 'staff:alice', CURRENT_TIMESTAMP
         )`,
        `gid://shopify/Order/${uniq()}`,
        `TRACK-${uniq()}`
      )
    ).rejects.toThrow();
  });

  it("refuses a timestamp with no actor", async () => {
    await expect(
      prisma.$executeRawUnsafe(
        `INSERT INTO "shipment" (
           id, order_ref, carrier, tracking_number, ship_date,
           signature_required, signature_required_set_by_actor_ref, signature_required_set_at,
           address_line1, address_city, address_postal_code, address_country,
           entered_by_actor_ref, updated_at
         ) VALUES (
           gen_random_uuid(), $1, 'USPS', $2, '2026-09-25',
           true, NULL, CURRENT_TIMESTAMP,
           'x', 'y', 'z', 'US', 'staff:alice', CURRENT_TIMESTAMP
         )`,
        `gid://shopify/Order/${uniq()}`,
        `TRACK-${uniq()}`
      )
    ).rejects.toThrow();
  });
});

describe("shipment is mutable by design (not append-only) — delivery/signature/address are updated in place", () => {
  it("allows updating delivery confirmation after creation", async () => {
    const shipment = await createShipment();
    const updated = await prisma.shipment.update({
      where: { id: shipment.id },
      data: { deliveredAt: new Date(), deliveryConfirmationReference: "USPS-CONFIRM-123" },
    });
    expect(updated.deliveryConfirmationReference).toBe("USPS-CONFIRM-123");
  });
});

describe("ShipmentAddressChangeEvent: append-only history — criteria 176-178", () => {
  it("records a well-formed address change", async () => {
    const shipment = await createShipment();
    const change = await prisma.shipmentAddressChangeEvent.create({
      data: {
        shipmentId: shipment.id,
        fromAddressLine1: shipment.addressLine1,
        fromAddressCity: shipment.addressCity,
        fromAddressPostalCode: shipment.addressPostalCode,
        fromAddressCountry: shipment.addressCountry,
        toAddressLine1: "456 Oak Ave",
        toAddressCity: shipment.addressCity,
        toAddressPostalCode: shipment.addressPostalCode,
        toAddressCountry: shipment.addressCountry,
        reason: "customer requested update",
        actorType: "staff",
        actorRef: "staff:alice",
      },
    });
    expect(change.toAddressLine1).toBe("456 Oak Ave");
  });

  it("rejects UPDATE and DELETE at the database level", async () => {
    const shipment = await createShipment();
    const change = await prisma.shipmentAddressChangeEvent.create({
      data: {
        shipmentId: shipment.id,
        fromAddressLine1: shipment.addressLine1,
        fromAddressCity: shipment.addressCity,
        fromAddressPostalCode: shipment.addressPostalCode,
        fromAddressCountry: shipment.addressCountry,
        toAddressLine1: "456 Oak Ave",
        toAddressCity: shipment.addressCity,
        toAddressPostalCode: shipment.addressPostalCode,
        toAddressCountry: shipment.addressCountry,
        actorType: "staff",
        actorRef: "staff:alice",
      },
    });

    await expect(
      prisma.shipmentAddressChangeEvent.update({ where: { id: change.id }, data: { reason: "edited" } })
    ).rejects.toThrow();
    await expect(prisma.shipmentAddressChangeEvent.delete({ where: { id: change.id } })).rejects.toThrow();
  });

  it("rejects TRUNCATE at the database level", async () => {
    await expect(prisma.$executeRawUnsafe(`TRUNCATE TABLE "shipment_address_change_event"`)).rejects.toThrow();
  });

  it("retrievable together with its shipment in one query", async () => {
    const shipment = await createShipment();
    await prisma.shipmentAddressChangeEvent.create({
      data: {
        shipmentId: shipment.id,
        fromAddressLine1: shipment.addressLine1,
        fromAddressCity: shipment.addressCity,
        fromAddressPostalCode: shipment.addressPostalCode,
        fromAddressCountry: shipment.addressCountry,
        toAddressLine1: "456 Oak Ave",
        toAddressCity: shipment.addressCity,
        toAddressPostalCode: shipment.addressPostalCode,
        toAddressCountry: shipment.addressCountry,
        actorType: "staff",
        actorRef: "staff:alice",
      },
    });

    const full = await prisma.shipment.findUniqueOrThrow({
      where: { id: shipment.id },
      include: { addressChanges: true },
    });
    expect(full.addressChanges).toHaveLength(1);
  });

  it("an unrelated shipment id does not error, but a nonexistent one refuses the foreign key", async () => {
    await expect(
      prisma.shipmentAddressChangeEvent.create({
        data: {
          shipmentId: randomUUID(),
          fromAddressLine1: "x",
          fromAddressCity: "y",
          fromAddressPostalCode: "z",
          fromAddressCountry: "US",
          toAddressLine1: "a",
          toAddressCity: "b",
          toAddressPostalCode: "c",
          toAddressCountry: "US",
          actorType: "staff",
          actorRef: "staff:alice",
        },
      })
    ).rejects.toThrow();
  });
});
