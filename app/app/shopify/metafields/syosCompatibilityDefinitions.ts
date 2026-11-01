/**
 * Set Your Own Stone compatibility — the canonical Shopify custom-data spec.
 *
 * Authoritative requirements: docs/SET-YOUR-OWN-STONE.md §5, §6.2.1; owner
 * direction 2026-11-01 and the approved native architecture:
 *
 *   Shopify Product
 *     -> "Center Stone Size" ProductOption
 *       -> ProductOptionValue (stable id)
 *         -> custom.syos_center_size            (linking metafield)
 *           -> $app:syos_center_size_profile    (app-owned metaobject)
 *             -> shape + nominal dimensions
 *
 * ---------------------------------------------------------------------------
 * WHY THE LINKING METAFIELD IS MERCHANT-OWNED AND THE PROFILE IS NOT
 * ---------------------------------------------------------------------------
 * Not a style choice. Verified empirically against 2026-10 with the app's own
 * token, changing exactly one variable:
 *
 *   namespace `$app:syos`  -> resolves to `app--424838725633--syos`
 *                          -> productOptionsCreate REFUSES:
 *                             "No valid metafield definition found at
 *                              '...' for linked option"
 *   namespace `custom`     -> ACCEPTED, with a stable ProductOptionValue id
 *                             and linkedMetafieldValue pointing at our
 *                             app-owned metaobject
 *
 * So `ProductOption.linkedMetafield` does not accept an app-reserved
 * namespace. The METAOBJECT stays app-owned — which is what buys us the
 * scope exemption of Shopify's 2026-04 change, so no `read_metaobjects` or
 * `write_metaobjects` is needed to read or write profiles. Only the small
 * pointer lives in `custom`, and creating it needs nothing beyond
 * `write_products`.
 *
 * ---------------------------------------------------------------------------
 * WHERE EACH FIELD LIVES, AND WHY IT CANNOT LIVE ELSEWHERE
 * ---------------------------------------------------------------------------
 * PROFILE (shared, one entry per real centre size): shape and nominal
 * dimensions. "Pear 10 × 7 mm" means the same measurements on every mounting
 * in the catalogue, so duplicating them per variant is how two mountings end
 * up disagreeing about what 10 × 7 means.
 *
 * VARIANT (per mounting + size): the vendor range and compatibility state. A
 * vendor may approve a different range for one 10 × 7 mounting than for
 * another, so these are properties of the actual configuration and must not
 * be pushed into a shared profile.
 *
 * PRODUCT (per design): eligibility, setting style, the two prong flags, and
 * the vendor. A mounting is prong-set or it is not; recording that per centre
 * size would let one size claim an allowance its siblings do not have.
 *
 * `syos_stone_shape` is ALSO kept at product level, deliberately duplicating
 * the profile's shape. It is a declaration, cross-checked against every
 * profile the product references — which catches a pear mounting wired to an
 * oval profile. The profile remains authoritative; the product-level value
 * exists only to disagree with it loudly.
 *
 * MILLIMETRES EVERYWHERE A HUMAN CAN SEE. Micrometres are internal, chosen so
 * a fit tolerance is never decided by a float (CLAUDE.md rule 6). Showing
 * them to staff would invite someone typing 10250 into a field meaning 10.25.
 */

/** Merchant-owned, because Shopify refuses an app-reserved namespace for a
 *  linked option. See the header. */
export const SYOS_LINKING_NAMESPACE = "custom" as const;
export const SYOS_LINKING_KEY = "syos_center_size" as const;

/** App-owned: `$app:` is what exempts profile reads and writes from the
 *  metaobject scopes. */
export const SYOS_PROFILE_TYPE = "$app:syos_center_size_profile" as const;

/** Where the product- and variant-level compatibility metafields live. The
 *  house namespace, already used for pricing and Luxury Steals metafields. */
export const SYOS_NAMESPACE = "carat" as const;

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

/** `prong` first because it is the only family the owner's ±0.3 mm
 *  accommodation applies to. The rest exist so "not prong-adjustable" is a
 *  recorded fact rather than an unexplained unticked box. */
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

// ------------------------------------------------- the app-owned size profile

export interface SyosProfileFieldSpec {
  readonly key: string;
  readonly name: string;
  readonly type: string;
  readonly description: string;
  readonly required?: boolean;
  readonly choices?: readonly string[];
}

/**
 * Fields on one Center Stone Size Profile.
 *
 * `display_name` is first and is the definition's `displayNameKey`. WITHOUT
 * THAT, Shopify names the option value from the definition and the customer
 * sees something like "App 424838725633 Probe Center Size #B1GMFLSE" — which
 * the probe actually produced. The display name is the only reason the
 * customer-facing option reads "Pear 10 × 7 mm", so it is required.
 */
export const SYOS_PROFILE_FIELDS: readonly SyosProfileFieldSpec[] = [
  {
    key: "display_name",
    name: "Display Name",
    type: "single_line_text_field",
    description:
      "What customers and staff see for this centre size, for example “Pear 10 × 7 mm”. This becomes the Center Stone Size option label.",
    required: true,
  },
  {
    key: "stone_shape",
    name: "Stone Shape",
    type: "single_line_text_field",
    description:
      "The centre-stone shape this size is for. Matching compares shape before any dimension, so a wrong value hides every mounting using this profile.",
    required: true,
    choices: SYOS_SHAPE_CHOICES,
  },
  {
    key: "nominal_length_mm",
    name: "Nominal Stone Length (mm)",
    type: "number_decimal",
    description: "The centre-stone length this size is built for, in millimetres. For example 10.25.",
    required: true,
  },
  {
    key: "nominal_width_mm",
    name: "Nominal Stone Width (mm)",
    type: "number_decimal",
    description: "The centre-stone width this size is built for, in millimetres.",
    required: true,
  },
  {
    key: "nominal_depth_mm",
    name: "Nominal Stone Depth (mm)",
    type: "number_decimal",
    description: "Optional. The centre-stone depth, if the supplier states one.",
  },
];

export const SYOS_PROFILE_DEFINITION = {
  type: SYOS_PROFILE_TYPE,
  name: "Center Stone Size Profile",
  description:
    "A real centre-stone size — shape and nominal millimetre dimensions — shared by every mounting offered in that size.",
  /** So the option label reads "Pear 10 × 7 mm" and never an app identifier. */
  displayNameKey: "display_name",
  access: {
    /** Staff edit profiles in Shopify Admin. That is the whole point of
     *  app-owned-but-merchant-editable: one authoring surface, no app needed. */
    admin: "MERCHANT_READ_WRITE",
    /** The storefront shows the matched centre size as information. */
    storefront: "PUBLIC_READ",
  },
  fields: SYOS_PROFILE_FIELDS,
} as const;

// ----------------------------------------------------- product and variant

export interface SyosMetafieldDefinition {
  readonly namespace: string;
  readonly key: string;
  readonly name: string;
  readonly description: string;
  readonly type: string;
  readonly ownerType: "PRODUCT" | "PRODUCTVARIANT";
  readonly choices?: readonly string[];
}

/** The pointer from a product's Center Stone Size option to its profiles.
 *  Merchant-owned by Shopify's requirement, not by preference. */
export const SYOS_LINKING_DEFINITION: SyosMetafieldDefinition = {
  namespace: SYOS_LINKING_NAMESPACE,
  key: SYOS_LINKING_KEY,
  name: "Center Stone Size",
  description:
    "The centre sizes this mounting is offered in. Linked to the Center Stone Size product option, so each option value points at a shared size profile.",
  type: "list.metaobject_reference",
  ownerType: "PRODUCT",
};

export const SYOS_PRODUCT_DEFINITIONS: readonly SyosMetafieldDefinition[] = [
  {
    namespace: SYOS_NAMESPACE,
    key: "syos_eligible",
    name: "Eligible",
    description:
      "Offer this mounting for a customer-supplied stone. Off means it is never shown in Set Your Own Stone.",
    type: "boolean",
    ownerType: "PRODUCT",
  },
  {
    namespace: SYOS_NAMESPACE,
    key: "syos_stone_shape",
    name: "Stone Shape",
    description:
      "The shape this mounting is made for. Cross-checked against every centre-size profile it references; the profile is authoritative and a disagreement is reported.",
    type: "single_line_text_field",
    ownerType: "PRODUCT",
    choices: SYOS_SHAPE_CHOICES,
  },
  {
    namespace: SYOS_NAMESPACE,
    key: "syos_setting_style",
    name: "Setting Style",
    description: "How the stone is held. Only prong settings can receive the ±0.3 mm allowance.",
    type: "single_line_text_field",
    ownerType: "PRODUCT",
    choices: SYOS_SETTING_STYLE_CHOICES,
  },
  {
    namespace: SYOS_NAMESPACE,
    key: "syos_prong_adjustable",
    name: "Prong Adjustable",
    description: "A bench can adjust the prongs on this design during setting.",
    type: "boolean",
    ownerType: "PRODUCT",
  },
  {
    namespace: SYOS_NAMESPACE,
    key: "syos_prong_tolerance_eligible",
    name: "±0.3 mm Prong Tolerance Eligible",
    description:
      "Apply the approved ±0.3 mm automatic allowance to this design. Leave off for bezel, channel and tension settings: a mounting marked here is advertised as a size match up to 0.3 mm from nominal, and the customer's own stone is already in the post by the time a bench finds out otherwise.",
    type: "boolean",
    ownerType: "PRODUCT",
  },
  {
    namespace: SYOS_NAMESPACE,
    key: "syos_vendor",
    name: "Vendor",
    description: "Who supplies this mounting. Recorded so a published size range can be traced to its source.",
    type: "single_line_text_field",
    ownerType: "PRODUCT",
  },
];

/**
 * Variant level — mounting-specific, never shared.
 *
 * Nominal dimensions are NOT here: they live on the shared profile. These are
 * the values a vendor may set differently for one 10 × 7 mounting than for
 * another, which is exactly why they stay attached to the configuration.
 */
export const SYOS_VARIANT_DEFINITIONS: readonly SyosMetafieldDefinition[] = [
  {
    namespace: SYOS_NAMESPACE,
    key: "syos_vendor_min_length_mm",
    name: "Vendor Min Length (mm)",
    description:
      "Only when the manufacturer published an accepted range FOR THIS MOUNTING. A vendor range overrides the nominal size and the ±0.3 mm allowance in both directions. All four bounds are required together.",
    type: "number_decimal",
    ownerType: "PRODUCTVARIANT",
  },
  {
    namespace: SYOS_NAMESPACE,
    key: "syos_vendor_max_length_mm",
    name: "Vendor Max Length (mm)",
    description: "The upper length bound of the manufacturer's published range for this mounting.",
    type: "number_decimal",
    ownerType: "PRODUCTVARIANT",
  },
  {
    namespace: SYOS_NAMESPACE,
    key: "syos_vendor_min_width_mm",
    name: "Vendor Min Width (mm)",
    description: "The lower width bound of the manufacturer's published range for this mounting.",
    type: "number_decimal",
    ownerType: "PRODUCTVARIANT",
  },
  {
    namespace: SYOS_NAMESPACE,
    key: "syos_vendor_max_width_mm",
    name: "Vendor Max Width (mm)",
    description: "The upper width bound of the manufacturer's published range for this mounting.",
    type: "number_decimal",
    ownerType: "PRODUCTVARIANT",
  },
  {
    namespace: SYOS_NAMESPACE,
    key: "syos_vendor_range_source",
    name: "Vendor Range Source",
    description:
      "Where the published range came from — a spec sheet, catalogue page or supplier email. Required whenever a range is entered, because the range outranks every rule of ours.",
    type: "single_line_text_field",
    ownerType: "PRODUCTVARIANT",
  },
  {
    namespace: SYOS_NAMESPACE,
    key: "syos_compatibility_active",
    name: "Compatibility Active",
    description:
      "Untick to withdraw this configuration from Set Your Own Stone without deleting anything, so past sessions that matched it still explain themselves.",
    type: "boolean",
    ownerType: "PRODUCTVARIANT",
  },
];

export const SYOS_ALL_METAFIELD_DEFINITIONS: readonly SyosMetafieldDefinition[] = [
  SYOS_LINKING_DEFINITION,
  ...SYOS_PRODUCT_DEFINITIONS,
  ...SYOS_VARIANT_DEFINITIONS,
];

export const SYOS_PRODUCT_KEYS = SYOS_PRODUCT_DEFINITIONS.map((d) => d.key);
export const SYOS_VARIANT_KEYS = SYOS_VARIANT_DEFINITIONS.map((d) => d.key);
export const SYOS_PROFILE_FIELD_KEYS = SYOS_PROFILE_FIELDS.map((f) => f.key);
