import { AppProvider } from "@shopify/shopify-app-react-router/react";
import { boundary } from "@shopify/shopify-app-react-router/server";
import type { ActionFunctionArgs, HeadersFunction, LoaderFunctionArgs } from "react-router";
import { Form, Link, useActionData, useLoaderData, useNavigation, useRouteError } from "react-router";
import type { CSSProperties, ReactNode } from "react";

import {
  GroupBuyCampaignNotDraftForConfigurationError,
  GroupBuyCampaignNotFoundError,
  addGroupBuyCampaignEligibleVariant,
  getFrozenGroupBuyCampaignOptions,
  getGroupBuyCampaignForStaff,
  getGroupBuyCampaignTierPublishStatus,
  getGroupBuyVariantIdentities,
  getLatestGroupBuyCampaignOptionsUpload,
  listMasterVariantsForGroupBuySelection,
  removeGroupBuyCampaignEligibleVariant,
  replaceGroupBuyCampaignTiers,
  saveGroupBuyCampaignOptionsUpload,
  type GroupBuyCampaignForStaff,
  type GroupBuyCampaignTierPublishStatus,
  type GroupBuyCandidateProductRow,
  type GroupBuyCampaignOptionsUpload,
  type GroupBuyVariantIdentity,
} from "~/db/repositories/groupBuyRepository.server";
import { validateGroupBuyCampaignOptions } from "~/domain/groupbuy/campaignOptions";
import { InvalidTierSetError, MAX_TIERS, type TierDefinition } from "~/domain/groupbuy/tiers";
import type { FloorId } from "~/domain/pricing/types";
import {
  BrokenPriceLadderError,
  CampaignIncompleteError,
  CampaignNotDraftError,
  UnsafeTiersError,
  openGroupBuyCampaign,
} from "~/jobs/groupbuy/openCampaign.server";
import {
  GroupBuyTierPriceSyncError,
  ensureGroupBuyCampaignSyncedToCurrentTier,
} from "~/jobs/groupbuy/tierPriceSync.server";
import { MoneyDecimal } from "~/domain/money/decimal";
import { getEnv } from "~/lib/env.server";
import { logger } from "~/lib/logger.server";
import { createProductionPriceSyncPort } from "~/shopify/admin/productionPriceSyncPort.server";
import { authenticate } from "~/shopify.server";

/**
 * GET/POST /app/group-buy-campaigns/:id — the Group Buy campaign detail,
 * draft configuration, campaign-options upload, and OPEN surface (Slice 6,
 * docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md §11-§13).
 *
 * CALLS THE REPOSITORY AND `openGroupBuyCampaign`; DOES NOT RE-DERIVE
 * ANYTHING. Tier validation (`validateTierSet`), campaign-options validation
 * (`validateGroupBuyCampaignOptions`), and tier/price-ladder safety
 * (`evaluateTierSafety`, inside `openGroupBuyCampaign`) are each owned
 * elsewhere; this route's job is attributing every write to the
 * AUTHENTICATED Shopify staff identity (D23, same as
 * `app.warranty-claims.$id.tsx`) and not offering a control the system
 * would refuse (`canConfigureDraft`/`canOpen` below).
 *
 * A DEFAULT EXPORT WITH AN ACTION — see `csrfResourceRouteFence.test.ts`'s
 * `EXEMPT_UI_ACTION_ROUTES` for the reasoned exemption entry added for this
 * route, identical argument to `app.warranty-claims.$id.tsx`.
 *
 * OPENING IS A ONE-WAY DOOR, NEVER A SIDE EFFECT. The "Open campaign —
 * freeze pricing" action is its own explicit form, gated to draft campaigns
 * only, and is never triggered by saving tiers, variants, or an options
 * upload. `openGroupBuyCampaign` can refuse in three DIFFERENT ways, each
 * rendered distinctly:
 *
 *   - `CampaignIncompleteError` / `CampaignNotDraftError` — plain refusal,
 *     no override concept applies.
 *   - `BrokenPriceLadderError` — NEVER OVERRIDABLE. No checkbox, no reason
 *     field, no path to retry with an override is ever rendered for this
 *     failure; the message says outright that it cannot be overridden.
 *   - `UnsafeTiersError` — OVERRIDABLE. Only here does the page offer an
 *     override control, and only after this exact failure has already been
 *     returned by a real attempt — the checkbox/reason fields do not exist
 *     on the form's first render.
 *
 * A misleading UI at this boundary is expensive: this is the moment money
 * gets locked for the life of the campaign.
 *
 * NEVER SHOWS supplier cost, margin, or internal pricing (CLAUDE.md rule
 * 10). `frozenLandedCostMinorUnits` is not in any view type below — not
 * merely unrendered, structurally absent. A tier-safety failure names WHICH
 * floor failed (`evaluation.failing`, e.g. "min_gross_margin") but never the
 * margin rate or dollar contribution that `evaluateTierSafety` computed
 * along the way.
 *
 * TIER-PRICE-SYNC RECOVERY (architect assignment, 2026-09-27, closing the gap
 * `CampaignOpenTierPublishError`'s own doc comment names). `openGroupBuyCampaign`
 * fails LOUDLY when tier 1's publish to Shopify fails, but deliberately does
 * NOT roll back the freeze — leaving the campaign open with no way for staff to
 * retry the publish except waiting for the next order (which pays at whatever
 * price is currently live, possibly wrong — see that error's own comment for
 * why a stale pre-campaign price is not guaranteed to be higher than tier 1).
 * `campaign.tierPublish` (from `getGroupBuyCampaignTierPublishStatus`, a
 * read-only check against the same completion marker the sync job itself
 * writes) makes that gap VISIBLE without anyone needing to already know the
 * failure mode exists, and the `resync_tier_price` action calls the exact
 * same idempotent recovery path the error message names
 * (`ensureGroupBuyCampaignSyncedToCurrentTier`) — safe to press at any time,
 * including when nothing is wrong, because that function's own completion
 * marker already makes an up-to-date resync a no-op.
 */

// ---------------------------------------------------------------------------
// View models — explicit field lists, never a raw spread of a Prisma row.
// BigInt/Date/Decimal are stringified at this boundary.
// ---------------------------------------------------------------------------

interface TierView {
  readonly tierNumber: number;
  readonly minQualifyingUnits: number;
  readonly priceMultiplier: string;
  readonly percentOff: string;
}

interface EligibleVariantView {
  readonly masterVariantId: string;
  readonly productName: string;
  readonly metal: string;
  readonly purity: string;
  readonly bandLabel: string | null;
  /** Only meaningful once the campaign is not draft — null while draft (the DB value is a NOT-NULL placeholder, never a real price; see addGroupBuyCampaignEligibleVariant's own comment). */
  readonly frozenBaseBankPaymentPrice: string | null;
}

interface CampaignView {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: string;
  readonly currency: string;
  readonly scheduledCloseAt: string | null;
  readonly openedAt: string | null;
  readonly closedAt: string | null;
  readonly createdAt: string;
  readonly finalTierNumber: number | null;
  readonly finalQualifyingUnits: number | null;
  readonly unsafeOverrideBy: string | null;
  readonly unsafeOverrideReason: string | null;
  readonly unsafeOverrideAt: string | null;
  readonly tiers: readonly TierView[];
  readonly variants: readonly EligibleVariantView[];
  readonly tierPublish: TierPublishView | null;
}

/**
 * Whether the campaign's CURRENT tier price has ever fully reached Shopify —
 * `null` (not applicable) for a draft or closed campaign; see
 * `getGroupBuyCampaignTierPublishStatus`'s own doc comment. No cost, margin,
 * or Shopify processor detail here — only the tier number, the live
 * qualifying-unit count, and a boolean.
 */
interface TierPublishView {
  readonly tierNumber: number;
  readonly qualifyingUnits: number;
  readonly published: boolean;
}

interface CandidateVariantOption {
  readonly masterVariantId: string;
  readonly label: string;
}

interface OptionsUploadView {
  readonly sequence: number;
  readonly uploadedBy: string;
  readonly uploadedAt: string;
  readonly contentHash: string;
  readonly rawJson: string;
  /** True once the campaign is not draft — this is the configuration PINNED at open, read from the freeze, never a live "latest" re-query (see getFrozenGroupBuyCampaignOptions). */
  readonly pinnedAtOpen: boolean;
}

interface LoaderData {
  apiKey: string;
  shop: string;
  campaign: CampaignView | null;
  candidateVariants: readonly CandidateVariantOption[];
  optionsUpload: OptionsUploadView | null;
}

function formatMoney(minorUnits: string, currency: string): string {
  const negative = minorUnits.startsWith("-");
  const digits = negative ? minorUnits.slice(1) : minorUnits;
  const padded = digits.padStart(3, "0");
  const major = padded.slice(0, -2);
  const minor = padded.slice(-2);
  const grouped = major.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${negative ? "-" : ""}${currency} ${grouped}.${minor}`;
}

function buildCampaignView(
  campaign: GroupBuyCampaignForStaff,
  identities: readonly GroupBuyVariantIdentity[],
  tierPublish: GroupBuyCampaignTierPublishStatus | null
): CampaignView {
  const identityById = new Map(identities.map((i) => [i.masterVariantId, i] as const));
  const isDraft = campaign.status === "draft";

  return {
    id: campaign.id,
    code: campaign.code,
    name: campaign.name,
    status: campaign.status,
    currency: campaign.currency,
    scheduledCloseAt: campaign.scheduledCloseAt ? campaign.scheduledCloseAt.toISOString() : null,
    openedAt: campaign.openedAt ? campaign.openedAt.toISOString() : null,
    closedAt: campaign.closedAt ? campaign.closedAt.toISOString() : null,
    createdAt: campaign.createdAt.toISOString(),
    finalTierNumber: campaign.finalTierNumber,
    finalQualifyingUnits: campaign.finalQualifyingUnits,
    unsafeOverrideBy: campaign.unsafeOverrideBy,
    unsafeOverrideReason: campaign.unsafeOverrideReason,
    unsafeOverrideAt: campaign.unsafeOverrideAt ? campaign.unsafeOverrideAt.toISOString() : null,
    tiers: [...campaign.tiers]
      .sort((a, b) => a.tierNumber - b.tierNumber)
      .map((tier) => {
        const multiplier = new MoneyDecimal(tier.priceMultiplier.toString());
        // decimal.js's own decimal-places rounding, formatted via toString()
        // rather than Number.prototype's fixed-decimal formatter — the
        // repo-wide money-safety scan flags that lexical pattern outside its
        // one reviewed allow-list entry (scripts/check-money-safety.mjs).
        // This is a display-only value (a form default), never written back
        // to a money/multiplier column.
        const percentOff = new MoneyDecimal(100).minus(multiplier.times(100)).toDecimalPlaces(4).toString();
        return {
          tierNumber: tier.tierNumber,
          minQualifyingUnits: tier.minQualifyingUnits,
          priceMultiplier: tier.priceMultiplier.toString(),
          percentOff,
        };
      }),
    variants: campaign.variants.map((variant) => {
      const identity = identityById.get(variant.masterVariantId);
      return {
        masterVariantId: variant.masterVariantId,
        productName: identity?.productName ?? "(unknown product)",
        metal: identity?.metal ?? "?",
        purity: identity?.purity ?? "?",
        bandLabel: identity?.bandLabel ?? null,
        frozenBaseBankPaymentPrice: isDraft ? null : variant.frozenBaseBankPaymentPriceMinorUnits.toString(),
      };
    }),
    tierPublish: tierPublish
      ? { tierNumber: tierPublish.tierNumber, qualifyingUnits: tierPublish.qualifyingUnits, published: tierPublish.published }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Which controls the UI may offer, given the campaign's CURRENT status —
// same discipline as `app.warranty-claims.$id.tsx`'s canX() functions.
// ---------------------------------------------------------------------------

function canConfigureDraft(status: string): boolean {
  return status === "draft";
}
function canOpen(status: string): boolean {
  return status === "draft";
}
/** Resync is only meaningful once a tier price could exist to publish — i.e. only while open. Safe to press at any time within that window, per this route's header comment: an up-to-date resync is a no-op. */
function canResyncTierPrice(status: string): boolean {
  return status === "open";
}

// ---------------------------------------------------------------------------
// Staff identity — D23, identical to app.warranty-claims.$id.tsx.
// ---------------------------------------------------------------------------

function resolveStaffActorRef(session: Awaited<ReturnType<typeof authenticate.admin>>["session"]): string | null {
  const associatedUser = session.onlineAccessInfo?.associated_user;
  if (!associatedUser) return null;
  return `staff:${associatedUser.id}`;
}

// ---------------------------------------------------------------------------
// Tier-row parsing — deliberately duplicated from app.group-buy-campaigns.new.tsx
// rather than factored into a shared module: this task's scope is
// `app/app/routes/app.group-buy-campaigns*` plus tests only, and a shared
// helper file under `app/routes/` would itself become a route under
// React Router's flat-routes convention (dots are path separators). The
// duplicated block is small and self-contained.
// ---------------------------------------------------------------------------

const PERCENT_PATTERN = /^\d+(\.\d{1,4})?$/;

function stringField(formData: FormData, name: string): string {
  const value = formData.get(name);
  return typeof value === "string" ? value : "";
}

function parseTierRow(formData: FormData, rowIndex: number): { tier: TierDefinition } | { problem: string } | null {
  const tierNumber = rowIndex + 1;
  const unitsRaw = stringField(formData, `tierUnits_${tierNumber}`).trim();
  const percentRaw = stringField(formData, `tierPercentOff_${tierNumber}`).trim();

  if (unitsRaw === "" && percentRaw === "") return null;
  if (unitsRaw === "" || percentRaw === "") {
    return { problem: `tier ${tierNumber}: both qualifying units and percent off are required, or leave both blank to omit this tier` };
  }

  const minQualifyingUnits = Number(unitsRaw);
  if (!Number.isInteger(minQualifyingUnits) || minQualifyingUnits < 1) {
    return { problem: `tier ${tierNumber}: qualifying units must be a positive whole number, got "${unitsRaw}"` };
  }

  if (!PERCENT_PATTERN.test(percentRaw)) {
    return { problem: `tier ${tierNumber}: percent off must be a plain number with up to 4 decimal places (e.g. 10 or 12.5), got "${percentRaw}"` };
  }
  const percentOff = new MoneyDecimal(percentRaw);
  if (percentOff.lessThan(0) || percentOff.greaterThanOrEqualTo(100)) {
    return { problem: `tier ${tierNumber}: percent off must be at least 0 and less than 100, got "${percentRaw}"` };
  }

  // decimal.js's own decimal-places rounding, formatted via toString() —
  // see the header note above the equivalent line in
  // app.group-buy-campaigns.new.tsx for why this avoids the money-safety
  // scan's flagged lexical pattern.
  const priceMultiplier = new MoneyDecimal(100).minus(percentOff).dividedBy(100).toDecimalPlaces(6).toString();
  return { tier: { tierNumber, minQualifyingUnits, priceMultiplier } };
}

function parseTierRows(formData: FormData): { tiers: TierDefinition[] } | { problems: readonly string[] } {
  const tiers: TierDefinition[] = [];
  const problems: string[] = [];
  for (let i = 0; i < MAX_TIERS; i++) {
    const result = parseTierRow(formData, i);
    if (result === null) continue;
    if ("problem" in result) problems.push(result.problem);
    else tiers.push(result.tier);
  }
  if (problems.length > 0) return { problems };
  return { tiers };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

function serializeCandidates(products: readonly GroupBuyCandidateProductRow[]): CandidateVariantOption[] {
  const options: CandidateVariantOption[] = [];
  for (const product of products) {
    for (const variant of product.variants) {
      options.push({
        masterVariantId: variant.masterVariantId,
        label: `${product.name} — ${variant.metal} ${variant.purity}${variant.bandLabel ? ` (${variant.bandLabel})` : ""}`,
      });
    }
  }
  return options;
}

export async function loader({ request, params }: LoaderFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const id = params.id;
  if (!id) throw new Response("Missing Group Buy campaign id.", { status: 400 });

  const campaign = await getGroupBuyCampaignForStaff(id);
  if (!campaign) {
    return {
      apiKey: getEnv().SHOPIFY_API_KEY ?? "",
      shop: session.shop,
      campaign: null,
      candidateVariants: [],
      optionsUpload: null,
    } satisfies LoaderData;
  }

  const isDraft = campaign.status === "draft";
  // WHICH OPTIONS-UPLOAD READ PATH DEPENDS ON WHETHER A FREEZE HAS HAPPENED
  // YET (architect review, 2026-09-26). While draft, uploads can still
  // change, so "current" means the mutable store's own current answer
  // (`getLatestGroupBuyCampaignOptionsUpload`). Once not draft, no further
  // upload can ever be recorded (the draft-only guard is permanent), so the
  // only correct source is what `openGroupBuyCampaign` actually pinned into
  // the freeze (`getFrozenGroupBuyCampaignOptions`) — never a live
  // "latest" re-query against a table whose selection rule could, in
  // principle, change later for reasons unrelated to this campaign.
  const [candidateProducts, identities, optionsUpload, tierPublish] = await Promise.all([
    isDraft ? listMasterVariantsForGroupBuySelection() : Promise.resolve([]),
    getGroupBuyVariantIdentities(campaign.variants.map((v) => v.masterVariantId)),
    isDraft ? getLatestGroupBuyCampaignOptionsUpload(id) : getFrozenGroupBuyCampaignOptions(campaign.snapshotId),
    // `null` for a draft/closed campaign — see getGroupBuyCampaignTierPublishStatus's own doc comment.
    getGroupBuyCampaignTierPublishStatus(id),
  ]);

  const alreadyEligible = new Set(campaign.variants.map((v) => v.masterVariantId));
  const candidateVariants = serializeCandidates(candidateProducts).filter((c) => !alreadyEligible.has(c.masterVariantId));

  return {
    apiKey: getEnv().SHOPIFY_API_KEY ?? "",
    shop: session.shop,
    campaign: buildCampaignView(campaign, identities, tierPublish),
    candidateVariants,
    optionsUpload: serializeOptionsUpload(optionsUpload, !isDraft),
  } satisfies LoaderData;
}

function serializeOptionsUpload(upload: GroupBuyCampaignOptionsUpload | null, pinnedAtOpen: boolean): OptionsUploadView | null {
  if (!upload) return null;
  return {
    sequence: upload.sequence,
    uploadedBy: upload.uploadedBy,
    uploadedAt: upload.uploadedAt.toISOString(),
    contentHash: upload.contentHash,
    rawJson: JSON.stringify(upload.options, null, 2),
    pinnedAtOpen,
  };
}

// ---------------------------------------------------------------------------
// Action
// ---------------------------------------------------------------------------

interface OpenBlockedUnsafe {
  readonly kind: "unsafe";
  readonly entries: readonly { masterVariantId: string; tierNumber: number; failing: readonly FloorId[] }[];
}
interface OpenBlockedLadder {
  readonly kind: "ladder";
  readonly problems: readonly { masterVariantId: string; priorTierNumber: number; tierNumber: number; detail: string }[];
}

interface TierResyncResult {
  readonly tierNumber: number;
  /** True when a prior completed sync already covered this tier — no Shopify call was made. */
  readonly skipped: boolean;
  readonly syncedVariantCount: number;
  readonly unresolvedVariantCount: number;
}

interface ActionData {
  ok: boolean;
  formError: string | null;
  problems: readonly string[];
  openBlocked?: OpenBlockedUnsafe | OpenBlockedLadder;
  tierResyncResult?: TierResyncResult;
}

function ok(): ActionData {
  return { ok: true, formError: null, problems: [] };
}
function fail(formError: string, problems: readonly string[] = []): ActionData {
  return { ok: false, formError, problems };
}

export async function action({ request, params }: ActionFunctionArgs) {
  const { session } = await authenticate.admin(request);
  const id = params.id;
  if (!id) return Response.json(fail("Missing Group Buy campaign id."), { status: 400 });
  if (request.method !== "POST") return Response.json(fail("Method not allowed."), { status: 405 });

  const staffActorRef = resolveStaffActorRef(session);
  if (!staffActorRef) {
    logger.error("group_buy_campaigns.no_online_user", { campaignId: id });
    return Response.json(
      fail(
        "This request could not be attributed to a signed-in Shopify staff member (no online session). Reload the page and try again."
      ),
      { status: 401 }
    );
  }

  const formData = await request.formData();
  const intent = stringField(formData, "intent");

  try {
    switch (intent) {
      case "replace_tiers": {
        const parsed = parseTierRows(formData);
        if ("problems" in parsed) {
          return Response.json(fail("Fix the tier rows below before saving.", parsed.problems), { status: 400 });
        }
        await replaceGroupBuyCampaignTiers(id, parsed.tiers);
        return Response.json(ok());
      }

      case "add_variant": {
        const masterVariantId = stringField(formData, "masterVariantId").trim();
        if (!masterVariantId) return Response.json(fail("Select a variant to add."), { status: 400 });
        await addGroupBuyCampaignEligibleVariant(id, masterVariantId);
        return Response.json(ok());
      }

      case "remove_variant": {
        const masterVariantId = stringField(formData, "masterVariantId").trim();
        if (!masterVariantId) return Response.json(fail("Missing variant id."), { status: 400 });
        await removeGroupBuyCampaignEligibleVariant(id, masterVariantId);
        return Response.json(ok());
      }

      case "upload_options": {
        const raw = stringField(formData, "optionsJson");
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(raw);
        } catch (error) {
          return Response.json(
            fail(`That upload is not valid JSON: ${error instanceof Error ? error.message : String(error)}`),
            { status: 400 }
          );
        }
        const result = validateGroupBuyCampaignOptions(parsedJson);
        if (!result.ok) {
          // Every problem verbatim, including the offending key and its
          // path — never collapsed to "invalid configuration". See this
          // route's header comment and campaignOptions.ts's own rationale.
          return Response.json(fail("The campaign-options upload was rejected.", result.problems), { status: 400 });
        }
        await saveGroupBuyCampaignOptionsUpload(id, result.value, staffActorRef);
        return Response.json(ok());
      }

      case "open_campaign": {
        const overrideConfirmed = stringField(formData, "overrideConfirmed") === "on";
        const overrideReason = stringField(formData, "overrideReason").trim();
        if (overrideConfirmed && overrideReason === "") {
          return Response.json(
            fail("An override reason is required to open a campaign with an overridden tier-safety exception."),
            { status: 400 }
          );
        }

        const result = await openGroupBuyCampaign({
          campaignId: id,
          openedBy: staffActorRef,
          ...(overrideConfirmed ? { unsafeOverride: { by: staffActorRef, reason: overrideReason } } : {}),
        });
        logger.info("group_buy_campaigns.opened_via_admin", {
          campaignId: id,
          openedBy: staffActorRef,
          openedWithOverride: result.openedWithOverride,
        });
        return Response.json(ok());
      }

      case "resync_tier_price": {
        // THE SAME IDEMPOTENT RECOVERY PATH `CampaignOpenTierPublishError`
        // NAMES — see this route's header comment. Safe to press whether or
        // not anything is actually wrong: an up-to-date campaign's resync is
        // a no-op (`result.skipped`), not a second Shopify call.
        const result = await ensureGroupBuyCampaignSyncedToCurrentTier(id, {
          resolveSyncPort: createProductionPriceSyncPort,
        });
        logger.info("group_buy_campaigns.tier_price_resync_via_admin", {
          campaignId: id,
          triggeredBy: staffActorRef,
          tierNumber: result.tierNumber,
          skipped: result.skipped,
          syncedVariantCount: result.syncedVariantCount,
          unresolvedVariantCount: result.unresolvedVariantCount,
        });
        return Response.json({
          ...ok(),
          tierResyncResult: {
            tierNumber: result.tierNumber,
            skipped: result.skipped,
            syncedVariantCount: result.syncedVariantCount,
            unresolvedVariantCount: result.unresolvedVariantCount,
          },
        } satisfies ActionData);
      }

      default:
        return Response.json(fail(`Unrecognized action: ${intent}`), { status: 400 });
    }
  } catch (error) {
    if (error instanceof GroupBuyCampaignNotFoundError) {
      return Response.json(fail("That Group Buy campaign no longer exists."), { status: 404 });
    }
    if (error instanceof GroupBuyCampaignNotDraftForConfigurationError) {
      return Response.json(fail(error.message), { status: 409 });
    }
    if (error instanceof InvalidTierSetError) {
      return Response.json(fail("The tier set is invalid.", error.problems), { status: 400 });
    }
    if (error instanceof CampaignNotDraftError) {
      return Response.json(fail(error.message), { status: 409 });
    }
    if (error instanceof CampaignIncompleteError) {
      return Response.json(fail(error.message), { status: 400 });
    }
    if (error instanceof GroupBuyTierPriceSyncError) {
      // NEVER the raw Shopify processor/API error text — `error.failures`
      // entries are `variant <id>: <Error.name>` (a class name, e.g.
      // "AdminApiError"), never a raw API error message, but this UI
      // surfaces only the count and tier, staying well inside that existing
      // ceiling rather than testing it.
      logger.error("group_buy_campaigns.tier_price_resync_failed", {
        campaignId: id,
        triggeredBy: staffActorRef,
        tierNumber: error.tierNumber,
        failureCount: error.failures.length,
      });
      return Response.json(
        fail(
          `Resync could not publish tier ${error.tierNumber} to Shopify for ${error.failures.length} variant(s). ` +
            "The frozen campaign pricing in our system is unaffected. Try again, or wait — the next order for this " +
            "campaign retries the same publish automatically."
        ),
        { status: 502 }
      );
    }
    if (error instanceof BrokenPriceLadderError) {
      // NEVER OVERRIDABLE — no override fields are read for this branch, and
      // the UI (below) renders no checkbox/reason control for `kind: "ladder"`.
      const openBlocked: OpenBlockedLadder = {
        kind: "ladder",
        problems: error.report.priceLadderProblems.map((p) => ({
          masterVariantId: p.masterVariantId,
          priorTierNumber: p.priorTierNumber,
          tierNumber: p.tierNumber,
          detail: p.detail,
        })),
      };
      return Response.json(
        {
          ok: false,
          formError:
            "The price ladder does not only fall for one or more variants. This cannot be overridden — adjust the tier multipliers.",
          problems: [],
          openBlocked,
        } satisfies ActionData,
        { status: 409 }
      );
    }
    if (error instanceof UnsafeTiersError) {
      // OVERRIDABLE — the UI renders a checkbox + required reason only in
      // response to exactly this failure kind.
      const openBlocked: OpenBlockedUnsafe = {
        kind: "unsafe",
        entries: error.report.unsafe.map((u) => ({
          masterVariantId: u.masterVariantId,
          tierNumber: u.tierNumber,
          failing: u.evaluation.failing,
        })),
      };
      return Response.json(
        {
          ok: false,
          formError:
            "One or more tiers fail a configured pricing floor. Review the affected variants below, then open with an explicit override if the exception is authorized.",
          problems: [],
          openBlocked,
        } satisfies ActionData,
        { status: 409 }
      );
    }
    const message = error instanceof Error ? error.message : String(error);
    if (message.toLowerCase().includes("unique constraint")) {
      return Response.json(fail("That variant is already eligible for this campaign."), { status: 409 });
    }
    logger.error("group_buy_campaigns.action_failed", {
      campaignId: id,
      intent,
      message,
    });
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Display helpers
// ---------------------------------------------------------------------------

function formatTimestamp(iso8601: string | null): string {
  if (!iso8601) return "—";
  return `${iso8601.replace("T", " ").slice(0, 16)} UTC`;
}

const FLOOR_LABELS: Record<string, string> = {
  min_gross_margin: "minimum gross margin",
  min_dollar_profit: "minimum dollar profit",
  variant_floor: "variant-specific price floor",
};

function statusLabel(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

const sectionStyle: CSSProperties = { marginBottom: "1.5rem", border: "1px solid #ddd", borderRadius: "4px", padding: "1rem" };
const labelStyle: CSSProperties = { display: "block", fontWeight: 600, fontSize: "0.875rem", marginBottom: "0.25rem" };
const inputStyle: CSSProperties = { display: "block", padding: "0.4rem 0.6rem", width: "100%", maxWidth: "24rem", marginBottom: "0.6rem" };

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt style={{ display: "inline", fontWeight: 600 }}>{label}: </dt>
      <dd style={{ display: "inline", margin: 0 }}>{children}</dd>
    </div>
  );
}

export default function GroupBuyCampaignDetailPage() {
  const { apiKey, shop, campaign, candidateVariants, optionsUpload } = useLoaderData<typeof loader>();
  const actionData = useActionData<ActionData>();
  const navigation = useNavigation();
  const busy = navigation.state !== "idle";

  const variantLabelById = new Map(
    (campaign?.variants ?? []).map((v) => [v.masterVariantId, `${v.productName} — ${v.metal} ${v.purity}${v.bandLabel ? ` (${v.bandLabel})` : ""}`])
  );

  return (
    <AppProvider apiKey={apiKey}>
      <main style={{ fontFamily: "system-ui, sans-serif", padding: "1.5rem", lineHeight: 1.5, maxWidth: "56rem" }}>
        <p style={{ margin: "0 0 0.5rem" }}>
          <Link to="/app/group-buy-campaigns">&larr; Back to Group Buy campaigns</Link>
        </p>
        <h1 style={{ fontSize: "1.25rem", margin: "0 0 0.5rem" }}>Group Buy campaign</h1>
        <p style={{ margin: "0 0 1.5rem", color: "#555" }}>
          Connected to <strong>{shop}</strong>.
        </p>

        {!campaign ? (
          <p role="alert" style={{ color: "#b00" }}>
            That Group Buy campaign was not found.
          </p>
        ) : (
          <>
            {actionData?.formError ? (
              <div role="alert" style={{ color: "#b00", margin: "0 0 1rem", border: "1px solid #b00", borderRadius: "4px", padding: "0.75rem 1rem" }}>
                <p style={{ margin: "0 0 0.25rem", fontWeight: 600 }}>{actionData.formError}</p>
                {actionData.problems.length > 0 ? (
                  <ul style={{ margin: "0.25rem 0 0", paddingLeft: "1.25rem" }}>
                    {actionData.problems.map((problem, i) => (
                      <li key={i}>{problem}</li>
                    ))}
                  </ul>
                ) : null}
              </div>
            ) : null}

            <section style={sectionStyle}>
              <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>
                {campaign.code} — {campaign.name} — <span style={{ fontWeight: 400 }}>{statusLabel(campaign.status)}</span>
              </h2>
              <dl style={{ margin: 0, fontSize: "0.875rem", display: "grid", rowGap: "0.35rem" }}>
                <Row label="Currency">{campaign.currency}</Row>
                <Row label="Scheduled close">{formatTimestamp(campaign.scheduledCloseAt)}</Row>
                <Row label="Opened">{formatTimestamp(campaign.openedAt)}</Row>
                <Row label="Closed">{formatTimestamp(campaign.closedAt)}</Row>
                {campaign.finalTierNumber !== null ? <Row label="Final tier">{campaign.finalTierNumber}</Row> : null}
                {campaign.finalQualifyingUnits !== null ? (
                  <Row label="Final qualifying units">{campaign.finalQualifyingUnits}</Row>
                ) : null}
                {campaign.unsafeOverrideBy ? (
                  <>
                    <Row label="Opened with tier-safety override by">{campaign.unsafeOverrideBy}</Row>
                    <Row label="Override reason">{campaign.unsafeOverrideReason}</Row>
                    <Row label="Override at">{formatTimestamp(campaign.unsafeOverrideAt)}</Row>
                  </>
                ) : null}
              </dl>
            </section>

            {campaign.tierPublish ? (
              <section
                style={{
                  ...sectionStyle,
                  border: campaign.tierPublish.published ? sectionStyle.border : "2px solid #b00",
                }}
              >
                <h2
                  style={{
                    fontSize: "1rem",
                    margin: "0 0 0.5rem",
                    color: campaign.tierPublish.published ? undefined : "#b00",
                  }}
                >
                  Shopify tier-price sync
                </h2>
                {campaign.tierPublish.published ? (
                  <p style={{ margin: "0 0 0.75rem", fontSize: "0.875rem", color: "#2a7a2a" }}>
                    Tier {campaign.tierPublish.tierNumber} ({campaign.tierPublish.qualifyingUnits} qualifying units)
                    is published and live on Shopify.
                  </p>
                ) : (
                  <p role="alert" style={{ margin: "0 0 0.75rem", fontSize: "0.875rem", fontWeight: 600, color: "#b00" }}>
                    Tier {campaign.tierPublish.tierNumber} ({campaign.tierPublish.qualifyingUnits} qualifying units)
                    has NOT reached Shopify. The storefront may still be showing a stale price. Resync now, or wait
                    for the next order to retry automatically.
                  </p>
                )}
                {actionData?.tierResyncResult ? (
                  <p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem", color: "#555" }}>
                    {actionData.tierResyncResult.skipped
                      ? `Already up to date — tier ${actionData.tierResyncResult.tierNumber} was already published; no Shopify call was made.`
                      : actionData.tierResyncResult.unresolvedVariantCount > 0
                        ? `Published tier ${actionData.tierResyncResult.tierNumber} to ${actionData.tierResyncResult.syncedVariantCount} variant(s); ${actionData.tierResyncResult.unresolvedVariantCount} variant(s) have no Shopify product yet and were skipped.`
                        : `Published tier ${actionData.tierResyncResult.tierNumber} to ${actionData.tierResyncResult.syncedVariantCount} variant(s).`}
                  </p>
                ) : null}
                {canResyncTierPrice(campaign.status) ? (
                  <Form method="post">
                    <input type="hidden" name="intent" value="resync_tier_price" />
                    <button type="submit" disabled={busy}>
                      Resync tier price to Shopify
                    </button>
                  </Form>
                ) : null}
              </section>
            ) : null}

            <section style={sectionStyle}>
              <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Tiers</h2>
              {campaign.tiers.length === 0 ? (
                <p style={{ margin: "0 0 0.75rem", fontSize: "0.875rem", color: "#555" }}>No tiers configured yet.</p>
              ) : (
                <table style={{ borderCollapse: "collapse", fontSize: "0.875rem", marginBottom: "0.75rem" }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.35rem 0.75rem 0.35rem 0" }}>Tier</th>
                      <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.35rem 0.75rem" }}>Qualifying units</th>
                      <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.35rem 0.75rem" }}>Percent off</th>
                    </tr>
                  </thead>
                  <tbody>
                    {campaign.tiers.map((tier) => (
                      <tr key={tier.tierNumber}>
                        <td style={{ padding: "0.35rem 0.75rem 0.35rem 0" }}>{tier.tierNumber}</td>
                        <td style={{ padding: "0.35rem 0.75rem" }}>{tier.minQualifyingUnits}</td>
                        <td style={{ padding: "0.35rem 0.75rem" }}>{tier.percentOff}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {canConfigureDraft(campaign.status) ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="replace_tiers" />
                  <p style={{ margin: "0 0 0.5rem", fontSize: "0.8rem", color: "#555" }}>
                    Saving replaces the entire tier set (draft only — tiers freeze permanently when the campaign opens).
                    Fill consecutive rows starting at Tier 1; leave trailing rows blank.
                  </p>
                  {Array.from({ length: MAX_TIERS }, (_, i) => i + 1).map((tierNumber) => {
                    const existing = campaign.tiers.find((t) => t.tierNumber === tierNumber);
                    return (
                      <div key={tierNumber} style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end", marginBottom: "0.5rem" }}>
                        <span style={{ fontSize: "0.875rem", fontWeight: 600, minWidth: "3.5rem" }}>Tier {tierNumber}</span>
                        <div>
                          <label htmlFor={`tierUnits_${tierNumber}`} style={{ ...labelStyle, marginBottom: "0.15rem" }}>
                            Qualifying units
                          </label>
                          <input
                            id={`tierUnits_${tierNumber}`}
                            name={`tierUnits_${tierNumber}`}
                            type="text"
                            inputMode="numeric"
                            defaultValue={existing?.minQualifyingUnits ?? ""}
                            style={{ ...inputStyle, maxWidth: "8rem", marginBottom: 0 }}
                          />
                        </div>
                        <div>
                          <label htmlFor={`tierPercentOff_${tierNumber}`} style={{ ...labelStyle, marginBottom: "0.15rem" }}>
                            Percent off
                          </label>
                          <input
                            id={`tierPercentOff_${tierNumber}`}
                            name={`tierPercentOff_${tierNumber}`}
                            type="text"
                            inputMode="decimal"
                            defaultValue={existing?.percentOff ?? ""}
                            style={{ ...inputStyle, maxWidth: "8rem", marginBottom: 0 }}
                          />
                        </div>
                      </div>
                    );
                  })}
                  <button type="submit" disabled={busy}>
                    Save tiers
                  </button>
                </Form>
              ) : (
                <p style={{ margin: 0, fontSize: "0.8rem", color: "#555" }}>
                  Tiers are frozen and cannot be edited once the campaign is not draft.
                </p>
              )}
            </section>

            <section style={sectionStyle}>
              <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Eligible variants</h2>
              {campaign.variants.length === 0 ? (
                <p style={{ margin: "0 0 0.75rem", fontSize: "0.875rem", color: "#555" }}>No eligible variants yet.</p>
              ) : (
                <table style={{ borderCollapse: "collapse", width: "100%", fontSize: "0.875rem", marginBottom: "0.75rem" }}>
                  <thead>
                    <tr>
                      <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.35rem 0.75rem 0.35rem 0" }}>Variant</th>
                      {campaign.status !== "draft" ? (
                        <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.35rem 0.75rem" }}>
                          Frozen Bank Payment base
                        </th>
                      ) : null}
                      {canConfigureDraft(campaign.status) ? (
                        <th style={{ textAlign: "left", borderBottom: "1px solid #ddd", padding: "0.35rem 0.75rem" }}></th>
                      ) : null}
                    </tr>
                  </thead>
                  <tbody>
                    {campaign.variants.map((variant) => (
                      <tr key={variant.masterVariantId}>
                        <td style={{ padding: "0.35rem 0.75rem 0.35rem 0" }}>
                          {variant.productName} — {variant.metal} {variant.purity}
                          {variant.bandLabel ? ` (${variant.bandLabel})` : ""}
                        </td>
                        {campaign.status !== "draft" ? (
                          <td style={{ padding: "0.35rem 0.75rem" }}>
                            {variant.frozenBaseBankPaymentPrice
                              ? formatMoney(variant.frozenBaseBankPaymentPrice, campaign.currency)
                              : "—"}
                          </td>
                        ) : null}
                        {canConfigureDraft(campaign.status) ? (
                          <td style={{ padding: "0.35rem 0.75rem" }}>
                            <Form method="post">
                              <input type="hidden" name="intent" value="remove_variant" />
                              <input type="hidden" name="masterVariantId" value={variant.masterVariantId} />
                              <button type="submit" disabled={busy}>
                                Remove
                              </button>
                            </Form>
                          </td>
                        ) : null}
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {canConfigureDraft(campaign.status) ? (
                <Form method="post" style={{ display: "flex", gap: "0.75rem", alignItems: "flex-end" }}>
                  <input type="hidden" name="intent" value="add_variant" />
                  <div>
                    <label htmlFor="masterVariantId" style={labelStyle}>
                      Add eligible variant
                    </label>
                    <select id="masterVariantId" name="masterVariantId" style={{ ...inputStyle, marginBottom: 0 }} required>
                      <option value="">Select a variant…</option>
                      {candidateVariants.map((option) => (
                        <option key={option.masterVariantId} value={option.masterVariantId}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button type="submit" disabled={busy}>
                    Add
                  </button>
                </Form>
              ) : null}
            </section>

            <section style={sectionStyle}>
              <h2 style={{ fontSize: "1rem", margin: "0 0 0.5rem" }}>Campaign-options upload</h2>
              <p style={{ margin: "0 0 0.75rem", fontSize: "0.8rem", color: "#555" }}>
                Describes WHAT MAY BE SOLD (option dimensions, allowed values, valid combinations, table/ordering-flow
                configuration) — never pricing policy. Rejected at upload time if invalid; see
                docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md §12.
              </p>
              {optionsUpload ? (
                <p style={{ margin: "0 0 0.75rem", fontSize: "0.875rem" }}>
                  Revision #{optionsUpload.sequence}, uploaded by <strong>{optionsUpload.uploadedBy}</strong> at{" "}
                  {formatTimestamp(optionsUpload.uploadedAt)} (content hash <code>{optionsUpload.contentHash}</code>).
                  {optionsUpload.pinnedAtOpen ? (
                    <>
                      {" "}
                      <strong>Pinned at campaign open</strong> — this is the exact configuration frozen when the
                      campaign opened, not a live re-read of the upload store.
                    </>
                  ) : null}
                </p>
              ) : (
                <p style={{ margin: "0 0 0.75rem", fontSize: "0.875rem", color: "#555" }}>
                  No campaign-options configuration has been uploaded yet.
                </p>
              )}

              {canConfigureDraft(campaign.status) ? (
                <Form method="post">
                  <input type="hidden" name="intent" value="upload_options" />
                  <label htmlFor="optionsJson" style={labelStyle}>
                    Campaign-options JSON
                  </label>
                  <textarea
                    id="optionsJson"
                    name="optionsJson"
                    rows={14}
                    defaultValue={optionsUpload?.rawJson ?? ""}
                    style={{ ...inputStyle, maxWidth: "100%", fontFamily: "monospace", fontSize: "0.8rem" }}
                  />
                  <button type="submit" disabled={busy}>
                    Validate &amp; upload
                  </button>
                </Form>
              ) : (
                <p style={{ margin: 0, fontSize: "0.8rem", color: "#555" }}>
                  The options upload can only be changed while the campaign is draft.
                </p>
              )}
            </section>

            {canOpen(campaign.status) ? (
              <section style={{ ...sectionStyle, border: "2px solid #b00" }}>
                <h2 style={{ fontSize: "1rem", margin: "0 0 0.25rem", color: "#b00" }}>Open campaign — freezes pricing</h2>
                <p style={{ margin: "0 0 0.75rem", fontSize: "0.85rem" }}>
                  Opening freezes this campaign&rsquo;s cost inputs, tier prices, and every eligible variant&rsquo;s
                  Bank Payment base price PERMANENTLY. This cannot be undone and market changes afterward cannot
                  alter the frozen prices. This is a deliberate, one-way action — it is never a side effect of saving
                  tiers, variants, or the options upload.
                </p>

                {actionData?.openBlocked?.kind === "ladder" ? (
                  <div style={{ margin: "0 0 1rem" }}>
                    <p style={{ fontWeight: 600, color: "#b00" }}>
                      Price ladder problem — NOT overridable. No option below can clear this; adjust the tier
                      multipliers so every tier&rsquo;s price only falls.
                    </p>
                    <ul style={{ fontSize: "0.8rem" }}>
                      {actionData.openBlocked.problems.map((p, i) => (
                        <li key={i}>
                          {variantLabelById.get(p.masterVariantId) ?? p.masterVariantId}: tier {p.priorTierNumber} &rarr;{" "}
                          {p.tierNumber} — {p.detail}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                {actionData?.openBlocked?.kind === "unsafe" ? (
                  <div style={{ margin: "0 0 1rem" }}>
                    <p style={{ fontWeight: 600, color: "#b06a00" }}>
                      Tier-safety exception — overridable by an authorized owner, with a recorded reason.
                    </p>
                    <ul style={{ fontSize: "0.8rem" }}>
                      {actionData.openBlocked.entries.map((entry, i) => (
                        <li key={i}>
                          {variantLabelById.get(entry.masterVariantId) ?? entry.masterVariantId}: tier {entry.tierNumber}{" "}
                          fails {entry.failing.map((f) => FLOOR_LABELS[f] ?? f).join(", ")}
                        </li>
                      ))}
                    </ul>
                  </div>
                ) : null}

                <Form method="post">
                  <input type="hidden" name="intent" value="open_campaign" />
                  {actionData?.openBlocked?.kind === "unsafe" ? (
                    <fieldset style={{ border: "1px solid #b06a00", borderRadius: "4px", padding: "0.75rem 1rem", marginBottom: "0.75rem" }}>
                      <legend style={{ fontSize: "0.875rem", fontWeight: 600 }}>Override the tier-safety exception above</legend>
                      <label style={{ display: "block", fontSize: "0.875rem", marginBottom: "0.5rem" }}>
                        <input type="checkbox" name="overrideConfirmed" required /> I am authorized to open this
                        campaign despite the pricing-floor exception(s) listed above.
                      </label>
                      <label htmlFor="overrideReason" style={labelStyle}>
                        Override reason (required)
                      </label>
                      <textarea id="overrideReason" name="overrideReason" rows={2} required style={{ ...inputStyle, maxWidth: "100%" }} />
                    </fieldset>
                  ) : null}
                  <button type="submit" disabled={busy}>
                    Open campaign and freeze pricing
                  </button>
                </Form>
              </section>
            ) : null}
          </>
        )}
      </main>
    </AppProvider>
  );
}

export const headers: HeadersFunction = (args) => boundary.headers(args);

export function ErrorBoundary() {
  return boundary.error(useRouteError());
}
