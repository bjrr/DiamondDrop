import { describe, expect, it } from "vitest";

import {
  FIRST_ACCESS_INTEREST_TAGS,
  FIRST_ACCESS_TAG,
  mayWriteToCustomer,
  normaliseEmail,
  normaliseName,
  normalisePhone,
  planCustomerWrite,
  selectedInterestTags,
  type ExistingCustomerFacts,
  type SubmittedSignup,
} from "./phoneCapture";

/**
 * The pure half of First Access phone capture.
 *
 * The interesting cases here are the destructive ones. A bug in
 * `planCustomerWrite` does not produce a wrong answer on screen — it quietly
 * erases a customer's phone number or strips the tags operations rely on, and
 * nobody finds out until someone goes looking for a segment that is suddenly
 * empty. Those paths get the most tests.
 */

const NOBODY: ExistingCustomerFacts = {
  firstName: null,
  lastName: null,
  phone: null,
  tags: [FIRST_ACCESS_TAG],
};

function signup(overrides: Partial<SubmittedSignup> = {}): SubmittedSignup {
  return {
    firstName: "Ada",
    lastName: "Lovelace",
    phoneE164: "+12125550147",
    interests: [],
    ...overrides,
  };
}

describe("normalisePhone", () => {
  it("accepts a bare 10-digit US number and gives it a country code", () => {
    expect(normalisePhone("2125550147")).toEqual({ ok: true, e164: "+12125550147" });
  });

  it("strips the punctuation a person actually types", () => {
    for (const typed of ["(212) 555-0147", "212.555.0147", "212 555 0147", "212-555-0147"]) {
      expect(normalisePhone(typed)).toEqual({ ok: true, e164: "+12125550147" });
    }
  });

  it("treats a leading 1 as the country code rather than an eleventh digit", () => {
    expect(normalisePhone("1 (212) 555-0147")).toEqual({ ok: true, e164: "+12125550147" });
  });

  it("keeps an international number as given", () => {
    expect(normalisePhone("+44 20 7946 0958")).toEqual({ ok: true, e164: "+442079460958" });
  });

  it("reports an empty field as empty, not as invalid", () => {
    // The caller treats these differently: empty is the optional field being
    // skipped, invalid is worth a log line.
    expect(normalisePhone("")).toEqual({ ok: false, reason: "empty" });
    expect(normalisePhone("   ")).toEqual({ ok: false, reason: "empty" });
  });

  it("refuses a bare 11+ digit number rather than guessing a country", () => {
    // 442079460958 without a plus. Prefixing +1 would invent a US number.
    expect(normalisePhone("442079460958")).toEqual({ ok: false, reason: "ambiguous_country" });
  });

  it("refuses a short number instead of padding it", () => {
    expect(normalisePhone("555-0147")).toEqual({ ok: false, reason: "too_short" });
    expect(normalisePhone("+1234")).toEqual({ ok: false, reason: "too_short" });
  });

  it("refuses more digits than E.164 allows", () => {
    expect(normalisePhone("+1234567890123456")).toEqual({ ok: false, reason: "too_long" });
  });

  it("refuses an extension rather than welding it onto the number", () => {
    // THE DANGEROUS ONE. Stripping separators would turn this into
    // +121255501474 — a different, real, dialable number.
    expect(normalisePhone("212-555-0147 x4")).toEqual({ ok: false, reason: "not_a_number" });
    expect(normalisePhone("212-555-0147 ext. 4")).toEqual({ ok: false, reason: "not_a_number" });
  });

  it("refuses letters anywhere", () => {
    expect(normalisePhone("call me")).toEqual({ ok: false, reason: "not_a_number" });
    expect(normalisePhone("1-800-FLOWERS")).toEqual({ ok: false, reason: "not_a_number" });
  });
});

describe("normaliseEmail", () => {
  it("lowercases and trims, so one address has one spelling", () => {
    expect(normaliseEmail("  Ada@Example.COM ")).toBe("ada@example.com");
  });

  it("rejects shapes that cannot identify a customer", () => {
    for (const bad of ["", "ada", "ada@", "@example.com", "ada@example", "a b@example.com"]) {
      expect(normaliseEmail(bad)).toBeNull();
    }
  });

  it("rejects an address longer than RFC 5321 allows", () => {
    expect(normaliseEmail("a".repeat(250) + "@example.com")).toBeNull();
  });
});

describe("normaliseName", () => {
  it("collapses whitespace and trims", () => {
    expect(normaliseName("  Mary   Anne  ")).toBe("Mary Anne");
  });

  it("removes control characters rather than rejecting the name", () => {
    const pasted = "Ada" + String.fromCharCode(9) + String.fromCharCode(0) + "Lovelace";
    expect(normaliseName(pasted)).toBe("Ada Lovelace");
  });

  it("returns null for nothing, so the caller omits the field", () => {
    expect(normaliseName("")).toBeNull();
    expect(normaliseName("   ")).toBeNull();
    expect(normaliseName(String.fromCharCode(0))).toBeNull();
  });

  it("truncates rather than refusing an absurd length", () => {
    expect(normaliseName("x".repeat(500))).toHaveLength(80);
  });
});

describe("selectedInterestTags", () => {
  it("keeps only tags from the allowlist", () => {
    expect(selectedInterestTags(["loose-diamonds", "vip", "wholesale", "group-buys"])).toEqual([
      "loose-diamonds",
      "group-buys",
    ]);
  });

  it("cannot be used to mint a tag that does not exist", () => {
    expect(selectedInterestTags(["free-shipping", "staff-discount"])).toEqual([]);
  });

  it("deduplicates and returns a stable order regardless of input order", () => {
    expect(
      selectedInterestTags(["custom-jewelry", "loose-diamonds", "loose-diamonds"])
    ).toEqual(["loose-diamonds", "custom-jewelry"]);
  });

  it("covers every chip the form renders", () => {
    expect(selectedInterestTags([...FIRST_ACCESS_INTEREST_TAGS])).toEqual([
      ...FIRST_ACCESS_INTEREST_TAGS,
    ]);
  });
});

describe("planCustomerWrite — the destructive cases", () => {
  it("OMITS phone entirely when none was submitted, so it cannot be cleared", () => {
    const plan = planCustomerWrite(
      { ...NOBODY, phone: "+12125550147" },
      signup({ phoneE164: null })
    );
    expect("phone" in plan.fields).toBe(false);
  });

  it("OMITS a name when none was submitted", () => {
    const plan = planCustomerWrite(
      { ...NOBODY, firstName: "Ada", lastName: "Lovelace" },
      signup({ firstName: null, lastName: null })
    );
    expect("firstName" in plan.fields).toBe(false);
    expect("lastName" in plan.fields).toBe(false);
  });

  it("never returns a tag list that could replace the existing one", () => {
    // `tagsToAdd` holds ONLY new tags. If it ever contained the full set, a
    // caller passing it to CustomerInput.tags would be lossless by accident
    // and lossy the moment a tag it does not know about appears.
    const plan = planCustomerWrite(
      { ...NOBODY, tags: [FIRST_ACCESS_TAG, "vip", "wholesale"] },
      signup({ interests: ["luxury-steals"] })
    );
    expect(plan.tagsToAdd).toEqual(["luxury-steals"]);
    expect(plan.tagsToAdd).not.toContain("vip");
    expect(plan.tagsToAdd).not.toContain("wholesale");
  });
});

describe("planCustomerWrite — idempotence", () => {
  it("is a no-op when everything already matches", () => {
    const existing: ExistingCustomerFacts = {
      firstName: "Ada",
      lastName: "Lovelace",
      phone: "+12125550147",
      tags: [FIRST_ACCESS_TAG, "loose-diamonds"],
    };
    const plan = planCustomerWrite(existing, signup({ interests: ["loose-diamonds"] }));
    expect(plan.isNoop).toBe(true);
    expect(plan.fields).toEqual({});
    expect(plan.tagsToAdd).toEqual([]);
  });

  it("matches tags case-insensitively, as Shopify does", () => {
    const plan = planCustomerWrite(
      { ...NOBODY, tags: ["First-Access", "Loose-Diamonds"] },
      signup({ firstName: null, lastName: null, phoneE164: null, interests: ["loose-diamonds"] })
    );
    expect(plan.tagsToAdd).toEqual([]);
  });

  it("writes a changed phone and leaves the rest alone", () => {
    const existing: ExistingCustomerFacts = {
      firstName: "Ada",
      lastName: "Lovelace",
      phone: null,
      tags: [FIRST_ACCESS_TAG],
    };
    const plan = planCustomerWrite(existing, signup());
    expect(plan.fields).toEqual({ phone: "+12125550147" });
    expect(plan.isNoop).toBe(false);
  });

  it("adds the base tag when the record somehow lacks it", () => {
    const plan = planCustomerWrite(
      { ...NOBODY, tags: ["vip", FIRST_ACCESS_TAG] },
      signup({ interests: ["group-buys"] })
    );
    expect(plan.tagsToAdd).toEqual(["group-buys"]);
  });
});

describe("mayWriteToCustomer — the blast-radius gate", () => {
  it("refuses a customer who never signed up for First Access", () => {
    // The whole point: knowing a paying customer's email must not be enough
    // to rewrite their name and phone through a public endpoint.
    expect(mayWriteToCustomer({ ...NOBODY, tags: ["vip", "wholesale"] })).toBe(false);
    expect(mayWriteToCustomer({ ...NOBODY, tags: [] })).toBe(false);
  });

  it("allows a First Access signup, whatever the tag's casing", () => {
    expect(mayWriteToCustomer({ ...NOBODY, tags: ["First-Access"] })).toBe(true);
    expect(mayWriteToCustomer({ ...NOBODY, tags: ["vip", " first-access "] })).toBe(true);
  });

  it("is not satisfied by a tag that merely contains the word", () => {
    expect(mayWriteToCustomer({ ...NOBODY, tags: ["first-access-declined"] })).toBe(false);
  });
});
