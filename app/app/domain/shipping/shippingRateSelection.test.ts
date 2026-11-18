import { describe, expect, it } from "vitest";

import {
  resolveShippingRateSelection,
  type AvailableShippingRate,
} from "./shippingRateSelection";

/**
 * The three contiguous-48 services, named exactly as
 * `docs/SHIPPING-AND-DELIVERY.md` §5 requires and as the live Shopify delivery
 * profile is configured. The names matter to these tests specifically: two of
 * the three share a suffix, which is the trap an inexact match would fall into.
 */
const STANDARD: AvailableShippingRate = {
  handle: "handle-standard",
  title: "Standard Insured Shipping with Signature",
  priceMinorUnits: 3000n,
  currency: "USD",
};
const EXPRESS: AvailableShippingRate = {
  handle: "handle-express",
  title: "Express Insured Shipping with Signature",
  priceMinorUnits: 5500n,
  currency: "USD",
};
const COMPLIMENTARY: AvailableShippingRate = {
  handle: "handle-complimentary",
  title: "Complimentary Express Insured Shipping with Signature",
  priceMinorUnits: 0n,
  currency: "USD",
};
/** Alaska/Hawaii, where Shopify returns the carrier's own service names. */
const UPS_GROUND: AvailableShippingRate = {
  handle: "handle-ups-ground",
  title: "UPS® Ground",
  priceMinorUnits: 3225n,
  currency: "USD",
};

describe("resolveShippingRateSelection", () => {
  describe("the ordinary case", () => {
    it("resolves the requested service to the authoritative rate, price and handle", () => {
      const result = resolveShippingRateSelection({
        requestedServiceTitle: STANDARD.title,
        availableRates: [STANDARD, EXPRESS],
      });

      expect(result).toEqual({ kind: "resolved", rate: STANDARD });
    });

    it("returns the rate OBJECT, so the caller charges Shopify's price and never the request's", () => {
      // The request carries a title and nothing else. Everything monetary in
      // the result must come from the available-rates list.
      const result = resolveShippingRateSelection({
        requestedServiceTitle: EXPRESS.title,
        availableRates: [STANDARD, EXPRESS],
      });

      expect(result.kind).toBe("resolved");
      if (result.kind !== "resolved") return;
      expect(result.rate.priceMinorUnits).toBe(5500n);
      expect(result.rate.handle).toBe("handle-express");
    });

    it("resolves a carrier-named Alaska/Hawaii service, trademark glyph and all", () => {
      const result = resolveShippingRateSelection({
        requestedServiceTitle: "UPS® Ground",
        availableRates: [UPS_GROUND],
      });

      expect(result).toEqual({ kind: "resolved", rate: UPS_GROUND });
    });
  });

  describe("a genuinely free rate is still a chosen rate", () => {
    it("resolves complimentary Express when the customer selected it", () => {
      const result = resolveShippingRateSelection({
        requestedServiceTitle: COMPLIMENTARY.title,
        availableRates: [COMPLIMENTARY],
      });

      expect(result).toEqual({ kind: "resolved", rate: COMPLIMENTARY });
    });

    it("does NOT hand out the free rate just because it exists in the list", () => {
      // THE MONEY-LOSING SHORTCUT, pinned shut. A "fall back to the cheapest
      // available rate" convenience would silently ship free whenever
      // complimentary Express happened to be offered, regardless of what the
      // customer picked or whether their pick was still valid.
      const result = resolveShippingRateSelection({
        requestedServiceTitle: "Some service that is not offered",
        availableRates: [COMPLIMENTARY, STANDARD],
      });

      expect(result.kind).toBe("service_unavailable");
    });
  });

  describe("refusal, never free shipping", () => {
    it("refuses with no_rates_available when Shopify offered nothing", () => {
      // Undeliverable destination, a delivery-profile gap, or an AK/HI
      // carrier outage. The caller must refuse the checkout.
      const result = resolveShippingRateSelection({
        requestedServiceTitle: STANDARD.title,
        availableRates: [],
      });

      expect(result).toEqual({ kind: "no_rates_available" });
    });

    it("distinguishes 'nothing offered' from 'your choice is gone'", () => {
      // Two different customer actions: correct the address, versus re-pick.
      // One code for both would send half of them to the wrong remedy.
      const nothing = resolveShippingRateSelection({
        requestedServiceTitle: STANDARD.title,
        availableRates: [],
      });
      const gone = resolveShippingRateSelection({
        requestedServiceTitle: STANDARD.title,
        availableRates: [COMPLIMENTARY],
      });

      expect(nothing.kind).toBe("no_rates_available");
      expect(gone.kind).toBe("service_unavailable");
    });

    it("returns the live list with service_unavailable, so the customer can re-pick", () => {
      // The real scenario: the basket crossed $1,000 between the quote and
      // the submit, so the paid options vanished.
      const result = resolveShippingRateSelection({
        requestedServiceTitle: STANDARD.title,
        availableRates: [COMPLIMENTARY],
      });

      expect(result.kind).toBe("service_unavailable");
      if (result.kind !== "service_unavailable") return;
      expect(result.available).toEqual([COMPLIMENTARY]);
    });

    it("never returns a resolved rate for an unknown service, whatever the list contains", () => {
      for (const rates of [[STANDARD], [STANDARD, EXPRESS], [COMPLIMENTARY], [UPS_GROUND]]) {
        const result = resolveShippingRateSelection({
          requestedServiceTitle: "Free Shipping",
          availableRates: rates,
        });
        expect(result.kind).not.toBe("resolved");
      }
    });
  });

  describe("the match is exact, because a loose one would misprice", () => {
    it("does not treat Express as the Complimentary Express it is a suffix of", () => {
      // "Express Insured Shipping with Signature" is a literal suffix of
      // "Complimentary Express Insured Shipping with Signature". A suffix,
      // substring or prefix match would charge $55 for a service shown as
      // free — or give away the $55 one.
      const result = resolveShippingRateSelection({
        requestedServiceTitle: EXPRESS.title,
        availableRates: [COMPLIMENTARY],
      });

      expect(result.kind).toBe("service_unavailable");
    });

    it("does not resolve Complimentary Express when only paid Express is offered", () => {
      // The inverse, which is the one that gives shipping away: below $1,000
      // the complimentary service does not exist, and asking for it by name
      // must not land on the paid Express rate.
      const result = resolveShippingRateSelection({
        requestedServiceTitle: COMPLIMENTARY.title,
        availableRates: [STANDARD, EXPRESS],
      });

      expect(result.kind).toBe("service_unavailable");
    });

    it("is case-sensitive", () => {
      const result = resolveShippingRateSelection({
        requestedServiceTitle: "standard insured shipping with signature",
        availableRates: [STANDARD],
      });

      expect(result.kind).toBe("service_unavailable");
    });

    it("does not trim or normalise whitespace inside the title", () => {
      const result = resolveShippingRateSelection({
        requestedServiceTitle: "Standard  Insured Shipping with Signature",
        availableRates: [STANDARD],
      });

      expect(result.kind).toBe("service_unavailable");
    });

    it("does not match a different carrier service with a shared prefix", () => {
      const nextDay: AvailableShippingRate = {
        handle: "handle-nda",
        title: "UPS Next Day Air®",
        priceMinorUnits: 8216n,
        currency: "USD",
      };
      const nextDayEarly: AvailableShippingRate = {
        handle: "handle-nda-early",
        title: "UPS Next Day Air® Early",
        priceMinorUnits: 11216n,
        currency: "USD",
      };

      const result = resolveShippingRateSelection({
        requestedServiceTitle: nextDay.title,
        availableRates: [nextDay, nextDayEarly],
      });

      expect(result.kind).toBe("resolved");
      if (result.kind !== "resolved") return;
      // The cheaper one, not the Early variant whose title it is a prefix of.
      expect(result.rate.priceMinorUnits).toBe(8216n);
    });
  });

  describe("duplicate titles", () => {
    it("takes the first match deterministically rather than the cheapest or dearest", () => {
      // Shopify should not return two rates with one title, but if it did,
      // picking "the cheapest" would be a quiet discount and "the dearest" a
      // quiet overcharge. First-match is neither, and it is predictable.
      const duplicate: AvailableShippingRate = { ...STANDARD, handle: "handle-dup", priceMinorUnits: 9900n };

      const result = resolveShippingRateSelection({
        requestedServiceTitle: STANDARD.title,
        availableRates: [STANDARD, duplicate],
      });

      expect(result.kind).toBe("resolved");
      if (result.kind !== "resolved") return;
      expect(result.rate.handle).toBe("handle-standard");
    });
  });
});
