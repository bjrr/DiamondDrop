import { describe, expect, it } from "vitest";

import {
  FIRST_ACCESS_MOBILE_METAFIELD,
  FIRST_ACCESS_TAG,
  mayWriteToCustomer,
  normaliseEmail,
  normalisePhone,
} from "./phoneCapture";

/**
 * The pure half of First Access mobile capture.
 *
 * Small on purpose. The earlier `Customer.phone` implementation needed a
 * field-merge planner to avoid blanking names and replacing tag sets; storing
 * one text metafield needs none of that, so those tests are deleted rather
 * than kept passing against code nobody calls.
 *
 * What remains is the stuff that is still genuinely risky: turning whatever a
 * visitor types into a number that belongs to THEM, and the gate that decides
 * whose record a public endpoint may touch.
 */

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
    // The route treats these differently: empty is the optional field being
    // skipped and is not even logged; invalid is worth a log line.
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
    // +121255501474 — a different, real, dialable number. The metafield is
    // free text, so nothing downstream would ever catch it.
    expect(normalisePhone("212-555-0147 x4")).toEqual({ ok: false, reason: "not_a_number" });
    expect(normalisePhone("212-555-0147 ext. 4")).toEqual({ ok: false, reason: "not_a_number" });
  });

  it("refuses letters anywhere", () => {
    expect(normalisePhone("call me")).toEqual({ ok: false, reason: "not_a_number" });
    expect(normalisePhone("1-800-FLOWERS")).toEqual({ ok: false, reason: "not_a_number" });
  });

  it("never returns a value that is not E.164", () => {
    const inputs = [
      "2125550147", "(212) 555-0147", "+44 20 7946 0958", "1 212 555 0147",
      "", "  ", "abc", "212-555-0147 x4", "12345", "442079460958",
    ];
    for (const input of inputs) {
      const result = normalisePhone(input);
      if (result.ok) expect(result.e164).toMatch(/^\+[1-9]\d{7,14}$/);
    }
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

describe("mayWriteToCustomer — the blast-radius gate", () => {
  it("refuses a customer who never signed up for First Access", () => {
    // The whole point: knowing a paying customer's email must not be enough
    // to attach a mobile number to their record through a public endpoint.
    expect(mayWriteToCustomer(["vip", "wholesale"])).toBe(false);
    expect(mayWriteToCustomer([])).toBe(false);
  });

  it("allows a First Access signup, whatever the tag's casing or padding", () => {
    expect(mayWriteToCustomer(["First-Access"])).toBe(true);
    expect(mayWriteToCustomer(["vip", " first-access "])).toBe(true);
  });

  it("is not satisfied by a tag that merely contains the word", () => {
    expect(mayWriteToCustomer(["first-access-declined"])).toBe(false);
    expect(mayWriteToCustomer(["pre-first-access"])).toBe(false);
  });
});

describe("the metafield address is the one the definition was created at", () => {
  it("is custom.first_access_mobile, single_line_text_field", () => {
    // Pinned against the definition created in Shopify admin
    // (gid://shopify/MetafieldDefinition/564165083354). A drift here writes
    // values into an undefined metafield, which still "works" but is
    // invisible in the admin UI — a silent failure.
    expect(FIRST_ACCESS_MOBILE_METAFIELD).toEqual({
      namespace: "custom",
      key: "first_access_mobile",
      type: "single_line_text_field",
    });
  });

  it("keeps the tag the native form applies", () => {
    expect(FIRST_ACCESS_TAG).toBe("first-access");
  });
});
