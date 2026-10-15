import { Prisma, type PricingProfileCode } from "@prisma/client";

import { Money } from "~/domain/money/money";

import { prisma } from "../client.server";
import {
  MissingCostInputError,
  provenanceOf,
  type CostInputProvenance,
} from "./effectiveDated.server";

/**
 * L2 — pricing profile retrieval (spec §4.0 L4, retrieved via L2).
 *
 * A profile is POLICY: margin objective, hard floors, tolerance, and the
 * rounding/price-ending rule ids. It holds nothing product-, variant- or
 * supplier-specific — a rule that applies to one product is a cost input or a
 * variant floor, not a policy (§4.0 L4).
 *
 * The table is append-only and versioned: a change is a new version, never an
 * edit, so a stored price_calculation's (profileId, profileVersion) always
 * resolves to exactly the values it was computed from.
 */

export interface ResolvedPricingProfile {
  id: string;
  code: PricingProfileCode;
  version: number;
  marginModel: string;
  /** Decimal strings, never numbers (§4.1). */
  targetGrossMarginRate: string | null;
  targetMarkupRate: string | null;
  minGrossMarginRate: string;
  minDollarProfit: Money;
  roundingRuleId: string;
  priceEndingRuleId: string;
  autoApplyToleranceBps: number | null;
  regularCardPriceRuleId: string;
  fixedCardUpliftRate: string;
  /**
   * D14 is unresolved, so the seeded profile carries deliberately absurd
   * placeholder values behind this flag. The T8 review CLI MUST refuse to
   * approve or sync a price computed from a profile where this is true —
   * that check is the only thing standing between a placeholder margin and a
   * real storefront price.
   */
  isPlaceholder: boolean;
  provenance: CostInputProvenance;
}

export async function resolveActivePricingProfile(
  code: PricingProfileCode,
  asOf: Date
): Promise<ResolvedPricingProfile> {
  // Resolution is by effective date, with VERSION as the tie-break.
  //
  // pricing_profile is unique on (code, version), NOT on (code, effectiveFrom),
  // so two versions may legitimately share an effective date — an operator
  // correcting a profile the same day they created it is the obvious case.
  // selectMostSpecific would treat that as an unresolvable tie and refuse to
  // price anything, which is the wrong answer here: unlike a cost row, a
  // profile version is a deliberate monotonic sequence, so at the same
  // effective date the higher version is unambiguously the later intent.
  //
  // ONE ROW, NOT ALL OF THEM. This was `findMany` followed by a redundant
  // in-JS re-filter of the same `effectiveFrom <= asOf` the WHERE already
  // applied, then `[0]` — so every price calculation loaded the ENTIRE
  // version history for the code to use its first row.
  //
  // That was invisible while versions only appeared when an engineer edited
  // the seed. The pricing-settings surface makes an operator-created version
  // a routine weekly event, so the cost now grows with how often the business
  // changes its mind — in production, and in the shared integration database
  // where it pushed two already-slow pricing tests past their timeout.
  // `findFirst` with the identical where and ordering returns exactly the
  // same row in constant time.
  const row = await prisma.pricingProfile.findFirst({
    where: { code, effectiveFrom: { lte: asOf } },
    orderBy: [{ effectiveFrom: "desc" }, { version: "desc" }],
  });

  if (!row) {
    throw new MissingCostInputError("pricing_profile", asOf, `code=${code}`);
  }

  return {
    id: row.id,
    code: row.code,
    version: row.version,
    marginModel: row.marginModel,
    targetGrossMarginRate: row.targetGrossMarginRate?.toString() ?? null,
    targetMarkupRate: row.targetMarkupRate?.toString() ?? null,
    minGrossMarginRate: row.minGrossMarginRate.toString(),
    minDollarProfit: Money.fromMinorUnits(row.minDollarProfitMinorUnits, row.currency),
    roundingRuleId: row.roundingRuleId,
    priceEndingRuleId: row.priceEndingRuleId,
    autoApplyToleranceBps: row.autoApplyToleranceBps,
    regularCardPriceRuleId: row.regularCardPriceRuleId,
    fixedCardUpliftRate: row.fixedCardUpliftRate.toString(),
    isPlaceholder: row.isPlaceholder,
    provenance: provenanceOf("pricing_profile", row),
  };
}

/** Resolves the exact version a stored calculation was computed from. */
export async function getPricingProfileVersion(code: PricingProfileCode, version: number) {
  return prisma.pricingProfile.findUnique({ where: { code_version: { code, version } } });
}

/**
 * Creates the NEXT version of a pricing profile from operator-entered
 * settings. The only supported write path to `pricing_profile`.
 *
 * ============================================================================
 * VERSION IS SYSTEM METADATA, NEVER OPERATOR INPUT
 * ============================================================================
 * Before this existed, versions were hand-assigned in `prisma/seed.ts`, which
 * is fine for a script an engineer reads and impossible for a form. The next
 * version is derived here, server-side, and the caller cannot influence it.
 *
 * CONCURRENCY IS HANDLED BY THE UNIQUE CONSTRAINT, NOT BY HOPING.
 * `MAX(version) + 1` read outside any protection is the classic lost-update:
 * two operators saving together both read 5 and both try to write 6. The
 * `(code, version)` unique index is the real boundary — the same discipline
 * the rest of this codebase uses for concurrency — so the loser of a race
 * gets P2002 and we recompute and retry. Bounded, because an unbounded retry
 * loop under sustained contention is its own outage.
 *
 * EVERYTHING THE OPERATOR DID NOT TYPE IS INHERITED FROM THE CURRENT ACTIVE
 * PROFILE. The margin model, currency, rounding rule, price-ending rule,
 * card-price rule and uplift rate all carry forward unchanged. A settings
 * form that silently reset the card rule to a default would be a pricing
 * incident dressed as a UI convenience.
 *
 * THE AUDIT EVENT IS WRITTEN IN THE SAME TRANSACTION as the profile row, so
 * a recorded change always has its evidence and an unrecorded one leaves
 * nothing behind. Same pattern as `groupBuyRepository.server.ts`.
 */
export class NoActivePricingProfileError extends Error {
  constructor(code: string) {
    super(
      `No active pricing profile exists for "${code}", so there is nothing to base a new version on. ` +
        `This is a provisioning problem, not a data-entry one.`
    );
    this.name = "NoActivePricingProfileError";
  }
}

export class PricingProfileVersionRaceError extends Error {
  constructor(attempts: number) {
    super(
      `Could not allocate a new pricing profile version after ${attempts} attempts because another save kept winning the race. Nothing was written. Try again.`
    );
    this.name = "PricingProfileVersionRaceError";
  }
}

export interface PricingProfileSettingsToPersist {
  readonly targetMarkupRate: string;
  readonly minGrossMarginRate: string;
  readonly minDollarProfitMinorUnits: bigint;
  readonly currency: string;
}

export interface CreatedPricingProfileVersion {
  readonly id: string;
  readonly code: PricingProfileCode;
  readonly version: number;
  readonly effectiveFrom: Date;
  readonly previousVersion: number;
  readonly previousId: string;
}

const MAX_VERSION_ATTEMPTS = 5;

export async function createNextPricingProfileVersion(input: {
  code: PricingProfileCode;
  settings: PricingProfileSettingsToPersist;
  /** From the authenticated embedded-admin session. Never typed by the operator. */
  actorRef: string;
  /** Server time. MVP1 does not expose future-dating. */
  effectiveFrom: Date;
}): Promise<CreatedPricingProfileVersion> {
  let lastConflict: unknown = null;

  for (let attempt = 1; attempt <= MAX_VERSION_ATTEMPTS; attempt += 1) {
    // Read the CURRENT profile fresh on every attempt: a competing save may
    // have changed both the version to beat and the fields to inherit.
    const current = await resolveActivePricingProfile(input.code, input.effectiveFrom).catch(() => null);
    if (!current) throw new NoActivePricingProfileError(input.code);

    const highest = await prisma.pricingProfile.findFirst({
      where: { code: input.code },
      orderBy: { version: "desc" },
      select: { version: true },
    });
    const nextVersion = (highest?.version ?? 0) + 1;

    try {
      return await prisma.$transaction(async (tx) => {
        const created = await tx.pricingProfile.create({
          data: {
            code: input.code,
            version: nextVersion,
            // ---- inherited, not operator-editable ----
            marginModel: current.marginModel,
            targetGrossMarginRate: null,
            roundingRuleId: current.roundingRuleId,
            priceEndingRuleId: current.priceEndingRuleId,
            autoApplyToleranceBps: current.autoApplyToleranceBps,
            regularCardPriceRuleId: current.regularCardPriceRuleId,
            fixedCardUpliftRate: current.fixedCardUpliftRate,
            isPlaceholder: false,
            // ---- operator-entered ----
            targetMarkupRate: input.settings.targetMarkupRate,
            minGrossMarginRate: input.settings.minGrossMarginRate,
            minDollarProfitMinorUnits: input.settings.minDollarProfitMinorUnits,
            currency: input.settings.currency,
            effectiveFrom: input.effectiveFrom,
            createdBy: input.actorRef,
          },
        });

        await tx.auditEvent.create({
          data: {
            actorType: "staff",
            actorRef: input.actorRef,
            action: "pricing_profile.version_created",
            entityType: "pricing_profile",
            entityId: created.id,
            before: {
              version: current.version,
              profileId: current.id,
              targetMarkupRate: current.targetMarkupRate,
              minGrossMarginRate: current.minGrossMarginRate,
              minDollarProfitMinorUnits: current.minDollarProfit.amountMinorUnits.toString(),
              currency: current.minDollarProfit.currency,
            },
            after: {
              version: created.version,
              profileId: created.id,
              targetMarkupRate: input.settings.targetMarkupRate,
              minGrossMarginRate: input.settings.minGrossMarginRate,
              minDollarProfitMinorUnits: input.settings.minDollarProfitMinorUnits.toString(),
              currency: input.settings.currency,
              effectiveFrom: input.effectiveFrom.toISOString(),
            },
            reason: "pricing_profile_settings",
          },
        });

        return {
          id: created.id,
          code: created.code,
          version: created.version,
          effectiveFrom: created.effectiveFrom,
          previousVersion: current.version,
          previousId: current.id,
        };
      });
    } catch (error) {
      // P2002 on (code, version) means a concurrent save took this number.
      // Recompute and try again; anything else is a real failure.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
        lastConflict = error;
        continue;
      }
      throw error;
    }
  }

  void lastConflict;
  throw new PricingProfileVersionRaceError(MAX_VERSION_ATTEMPTS);
}
