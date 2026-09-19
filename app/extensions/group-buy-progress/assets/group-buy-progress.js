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

  /*
   * THE ACTIVE GROUP BUY PRICE — ONLY ONE AT A TIME (owner
   * docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md §9, §10).
   *
   * DEFAULT/PUBLIC STATE is the Regular/Card Price plus a concise note that a
   * lower price exists. It deliberately does NOT show the Bank Payment Price
   * beside it, does NOT show the dollar saving, and does NOT list eligible
   * methods as default body copy — showing all of that by default is exactly
   * what §9 supersedes from the earlier presentation.
   *
   * SELECTING "Bank Payment" switches the SAME slot to the Bank Payment Price
   * and reveals the eligible methods there. Selecting "Credit / Debit Card"
   * switches it back. The two prices are never rendered side by side, so a
   * shopper is never looking at two "the price is" claims at once.
   *
   * STILL A DISPLAY CHOICE, NOT A CHECKOUT ONE. Shopify does not vary the
   * payable total by payment method (docs/BANK-PAYMENT-CHECKOUT-FINDINGS.md),
   * so the Bank Payment state keeps the CONTACT-TO-ARRANGE copy rather than
   * implying a shopper can simply pick it at checkout.
   */
  function renderActivePrice(container, data, moneyFormat, mode) {
    container.textContent = "";

    var amount =
      mode === "bank" ? data.groupBuyBankPaymentPriceMinorUnits : data.groupBuyRegularCardPriceMinorUnits;

    var priceRow = el("div", "carat-gb__price");
    priceRow.appendChild(el("span", "carat-gb__label", "Group Buy Price"));
    priceRow.appendChild(el("span", "carat-gb__amount", formatMoney(amount, moneyFormat)));
    container.appendChild(priceRow);

    if (mode === "bank") {
      /*
       * WHICH METHODS QUALIFY, AND HOW TO GET THE PRICE. Owner-approved
       * wording, reproduced verbatim — do not paraphrase. Shown only once
       * Bank Payment is the active selection (§9), never as default copy.
       *
       * No Shopify mechanism changes the payable total at payment-method
       * selection, so the line says CONTACT US, not "choose at checkout".
       */
      container.appendChild(
        el(
          "p",
          "carat-gb__bank-methods",
          "Available with Zelle, bank transfer, ACH, or wire. Contact us to arrange payment."
        )
      );
    } else {
      /* The §9 default note — nothing more. No side-by-side price, no figure. */
      container.appendChild(
        el("p", "carat-gb__bank-note", "Lower pricing is available with Bank Payment.")
      );
    }
  }

  /*
   * REQUIRED PAYMENT TYPE SELECTION (§9), once a configuration is selected.
   *
   * Deliberately rendered with NEITHER option pre-checked. CLAUDE.md: a
   * required choice is never pre-checked or silently inferred, and §9 calls
   * this a required selection the shopper makes, not a default the page picks
   * for them. The DEFAULT DISPLAYED PRICE above is still the Regular/Card
   * Price — that is the resting/public state, not an implicit selection.
   *
   * `name` is scoped per block instance (`data-carat-gb-instance`, set once in
   * `init`) because a radio group's `name` is unique across the whole
   * document, not just this element's subtree — two Group Buy blocks on one
   * page must not fight over each other's selection.
   */
  function renderPaymentType(container, instanceId, onChange) {
    container.textContent = "";

    var fieldset = document.createElement("fieldset");
    fieldset.className = "carat-gb__payment-type";
    var legend = document.createElement("legend");
    legend.className = "carat-gb__payment-type-legend";
    legend.textContent = "Payment Type";
    fieldset.appendChild(legend);

    var groupName = "carat-gb-payment-type-" + instanceId;

    function option(value, label) {
      var wrap = el("label", "carat-gb__payment-option");
      var input = document.createElement("input");
      input.type = "radio";
      input.name = groupName;
      input.value = value;
      input.className = "carat-gb__payment-input";
      wrap.appendChild(input);
      wrap.appendChild(document.createTextNode(" " + label));
      fieldset.appendChild(wrap);
      return input;
    }

    var cardInput = option("card", "Credit / Debit Card");
    var bankInput = option("bank", "Bank Payment");

    function change(event) {
      // Stops this radio's "change" from reaching the document-level listener
      // `init` installs to detect a THEME variant change — a different
      // concern that happens to share the same event name.
      if (event && event.stopPropagation) event.stopPropagation();
      onChange(bankInput.checked ? "bank" : "card");
    }
    cardInput.addEventListener("change", change);
    bankInput.addEventListener("change", change);

    container.appendChild(fieldset);
  }

  function render(root, data) {
    var body = root.querySelector("[data-carat-gb-body]");
    var loading = root.querySelector("[data-carat-gb-loading]");
    var moneyFormat = root.getAttribute("data-money-format");
    var instanceId = root.getAttribute("data-carat-gb-instance") || "0";

    body.textContent = "";

    /* Units sold — a count, never a percentage of anything. */
    var units = el("p", "carat-gb__units");
    units.appendChild(el("strong", null, String(data.qualifyingUnitsSold)));
    units.appendChild(document.createTextNode(" pieces claimed so far"));
    body.appendChild(units);

    /*
     * THE GROUP BUY PRICE IS THE REGULAR/CARD PRICE BY DEFAULT.
     *
     * Card is the primary/public advertised price (owner §9). The Bank
     * Payment Price only becomes active once the shopper selects it below —
     * never shown side by side with the card price.
     */
    var prices = el("div", "carat-gb__prices");
    var activePrice = el("div", "carat-gb__price-active");
    prices.appendChild(activePrice);

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
    renderActivePrice(activePrice, data, moneyFormat, "card");

    /*
     * §9's required Payment Type selection. Re-renders the SAME active-price
     * slot above — never a second price node — so only one price is ever on
     * screen at once.
     */
    var paymentType = el("div", "carat-gb__payment-type-wrap");
    body.appendChild(paymentType);
    renderPaymentType(paymentType, instanceId, function (mode) {
      renderActivePrice(activePrice, data, moneyFormat, mode);
    });

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
       * BELT AND BRACES since the owner tightened publication on 2026-09-19.
       * A campaign whose next tier does not STRICTLY lower the Regular/Card
       * Price can no longer be published, so on a campaign opened since then
       * this cannot fire.
       *
       * Kept because campaigns opened under the earlier `<=` rule were
       * validated when a tie was permitted, and their tiers are frozen — the
       * database refuses to change them, correctly, so the only place left to
       * be honest about such a campaign is here. Without the guard one renders
       * "7 more and the price drops to $2,080.00" directly beneath a Group Buy
       * Price of $2,080.00: every figure individually correct, the sentence
       * false.
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
    Array.prototype.forEach.call(roots, function (root, index) {
      // A stable id per block instance, so its Payment Type radio group's
      // `name` (document-scoped, not subtree-scoped) never collides with a
      // second Group Buy block on the same page.
      root.setAttribute("data-carat-gb-instance", String(index));

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
