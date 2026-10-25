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
  // Group Buy Bank Payment ordering (register D12) — pure half
  // ---------------------------------------------------------------------

  /**
   * Bank Payment copy, bound in `theme.liquid` as
   * `window.groupBuyCampaignStrings`.
   *
   * WHY A FALLBACK AT ALL. The rest of this file hardcodes its English
   * strings ("Sold out", "Select"), which predates this work; a payment
   * surface rendering a bare key would be worse than any of those. The
   * fallback is the key itself only when the binding is missing entirely,
   * which is a theme deployment error, not a translation gap.
   */
  function localeString(key) {
    var strings = window.groupBuyCampaignStrings;
    if (strings && typeof strings[key] === "string" && strings[key].length > 0) return strings[key];
    return key;
  }

  var BANK_REQUIRED_FIELDS = ["email", "address1", "city", "zip", "countryCode"];
  var BANK_OPTIONAL_FIELDS = ["firstName", "lastName", "address2", "provinceCode", "phone"];

  /** Trims every value and drops anything the form did not provide. */
  function normalizeBankValues(raw) {
    var out = {};
    if (!raw) return out;
    BANK_REQUIRED_FIELDS.concat(BANK_OPTIONAL_FIELDS).forEach(function (name) {
      var value = raw[name];
      out[name] = typeof value === "string" ? value.trim() : "";
    });
    return out;
  }

  /**
   * Client-side validation, which exists ONLY to save a round trip. The
   * route revalidates everything with zod and is the authority; nothing
   * here may be relied on for correctness.
   */
  function validateBankValues(values) {
    var errors = [];
    BANK_REQUIRED_FIELDS.forEach(function (name) {
      if (!values[name]) errors.push({ field: name, messageKey: "bank_error_" + name + "_required" });
    });
    if (values.email && values.email.indexOf("@") === -1) {
      errors.push({ field: "email", messageKey: "bank_error_email_required" });
    }
    return errors;
  }

  /**
   * THE ONLY PLACE A GROUP BUY BANK REQUEST BODY IS BUILT.
   *
   * `cancellationAcknowledgmentAccepted` is passed in as a separate
   * argument rather than read off the form, so the caller has to state
   * explicitly that the box was ticked. It is emitted as the literal `true`
   * only in that case — the route's zod schema is `z.literal(true)` and
   * will reject anything else, which is the behaviour we want preserved,
   * not worked around.
   *
   * NO ACKNOWLEDGMENT ID IS SENT. Not an omission — see the snippet header.
   * Optional address fields are omitted entirely when empty rather than
   * sent as "", because the route's schema requires `.min(1)` on each.
   */
  function buildBankRequestBody(input) {
    var values = normalizeBankValues(input.values);
    var address = { address1: values.address1, city: values.city, zip: values.zip, countryCode: values.countryCode };
    BANK_OPTIONAL_FIELDS.forEach(function (name) {
      if (values[name]) address[name] = values[name];
    });
    return {
      mode: "bank",
      campaignCode: input.campaignCode,
      email: values.email,
      shippingAddress: address,
      lines: [{ shopifyVariantId: String(input.shopifyVariantId), quantity: 1 }],
      cancellationAcknowledgmentAccepted: input.acknowledged === true ? true : false,
    };
  }

  /** Maps a failed submit to a locale key. Never surfaces a server detail. */
  function messageKeyForBankFailure(status, body) {
    var error = body && typeof body.error === "string" ? body.error : "";
    if (status === 401) return "bank_error_authentication_required";
    if (status === 409) return "bank_error_unresolved";
    if (error === "campaign_not_open") return "bank_error_campaign_not_open";
    if (error === "unpurchasable_lines") return "bank_error_unpurchasable";
    if (error === "checkout_unavailable" || error === "acknowledgment_copy_pending_approval") {
      return "bank_error_unavailable";
    }
    if (status === 400) return "bank_error_invalid_request";
    return "bank_error_generic";
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
    var addToCartForm = root.querySelector("[data-carat-gb-add-to-cart-form]");
    var cancelAckCheckbox = root.querySelector("[data-carat-gb-cancel-ack-checkbox]");
    var cancelAckInput = root.querySelector("[data-carat-gb-cancel-ack-input]");
    var cancelAckStatus = root.querySelector("[data-carat-gb-cancel-ack-status]");
    var cancelAckError = root.querySelector("[data-carat-gb-cancel-ack-error]");
    // Bank Payment ordering (register D12). Replaced the contact link.
    var bankPanel = root.querySelector("[data-carat-gb-bank]");
    var bankForm = root.querySelector("[data-carat-gb-bank-form]");
    var bankSubmit = root.querySelector("[data-carat-gb-bank-submit]");
    var bankStatus = root.querySelector("[data-carat-gb-bank-status]");
    var bankErrorSummary = root.querySelector("[data-carat-gb-bank-error-summary]");
    var bankConfirmation = root.querySelector("[data-carat-gb-bank-confirmation]");

    var state = {
      variant: firstAvailableOrFirstVariant(variants),
      paymentType: null,
      lastData: null,
      hasEverLoaded: false,
      signedIn: !!(addToCartButton || bankPanel),
      // Owner spec 2026-09-27/28 — never pre-checked, never inferred. See
      // `canSubmitOrder`'s own comment on why this gates both actions and
      // why it is a UX gate, not enforcement.
      acknowledged: false,
      /**
       * Set once the Bank order has been placed, so a double submit cannot
       * create a second real, participation-counting Shopify order. The
       * route is idempotent and would collapse a true duplicate anyway —
       * this is the cheap front-line guard, not the correctness one.
       */
      bankOrderPlaced: false,
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
      if (bankPanel) {
        // Hidden until Bank Payment is explicitly chosen (owner §9/§10:
        // Payment Type is a required, never-defaulted selection), and
        // retired entirely once the order exists so the confirmation is
        // the only thing on screen.
        bankPanel.hidden = state.paymentType !== "bank" || state.bankOrderPlaced;
      }
      if (bankSubmit) {
        bankSubmit.disabled = !(state.paymentType === "bank" && canBank) || state.bankOrderPlaced;
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

        /**
         * SWITCHING BANK -> CARD AFTER TICKING THE BOX.
         *
         * The Bank branch deliberately captures nothing, so a customer who
         * ticked under Bank and then chose Card has an acknowledgment the
         * Card path cannot carry — native checkout needs the id on the cart
         * line. Capture it now rather than silently letting them add to cart
         * with an empty `_carat_gb_cancel_ack`.
         *
         * The reverse direction needs nothing: a captured id is simply never
         * sent to the Bank route.
         */
        if (cancelAckCheckbox && cancelAckCheckbox.checked && cardCaptureOutstanding()) {
          captureCardAcknowledgment();
        }
      });
    });

    // -----------------------------------------------------------------
    // GROUP BUY CANCELLATION-POLICY ACKNOWLEDGMENT (owner spec 2026-09-27/28).
    //
    // ONE CHECKBOX, TWO MECHANISMS — AND THEY STAY SEPARATE.
    //
    // CARD: captures evidence NOW, through
    // `/apps/carat/group-buy-cancellation-acknowledgment`, and carries the
    // returned id on the cart line. It must work this way because native
    // Shopify checkout creates the order, so the evidence has to exist
    // before the order does and travel with it. Mirrors
    // `luxury-steal-gate.js`'s checkbox -> capture-endpoint -> hidden-input
    // shape, simplified: this acknowledgment is CAMPAIGN-scoped, not
    // per-variant, so nothing here resets it on an option change.
    //
    // BANK: captures NOTHING here. No call to that endpoint, no id in the
    // browser. The checkbox only records that the customer ticked it, and
    // the bank submit sends `cancellationAcknowledgmentAccepted: true`.
    // `apps.carat.group-buy-bank-checkout.tsx` writes the Acknowledgment row
    // itself, in the same transaction as the order, bound to the
    // AUTHENTICATED customerGid, behind a NOT NULL foreign key.
    //
    // Unifying these for symmetry would mean either sending the Card path's
    // id to the Bank route (a browser-supplied identity the route is right
    // to refuse) or dropping the Card path's pre-capture (which native
    // checkout cannot do without). The MECHANISMS differ because the two
    // order-creation paths differ. The EVIDENCE STANDARD does not, and
    // `groupBuyAcknowledgmentEvidenceParity.test.ts` pins that.
    //
    // NEITHER IS ENFORCEMENT. See `canSubmitOrder`'s own comment and
    // `groupBuyOrderHandler.server.ts`.
    // -----------------------------------------------------------------

    /** True when the Card path still needs a captured id it does not have. */
    function cardCaptureOutstanding() {
      return state.paymentType === "card" && !(cancelAckInput && cancelAckInput.value);
    }

    function captureCardAcknowledgment() {
      cancelAckCheckbox.disabled = true;
      if (cancelAckError) cancelAckError.hidden = true;
      if (cancelAckStatus) cancelAckStatus.hidden = true;

      return fetch("/apps/carat/group-buy-cancellation-acknowledgment", {
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
    }

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

        if (state.paymentType === "bank") {
          // NO NETWORK CALL. The tick is the affirmative action; the
          // evidence is written server-side at order time.
          state.acknowledged = true;
          if (cancelAckError) cancelAckError.hidden = true;
          updateOrderControls();
          return;
        }

        // Card, or no payment type chosen yet. Capturing eagerly keeps the
        // existing behaviour for the Card path; if the customer later picks
        // Bank, the captured id is simply never sent.
        captureCardAcknowledgment();
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

    // ---- Group Buy Bank Payment ordering (register D12) -------------------

    function bankFieldErrorNode(name) {
      var input = bankForm ? bankForm.querySelector('[name="' + name + '"]') : null;
      if (!input) return null;
      var describedBy = input.getAttribute("aria-describedby");
      return describedBy ? document.getElementById(describedBy) : null;
    }

    function clearBankFieldErrors() {
      if (!bankForm) return;
      BANK_REQUIRED_FIELDS.concat(BANK_OPTIONAL_FIELDS).forEach(function (name) {
        var input = bankForm.querySelector('[name="' + name + '"]');
        if (input) input.removeAttribute("aria-invalid");
        var node = bankFieldErrorNode(name);
        if (node) node.hidden = true;
      });
      if (bankErrorSummary) {
        bankErrorSummary.hidden = true;
        bankErrorSummary.textContent = "";
      }
    }

    function showBankErrors(errors) {
      if (!bankErrorSummary) return;
      bankErrorSummary.textContent = "";
      var heading = el("p", "form-status caption-large text-body", localeString("bank_error_summary_heading"));
      var list = el("ul");
      list.setAttribute("role", "list");
      errors.forEach(function (entry) {
        var message = localeString(entry.messageKey);
        list.appendChild(el("li", null, message));
        var input = bankForm ? bankForm.querySelector('[name="' + entry.field + '"]') : null;
        if (input) input.setAttribute("aria-invalid", "true");
        var node = bankFieldErrorNode(entry.field);
        if (node) {
          var text = node.querySelector("[data-carat-gb-bank-field-error-text]");
          if (text) text.textContent = message;
          node.hidden = false;
        }
      });
      bankErrorSummary.appendChild(heading);
      bankErrorSummary.appendChild(list);
      bankErrorSummary.hidden = false;
      bankErrorSummary.focus();
    }

    function showBankMessage(messageKey) {
      showBankErrors([{ field: "__form", messageKey: messageKey }]);
    }

    /** ISO instant to a readable UTC string. No arithmetic — the server decided it. */
    function formatBankDeadline(iso) {
      var parsed = new Date(iso);
      if (isNaN(parsed.getTime())) return iso;
      var text = parsed.toISOString();
      return text.slice(0, 10) + " " + text.slice(11, 16) + " UTC";
    }

    /**
     * The Group Buy confirmation (register D12).
     *
     * EVERY VALUE COMES FROM THE SERVER RESPONSE — no price arithmetic, no
     * deadline arithmetic. `commitmentNotice` and `extensionNotice` are
     * composed server-side by `buildPaymentInstructionsView` and say
     * materially different things from Buy Now's, deliberately: a Group Buy
     * Bank Payment order is a REAL unpaid order that already counts toward
     * the campaign and has a locked price, with 48h plus one automatic 48h
     * extension. Rewording either here would make this screen disagree with
     * the email and the orders page.
     *
     * textContent throughout — a bank account number must never be able to
     * introduce markup.
     */
    function renderBankConfirmation(dto) {
      if (!bankConfirmation) return;
      var ins = dto.instructions;

      function row(dl, label, value) {
        dl.appendChild(el("dt", "carat-bank-confirmation__label", label));
        dl.appendChild(el("dd", "carat-bank-confirmation__value", value));
      }

      bankConfirmation.textContent = "";
      bankConfirmation.setAttribute("role", "status");
      bankConfirmation.setAttribute("aria-live", "polite");

      var panel = el("div", "carat-bank-confirmation");
      panel.appendChild(el("h3", "carat-bank-confirmation__heading", localeString("bank_confirmation_heading")));
      panel.appendChild(el("p", "carat-bank-confirmation__still-required", ins.paymentStillRequired));
      panel.appendChild(el("p", "carat-bank-confirmation__commitment", ins.commitmentNotice));

      var summary = el("dl", "carat-bank-confirmation__summary");
      row(summary, localeString("bank_confirmation_reference"), ins.reference);
      row(summary, localeString("bank_confirmation_campaign"), dto.campaignCode);
      row(summary, localeString("bank_confirmation_tier"), String(dto.tierNumber));
      row(summary, localeString("bank_confirmation_amount_due"), ins.formattedAmountDue + " " + ins.currency);
      row(summary, localeString("bank_confirmation_deadline"), formatBankDeadline(ins.paymentDeadline));
      panel.appendChild(summary);

      if (ins.extensionNotice) {
        panel.appendChild(el("p", "carat-bank-confirmation__extension", ins.extensionNotice));
      }

      panel.appendChild(el("h4", "carat-bank-confirmation__methods-heading", localeString("bank_confirmation_methods")));
      ins.methods.forEach(function (m) {
        var block = el("div", "carat-bank-confirmation__method");
        var fields = el("dl", "carat-bank-confirmation__method-fields");
        if (m.kind === "zelle") {
          block.appendChild(el("h5", "carat-bank-confirmation__method-name", localeString("bank_confirmation_zelle")));
          row(fields, localeString("bank_confirmation_send_to"), m.recipient);
          row(fields, localeString("bank_confirmation_memo"), m.memo);
        } else {
          block.appendChild(el("h5", "carat-bank-confirmation__method-name", localeString("bank_confirmation_wire")));
          row(fields, localeString("bank_confirmation_bank_name"), m.bankName);
          row(fields, localeString("bank_confirmation_account_name"), m.accountName);
          row(fields, localeString("bank_confirmation_routing"), m.routingNumber);
          row(fields, localeString("bank_confirmation_account_number"), m.accountNumber);
          row(fields, localeString("bank_confirmation_reference_label"), m.reference);
        }
        block.appendChild(fields);
        panel.appendChild(block);
      });

      panel.appendChild(el("p", "carat-bank-confirmation__include", ins.includeWithPayment));

      // The durable surface, same as the Buy Now confirmation offers.
      var durable = el("p", "carat-bank-confirmation__durable");
      var link = el("a", "carat-bank-confirmation__durable-link", localeString("bank_confirmation_view_orders_link"));
      link.setAttribute("href", "/pages/bank-payment-orders");
      durable.appendChild(document.createTextNode(localeString("bank_confirmation_view_orders") + " "));
      durable.appendChild(link);
      panel.appendChild(durable);

      panel.appendChild(
        el(
          "p",
          "carat-bank-confirmation__support",
          localeString("bank_confirmation_support") + " " + ins.supportEmail
        )
      );

      bankConfirmation.appendChild(panel);
      bankConfirmation.hidden = false;
    }

    if (bankForm) {
      bankForm.addEventListener("submit", function (evt) {
        evt.preventDefault();
        if (state.bankOrderPlaced) return;
        if (
          !canSubmitOrder({
            variant: state.variant,
            paymentType: "bank",
            signedIn: state.signedIn,
            acknowledged: state.acknowledged,
          })
        ) {
          return;
        }

        clearBankFieldErrors();

        var raw = {};
        BANK_REQUIRED_FIELDS.concat(BANK_OPTIONAL_FIELDS).forEach(function (name) {
          var input = bankForm.querySelector('[name="' + name + '"]');
          raw[name] = input ? input.value : "";
        });
        var values = normalizeBankValues(raw);
        var errors = validateBankValues(values);
        if (errors.length > 0) {
          showBankErrors(errors);
          return;
        }

        if (bankSubmit) bankSubmit.disabled = true;
        if (bankStatus) {
          bankStatus.textContent = localeString("bank_submitting");
          bankStatus.hidden = false;
        }

        var body = buildBankRequestBody({
          campaignCode: code,
          shopifyVariantId: state.variant.id,
          values: values,
          // ONLY true because the checkbox was actually ticked —
          // `state.acknowledged` is set nowhere else, and `canSubmitOrder`
          // above already refused to get here without it.
          acknowledged: state.acknowledged === true,
        });

        fetch("/apps/carat/group-buy-bank-checkout", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          credentials: "same-origin",
          body: JSON.stringify(body),
        })
          .then(function (response) {
            return response
              .json()
              .catch(function () {
                return null;
              })
              .then(function (parsed) {
                return { ok: response.ok, status: response.status, body: parsed };
              });
          })
          .then(function (result) {
            if (!result.ok || !result.body || !result.body.instructions) {
              if (bankStatus) bankStatus.hidden = true;
              if (bankSubmit) bankSubmit.disabled = false;
              showBankMessage(
                result.ok ? "bank_error_generic" : messageKeyForBankFailure(result.status, result.body)
              );
              return;
            }
            // The order exists. Retire the form so a second submit cannot
            // create a second real, participation-counting order.
            state.bankOrderPlaced = true;
            if (bankStatus) bankStatus.hidden = true;
            renderBankConfirmation(result.body);
            updateOrderControls();
          })
          .catch(function () {
            if (bankStatus) bankStatus.hidden = true;
            if (bankSubmit) bankSubmit.disabled = false;
            showBankMessage("bank_error_network");
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
      normalizeBankValues: normalizeBankValues,
      validateBankValues: validateBankValues,
      buildBankRequestBody: buildBankRequestBody,
      messageKeyForBankFailure: messageKeyForBankFailure,
    },
  };
})();
