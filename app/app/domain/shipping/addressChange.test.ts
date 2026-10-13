import { describe, expect, it } from "vitest";

import { validateShipmentAddressChange, type ShipmentAddress } from "./addressChange";

const ORIGINAL: ShipmentAddress = {
  line1: "123 Main St",
  line2: null,
  city: "Springfield",
  region: "IL",
  postalCode: "62704",
  country: "US",
};

const UPDATED: ShipmentAddress = {
  ...ORIGINAL,
  line1: "456 Oak Ave",
};

describe("validateShipmentAddressChange — criteria 176-178: always audited, unconditionally", () => {
  it("accepts a well-formed staff-attributed change", () => {
    const result = validateShipmentAddressChange({
      from: ORIGINAL,
      to: UPDATED,
      reason: "customer called to update delivery address",
      actorType: "staff",
      actorRef: "staff:alice",
    });
    expect(result).toEqual({ ok: true });
  });

  it("accepts a change with no reason given — reason is optional, mirroring AuditEvent", () => {
    const result = validateShipmentAddressChange({
      from: ORIGINAL,
      to: UPDATED,
      reason: null,
      actorType: "staff",
      actorRef: "staff:alice",
    });
    expect(result).toEqual({ ok: true });
  });

  it("refuses an incomplete from-address", () => {
    const result = validateShipmentAddressChange({
      from: { ...ORIGINAL, line1: "" },
      to: UPDATED,
      reason: null,
      actorType: "staff",
      actorRef: "staff:alice",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses an incomplete to-address", () => {
    const result = validateShipmentAddressChange({
      from: ORIGINAL,
      to: { ...UPDATED, postalCode: "" },
      reason: null,
      actorType: "staff",
      actorRef: "staff:alice",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a no-op change (from and to identical)", () => {
    const result = validateShipmentAddressChange({
      from: ORIGINAL,
      to: ORIGINAL,
      reason: null,
      actorType: "staff",
      actorRef: "staff:alice",
    });
    expect(result.ok).toBe(false);
  });

  it("refuses a staff-attributed change with no actorRef", () => {
    const result = validateShipmentAddressChange({
      from: ORIGINAL,
      to: UPDATED,
      reason: null,
      actorType: "staff",
      actorRef: null,
    });
    expect(result.ok).toBe(false);
  });

  it("a change differing only in a nullable field (e.g. line2) still counts as a real change", () => {
    const result = validateShipmentAddressChange({
      from: ORIGINAL,
      to: { ...ORIGINAL, line2: "Apt 4B" },
      reason: null,
      actorType: "staff",
      actorRef: "staff:alice",
    });
    expect(result).toEqual({ ok: true });
  });
});
