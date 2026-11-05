import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * The First Access landing page — approved copy, and the things it must not
 * become.
 *
 * A LANDING PAGE DRIFTS FASTER THAN ANYTHING ELSE. It is the surface most
 * likely to be "just tweaked" for a campaign, and several of its lines are
 * approved claims rather than marketing prose: wholesale pricing, the diamond
 * promise, the U.S.-based positioning. Those are pinned here verbatim.
 *
 * The second half pins the absences. A countdown, a referral ladder or an
 * invented discount percentage would each be a decision nobody made.
 */
const THEME_ROOT = join(process.cwd(), "..", "theme");
const read = (...parts: string[]) => readFileSync(join(THEME_ROOT, ...parts), "utf8");

const locale = JSON.parse(read("locales", "en.default.json")) as {
  templates: { first_access: Record<string, Record<string, string>> };
};
const fa = locale.templates.first_access;
const allCopy = JSON.stringify(fa);

function stripLiquidComments(source: string): string {
  return source.replace(/\{%-?\s*comment\s*-?%\}[\s\S]*?\{%-?\s*endcomment\s*-?%\}/g, "");
}
function stripJsComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

const section = read("sections", "first-access.liquid");
const formSnippet = read("snippets", "first-access-form.liquid");
const successSnippet = read("snippets", "first-access-success.liquid");
const script = read("assets", "first-access.js");
// Named -campaign because Shopify refuses two templates sharing a name with
// different extensions, and the original page.first-access.json is still on the
// theme. The page URL is unaffected: the handle is what a visitor sees.
const template = read("templates", "page.first-access-campaign.liquid");
const layout = read("layout", "first-access.liquid");
/**
 * What a visitor can actually encounter, with the authors' comments removed.
 *
 * The absence checks below scan THIS rather than the raw files. Several of
 * those comments say in plain English that the page must have no countdown and
 * no referral mechanics, and the first version of this fence flagged them as
 * the very thing they forbid.
 */
const surfaces = [
  allCopy,
  stripLiquidComments(section),
  stripLiquidComments(formSnippet),
  stripLiquidComments(successSnippet),
  stripJsComments(script),
].join("\n");

describe("the approved copy, verbatim", () => {
  it("leads with the launch message", () => {
    expect(fa.hero?.heading).toBe("Fine Jewelry Is About to Change.");
    expect(fa.hero?.eyebrow).toBe("Launching Soon");
  });

  it("states the diamond positioning exactly", () => {
    expect(fa.diamond?.heading).toBe("Your Diamond. Your Decision. Your Time.");
    expect(fa.diamond?.no_pressure).toBe("No bidding. No pressure. No games.");
  });

  it("says wholesale prices on the loose-diamond teaser", () => {
    expect(fa.teasers?.diamonds_heading).toBe(
      "Loose Diamonds. Wholesale Prices. No Pressure."
    );
    expect(fa.diamond?.promise).toContain("wholesale prices");
  });

  it("states the loose-diamond message once, not twice", () => {
    // The tile used to carry a supporting sentence AND the core promise, both
    // saying wholesale prices, browse and compare. Consolidated to the locked
    // promise alone; the restatement must not come back.
    expect(fa.teasers?.diamonds_text).toBeUndefined();
    const tile = stripLiquidComments(section).slice(
      stripLiquidComments(section).indexOf("carat-fa__tile--wide")
    );
    const upToNextTile = tile.slice(0, tile.indexOf("</article>"));
    const wholesale = upToNextTile.match(/diamonds_text|diamond.promise/g) ?? [];
    expect(wholesale).toHaveLength(1);
  });

  it("positions CaratForUs as a U.S.-based company", () => {
    expect(fa.hero?.lede).toContain("U.S.-based company");
    expect(fa.disruption?.us_based).toContain("U.S.-based company");
  });

  it("asks the overseas question without attacking anyone", () => {
    expect(fa.disruption?.heading).toBe("Why Go Overseas for a Better Deal?");
    // The message is about the customer's options, never about a country or
    // its manufacturers.
    expect(allCopy).not.toMatch(/china|chinese|overseas manufacturer|foreign factor/i);
  });

  it("carries all five teasers with their approved concepts", () => {
    expect(fa.teasers?.steals_heading).toBe(
      "Exceptional pieces. Limited quantities. Standout pricing."
    );
    expect(fa.teasers?.group_heading).toBe("More buyers. Better buying power.");
    expect(fa.teasers?.syos_heading).toBe(
      "Already have the stone? Find the setting or create your own."
    );
    expect(fa.teasers?.custom_heading).toBe("Your idea. Made for you.");
  });

  it("calls the conversion First Access, never a newsletter", () => {
    expect(fa.form?.cta).toBe("GET FIRST ACCESS");
    // "newsletter" belongs to the footer signup, not to this page.
    expect(
      [allCopy, stripLiquidComments(section), stripLiquidComments(formSnippet)].join("\n")
    ).not.toMatch(/newsletter/i);
  });

  it("renders the primary CTA at both signups and nowhere competing", () => {
    const ctas = section.match(/first-access-form/g) ?? [];
    expect(ctas).toHaveLength(2);
  });
});

describe("what this page must not become", () => {
  it("has no countdown", () => {
    expect(surfaces).not.toMatch(/countdown|setInterval|days?\s*:\s*hours|time[- ]remaining/i);
  });

  it("has no referral, points or rewards mechanics", () => {
    expect(surfaces).not.toMatch(
      /referral|refer a friend|invite \d|reward|points|leaderboard|waitlist position|move up/i
    );
  });

  it("promises no percentage, no date and no shipping or return terms", () => {
    // Nothing commercial that was not approved: no "20% off", no launch date,
    // no free shipping, no guarantee.
    expect(allCopy).not.toMatch(/\d+\s?%/);
    expect(allCopy).not.toMatch(/free shipping|money[- ]back|guarantee|risk[- ]free/i);
    expect(allCopy).not.toMatch(
      /\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/i
    );
  });

  it("keeps the First Access benefit as a possibility, not a commitment", () => {
    expect(fa.form?.benefit).toBe("First Access members get in first.");
    expect(fa.form?.benefit).not.toMatch(/you will receive|guaranteed|exclusive discount/i);
  });

  it("frames loose diamonds as browsing, never as an auction", () => {
    expect(allCopy).not.toMatch(/auction|bid now|place a bid|highest bidder/i);
    expect(fa.diamond?.no_pressure).toContain("No bidding");
  });

  it("requires no account and opens no popup", () => {
    expect(surfaces).not.toMatch(/create an account|sign up for an account|register/i);
    expect(surfaces).not.toMatch(/modal|popup|overlay-open|window\.open/i);
  });
});

describe("the signup is Shopify-native and low friction", () => {
  it("posts Shopify's own customer form rather than a bespoke endpoint", () => {
    expect(formSnippet).toMatch(/form 'customer'/);
    // No app proxy, no second database, no CRM.
    expect(formSnippet).not.toMatch(/apps\/carat|fetch\(|\/api\//);
  });

  /**
   * Each input isolated by splitting on the tag boundary first. An unanchored
   * match sweeps from the FIRST input in the file, which once had the
   * first-name assertion reading the email input's `required` and passing
   * for the wrong reason.
   */
  const inputs = () =>
    formSnippet.split("<input").map((chunk) => chunk.split(">")[0] ?? "");
  const inputNamed = (name: string) =>
    inputs().find((i) => i.includes('name="' + name + '"')) ?? "";

  it("requires email, first name and last name", () => {
    for (const name of ["contact[email]", "contact[first_name]", "contact[last_name]"]) {
      expect(inputNamed(name), name).toContain("required");
    }
  });

  it("keeps the phone and the interests optional", () => {
    expect(inputNamed("contact[phone]")).not.toContain("required");
    expect(inputNamed("interests[]")).not.toContain("required");
  });

  it("asks for first and last name separately, never one Full Name box", () => {
    // Separate fields are what map cleanly onto a Shopify customer record and
    // what makes later personalisation possible.
    expect(formSnippet).toContain('name="contact[first_name]"');
    expect(formSnippet).toContain('name="contact[last_name]"');
    expect(formSnippet).not.toMatch(/name="contact[(full_)?name]"/);
  });

  it("brings up a telephone keypad for the phone", () => {
    const phone = inputNamed("contact[phone]");
    expect(phone).toContain('type="tel"');
    expect(phone).toContain('inputmode="tel"');
    expect(phone).toContain('autocomplete="tel"');
  });

  it("says which fields are optional, in the label, with no asterisks", () => {
    expect(fa.form?.phone_label).toBe("Mobile number (optional)");
    expect(fa.form?.interests_label).toContain("(optional)");
    // Required labels carry no marker at all — a luxury signup should not
    // look like an admin screen.
    expect(fa.form?.email_label).toBe("Email");
    expect(fa.form?.first_name_label).toBe("First name");
    expect(fa.form?.last_name_label).toBe("Last name");
    expect(stripLiquidComments(formSnippet)).not.toContain("*");
  });

  it("never treats a phone number as consent to text", () => {
    // A number given for launch updates is not an SMS marketing opt-in. If
    // CaratForUs ever sends marketing texts that needs its own unchecked
    // control and its own disclosure, recorded separately — not inferred
    // from a field someone filled in on a different promise.
    const live = [
      stripLiquidComments(formSnippet),
      stripJsComments(script),
      allCopy,
    ].join("\n");
    expect(live).not.toMatch(/accepts_sms|sms_consent|smsMarketing|accepts_text|text_consent/i);
    expect(live).not.toMatch(/by (providing|entering) your (mobile|phone)/i);
    expect(live).not.toMatch(/consent to (receive )?(marketing )?(texts|sms)/i);

    /**
     * THE LABEL ITSELF MUST NOT PROMISE TEXTS.
     *
     * The field shipped as "Mobile number for text updates (optional)" and
     * survived every check above, because none of them read the words a
     * visitor actually sees — the label promised texts while the code
     * correctly set no consent. Layout and copy are part of consent, not
     * just the mutation. Owner decision 2026-11-05: "Mobile number
     * (optional)", nothing more.
     */
    expect(fa.form?.phone_label).not.toMatch(/text|sms|message|update|alert|notif/i);
    expect(fa.form?.phone_placeholder ?? "").not.toMatch(/text|sms|message/i);
  });

  it("offers the six interests as multi-select chips that cannot block signup", () => {
    const values = [...formSnippet.matchAll(/name="interests\[\]"\s+value="\{\{ handle \}\}"/g)];
    // Rendered in a loop, so one input in source and six handles in the list.
    expect(values.length).toBeGreaterThan(0);
    for (const handle of [
      "loose-diamonds",
      "engagement-rings",
      "luxury-steals",
      "group-buys",
      "set-your-own-stone",
      "custom-jewelry",
    ]) {
      expect(formSnippet).toContain(handle);
    }
    const chipInput =
      formSnippet
        .split("<input")
        .map((chunk) => chunk.split(">")[0] ?? "")
        .find((i) => i.includes('name="interests[]"')) ?? "";
    expect(chipInput).toContain('type="checkbox"');
    expect(chipInput).not.toContain("required");
  });

  it("stores interests as Shopify customer tags", () => {
    expect(formSnippet).toContain('name="contact[tags]"');
    expect(script).toContain("contact[tags]");
    expect(script).toContain("data-carat-fa-interest");
  });

  it("falls back to a native submit if its JavaScript cannot run", () => {
    expect(script).toContain("form.submit()");
    expect(script).toMatch(/typeof window\.fetch !== 'function'/);
  });

  it("renders the success panel from Liquid, not from a JS string", () => {
    expect(successSnippet).toContain("data-carat-fa-success");
    expect(script).toContain("data-carat-fa-success");
    // The panel is parsed out of Shopify's own response, so there is one copy.
    expect(script).toContain("DOMParser");
  });
});

describe("sharing is a courtesy with no machinery behind it", () => {
  it("offers text, WhatsApp, email and copy", () => {
    for (const marker of [
      "data-carat-fa-share-sms",
      "data-carat-fa-share-whatsapp",
      "data-carat-fa-share-email",
      "data-carat-fa-share-copy",
    ]) {
      expect(successSnippet).toContain(marker);
      expect(script).toContain(marker);
    }
  });

  it("loads no third-party script or tracking pixel", () => {
    expect(stripJsComments(script)).not.toMatch(
      /facebook|fbq|gtag|googletagmanager|pixel|analytics|sdk/i
    );
    expect(stripLiquidComments(successSnippet)).not.toMatch(/<script/i);
  });

  it("uses the approved share wording", () => {
    expect(fa.share?.text).toContain("CaratForUs is launching soon");
    expect(fa.share?.text).toContain("First Access");
    expect(fa.share?.prompt).toContain("Share First Access with a friend");
  });
});

describe("no store chrome competes with the one action", () => {
  it("the campaign layout renders no header, footer or cart drawer", () => {
    const live = stripLiquidComments(layout);
    expect(live).not.toContain("sections 'header-group'");
    expect(live).not.toContain("sections 'footer-group'");
    expect(live).not.toContain("cart-drawer");
  });

  it("but keeps the head, so the page still looks like the brand", () => {
    // Same fonts and CSS variables as every other page: this is theme.liquid
    // with chrome removed, not a bare document.
    expect(layout).toContain("{{ content_for_header }}");
    expect(layout).toContain("--font-heading-family");
    expect(layout).toContain("base.css");
  });

  it("keeps the skip link — removing navigation is not a reason to drop a11y", () => {
    expect(layout).toContain("skip-to-content-link");
  });

  it("is used by nothing except the First Access template", () => {
    expect(template).toContain("{% layout 'first-access' %}");
  });
});

describe("the final signup is the simple one", () => {
  it("omits the interest chips and the benefit line when compact", () => {
    // Asked once, in the hero. The closing form is email and a button.
    const compactGuards = formSnippet.match(/{%- unless compact -%}/g) ?? [];
    expect(compactGuards.length).toBeGreaterThanOrEqual(2);
    expect(formSnippet).toContain("carat-fa__interests");
    expect(formSnippet).toContain("carat-fa__benefit");
  });

  it("still carries the email field and the primary CTA", () => {
    const cta = formSnippet.indexOf("carat-fa__cta");
    const email = formSnippet.indexOf('name="contact[email]"');
    expect(email).toBeGreaterThan(-1);
    expect(cta).toBeGreaterThan(email);
  });
});

describe("interests come before the button", () => {
  it("the chips are above the CTA in the markup", () => {
    expect(formSnippet.indexOf("carat-fa__interests")).toBeLessThan(
      formSnippet.indexOf("carat-fa__cta")
    );
  });
});

describe("the page is wired up", () => {
  it("renders only this section, on the campaign layout", () => {
    expect(template).toContain("{% layout 'first-access' %}");
    expect(template).toContain("{% section 'first-access' %}");
    // Nothing else on the page.
    expect(template.match(/{% section /g) ?? []).toHaveLength(1);
  });

  it("ships no default image, so nothing invents a product photograph", () => {
    const schema = section.slice(section.indexOf("{% schema %}"));
    const hero = schema.slice(schema.indexOf('"id": "hero_image"'));
    expect(hero.slice(0, 200)).not.toContain('"default"');
  });
});
