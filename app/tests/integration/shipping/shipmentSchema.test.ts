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
    // D29-D31 wiring (migration 20260925040000) added signatureRequiredSource:
    // override provenance is only coherent alongside source='staff_override'
    // now — see shipment_signature_source_coherent below.
    const shipment = await createShipment({
      signatureRequired: true,
      signatureRequiredSource: "staff_override",
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

describe("D29-D31 wiring — new columns and their CHECK constraints", () => {
  it("defaults signatureRequiredSource to 'rule' with no override provenance", async () => {
    const shipment = await createShipment();
    expect(shipment.signatureRequiredSource).toBe("rule");
    expect(shipment.signatureRequiredSetByActorRef).toBeNull();
    expect(shipment.signatureRequiredSetAt).toBeNull();
    expect(shipment.signatureServiceUsed).toBeNull();
    expect(shipment.computedMerchandiseValueMinorUnits).toBeNull();
  });

  describe("shipment_computed_merchandise_value_coherent / non_negative", () => {
    it("accepts a well-formed positive computed merchandise value", async () => {
      const shipment = await createShipment({
        computedMerchandiseValueMinorUnits: 150_00n,
        computedMerchandiseValueCurrency: "USD",
      });
      expect(shipment.computedMerchandiseValueMinorUnits).toBe(150_00n);
    });

    it("accepts zero (an all-promotional-item shipment)", async () => {
      const shipment = await createShipment({
        computedMerchandiseValueMinorUnits: 0n,
        computedMerchandiseValueCurrency: "USD",
      });
      expect(shipment.computedMerchandiseValueMinorUnits).toBe(0n);
    });

    it("refuses an amount with no currency, even bypassing the application via raw SQL", async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "shipment" (
             id, order_ref, carrier, tracking_number, ship_date,
             computed_merchandise_value_minor_units, computed_merchandise_value_currency,
             address_line1, address_city, address_postal_code, address_country,
             entered_by_actor_ref, updated_at
           ) VALUES (
             gen_random_uuid(), $1, 'USPS', $2, '2026-09-25',
             15000, NULL,
             'x', 'y', 'z', 'US', 'staff:alice', CURRENT_TIMESTAMP
           )`,
          `gid://shopify/Order/${uniq()}`,
          `TRACK-${uniq()}`
        )
      ).rejects.toThrow();
    });

    it("refuses a negative computed merchandise value", async () => {
      await expect(
        createShipment({ computedMerchandiseValueMinorUnits: -1n, computedMerchandiseValueCurrency: "USD" })
      ).rejects.toThrow();
    });
  });

  describe("shipment_signature_source_coherent", () => {
    it("accepts source='rule' with no provenance", async () => {
      const shipment = await createShipment({ signatureRequiredSource: "rule" });
      expect(shipment.signatureRequiredSource).toBe("rule");
    });

    it("accepts source='staff_override' with complete provenance and required=true", async () => {
      const shipment = await createShipment({
        signatureRequired: true,
        signatureRequiredSource: "staff_override",
        signatureRequiredSetByActorRef: "staff:alice",
        signatureRequiredSetAt: new Date(),
      });
      expect(shipment.signatureRequiredSource).toBe("staff_override");
    });

    it("refuses source='staff_override' with no actor, even bypassing the application via raw SQL", async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "shipment" (
             id, order_ref, carrier, tracking_number, ship_date,
             signature_required, signature_required_source, signature_required_set_by_actor_ref, signature_required_set_at,
             address_line1, address_city, address_postal_code, address_country,
             entered_by_actor_ref, updated_at
           ) VALUES (
             gen_random_uuid(), $1, 'USPS', $2, '2026-09-25',
             true, 'staff_override', NULL, CURRENT_TIMESTAMP,
             'x', 'y', 'z', 'US', 'staff:alice', CURRENT_TIMESTAMP
           )`,
          `gid://shopify/Order/${uniq()}`,
          `TRACK-${uniq()}`
        )
      ).rejects.toThrow();
    });

    it("refuses source='rule' that still carries override provenance", async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "shipment" (
             id, order_ref, carrier, tracking_number, ship_date,
             signature_required_source, signature_required_set_by_actor_ref, signature_required_set_at,
             address_line1, address_city, address_postal_code, address_country,
             entered_by_actor_ref, updated_at
           ) VALUES (
             gen_random_uuid(), $1, 'USPS', $2, '2026-09-25',
             'rule', 'staff:alice', CURRENT_TIMESTAMP,
             'x', 'y', 'z', 'US', 'staff:alice', CURRENT_TIMESTAMP
           )`,
          `gid://shopify/Order/${uniq()}`,
          `TRACK-${uniq()}`
        )
      ).rejects.toThrow();
    });
  });

  describe("shipment_signature_override_requires_true", () => {
    it("refuses source='staff_override' with signatureRequired=false, even with complete provenance", async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "shipment" (
             id, order_ref, carrier, tracking_number, ship_date,
             signature_required, signature_required_source, signature_required_set_by_actor_ref, signature_required_set_at,
             address_line1, address_city, address_postal_code, address_country,
             entered_by_actor_ref, updated_at
           ) VALUES (
             gen_random_uuid(), $1, 'USPS', $2, '2026-09-25',
             false, 'staff_override', 'staff:alice', CURRENT_TIMESTAMP,
             'x', 'y', 'z', 'US', 'staff:alice', CURRENT_TIMESTAMP
           )`,
          `gid://shopify/Order/${uniq()}`,
          `TRACK-${uniq()}`
        )
      ).rejects.toThrow();
    });
  });

  describe("signatureServiceUsed — evidence, independent of what was required", () => {
    it("can record 'standard' even when the rule/override did not require a signature at all", async () => {
      const shipment = await createShipment({
        signatureRequired: false,
        signatureRequiredSource: "rule",
        signatureServiceUsed: "standard",
      });
      expect(shipment.signatureRequired).toBe(false);
      expect(shipment.signatureServiceUsed).toBe("standard");
    });

    it("can record 'none' even when a signature was required — the mismatch is not refused; it is evidence", async () => {
      const shipment = await createShipment({
        signatureRequired: true,
        signatureRequiredSource: "staff_override",
        signatureRequiredSetByActorRef: "staff:alice",
        signatureRequiredSetAt: new Date(),
        signatureServiceUsed: "none",
      });
      expect(shipment.signatureRequired).toBe(true);
      expect(shipment.signatureServiceUsed).toBe("none");
    });
  });

  describe("insured value and computed merchandise value may differ visibly (D30/G2)", () => {
    it("stores both figures independently, with no equality enforced", async () => {
      const shipment = await createShipment({
        computedMerchandiseValueMinorUnits: 500_000_00n,
        computedMerchandiseValueCurrency: "USD",
        insuredValueMinorUnits: 50_000_00n, // far below the computed figure — a real G2 scenario (carrier cap)
        insuredValueCurrency: "USD",
      });
      expect(shipment.computedMerchandiseValueMinorUnits).toBe(500_000_00n);
      expect(shipment.insuredValueMinorUnits).toBe(50_000_00n);
    });
  });
});

describe("D32 — insurance provider identity + verification provenance (migration 20260926070000)", () => {
  it("accepts a shipment with no provider/verification recorded at all", async () => {
    const shipment = await createShipment();
    expect(shipment.insuranceProviderId).toBeNull();
    expect(shipment.insuranceCoverageVerifiedAt).toBeNull();
    expect(shipment.insuranceCoverageVerifiedByActorRef).toBeNull();
  });

  it("accepts a provider id together with a reference", async () => {
    const shipment = await createShipment({
      insuranceProviderId: "jewelers_mutual",
      insuranceReference: "JM-CERT-1",
      insuredValueMinorUnits: 100_000_00n,
      insuredValueCurrency: "USD",
    });
    expect(shipment.insuranceProviderId).toBe("jewelers_mutual");
  });

  describe("shipment_insurance_provider_requires_reference", () => {
    it("refuses a provider id with no reference, even bypassing the application via raw SQL", async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "shipment" (
             id, order_ref, carrier, tracking_number, ship_date,
             insurance_provider_id, insurance_reference,
             address_line1, address_city, address_postal_code, address_country,
             entered_by_actor_ref, updated_at
           ) VALUES (
             gen_random_uuid(), $1, 'USPS', $2, '2026-09-25',
             'jewelers_mutual', NULL,
             'x', 'y', 'z', 'US', 'staff:alice', CURRENT_TIMESTAMP
           )`,
          `gid://shopify/Order/${uniq()}`,
          `TRACK-${uniq()}`
        )
      ).rejects.toThrow();
    });
  });

  describe("shipment_insurance_verification_provenance_coherent", () => {
    it("accepts a complete verification (verified-at and verified-by together)", async () => {
      const shipment = await createShipment({
        insuranceProviderId: "jewelers_mutual",
        insuranceReference: "JM-CERT-2",
        insuranceCoverageVerifiedAt: new Date(),
        insuranceCoverageVerifiedByActorRef: "staff:alice",
      });
      expect(shipment.insuranceCoverageVerifiedByActorRef).toBe("staff:alice");
    });

    it("refuses a verified-at timestamp with no verifying actor, even bypassing the application via raw SQL", async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "shipment" (
             id, order_ref, carrier, tracking_number, ship_date,
             insurance_provider_id, insurance_reference,
             insurance_coverage_verified_at, insurance_coverage_verified_by_actor_ref,
             address_line1, address_city, address_postal_code, address_country,
             entered_by_actor_ref, updated_at
           ) VALUES (
             gen_random_uuid(), $1, 'USPS', $2, '2026-09-25',
             'jewelers_mutual', 'JM-CERT-3',
             CURRENT_TIMESTAMP, NULL,
             'x', 'y', 'z', 'US', 'staff:alice', CURRENT_TIMESTAMP
           )`,
          `gid://shopify/Order/${uniq()}`,
          `TRACK-${uniq()}`
        )
      ).rejects.toThrow();
    });

    it("refuses a verifying actor with no timestamp", async () => {
      await expect(
        createShipment({
          insuranceProviderId: "jewelers_mutual",
          insuranceReference: "JM-CERT-4",
          insuranceCoverageVerifiedByActorRef: "staff:alice",
        })
      ).rejects.toThrow();
    });
  });

  describe("shipment_insurance_verification_requires_provider_and_reference", () => {
    it("refuses a verification with no provider/reference on record at all, even bypassing the application via raw SQL", async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "shipment" (
             id, order_ref, carrier, tracking_number, ship_date,
             insurance_coverage_verified_at, insurance_coverage_verified_by_actor_ref,
             address_line1, address_city, address_postal_code, address_country,
             entered_by_actor_ref, updated_at
           ) VALUES (
             gen_random_uuid(), $1, 'USPS', $2, '2026-09-25',
             CURRENT_TIMESTAMP, 'staff:alice',
             'x', 'y', 'z', 'US', 'staff:alice', CURRENT_TIMESTAMP
           )`,
          `gid://shopify/Order/${uniq()}`,
          `TRACK-${uniq()}`
        )
      ).rejects.toThrow();
    });

    it("refuses a verification that names a provider but no reference, even bypassing the application via raw SQL", async () => {
      await expect(
        prisma.$executeRawUnsafe(
          `INSERT INTO "shipment" (
             id, order_ref, carrier, tracking_number, ship_date,
             insurance_provider_id, insurance_coverage_verified_at, insurance_coverage_verified_by_actor_ref,
             address_line1, address_city, address_postal_code, address_country,
             entered_by_actor_ref, updated_at
           ) VALUES (
             gen_random_uuid(), $1, 'USPS', $2, '2026-09-25',
             'jewelers_mutual', CURRENT_TIMESTAMP, 'staff:alice',
             'x', 'y', 'z', 'US', 'staff:alice', CURRENT_TIMESTAMP
           )`,
          `gid://shopify/Order/${uniq()}`,
          `TRACK-${uniq()}`
        )
      ).rejects.toThrow();
    });
  });
});
