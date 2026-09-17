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
export const PRICING_ENGINE_VERSION = "BUY_NOW_PRICING_V1";
