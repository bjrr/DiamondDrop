import { prisma } from "~/db/client.server";
import { getLatestGroupBuyCampaignOptionsUpload, type FrozenGroupBuyCampaignOptionsPayload } from "~/db/repositories/groupBuyRepository.server";
import { hashCanonicalJson } from "~/domain/evidence/hash";
import type { JsonValue } from "~/domain/evidence";
import { MoneyDecimal, type MoneyDecimalValue } from "~/domain/money/decimal";
import { evaluateTierSafety, type TierSafetyReport } from "~/domain/groupbuy/tierSafety";
import { validateTierSet, type TierDefinition } from "~/domain/groupbuy/tiers";
import { computeBuyNowPrice } from "~/domain/pricing/engine";
import type { BuyNowPriceResult, BuyNowPricingInputs } from "~/domain/pricing/types";
import { ensureGroupBuyCampaignSyncedToCurrentTier } from "~/jobs/groupbuy/tierPriceSync.server";
import type { ShopifyPriceSyncPort } from "~/jobs/pricing/ports";
import { resolveInputsForVariant } from "~/jobs/pricing/resolveInputs.server";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { createProductionPriceSyncPort } from "~/shopify/admin/productionPriceSyncPort.server";

/**
 * Opening a Group Buy campaign — the FREEZE.
 *
 * README: "When a campaign opens, freeze/version its applicable cost inputs,
 * pricing assumptions, tier thresholds/percentages, and eligible-variant
 * prices. Market changes after opening must not retroactively alter campaign
 * tier prices."
 *
 * WHAT GETS FROZEN, AND WHY IT IS THE INPUTS AND NOT JUST THE PRICES. The
 * snapshot stores every resolved cost input behind each price, not merely the
 * resulting numbers. Storing only the prices makes a campaign unauditable the
 * moment anyone asks why a variant was priced as it was — and "the metal price
 * has moved since" is not an answer a dispute accepts. With the inputs, the
 * campaign can be RECOMPUTED years later and shown to be what it claimed.
 *
 * `frozenAsOf` is recorded for the same reason: a recomputation must resolve
 * inputs at the instant the freeze used, not at "now".
 *
 * ONE TRANSACTION. A campaign that is open but half-frozen would be quoting
 * prices with no recorded basis. The database also refuses that state
 * outright — see the open_is_frozen CHECK — so this cannot be got wrong by a
 * later caller either.
 *
 * SAFETY IS CHECKED BEFORE OPENING, NOT AFTER. The README requires every
 * allowed variant to be validated against the margin, dollar-profit and
 * variant floors before publication, with unsafe tiers blocked or explicitly
 * overridden. An unsafe campaign therefore cannot open by accident: the
 * override is a separate, attributed argument that a caller has to supply on
 * purpose.
 */

export class CampaignNotDraftError extends Error {
  constructor(id: string, status: string) {
    super(`Campaign ${id} is ${status}; only a draft campaign can be opened.`);
    this.name = "CampaignNotDraftError";
  }
}

export class CampaignIncompleteError extends Error {
  constructor(id: string, problem: string) {
    super(`Campaign ${id} cannot open: ${problem}`);
    this.name = "CampaignIncompleteError";
  }
}

/**
 * Carries the report so the caller can show exactly which variant and tier
 * failed, and why — refusing without saying what is wrong just moves the
 * guesswork to a human.
 */
export class UnsafeTiersError extends Error {
  constructor(
    readonly report: TierSafetyReport,
    readonly summary: string
  ) {
    super(`Campaign cannot open: ${summary}`);
    this.name = "UnsafeTiersError";
  }
}

/**
 * The campaign's price ladder does not fall monotonically for some variant.
 *
 * SEPARATE FROM UnsafeTiersError, and deliberately not carrying an override
 * path. The two faults are different in kind: an unsafe tier sells at a margin
 * the owner may still accept, while a rising price makes the storefront state
 * something false. Sharing an error type would invite sharing the override.
 */
export class BrokenPriceLadderError extends Error {
  constructor(
    readonly report: TierSafetyReport,
    readonly summary: string
  ) {
    super(
      `Campaign cannot open — the price ladder does not only fall: ${summary}. ` +
        `This cannot be overridden; adjust the tier multipliers so every tier's ` +
        `Bank Payment Price falls and its Regular/Card Price does not rise.`
    );
    this.name = "BrokenPriceLadderError";
  }
}

/**
 * The campaign froze and committed as `open` in Postgres, but its tier 1
 * price never reached Shopify.
 *
 * WHY THIS FAILS LOUDLY INSTEAD OF SWALLOWING THE PUBLISH ERROR (architect's
 * instruction, 2026-09-27, following from the gap found in
 * `docs/ARCHITECTURE-MVP1.md` §6.1). §6.1's whole safety argument — "a stale
 * cart can only hold a HIGHER price, which the ledger refunds" — depends on
 * the published Shopify price starting at tier 1 and only ever descending
 * from there. If the freeze committed but the publish failed, the variant is
 * still showing whatever it showed BEFORE the campaign opened (ordinarily its
 * last Buy Now price). That prior price is not guaranteed to be higher than
 * the newly frozen tier 1 price — costs can have moved between the last Buy
 * Now sync and this freeze's `asOf` — so leaving it live and silent risks the
 * exact underpayment §6.1 calls "impossible for a monotonic descent": a
 * customer paying less than tier 1, which floors the refund ledger at zero
 * and quietly stops the system's own safety argument from being true.
 *
 * THE OPEN ITSELF IS NOT ROLLED BACK. The freeze in Postgres is correct and
 * final regardless of whether Shopify was reachable a moment later — undoing
 * it would either need a status this schema does not have (there is no
 * "opened, awaiting publish" state) or would discard a legitimate,
 * safety-checked freeze over a transient network failure. So the campaign
 * IS open; `openGroupBuyCampaign` cannot be called again for it
 * (`CampaignNotDraftError` — it is no longer a draft), which is why this
 * error's message says so explicitly rather than reading like an ordinary
 * "open failed, try again" error.
 *
 * RECOVERY IS THE SAME IDEMPOTENT PATH THIS FILE ALREADY CALLS.
 * `ensureGroupBuyCampaignSyncedToCurrentTier` (tierPriceSync.server.ts) is
 * safe to call again for this campaign at any time — its own completion
 * marker means a retry that finds tier 1 already published is a no-op. Two
 * things will retry it without anyone doing anything: the incidental
 * self-heal (the next order placed against this campaign, however soon,
 * triggers the same call from the `orders/create` handler), or an operator
 * re-invoking the publish directly. Neither requires re-opening the
 * campaign.
 */
export class CampaignOpenTierPublishError extends Error {
  constructor(
    readonly campaignId: string,
    readonly cause: unknown
  ) {
    super(
      `Campaign ${campaignId} opened successfully (frozen and committed) but its tier 1 price ` +
        `failed to reach Shopify: ${cause instanceof Error ? cause.message : String(cause)}. ` +
        `The campaign IS open — do not attempt to open it again, it is no longer a draft. ` +
        `The publish will retry automatically the moment the next order for this campaign arrives, ` +
        `or it can be retried immediately by calling ensureGroupBuyCampaignSyncedToCurrentTier for this campaign.`
    );
    this.name = "CampaignOpenTierPublishError";
  }
}

export interface OpenCampaignOptions {
  campaignId: string;
  openedBy: string;
  /** Resolution instant. An input, never a clock read, so opens are reproducible. */
  asOf?: Date;
  /**
   * Required to open a campaign whose tiers breach a floor. Both fields must be
   * present together; the database refuses a half-recorded override.
   */
  unsafeOverride?: { by: string; reason: string };
  /** Injected in tests. Production default lazily creates the real Admin API-backed port. */
  resolveSyncPort?: () => Promise<ShopifyPriceSyncPort>;
}

export interface OpenCampaignResult {
  campaignId: string;
  openedAt: Date;
  frozenAsOf: Date;
  variantCount: number;
  tierCount: number;
  safety: TierSafetyReport;
  openedWithOverride: boolean;
  /**
   * Tier 1's publish outcome — see `CampaignOpenTierPublishError` for what
   * happens when this step fails instead of returning. `unresolvedVariantCount`
   * is NOT a failure — it counts eligible variants with no Shopify
   * product/variant id yet (see `tierPriceSync.server.ts`); campaign open
   * proceeds and returns normally even when it is greater than zero.
   */
  tierOnePublish: { tierNumber: number; syncedVariantCount: number; skipped: boolean; unresolvedVariantCount: number };
}

/**
 * TEMPORARY PRODUCTION LOCK (owner-directed 2026-09-28). Remove together with
 * `GROUP_BUY_CAMPAIGN_OPEN_ENABLED` once the seven-case acknowledgment live
 * gate has passed in production — see that variable's comment in
 * `~/lib/env.server.ts`.
 *
 * FIRST STATEMENT IN THE FUNCTION, deliberately. Opening a campaign freezes
 * pricing, publishes tier-1 prices to Shopify and makes the campaign
 * customer-facing; a guard placed after any of that would be refusing a
 * decision already partly taken.
 */
export class GroupBuyCampaignOpenLockedError extends Error {
  constructor() {
    super(
      "Opening a Group Buy campaign is locked in production until the " +
        "acknowledgment-before-counting path is deployed and live-proven. Public progress is " +
        "monotonic, so a unit counted for an unverified order can never be taken back. " +
        "Set GROUP_BUY_CAMPAIGN_OPEN_ENABLED=true only after the seven-case live gate passes."
    );
    this.name = "GroupBuyCampaignOpenLockedError";
  }
}

export async function openGroupBuyCampaign(
  options: OpenCampaignOptions
): Promise<OpenCampaignResult> {
  const env = getEnv();
  if (env.APP_ENV === "production" && env.GROUP_BUY_CAMPAIGN_OPEN_ENABLED !== "true") {
    logger.error("groupbuy.campaign_open_refused_production_lock", { campaignId: options.campaignId });
    throw new GroupBuyCampaignOpenLockedError();
  }

  const asOf = options.asOf ?? new Date();

  const campaign = await prisma.groupBuyCampaign.findUniqueOrThrow({
    where: { id: options.campaignId },
    include: { tiers: { orderBy: { tierNumber: "asc" } }, variants: true },
  });

  if (campaign.status !== "draft") {
    throw new CampaignNotDraftError(campaign.id, campaign.status);
  }
  if (campaign.variants.length === 0) {
    throw new CampaignIncompleteError(campaign.id, "it has no eligible variants");
  }

  const tiers: TierDefinition[] = campaign.tiers.map((t) => ({
    tierNumber: t.tierNumber,
    minQualifyingUnits: t.minQualifyingUnits,
    priceMultiplier: t.priceMultiplier.toString(),
  }));

  // Throws with every problem at once rather than the first.
  validateTierSet(tiers);

  // Resolve and price each eligible variant AT THE FREEZE INSTANT. This is the
  // same pipeline Buy Now uses — a second implementation would be free to
  // drift, and the drift would appear as a campaign whose frozen base price
  // disagreed with the Buy Now price for the identical variant on the same day.
  interface PricedVariant {
    masterVariantId: string;
    inputs: BuyNowPricingInputs;
    result: BuyNowPriceResult;
    profile: BuyNowPricingInputs["profile"];
    pricingProfileId: string;
    /** The frozen base is the BANK PAYMENT price; tier multipliers apply to it. */
    baseBankPaymentPriceMinorUnits: bigint;
    landedCostMinorUnits: MoneyDecimalValue;
    variantFloorMinorUnits: MoneyDecimalValue;
  }

  const priced: PricedVariant[] = [];
  for (const variant of campaign.variants) {
    const resolved = await resolveInputsForVariant(variant.masterVariantId, asOf);
    const result = computeBuyNowPrice(resolved.inputs);

    priced.push({
      masterVariantId: variant.masterVariantId,
      inputs: resolved.inputs,
      result,
      profile: resolved.inputs.profile,
      pricingProfileId: resolved.pricingProfileId,
      // THE BANK PAYMENT PRICE IS WHAT FREEZES. Tier multipliers apply to it and tier
      // safety judges it; the credit-card price is re-derived for display from
      // whatever bank price a tier produces, so freezing it too would store a
      // second number that could only ever agree or be wrong.
      baseBankPaymentPriceMinorUnits: BigInt(result.bankPaymentPrice.amountMinorUnits),
      landedCostMinorUnits: new MoneyDecimal(result.breakdown.landedCostMinorUnits),
      variantFloorMinorUnits: new MoneyDecimal(resolved.inputs.variantFloor?.amountMinorUnits ?? "0"),
    });
  }

  const first = priced[0]!;

  // ONE PROFILE GOVERNS THE WHOLE CAMPAIGN, and that is now checked rather than
  // assumed.
  //
  // `first.profile` supplies the floors, the rounding, the price ending and the
  // card rule for every variant below, and `first.pricingProfileId` is the one
  // id frozen on the campaign. That is sound only because every variant was
  // resolved at the same `asOf` and therefore resolved the same profile — true
  // today, and nothing enforced it.
  //
  // If it ever stopped being true the failure would be silent and serious: the
  // campaign would record a profile that did not govern some of its variants,
  // and every later reader — the storefront, the refund ledger, an auditor —
  // would price those variants under rules they were never validated against.
  const divergent = priced.find((p) => p.pricingProfileId !== first.pricingProfileId);
  if (divergent) {
    throw new CampaignIncompleteError(
      campaign.id,
      `its variants resolved different pricing profiles at ${asOf.toISOString()} ` +
        `(variant ${first.masterVariantId} -> ${first.pricingProfileId}, ` +
        `variant ${divergent.masterVariantId} -> ${divergent.pricingProfileId}); ` +
        `a campaign freezes one profile and cannot honestly record two`
    );
  }

  // Every variant against every tier — not just the deepest. A variant-specific
  // floor can sit above an INTERMEDIATE tier.
  const safety = evaluateTierSafety({
    variants: priced.map((p) => ({
      masterVariantId: p.masterVariantId,
      frozenBaseBankPaymentMinorUnits: p.baseBankPaymentPriceMinorUnits,
      landedCostMinorUnits: p.landedCostMinorUnits,
      variantFloorMinorUnits: p.variantFloorMinorUnits,
    })),
    tiers,
    profile: first.profile,
    roundingRuleId: first.profile.roundingRuleId,
    priceEndingRuleId: first.profile.priceEndingRuleId,
    // The card rule this campaign is about to freeze. Used only to validate the
    // displayed price ladder; it reaches no floor.
    regularCardPriceRuleId: first.profile.regularCardPriceRuleId,
    fixedCardUpliftRate: first.profile.fixedCardUpliftRate,
    currency: campaign.currency,
  });

  // A BROKEN PRICE LADDER IS NOT OVERRIDABLE, and that is the one place this
  // differs from a floor breach.
  //
  // The override exists so an owner can knowingly sell at a thin margin — a
  // commercial judgement that is theirs to make. There is no equivalent
  // judgement behind "the price rises as the group grows": the storefront would
  // tell a shopper the price drops at the next tier and then charge more. No
  // authority makes that true, so no authority can approve it.
  //
  // Checked BEFORE the override is consulted, so an override supplied for a
  // margin breach cannot carry a ladder fault through with it.
  if (safety.priceLadderProblems.length > 0) {
    throw new BrokenPriceLadderError(
      safety,
      safety.priceLadderProblems.map((p) => p.detail).join("; ")
    );
  }

  if (!safety.allSafe && !options.unsafeOverride) {
    const summary = safety.unsafe
      .map((u) => `variant ${u.masterVariantId} tier ${u.tierNumber} fails ${u.evaluation.failing.join(", ")}`)
      .join("; ");
    throw new UnsafeTiersError(safety, summary);
  }

  // PIN THE CAMPAIGN-OPTIONS CONFIGURATION IN FORCE, INTO THE FREEZE ITSELF
  // (architect review, 2026-09-26). The options upload store's own "current"
  // read (`getLatestGroupBuyCampaignOptionsUpload`) is correct today for any
  // already-open campaign too, because uploads are permanently refused once a
  // campaign is not draft — but an open/closed campaign's evidence should say
  // what was true AT OPEN, by id, embedded here, rather than depend on a
  // separate table continuing to answer the same question the same way
  // indefinitely. `getFrozenGroupBuyCampaignOptions` is the read path that
  // corresponds to this write; nothing after this point re-queries "latest"
  // for an open/closed campaign. `null` when the campaign never had an
  // options upload — that upload is optional (see
  // `app.group-buy-campaigns.$id.tsx`'s header comment on that point), not a
  // precondition of opening.
  const currentOptionsUpload = await getLatestGroupBuyCampaignOptionsUpload(campaign.id);
  const optionsAtFreeze: FrozenGroupBuyCampaignOptionsPayload | null = currentOptionsUpload
    ? {
        snapshotId: currentOptionsUpload.snapshotId,
        campaignId: currentOptionsUpload.campaignId,
        sequence: currentOptionsUpload.sequence,
        uploadedBy: currentOptionsUpload.uploadedBy,
        uploadedAt: currentOptionsUpload.uploadedAt.toISOString(),
        options: currentOptionsUpload.options,
        contentHash: currentOptionsUpload.contentHash,
      }
    : null;

  // The reproducibility contract. Normalised through JSON before hashing, the
  // same as pricing snapshots: the inputs carry optional fields that are
  // `undefined` in memory, and the canonicalizer refuses `undefined` rather
  // than guessing whether it meant "absent" or "null".
  const payload = JSON.parse(
    JSON.stringify({
      kind: "groupbuy.campaign_freeze.v1",
      campaignId: campaign.id,
      frozenAsOf: asOf.toISOString(),
      tiers,
      variants: priced.map((p) => ({
        masterVariantId: p.masterVariantId,
        inputs: p.inputs,
        result: p.result,
      })),
      optionsAtFreeze,
    })
  ) as JsonValue;

  const contentHash = hashCanonicalJson(payload);
  const openedAt = new Date();

  await prisma.$transaction(async (tx) => {
    const snapshot = await tx.snapshot.create({
      data: { kind: "groupbuy.campaign_freeze.v1", payload: payload as never, contentHash },
    });

    // Frozen prices are written while the campaign is STILL DRAFT — the
    // database trigger refuses writes to these tables once it is not.
    for (const p of priced) {
      await tx.groupBuyCampaignVariant.update({
        where: { campaignId_masterVariantId: { campaignId: campaign.id, masterVariantId: p.masterVariantId } },
        data: {
          frozenBaseBankPaymentPriceMinorUnits: p.baseBankPaymentPriceMinorUnits,
          frozenLandedCostMinorUnits: BigInt(p.landedCostMinorUnits.toDecimalPlaces(0).toString()),
        },
      });
    }

    await tx.groupBuyCampaign.update({
      where: { id: campaign.id },
      data: {
        status: "open",
        openedAt,
        frozenAsOf: asOf,
        snapshotId: snapshot.id,
        pricingProfileId: first.pricingProfileId,
        profileVersion: first.profile.version,
        ...(options.unsafeOverride
          ? {
              unsafeOverrideBy: options.unsafeOverride.by,
              unsafeOverrideReason: options.unsafeOverride.reason,
              unsafeOverrideAt: openedAt,
            }
          : {}),
      },
    });
  });

  // Logged at WARN when opened over a breach: a campaign selling below an
  // approved floor is an exceptional event even when authorised.
  const log = safety.allSafe ? logger.info : logger.warn;
  log("groupbuy.campaign_opened", {
    campaignId: campaign.id,
    openedBy: options.openedBy,
    variantCount: priced.length,
    tierCount: tiers.length,
    unsafeTierCount: safety.unsafe.length,
    openedWithOverride: Boolean(options.unsafeOverride),
    // No prices, costs or margins in logs (criterion 30).
  });

  // TIER 1 GOES TO SHOPIFY NOW, DELIBERATELY OUTSIDE THE TRANSACTION ABOVE.
  // A network call inside a database transaction would hold that transaction
  // (and its row locks) open for the duration of an Admin API round trip —
  // exactly the kind of coupling `syncApprovedIntent.server.ts` and this
  // file's own freeze both avoid elsewhere. The freeze is already committed
  // by this point; what happens next only decides whether Shopify agrees
  // with it yet.
  //
  // See `CampaignOpenTierPublishError`'s own doc comment for why a publish
  // failure here PROPAGATES rather than being logged and swallowed: the
  // freeze already committed, so there is no way to "fail the open" any
  // more — the only choice left is whether the caller finds out now (throw)
  // or discovers a silently stale, possibly-underpriced Shopify listing
  // later (swallow). This function chooses to throw.
  //
  // REUSES THE SAME IDEMPOTENT PATH THE ORDER WEBHOOK USES — not a second
  // publish route. `ensureGroupBuyCampaignSyncedToCurrentTier` reads the
  // live tier (tier 1, since nothing has purchased yet) and is a no-op if
  // this exact campaign/tier was already published, which is what makes it
  // safe to call again from here after a prior failed open attempt, or from
  // the very first order if this call never runs at all in an older code
  // path.
  const resolveSyncPort = options.resolveSyncPort ?? createProductionPriceSyncPort;
  let tierOnePublish: { tierNumber: number; syncedVariantCount: number; skipped: boolean; unresolvedVariantCount: number };
  try {
    const result = await ensureGroupBuyCampaignSyncedToCurrentTier(campaign.id, { resolveSyncPort });
    tierOnePublish = {
      tierNumber: result.tierNumber,
      syncedVariantCount: result.syncedVariantCount,
      skipped: result.skipped,
      unresolvedVariantCount: result.unresolvedVariantCount,
    };
    logger.info("groupbuy.campaign_open_tier1_published", {
      campaignId: campaign.id,
      tierNumber: result.tierNumber,
      syncedVariantCount: result.syncedVariantCount,
      skipped: result.skipped,
      unresolvedVariantCount: result.unresolvedVariantCount,
    });
  } catch (publishError) {
    logger.error("groupbuy.campaign_open_tier1_publish_failed", {
      campaignId: campaign.id,
      error: publishError instanceof Error ? publishError.message : String(publishError),
    });
    throw new CampaignOpenTierPublishError(campaign.id, publishError);
  }

  return {
    campaignId: campaign.id,
    openedAt,
    frozenAsOf: asOf,
    variantCount: priced.length,
    tierCount: tiers.length,
    tierOnePublish,
    safety,
    openedWithOverride: Boolean(options.unsafeOverride),
  };
}
