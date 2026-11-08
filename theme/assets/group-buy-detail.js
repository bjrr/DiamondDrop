/**
 * Group Buy — campaign detail.
 *
 * ============================================================================
 * ONE STATE OBJECT, EVERY CONTROL READS IT
 * ============================================================================
 * The primary purchase block and the sticky bottom bar are two renderings of
 * the SAME `state`. There is no second state machine, no duplicated
 * "is it buyable" rule and no way for the bar to offer a purchase the main
 * controls would refuse. `render()` paints both from `state`; `canOrder()`
 * is the single predicate both consult.
 *
 * ============================================================================
 * THE BROWSER NEVER DERIVES A PRICE
 * ============================================================================
 * No multiplication by a tier rate, no rounding, no card uplift, no division
 * by 100. Prices arrive from the server as integer minor units already
 * derived by the campaign's frozen pricing path, and `formatMoney` splits the
 * digit string to display them. A float never touches money here.
 *
 * ============================================================================
 * THE BROWSER NEVER CHOOSES A VARIANT
 * ============================================================================
 * It posts what the shopper selected. The server validates against the frozen
 * contract, resolves the exact ring size through a size band it never
 * discloses, finds the mapped variant, confirms it belongs to this campaign
 * and returns ONE Shopify variant id. Disabling impossible pills here is an
 * affordance; the server is the authority, and an unresolvable selection is
 * refused rather than approximated.
 *
 * ============================================================================
 * PURCHASE MECHANISMS ARE THE EXISTING ONES
 * ============================================================================
 * Card: capture the acknowledgment, then Shopify's native /cart/add carrying
 * `properties[_carat_gb_cancel_ack]`. Bank: no acknowledgment id in the
 * browser at all — the dedicated Group Buy bank endpoint writes the evidence
 * itself, bound to the authenticated customer. Those mechanisms differ
 * because the two order-creation paths differ, and unifying them for visual
 * symmetry would weaken one of them.
 *
 * No framework. No carousel library. Scroll-snap and a few event listeners.
 */
(function () {
  "use strict";

  /* ====================================================================
     Pure helpers
     ==================================================================== */

  /**
   * Minor units to a display string, using the shop's own money format.
   * Integer/string manipulation only — never `Number(minorUnits) / 100`.
   */
  function formatMoney(minorUnits, moneyFormat) {
    var digits = String(minorUnits == null ? "" : minorUnits).replace(/[^0-9]/g, "");
    if (digits === "") return "";
    while (digits.length < 3) digits = "0" + digits;

    var whole = digits.slice(0, -2);
    var cents = digits.slice(-2);
    var grouped = "";
    for (var i = 0; i < whole.length; i++) {
      if (i > 0 && (whole.length - i) % 3 === 0) grouped += ",";
      grouped += whole.charAt(i);
    }

    var format = moneyFormat || "${{amount}}";
    if (format.indexOf("amount_no_decimals") !== -1) {
      return format.replace(/\{\{\s*amount_no_decimals\s*\}\}/g, grouped);
    }
    return format.replace(/\{\{\s*amount\s*\}\}/g, grouped + "." + cents);
  }

  /** Calm, coarse remaining time. No ticking seconds, no manufactured urgency. */
  function formatRemaining(totalSeconds) {
    if (totalSeconds == null) return "";
    var s = totalSeconds < 0 ? 0 : totalSeconds;
    var days = (s - (s % 86400)) / 86400;
    var afterDays = s - days * 86400;
    var hours = (afterDays - (afterDays % 3600)) / 3600;
    var afterHours = afterDays - hours * 3600;
    var minutes = (afterHours - (afterHours % 60)) / 60;

    function unit(v, n) {
      return v + " " + n + (v === 1 ? "" : "s");
    }
    if (days > 0) return hours > 0 ? unit(days, "day") + " " + unit(hours, "hour") : unit(days, "day");
    if (hours > 0) return minutes > 0 ? unit(hours, "hour") + " " + unit(minutes, "minute") : unit(hours, "hour");
    if (minutes > 0) return unit(minutes, "minute");
    return "less than a minute";
  }

  /**
   * Which values of each option can still be reached, given what is already
   * chosen. Mirrors the server's `selectableValues`; an affordance only.
   */
  function selectableValues(options, selection) {
    var result = {};
    options.optionDimensions.forEach(function (dimension) {
      var reachable = {};
      options.validCombinations.forEach(function (combination) {
        var compatible = Object.keys(selection).every(function (key) {
          return key === dimension.key || combination.values[key] === selection[key];
        });
        if (!compatible) return;
        var candidate = combination.values[dimension.key];
        if (candidate !== undefined) reachable[candidate] = true;
      });
      result[dimension.key] = dimension.allowedValues
        .map(function (v) {
          return v.value;
        })
        .filter(function (v) {
          return reachable[v] === true;
        });
    });
    return result;
  }

  function isComplete(options, selection) {
    return options.optionDimensions
      .filter(function (d) {
        return d.required;
      })
      .every(function (d) {
        return selection[d.key] !== undefined && selection[d.key] !== "";
      });
  }

  /** Shopify CDN responsive attributes, or nothing for a non-CDN URL. */
  function applyResponsive(img, url, sizes) {
    if (!url || url.indexOf("cdn.shopify.com") === -1) return;
    var sep = url.indexOf("?") === -1 ? "?" : "&";
    img.setAttribute(
      "srcset",
      [400, 600, 800, 1200, 1600]
        .map(function (w) {
          return url + sep + "width=" + w + " " + w + "w";
        })
        .join(", ")
    );
    img.setAttribute("sizes", sizes);
  }

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  /* ====================================================================
     Component
     ==================================================================== */

  function init(root) {
    var cfg = {
      bootstrapBase: root.getAttribute("data-bootstrap-base"),
      resolveBase: root.getAttribute("data-resolve-base"),
      hubEndpoint: root.getAttribute("data-hub-endpoint"),
      ackEndpoint: root.getAttribute("data-ack-endpoint"),
      bankEndpoint: root.getAttribute("data-bank-endpoint"),
      hubUrl: root.getAttribute("data-hub-url"),
      cartAddUrl: root.getAttribute("data-cart-add-url"),
      cartUrl: root.getAttribute("data-cart-url"),
      loginUrl: root.getAttribute("data-login-url"),
      moneyFormat: root.getAttribute("data-money-format"),
      signedIn: root.getAttribute("data-signed-in") === "true",
    };

    var code = new URLSearchParams(window.location.search).get("campaign");
    var stateNode = root.querySelector("[data-carat-gb-state]");
    var body = root.querySelector("[data-carat-gb-body]");
    var sticky = root.querySelector("[data-carat-gb-sticky]");

    // ONE PAGE, TWO VIEWS. The hub and the detail are both sections on
    // /pages/group-buy, and the URL decides which one is the page. Neither
    // redirects: a redirect between two sections of the same page is a loop
    // waiting to happen, and Shopify caches section output so neither can
    // know at render time. Each simply stands down when the other is in
    // charge.
    if (!code) {
      var detailSection = root.closest(".shopify-section") || root;
      detailSection.hidden = true;
      return;
    }

    /** The single source of truth. Both the main block and the bar read it. */
    var state = {
      campaign: null,
      options: null,
      selection: {},
      /** Server-resolved: { shopifyVariantId, price } or null. */
      resolved: null,
      resolving: false,
      resolveError: null,
      unavailable: false,
      paymentType: null, // never preselected
      acknowledged: false,
      ackId: null,
      submitting: false,
      submitError: null,
    };

    /** Guards against a slow earlier response overwriting a later selection. */
    var resolveSeq = 0;
    var resolveAbort = null;

    /* ---------------------------------------------------------------- */

    function fail(message) {
      stateNode.textContent = message;
      stateNode.hidden = false;
      body.hidden = true;
    }

    function canOrder() {
      if (!cfg.signedIn) return false;
      if (!state.resolved) return false;
      if (state.resolving || state.submitting) return false;
      if (!state.acknowledged) return false;
      return state.paymentType === "card" || state.paymentType === "bank";
    }

    /** What the CTA should say, and what pressing it should do about it. */
    function ctaState() {
      if (!state.options) return { label: "Loading…", action: null, disabled: true };
      if (!isComplete(state.options, state.selection)) {
        return { label: "Choose options", action: "focus-options", disabled: false };
      }
      if (state.resolving) return { label: "Checking price…", action: null, disabled: true };
      if (state.unavailable) return { label: "Unavailable", action: null, disabled: true };
      if (!state.paymentType) {
        return { label: "Choose payment method", action: "focus-payment", disabled: false };
      }
      if (!state.acknowledged) return { label: "Confirm to continue", action: "focus-ack", disabled: false };
      if (!cfg.signedIn) return { label: "Sign in to join", action: "sign-in", disabled: false };
      if (state.submitting) return { label: "Working…", action: null, disabled: true };
      return {
        label: state.paymentType === "bank" ? "Place Group Buy Order" : "Join the Group Buy",
        action: "order",
        disabled: false,
      };
    }

    /* ------------------------------------------------- server resolution */

    function resolve() {
      if (!state.options || !isComplete(state.options, state.selection)) {
        state.resolved = null;
        state.unavailable = false;
        state.resolveError = null;
        render();
        return;
      }

      var seq = ++resolveSeq;
      if (resolveAbort) resolveAbort.abort();
      resolveAbort = typeof AbortController === "function" ? new AbortController() : null;

      state.resolving = true;
      state.resolveError = null;
      // The previous price is no longer authoritative for what is selected,
      // and leaving it looking current while a different configuration is in
      // flight is the specific thing to avoid.
      state.unavailable = false;
      render();

      var url =
        cfg.resolveBase +
        "/" +
        encodeURIComponent(code) +
        "?selection=" +
        encodeURIComponent(JSON.stringify(state.selection));

      fetch(url, {
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        signal: resolveAbort ? resolveAbort.signal : undefined,
      })
        .then(function (response) {
          if (!response.ok && response.status !== 200) throw new Error("status " + response.status);
          return response.json();
        })
        .then(function (payload) {
          // A slower earlier response must never overwrite a later selection.
          if (seq !== resolveSeq) return;
          state.resolving = false;
          if (payload && payload.available === true) {
            state.resolved = { shopifyVariantId: payload.shopifyVariantId, price: payload.price };
            state.unavailable = false;
          } else {
            state.resolved = null;
            state.unavailable = true;
          }
          render();
        })
        .catch(function (error) {
          if (error && error.name === "AbortError") return;
          if (seq !== resolveSeq) return;
          state.resolving = false;
          state.resolved = null;
          // Local, recoverable: selections stay, the rest of the page stays.
          state.resolveError = "We couldn't load the price. Try again.";
          render();
        });
    }

    /* ----------------------------------------------------- acknowledgment */

    /**
     * CARD captures evidence NOW and carries the returned id on the cart
     * line, because native Shopify checkout creates the order and the
     * evidence has to exist before the order does.
     *
     * BANK captures nothing here — no call, no id in the browser. The bank
     * endpoint writes the Acknowledgment row itself, in the same transaction
     * as the order, bound to the authenticated customer. Sending a
     * browser-held id there would be a browser-supplied identity the route is
     * right to refuse.
     */
    function onAckChange(checked) {
      state.acknowledged = checked;
      state.submitError = null;

      if (!checked || state.paymentType !== "card" || state.ackId) {
        render();
        return;
      }
      if (!state.resolved) {
        render();
        return;
      }

      fetch(cfg.ackEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          campaignCode: code,
          shopifyVariantId: state.resolved.shopifyVariantId,
        }),
      })
        .then(function (response) {
          if (!response.ok) throw new Error("status " + response.status);
          return response.json();
        })
        .then(function (payload) {
          state.ackId = (payload && (payload.acknowledgmentId || payload.id)) || null;
          render();
        })
        .catch(function () {
          // The tick stands, but without an id the Card path cannot proceed;
          // say so rather than failing silently at cart-add.
          state.ackId = null;
          state.submitError = "We couldn't record your confirmation. Please try again.";
          render();
        });
    }

    /* --------------------------------------------------------- purchasing */

    function joinWithCard() {
      if (!canOrder() || !state.resolved) return;
      if (!state.ackId) {
        state.submitError = "We couldn't record your confirmation. Please try again.";
        render();
        return;
      }
      state.submitting = true;
      state.submitError = null;
      render();

      // SHOPIFY'S NATIVE CART, unchanged — including the existing
      // acknowledgment line property.
      fetch(cfg.cartAddUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        credentials: "same-origin",
        body: JSON.stringify({
          id: state.resolved.shopifyVariantId,
          quantity: 1,
          properties: { _carat_gb_cancel_ack: state.ackId },
        }),
      })
        .then(function (response) {
          if (!response.ok) throw new Error("status " + response.status);
          window.location = cfg.cartUrl;
        })
        .catch(function () {
          state.submitting = false;
          state.submitError = "We couldn't add this to your cart. Please try again.";
          render();
        });
    }

    /* ------------------------------------------------------------ sheets */

    var sheet = root.querySelector("[data-carat-gb-sheet]");
    var sheetTitle = root.querySelector("[data-carat-gb-sheet-title]");
    var sheetBody = root.querySelector("[data-carat-gb-sheet-body]");
    var sheetReturnFocus = null;

    function openSheet(title, contentNode, opener) {
      sheetTitle.textContent = title;
      sheetBody.innerHTML = "";
      sheetBody.appendChild(contentNode);
      sheet.hidden = false;
      sheet.setAttribute("data-open", "true");
      sheetReturnFocus = opener || null;
      var closeButton = root.querySelector("[data-carat-gb-sheet-close]");
      if (closeButton) closeButton.focus();
      document.addEventListener("keydown", onSheetKeydown);
    }

    function closeSheet() {
      sheet.setAttribute("data-open", "false");
      sheet.hidden = true;
      document.removeEventListener("keydown", onSheetKeydown);
      if (sheetReturnFocus && sheetReturnFocus.focus) sheetReturnFocus.focus();
      sheetReturnFocus = null;
    }

    function onSheetKeydown(event) {
      if (event.key === "Escape") closeSheet();
    }

    root.querySelector("[data-carat-gb-sheet-close]").addEventListener("click", closeSheet);
    root.querySelector("[data-carat-gb-sheet-scrim]").addEventListener("click", closeSheet);

    /* ====================================================================
       Rendering
       ==================================================================== */

    function renderGallery() {
      var campaign = state.campaign;
      var images = [];
      // Mobile hero first where configured, otherwise the hero; then gallery.
      var lead = campaign.mobileHeroImage || campaign.heroImage;
      if (lead) images.push(lead);
      (campaign.galleryImages || []).forEach(function (image) {
        images.push(image);
      });
      if (images.length === 0) return null;

      var wrap = el("div", "gb-gallery");
      var track = el("div", "gb-gallery__track");
      track.setAttribute("role", "group");
      track.setAttribute("aria-label", "Campaign images");

      images.forEach(function (image, index) {
        var slide = el("div", "gb-gallery__slide");
        var img = el("img", "gb-gallery__img");
        img.setAttribute("src", image.url);
        // Shopify's own alt text, preserved.
        img.setAttribute("alt", image.altText || "");
        img.setAttribute("width", "1000");
        img.setAttribute("height", "1000");
        // The first image is the LCP candidate; the rest wait.
        img.setAttribute("loading", index === 0 ? "eager" : "lazy");
        img.setAttribute("decoding", index === 0 ? "sync" : "async");
        if (index === 0) img.setAttribute("fetchpriority", "high");
        applyResponsive(img, image.url, "(min-width: 990px) 50vw, 100vw");
        slide.appendChild(img);
        track.appendChild(slide);
      });

      wrap.appendChild(track);

      if (images.length > 1) {
        var count = el("p", "gb-gallery__count", "1 / " + images.length);
        var dots = el("div", "gb-gallery__dots");
        images.forEach(function (image, index) {
          var dot = el("button", "gb-gallery__dot");
          dot.type = "button";
          dot.setAttribute("aria-label", "Image " + (index + 1) + " of " + images.length);
          dot.setAttribute("aria-current", index === 0 ? "true" : "false");
          dot.addEventListener("click", function () {
            track.scrollTo({ left: track.clientWidth * index, behavior: "smooth" });
          });
          dots.appendChild(dot);
        });

        // The customer drives the gallery. Nothing advances on its own.
        track.addEventListener("scroll", function () {
          var width = track.clientWidth || 1;
          var active = Math.round(track.scrollLeft / width);
          count.textContent = active + 1 + " / " + images.length;
          var all = dots.querySelectorAll(".gb-gallery__dot");
          for (var i = 0; i < all.length; i++) {
            all[i].setAttribute("aria-current", i === active ? "true" : "false");
          }
        });

        wrap.appendChild(dots);
        wrap.appendChild(count);
      }

      return wrap;
    }

    function renderOptions(container) {
      var options = state.options;
      if (!options) return;
      var reachable = selectableValues(options, state.selection);

      options.optionDimensions.forEach(function (dimension) {
        var field = el("fieldset", "gb-option");
        field.setAttribute("data-option-key", dimension.key);

        var legend = el("legend", "gb-option__legend");
        legend.appendChild(document.createTextNode(dimension.label + " "));
        var chosenValue = state.selection[dimension.key];
        if (chosenValue) {
          var chosenLabel = dimension.allowedValues.filter(function (v) {
            return v.value === chosenValue;
          })[0];
          legend.appendChild(el("span", "gb-option__chosen", chosenLabel ? chosenLabel.label : chosenValue));
        }
        field.appendChild(legend);

        // A long list (ring sizes) gets a sheet; a short one gets pills.
        if (dimension.allowedValues.length > 8) {
          var opener = el("button", "gb-select-row");
          opener.type = "button";
          opener.appendChild(
            el("span", "gb-select-row__value", chosenValue ? legendTextFor(dimension, chosenValue) : "Choose " + dimension.label.toLowerCase())
          );
          opener.appendChild(el("span", null, "›"));
          opener.addEventListener("click", function () {
            openSheet(dimension.label, buildSheetList(dimension, reachable[dimension.key] || []), opener);
          });
          field.appendChild(opener);
        } else {
          var pills = el("div", "gb-pills");
          dimension.allowedValues.forEach(function (value) {
            var pill = el("button", "gb-pill", value.label);
            pill.type = "button";
            var allowed = (reachable[dimension.key] || []).indexOf(value.value) !== -1;
            pill.setAttribute("aria-pressed", chosenValue === value.value ? "true" : "false");
            if (!allowed && chosenValue !== value.value) {
              pill.disabled = true;
              pill.setAttribute("aria-disabled", "true");
              pill.setAttribute("title", "Not available with your other choices");
            }
            pill.addEventListener("click", function () {
              choose(dimension.key, value.value);
            });
            pills.appendChild(pill);
          });
          field.appendChild(pills);
        }

        container.appendChild(field);
      });
    }

    function legendTextFor(dimension, value) {
      var match = dimension.allowedValues.filter(function (v) {
        return v.value === value;
      })[0];
      return match ? match.label : value;
    }

    function buildSheetList(dimension, allowedValues) {
      var list = el("ul", "gb-sheet__list");
      dimension.allowedValues.forEach(function (value) {
        var item = document.createElement("li");
        var pill = el("button", "gb-pill", value.label);
        pill.type = "button";
        var allowed = allowedValues.indexOf(value.value) !== -1;
        pill.setAttribute("aria-pressed", state.selection[dimension.key] === value.value ? "true" : "false");
        if (!allowed && state.selection[dimension.key] !== value.value) {
          pill.disabled = true;
          pill.setAttribute("aria-disabled", "true");
        }
        pill.addEventListener("click", function () {
          choose(dimension.key, value.value);
          closeSheet();
        });
        item.appendChild(pill);
        list.appendChild(item);
      });
      return list;
    }

    function choose(key, value) {
      if (state.selection[key] === value) delete state.selection[key];
      else state.selection[key] = value;

      // Changing an option can strand a later one. Drop any selection that is
      // no longer reachable, rather than silently resolving an impossible
      // combination.
      var reachable = selectableValues(state.options, state.selection);
      Object.keys(state.selection).forEach(function (otherKey) {
        if (otherKey === key) return;
        if ((reachable[otherKey] || []).indexOf(state.selection[otherKey]) === -1) {
          delete state.selection[otherKey];
        }
      });

      // The configuration changed, so any captured Card acknowledgment is for
      // a different variant. Re-tick is required.
      state.ackId = null;
      resolve();
    }

    function renderPrice(container) {
      var block = el("div", "gb-price");
      block.setAttribute("data-loading", state.resolving ? "true" : "false");
      block.setAttribute("aria-live", "polite");

      var complete = state.options && isComplete(state.options, state.selection);
      var price = state.resolved ? state.resolved.price : state.campaign.progress;

      block.appendChild(
        el("p", "gb-price__label", complete && state.resolved ? "Your Group Buy Price" : "From")
      );

      var amountText = "";
      if (state.resolved) {
        amountText =
          state.paymentType === "bank"
            ? formatMoney(state.resolved.price.groupBuyBankPaymentPriceMinorUnits, cfg.moneyFormat)
            : formatMoney(state.resolved.price.groupBuyRegularCardPriceMinorUnits, cfg.moneyFormat);
      } else if (state.campaign.progress) {
        amountText = formatMoney(
          state.campaign.progress.groupBuyRegularCardPriceMinorUnits,
          cfg.moneyFormat
        );
      }
      block.appendChild(el("p", "gb-price__amount", amountText));

      if (state.resolved) {
        block.appendChild(
          el(
            "p",
            "gb-price__alt",
            state.paymentType === "bank"
              ? "Regular/Card Price " +
                  formatMoney(state.resolved.price.groupBuyRegularCardPriceMinorUnits, cfg.moneyFormat)
              : "Bank Payment Price " +
                  formatMoney(state.resolved.price.groupBuyBankPaymentPriceMinorUnits, cfg.moneyFormat)
          )
        );
      }

      if (state.unavailable) {
        block.appendChild(
          el("p", "gb-price__error", "This configuration is currently unavailable. Try a different option.")
        );
      }
      if (state.resolveError) {
        var err = el("p", "gb-price__error");
        err.appendChild(document.createTextNode(state.resolveError + " "));
        var retry = el("button", "link", "Try again");
        retry.type = "button";
        retry.addEventListener("click", resolve);
        err.appendChild(retry);
        block.appendChild(err);
      }

      container.appendChild(block);
      void price;
    }

    function renderProgress(container) {
      var price = state.resolved ? state.resolved.price : state.campaign.progress;
      if (!price) return;

      var block = el("div", "gb-progress");
      block.setAttribute("aria-live", "polite");
      block.appendChild(
        el(
          "p",
          "gb-progress__joined",
          price.qualifyingUnitsSold + (price.qualifyingUnitsSold === 1 ? " piece joined" : " pieces joined")
        )
      );

      if (price.bestPriceUnlocked) {
        var badge = el("span", "gb-badge gb-badge--best", "Best Price Unlocked");
        block.appendChild(badge);
      } else if (price.unitsToNextTier != null && price.nextTierRegularCardPriceMinorUnits) {
        block.appendChild(
          el(
            "p",
            "gb-progress__next",
            price.unitsToNextTier +
              (price.unitsToNextTier === 1 ? " more buyer unlocks " : " more buyers unlock ") +
              formatMoney(price.nextTierRegularCardPriceMinorUnits, cfg.moneyFormat)
          )
        );
      }

      if (price.tierMarkers && price.tierMarkers.length) {
        var track = el("ul", "gb-tiers");
        price.tierMarkers.forEach(function (marker) {
          var step = el("li", "gb-tiers__step");
          step.setAttribute(
            "data-state",
            marker.current ? "current" : marker.unlocked ? "unlocked" : "locked"
          );
          step.appendChild(el("span", "gb-tiers__bar"));
          step.appendChild(
            document.createTextNode(
              marker.minQualifyingUnits + "+ " + (marker.current ? "●" : marker.unlocked ? "✓" : "○")
            )
          );
          track.appendChild(step);
        });
        block.appendChild(track);

        var viewAll = el("button", "link", "View all price tiers");
        viewAll.type = "button";
        viewAll.addEventListener("click", function () {
          openSheet("Price tiers", buildTierSheet(price), viewAll);
        });
        block.appendChild(viewAll);
      }

      if (price.secondsRemaining != null) {
        var countdown = el("p", "gb-countdown");
        countdown.appendChild(document.createTextNode("Group Buy closes in "));
        countdown.appendChild(el("strong", null, formatRemaining(price.secondsRemaining)));
        block.appendChild(countdown);
      }

      container.appendChild(block);
    }

    function buildTierSheet(price) {
      var list = el("div", "gb-details");
      price.tierMarkers.forEach(function (marker) {
        var row = el("div", "gb-details__row");
        row.appendChild(
          el(
            "span",
            "gb-details__key",
            marker.minQualifyingUnits + "+ pieces" + (marker.current ? " (current)" : "")
          )
        );
        row.appendChild(
          el("span", "gb-details__val", formatMoney(marker.regularCardPriceMinorUnits, cfg.moneyFormat))
        );
        list.appendChild(row);
      });
      return list;
    }

    function renderPayment(container) {
      var block = el("div", "gb-pay");
      block.setAttribute("data-carat-gb-payment", "");
      block.appendChild(el("p", "gb-option__legend", "Payment method"));

      var group = el("div", "gb-pay__options");
      group.setAttribute("role", "group");
      group.setAttribute("aria-label", "Payment method");

      [
        { id: "card", label: "Credit / Debit Card" },
        { id: "bank", label: "Bank Payment" },
      ].forEach(function (option) {
        var button = el("button", "gb-pay__option", option.label);
        button.type = "button";
        // Never preselected: the customer chooses explicitly.
        button.setAttribute("aria-pressed", state.paymentType === option.id ? "true" : "false");
        button.addEventListener("click", function () {
          state.paymentType = option.id;
          // The two paths capture acknowledgment differently, so a captured
          // Card id is meaningless once the shopper switches to Bank.
          state.ackId = null;
          state.acknowledged = false;
          render();
        });
        group.appendChild(button);
      });

      block.appendChild(group);
      container.appendChild(block);
    }

    function renderDetails(container) {
      var campaign = state.campaign;
      if ((campaign.highlights || []).length) {
        var list = el("ul", "gb-highlights");
        campaign.highlights.forEach(function (highlight) {
          list.appendChild(el("li", null, highlight));
        });
        container.appendChild(list);
      }
      if ((campaign.displayDetails || []).length) {
        var section = el("section", "gb-section");
        section.appendChild(el("h2", "gb-section__title", "Details"));
        var rows = el("div", "gb-details");
        campaign.displayDetails.forEach(function (detail) {
          var row = el("div", "gb-details__row");
          row.appendChild(el("span", "gb-details__key", detail.label));
          row.appendChild(el("span", "gb-details__val", detail.value));
          rows.appendChild(row);
        });
        section.appendChild(rows);
        container.appendChild(section);
      }
    }

    function renderShare(container) {
      var block = el("div", "gb-share");
      var shareUrl = window.location.href;
      var button = el("button", "button button--secondary", "Share Group Buy");
      button.type = "button";
      button.addEventListener("click", function () {
        var data = { title: state.campaign.headline, url: shareUrl };
        if (navigator.share) {
          navigator.share(data).catch(function () {
            /* Dismissed by the customer. Nothing to report. */
          });
          return;
        }
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(shareUrl).then(
            function () {
              button.textContent = "Link copied";
            },
            function () {
              button.textContent = "Copy failed";
            }
          );
          return;
        }
        button.textContent = shareUrl;
      });
      block.appendChild(button);
      block.appendChild(
        el(
          "p",
          "gb-share__note",
          "Invite friends — more buyers can unlock a lower price for everyone."
        )
      );
      container.appendChild(block);
    }

    function renderRelated(container) {
      fetch(cfg.hubEndpoint, { headers: { Accept: "application/json" }, credentials: "same-origin" })
        .then(function (response) {
          if (!response.ok) throw new Error("status " + response.status);
          return response.json();
        })
        .then(function (payload) {
          var others = ((payload && payload.campaigns) || [])
            .filter(function (c) {
              return c.code !== code;
            })
            .slice(0, 3);
          if (others.length === 0) return;

          var section = el("section", "gb-section");
          section.appendChild(el("h2", "gb-section__title", "Explore More Group Buys"));
          var grid = el("ul", "gb-hub__grid");
          others.forEach(function (other) {
            var item = document.createElement("li");
            item.className = "gb-card";
            var link = el("a", "gb-card__link");
            link.setAttribute("href", other.detailUrl);
            if (other.cardImage) {
              var media = el("span", "gb-card__media");
              var img = el("img", "gb-card__image");
              img.setAttribute("src", other.cardImage.url);
              img.setAttribute("alt", other.cardImage.altText || "");
              img.setAttribute("loading", "lazy");
              applyResponsive(img, other.cardImage.url, "(min-width: 990px) 30vw, 92vw");
              media.appendChild(img);
              link.appendChild(media);
            }
            item.appendChild(link);
            var bodyEl = el("div", "gb-card__body");
            var title = el("h3", "gb-card__title");
            var titleLink = el("a", "gb-card__link", other.headline);
            titleLink.setAttribute("href", other.detailUrl);
            title.appendChild(titleLink);
            bodyEl.appendChild(title);
            if (other.fromRegularCardPriceMinorUnits) {
              bodyEl.appendChild(
                el(
                  "p",
                  "gb-card__price",
                  "From " + formatMoney(other.fromRegularCardPriceMinorUnits, cfg.moneyFormat)
                )
              );
            }
            item.appendChild(bodyEl);
            grid.appendChild(item);
          });
          section.appendChild(grid);
          body.appendChild(section);
        })
        .catch(function () {
          /* Related campaigns are a nicety; their absence is not an error. */
        });
      void container;
    }

    /* ------------------------------------------------------------ render */

    function render() {
      if (!state.campaign) return;
      var campaign = state.campaign;

      body.innerHTML = "";
      stateNode.hidden = true;
      body.hidden = false;

      var layout = el("div", "gb-detail__layout");
      var media = el("div", "gb-detail__media");
      var buy = el("div", "gb-detail__buy");

      var gallery = renderGallery();
      if (gallery) media.appendChild(gallery);

      buy.appendChild(el("p", "gb__eyebrow", campaign.productType ? "Group Buy · " + campaign.productType : "Group Buy"));
      buy.appendChild(el("h1", "gb__headline", campaign.headline));
      if (campaign.shortDescription) buy.appendChild(el("p", "gb__sub", campaign.shortDescription));

      if (campaign.status === "closed") {
        var closed = el("div", "gb-closed");
        closed.appendChild(el("h2", "gb-closed__title", "Campaign Closed"));
        closed.appendChild(
          el("p", null, "This Group Buy has ended. The pieces below are no longer available to join.")
        );
        var links = el("div", "gb-hub__empty-links");
        var toActive = el("a", "button button--secondary", "View Active Group Buys");
        toActive.setAttribute("href", cfg.hubUrl);
        links.appendChild(toActive);
        var toPast = el("a", "button button--secondary", "Past Group Buys");
        toPast.setAttribute("href", "/pages/past-group-buys");
        links.appendChild(toPast);
        var toCustom = el("a", "button button--secondary", "Design Something Custom");
        toCustom.setAttribute("href", "/pages/custom-jewelry");
        links.appendChild(toCustom);
        closed.appendChild(links);
        buy.appendChild(closed);
      } else {
        renderPrice(buy);
        renderProgress(buy);

        var config = el("div", "gb-config");
        config.setAttribute("data-carat-gb-config", "");
        renderOptions(config);
        buy.appendChild(config);

        renderPayment(buy);

        // The acknowledgment sits immediately above the CTA, using the
        // owner-approved copy rendered by Liquid.
        var ackTemplate = root.querySelector("[data-carat-gb-ack-template]");
        var ackNode = ackTemplate.content.firstElementChild.cloneNode(true);
        var ackBox = ackNode.querySelector("[data-carat-gb-ack]");
        ackBox.checked = state.acknowledged;
        ackBox.addEventListener("change", function () {
          onAckChange(ackBox.checked);
        });
        ackNode.setAttribute("data-carat-gb-ack-row", "");
        buy.appendChild(ackNode);

        var cta = ctaState();
        var ctaButton = el("button", "button gb-cta", cta.label);
        ctaButton.type = "button";
        ctaButton.disabled = cta.disabled;
        ctaButton.addEventListener("click", function () {
          handleCta(cta.action);
        });
        buy.appendChild(ctaButton);

        if (state.submitError) {
          var submitError = el("p", "gb-price__error", state.submitError);
          submitError.setAttribute("role", "alert");
          buy.appendChild(submitError);
        }

        if (!cfg.signedIn) {
          buy.appendChild(
            el("p", "gb-share__note", "You can browse and configure freely. Signing in is only needed to join.")
          );
        }

        renderShare(buy);
      }

      layout.appendChild(media);
      layout.appendChild(buy);
      body.appendChild(layout);

      var tail = el("div", "gb-detail__tail");
      renderDetails(tail);
      var howTemplate = root.querySelector("[data-carat-gb-how-template]");
      tail.appendChild(howTemplate.content.cloneNode(true));
      body.appendChild(tail);

      renderRelated(tail);
      renderSticky();
    }

    function renderSticky() {
      if (!state.campaign || state.campaign.status === "closed") {
        sticky.hidden = true;
        return;
      }
      sticky.hidden = false;
      sticky.setAttribute("data-visible", "true");

      var amount = root.querySelector("[data-carat-gb-sticky-amount]");
      var label = root.querySelector("[data-carat-gb-sticky-label]");
      var button = root.querySelector("[data-carat-gb-sticky-cta]");

      // THE SAME STATE as the main controls — same price, same predicate,
      // same label. The bar is a second rendering, not a second machine.
      if (state.resolved) {
        amount.textContent =
          state.paymentType === "bank"
            ? formatMoney(state.resolved.price.groupBuyBankPaymentPriceMinorUnits, cfg.moneyFormat)
            : formatMoney(state.resolved.price.groupBuyRegularCardPriceMinorUnits, cfg.moneyFormat);
        label.textContent = "Your Group Buy Price";
      } else if (state.campaign.progress) {
        amount.textContent = formatMoney(
          state.campaign.progress.groupBuyRegularCardPriceMinorUnits,
          cfg.moneyFormat
        );
        label.textContent = "From";
      } else {
        amount.textContent = "";
        label.textContent = "";
      }

      var cta = ctaState();
      button.textContent = cta.label;
      button.disabled = cta.disabled;
      button.onclick = function () {
        handleCta(cta.action);
      };
    }

    function handleCta(action) {
      if (action === "focus-options") {
        var firstMissing = null;
        state.options.optionDimensions.some(function (dimension) {
          if (dimension.required && !state.selection[dimension.key]) {
            firstMissing = body.querySelector('[data-option-key="' + dimension.key + '"]');
            return true;
          }
          return false;
        });
        if (firstMissing) {
          firstMissing.scrollIntoView({ behavior: "smooth", block: "center" });
          var focusable = firstMissing.querySelector("button:not([disabled])");
          if (focusable) focusable.focus();
        }
        return;
      }
      if (action === "focus-payment") {
        var payment = body.querySelector("[data-carat-gb-payment] button");
        if (payment) {
          payment.scrollIntoView({ behavior: "smooth", block: "center" });
          payment.focus();
        }
        return;
      }
      if (action === "focus-ack") {
        var ack = body.querySelector("[data-carat-gb-ack]");
        if (ack) {
          ack.scrollIntoView({ behavior: "smooth", block: "center" });
          ack.focus();
        }
        return;
      }
      if (action === "sign-in") {
        // Come back to exactly this campaign after signing in.
        window.location = cfg.loginUrl + "?return_url=" + encodeURIComponent(window.location.pathname + window.location.search);
        return;
      }
      if (action === "order") {
        if (state.paymentType === "card") joinWithCard();
        else openBankSheet();
      }
    }

    /* -------------------------------------------------------- bank order */

    /**
     * The DEDICATED Group Buy bank path, unchanged: the same endpoint, the
     * same payload, and no acknowledgment id in the browser —
     * `cancellationAcknowledgmentAccepted` only, with the server writing the
     * evidence itself against the authenticated customer.
     */
    function openBankSheet() {
      if (!canOrder() || !state.resolved) return;

      var form = document.createElement("form");
      form.className = "gb-bank-form";

      var fields = [
        { name: "email", label: "Email", type: "email", required: true },
        { name: "address1", label: "Address", type: "text", required: true },
        { name: "address2", label: "Apartment, suite (optional)", type: "text", required: false },
        { name: "city", label: "City", type: "text", required: true },
        { name: "province", label: "State / Province (optional)", type: "text", required: false },
        { name: "zip", label: "ZIP / Postal code", type: "text", required: true },
        { name: "countryCode", label: "Country code (e.g. US)", type: "text", required: true },
      ];

      fields.forEach(function (field) {
        var label = el("label", "gb-option__legend", field.label);
        label.setAttribute("for", "gb-bank-" + field.name);
        var input = document.createElement("input");
        input.id = "gb-bank-" + field.name;
        input.name = field.name;
        input.type = field.type;
        if (field.required) input.required = true;
        input.className = "gb-select-row";
        form.appendChild(label);
        form.appendChild(input);
      });

      var error = el("p", "gb-price__error");
      error.setAttribute("role", "alert");
      error.hidden = true;
      form.appendChild(error);

      var submit = el("button", "button gb-cta", "Place Group Buy Order");
      submit.type = "submit";
      form.appendChild(submit);

      form.addEventListener("submit", function (event) {
        event.preventDefault();
        if (state.submitting) return; // no duplicate submission
        state.submitting = true;
        submit.disabled = true;
        error.hidden = true;

        var values = {};
        fields.forEach(function (field) {
          values[field.name] = (form.querySelector("#gb-bank-" + field.name) || {}).value || "";
        });

        var address = {
          address1: values.address1,
          city: values.city,
          zip: values.zip,
          countryCode: values.countryCode,
        };
        if (values.address2) address.address2 = values.address2;
        if (values.province) address.province = values.province;

        fetch(cfg.bankEndpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          credentials: "same-origin",
          body: JSON.stringify({
            mode: "bank",
            campaignCode: code,
            email: values.email,
            shippingAddress: address,
            lines: [{ shopifyVariantId: String(state.resolved.shopifyVariantId), quantity: 1 }],
            cancellationAcknowledgmentAccepted: state.acknowledged === true,
          }),
        })
          .then(function (response) {
            if (!response.ok) throw new Error("status " + response.status);
            return response.json();
          })
          .then(function () {
            window.location = "/pages/bank-payment-orders";
          })
          .catch(function () {
            state.submitting = false;
            submit.disabled = false;
            // Never a raw server detail.
            error.textContent = "We couldn't place that order. Please check your details and try again.";
            error.hidden = false;
          });
      });

      openSheet("Bank Payment order", form, null);
    }

    /* ------------------------------------------------------------- boot */

    var backLink = root.querySelector("[data-carat-gb-back]");
    if (backLink) backLink.setAttribute("href", cfg.hubUrl);

    fetch(cfg.bootstrapBase + "/" + encodeURIComponent(code), {
      headers: { Accept: "application/json" },
      credentials: "same-origin",
    })
      .then(function (response) {
        if (!response.ok) throw new Error("status " + response.status);
        return response.json();
      })
      .then(function (campaign) {
        state.campaign = campaign;
        state.options = campaign.options;
        render();
      })
      .catch(function () {
        fail("This Group Buy could not be loaded. It may have ended, or the link may be incorrect.");
      });
  }

  function boot() {
    var roots = document.querySelectorAll("[data-carat-gb-detail]");
    for (var i = 0; i < roots.length; i++) init(roots[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
