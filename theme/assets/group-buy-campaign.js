/*
 * Group Buy campaign page (sections/group-buy-campaign.liquid). See that
 * file's own header comment for the full design rationale — this file is
 * its client-side half.
 *
 * ALL PRICES COME FROM THE SERVER. This file fetches
 * `GET /apps/carat/group-buy/:code` (optionally `?shopify_variant=<id>`),
 * the same read-only App Proxy endpoint `app/extensions/group-buy-progress`
 * already uses, and never computes a tier, a rounding, or a Bank/Card
 * uplift itself. A handful of small DISPLAY helpers (`formatMoney`,
 * `formatCountdown`, `isPositiveMinorUnits`) are necessarily duplicated from
 * that extension's `group-buy-progress.js` rather than shared: a theme app
 * extension and the Online Store theme are two separate deployable bundles
 * in Shopify and cannot literally import one another's assets. Duplicating
 * a formatter is safe; duplicating a PRICING RULE would not be, and none is
 * duplicated here — every figure this file displays is read verbatim from
 * the response body.
 *
 * PURE HELPERS ARE EXPOSED for testing exactly like
 * `assets/warranty-claim-form.js` / `assets/bank-payment-checkout.js`:
 * `window.CaratGroupBuyCampaign._internal`, loaded in tests through
 * `app/app/theme/groupBuyCampaignSandbox.ts`'s `vm` sandbox. Everything else
 * in this file (DOM wiring, fetches) is exercised by rendering the real
 * Liquid and diffing branches, matching this repo's own division of labour
 * for theme code (see that test file's own header comment).
 */
(function () {
  "use strict";

  var ENDPOINT = "/apps/carat/group-buy/";

  // ---------------------------------------------------------------------
  // Pure helpers
  // ---------------------------------------------------------------------

  /*
   * Minor units to a display string, using the shop's own money format.
   * Integer/string manipulation only — never `Number(minorUnits) / 100`,
   * which is exactly how a price would pick up a float rounding error on
   * its way to a shopper. Identical in spirit to
   * `group-buy-progress.js`'s own `formatMoney` (necessarily duplicated —
   * see this file's header comment).
   */
  function formatMoney(minorUnitsString, moneyFormat) {
    var negative = minorUnitsString.charAt(0) === "-";
    var digits = (negative ? minorUnitsString.slice(1) : minorUnitsString).replace(/\D/g, "");
    while (digits.length < 3) digits = "0" + digits;

    var whole = digits.slice(0, -2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
    var cents = digits.slice(-2);
    var amount = whole + "." + cents;

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

  /* String inspection only — see group-buy-progress.js's identical helper for why. */
  function isPositiveMinorUnits(value) {
    if (value === null || value === undefined) return false;
    var text = String(value);
    return text.charAt(0) !== "-" && !/^0+$/.test(text);
  }

  /*
   * Owner §9/§10's single active price slot: 'card' reads the Regular/Card
   * figure, 'bank' reads the Bank Payment figure. Pure so the switch logic
   * itself — not just its rendering — is directly testable.
   */
  function activePriceMinorUnits(data, mode) {
    return mode === "bank" ? data.groupBuyBankPaymentPriceMinorUnits : data.groupBuyRegularCardPriceMinorUnits;
  }

  /*
   * Defensive parse of the merchant-authored campaign-options JSON
   * (`data-campaign-options`, section setting `campaign_options_json`).
   * Returns null for anything that is not at least shaped like the
   * contract in app/app/domain/groupbuy/campaignOptions.ts — this file does
   * NOT re-run that module's full validator (a storefront asset cannot
   * import a server-side TypeScript module), only enough of a shape check
   * that a malformed or unrelated JSON blob safely falls back to "show
   * every product option" rather than throwing or rendering garbage
   * columns.
   */
  function parseCampaignOptionsJson(raw) {
    if (!raw) return null;
    var parsed;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      return null;
    }
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.schemaVersion !== 1) return null;
    if (!parsed.tableView || !Array.isArray(parsed.tableView.columns)) return null;
    return parsed;
  }

  /*
   * Which of the product's OWN option names become table columns, and in
   * what order. ALWAYS a subset of `productOptionNames` — this can never
   * invent a column the real Shopify product does not have, because the
   * campaign-options JSON has no variant-id field and cannot be trusted to
   * name a column that actually exists on this product (see the section
   * file's header comment on why the JSON only ever chooses among real
   * options, never supplies its own).
   *
   * Falls back to every product option, in the product's own order, when
   * there is no usable JSON or when the JSON names nothing that matches —
   * the table must still work for a merchant who has not authored the JSON
   * yet (Slice 6 tooling is not built).
   */
  function buildTableColumns(productOptionNames, campaignOptions) {
    if (!campaignOptions) return productOptionNames.slice();

    var lowerNames = productOptionNames.map(function (name) {
      return String(name).toLowerCase();
    });

    var matched = [];
    campaignOptions.tableView.columns.forEach(function (columnKey) {
      var idx = lowerNames.indexOf(String(columnKey).toLowerCase());
      if (idx !== -1 && matched.indexOf(productOptionNames[idx]) === -1) {
        matched.push(productOptionNames[idx]);
      }
    });

    return matched.length > 0 ? matched : productOptionNames.slice();
  }

  /*
   * The table's full header row, built from `buildTableColumns`' output.
   * Pulled out as its own pure function specifically so "exactly ONE price
   * column, never a second Bank Payment column" (owner §10) is directly
   * testable rather than only true because of how `init()` happens to call
   * `el()` — the trailing empty string is the header for the per-row
   * "Select" action column, never a price.
   */
  function buildTableHeaderLabels(columns) {
    return columns.concat(["Group Buy Price", ""]);
  }

  /*
   * Native Shopify variant matching — given the product's own `variants`
   * (each carrying `option1`/`option2`/`option3`) and an ordered array of
   * currently-selected option VALUES (position 0 = option1, etc.), returns
   * the one matching variant or null. No dimension "key" matching, no
   * campaign-options involvement at all: this is plain Shopify data, the
   * same shape Shopify's own variant pickers already match against.
   */
  function resolveVariantForOptionValues(variants, selectedValues) {
    if (!Array.isArray(variants)) return null;
    var found = null;
    variants.forEach(function (variant) {
      if (found) return;
      var matches = true;
      for (var i = 0; i < selectedValues.length; i++) {
        var optionKey = "option" + (i + 1);
        if (variant[optionKey] !== selectedValues[i]) {
          matches = false;
          break;
        }
      }
      if (matches) found = variant;
    });
    return found;
  }

  /* Mirrors Shopify's own `selected_or_first_available_variant`. */
  function firstAvailableOrFirstVariant(variants) {
    if (!Array.isArray(variants) || variants.length === 0) return null;
    var available = variants.filter(function (v) {
      return v.available !== false;
    });
    return available.length > 0 ? available[0] : variants[0];
  }

  /*
   * Whether the order action may be enabled. `signedIn` is always true when
   * this file's order controls exist at all — the section only renders
   * them inside Liquid's `{% if customer %}` branch (UX, not the real
   * enforcement; see the section file's header comment) — but this stays an
   * explicit parameter rather than an assumption so it is directly
   * testable and so a future caller cannot accidentally omit the check.
   */
  /*
   * `acknowledged` (owner spec 2026-09-27/28): the Group Buy cancellation
   * -policy checkbox — see `group-buy-cancellation-gate` wiring in `init()`
   * below. REQUIRED before either action, not only the Card add-to-cart:
   * neither path places or requests an order without it. THIS IS A UX GATE,
   * NOT ENFORCEMENT — a bypassed storefront can still POST directly to
   * `/cart/add`. The BINDING control is the `orders/create` order-time
   * verification in `groupBuyOrderHandler.server.ts`, which this gate cannot
   * replace and does not attempt to. See that handler's own module comment.
   */
  function canSubmitOrder(state) {
    if (!state || !state.signedIn) return false;
    if (!state.variant || state.variant.available === false) return false;
    if (!state.acknowledged) return false;
    return state.paymentType === "card" || state.paymentType === "bank";
  }

  // ---------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function fetchCampaign(code, shopifyVariantId) {
    var url = ENDPOINT + encodeURIComponent(code);
    if (shopifyVariantId) url += "?shopify_variant=" + encodeURIComponent(shopifyVariantId);
    return fetch(url, { headers: { Accept: "application/json" }, credentials: "same-origin" }).then(function (response) {
      if (!response.ok) throw new Error("status " + response.status);
      return response.json();
    });
  }

  function renderActivePrice(container, data, moneyFormat, mode) {
    container.textContent = "";
    if (!data) {
      container.appendChild(
        el("p", "carat-gb-campaign__price-note", "Select a configuration to see the Group Buy price.")
      );
      return;
    }

    var amount = activePriceMinorUnits(data, mode || "card");
    var row = el("div", "carat-gb-campaign__price-row");
    row.appendChild(el("span", "carat-gb-campaign__price-label", "Group Buy Price"));
    row.appendChild(el("span", null, formatMoney(amount, moneyFormat)));
    container.appendChild(row);

    if (mode === "bank") {
      container.appendChild(
        el(
          "p",
          "carat-gb-campaign__price-note",
          "Available with Zelle, bank transfer, ACH, or wire. Contact us to arrange payment."
        )
      );
    } else {
      container.appendChild(
        el("p", "carat-gb-campaign__price-note", "Lower pricing is available with Bank Payment.")
      );
    }
  }

  function renderProgress(container, data, moneyFormat) {
    container.textContent = "";

    var units = el("p", "carat-gb-campaign__units");
    units.appendChild(el("strong", null, String(data.qualifyingUnitsSold)));
    units.appendChild(document.createTextNode(" pieces claimed so far"));
    container.appendChild(units);

    if (data.groupSavingsCardBasisMinorUnits !== "0") {
      container.appendChild(
        el(
          "p",
          "carat-gb-campaign__savings",
          "You save " +
            formatMoney(data.groupSavingsCardBasisMinorUnits, moneyFormat) +
            " (" +
            data.groupSavingsCardBasisPercent +
            "%) vs buying now"
        )
      );
    }

    var track = el("ol", "carat-gb-campaign__tiers");
    data.tierMarkers.forEach(function (marker) {
      var item = el(
        "li",
        "carat-gb-campaign__tier" + (marker.unlocked ? " is-unlocked" : "") + (marker.current ? " is-current" : "")
      );
      item.appendChild(el("span", "carat-gb-campaign__tier-units", marker.minQualifyingUnits + "+"));
      item.appendChild(
        el("span", "carat-gb-campaign__tier-price", formatMoney(marker.regularCardPriceMinorUnits, moneyFormat))
      );
      if (marker.current) item.appendChild(el("span", "carat-gb-campaign__tier-state", "current"));
      track.appendChild(item);
    });
    container.appendChild(track);

    if (data.bestPriceUnlocked) {
      container.appendChild(el("p", "carat-gb-campaign__best", "Best Price Unlocked"));
    } else if (
      data.unitsToNextTier !== null &&
      data.nextTierRegularCardPriceMinorUnits !== null &&
      isPositiveMinorUnits(data.additionalRegularCardSavingsMinorUnits)
    ) {
      container.appendChild(
        el(
          "p",
          "carat-gb-campaign__next",
          data.unitsToNextTier +
            " more and the price drops to " +
            formatMoney(data.nextTierRegularCardPriceMinorUnits, moneyFormat)
        )
      );
    }

    var countdown = formatCountdown(data.secondsRemaining);
    if (countdown) container.appendChild(el("p", "carat-gb-campaign__countdown", "Closes in " + countdown));

    container.appendChild(el("p", "carat-gb-campaign__message", data.coreMessage));
  }

  /*
   * Full-body replacement — reserved for the FIRST load only, when there is
   * no configuration/table/order area worth keeping on screen yet (e.g. the
   * campaign code itself is wrong or the campaign has closed). Once the body
   * has ever shown real content, a LATER per-variant price failure uses
   * `showPriceUnavailable` instead, which leaves the table/configurator/order
   * area intact — a shopper who has already started choosing options should
   * never have that work wiped out by one failed fetch.
   */
  function showUnavailable(root) {
    var body = root.querySelector("[data-carat-gb-campaign-body]");
    var loading = root.querySelector("[data-carat-gb-campaign-loading]");
    if (body) {
      body.textContent = "";
      body.appendChild(
        el("p", "carat-gb-campaign__unavailable", "Group Buy pricing is not available for this item right now.")
      );
      body.hidden = false;
      body.setAttribute("aria-busy", "false");
    }
    if (loading) loading.hidden = true;
  }

  /* Reveals the body (if still hidden/loading) and localizes a fetch failure to the active-price slot only. */
  function showPriceUnavailable(root, activePriceEl) {
    var body = root.querySelector("[data-carat-gb-campaign-body]");
    var loading = root.querySelector("[data-carat-gb-campaign-loading]");
    if (body) {
      body.hidden = false;
      body.setAttribute("aria-busy", "false");
    }
    if (loading) loading.hidden = true;
    if (activePriceEl) {
      activePriceEl.textContent = "";
      activePriceEl.appendChild(
        el("p", "carat-gb-campaign__price-note", "Group Buy pricing is temporarily unavailable. Please try again shortly.")
      );
    }
  }

  // ---------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------

  function init(root) {
    var code = root.getAttribute("data-campaign-code");
    if (!code) return;

    var moneyFormat = root.getAttribute("data-money-format");
    var cartAddUrl = root.getAttribute("data-cart-add-url");
    var cartUrl = root.getAttribute("data-cart-url");

    var variantsScript = root.querySelector("[data-carat-gb-variants]");
    var optionsScript = root.querySelector("[data-carat-gb-options]");
    var variants = [];
    var productOptions = [];
    try {
      variants = JSON.parse(variantsScript.textContent) || [];
    } catch (e) {
      variants = [];
    }
    try {
      productOptions = JSON.parse(optionsScript.textContent) || [];
    } catch (e) {
      productOptions = [];
    }
    var productOptionNames = productOptions.map(function (o) {
      return o.name;
    });

    var campaignOptions = parseCampaignOptionsJson(root.getAttribute("data-campaign-options"));

    var body = root.querySelector("[data-carat-gb-campaign-body]");
    var loading = root.querySelector("[data-carat-gb-campaign-loading]");
    var tableHead = root.querySelector("[data-carat-gb-table-head]");
    var tableBody = root.querySelector("[data-carat-gb-table-body]");
    var optionSelects = Array.prototype.slice.call(root.querySelectorAll("[data-carat-gb-option-index]"));
    var variantStatus = root.querySelector("[data-carat-gb-variant-status]");
    var activePriceEl = root.querySelector("[data-carat-gb-active-price]");
    var progressEl = root.querySelector("[data-carat-gb-progress]");
    var paymentTypeInputs = Array.prototype.slice.call(root.querySelectorAll("[data-carat-gb-payment-type]"));
    var variantIdInput = root.querySelector("[data-carat-gb-variant-id]");
    var addToCartButton = root.querySelector('[data-carat-gb-payment-type-target="card"]');
    var bankContactLink = root.querySelector('[data-carat-gb-payment-type-target="bank"]');
    var addToCartForm = root.querySelector("[data-carat-gb-add-to-cart-form]");
    var cancelAckCheckbox = root.querySelector("[data-carat-gb-cancel-ack-checkbox]");
    var cancelAckInput = root.querySelector("[data-carat-gb-cancel-ack-input]");
    var cancelAckStatus = root.querySelector("[data-carat-gb-cancel-ack-status]");
    var cancelAckError = root.querySelector("[data-carat-gb-cancel-ack-error]");

    // Unlike a <button disabled>, a plain <a> stays clickable regardless of
    // `aria-disabled` — this is the one place that matters, since the link
    // only merely NAVIGATES TO A CONTACT PAGE rather than submitting an
    // order, but it should still honestly reflect "disabled" rather than
    // silently work anyway.
    if (bankContactLink) {
      bankContactLink.addEventListener("click", function (evt) {
        if (bankContactLink.getAttribute("aria-disabled") === "true") evt.preventDefault();
      });
    }

    var state = {
      variant: firstAvailableOrFirstVariant(variants),
      paymentType: null,
      lastData: null,
      hasEverLoaded: false,
      signedIn: !!(addToCartButton || bankContactLink),
      // Owner spec 2026-09-27/28 — never pre-checked, never inferred. See
      // `canSubmitOrder`'s own comment on why this gates both actions and
      // why it is a UX gate, not enforcement.
      acknowledged: false,
    };

    function updateOrderControls() {
      var canCard = canSubmitOrder({
        variant: state.variant,
        paymentType: "card",
        signedIn: state.signedIn,
        acknowledged: state.acknowledged,
      });
      var canBank = canSubmitOrder({
        variant: state.variant,
        paymentType: "bank",
        signedIn: state.signedIn,
        acknowledged: state.acknowledged,
      });

      if (addToCartButton) {
        addToCartButton.hidden = state.paymentType !== "card";
        addToCartButton.disabled = !(state.paymentType === "card" && canCard);
      }
      if (bankContactLink) {
        bankContactLink.hidden = state.paymentType !== "bank";
        if (!(state.paymentType === "bank" && canBank)) {
          bankContactLink.setAttribute("aria-disabled", "true");
        } else {
          bankContactLink.removeAttribute("aria-disabled");
        }
      }
      if (variantIdInput) variantIdInput.value = state.variant ? state.variant.id : "";

      if (variantStatus) {
        if (!state.variant) {
          variantStatus.textContent = "Select every option to choose a configuration.";
          variantStatus.setAttribute("data-carat-gb-status-unavailable", "true");
        } else if (state.variant.available === false) {
          variantStatus.textContent = "This configuration is sold out.";
          variantStatus.setAttribute("data-carat-gb-status-unavailable", "true");
        } else {
          variantStatus.textContent = "In stock and ready to order.";
          variantStatus.removeAttribute("data-carat-gb-status-unavailable");
        }
        variantStatus.hidden = false;
      }
    }

    function loadPriceForCurrentVariant() {
      if (!state.variant) {
        renderActivePrice(activePriceEl, null, moneyFormat, state.paymentType);
        return;
      }
      fetchCampaign(code, state.variant.id)
        .then(function (data) {
          state.lastData = data;
          state.hasEverLoaded = true;
          renderActivePrice(activePriceEl, data, moneyFormat, state.paymentType);
          if (progressEl) renderProgress(progressEl, data, moneyFormat);
          body.hidden = false;
          body.setAttribute("aria-busy", "false");
          if (loading) loading.hidden = true;
        })
        .catch(function () {
          // A campaign that has closed, or a variant this campaign does not
          // sell, is an ordinary 404 -- shown plainly rather than leaving the
          // "Loading…" text on screen forever (same swallow-to-"unavailable"
          // treatment as group-buy-progress.js). Only wipes the WHOLE page
          // when nothing has ever loaded; a later failure (e.g. after the
          // shopper picked a different configuration) leaves the table/
          // configurator/order area they already used intact and localizes
          // the failure to the price slot.
          if (state.hasEverLoaded) {
            showPriceUnavailable(root, activePriceEl);
          } else {
            showUnavailable(root);
          }
        });
    }

    function onOptionSelectChange() {
      var selectedValues = optionSelects
        .sort(function (a, b) {
          return Number(a.getAttribute("data-carat-gb-option-index")) - Number(b.getAttribute("data-carat-gb-option-index"));
        })
        .map(function (select) {
          return select.value;
        });
      state.variant = resolveVariantForOptionValues(variants, selectedValues);
      updateOrderControls();
      loadPriceForCurrentVariant();
    }

    optionSelects.forEach(function (select) {
      select.addEventListener("change", onOptionSelectChange);
    });

    paymentTypeInputs.forEach(function (input) {
      input.addEventListener("change", function () {
        if (!input.checked) return;
        state.paymentType = input.value;
        renderActivePrice(activePriceEl, state.lastData, moneyFormat, state.paymentType);
        updateOrderControls();
      });
    });

    // -----------------------------------------------------------------
    // Group Buy cancellation-policy acknowledgment (owner spec 2026-09-27/28).
    // CAPTURE ONLY, NOT ENFORCEMENT — see `canSubmitOrder`'s own comment and
    // `groupBuyOrderHandler.server.ts`'s module comment for the binding
    // control this gate feeds evidence to but cannot replace. Mirrors
    // `luxury-steal-gate.js`'s checkbox -> capture-endpoint -> hidden-input
    // shape, simplified: this acknowledgment is CAMPAIGN-scoped, not
    // per-variant, so — unlike that gate — nothing here resets it on an
    // option/variant change within the same page load.
    // -----------------------------------------------------------------
    if (cancelAckCheckbox) {
      // NEVER PRE-CHECKED — defensive reset against bfcache restoring stale
      // form state, same discipline `luxury-steal-gate.js` documents for its
      // own checkbox, even though the server-rendered markup already starts
      // unchecked by construction.
      cancelAckCheckbox.checked = false;
      if (cancelAckInput) cancelAckInput.value = "";

      cancelAckCheckbox.addEventListener("change", function () {
        if (!cancelAckCheckbox.checked) {
          state.acknowledged = false;
          if (cancelAckInput) cancelAckInput.value = "";
          if (cancelAckError) cancelAckError.hidden = true;
          updateOrderControls();
          return;
        }

        cancelAckCheckbox.disabled = true;
        if (cancelAckError) cancelAckError.hidden = true;
        if (cancelAckStatus) cancelAckStatus.hidden = true;

        fetch("/apps/carat/group-buy-cancellation-acknowledgment", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            campaignCode: code,
            shopifyVariantId: state.variant ? state.variant.id : undefined,
          }),
        })
          .then(function (response) {
            if (!response.ok) throw new Error("status " + response.status);
            return response.json();
          })
          .then(function (data) {
            if (!data || !data.acknowledgmentId) throw new Error("acknowledgment response missing acknowledgmentId");
            if (cancelAckInput) cancelAckInput.value = data.acknowledgmentId;
            state.acknowledged = true;
            updateOrderControls();
          })
          .catch(function () {
            // The click did not result in recorded evidence, so the checkbox
            // must not be left showing "checked" — that would visually claim
            // an acknowledgment that was never captured.
            cancelAckCheckbox.checked = false;
            state.acknowledged = false;
            if (cancelAckInput) cancelAckInput.value = "";
            updateOrderControls();
            if (cancelAckError) cancelAckError.hidden = false;
          })
          .finally(function () {
            cancelAckCheckbox.disabled = false;
          });
      });
    }

    if (addToCartForm) {
      addToCartForm.addEventListener("submit", function (evt) {
        evt.preventDefault();
        if (
          !canSubmitOrder({
            variant: state.variant,
            paymentType: "card",
            signedIn: state.signedIn,
            acknowledged: state.acknowledged,
          })
        ) {
          return;
        }
        if (addToCartButton) addToCartButton.setAttribute("aria-disabled", "true");

        fetch(cartAddUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            id: state.variant.id,
            quantity: 1,
            properties: cancelAckInput && cancelAckInput.value ? { _carat_gb_cancel_ack: cancelAckInput.value } : undefined,
          }),
        })
          .then(function (response) {
            if (!response.ok) throw new Error("status " + response.status);
            window.location = cartUrl;
          })
          .catch(function () {
            if (addToCartButton) addToCartButton.removeAttribute("aria-disabled");
            if (variantStatus) {
              variantStatus.textContent = "We couldn't add this to your cart. Please try again.";
              variantStatus.setAttribute("data-carat-gb-status-unavailable", "true");
              variantStatus.hidden = false;
            }
          });
      });
    }

    // ---- Comparison table -----------------------------------------------

    var columns = buildTableColumns(productOptionNames, campaignOptions);

    var headRow = el("tr");
    buildTableHeaderLabels(columns).forEach(function (label) {
      headRow.appendChild(el("th", null, label));
    });
    if (tableHead) tableHead.appendChild(headRow);

    var priceCellsByVariantId = {};

    if (tableBody) {
      variants.forEach(function (variant) {
        var row = el("tr");
        if (variant.available === false) row.setAttribute("data-carat-gb-row-unavailable", "true");

        columns.forEach(function (columnName) {
          var optionIndex = productOptionNames.indexOf(columnName);
          var value = optionIndex === -1 ? "" : variant["option" + (optionIndex + 1)];
          row.appendChild(el("td", null, value || ""));
        });

        var priceCell = el("td");
        if (variant.available === false) {
          priceCell.textContent = "Sold out";
        } else {
          priceCell.textContent = "…";
          priceCellsByVariantId[variant.id] = priceCell;
        }
        row.appendChild(priceCell);

        var actionCell = el("td", "carat-gb-campaign__table-select");
        if (variant.available !== false) {
          var selectButton = el("button", "link", "Select");
          selectButton.type = "button";
          selectButton.addEventListener("click", function () {
            optionSelects.forEach(function (select) {
              var index = Number(select.getAttribute("data-carat-gb-option-index"));
              var value = variant["option" + (index + 1)];
              if (value !== undefined) select.value = value;
            });
            onOptionSelectChange();
            var configurator = root.querySelector("[data-carat-gb-configurator]");
            if (configurator) configurator.scrollIntoView({ behavior: "smooth", block: "start" });
          });
          actionCell.appendChild(selectButton);
        }
        row.appendChild(actionCell);

        tableBody.appendChild(row);
      });
    }

    // One fetch per distinct AVAILABLE Shopify variant — never for a
    // sold-out one (README: never use an unavailable configuration to
    // advertise a price).
    Object.keys(priceCellsByVariantId).forEach(function (variantId) {
      fetchCampaign(code, variantId)
        .then(function (data) {
          priceCellsByVariantId[variantId].textContent = formatMoney(
            data.groupBuyRegularCardPriceMinorUnits,
            moneyFormat
          );
        })
        .catch(function () {
          priceCellsByVariantId[variantId].textContent = "Price unavailable";
        });
    });

    // ---- Initial state ----------------------------------------------------

    updateOrderControls();
    loadPriceForCurrentVariant();

    if (!state.variant) showUnavailable(root);
  }

  function initAll() {
    var roots = document.querySelectorAll("[data-carat-gb-campaign]");
    Array.prototype.forEach.call(roots, init);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", initAll);
  } else {
    initAll();
  }

  window.CaratGroupBuyCampaign = {
    _internal: {
      formatMoney: formatMoney,
      formatCountdown: formatCountdown,
      isPositiveMinorUnits: isPositiveMinorUnits,
      activePriceMinorUnits: activePriceMinorUnits,
      parseCampaignOptionsJson: parseCampaignOptionsJson,
      buildTableColumns: buildTableColumns,
      buildTableHeaderLabels: buildTableHeaderLabels,
      resolveVariantForOptionValues: resolveVariantForOptionValues,
      firstAvailableOrFirstVariant: firstAvailableOrFirstVariant,
      canSubmitOrder: canSubmitOrder,
    },
  };
})();
