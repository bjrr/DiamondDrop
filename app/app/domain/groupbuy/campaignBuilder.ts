/**
 * Group Buy campaign BUILDER — the merchant-side working state that a
 * visual campaign editor edits, and the generator that turns it into the
 * locked `schemaVersion: 1` campaign-options contract.
 *
 * PURE. No database, no I/O, no clock. Same discipline as
 * `campaignOptions.ts`, for the same reason: everything here is exercised
 * directly by tests rather than through a route.
 *
 * ===========================================================================
 * WHY A SECOND MODEL EXISTS AT ALL
 * ===========================================================================
 * `campaignOptions.ts` is a CLOSED, LOCKED contract describing what may be
 * sold: dimensions, labels, allowed values, valid combinations, table view,
 * ordering flow. It deliberately holds nothing else — §12 of
 * `docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md` forbids pricing policy
 * inside it, and `findForbiddenPricingKeys` enforces that with a backstop
 * pattern of `/pric(?:e|ing)/i` over EVERY key at EVERY depth.
 *
 * That backstop is the architectural fact that shapes this file. A merchant
 * building a campaign visually needs to record three things the contract has
 * no room for and must never gain:
 *
 *   1. WHICH OPTIONS AFFECT PRICE (§4). A ring's metal changes which variant
 *      is sold; a gift-wrap preference does not.
 *   2. WHICH MASTER VARIANT EACH PRICED CONFIGURATION MAPS TO (§6).
 *   3. CAMPAIGN CONTENT (§2, §14) — hero and gallery imagery, a headline,
 *      highlights, and presentational display details like "Production time:
 *      4 to 6 weeks".
 *
 * Every one of those would either trip the forbidden-key backstop or expand
 * a locked contract. So the builder state is a SEPARATE artifact, persisted
 * under its own snapshot kind, and the options JSON remains exactly what it
 * was. §15's "do not weaken `findForbiddenPricingKeys`" is honoured by
 * never asking it to tolerate any of this, rather than by carving out an
 * exception.
 *
 * ===========================================================================
 * THE GENERATOR IS VALIDATED BY THE REAL VALIDATOR, NOT A COPY
 * ===========================================================================
 * `buildCampaignOptionsJson` does not return its own construction. It builds
 * a candidate object and hands it to `validateGroupBuyCampaignOptions` — the
 * one in `campaignOptions.ts`, the same function the raw-JSON upload path
 * calls — and returns that result. There is no second validator here (§13),
 * and a generator bug surfaces as a rejected generation rather than as an
 * invalid campaign.
 *
 * ===========================================================================
 * TWO DIFFERENT SPACES, AND WHY THE DISTINCTION IS LOAD-BEARING
 * ===========================================================================
 * `isGroupBuyOptionSelectionValid` matches a customer's selection against
 * `validCombinations` by EXACT key set — same keys, same values, no more and
 * no fewer. So `validCombinations` must enumerate the FULL customer
 * selection space, including an exact ring size the customer picks.
 *
 * Pricing does not work at that granularity. A ring is manufactured in size
 * BANDS (`RingSizeBand`, already a first-class model with `sizeMin`/
 * `sizeMax`), and one `MasterVariant` covers a whole band. So sizes 6.5, 7,
 * 7.5 and 8 are four customer choices but ONE priced variant.
 *
 * Hence two spaces:
 *
 *   CONFIGURATION SPACE  every combination of every option, exact sizes and
 *                        all. This is what becomes `validCombinations`.
 *   VARIANT GROUP SPACE  the projection of a configuration onto only its
 *                        price-affecting options, with band options replaced
 *                        by their band. This is what gets mapped to a
 *                        `MasterVariant`, and what the price preview prices.
 *
 * For the §19 engagement-ring case — 3 shapes x 3 carat weights x 3 metals x
 * 15 ring sizes across 3 bands — that is 405 configurations over 27 variant
 * groups. The merchant maps 27 variants, not 405.
 */

import {
  validateGroupBuyCampaignOptions,
  type GroupBuyCampaignOptions,
  type GroupBuyCampaignOptionsValidationResult,
  type GroupBuyOptionAllowedValue,
  type GroupBuyOptionDimension,
} from "./campaignOptions";

// ---------------------------------------------------------------------------
// Option roles (§4)
// ---------------------------------------------------------------------------

/**
 * How an option participates in deciding WHICH VARIANT IS SOLD, which is the
 * same question as whether it affects price.
 *
 * The stored role names say "variant defining" rather than "price
 * affecting". That is not euphemism — it is the more accurate description
 * (these options select a variant; price follows from the variant) and it
 * keeps the word "price" out of a persisted admin artifact that sits one
 * copy-paste away from the options contract, whose forbidden-key backstop
 * would reject it. The MERCHANT-FACING wording is plain: see
 * `OPTION_ROLE_LABELS` below, which is what §18 asks for.
 */
export type BuilderOptionRole =
  /** Selects a variant directly. Metal, carat weight, stone shape. */
  | "variant_defining"
  /** Selects a variant through a size band (§5). Exact ring size. */
  | "variant_defining_band"
  /** Recorded with the order but does not change which variant is sold. */
  | "customer_preference";

export const BUILDER_OPTION_ROLES: readonly BuilderOptionRole[] = [
  "variant_defining",
  "variant_defining_band",
  "customer_preference",
];

/** Merchant-facing wording (§18). No internal vocabulary. */
export const OPTION_ROLE_LABELS: Readonly<Record<BuilderOptionRole, string>> = {
  variant_defining: "Affects price",
  variant_defining_band: "Affects price, by size band",
  customer_preference: "Does not affect price",
};

export const OPTION_ROLE_HELP: Readonly<Record<BuilderOptionRole, string>> = {
  variant_defining:
    "Each choice is a different product variant with its own price. Metal, stone shape and carat weight normally work this way.",
  variant_defining_band:
    "Customers pick an exact size, but the price comes from the size band that size falls into. Assign every size to a band below.",
  customer_preference:
    "Recorded with the order so you can fulfil it, but every choice costs the same. Engraving style and gift wrap normally work this way.",
};

export function isVariantDefiningRole(role: BuilderOptionRole): boolean {
  return role === "variant_defining" || role === "variant_defining_band";
}

// ---------------------------------------------------------------------------
// The builder state
// ---------------------------------------------------------------------------

export interface BuilderOptionValue {
  /** The stored value, e.g. `round` or `7.5`. */
  readonly value: string;
  /** What the customer reads, e.g. `Round brilliant`. */
  readonly label: string;
  /**
   * Which band this value prices from. Required for, and only meaningful
   * on, a `variant_defining_band` option (§5). Left unset it falls back to
   * the raw value, which deliberately produces an unmappable variant group
   * rather than a silently wrong one — `assessCampaignBuilderCompleteness`
   * refuses to let the campaign open until every size has a band.
   */
  readonly bandValue?: string;
}

export interface BuilderOption {
  /** Internal key written into the contract. Slug-shaped; see `normaliseOptionKey`. */
  readonly key: string;
  readonly label: string;
  readonly required: boolean;
  readonly displayOrder: number;
  readonly role: BuilderOptionRole;
  readonly allowedValues: readonly BuilderOptionValue[];
}

/**
 * A presentational fact about the campaign (§14) — "Production time: 4 to 6
 * weeks", "Certification: GIA". NOT selectable, so it is deliberately not an
 * option and never reaches `validCombinations`. A merchant who adds one of
 * these by mistake as a Customer Option would create purchasable
 * combinations that differ only by a label.
 */
export interface BuilderDisplayDetail {
  readonly label: string;
  readonly value: string;
}

/**
 * An image the merchant picked, held by reference (§2). The bytes live in
 * Shopify Files; this records which file and how to render it. `fileGid` is
 * admin-only and must never reach the storefront — `url` and `altText` are
 * the customer-facing half.
 */
export interface BuilderImageRef {
  readonly fileGid: string;
  readonly url: string;
  readonly altText: string;
}

/**
 * PRESENTATION — the fields that may still be corrected after a campaign
 * opens (owner decision, 2026-11-06).
 *
 * ===========================================================================
 * THE LINE IS "IS THIS A PROMISE, OR IS IT A PICTURE?"
 * ===========================================================================
 * A campaign that has opened has customers in it. Anything they relied on
 * when they joined is a commerce promise and is frozen: the options, the
 * bands, the combinations, the variant mappings, the tiers, and every
 * factual claim about what they are buying.
 *
 * A hero photograph, a card thumbnail, a headline and a one-line promotional
 * description are not promises about the goods. They are how the campaign
 * presents itself, and a typo or a placeholder photo in them is a thing
 * worth being able to fix without cancelling a live campaign.
 *
 * ===========================================================================
 * WHAT IS DELIBERATELY *NOT* IN HERE, AND WHY
 * ===========================================================================
 * `highlights` and `displayDetails` stay FROZEN, in `BuilderFrozenContent`
 * below, even though both are "content" in a loose sense.
 *
 * `displayDetails` is where "Certification: GIA", "Clarity: VS1" and
 * "Production time: 4 to 6 weeks" live. Those are certification, quality,
 * material and specification claims — named explicitly in the owner's frozen
 * list. A highlight is a promotional bullet, but nothing stops a merchant
 * writing "Natural diamond, VS1 clarity" in one, which is the same kind of
 * claim wearing different clothes.
 *
 * The owner's editable list names exactly six fields. Treating a seventh as
 * editable because it felt like presentation would be deciding, on the
 * owner's behalf, that a quality claim may change under a customer who
 * already bought against it. The conservative reading is the correct one
 * here, and widening it later is a one-line change; narrowing it after a
 * campaign has shipped is not.
 */
export interface BuilderCampaignPresentation {
  readonly headline: string;
  readonly shortDescription: string;
  readonly heroImage: BuilderImageRef | null;
  readonly mobileHeroImage: BuilderImageRef | null;
  readonly cardImage: BuilderImageRef | null;
  readonly galleryImages: readonly BuilderImageRef[];
}

/** The content that is a commerce promise, and therefore freezes at open. */
export interface BuilderFrozenContent {
  readonly highlights: readonly string[];
  readonly displayDetails: readonly BuilderDisplayDetail[];
}

/**
 * §2 / §14 — campaign content, which the locked options contract has no
 * field for. Structurally the union of the two halves above, kept as one flat
 * shape so the draft editor stays one coherent form (§20) and so existing
 * stored snapshots keep deserialising unchanged.
 */
export interface BuilderCampaignContent extends BuilderCampaignPresentation, BuilderFrozenContent {}

/** Field names in the presentation half. The one list everything else derives from. */
export const PRESENTATION_FIELDS = [
  "headline",
  "shortDescription",
  "heroImage",
  "mobileHeroImage",
  "cardImage",
  "galleryImages",
] as const satisfies readonly (keyof BuilderCampaignPresentation)[];

/** Field names that freeze at open. */
export const FROZEN_CONTENT_FIELDS = ["highlights", "displayDetails"] as const satisfies readonly (keyof BuilderFrozenContent)[];

/** The presentation half of a campaign's content, for versioning after open. */
export function extractPresentation(content: BuilderCampaignContent): BuilderCampaignPresentation {
  return {
    headline: content.headline,
    shortDescription: content.shortDescription,
    heroImage: content.heroImage,
    mobileHeroImage: content.mobileHeroImage,
    cardImage: content.cardImage,
    galleryImages: content.galleryImages,
  };
}

/**
 * Lays a newer presentation version over the frozen builder state, which is
 * how every reader (this editor now, the storefront later) sees a live
 * campaign: FROZEN COMMERCE CONFIGURATION PLUS LATEST PRESENTATION.
 *
 * The frozen state is never mutated — a new object is returned — because the
 * stored snapshot is evidence of what the campaign opened with.
 */
export function withPresentation(
  state: CampaignBuilderState,
  presentation: BuilderCampaignPresentation | null
): CampaignBuilderState {
  if (presentation === null) return state;
  return {
    ...state,
    content: {
      ...state.content,
      headline: presentation.headline,
      shortDescription: presentation.shortDescription,
      heroImage: presentation.heroImage,
      mobileHeroImage: presentation.mobileHeroImage,
      cardImage: presentation.cardImage,
      galleryImages: presentation.galleryImages,
    },
  };
}

/** §2 caps the gallery; more than this is a merchant mistake, not a layout. */
export const MAX_GALLERY_IMAGES = 6;

export interface CampaignBuilderState {
  /** Free text, matching the contract's `campaign.productType`. */
  readonly productType: string;
  readonly title: string;
  readonly description: string;
  readonly options: readonly BuilderOption[];
  readonly content: BuilderCampaignContent;
  /**
   * Configuration signatures the merchant switched OFF (§7). Stored as the
   * exclusion set rather than the inclusion set so that adding a new allowed
   * value turns on its combinations by default instead of silently shipping
   * a campaign that cannot sell them.
   */
  readonly disabledConfigurations: readonly string[];
  /** Variant-group signature -> `MasterVariant.id` (§6). */
  readonly variantMappings: Readonly<Record<string, string>>;
}

export function emptyCampaignContent(): BuilderCampaignContent {
  return {
    headline: "",
    shortDescription: "",
    highlights: [],
    heroImage: null,
    mobileHeroImage: null,
    cardImage: null,
    galleryImages: [],
    displayDetails: [],
  };
}

export function emptyCampaignBuilderState(): CampaignBuilderState {
  return {
    productType: "",
    title: "",
    description: "",
    options: [],
    content: emptyCampaignContent(),
    disabledConfigurations: [],
    variantMappings: {},
  };
}

// ---------------------------------------------------------------------------
// Keys and signatures
// ---------------------------------------------------------------------------

export const OPTION_KEY_PATTERN = /^[a-z][a-z0-9_]*$/;

/**
 * Turns a merchant's label into a usable internal key, so §3's "internal
 * key" field can be prefilled instead of demanded. "Carat Weight" becomes
 * `carat_weight`.
 */
export function normaliseOptionKey(raw: string): string {
  const lowered = raw.trim().toLowerCase();
  const slug = lowered.replace(/[^a-z0-9]+/g, "_").replace(/^_+/, "").replace(/_+$/, "");
  // A key must start with a letter; a label like "4 C's" would otherwise
  // produce `4_c_s`, which the contract accepts but which reads as broken.
  return OPTION_KEY_PATTERN.test(slug) ? slug : slug === "" ? "" : `option_${slug}`;
}

/**
 * A stable, collision-proof identity for a set of option values.
 *
 * JSON of sorted entries, NOT a joined string. A naive `key=value` join on a
 * delimiter is forgeable: two different configurations can produce one
 * signature as soon as a merchant-entered value contains the delimiter.
 * These signatures decide which variant a configuration prices from, so a
 * collision would sell the wrong variant. JSON quoting and escaping make
 * that impossible, and sorting makes the result independent of insertion
 * order.
 */
export function configurationSignature(values: Readonly<Record<string, string>>): string {
  const entries = Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify(entries);
}

/** Reverses `configurationSignature`. Returns null on anything it did not produce. */
export function parseConfigurationSignature(signature: string): Readonly<Record<string, string>> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(signature);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const values: Record<string, string> = {};
  for (const entry of parsed) {
    if (!Array.isArray(entry) || entry.length !== 2) return null;
    const [key, value] = entry;
    if (typeof key !== "string" || typeof value !== "string") return null;
    values[key] = value;
  }
  return values;
}

// ---------------------------------------------------------------------------
// Enumeration (§7)
// ---------------------------------------------------------------------------

/**
 * A ceiling on the configuration space, so a mistyped option cannot hang the
 * admin page. The §19 engagement-ring case is 405; a legitimate campaign
 * being refused here means the campaign has more purchasable combinations
 * than a merchant could meaningfully review, which is itself worth stopping
 * on.
 */
export const MAX_CONFIGURATIONS = 2000;

export class ConfigurationSpaceTooLargeError extends Error {
  constructor(
    readonly count: number,
    readonly limit: number = MAX_CONFIGURATIONS
  ) {
    super(
      `This combination of options would create ${count} available configurations, over the limit of ${limit}. Reduce the number of choices on one of the options.`
    );
    this.name = "ConfigurationSpaceTooLargeError";
  }
}

export interface EnumeratedConfiguration {
  /** Every option key -> the customer's exact choice. Becomes one `validCombinations` entry. */
  readonly values: Readonly<Record<string, string>>;
  readonly signature: string;
  /** The price-affecting projection, with band options resolved to their band. */
  readonly variantGroupValues: Readonly<Record<string, string>>;
  readonly variantGroupSignature: string;
  /** False when the merchant switched this configuration off (§7). */
  readonly enabled: boolean;
}

function sortedOptions(options: readonly BuilderOption[]): readonly BuilderOption[] {
  return [...options].sort((a, b) =>
    a.displayOrder !== b.displayOrder ? a.displayOrder - b.displayOrder : a.key < b.key ? -1 : 1
  );
}

/** How many configurations the option set would produce, without building them. */
export function configurationCount(options: readonly BuilderOption[]): number {
  const usable = options.filter((option) => option.allowedValues.length > 0);
  if (usable.length === 0) return 0;
  return usable.reduce((total, option) => total * option.allowedValues.length, 1);
}

/**
 * The band an option value prices from. Falls back to the raw value when the
 * merchant has not assigned a band yet, which produces a variant group that
 * cannot be mapped to anything sensible — deliberately. The alternative,
 * quietly folding an unassigned size into some other band, is the silent
 * mis-mapping §6 forbids.
 */
function priceBearingValue(option: BuilderOption, value: BuilderOptionValue): string {
  if (option.role !== "variant_defining_band") return value.value;
  return value.bandValue !== undefined && value.bandValue.trim() !== "" ? value.bandValue : value.value;
}

/**
 * The full configuration space, in a stable order.
 *
 * @throws ConfigurationSpaceTooLargeError when the space exceeds
 *         `MAX_CONFIGURATIONS`. Checked by multiplication BEFORE any
 *         building, so an absurd option set is refused rather than
 *         materialised.
 */
export function enumerateConfigurations(state: CampaignBuilderState): readonly EnumeratedConfiguration[] {
  const options = sortedOptions(state.options).filter((option) => option.allowedValues.length > 0);
  if (options.length === 0) return [];

  const count = configurationCount(options);
  if (count > MAX_CONFIGURATIONS) throw new ConfigurationSpaceTooLargeError(count);

  const disabled = new Set(state.disabledConfigurations);
  const rows: EnumeratedConfiguration[] = [];

  // Iterative odometer rather than recursion: the depth is the number of
  // options, which is merchant-controlled.
  const cursor = options.map(() => 0);
  for (;;) {
    const values: Record<string, string> = {};
    const variantGroupValues: Record<string, string> = {};
    options.forEach((option, index) => {
      // Both indexes are in range by construction: `cursor` has one entry
      // per option, and the odometer below resets each position before it
      // reaches that option's length.
      const chosen = option.allowedValues[cursor[index]!]!;
      values[option.key] = chosen.value;
      if (isVariantDefiningRole(option.role)) {
        variantGroupValues[option.key] = priceBearingValue(option, chosen);
      }
    });

    const signature = configurationSignature(values);
    rows.push({
      values,
      signature,
      variantGroupValues,
      variantGroupSignature: configurationSignature(variantGroupValues),
      enabled: !disabled.has(signature),
    });

    // Advance the odometer.
    let position = options.length - 1;
    for (;;) {
      cursor[position] = cursor[position]! + 1;
      if (cursor[position]! < options[position]!.allowedValues.length) break;
      cursor[position] = 0;
      position -= 1;
      if (position < 0) return rows;
    }
  }
}

export interface VariantGroup {
  readonly signature: string;
  /** Price-affecting option key -> value (bands resolved). */
  readonly values: Readonly<Record<string, string>>;
  /** Every enabled configuration that prices from this group. */
  readonly configurationSignatures: readonly string[];
  /** `MasterVariant.id`, or null when the merchant has not mapped it yet. */
  readonly masterVariantId: string | null;
}

/**
 * The distinct priced groups across all ENABLED configurations, in first-seen
 * order. A group with no enabled configuration is not a group: it cannot be
 * bought, so requiring a variant for it would block an open for no reason.
 */
export function variantGroupsOf(state: CampaignBuilderState): readonly VariantGroup[] {
  const groups = new Map<string, { values: Readonly<Record<string, string>>; configurations: string[] }>();

  for (const configuration of enumerateConfigurations(state)) {
    if (!configuration.enabled) continue;
    const existing = groups.get(configuration.variantGroupSignature);
    if (existing) {
      existing.configurations.push(configuration.signature);
    } else {
      groups.set(configuration.variantGroupSignature, {
        values: configuration.variantGroupValues,
        configurations: [configuration.signature],
      });
    }
  }

  return [...groups.entries()].map(([signature, group]) => ({
    signature,
    values: group.values,
    configurationSignatures: group.configurations,
    masterVariantId: state.variantMappings[signature] ?? null,
  }));
}

/** A human label for a group, for the mapping and preview tables (§18). */
export function describeVariantGroup(state: CampaignBuilderState, group: VariantGroup): string {
  const byKey = new Map(state.options.map((option) => [option.key, option]));
  return sortedOptions(state.options)
    .filter((option) => isVariantDefiningRole(option.role) && group.values[option.key] !== undefined)
    .map((option) => {
      const raw = group.values[option.key];
      const source = byKey.get(option.key);
      // For a band option the group holds the BAND, so the per-value labels
      // do not match; show the band as supplied.
      const matched = source?.allowedValues.find((value) => priceBearingValue(option, value) === raw);
      const label = option.role === "variant_defining_band" ? raw : (matched?.label ?? raw);
      return `${option.label}: ${label}`;
    })
    .join(" / ");
}

// ---------------------------------------------------------------------------
// Generating the locked contract (§13, §16)
// ---------------------------------------------------------------------------

function toContractDimension(option: BuilderOption): GroupBuyOptionDimension {
  const allowedValues: GroupBuyOptionAllowedValue[] = option.allowedValues.map((value) => ({
    value: value.value,
    label: value.label,
  }));
  // `bandValue` is deliberately dropped. It is pricing structure, which §12
  // keeps out of this contract; it stays in the builder state, which is the
  // only place that needs it.
  return {
    key: option.key,
    label: option.label,
    required: option.required,
    displayOrder: option.displayOrder,
    allowedValues,
  };
}

/**
 * Builds the `schemaVersion: 1` contract from builder state and returns the
 * REAL validator's verdict on it (§13 — there is no second validator).
 *
 * `tableView.columns` carries only the price-affecting options: the public
 * comparison table exists to show what changes the price, and a column for a
 * preference option would produce rows that differ only by a label while
 * showing the same figure.
 *
 * `orderingFlow.steps` carries every option, in display order, because the
 * customer does have to choose the preference options too.
 */
export function buildCampaignOptionsJson(
  state: CampaignBuilderState
): GroupBuyCampaignOptionsValidationResult {
  let configurations: readonly EnumeratedConfiguration[];
  try {
    configurations = enumerateConfigurations(state);
  } catch (error) {
    if (error instanceof ConfigurationSpaceTooLargeError) {
      return { ok: false, problems: [error.message] };
    }
    throw error;
  }

  const options = sortedOptions(state.options);
  const enabled = configurations.filter((configuration) => configuration.enabled);

  const candidate: Record<string, unknown> = {
    schemaVersion: 1,
    campaign: {
      productType: state.productType,
      ...(state.title.trim() !== "" ? { title: state.title } : {}),
      ...(state.description.trim() !== "" ? { description: state.description } : {}),
    },
    optionDimensions: options.map(toContractDimension),
    validCombinations: enabled.map((configuration) => ({ values: configuration.values })),
    tableView: {
      columns: options.filter((option) => isVariantDefiningRole(option.role)).map((option) => option.key),
    },
    orderingFlow: { steps: options.map((option) => option.key) },
  };

  return validateGroupBuyCampaignOptions(candidate);
}

/**
 * Reads an existing contract back into builder state (§13's two-way sync,
 * §16's "existing JSON stays readable").
 *
 * ROLES CANNOT BE RECOVERED FROM THE CONTRACT, because the contract never
 * held them. Every imported option therefore comes back as `variant_defining`
 * — the choice that FAILS LOUD. A preference option mistakenly treated as
 * price-affecting multiplies the variant groups the merchant is asked to map,
 * which is immediately visible in the mapping table and blocks the open until
 * resolved. The opposite default would quietly collapse real priced variants
 * into one group and sell the wrong thing.
 *
 * `overlay` carries whatever the builder already knew about this campaign
 * (roles, band assignments, mappings, content) so that re-reading the
 * contract after an external edit does not discard it. Only options still
 * present in the contract keep their overlaid role.
 */
export function builderStateFromCampaignOptions(
  options: GroupBuyCampaignOptions,
  overlay?: Partial<CampaignBuilderState>
): CampaignBuilderState {
  const overlaidByKey = new Map((overlay?.options ?? []).map((option) => [option.key, option]));

  const rebuilt: BuilderOption[] = options.optionDimensions.map((dimension) => {
    const previous = overlaidByKey.get(dimension.key);
    const previousValues = new Map((previous?.allowedValues ?? []).map((value) => [value.value, value]));
    return {
      key: dimension.key,
      label: dimension.label,
      required: dimension.required,
      displayOrder: dimension.displayOrder,
      role: previous?.role ?? "variant_defining",
      allowedValues: dimension.allowedValues.map((value) => {
        const previousValue = previousValues.get(value.value);
        return {
          value: value.value,
          label: value.label,
          ...(previousValue?.bandValue !== undefined ? { bandValue: previousValue.bandValue } : {}),
        };
      }),
    };
  });

  // Anything the contract does NOT list as a valid combination is, by
  // definition, switched off. Rebuilding the exclusion set this way keeps
  // `disabledConfigurations` consistent with the contract that was uploaded,
  // rather than trusting a stale overlay.
  const contractEnabled = new Set(
    options.validCombinations.map((combination) => configurationSignature(combination.values))
  );
  const scratch: CampaignBuilderState = {
    ...emptyCampaignBuilderState(),
    ...overlay,
    productType: options.campaign.productType,
    title: options.campaign.title ?? "",
    description: options.campaign.description ?? "",
    options: rebuilt,
    disabledConfigurations: [],
  };

  let disabledConfigurations: readonly string[] = [];
  try {
    disabledConfigurations = enumerateConfigurations(scratch)
      .filter((configuration) => !contractEnabled.has(configuration.signature))
      .map((configuration) => configuration.signature);
  } catch (error) {
    // An oversized space cannot be enumerated, so the exclusion set cannot
    // be derived. Keeping it empty is right: it means "nothing switched off",
    // and `assessCampaignBuilderCompleteness` reports the size problem
    // instead of this surfacing as a mysterious combination mismatch.
    if (!(error instanceof ConfigurationSpaceTooLargeError)) throw error;
  }

  return { ...scratch, disabledConfigurations };
}

// ---------------------------------------------------------------------------
// Completeness (§11)
// ---------------------------------------------------------------------------

export type BuilderProblemSection =
  | "basics"
  | "content"
  | "options"
  | "configurations"
  | "variant_mapping"
  | "contract";

export interface BuilderCompletenessProblem {
  readonly section: BuilderProblemSection;
  /** Merchant-facing, specific, and actionable (§18). */
  readonly message: string;
  /** True when this must be fixed before the campaign can open. */
  readonly blocking: boolean;
}

/**
 * Everything standing between this builder state and a campaign that can
 * open. Collects every problem rather than stopping at the first, matching
 * `validateGroupBuyCampaignOptions` and `validateTierSet`.
 *
 * This function does NOT check tiers, eligible variants, or anything the
 * existing open path already validates. §8's open/freeze sequence is
 * untouched; this is a pre-flight so a merchant finds out in the editor
 * rather than from a rejected open.
 */
export function assessCampaignBuilderCompleteness(
  state: CampaignBuilderState
): readonly BuilderCompletenessProblem[] {
  const problems: BuilderCompletenessProblem[] = [];
  const add = (section: BuilderProblemSection, message: string, blocking = true) =>
    problems.push({ section, message, blocking });

  if (state.productType.trim() === "") {
    add("basics", "Product type is required, for example “Engagement ring”.");
  }

  // ---- Content. Non-blocking by design: a campaign with no hero image is
  // ---- unattractive, not unsellable, and blocking an open on a missing
  // ---- photo would be this editor inventing a policy nobody locked.
  if (state.content.headline.trim() === "") {
    add("content", "Add a headline so the campaign has something to lead with.", false);
  }
  if (state.content.heroImage === null) {
    add("content", "Add a hero image. Campaigns without one look unfinished to customers.", false);
  }
  if (state.content.cardImage === null) {
    add("content", "Add a card image, used wherever this campaign is listed alongside others.", false);
  }
  if (state.content.galleryImages.length > MAX_GALLERY_IMAGES) {
    add("content", `Remove ${state.content.galleryImages.length - MAX_GALLERY_IMAGES} gallery image(s): the limit is ${MAX_GALLERY_IMAGES}.`);
  }
  state.content.displayDetails.forEach((detail, index) => {
    if (detail.label.trim() === "" || detail.value.trim() === "") {
      add("content", `Display detail ${index + 1} needs both a label and a value, or should be removed.`);
    }
  });

  // ---- Options
  if (state.options.length === 0) {
    add("options", "Add at least one customer option. A campaign with nothing to choose has nothing to sell.");
  }

  const seenKeys = new Set<string>();
  for (const option of state.options) {
    const name = option.label.trim() === "" ? option.key : option.label;
    if (!OPTION_KEY_PATTERN.test(option.key)) {
      add("options", `“${name}” needs an internal key of lower-case letters, numbers and underscores, starting with a letter.`);
    } else if (seenKeys.has(option.key)) {
      add("options", `Two options share the internal key “${option.key}”. Keys must be unique.`);
    } else {
      seenKeys.add(option.key);
    }
    if (option.label.trim() === "") {
      add("options", `The option “${option.key}” needs a label customers will read.`);
    }
    if (option.allowedValues.length === 0) {
      add("options", `“${name}” has no choices yet. Add at least one.`);
    }

    const seenValues = new Set<string>();
    for (const value of option.allowedValues) {
      if (value.value.trim() === "") {
        add("options", `“${name}” has a choice with no value.`);
      } else if (seenValues.has(value.value)) {
        add("options", `“${name}” repeats the choice “${value.value}”.`);
      } else {
        seenValues.add(value.value);
      }
      if (value.label.trim() === "") {
        add("options", `The choice “${value.value}” on “${name}” needs a label.`);
      }
      if (option.role === "variant_defining_band" && (value.bandValue === undefined || value.bandValue.trim() === "")) {
        add("options", `Assign “${value.label || value.value}” on “${name}” to a size band, so it knows which variant to price from.`);
      }
    }
  }

  if (state.options.length > 0 && !state.options.some((option) => isVariantDefiningRole(option.role))) {
    add(
      "options",
      "At least one option has to affect price, otherwise there is no variant for the campaign to sell."
    );
  }

  // ---- Configurations and mapping
  let configurations: readonly EnumeratedConfiguration[] | null = null;
  try {
    configurations = enumerateConfigurations(state);
  } catch (error) {
    if (error instanceof ConfigurationSpaceTooLargeError) {
      add("configurations", error.message);
    } else {
      throw error;
    }
  }

  if (configurations !== null && state.options.length > 0) {
    const enabledCount = configurations.filter((configuration) => configuration.enabled).length;
    if (enabledCount === 0) {
      add("configurations", "Every configuration is switched off. Switch at least one back on.");
    }

    const groups = variantGroupsOf(state);
    const unmapped = groups.filter((group) => group.masterVariantId === null);
    for (const group of unmapped) {
      add("variant_mapping", `Choose the product variant for ${describeVariantGroup(state, group) || "this configuration"}.`);
    }

    // A mapping left behind by an option that has since changed is not
    // harmless: it is a variant the merchant believes is in the campaign.
    // Report it rather than dropping it silently.
    const liveSignatures = new Set(groups.map((group) => group.signature));
    const stale = Object.keys(state.variantMappings).filter((signature) => !liveSignatures.has(signature));
    if (stale.length > 0) {
      add(
        "variant_mapping",
        `${stale.length} saved variant mapping(s) no longer match any available configuration, because the options changed. Review the mapping table and save it again.`,
        false
      );
    }
  }

  // ---- The contract itself, checked by the real validator.
  const generated = buildCampaignOptionsJson(state);
  if (!generated.ok) {
    for (const problem of generated.problems) {
      add("contract", problem);
    }
  }

  return problems;
}

export function isReadyToOpen(problems: readonly BuilderCompletenessProblem[]): boolean {
  return !problems.some((problem) => problem.blocking);
}

// ---------------------------------------------------------------------------
// Parsing an untrusted submission
//
// The visual editor keeps the builder state in the browser and posts the whole
// thing back as one JSON field. That makes the submission UNTRUSTED INPUT in
// the ordinary sense — a hand-crafted post can contain any shape, any size and
// any `masterVariantId` — so it is parsed and bounded here before anything
// reads it.
//
// WHAT THIS FUNCTION CANNOT CHECK, and the caller therefore must: that each
// `masterVariantId` is actually one of THIS campaign's eligible variants.
// That is a database fact, not a shape, and mapping a configuration to an
// arbitrary variant id would sell the wrong item. The route cross-checks it
// against the campaign's own variant list.
// ---------------------------------------------------------------------------

/** Bounds, so a hostile or mistaken payload cannot be unbounded work. */
export const MAX_OPTIONS = 12;
export const MAX_VALUES_PER_OPTION = 80;
export const MAX_HIGHLIGHTS = 10;
export const MAX_DISPLAY_DETAILS = 12;
/** Generous for a label or a description, far below a denial-of-service. */
export const MAX_TEXT_LENGTH = 2000;

export type CampaignBuilderStateParseResult =
  | { readonly ok: true; readonly value: CampaignBuilderState }
  | { readonly ok: false; readonly problems: readonly string[] };

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validates and narrows a posted builder state. Collects every problem, like
 * every other validator in this codebase.
 *
 * Text is NOT silently truncated. A merchant whose 3000-character description
 * came back quietly shortened would not know which half survived; the
 * submission is refused with the field named instead.
 */
/**
 * The field readers both parsers share, bound to one problem list.
 *
 * Extracted so that `parseCampaignBuilderState` and
 * `parseCampaignPresentation` cannot drift apart. The presentation parser
 * runs against a LIVE campaign, so if its image rules were a second
 * implementation that happened to be laxer, the freeze would be bypassable
 * through the one path that is still open after a campaign ships.
 */
function fieldReaders(problems: string[]) {
  const text = (value: unknown, path: string, { required = false } = {}): string => {
    if (value === undefined || value === null) {
      if (required) problems.push(`${path} is required.`);
      return "";
    }
    if (typeof value !== "string") {
      problems.push(`${path} must be text.`);
      return "";
    }
    if (value.length > MAX_TEXT_LENGTH) {
      problems.push(`${path} is longer than ${MAX_TEXT_LENGTH} characters. Shorten it.`);
      return "";
    }
    if (required && value.trim() === "") problems.push(`${path} is required.`);
    return value;
  };

  const parseImage = (value: unknown, path: string): BuilderImageRef | null => {
    if (value === undefined || value === null) return null;
    if (!isPlainRecord(value)) {
      problems.push(`${path} is not a valid image reference.`);
      return null;
    }
    const fileGid = text(value.fileGid, `${path} file`);
    const url = text(value.url, `${path} address`);
    if (url.trim() === "") {
      problems.push(`${path} is missing its Shopify Files address.`);
      return null;
    }
    // SHOPIFY-HOSTED ONLY (§2 — Shopify-native media). A campaign image is
    // rendered to customers, and an arbitrary remote address would have the
    // storefront loading imagery from a host nobody vetted.
    //
    // This is now the SECOND line of defence rather than the only one: the
    // normal path is Shopify's native file picker, whose selections are
    // re-resolved against the Admin API on save so the stored URL is
    // whatever Shopify says it is. This check still matters, because a
    // GID-less legacy reference has no Admin API answer to be replaced with.
    if (!/^https:\/\/cdn\.shopify\.com\//.test(url)) {
      problems.push(
        `${path} must be a Shopify Files image. Use “Choose image” to pick one from Shopify Files.`
      );
      return null;
    }
    if (fileGid.trim() !== "" && !/^gid:\/\/shopify\/MediaImage\//.test(fileGid)) {
      // Narrowed from `gid://shopify/` to MediaImage specifically: the picker
      // is invoked with `mediaTypes: ['MediaImage']`, so a Video or
      // GenericFile id arriving here did not come from where it claims to.
      problems.push(`${path} is not a Shopify image file.`);
      return null;
    }
    return { fileGid, url, altText: text(value.altText, `${path} alt text`) };
  };

  return { text, parseImage };
}

export function parseCampaignBuilderState(input: unknown): CampaignBuilderStateParseResult {
  const problems: string[] = [];

  if (!isPlainRecord(input)) {
    return { ok: false, problems: ["The saved configuration was not an object."] };
  }

  const { text, parseImage } = fieldReaders(problems);

  const productType = text(input.productType, "Product type");
  const title = text(input.title, "Title");
  const description = text(input.description, "Description");

  // ---- options
  const options: BuilderOption[] = [];
  if (!Array.isArray(input.options)) {
    problems.push("Customer options must be a list.");
  } else if (input.options.length > MAX_OPTIONS) {
    problems.push(`There are ${input.options.length} customer options; the limit is ${MAX_OPTIONS}.`);
  } else {
    input.options.forEach((raw, index) => {
      const where = `Option ${index + 1}`;
      if (!isPlainRecord(raw)) {
        problems.push(`${where} is not an object.`);
        return;
      }
      const role = raw.role;
      if (typeof role !== "string" || !(BUILDER_OPTION_ROLES as readonly string[]).includes(role)) {
        problems.push(`${where} has an unrecognised price setting.`);
        return;
      }
      if (typeof raw.displayOrder !== "number" || !Number.isFinite(raw.displayOrder)) {
        problems.push(`${where} has an invalid display order.`);
        return;
      }
      if (typeof raw.required !== "boolean") {
        problems.push(`${where} must say whether it is required.`);
        return;
      }
      if (!Array.isArray(raw.allowedValues)) {
        problems.push(`${where} must have a list of choices.`);
        return;
      }
      if (raw.allowedValues.length > MAX_VALUES_PER_OPTION) {
        problems.push(`${where} has ${raw.allowedValues.length} choices; the limit is ${MAX_VALUES_PER_OPTION}.`);
        return;
      }

      const allowedValues: BuilderOptionValue[] = [];
      raw.allowedValues.forEach((rawValue, valueIndex) => {
        const valueWhere = `${where}, choice ${valueIndex + 1}`;
        if (!isPlainRecord(rawValue)) {
          problems.push(`${valueWhere} is not an object.`);
          return;
        }
        const band = rawValue.bandValue;
        if (band !== undefined && typeof band !== "string") {
          problems.push(`${valueWhere} has an invalid size band.`);
          return;
        }
        allowedValues.push({
          value: text(rawValue.value, `${valueWhere} value`),
          label: text(rawValue.label, `${valueWhere} label`),
          ...(typeof band === "string" ? { bandValue: text(band, `${valueWhere} size band`) } : {}),
        });
      });

      options.push({
        key: text(raw.key, `${where} internal key`),
        label: text(raw.label, `${where} label`),
        required: raw.required,
        displayOrder: raw.displayOrder,
        role: role as BuilderOptionRole,
        allowedValues,
      });
    });
  }

  // ---- content
  const rawContent = isPlainRecord(input.content) ? input.content : {};
  if (input.content !== undefined && !isPlainRecord(input.content)) {
    problems.push("Content and images must be an object.");
  }

  let highlights: string[] = [];
  if (rawContent.highlights !== undefined) {
    if (!Array.isArray(rawContent.highlights)) {
      problems.push("Highlights must be a list.");
    } else if (rawContent.highlights.length > MAX_HIGHLIGHTS) {
      problems.push(`There are ${rawContent.highlights.length} highlights; the limit is ${MAX_HIGHLIGHTS}.`);
    } else {
      highlights = rawContent.highlights.map((value, index) => text(value, `Highlight ${index + 1}`));
    }
  }

  let galleryImages: BuilderImageRef[] = [];
  if (rawContent.galleryImages !== undefined) {
    if (!Array.isArray(rawContent.galleryImages)) {
      problems.push("The gallery must be a list.");
    } else if (rawContent.galleryImages.length > MAX_GALLERY_IMAGES) {
      problems.push(
        `There are ${rawContent.galleryImages.length} gallery images; the limit is ${MAX_GALLERY_IMAGES}.`
      );
    } else {
      galleryImages = rawContent.galleryImages
        .map((value, index) => parseImage(value, `Gallery image ${index + 1}`))
        .filter((image): image is BuilderImageRef => image !== null);
    }
  }

  let displayDetails: BuilderDisplayDetail[] = [];
  if (rawContent.displayDetails !== undefined) {
    if (!Array.isArray(rawContent.displayDetails)) {
      problems.push("Display details must be a list.");
    } else if (rawContent.displayDetails.length > MAX_DISPLAY_DETAILS) {
      problems.push(
        `There are ${rawContent.displayDetails.length} display details; the limit is ${MAX_DISPLAY_DETAILS}.`
      );
    } else {
      displayDetails = rawContent.displayDetails.map((raw, index) => {
        const where = `Display detail ${index + 1}`;
        if (!isPlainRecord(raw)) {
          problems.push(`${where} is not an object.`);
          return { label: "", value: "" };
        }
        return { label: text(raw.label, `${where} label`), value: text(raw.value, `${where} value`) };
      });
    }
  }

  const content: BuilderCampaignContent = {
    headline: text(rawContent.headline, "Headline"),
    shortDescription: text(rawContent.shortDescription, "Short description"),
    highlights,
    heroImage: parseImage(rawContent.heroImage, "Hero image"),
    mobileHeroImage: parseImage(rawContent.mobileHeroImage, "Mobile hero image"),
    cardImage: parseImage(rawContent.cardImage, "Card image"),
    galleryImages,
    displayDetails,
  };

  // ---- disabled configurations
  let disabledConfigurations: string[] = [];
  if (input.disabledConfigurations !== undefined) {
    if (!Array.isArray(input.disabledConfigurations)) {
      problems.push("The list of switched-off configurations is invalid.");
    } else {
      // Bounded by the configuration cap: there is no legitimate reason to
      // switch off more configurations than can exist.
      if (input.disabledConfigurations.length > MAX_CONFIGURATIONS) {
        problems.push("The list of switched-off configurations is longer than the number of configurations.");
      } else {
        disabledConfigurations = input.disabledConfigurations.filter((value): value is string => {
          if (typeof value !== "string") {
            problems.push("A switched-off configuration was not recognised.");
            return false;
          }
          return true;
        });
      }
    }
  }

  // ---- variant mappings
  const variantMappings: Record<string, string> = {};
  if (input.variantMappings !== undefined) {
    if (!isPlainRecord(input.variantMappings)) {
      problems.push("The variant mapping is invalid.");
    } else if (Object.keys(input.variantMappings).length > MAX_CONFIGURATIONS) {
      problems.push("There are more variant mappings than there are configurations.");
    } else {
      for (const [signature, variantId] of Object.entries(input.variantMappings)) {
        if (typeof variantId !== "string" || variantId.trim() === "") {
          problems.push("A variant mapping has no product variant.");
          continue;
        }
        variantMappings[signature] = variantId;
      }
    }
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    value: {
      productType,
      title,
      description,
      options,
      content,
      disabledConfigurations,
      variantMappings,
    },
  };
}

/**
 * Every `MasterVariant.id` a builder state maps to. The route uses this to
 * confirm each one is an eligible variant of THIS campaign before saving —
 * see the section header on what `parseCampaignBuilderState` cannot check.
 */
export function mappedVariantIds(state: CampaignBuilderState): readonly string[] {
  return [...new Set(Object.values(state.variantMappings))];
}

// ---------------------------------------------------------------------------
// Presentation: parsing, reasons, and image references
// ---------------------------------------------------------------------------

export type CampaignPresentationParseResult =
  | { readonly ok: true; readonly value: BuilderCampaignPresentation }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Parses a posted presentation edit. Uses the SAME field readers as the full
 * builder parser (see `fieldReaders`), so the image rules on the one path
 * that stays open after a campaign ships are not a second, laxer copy.
 *
 * Only the six presentation fields are read. Anything else in the payload is
 * ignored rather than rejected: this endpoint's contract is "these six
 * fields", and a client that sends the whole builder state to it must not be
 * able to smuggle an option change through by including one.
 */
export function parseCampaignPresentation(input: unknown): CampaignPresentationParseResult {
  const problems: string[] = [];

  if (!isPlainRecord(input)) {
    return { ok: false, problems: ["The presentation content was not an object."] };
  }

  const { text, parseImage } = fieldReaders(problems);

  let galleryImages: BuilderImageRef[] = [];
  if (input.galleryImages !== undefined) {
    if (!Array.isArray(input.galleryImages)) {
      problems.push("The gallery must be a list.");
    } else if (input.galleryImages.length > MAX_GALLERY_IMAGES) {
      problems.push(
        `There are ${input.galleryImages.length} gallery images; the limit is ${MAX_GALLERY_IMAGES}.`
      );
    } else {
      galleryImages = input.galleryImages
        .map((value, index) => parseImage(value, `Gallery image ${index + 1}`))
        .filter((image): image is BuilderImageRef => image !== null);
    }
  }

  const value: BuilderCampaignPresentation = {
    headline: text(input.headline, "Headline"),
    shortDescription: text(input.shortDescription, "Short description"),
    heroImage: parseImage(input.heroImage, "Hero image"),
    mobileHeroImage: parseImage(input.mobileHeroImage, "Mobile hero image"),
    cardImage: parseImage(input.cardImage, "Card image"),
    galleryImages,
  };

  if (problems.length > 0) return { ok: false, problems };
  return { ok: true, value };
}

/**
 * A presentation change on a LIVE campaign has to say why (owner decision,
 * 2026-11-06). Eight characters is not an anti-abuse measure — anyone
 * determined to write "asdfasdf" will — it is enough to stop an empty box
 * and an accidental single keystroke becoming the permanent audit record of
 * why a live campaign's photography changed.
 */
export const MIN_PRESENTATION_REASON_LENGTH = 8;

export function validatePresentationReason(
  raw: string
): { readonly ok: true; readonly value: string } | { readonly ok: false; readonly problem: string } {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return {
      ok: false,
      problem:
        "Give a reason for this change. It is recorded against the campaign, for example “Corrected headline typo”.",
    };
  }
  if (trimmed.length < MIN_PRESENTATION_REASON_LENGTH) {
    return {
      ok: false,
      problem: `That reason is too short to be useful later. Use at least ${MIN_PRESENTATION_REASON_LENGTH} characters, for example “Corrected headline typo”.`,
    };
  }
  if (trimmed.length > MAX_TEXT_LENGTH) {
    return { ok: false, problem: `That reason is longer than ${MAX_TEXT_LENGTH} characters. Shorten it.` };
  }
  return { ok: true, value: trimmed };
}

/** One image reference, with the merchant-facing name of the field it came from. */
export interface LocatedImageRef {
  readonly path: string;
  readonly ref: BuilderImageRef;
}

/** Every image in a presentation, labelled, in a stable order. */
export function locatedImageRefs(presentation: BuilderCampaignPresentation): readonly LocatedImageRef[] {
  const located: LocatedImageRef[] = [];
  const add = (path: string, ref: BuilderImageRef | null) => {
    if (ref !== null) located.push({ path, ref });
  };
  add("Hero image", presentation.heroImage);
  add("Mobile hero image", presentation.mobileHeroImage);
  add("Card image", presentation.cardImage);
  presentation.galleryImages.forEach((ref, index) => add(`Gallery image ${index + 1}`, ref));
  return located;
}

/**
 * The Shopify file ids a submission needs resolved against the Admin API,
 * deduplicated. The caller resolves these and replaces each reference's URL
 * and alt text with Shopify's own answer — see
 * `resolveCampaignImageRefs` in `campaignImages.server.ts`.
 */
export function imageFileGidsToResolve(presentation: BuilderCampaignPresentation): readonly string[] {
  return [
    ...new Set(
      locatedImageRefs(presentation)
        .map((located) => located.ref.fileGid)
        .filter((fileGid) => fileGid.trim() !== "")
    ),
  ];
}

/**
 * Images that carry a URL but NO Shopify file id, and whose URL was not
 * already stored.
 *
 * ===========================================================================
 * WHY A GID-LESS REFERENCE IS TOLERATED AT ALL
 * ===========================================================================
 * Before the native picker existed, a merchant pasted a Shopify Files link
 * and no id was recorded. The owner asked for those snapshots to keep
 * working, so a reference with no id is still valid — but ONLY if it is one
 * of those, meaning its URL is already in the previously stored content.
 *
 * A NEW id-less reference is refused. Without an id there is nothing to
 * resolve against the Admin API, so its URL could be any `cdn.shopify.com`
 * path at all, including one belonging to a different shop. Grandfathering
 * what already exists is compatibility; accepting new ones would be leaving
 * the old hole open and calling it compatibility.
 */
export function unverifiableImagePaths(
  next: BuilderCampaignPresentation,
  previous: BuilderCampaignPresentation | null
): readonly string[] {
  const grandfathered = new Set(
    previous === null
      ? []
      : locatedImageRefs(previous)
          .filter((located) => located.ref.fileGid.trim() === "")
          .map((located) => located.ref.url)
  );

  return locatedImageRefs(next)
    .filter((located) => located.ref.fileGid.trim() === "" && !grandfathered.has(located.ref.url))
    .map((located) => located.path);
}

/**
 * Rewrites every image reference that has a file id so its URL and alt text
 * are the ones Shopify reported for that id.
 *
 * This is the step that makes a submitted URL irrelevant rather than merely
 * checked. A reference with no id is left alone — it is a grandfathered
 * pasted link, already constrained to `cdn.shopify.com` by the parser and
 * already confirmed by `unverifiableImagePaths` to be one that was previously
 * stored.
 *
 * A reference whose id is absent from the map is also left alone rather than
 * dropped. That cannot happen on the save path, which resolves every id and
 * refuses the save on any problem; leaving it is the conservative behaviour
 * if some future caller resolves only a subset.
 */
export function applyResolvedImages(
  presentation: BuilderCampaignPresentation,
  byGid: ReadonlyMap<string, { readonly url: string; readonly altText: string }>
): BuilderCampaignPresentation {
  const apply = (ref: BuilderImageRef | null): BuilderImageRef | null => {
    if (ref === null || ref.fileGid.trim() === "") return ref;
    const resolved = byGid.get(ref.fileGid);
    if (resolved === undefined) return ref;
    return { fileGid: ref.fileGid, url: resolved.url, altText: resolved.altText };
  };

  return {
    headline: presentation.headline,
    shortDescription: presentation.shortDescription,
    heroImage: apply(presentation.heroImage),
    mobileHeroImage: apply(presentation.mobileHeroImage),
    cardImage: apply(presentation.cardImage),
    galleryImages: presentation.galleryImages
      .map((ref) => apply(ref))
      .filter((ref): ref is BuilderImageRef => ref !== null),
  };
}
