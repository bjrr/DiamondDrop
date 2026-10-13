/**
 * Version of the pricing formula (spec §5.6).
 *
 * Bump whenever the calculation changes in a way that would make a stored
 * price_calculation irreproducible: the §5.3 solve, the §5.2 component
 * ordering, or the §5.5 floor logic. Bumping is an architect-reviewed change.
 *
 * A stored calculation records the version it was computed under. Reproduction
 * asserts equality only when the versions match; when they differ the
 * difference is reported, never silently asserted equal (§5.6, criterion 19).
 */
/**
 * V2, 2026-09-18: the Regular/Card Price moved from a fixed 5% uplift with a
 * whole-dollar ceiling to the tiered schedule in docs/BANK-CARD-PRICING.md with
 * a $5 ceiling. The Bank Payment Price is unchanged by that switch, but a
 * stored V1 result carries the old card price and the old field names, so it
 * cannot be asserted equal to a fresh computation — which is exactly what this
 * version string exists to tell `verify`.
 */
export const PRICING_ENGINE_VERSION = "BUY_NOW_PRICING_V2";
