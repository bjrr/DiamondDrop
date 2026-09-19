import { Prisma } from "@prisma/client";
import { describe, expect, it } from "vitest";

import {
  COVERED_MODELS,
  NOT_PRICE_AFFECTING_COLUMNS,
  PRICE_AFFECTING_COLUMNS,
} from "./priceAffectingColumns";

/**
 * The fence for criterion 58's classifier — the part that survives contact
 * with future slices.
 *
 * A hand-written allow/deny-list rots the moment someone adds a column: the
 * classifier would silently answer `false` (see priceAffectingColumns.ts's
 * "an unclassified column defaults to not-triggering" design) for a column
 * nobody ever looked at, and a genuinely price-affecting new column would go
 * unnoticed exactly like the missing cost components
 * `componentCoverage.test.ts` documents having actually happened in this
 * codebase.
 *
 * SOURCE OF TRUTH: the Prisma DMMF (`Prisma.dmmf.datamodel.models`), read at
 * test time from the GENERATED client rather than hand-copied. Team-lead
 * instruction explicitly permits DMMF or a schema.prisma text parse
 * (`componentCoverage.test.ts` uses the latter, for enum VALUES). DMMF is
 * used here instead because it already distinguishes a real column
 * (`kind: "scalar" | "enum"`) from a relation (`kind: "object"`) — a
 * relation field such as `MasterVariant.masterProduct` is not a column a
 * write ever "touches" in the sense this classifier cares about, and DMMF
 * gives that distinction directly rather than needing a second regex to
 * approximate it.
 *
 * NOT CIRCULAR: `PRICE_AFFECTING_COLUMNS`/`NOT_PRICE_AFFECTING_COLUMNS` are
 * hand-maintained TypeScript literals that do NOT regenerate when
 * schema.prisma changes. DMMF DOES. A field added to a covered model and
 * never added to either list is exactly the gap this test exists to catch,
 * and it can only be caught by comparing the hand-maintained lists against
 * something that moves independently of them.
 */

function realColumnNames(modelName: string): string[] {
  const model = Prisma.dmmf.datamodel.models.find((m) => m.name === modelName);
  if (!model) throw new Error(`Model "${modelName}" not found in the Prisma DMMF.`);

  return model.fields
    .filter((field) => field.kind === "scalar" || field.kind === "enum")
    .map((field) => field.name);
}

describe("criterion 58 fence — every column on every covered model is classified", () => {
  for (const model of COVERED_MODELS) {
    it(`${model}: every real column is EITHER price-affecting OR explicitly not, never neither`, () => {
      const actual = realColumnNames(model);
      const classified = new Set([
        ...PRICE_AFFECTING_COLUMNS[model],
        ...Object.keys(NOT_PRICE_AFFECTING_COLUMNS[model]),
      ]);

      const unclassified = actual.filter((column) => !classified.has(column));

      expect(
        unclassified,
        `${model} has column(s) that are neither in PRICE_AFFECTING_COLUMNS nor ` +
          `NOT_PRICE_AFFECTING_COLUMNS: ${unclassified.join(", ")}. An unclassified column is ` +
          `SILENTLY TREATED AS NOT PRICE-AFFECTING by isPriceAffectingChange — for a genuinely ` +
          `price-affecting new column, that is a price that goes stale with nothing failing, ` +
          `until this fence catches it. Classify it in exactly one of the two lists in ` +
          `priceAffectingColumns.ts, with a reason if it is not price-affecting.`
      ).toEqual([]);
    });

    it(`${model}: no column is classified in BOTH lists`, () => {
      const allowed = new Set(PRICE_AFFECTING_COLUMNS[model]);
      const denied = new Set(Object.keys(NOT_PRICE_AFFECTING_COLUMNS[model]));
      const overlap = [...allowed].filter((c) => denied.has(c));
      expect(overlap).toEqual([]);
    });

    it(`${model}: every classified column actually exists on the model — no stale entries`, () => {
      const actual = new Set(realColumnNames(model));
      const classified = [...PRICE_AFFECTING_COLUMNS[model], ...Object.keys(NOT_PRICE_AFFECTING_COLUMNS[model])];
      const stale = classified.filter((column) => !actual.has(column));

      expect(
        stale,
        `${model} classifies column(s) that no longer exist on the model: ${stale.join(", ")}. ` +
          `A stale entry usually means a column was renamed or removed without updating this file.`
      ).toEqual([]);
    });
  }

  it("GUARDS THE GUARD: the DMMF introspection actually found real columns, not an empty list", () => {
    // If realColumnNames silently returned [] for every model (a broken
    // model-name string, a DMMF shape change), every "unclassified" check
    // above would vacuously pass. This is that check's own check.
    for (const model of COVERED_MODELS) {
      expect(realColumnNames(model).length).toBeGreaterThan(0);
    }
    // A concrete, known-shape spot check on the two tables this classifier
    // exists for, so a DMMF shape change that happened to preserve list
    // LENGTHS could not slip through silently either.
    expect(realColumnNames("MasterVariant")).toContain("lastSyncedPriceCalculationId");
    expect(realColumnNames("MasterVariant")).toContain("baseWeightGrams");
    expect(realColumnNames("MasterProduct")).toContain("isLuxurySteal");
  });

  it("COVERED_MODELS itself covers at least the tables T5's PricingInputChangeKind audit identified", () => {
    const expected = [
      "MetalReferencePrice",
      "StoneCost",
      "CostComponent",
      "PricingProfile",
      "LaborRate",
      "RingSizeBand",
      "VariantWeightOverride",
      "MasterVariantStone",
      "MasterVariant",
      "MasterProduct",
    ];
    for (const model of expected) {
      expect(COVERED_MODELS as readonly string[]).toContain(model);
    }
  });
});
