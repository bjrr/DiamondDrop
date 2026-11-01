/**
 * Set Your Own Stone compatibility metafields — the canonical definition list.
 *
 * Authoritative requirements: docs/SET-YOUR-OWN-STONE.md §5, §6.2.1; owner
 * direction 2026-11-01 (Shopify-native authoring).
 *
 * ---------------------------------------------------------------------------
 * SHOPIFY PRODUCT ADMIN IS THE AUTHORING SURFACE
 * ---------------------------------------------------------------------------
 * These are real metafield DEFINITIONS, not loose ad-hoc values, and every one
 * is `pin: true` so it appears in Shopify Product Admin without staff needing
 * our app at all. Merchant-facing names are written for a jeweller, not for a
 * developer — "Nominal Stone Length (mm)", not `nominal_length_um`.
 *
 * MILLIMETRES EVERYWHERE A HUMAN CAN SEE. Staff type 10.25; the sync layer
 * converts once to integer micrometres for the matching engine. Micrometres
 * are an internal representation chosen so a fit tolerance is never decided by
 * a float (CLAUDE.md rule 6), and exposing them to staff would be both
 * confusing and an invitation to enter 10250 in a field meaning 10.25.
 *
 * ---------------------------------------------------------------------------
 * WHY NOMINAL DIMENSIONS SIT ON THE VARIANT
 * ---------------------------------------------------------------------------
 * Shopify can model this better: `ProductOption.linkedMetafield` plus
 * `ProductOptionValue.linkedMetafieldValue` let the "Center Stone Size" option
 * value BE a reference to a shared metaobject profile, which makes label/data
 * drift structurally impossible. That is the preferred design and it is
 * blocked only on the `write_metaobjects` scope, which the app has not been
 * granted.
 *
 * Until then the owner's stated fallback applies (direction 2026-11-01 §2):
 * the option label is display data, these structured metafields are the
 * authority, and the relationship between the two is VALIDATED at sync time
 * with mismatches surfaced in the dashboard. A mismatch is never silently
 * accepted, and nothing anywhere parses "10 × 7 mm" to obtain a dimension.
 *
 * When the scope arrives, the metaobject becomes the authority and these
 * variant fields become derived — the sync layer is the only thing that has to
 * change, because nothing else reads Shopify directly.
 */

export const SYOS_NAMESPACE = "carat" as const;

/** A shape must be one of the ten the matcher knows. Enforced as a Shopify
 *  choice validation so Product Admin offers a dropdown rather than a free
 *  text box an operator can mistype into. */
export const SYOS_SHAPE_CHOICES = [
  "round",
  "oval",
  "cushion",
  "princess",
  "emerald",
  "radiant",
  "pear",
  "marquise",
  "asscher",
  "heart",
] as const;

/**
 * Setting styles.
 *
 * `prong` is listed first because it is the only family the owner's ±0.3 mm
 * accommodation applies to. The others exist so that "not prong-adjustable" is
 * a recorded fact about the design rather than an unexplained unticked box.
 */
export const SYOS_SETTING_STYLE_CHOICES = [
  "prong",
  "bezel",
  "channel",
  "tension",
  "halo",
  "bar",
  "flush",
  "other",
] as const;

export interface SyosMetafieldDefinition {
  readonly key: string;
  /** Merchant-facing label shown in Shopify Product Admin. */
  readonly name: string;
  readonly description: string;
  /** A Shopify metafield type string, e.g. `boolean`, `number_decimal`. */
  readonly type: string;
  readonly ownerType: "PRODUCT" | "PRODUCTVARIANT";
  readonly choices?: readonly string[];
}

/**
 * Product level — one mounting design.
 *
 * These apply to every variant, which is exactly why they live here: a
 * mounting is prong-set or it is not, and recording that per centre size would
 * let one size claim an allowance its siblings do not have.
 */
export const SYOS_PRODUCT_DEFINITIONS: readonly SyosMetafieldDefinition[] = [
  {
    key: "syos_eligible",
    name: "Eligible",
    description:
      "Offer this mounting for a customer-supplied stone. Off means it is never shown in Set Your Own Stone.",
    type: "boolean",
    ownerType: "PRODUCT",
  },
  {
    key: "syos_stone_shape",
    name: "Stone Shape",
    description:
      "The centre-stone shape this mounting is made for. Matching compares shape before any dimension, so a wrong value hides the mounting completely.",
    type: "single_line_text_field",
    ownerType: "PRODUCT",
    choices: SYOS_SHAPE_CHOICES,
  },
  {
    key: "syos_setting_style",
    name: "Setting Style",
    description: "How the stone is held. Only prong settings can receive the ±0.3 mm allowance.",
    type: "single_line_text_field",
    ownerType: "PRODUCT",
    choices: SYOS_SETTING_STYLE_CHOICES,
  },
  {
    key: "syos_prong_adjustable",
    name: "Prong Adjustable",
    description: "A bench can adjust the prongs on this design during setting.",
    type: "boolean",
    ownerType: "PRODUCT",
  },
  {
    key: "syos_prong_tolerance_eligible",
    name: "±0.3 mm Prong Tolerance Eligible",
    description:
      "Apply the approved ±0.3 mm automatic allowance to this design. Leave off for bezel, channel and tension settings: a mounting marked here is advertised as a size match up to 0.3 mm from nominal, and the customer's own stone is already in the post by the time a bench finds out otherwise.",
    type: "boolean",
    ownerType: "PRODUCT",
  },
  {
    key: "syos_vendor",
    name: "Vendor",
    description: "Who supplies this mounting. Recorded so a published size range can be traced to its source.",
    type: "single_line_text_field",
    ownerType: "PRODUCT",
  },
];

/**
 * Variant level — one purchasable centre-size configuration.
 *
 * `number_decimal` throughout for measurements, so Shopify itself rejects
 * "10.3mm" and "about 10" before the value ever reaches us. The sync layer
 * still revalidates, because a definition can be edited or a value written
 * through the API without passing Admin's own form.
 */
export const SYOS_VARIANT_DEFINITIONS: readonly SyosMetafieldDefinition[] = [
  {
    key: "syos_nominal_length_mm",
    name: "Nominal Stone Length (mm)",
    description: "The centre-stone length this configuration is built for, in millimetres. For example 10.25.",
    type: "number_decimal",
    ownerType: "PRODUCTVARIANT",
  },
  {
    key: "syos_nominal_width_mm",
    name: "Nominal Stone Width (mm)",
    description: "The centre-stone width this configuration is built for, in millimetres.",
    type: "number_decimal",
    ownerType: "PRODUCTVARIANT",
  },
  {
    key: "syos_nominal_depth_mm",
    name: "Nominal Stone Depth (mm)",
    description: "Optional. The centre-stone depth, if the supplier states one.",
    type: "number_decimal",
    ownerType: "PRODUCTVARIANT",
  },
  {
    key: "syos_vendor_min_length_mm",
    name: "Vendor Min Length (mm)",
    description:
      "Only when the manufacturer published an accepted range. A vendor range overrides the nominal size and the ±0.3 mm allowance in both directions. All four bounds are required together.",
    type: "number_decimal",
    ownerType: "PRODUCTVARIANT",
  },
  {
    key: "syos_vendor_max_length_mm",
    name: "Vendor Max Length (mm)",
    description: "The upper length bound of the manufacturer's published range.",
    type: "number_decimal",
    ownerType: "PRODUCTVARIANT",
  },
  {
    key: "syos_vendor_min_width_mm",
    name: "Vendor Min Width (mm)",
    description: "The lower width bound of the manufacturer's published range.",
    type: "number_decimal",
    ownerType: "PRODUCTVARIANT",
  },
  {
    key: "syos_vendor_max_width_mm",
    name: "Vendor Max Width (mm)",
    description: "The upper width bound of the manufacturer's published range.",
    type: "number_decimal",
    ownerType: "PRODUCTVARIANT",
  },
  {
    key: "syos_vendor_range_source",
    name: "Vendor Range Source",
    description:
      "Where the published range came from — a spec sheet, catalogue page or supplier email. Required whenever a range is entered, because the range outranks every rule of ours.",
    type: "single_line_text_field",
    ownerType: "PRODUCTVARIANT",
  },
  {
    key: "syos_compatibility_active",
    name: "Compatibility Active",
    description:
      "Untick to withdraw this configuration from Set Your Own Stone without deleting anything, so past sessions that matched it still explain themselves.",
    type: "boolean",
    ownerType: "PRODUCTVARIANT",
  },
];

export const SYOS_ALL_DEFINITIONS: readonly SyosMetafieldDefinition[] = [
  ...SYOS_PRODUCT_DEFINITIONS,
  ...SYOS_VARIANT_DEFINITIONS,
];

/** Keys only, for the namespace-scoped event subscription and for reads. */
export const SYOS_PRODUCT_KEYS = SYOS_PRODUCT_DEFINITIONS.map((d) => d.key);
export const SYOS_VARIANT_KEYS = SYOS_VARIANT_DEFINITIONS.map((d) => d.key);
