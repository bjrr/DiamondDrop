/**
 * The $50 prong-only Stone Removal service (docs/SET-YOUR-OWN-STONE.md §17.3,
 * owner-locked 2026-11-02).
 *
 * CaratForUs removes a customer's centre stone only from a PRONG setting. That
 * is a liability boundary, not a capability one: a bezel, channel, tension or
 * flush setting has to be opened by whoever is willing to stand behind the
 * result, and we are not, so we decline and say so plainly.
 *
 * WHY THIS MODULE IS SEPARATE FROM MOUNTING PRICING. The mounting price is a
 * computed figure built from supplier cost, markup and labour components that
 * are deliberately never itemised to the customer (§17.5). This is the one
 * approved exception: a flat service charge shown on its own. Keeping it apart
 * means the removal fee can never slip into the mounting formula, and the
 * mounting formula can never be read as containing it.
 *
 * FLAT MEANS FLAT. $50 per customer centre stone requiring removal. Not per
 * prong, not scaled by carat weight, stone size, ring value or mounting value.
 * There is one centre stone in an SYOS session, so the charge appears at most
 * once. The amount is an integer in minor units, like every other money value
 * in this codebase.
 */
export const STONE_REMOVAL_RULE_ID = "SYOS_STONE_REMOVAL_PRONG_ONLY_V1" as const;

/** $50.00, flat, per customer centre stone requiring removal. */
export const STONE_REMOVAL_FEE_MINOR_UNITS: bigint = 5_000n;

/**
 * What the customer told us about their stone's current setting (§17.3).
 *
 * Three states, because two cannot express the thing that matters: "mounted"
 * on its own does not say whether we are allowed to touch it.
 */
export const STONE_MOUNTED_STATES = [
  "LOOSE",
  "MOUNTED_PRONG",
  "MOUNTED_UNSUPPORTED",
] as const;

export type StoneMountedState = (typeof STONE_MOUNTED_STATES)[number];

export function isStoneMountedState(value: unknown): value is StoneMountedState {
  return typeof value === "string" && (STONE_MOUNTED_STATES as readonly string[]).includes(value);
}

/**
 * Whether the removal service applies, and at what price.
 *
 * Three outcomes rather than a boolean plus an amount, because "no fee" means
 * two completely different things to the customer: a loose stone needs nothing
 * done, while an unsupported setting needs something done that we will not do.
 * Collapsing them would produce a page that says $0 and explains nothing.
 */
export type StoneRemovalOffer =
  /** LOOSE — nothing to remove, nothing to charge, nothing to say. */
  | { readonly kind: "not_needed" }
  /** MOUNTED_PRONG — offered at the flat fee. The customer decides. */
  | { readonly kind: "offered"; readonly feeMinorUnits: bigint }
  /** MOUNTED_UNSUPPORTED — we decline, and the customer carries on designing. */
  | { readonly kind: "unavailable" };

export function stoneRemovalOfferFor(state: StoneMountedState): StoneRemovalOffer {
  switch (state) {
    case "LOOSE":
      return { kind: "not_needed" };
    case "MOUNTED_PRONG":
      return { kind: "offered", feeMinorUnits: STONE_REMOVAL_FEE_MINOR_UNITS };
    case "MOUNTED_UNSUPPORTED":
      return { kind: "unavailable" };
  }
}

/** Whether the service may be added to an order at all for this stone. */
export function stoneRemovalIsPurchasable(state: StoneMountedState): boolean {
  return stoneRemovalOfferFor(state).kind === "offered";
}

/**
 * The charge for this session, in minor units.
 *
 * FAILS CLOSED ON THE STATE, NOT ON THE SELECTION. `selected` arrives from the
 * storefront, so it is a request rather than a fact. A selection against a
 * loose or unsupported stone yields zero here instead of a charge the customer
 * could not have been offered — which is also why the caller must use this
 * result rather than trusting the flag it passed in.
 */
export function stoneRemovalChargeFor(
  state: StoneMountedState,
  selected: boolean
): bigint {
  if (!selected) return 0n;
  const offer = stoneRemovalOfferFor(state);
  return offer.kind === "offered" ? offer.feeMinorUnits : 0n;
}

/**
 * Whether a removal selection is one we are willing to record.
 *
 * Separate from the charge so the route can REJECT a tampered or stale request
 * rather than silently zeroing it. A customer who picked "another type of
 * setting" and whose page still posts `stoneRemovalSelected: true` has a page
 * out of step with their answer; recording that as "declined" would lose the
 * disagreement, and recording it as "selected" would promise a service we do
 * not offer.
 */
export function stoneRemovalSelectionIsValid(
  state: StoneMountedState,
  selected: boolean
): boolean {
  return selected ? stoneRemovalIsPurchasable(state) : true;
}

/**
 * The approved customer-facing copy (§17.3, owner message 2026-11-02 §3–§4).
 *
 * Held here, next to the rule, so no surface can improvise it. Two things the
 * prong wording must never become: a promise that removal is risk-free, or a
 * guarantee that the stone cannot be damaged. It says what our jewelers will
 * do, carefully, and stops there.
 *
 * The unsupported wording has to do two jobs at once — decline the service and
 * keep the customer in the flow. "You can still continue designing your new
 * setting" is the half that stops this being a dead end.
 */
export const STONE_REMOVAL_COPY = {
  /** The service name and price, shown as its own line — never bundled. */
  offerLabel: "Stone Removal — $50",
  offered:
    "Our jewelers can carefully remove your center stone from a standard " +
    "prong setting before setting it into your new mounting.",
  unavailable:
    "We currently only offer stone removal for prong-set stones. Please have " +
    "your stone professionally removed before sending it to CaratForUs. You " +
    "can still continue designing your new setting.",
} as const;

/**
 * The intake question and its three answers (§1 of the owner message).
 *
 * The customer is choosing prong-set or not. Deliberately NOT a technical
 * taxonomy: standard, claw and double-claw prongs are all just "a prong
 * setting" here, and listing bezel/tension/flush/channel as separate options
 * would ask a customer to self-diagnose their jewellery.
 */
export const STONE_MOUNTED_QUESTION = {
  label: "Is your stone currently mounted?",
  answers: {
    LOOSE: "No — my stone is loose",
    MOUNTED_PRONG: "Yes — in a prong setting",
    MOUNTED_UNSUPPORTED: "Yes — in another type of setting",
  },
} as const satisfies { label: string; answers: Record<StoneMountedState, string> };
