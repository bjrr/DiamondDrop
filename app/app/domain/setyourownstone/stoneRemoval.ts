/**
 * The $50 prong-only Stone Removal service (docs/SET-YOUR-OWN-STONE.md §17.3,
 * owner-locked 2026-11-02; mandatory-not-optional correction 2026-11-02).
 *
 * CaratForUs removes a customer's centre stone only from a PRONG setting. That
 * is a liability boundary, not a capability one: a bezel, channel, tension or
 * flush setting has to be opened by whoever is willing to stand behind the
 * result, and we are not, so we decline and say so plainly.
 *
 * THE FEE IS NOT A CHOICE. For a prong-set stone the removal service is
 * REQUIRED. The customer's decision is the answer to "is your stone currently
 * mounted?" — and $50 is the disclosed price consequence of that answer, the
 * same way picking a paid product option changes a price. A customer who would
 * rather not pay us has their stone professionally removed first, which makes
 * their answer LOOSE.
 *
 * So `MOUNTED_PRONG` + no removal is not a state this module can express, and
 * the database refuses to store it. There is no second consent checkbox: the
 * general rule against pre-checked acknowledgments is about consent to terms,
 * not about whether a required service charge must be made optional.
 *
 * WHY THIS MODULE IS SEPARATE FROM MOUNTING PRICING. The mounting price is a
 * computed figure built from supplier cost, markup and labour components that
 * are deliberately never itemised to the customer (§17.5). This is the one
 * approved exception: a flat service charge shown on its own. Keeping it apart
 * means the removal fee can never slip into the mounting formula, and the
 * mounting formula can never be read as containing it — removal belongs to the
 * condition of the customer's stone, not to the ring.
 *
 * FLAT MEANS FLAT. $50 per customer centre stone requiring removal. Not per
 * prong, not scaled by carat weight, stone size, ring value or mounting value.
 * There is one centre stone in an SYOS session, so the charge appears exactly
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
  /** MOUNTED_PRONG — required at the flat fee. Disclosed, not offered. */
  | { readonly kind: "required"; readonly feeMinorUnits: bigint }
  /** MOUNTED_UNSUPPORTED — we decline, and the customer carries on designing. */
  | { readonly kind: "unavailable" };

export function stoneRemovalOfferFor(state: StoneMountedState): StoneRemovalOffer {
  switch (state) {
    case "LOOSE":
      return { kind: "not_needed" };
    case "MOUNTED_PRONG":
      return { kind: "required", feeMinorUnits: STONE_REMOVAL_FEE_MINOR_UNITS };
    case "MOUNTED_UNSUPPORTED":
      return { kind: "unavailable" };
  }
}

/**
 * Whether this order must include the removal service.
 *
 * THE ONLY INPUT IS THE MOUNTED STATE. Not a customer selection, not a cart
 * flag, not anything a page can post — which is what makes
 * `MOUNTED_PRONG` + declined unrepresentable rather than merely rejected.
 * Operations reads this as "Stone Removal Required = Yes/No".
 */
export function stoneRemovalRequiredFor(state: StoneMountedState): boolean {
  return stoneRemovalOfferFor(state).kind === "required";
}

/**
 * The charge for this session, in minor units.
 *
 * Derived from the stored answer and nothing else, so there is no path by
 * which a prong-set stone reaches checkout at $0 or a loose stone reaches it
 * at $50.
 */
export function stoneRemovalChargeFor(state: StoneMountedState): bigint {
  const offer = stoneRemovalOfferFor(state);
  return offer.kind === "required" ? offer.feeMinorUnits : 0n;
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
 * setting" is the half that stops this being a dead end; the sentence before
 * it is the half that stops a customer posting us a mounted stone we cannot
 * open.
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
 *
 * This is also where the $50 decision is made, which is why the answers are
 * worded as answers rather than as options with prices attached.
 */
export const STONE_MOUNTED_QUESTION = {
  label: "Is your stone currently mounted?",
  answers: {
    LOOSE: "No — my stone is loose",
    MOUNTED_PRONG: "Yes — in a prong setting",
    MOUNTED_UNSUPPORTED: "Yes — in another type of setting",
  },
} as const satisfies { label: string; answers: Record<StoneMountedState, string> };
