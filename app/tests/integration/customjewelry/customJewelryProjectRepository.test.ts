import { describe, expect, it } from "vitest";

import { prisma } from "~/db/client.server";
import {
  createCustomJewelryProject,
  toCustomJewelryProjectConfirmation,
} from "~/db/repositories/customJewelryProjectRepository.server";

/**
 * Custom Jewelry intake against real Postgres (Slice 9).
 *
 * The constraint tests matter more than the happy path here. Every one of
 * them encodes a question a human would otherwise have to answer by guessing
 * later: did the customer mean no deadline or did nobody ask; is that budget
 * dollars or cents; is this enquiry anonymous or did we lose the account link.
 */

let seq = 0;
const uniq = () => `${Date.now() % 900_000}-${++seq}`;

function baseInput() {
  return {
    customerRef: null,
    firstName: "Ada",
    lastName: "Lovelace",
    email: `ada-${uniq()}@example.com`,
    phone: "+1 555 0100",
    startingPoint: "from_scratch" as const,
    promptText: "A signet ring reworked from my grandmother's, keeping the original stone.",
    followUpPreference: "contact_me" as const,
  };
}

describe("custom jewelry intake records an enquiry", () => {
  it("creates a project with a readable, unique reference", async () => {
    const project = await createCustomJewelryProject(baseInput());
    expect(project.projectReference).toMatch(/^CJ-[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/);
    expect(project.status).toBe("submitted");
  });

  it("omits I, L, O and U from references — they are misread aloud and mistyped", async () => {
    // Generated rather than asserted on one sample: a single reference could
    // pass by luck.
    const references = await Promise.all(
      Array.from({ length: 12 }, async () => (await createCustomJewelryProject(baseInput())).projectReference)
    );
    for (const reference of references) {
      expect(reference.slice(3)).not.toMatch(/[ILOU]/);
    }
    expect(new Set(references).size).toBe(references.length);
  });

  it("ACCEPTS AN ANONYMOUS ENQUIRY — intake is deliberately low-friction", async () => {
    // README: the initial request is free and low-friction.
    // docs/REQUIRED-CUSTOMER-ACCOUNTS.md requires an account for every
    // PURCHASE path, naming "Custom Jewelry final approval/purchase" — not a
    // pre-purchase enquiry. The gate belongs at approval, not here.
    const project = await createCustomJewelryProject({ ...baseInput(), customerRef: null });
    expect(project.customerRef).toBeNull();
  });

  it("links the authenticated customer when there is one", async () => {
    const customerRef = `gid://shopify/Customer/${Date.now()}`;
    const project = await createCustomJewelryProject({ ...baseInput(), customerRef });
    expect(project.customerRef).toBe(customerRef);
  });

  it("stores an approximate budget in MINOR UNITS with a currency", async () => {
    const project = await createCustomJewelryProject({
      ...baseInput(),
      approximateBudget: { amountMinorUnits: 350000n, currency: "USD" },
    });
    // 350000 minor units = $3,500.00. Asserted as a bigint, never a number:
    // a float here is the bug CLAUDE.md rule 6 exists to prevent.
    expect(project.approximateBudgetMinorUnits).toBe(350000n);
    expect(project.approximateBudgetCurrency).toBe("USD");
  });

  it("the DATABASE refuses an amount without a currency", async () => {
    // Enforced below the repository, because a bare number is exactly the
    // value someone later reads as dollars.
    const project = await createCustomJewelryProject(baseInput());
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE custom_jewelry_project SET approximate_budget_minor_units = 1000 WHERE id = '${project.id}'::uuid`
      )
    ).rejects.toThrow(/custom_jewelry_project_budget_complete/);
  });

  it("the DATABASE refuses a negative budget, but permits zero", async () => {
    const project = await createCustomJewelryProject(baseInput());
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE custom_jewelry_project SET approximate_budget_minor_units = -1, approximate_budget_currency = 'USD' WHERE id = '${project.id}'::uuid`
      )
    ).rejects.toThrow(/custom_jewelry_project_budget_non_negative/);

    // Zero is a real answer — "no particular budget in mind" — not an error.
    const zero = await createCustomJewelryProject({
      ...baseInput(),
      approximateBudget: { amountMinorUnits: 0n, currency: "USD" },
    });
    expect(zero.approximateBudgetMinorUnits).toBe(0n);
  });

  it("records a desired date OR no-deadline, and the DATABASE refuses both", async () => {
    const dated = await createCustomJewelryProject({
      ...baseInput(),
      desiredCompletionDate: new Date("2027-06-01T00:00:00.000Z"),
    });
    expect(dated.hasNoDeadline).toBe(false);

    const open = await createCustomJewelryProject({ ...baseInput(), hasNoDeadline: true });
    expect(open.desiredCompletionDate).toBeNull();

    // Both at once leaves staff guessing which the customer meant.
    await expect(
      prisma.$executeRawUnsafe(
        `UPDATE custom_jewelry_project SET has_no_deadline = true WHERE id = '${dated.id}'::uuid`
      )
    ).rejects.toThrow(/custom_jewelry_project_deadline_exclusive/);
  });

  it("NO DEPOSIT IS RECORDED AT INTAKE — the README forbids charging yet", async () => {
    // Asserted structurally: the table has no payment columns at all, so
    // there is nothing for a later change to fill in from the wrong place.
    const project = await createCustomJewelryProject(baseInput());
    const columns = Object.keys(project);
    for (const forbidden of ["deposit", "paid", "charge", "payment", "amountCharged"]) {
      expect(
        columns.some((c) => c.toLowerCase().includes(forbidden)),
        `intake must not carry a "${forbidden}" column`
      ).toBe(false);
    }
    expect(project.status).toBe("submitted");
  });

  it("the customer-safe confirmation exposes only the reference and status", async () => {
    const project = await createCustomJewelryProject(baseInput());
    const confirmation = toCustomJewelryProjectConfirmation(project);
    expect(Object.keys(confirmation).sort()).toEqual(["projectReference", "status"]);
  });
});
