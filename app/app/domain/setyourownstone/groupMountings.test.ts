/**
 * Collapsing variant matches into mounting cards.
 *
 * The headline case is the pilot: a 9 x 7 pear matches fifteen variants of
 * one ring — three metals, five ring sizes — and the customer must see ONE
 * card. Everything else here guards the ways that collapsing could go wrong.
 */
import { describe, expect, it } from "vitest";

import { groupMountings, type MatchedVariant, type VariantDisplay } from "./groupMountings";

const PRODUCT = "gid://shopify/Product/15303595393242";
const PROFILE_9X7 = "gid://shopify/Metaobject/665980862682";
const PROFILE_12X8 = "gid://shopify/Metaobject/665980895450";

const METALS = ["14K White Gold", "14K Yellow Gold", "14K Rose Gold"];
const SIZES = ["6", "6.5", "7", "7.5", "8"];

/** The pilot: 3 metals x 5 ring sizes at one centre size. */
function pilot(
  profileId = PROFILE_9X7,
  size = { l: "9", w: "7" },
  status: "automatic" | "review_required" = "automatic"
) {
  const matches: MatchedVariant[] = [];
  const display = new Map<string, VariantDisplay>();
  let n = 0;

  for (const metal of METALS) {
    for (const ringSize of SIZES) {
      n += 1;
      const variantGid = `gid://shopify/ProductVariant/${profileId.slice(-4)}${n}`;
      matches.push({
        variantGid,
        status,
        label: status === "automatic" ? "Matches your stone size" : "May work — review required",
        centerSizeProfileId: profileId,
        nominalLengthMm: size.l,
        nominalWidthMm: size.w,
      });
      display.set(variantGid, {
        variantGid,
        productGid: PRODUCT,
        productTitle: "14K Pear Solitaire — Ultra Light Tulip Mounting",
        productHandle: "14k-pear-solitaire-ultra-light-tulip-mounting",
        featuredImageUrl: "https://cdn.shopify.com/pilot.jpg",
        // Deliberately varied so the "from" price is a real minimum.
        price: ringSize === "6" ? "880.00" : "930.00",
        currencyCode: "USD",
        availableForSale: true,
        selections: {
          "Center Stone Size": `${size.l}x${size.w} mm`,
          Metal: metal,
          "Ring Size": ringSize,
        },
      });
    }
  }
  return { matches, display };
}

describe("the pilot: fifteen variants become one card", () => {
  const { matches, display } = pilot();
  const cards = groupMountings(matches, display);

  it("produces exactly one card, not fifteen", () => {
    expect(matches).toHaveLength(15);
    expect(cards).toHaveLength(1);
  });

  it("carries the product identity a customer recognises", () => {
    expect(cards[0]?.productTitle).toBe("14K Pear Solitaire — Ultra Light Tulip Mounting");
    expect(cards[0]?.featuredImageUrl).toBe("https://cdn.shopify.com/pilot.jpg");
    expect(cards[0]?.productHandle).toBeTruthy();
  });

  it("shows the matched centre size as information", () => {
    expect(cards[0]?.matchedCenterSize).toBe("9 × 7 mm");
  });

  it("offers metal and ring size, and NOT centre size", () => {
    // Centre size was decided by measuring the stone. Offering it back would
    // invite the customer to get it wrong.
    const names = cards[0]!.options.map((o) => o.name);
    expect(names).toEqual(["Metal", "Ring Size"]);
    expect(names).not.toContain("Center Stone Size");
  });

  it("lists each option value once, in Shopify's order", () => {
    expect(cards[0]?.options[0]?.values).toEqual(METALS);
    expect(cards[0]?.options[1]?.values).toEqual(SIZES);
  });

  it("keeps every real variant so a choice resolves to Shopify", () => {
    expect(cards[0]?.variants).toHaveLength(15);
    for (const v of cards[0]!.variants) {
      expect(v.variantGid).toMatch(/^gid:\/\/shopify\/ProductVariant\//);
    }
  });

  it("reports the lowest price as the from figure, unreformatted", () => {
    expect(cards[0]?.priceFrom).toBe("880.00");
    expect(cards[0]?.currencyCode).toBe("USD");
  });

  it("a metal and ring size pick out exactly one variant", () => {
    const hit = cards[0]!.variants.filter(
      (v) => v.selections.Metal === "14K Yellow Gold" && v.selections["Ring Size"] === "6.5"
    );
    expect(hit).toHaveLength(1);
  });
});

describe("one mounting matched at two centre sizes stays two cards", () => {
  // Grouping by product alone would merge these and lose which size was
  // matched — the customer would not know what they were buying.
  const a = pilot(PROFILE_9X7, { l: "9", w: "7" });
  const b = pilot(PROFILE_12X8, { l: "12", w: "8" });
  const cards = groupMountings(
    [...a.matches, ...b.matches],
    new Map([...a.display, ...b.display])
  );

  it("keeps them separate", () => {
    expect(cards).toHaveLength(2);
  });

  it("labels each with its own matched size", () => {
    expect(cards.map((c) => c.matchedCenterSize).sort()).toEqual(["12 × 8 mm", "9 × 7 mm"]);
  });

  it("gives each its own profile id", () => {
    expect(new Set(cards.map((c) => c.centerSizeProfileId)).size).toBe(2);
  });
});

describe("review required", () => {
  const { matches, display } = pilot(PROFILE_9X7, { l: "9", w: "7" }, "review_required");
  const cards = groupMountings(matches, display);

  it("still collapses to one card", () => {
    expect(cards).toHaveLength(1);
  });

  it("is never presented as approved", () => {
    expect(cards[0]?.status).toBe("review_required");
    expect(cards[0]?.label).toBe("May work — review required");
    expect(cards[0]?.label).not.toMatch(/matches your stone size/i);
  });

  it("the WEAKER verdict wins if a group somehow disagrees", () => {
    // Overstating what we know about someone's stone is the expensive
    // direction to be wrong in.
    const mixed = matches.map((m, i) =>
      i === 0 ? { ...m, status: "automatic" as const, label: "Matches your stone size" } : m
    );
    const out = groupMountings(mixed, display);
    expect(out[0]?.status).toBe("review_required");
    expect(out[0]?.label).toBe("May work — review required");
  });
});

describe("ordering and edge cases", () => {
  it("puts automatic matches before review-required ones", () => {
    const auto = pilot(PROFILE_9X7, { l: "9", w: "7" }, "automatic");
    const rev = pilot(PROFILE_12X8, { l: "12", w: "8" }, "review_required");
    const cards = groupMountings(
      [...rev.matches, ...auto.matches],
      new Map([...rev.display, ...auto.display])
    );
    expect(cards[0]?.status).toBe("automatic");
    expect(cards[1]?.status).toBe("review_required");
  });

  it("drops a match with no display data rather than rendering a blank card", () => {
    const { matches, display } = pilot();
    display.delete(matches[0]!.variantGid);
    const cards = groupMountings(matches, display);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.variants).toHaveLength(14);
  });

  it("returns nothing when nothing matched", () => {
    expect(groupMountings([], new Map())).toEqual([]);
  });

  it("returns nothing when no match has display data", () => {
    const { matches } = pilot();
    expect(groupMountings(matches, new Map())).toEqual([]);
  });

  it("tolerates a sold-out variant without hiding the mounting", () => {
    const { matches, display } = pilot();
    const first = matches[0]!.variantGid;
    display.set(first, { ...display.get(first)!, availableForSale: false });
    const cards = groupMountings(matches, display);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.variants.find((v) => v.variantGid === first)?.availableForSale).toBe(false);
  });

  it("recognises the centre-size option however it is capitalised or spaced", () => {
    const { matches, display } = pilot();
    for (const [k, d] of display) {
      const { "Center Stone Size": size, ...rest } = d.selections;
      display.set(k, { ...d, selections: { "  center stone  size ": size!, ...rest } });
    }
    const names = groupMountings(matches, display)[0]!.options.map((o) => o.name);
    expect(names).toEqual(["Metal", "Ring Size"]);
  });
});

describe("nothing internal leaks into the card", () => {
  it("exposes no compatibility rule or micrometre value", () => {
    const { matches, display } = pilot();
    const json = JSON.stringify(groupMountings(matches, display));
    expect(json).not.toMatch(/prong_set_tolerance|review_band|exact_nominal|outside_all_rules/);
    expect(json).not.toMatch(/Um"|micrometre/);
    expect(json).not.toMatch(/syncProblems|eligibleForSetYourOwnStone/);
  });
});

describe("option values follow Shopify's order, not variant return order", () => {
  // Without this the card listed ring sizes as "6.5, 6, 7, 7.5, 8" on the
  // live pilot — the order variants happened to come back in. A customer
  // reads that as a bug. Sorting numerically would be a guess that breaks on
  // "6 1/2" or on metals, so Shopify's own order is authoritative.
  function withOrder() {
    const { matches, display } = pilot();
    for (const [k, d] of display) {
      display.set(k, {
        ...d,
        optionOrder: {
          Metal: METALS,
          "Ring Size": ["6", "6.5", "7", "7.5", "8"],
        },
      });
    }
    return { matches, display };
  }

  it("renders ring sizes in ascending order", () => {
    const { matches, display } = withOrder();
    const cards = groupMountings(matches, display);
    expect(cards[0]?.options[1]?.values).toEqual(["6", "6.5", "7", "7.5", "8"]);
  });

  it("keeps metals in the merchant's chosen order", () => {
    const { matches, display } = withOrder();
    expect(groupMountings(matches, display)[0]?.options[0]?.values).toEqual(METALS);
  });

  it("lists only the values that actually matched", () => {
    // A mounting may offer sizes this stone cannot use; the card must not
    // advertise them.
    const { matches, display } = withOrder();
    for (const [k, d] of display) {
      display.set(k, {
        ...d,
        optionOrder: { ...d.optionOrder, "Ring Size": ["4", "5", "6", "6.5", "7", "7.5", "8", "9"] },
      });
    }
    // 4, 5 and 9 exist on the mounting but did not match; they must not appear.
    expect(groupMountings(matches, display)[0]?.options[1]?.values).toEqual([
      "6",
      "6.5",
      "7",
      "7.5",
      "8",
    ]);
  });

  it("falls back to first-seen order when Shopify's order is absent", () => {
    const { matches, display } = pilot();
    const cards = groupMountings(matches, display);
    expect(cards[0]?.options[1]?.values.length).toBe(5);
  });
});

describe("the card carries both prices and the transformed SKU (owner §3/§4)", () => {
  function priced() {
    const { matches, display } = pilot();
    let n = 0;
    for (const [k, d] of display) {
      n += 1;
      // Deliberately varied so "from" is a real minimum rather than the first.
      const card = n === 1 ? "52000" : "56000";
      const bank = n === 1 ? "49350" : "53350";
      display.set(k, {
        ...d,
        sku: "U-0--0a8 pp-ZJ-6.32J-4VW-4.33fwv--5pp",
        prices: {
          bankPaymentPriceMinorUnits: bank,
          regularCardPriceMinorUnits: card,
          bankPaymentSavingsMinorUnits: String(BigInt(card) - BigInt(bank)),
          currency: "USD",
        },
      });
    }
    return groupMountings(matches, display);
  }

  it("exposes the lowest Regular price with ITS bank figure and saving", () => {
    // Taken as a set, not three independent minima — otherwise the three
    // numbers on the card could belong to different variants.
    const p = priced()[0]!.pricesFrom!;
    expect(p.regularCardPriceMinorUnits).toBe("52000");
    expect(p.bankPaymentPriceMinorUnits).toBe("49350");
    expect(p.bankPaymentSavingsMinorUnits).toBe("2650");
    expect(
      BigInt(p.regularCardPriceMinorUnits) - BigInt(p.bankPaymentPriceMinorUnits)
    ).toBe(BigInt(p.bankPaymentSavingsMinorUnits));
  });

  it("carries prices on every variant so a selection repriced exactly", () => {
    const card = priced()[0]!;
    expect(card.variants).toHaveLength(15);
    for (const v of card.variants) {
      expect(v.prices).not.toBeNull();
      expect(BigInt(v.prices!.regularCardPriceMinorUnits)).toBeGreaterThan(
        BigInt(v.prices!.bankPaymentPriceMinorUnits)
      );
    }
  });

  it("surfaces one CaratForUs SKU for the group", () => {
    expect(priced()[0]?.sku).toBe("U-0--0a8 pp-ZJ-6.32J-4VW-4.33fwv--5pp");
  });

  it("reports no group SKU when the variants disagree", () => {
    const { matches, display } = pilot();
    let n = 0;
    for (const [k, d] of display) {
      n += 1;
      display.set(k, { ...d, sku: n === 1 ? "AAA" : "BBB" });
    }
    expect(groupMountings(matches, display)[0]?.sku).toBeNull();
  });

  it("shows no price rather than a guess when pricing inputs are incomplete", () => {
    const cards = groupMountings(...Object.values(pilot()) as [never, never]);
    expect(cards[0]?.pricesFrom).toBeNull();
    for (const v of cards[0]!.variants) expect(v.prices).toBeNull();
  });

  it("leaks no supplier cost, markup or fee component into the card", () => {
    // §19/§25. The card type has nowhere to put these, and this asserts the
    // shape rather than trusting the intent.
    const json = JSON.stringify(priced());
    expect(json).not.toMatch(/unitCost|supplier|wholesale|markup|1\.75/i);
    expect(json).not.toMatch(/largeStone|bandPave|hiddenHalo|ringSizeAdjustment/i);
    expect(json).not.toMatch(/uplift|tier|vendorSku|vendor_sku/i);
    // Nor the raw George's SKU shape, which starts R- rather than the shifted U-.
    expect(json).not.toMatch(/"R-\d/);
  });
});
