/**
 * The `carat.luxury_steal` metafield contract (Slice 3 task 3-2, spec
 * `docs/specs/SLICE-3-LUXURY-STEALS.md` criteria 126-128, 148-150, owner
 * decisions D26/D27).
 *
 * PRESENTATION CACHE ONLY — NEVER AUTHORITATIVE (criteria 127, 150). D26
 * settled that Luxury Steal assignment lives in Postgres
 * (`master_variant.is_luxury_steal`), synced here as a cache for the theme,
 * exactly as published prices are a cache under `priceMetafieldPayload.ts`.
 * The order-time verification in slice 3 task 3-4 reads Postgres directly and
 * must NEVER fall back to this metafield, a client-supplied flag, or any
 * other cached value: a stale or missing metafield fails safe (the SERVER'S
 * answer wins), never the other way round. If Postgres says a variant is a
 * Luxury Steal and this metafield disagrees, the metafield is simply wrong
 * and due for a resync — it is not a second vote.
 *
 * WHY THIS IS A VARIANT METAFIELD, NOT A PRODUCT METAFIELD (D27). D26
 * originally named a *product* metafield. D27 then made the authoritative
 * assignment variant-level, and one product-level boolean cannot represent a
 * mixed variant set (criterion 147: one Luxury Steal variant must not make
 * its normal siblings Final Sale). The cache therefore moved to the variant
 * grain — `ownerId` below is always a `ProductVariant` gid — while keeping
 * the namespace and key the owner named. No product-level rollup field
 * exists; criterion 148's card badge is computed in Liquid by looping
 * `product.variants` and combining each variant's own
 * `metafields.carat.luxury_steal` with that same variant's live `available`,
 * because a stored rollup would need recomputing on every inventory movement
 * and would be wrong in the window before it caught up.
 *
 * WHY `type: "boolean"`, NOT `json` OR `single_line_text_field` (criterion
 * 149). Unlike the price-bearing payloads in `priceMetafieldPayload.ts`, this
 * flag carries no money and needs no `priceCalculationId`-style staleness
 * marker, so the JSON-envelope reasoning in that file's header comment does
 * not apply here — a bare boolean is the simplest thing that is still
 * self-describing. It is also the only metafield type Liquid can safely test
 * in a conditional (read through `.value` — see the contract below): a
 * `boolean` metafield's `.value` is a native Liquid `true`/`false`, but a
 * `single_line_text_field` whose `.value` is the STRING
 * "false" is a non-empty string, and Liquid has no type coercion in
 * equality — `{% if "false" %}` is TRUE. A text-field flag would therefore
 * render every synced variant, assigned or not, as a Luxury Steal the moment
 * it had ever been written. `boolean` is also the type this codebase already
 * uses for its other non-price-bearing flags (`buildVariantBankPaymentEligibleMetafield`,
 * `buildVariantSyncSuspendedMetafield` in `priceMetafieldPayload.ts`), so
 * this follows established precedent rather than introducing a third
 * convention.
 *
 * THE LIQUID-SIDE CONTRACT (for task 3-5). `variant.metafields.carat.luxury_steal`
 * is one of:
 *   - `true`  — this variant is currently assigned as a Luxury Steal.
 *   - `false` — this variant was explicitly synced as NOT a Luxury Steal
 *     (see the unassignment note below).
 *   - `nil`   — never synced (a variant created before its first sync ran).
 * READ IT THROUGH `.value`, ALWAYS:
 *
 *     {% if variant.metafields.carat.luxury_steal.value %}
 *
 * NOT `{% if variant.metafields.carat.luxury_steal %}`. In Liquid,
 * `variant.metafields.ns.key` resolves to a METAFIELD DROP, not to the
 * stored value, and a drop is an object — therefore TRUTHY WHENEVER THE
 * METAFIELD EXISTS AT ALL, including when its value is `false`. Testing the
 * drop would light up the Final Sale gate on every variant that had ever
 * been synced, which is precisely the failure mode the `boolean` type was
 * chosen to avoid, reintroduced one property short of the value. The
 * unassignment decision below makes this worse rather than better: writing
 * an explicit `false` is what guarantees the drop exists on non-assigned
 * variants.
 *
 * This is not a theoretical reading of the Liquid spec — it is what the
 * shipped theme already does. Every metafield read in `theme/snippets/
 * price.liquid` (lines 103 and 185) goes through `.value`, and that snippet
 * was live-verified in slice 2.
 *
 * `.value` yields `true`, `false`, or `nil` (a missing metafield resolves
 * to `nil`, and `nil.value` is `nil`, so the unsynced case needs no
 * separate guard). `nil` and `false` are Liquid's only falsy values, so the
 * single `.value` test above is the whole gate. Task 3-5 must gate the Final
 * Sale disclosure and acknowledgment on the SELECTED variant's own value,
 * and must reset it on every variant change (criterion 146) — never on any
 * product-level value, because none exists.
 *
 * UNASSIGNMENT WRITES AN EXPLICIT `false` RATHER THAN DELETING THE METAFIELD
 * (criterion 128). Liquid's `{% if %}` cannot tell a deleted metafield from
 * one that was never written — both simply resolve to `nil` — so *for
 * rendering* the two choices are equivalent. Writing an explicit `false` is
 * still the right call for two reasons that matter outside Liquid: (1) it
 * keeps this module consistent with the sibling boolean flags above, which
 * both write explicit values rather than deleting, so a reader of this
 * codebase does not have to remember a special case for this one field; and
 * (2) it makes "we successfully synced this variant's assignment" an
 * observable, auditable fact independent of Liquid — `false` on the
 * metafield says "checked, not a Luxury Steal", where a missing metafield
 * says only "unknown", which matters to anyone diagnosing sync health from
 * the Admin API or a support tool, even though the storefront itself cannot
 * tell the difference.
 */

export const LUXURY_STEAL_METAFIELD_NAMESPACE = "carat" as const;
export const LUXURY_STEAL_METAFIELD_KEY = "luxury_steal" as const;

/**
 * The narrow input this module needs — deliberately NOT the Prisma
 * `MasterVariant` type (task 3-1 is adding `isLuxurySteal` to that model
 * concurrently). Keeping this shape local means this module is testable and
 * mergeable independently of task 3-1's schema work; any caller can map its
 * own richer type down to this one field-for-field.
 */
export interface LuxuryStealAssignment {
  /** The Shopify GID of the variant this assignment applies to, e.g. "gid://shopify/ProductVariant/123". */
  readonly shopifyVariantGid: string;
  readonly isLuxurySteal: boolean;
}

export interface LuxuryStealMetafieldWriteInput {
  readonly ownerId: string;
  readonly namespace: typeof LUXURY_STEAL_METAFIELD_NAMESPACE;
  readonly key: typeof LUXURY_STEAL_METAFIELD_KEY;
  readonly type: "boolean";
  /** Shopify's own string encoding for a `boolean` metafield value — never a JSON boolean. */
  readonly value: "true" | "false";
}

/**
 * Builds the `metafieldsSet` input for one variant's Luxury Steal
 * assignment. Pure and synchronous — no Admin API access here; see
 * `luxuryStealMetafieldWriter.server.ts` for the write itself.
 */
export function buildLuxuryStealMetafield(assignment: LuxuryStealAssignment): LuxuryStealMetafieldWriteInput {
  return {
    ownerId: assignment.shopifyVariantGid,
    namespace: LUXURY_STEAL_METAFIELD_NAMESPACE,
    key: LUXURY_STEAL_METAFIELD_KEY,
    type: "boolean",
    value: assignment.isLuxurySteal ? "true" : "false",
  };
}
