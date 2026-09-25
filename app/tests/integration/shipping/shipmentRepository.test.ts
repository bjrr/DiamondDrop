import { randomUUID } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  applyShipmentSignatureOverride,
  createShipment,
  getShipmentForStaff,
  InvalidShipmentAddressChangeError,
  InvalidShipmentInsuredValueError,
  InvalidSignatureOverrideError,
  InvalidSignatureServiceUsedError,
  recordShipmentAddressChange,
  recordShipmentSignatureServiceUsed,
  ShipmentNotFoundError,
} from "~/db/repositories/shipmentRepository.server";
import { EmptyShipmentContentsError, type ShipmentMerchandiseLine } from "~/domain/shipping/merchandiseValue";
import type { ShipmentAddress } from "~/domain/shipping/addressChange";
import { prisma } from "~/db/client.server";

/**
 * D29-D31 wiring, repository behaviour (docs/ARCHITECTURE-MVP1.md, resolved
 * 2026-09-25; app/app/domain/shipping/**, committed 7fc17f0). Schema-level
 * CHECK constraints are covered in `shipmentSchema.test.ts`; this file
 * exercises the repository's orchestration — calling the domain functions,
 * never re-deriving them — against a real database.
 */

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${(seq += 1)}`;

const ADDRESS: ShipmentAddress = {
  line1: "123 Main St",
  line2: null,
  city: "Springfield",
  region: "IL",
  postalCode: "62704",
  country: "US",
};

function line(overrides: Partial<ShipmentMerchandiseLine> = {}): ShipmentMerchandiseLine {
  return { quantity: 1, merchandiseValueMinorUnits: 150_00n, currency: "USD", ...overrides };
}

function baseInput(overrides: Partial<Parameters<typeof createShipment>[0]> = {}) {
  return {
    orderRef: `gid://shopify/Order/${uniq()}`,
    carrier: "USPS",
    trackingNumber: `TRACK-${uniq()}`,
    shipDate: new Date("2026-09-25"),
    contents: [line()],
    address: ADDRESS,
    enteredByActorRef: "staff:alice",
    ...overrides,
  };
}

describe("createShipment — D29 merchandise value + D31 rule, computed and stored", () => {
  it("computes and stores the merchandise value from contents", async () => {
    const shipment = await createShipment(baseInput({ contents: [line({ merchandiseValueMinorUnits: 250_00n })] }));
    expect(shipment.computedMerchandiseValueMinorUnits).toBe(250_00n);
    expect(shipment.computedMerchandiseValueCurrency).toBe("USD");
  });

  it("sums multiple lines", async () => {
    const shipment = await createShipment(
      baseInput({ contents: [line({ merchandiseValueMinorUnits: 100_00n }), line({ merchandiseValueMinorUnits: 50_00n })] })
    );
    expect(shipment.computedMerchandiseValueMinorUnits).toBe(150_00n);
  });

  it("$100.00 exactly does not require a signature — source is 'rule'", async () => {
    const shipment = await createShipment(baseInput({ contents: [line({ merchandiseValueMinorUnits: 100_00n })] }));
    expect(shipment.signatureRequired).toBe(false);
    expect(shipment.signatureRequiredSource).toBe("rule");
  });

  it("$100.01 requires a signature — source is 'rule'", async () => {
    const shipment = await createShipment(baseInput({ contents: [line({ merchandiseValueMinorUnits: 100_01n })] }));
    expect(shipment.signatureRequired).toBe(true);
    expect(shipment.signatureRequiredSource).toBe("rule");
    expect(shipment.signatureRequiredSetByActorRef).toBeNull();
  });

  it("an upfront staff override at creation time is recorded as an override, not as the rule", async () => {
    const overriddenAt = new Date();
    const shipment = await createShipment(
      baseInput({
        contents: [line({ merchandiseValueMinorUnits: 10_00n })], // rule alone would say "not required"
        signatureOverride: { overriddenByActorRef: "staff:bob", overriddenAt, reason: "high-risk address" },
      })
    );
    expect(shipment.signatureRequired).toBe(true);
    expect(shipment.signatureRequiredSource).toBe("staff_override");
    expect(shipment.signatureRequiredSetByActorRef).toBe("staff:bob");
  });

  it("refuses an override with no recorded actor, before writing anything", async () => {
    const orderRef = `gid://shopify/Order/${uniq()}`;
    await expect(
      createShipment(
        baseInput({
          orderRef,
          signatureOverride: { overriddenByActorRef: "   ", overriddenAt: new Date() },
        })
      )
    ).rejects.toBeInstanceOf(InvalidSignatureOverrideError);
  });

  it("refuses empty contents", async () => {
    await expect(createShipment(baseInput({ contents: [] }))).rejects.toBeInstanceOf(EmptyShipmentContentsError);
  });

  it("refuses an insured amount with no currency, before writing anything", async () => {
    await expect(createShipment(baseInput({ insuredValueMinorUnits: 100_00n }))).rejects.toBeInstanceOf(
      InvalidShipmentInsuredValueError
    );
  });

  it("stores insured value independently of computed merchandise value — D30/G2, no equality enforced", async () => {
    const shipment = await createShipment(
      baseInput({
        contents: [line({ merchandiseValueMinorUnits: 500_000_00n })],
        insuredValueMinorUnits: 50_000_00n,
        insuredValueCurrency: "USD",
      })
    );
    expect(shipment.computedMerchandiseValueMinorUnits).toBe(500_000_00n);
    expect(shipment.insuredValueMinorUnits).toBe(50_000_00n);
  });

  it("criterion — split shipments are valued independently: two packages from the same order get independent computed values", async () => {
    const orderRef = `gid://shopify/Order/${uniq()}`;
    const packageA = await createShipment(baseInput({ orderRef, contents: [line({ merchandiseValueMinorUnits: 300_00n })] }));
    const packageB = await createShipment(baseInput({ orderRef, contents: [line({ merchandiseValueMinorUnits: 40_00n })] }));

    expect(packageA.computedMerchandiseValueMinorUnits).toBe(300_00n);
    expect(packageB.computedMerchandiseValueMinorUnits).toBe(40_00n);
    // Package A crosses the D31 threshold; package B, from the SAME order, does not.
    expect(packageA.signatureRequired).toBe(true);
    expect(packageB.signatureRequired).toBe(false);
  });
});

describe("applyShipmentSignatureOverride — upgrading an existing shipment", () => {
  it("upgrades a rule-required=false shipment to true, sourced 'staff_override'", async () => {
    const created = await createShipment(baseInput({ contents: [line({ merchandiseValueMinorUnits: 50_00n })] }));
    expect(created.signatureRequired).toBe(false);

    const overriddenAt = new Date();
    const updated = await applyShipmentSignatureOverride(created.id, {
      overriddenByActorRef: "staff:carol",
      overriddenAt,
      reason: "customer requested extra care",
    });
    expect(updated.signatureRequired).toBe(true);
    expect(updated.signatureRequiredSource).toBe("staff_override");
    expect(updated.signatureRequiredSetByActorRef).toBe("staff:carol");
  });

  it("refuses an override with no recorded actor", async () => {
    const created = await createShipment(baseInput());
    await expect(
      applyShipmentSignatureOverride(created.id, { overriddenByActorRef: "", overriddenAt: new Date() })
    ).rejects.toBeInstanceOf(InvalidSignatureOverrideError);
  });

  it("refuses a nonexistent shipment", async () => {
    await expect(
      applyShipmentSignatureOverride(randomUUID(), { overriddenByActorRef: "staff:alice", overriddenAt: new Date() })
    ).rejects.toBeInstanceOf(ShipmentNotFoundError);
  });
});

describe("recordShipmentSignatureServiceUsed — evidence, recorded independently of what was required", () => {
  it("records 'standard' on a shipment the rule did not require a signature for", async () => {
    const created = await createShipment(baseInput({ contents: [line({ merchandiseValueMinorUnits: 10_00n })] }));
    expect(created.signatureRequired).toBe(false);

    const updated = await recordShipmentSignatureServiceUsed(created.id, "standard");
    expect(updated.signatureServiceUsed).toBe("standard");
    // What was required is untouched by recording what was used.
    expect(updated.signatureRequired).toBe(false);
  });

  it("records 'none' on a shipment a signature WAS required for — the mismatch is not refused", async () => {
    const created = await createShipment(baseInput({ contents: [line({ merchandiseValueMinorUnits: 200_00n })] }));
    expect(created.signatureRequired).toBe(true);

    const updated = await recordShipmentSignatureServiceUsed(created.id, "none");
    expect(updated.signatureServiceUsed).toBe("none");
    expect(updated.signatureRequired).toBe(true);
  });

  it("refuses an unrecognized service value", async () => {
    const created = await createShipment(baseInput());
    await expect(recordShipmentSignatureServiceUsed(created.id, "expedited")).rejects.toBeInstanceOf(
      InvalidSignatureServiceUsedError
    );
  });

  it("refuses a nonexistent shipment", async () => {
    await expect(recordShipmentSignatureServiceUsed(randomUUID(), "standard")).rejects.toBeInstanceOf(
      ShipmentNotFoundError
    );
  });
});

describe("recordShipmentAddressChange — criteria 176-178", () => {
  it("reads the 'from' address from the shipment's own current row, not from the caller", async () => {
    const created = await createShipment(baseInput());
    const newAddress: ShipmentAddress = { ...ADDRESS, line1: "456 Oak Ave" };

    const { shipment, event } = await recordShipmentAddressChange(created.id, {
      to: newAddress,
      reason: "customer requested update",
      actorType: "staff",
      actorRef: "staff:alice",
    });

    expect(event.fromAddressLine1).toBe(ADDRESS.line1);
    expect(event.toAddressLine1).toBe("456 Oak Ave");
    expect(shipment.addressLine1).toBe("456 Oak Ave");
  });

  it("a second change chains from the FIRST change's result, not the original address", async () => {
    const created = await createShipment(baseInput());
    await recordShipmentAddressChange(created.id, {
      to: { ...ADDRESS, line1: "456 Oak Ave" },
      actorType: "staff",
      actorRef: "staff:alice",
    });
    const { event: secondEvent } = await recordShipmentAddressChange(created.id, {
      to: { ...ADDRESS, line1: "789 Pine Rd" },
      actorType: "staff",
      actorRef: "staff:alice",
    });
    expect(secondEvent.fromAddressLine1).toBe("456 Oak Ave");
    expect(secondEvent.toAddressLine1).toBe("789 Pine Rd");
  });

  it("refuses a no-op change (new address identical to current)", async () => {
    const created = await createShipment(baseInput());
    await expect(
      recordShipmentAddressChange(created.id, { to: ADDRESS, actorType: "staff", actorRef: "staff:alice" })
    ).rejects.toBeInstanceOf(InvalidShipmentAddressChangeError);
  });

  it("refuses a staff-attributed change with no actorRef", async () => {
    const created = await createShipment(baseInput());
    await expect(
      recordShipmentAddressChange(created.id, {
        to: { ...ADDRESS, line1: "456 Oak Ave" },
        actorType: "staff",
        actorRef: null,
      })
    ).rejects.toBeInstanceOf(InvalidShipmentAddressChangeError);
  });

  it("refuses a nonexistent shipment", async () => {
    await expect(
      recordShipmentAddressChange(randomUUID(), {
        to: { ...ADDRESS, line1: "456 Oak Ave" },
        actorType: "staff",
        actorRef: "staff:alice",
      })
    ).rejects.toBeInstanceOf(ShipmentNotFoundError);
  });

  it("the address-change event is append-only at the database level", async () => {
    const created = await createShipment(baseInput());
    const { event } = await recordShipmentAddressChange(created.id, {
      to: { ...ADDRESS, line1: "456 Oak Ave" },
      actorType: "staff",
      actorRef: "staff:alice",
    });
    await expect(
      prisma.shipmentAddressChangeEvent.update({ where: { id: event.id }, data: { reason: "edited" } })
    ).rejects.toThrow();
    await expect(prisma.shipmentAddressChangeEvent.delete({ where: { id: event.id } })).rejects.toThrow();
  });
});

describe("getShipmentForStaff — the complete record in one query", () => {
  it("returns the shipment together with its full address-change history, oldest first", async () => {
    const created = await createShipment(baseInput());
    await recordShipmentAddressChange(created.id, {
      to: { ...ADDRESS, line1: "456 Oak Ave" },
      actorType: "staff",
      actorRef: "staff:alice",
    });
    await recordShipmentAddressChange(created.id, {
      to: { ...ADDRESS, line1: "789 Pine Rd" },
      actorType: "staff",
      actorRef: "staff:alice",
    });

    const full = await getShipmentForStaff(created.id);
    expect(full).not.toBeNull();
    expect(full!.addressChanges).toHaveLength(2);
    expect(full!.addressChanges[0]!.toAddressLine1).toBe("456 Oak Ave");
    expect(full!.addressChanges[1]!.toAddressLine1).toBe("789 Pine Rd");
    expect(full!.addressLine1).toBe("789 Pine Rd");
  });

  it("returns null for a nonexistent shipment, rather than throwing", async () => {
    await expect(getShipmentForStaff(randomUUID())).resolves.toBeNull();
  });
});

describe("money stays in integer minor units throughout", () => {
  it("every money field on a created shipment is a bigint, never a float", async () => {
    const shipment = await createShipment(
      baseInput({
        contents: [line({ merchandiseValueMinorUnits: 12345n })],
        insuredValueMinorUnits: 12345n,
        insuredValueCurrency: "USD",
      })
    );
    expect(typeof shipment.computedMerchandiseValueMinorUnits).toBe("bigint");
    expect(typeof shipment.insuredValueMinorUnits).toBe("bigint");
  });
});
