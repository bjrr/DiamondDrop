import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { ALL_COMPONENT_TYPES, INERT_COMPONENT_TYPES } from "./resolveInputs.server";

/**
 * Pins the cost-component enum against the list the pricing job actually loads.
 *
 * WHY. `resolveInputs.server.ts` carries the comment "a type present in the
 * enum and absent here is silently free" — a guarantee that, until this file
 * existed, nothing enforced. This slice was bitten by exactly that twice: four
 * component types (`cad`, `assembly`, `supplier_fee`, `other`) were never
 * loaded, quietly dropping $30 of seeded labour out of every price; and a
 * per-carat stone cost was read in the wrong units.
 *
 * Both were arithmetically invisible. Nothing threw, no test failed, and the
 * prices looked entirely plausible — they were just wrong. A missing cost
 * component does not announce itself, so the only defence is a test that reads
 * the schema and refuses to let the two lists drift.
 *
 * Reading the .prisma file directly is deliberate. The generated TypeScript
 * enum is derived from the same schema, so asserting one against the other
 * would be circular; the schema file is the actual source of truth.
 */

function enumValuesFromSchema(enumName: string): string[] {
  const schema = readFileSync(join(process.cwd(), "prisma", "schema.prisma"), "utf8");
  const block = new RegExp(`enum ${enumName} \\{([\\s\\S]*?)\\n\\}`).exec(schema);
  if (!block?.[1]) throw new Error(`enum ${enumName} not found in schema.prisma`);

  return block[1]
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.startsWith("//") && !line.startsWith("@@"))
    .map((line) => line.split(/\s/)[0] ?? "")
    .filter((value) => /^[a-z_]+$/.test(value));
}

describe("cost component coverage", () => {
  it("every enum value is either loaded by the job or explicitly declared inert", () => {
    const declared = enumValuesFromSchema("CostComponentType");
    const accountedFor = new Set<string>([...ALL_COMPONENT_TYPES, ...INERT_COMPONENT_TYPES]);

    const unaccounted = declared.filter((value) => !accountedFor.has(value));

    expect(
      unaccounted,
      `These cost component types exist in the schema but are neither loaded by the ` +
        `pricing job nor declared inert: ${unaccounted.join(", ")}. ` +
        `A type in this state is SILENTLY FREE — costs recorded under it never reach ` +
        `a price, and nothing fails. Add it to ALL_COMPONENT_TYPES to load it, or to ` +
        `INERT_COMPONENT_TYPES to state deliberately that it is not a cost input.`
    ).toEqual([]);
  });

  it("finds the enum it is checking, rather than passing on an empty list", () => {
    // Guards the guard: if the schema parse silently returned nothing, the test
    // above would pass by checking no values at all.
    expect(enumValuesFromSchema("CostComponentType").length).toBeGreaterThan(10);
    expect(enumValuesFromSchema("CostComponentType")).toContain("payment_processing");
  });

  it("does not list a type as both loaded and inert", () => {
    const overlap = ALL_COMPONENT_TYPES.filter((t) =>
      (INERT_COMPONENT_TYPES as readonly string[]).includes(t)
    );
    expect(overlap).toEqual([]);
  });

  it("declares payment_adjustment inert — it is reserved, not a live cost input", () => {
    // Pinned explicitly because this one is a trap: it is a second plausible
    // home for the credit-card uplift rate, which D9 exists to forbid holding
    // in two places. If it ever becomes a real cost input, that is a deliberate
    // change and this assertion is where it gets noticed.
    expect(INERT_COMPONENT_TYPES).toContain("payment_adjustment");
    expect(ALL_COMPONENT_TYPES).not.toContain("payment_adjustment");
  });
});
