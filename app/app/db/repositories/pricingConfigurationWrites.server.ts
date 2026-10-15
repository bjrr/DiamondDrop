import type {
  CostComponentBasis,
  CostComponentType,
  CostComponentValueKind,
  LaborSource,
  Metal,
  MetalPriceSource,
  StoneCostKind,
  StoneType,
} from "@prisma/client";

import { INERT_COMPONENT_TYPES } from "~/jobs/pricing/resolveInputs.server";

import { prisma } from "../client.server";
import { findOverlappingCaratBands } from "./stoneCostRepository.server";

/**
 * THE OPERATOR WRITE PATH for the high-churn pricing cost libraries:
 * metal reference prices, labor rates and stone costs.
 *
 * ============================================================================
 * WHY THESE LIVE TOGETHER RATHER THAN IN THEIR PER-TABLE REPOSITORIES
 * ============================================================================
 * The per-table repositories are RESOLVERS — they answer "what value applies
 * at this instant", and they are called on every price calculation. These are
 * WRITES, called only from one authenticated admin route, and they share a
 * discipline the resolvers do not have: an authenticated actor, an audit
 * event in the same transaction, and append-only insertion.
 *
 * Keeping them in one module makes the boundary fenceable: a test can assert
 * that nothing outside this file and `prisma/seed.ts` writes these tables.
 * Spread across three resolver modules, that assertion becomes three
 * assertions nobody updates together.
 *
 * ============================================================================
 * APPEND-ONLY IS ENFORCED BY THE DATABASE, NOT BY THIS FILE
 * ============================================================================
 * `metal_reference_price`, `labor_rate` and `stone_cost` all carry
 * `no_update` / `no_delete` triggers. Nothing here can rewrite history even
 * if it tried; a configuration change is always a new row. The transaction
 * ROLLBACK used by the stone-cost overlap guard is not a DELETE and is
 * therefore unaffected by those triggers.
 *
 * ============================================================================
 * ACTOR
 * ============================================================================
 * `actorRef` comes from the authenticated embedded-admin session, never from
 * a form field. `metal_reference_price` and `labor_rate` have an `enteredBy`
 * column and it is populated; `stone_cost` has none, so for that table the
 * audit event is the sole actor record — which is why the audit write is in
 * the same transaction rather than best-effort afterwards.
 */

export class OverlappingCaratBandError extends Error {
  constructor(stoneType: string, shape: string) {
    super(
      `That carat band overlaps an existing ${stoneType}/${shape} band with the same quality qualifiers and effective date. ` +
        `Overlapping bands make two rows equally applicable, which fails at pricing time as an ambiguity error. Nothing was saved.`
    );
    this.name = "OverlappingCaratBandError";
  }
}

export class InvalidCaratBandError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCaratBandError";
  }
}

// ---------------------------------------------------------------------------
// Metal reference price
// ---------------------------------------------------------------------------

export async function createMetalReferencePrice(input: {
  metal: Metal;
  /** Decimal string, price per gram of PURE metal. Purity fineness is applied by the engine, never here. */
  pricePerGram: string;
  currency: string;
  effectiveFrom: Date;
  source: MetalPriceSource;
  actorRef: string;
  note?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const created = await tx.metalReferencePrice.create({
      data: {
        metal: input.metal,
        pricePerGram: input.pricePerGram,
        currency: input.currency,
        effectiveFrom: input.effectiveFrom,
        source: input.source,
        enteredBy: input.actorRef,
        note: input.note ?? null,
      },
    });

    await tx.auditEvent.create({
      data: {
        actorType: "staff",
        actorRef: input.actorRef,
        action: "metal_reference_price.created",
        entityType: "metal_reference_price",
        entityId: created.id,
        after: {
          metal: created.metal,
          pricePerGram: input.pricePerGram,
          currency: created.currency,
          effectiveFrom: created.effectiveFrom.toISOString(),
          source: created.source,
        },
        reason: "pricing_configuration",
      },
    });

    return created;
  });
}

// ---------------------------------------------------------------------------
// Labor rate
// ---------------------------------------------------------------------------

export async function createLaborRate(input: {
  source: LaborSource;
  /** Decimal string, rate per gram. */
  ratePerGram: string;
  currency: string;
  effectiveFrom: Date;
  actorRef: string;
  note?: string | null;
}) {
  return prisma.$transaction(async (tx) => {
    const created = await tx.laborRate.create({
      data: {
        source: input.source,
        ratePerGram: input.ratePerGram,
        currency: input.currency,
        effectiveFrom: input.effectiveFrom,
        enteredBy: input.actorRef,
        note: input.note ?? null,
      },
    });

    await tx.auditEvent.create({
      data: {
        actorType: "staff",
        actorRef: input.actorRef,
        action: "labor_rate.created",
        entityType: "labor_rate",
        entityId: created.id,
        after: {
          source: created.source,
          ratePerGram: input.ratePerGram,
          currency: created.currency,
          effectiveFrom: created.effectiveFrom.toISOString(),
        },
        reason: "pricing_configuration",
      },
    });

    return created;
  });
}

// ---------------------------------------------------------------------------
// Stone cost
// ---------------------------------------------------------------------------

export async function createStoneCost(input: {
  stoneType: StoneType;
  shape: string;
  /** Decimal strings. Half-open band: [caratMin, caratMax). */
  caratMin: string;
  caratMax: string;
  costKind: StoneCostKind;
  /** Exactly one of these, matching costKind — enforced by a CHECK and re-checked here. */
  costMinorUnits?: bigint | null;
  costPerCarat?: string | null;
  currency: string;
  effectiveFrom: Date;
  actorRef: string;
  /** Blank/absent qualifiers are WILDCARDS: the row then applies to every quality. */
  color?: string | null;
  clarity?: string | null;
  cutGrade?: string | null;
  labStatus?: string | null;
  supplierRef?: string | null;
}) {
  if (input.costKind === "per_stone" && (input.costMinorUnits === null || input.costMinorUnits === undefined)) {
    throw new InvalidCaratBandError("A per-stone cost requires an amount.");
  }
  if (input.costKind === "per_carat" && (input.costPerCarat === null || input.costPerCarat === undefined)) {
    throw new InvalidCaratBandError("A per-carat cost requires a rate.");
  }

  return prisma.$transaction(async (tx) => {
    const created = await tx.stoneCost.create({
      data: {
        stoneType: input.stoneType,
        shape: input.shape,
        caratMin: input.caratMin,
        caratMax: input.caratMax,
        color: input.color ?? null,
        clarity: input.clarity ?? null,
        cutGrade: input.cutGrade ?? null,
        labStatus: input.labStatus ?? null,
        supplierRef: input.supplierRef ?? null,
        costKind: input.costKind,
        costMinorUnits: input.costKind === "per_stone" ? input.costMinorUnits! : null,
        costPerCarat: input.costKind === "per_carat" ? input.costPerCarat! : null,
        currency: input.currency,
        effectiveFrom: input.effectiveFrom,
      },
    });

    // THE EXISTING VALIDATOR, RUN INSIDE THE TRANSACTION. Insert first, then
    // ask the one authoritative overlap predicate whether the resulting data
    // is ambiguous, and roll back if it is. This is deliberately not a second
    // "would it overlap?" implementation at the form boundary.
    const overlaps = await findOverlappingCaratBands(input.stoneType, input.shape, tx);
    if (overlaps.length > 0) {
      throw new OverlappingCaratBandError(input.stoneType, input.shape);
    }

    await tx.auditEvent.create({
      data: {
        actorType: "staff",
        actorRef: input.actorRef,
        action: "stone_cost.created",
        entityType: "stone_cost",
        entityId: created.id,
        after: {
          stoneType: created.stoneType,
          shape: created.shape,
          caratMin: input.caratMin,
          caratMax: input.caratMax,
          costKind: created.costKind,
          costMinorUnits: input.costMinorUnits?.toString() ?? null,
          costPerCarat: input.costPerCarat ?? null,
          currency: created.currency,
          effectiveFrom: created.effectiveFrom.toISOString(),
          color: created.color,
          clarity: created.clarity,
          cutGrade: created.cutGrade,
          labStatus: created.labStatus,
        },
        reason: "pricing_configuration",
      },
    });

    return created;
  });
}

// ---------------------------------------------------------------------------
// Cost components
// ---------------------------------------------------------------------------

export class InertComponentTypeError extends Error {
  constructor(componentType: string) {
    super(
      `"${componentType}" is declared inert in INERT_COMPONENT_TYPES — nothing reads it, so a value entered ` +
        `against it would silently have no effect on any price. Refusing rather than accepting a change that does nothing.`
    );
    this.name = "InertComponentTypeError";
  }
}

export class InvalidCostComponentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCostComponentError";
  }
}

/**
 * Creates a new effective-dated cost component.
 *
 * ONE WRITE PATH FOR ALL ELEVEN OPERATING COMPONENTS, because the model
 * already generalises them: the natural key is `(componentType, valueKind)`
 * and the only shape difference is which value column is populated —
 * `fixed`/`per_stone` carry an amount and a currency, `percentage` carries a
 * rate. That is not an abstraction imposed here; it is the existing
 * `cost_component_value_kind_matches_value` CHECK, restated so the operator
 * gets a sentence instead of a constraint violation.
 *
 * INERT TYPES ARE REFUSED. `payment_adjustment` exists in the enum but
 * `resolveInputs.server.ts` declares it inert and nothing reads it. Offering
 * it would let an operator carefully enter a cost that changes no price —
 * worse than not offering it, because it looks like it worked. The refusal
 * reads the existing `INERT_COMPONENT_TYPES` export rather than hard-coding a
 * second opinion about which types are live.
 */
export async function createCostComponent(input: {
  componentType: CostComponentType;
  basis: CostComponentBasis;
  valueKind: CostComponentValueKind;
  /** Required for `fixed` and `per_stone`. */
  amountMinorUnits?: bigint | null;
  /** Required for `fixed` and `per_stone`; must be absent for `percentage`. */
  currency?: string | null;
  /** Required for `percentage`, as a decimal fraction ("0.029"). */
  rate?: string | null;
  effectiveFrom: Date;
  actorRef: string;
  note?: string | null;
}) {
  if (INERT_COMPONENT_TYPES.includes(input.componentType)) {
    throw new InertComponentTypeError(input.componentType);
  }

  const isAmountKind = input.valueKind === "fixed" || input.valueKind === "per_stone";
  if (isAmountKind) {
    if (input.amountMinorUnits === null || input.amountMinorUnits === undefined) {
      throw new InvalidCostComponentError(`A ${input.valueKind} component requires an amount.`);
    }
    if (!input.currency) {
      throw new InvalidCostComponentError(`A ${input.valueKind} component requires a currency.`);
    }
  } else if (input.rate === null || input.rate === undefined) {
    throw new InvalidCostComponentError("A percentage component requires a rate.");
  }

  return prisma.$transaction(async (tx) => {
    const created = await tx.costComponent.create({
      data: {
        componentType: input.componentType,
        basis: input.basis,
        valueKind: input.valueKind,
        // The CHECK requires exactly one shape; populate accordingly rather
        // than passing both and letting the database decide.
        amountMinorUnits: isAmountKind ? input.amountMinorUnits! : null,
        currency: isAmountKind ? input.currency! : null,
        rate: isAmountKind ? null : input.rate!,
        effectiveFrom: input.effectiveFrom,
        enteredBy: input.actorRef,
        note: input.note ?? null,
      },
    });

    await tx.auditEvent.create({
      data: {
        actorType: "staff",
        actorRef: input.actorRef,
        action: "cost_component.created",
        entityType: "cost_component",
        entityId: created.id,
        after: {
          componentType: created.componentType,
          basis: created.basis,
          valueKind: created.valueKind,
          amountMinorUnits: input.amountMinorUnits?.toString() ?? null,
          currency: created.currency,
          rate: input.rate ?? null,
          effectiveFrom: created.effectiveFrom.toISOString(),
        },
        reason: "pricing_configuration",
      },
    });

    return created;
  });
}
