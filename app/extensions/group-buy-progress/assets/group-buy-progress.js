/*
 * Live Group Buy progress.
 *
 * Fetches campaign state from the app's App Proxy endpoint and renders it. All
 * figures come from the server; nothing about tiers or prices is computed here.
 * A script that did its own arithmetic would be a second place a
 * customer-facing price is decided, and the two could disagree.
 *
 * REQUESTS GO TO A RELATIVE PATH on the shop's own domain. Shopify proxies
 * /apps/carat/* to the app and signs the request on the way through, so the
 * browser never holds a credential and the app can still verify the caller.
 */
(function () {
  "use strict";

  var ENDPOINT = "/apps/carat/group-buy/";

  /*
   * Minor units to a display string, using the shop's own money format.
   *
   * Integer arithmetic on the string, never `Number(minorUnits) / 100`: a
   * float divide is exactly how a price picks up a rounding error on its way
   * to a shopper. The server sends whole minor units as a string precisely so
   * this step cannot lose anything.
   */
  function formatMoney(minorUnitsString, moneyFormat) {
    var negative = minorUnitsString.charAt(0) === "-";
    var digits = (negative ? minorUnitsString.slice(1) : minorUnitsString).replace(/\D/g, "");
    while (digits.length < 3) digits = "0" + digits;

    var whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    var cents = digits.slice(-2);
    var amount = whole + "." + cents;

    /*
     * Shopify money formats use {{amount}}-style placeholders. Substituting
     * the ones that mean "with decimals" covers the common cases; anything
     * unrecognised falls back to a plain amount rather than rendering a raw
     * template string at a shopper.
     */
    if (moneyFormat && moneyFormat.indexOf("{{") !== -1) {
      var replaced = moneyFormat
        .replace(/\{\{\s*amount\s*\}\}/g, amount)
        .replace(/\{\{\s*amount_with_comma_separator\s*\}\}/g, amount.replace(/,/g, " ").replace(".", ","))
        .replace(/\{\{\s*amount_no_decimals\s*\}\}/g, whole);
      if (replaced.indexOf("{{") === -1) return (negative ? "-" : "") + replaced;
    }
    return (negative ? "-" : "") + "$" + amount;
  }

  function formatCountdown(seconds) {
    if (seconds === null || seconds === undefined) return null;
    var days = (seconds - (seconds % 86400)) / 86400;
    var hours = ((seconds % 86400) - (seconds % 3600)) / 3600;
    var minutes = ((seconds % 3600) - (seconds % 60)) / 60;

    if (days > 0) return days + "d " + hours + "h";
    if (hours > 0) return hours + "h " + minutes + "m";
    return minutes + "m";
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    // textContent, never innerHTML: every value here originates server-side,
    // but building DOM this way means a future field cannot become an
    // injection point by being added carelessly.
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function render(root, data) {
    var body = root.querySelector("[data-carat-gb-body]");
    var loading = root.querySelector("[data-carat-gb-loading]");
    var moneyFormat = root.getAttribute("data-money-format");

    body.textContent = "";

    /* Units sold — a count, never a percentage of anything. */
    var units = el("p", "carat-gb__units");
    units.appendChild(el("strong", null, String(data.qualifyingUnitsSold)));
    units.appendChild(document.createTextNode(" pieces claimed so far"));
    body.appendChild(units);

    /* Group price, and the Buy Now price it beats. */
    var prices = el("div", "carat-gb__prices");
    var group = el("div", "carat-gb__price");
    group.appendChild(el("span", "carat-gb__label", "Group price"));
    group.appendChild(
      el("span", "carat-gb__amount", formatMoney(data.groupBuyPriceMinorUnits, moneyFormat))
    );
    prices.appendChild(group);

    if (data.savingsMinorUnits !== "0") {
      var compare = el("div", "carat-gb__price carat-gb__price--compare");
      compare.appendChild(el("span", "carat-gb__label", "Buy it now"));
      var was = el(
        "s",
        "carat-gb__amount carat-gb__amount--struck",
        formatMoney(data.buyNowComparisonPriceMinorUnits, moneyFormat)
      );
      /* The strikethrough is decorative; the saving is stated in words below. */
      was.setAttribute("aria-hidden", "true");
      compare.appendChild(was);
      prices.appendChild(compare);
    }
    body.appendChild(prices);

    if (data.savingsMinorUnits !== "0") {
      body.appendChild(
        el(
          "p",
          "carat-gb__savings",
          "You save " +
            formatMoney(data.savingsMinorUnits, moneyFormat) +
            " (" +
            data.savingsPercent +
            "%)"
        )
      );
    }

    /*
     * Tier markers. A TRACK OF THRESHOLDS, not a funded bar — the distinction
     * the README draws. Each marker says "the price is X once N are claimed",
     * so an unreached marker reads as an opportunity rather than a shortfall.
     */
    var track = el("ol", "carat-gb__tiers");
    data.tierMarkers.forEach(function (marker) {
      var item = el("li", "carat-gb__tier" + (marker.unlocked ? " is-unlocked" : "") + (marker.current ? " is-current" : ""));
      item.appendChild(el("span", "carat-gb__tier-units", marker.minQualifyingUnits + "+"));
      item.appendChild(el("span", "carat-gb__tier-price", formatMoney(marker.priceMinorUnits, moneyFormat)));
      if (marker.current) {
        /* Conveyed in text, not by colour alone. */
        item.appendChild(el("span", "carat-gb__tier-state", "current"));
      }
      track.appendChild(item);
    });
    body.appendChild(track);

    if (data.bestPriceUnlocked) {
      body.appendChild(el("p", "carat-gb__best", "Best Price Unlocked"));
    } else if (data.unitsToNextTier !== null && data.nextTierPriceMinorUnits !== null) {
      body.appendChild(
        el(
          "p",
          "carat-gb__next",
          data.unitsToNextTier +
            " more and the price drops to " +
            formatMoney(data.nextTierPriceMinorUnits, moneyFormat)
        )
      );
    }

    var countdown = formatCountdown(data.secondsRemaining);
    if (countdown) body.appendChild(el("p", "carat-gb__countdown", "Closes in " + countdown));

    body.appendChild(el("p", "carat-gb__message", data.coreMessage));

    body.hidden = false;
    body.setAttribute("aria-busy", "false");
    if (loading) loading.hidden = true;
  }

  function showUnavailable(root) {
    /*
     * Says so plainly rather than leaving an empty box. Critically it does NOT
     * fall back to showing the Buy Now price: presenting a non-group price
     * where a group price belongs would misquote the customer.
     */
    var body = root.querySelector("[data-carat-gb-body]");
    var loading = root.querySelector("[data-carat-gb-loading]");
    body.textContent = "";
    body.appendChild(
      el("p", "carat-gb__unavailable", "Group pricing is not available for this item right now.")
    );
    body.hidden = false;
    body.setAttribute("aria-busy", "false");
    if (loading) loading.hidden = true;
  }

  function load(root) {
    var code = root.getAttribute("data-campaign-code");
    var variantId = root.getAttribute("data-variant-id");
    if (!code) return;

    var url = ENDPOINT + encodeURIComponent(code);
    if (variantId) url += "?shopify_variant=" + encodeURIComponent(variantId);

    fetch(url, { headers: { Accept: "application/json" }, credentials: "same-origin" })
      .then(function (response) {
        if (!response.ok) throw new Error("status " + response.status);
        return response.json();
      })
      .then(function (data) {
        render(root, data);
      })
      .catch(function () {
        /*
         * Swallowed on purpose, and only here. A campaign that has closed, or
         * a variant not in the campaign, is an ordinary 404 — not something to
         * report to a shopper as an error.
         */
        showUnavailable(root);
      });
  }

  function init() {
    var roots = document.querySelectorAll("[data-carat-group-buy]");
    Array.prototype.forEach.call(roots, function (root) {
      load(root);

      /*
       * Re-fetch when the shopper picks a different size.
       *
       * Themes signal variant changes inconsistently, so this listens for the
       * common custom events AND falls back to watching the URL, which Shopify
       * themes update on selection. Listening for one theme's event alone
       * would leave the block silently stale on every other theme.
       */
      var lastVariant = root.getAttribute("data-variant-id");
      var onChange = function () {
        var current = new URLSearchParams(window.location.search).get("variant");
        if (current && current !== lastVariant) {
          lastVariant = current;
          root.setAttribute("data-variant-id", current);
          load(root);
        }
      };

      document.addEventListener("variant:change", onChange);
      document.addEventListener("change", onChange);
      window.addEventListener("popstate", onChange);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
