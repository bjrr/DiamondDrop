import { describe, expect, it } from "vitest";

import { buildAcknowledgmentRecord, InvalidAcknowledgmentError } from "./acknowledgment";

const validInput = {
  exactText: "I understand this Luxury Steal purchase is Final Sale and cannot be returned or exchanged.",
  policyVersionId: "11111111-1111-1111-1111-111111111111",
  acknowledgedAt: new Date("2026-09-13T12:00:00Z"),
  affirmativeActionLabel: "Customer clicked 'I Acknowledge'",
};

describe("buildAcknowledgmentRecord", () => {
  it("accepts a fully-specified explicit affirmative acknowledgment", () => {
    const record = buildAcknowledgmentRecord(validInput);
    expect(record.exactText).toBe(validInput.exactText);
    expect(record.affirmativeActionLabel).toBe(validInput.affirmativeActionLabel);
  });

  it("rejects a missing exactText — there is no default", () => {
    const { exactText: _omit, ...rest } = validInput;
    expect(() => buildAcknowledgmentRecord(rest)).toThrow(InvalidAcknowledgmentError);
  });

  it("rejects a blank exactText", () => {
    expect(() => buildAcknowledgmentRecord({ ...validInput, exactText: "" })).toThrow(
      InvalidAcknowledgmentError
    );
  });

  it("rejects a missing policyVersionId", () => {
    const { policyVersionId: _omit, ...rest } = validInput;
    expect(() => buildAcknowledgmentRecord(rest)).toThrow(InvalidAcknowledgmentError);
  });

  it("rejects a missing timestamp", () => {
    const { acknowledgedAt: _omit, ...rest } = validInput;
    expect(() => buildAcknowledgmentRecord(rest)).toThrow(InvalidAcknowledgmentError);
  });

  it("rejects a missing or blank affirmativeActionLabel — no pre-checked/inferred acceptance", () => {
    const { affirmativeActionLabel: _omit, ...rest } = validInput;
    expect(() => buildAcknowledgmentRecord(rest)).toThrow(InvalidAcknowledgmentError);
    expect(() => buildAcknowledgmentRecord({ ...validInput, affirmativeActionLabel: "" })).toThrow(
      InvalidAcknowledgmentError
    );
  });

  it("has no boolean 'accepted'/'checked' field to default or infer from", () => {
    // There is no field on the schema that could represent an implicit
    // "true" — attempting to satisfy the requirement with only a boolean
    // flag and no exact text/label must still fail.
    expect(() =>
      buildAcknowledgmentRecord({
        accepted: true,
        policyVersionId: validInput.policyVersionId,
        acknowledgedAt: validInput.acknowledgedAt,
      })
    ).toThrow(InvalidAcknowledgmentError);
  });

  it("accepts optional reference columns when supplied", () => {
    const record = buildAcknowledgmentRecord({
      ...validInput,
      customerRef: "gid://shopify/Customer/1",
      orderRef: "gid://shopify/Order/1",
      productRef: "gid://shopify/Product/1",
    });
    expect(record.customerRef).toBe("gid://shopify/Customer/1");
  });
});
