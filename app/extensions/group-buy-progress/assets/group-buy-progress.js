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

  /*
   * Is a minor-units string strictly greater than zero?
   *
   * STRING INSPECTION, not arithmetic. The server sends whole minor units as a
   * decimal string precisely so the client never converts money to a number,
   * and `Number(...)` here would be the one call that reintroduces a float into
   * the price path — the thing this whole file is written to avoid. An integer
   * string is positive exactly when it is neither absent, nor "0", nor signed.
   *
   * BigInt would also be exact but is ES2020; this file stays ES5 so it runs in
   * whatever a merchant's theme drags along with it.
   */
  function isPositiveMinorUnits(value) {
    if (value === null || value === undefined) return false;
    var text = String(value);
    return text.charAt(0) !== "-" && !/^0+$/.test(text);
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

    /*
     * THE GROUP BUY PRICE IS THE REGULAR/CARD PRICE.
     *
     * Card is the primary advertised price and the Bank Payment Price sits
     * beneath it — never the other way round. Owner decision,
     * docs/BANK-CARD-PRICING.md section 6. Checkout, network and legal
     * constraints are verified separately and do not change the display rule.
     */
    var prices = el("div", "carat-gb__prices");
    var group = el("div", "carat-gb__price");
    group.appendChild(el("span", "carat-gb__label", "Group Buy Price"));
    group.appendChild(
      el("span", "carat-gb__amount", formatMoney(data.groupBuyRegularCardPriceMinorUnits, moneyFormat))
    );
    prices.appendChild(group);

    if (data.groupSavingsCardBasisMinorUnits !== "0") {
      var compare = el("div", "carat-gb__price carat-gb__price--compare");
      compare.appendChild(el("span", "carat-gb__label", "Buy it now"));
      var was = el(
        "s",
        "carat-gb__amount carat-gb__amount--struck",
        formatMoney(data.buyNowRegularCardPriceMinorUnits, moneyFormat)
      );
      /* The strikethrough is decorative; the saving is stated in words below. */
      was.setAttribute("aria-hidden", "true");
      compare.appendChild(was);
      prices.appendChild(compare);
    }
    body.appendChild(prices);

    /*
     * The Bank Payment Price, and the saving against the card price — both as
     * ABSOLUTE AMOUNTS, never a percentage (policy §6).
     *
     * The saving arrives already computed from the two ROUNDED prices, so it is
     * exactly what a shopper gets by subtracting the two figures on screen. A
     * percentage would not be: the tier rate is applied before a $5 ceiling, so
     * the realised saving varies item to item and no single figure is right.
     */
    body.appendChild(
      el(
        "p",
        "carat-gb__bank",
        "Bank Payment Price: " + formatMoney(data.groupBuyBankPaymentPriceMinorUnits, moneyFormat)
      )
    );

    if (data.groupBuyBankPaymentSavingsMinorUnits !== "0") {
      body.appendChild(
        el(
          "p",
          "carat-gb__bank-savings",
          "Save " +
            formatMoney(data.groupBuyBankPaymentSavingsMinorUnits, moneyFormat) +
            " with Bank Payment"
        )
      );
    }

    /*
     * WHICH METHODS QUALIFY, AND HOW TO GET THE PRICE. Owner-approved wording,
     * reproduced verbatim — do not paraphrase.
     *
     * Not decoration. "Bank Payment Price" alone tells a shopper a lower price
     * exists without telling them how to obtain it, and standard Shopify
     * checkout will collect the Regular/Card Price whatever they select there:
     * no Shopify mechanism changes the payable total at payment-method
     * selection (docs/BANK-PAYMENT-CHECKOUT-FINDINGS.md).
     *
     * So the line says CONTACT US, not "choose at checkout". For MVP1 Phase 1
     * Bank Payment is an advertised alternative requiring arrangement; draft-
     * order automation is a separate future decision and is NOT implemented.
     * Advertising a price the checkout cannot charge, with no route to it,
     * would be the outcome docs/BANK-CARD-PRICING.md §8 prohibits.
     */
    body.appendChild(
      el(
        "p",
        "carat-gb__bank-methods",
        "Available with Zelle, bank transfer, ACH, or wire. Contact us to arrange payment."
      )
    );

    if (data.groupSavingsCardBasisMinorUnits !== "0") {
      /*
       * A DIFFERENT SAVING: the Group Buy against Buy Now, not the bank/card
       * spread above. Labelled "vs buying now" so the two cannot be read as one
       * number or added together.
       *
       * Compared card-to-card, so it measures the group discount alone and does
       * not quietly fold in the bank/card spread. A percentage is fine here —
       * the ban in policy §6 is on the bank/card rate, and this is the Group Buy
       * discount the README asks to be shown.
       */
      body.appendChild(
        el(
          "p",
          "carat-gb__savings",
          "You save " +
            formatMoney(data.groupSavingsCardBasisMinorUnits, moneyFormat) +
            " (" +
            data.groupSavingsCardBasisPercent +
            "%) vs buying now"
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
      item.appendChild(
        el("span", "carat-gb__tier-price", formatMoney(marker.regularCardPriceMinorUnits, moneyFormat))
      );
      if (marker.current) {
        /* Conveyed in text, not by colour alone. */
        item.appendChild(el("span", "carat-gb__tier-state", "current"));
      }
      track.appendChild(item);
    });
    body.appendChild(track);

    if (data.bestPriceUnlocked) {
      body.appendChild(el("p", "carat-gb__best", "Best Price Unlocked"));
    } else if (
      data.unitsToNextTier !== null &&
      data.nextTierRegularCardPriceMinorUnits !== null &&
      /*
       * ONLY CLAIM A DROP WHEN THERE IS ONE.
       *
       * Publication requires the next tier's Regular/Card Price to be no HIGHER
       * than the current one — but "no higher" permits EQUAL, and equal is
       * reachable: the $5 ceiling can swallow a small tier difference, so a
       * lower Bank Payment Price can round to the same card price.
       *
       * Without this guard the block renders "7 more and the price drops to
       * $2,080.00" directly beneath a Group Buy Price of $2,080.00 — every
       * figure individually correct, the sentence false. The tier is still real
       * for a bank-paying customer, whose price does fall, and its marker still
       * shows in the track; what is suppressed is a promise about the card
       * price that the card price does not keep.
       */
      isPositiveMinorUnits(data.additionalRegularCardSavingsMinorUnits)
    ) {
      body.appendChild(
        el(
          "p",
          "carat-gb__next",
          data.unitsToNextTier +
            " more and the price drops to " +
            formatMoney(data.nextTierRegularCardPriceMinorUnits, moneyFormat)
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
