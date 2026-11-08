/**
 * Group Buy hub — renders the campaign cards.
 *
 * ============================================================================
 * ONE REQUEST FOR THE WHOLE PAGE
 * ============================================================================
 * The hub asks /apps/carat/group-buy-campaigns once and renders everything
 * from the answer. It does NOT fetch per campaign, and it certainly does not
 * fetch per variant — the existing campaign page does exactly that to fill
 * its comparison table (one request per variant), which is the pattern this
 * surface was told not to repeat. The server computes each campaign's lowest
 * current-tier price before replying.
 *
 * ============================================================================
 * NO PRICE ARITHMETIC
 * ============================================================================
 * Every figure arrives as integer minor units already derived by the server's
 * own Group Buy pricing path. This file formats them for display using string
 * manipulation only — never `Number(minorUnits) / 100`, which is how a price
 * picks up a float rounding error on its way to a shopper. Same approach as
 * group-buy-campaign.js, deliberately.
 *
 * No framework, no dependencies: this is a list of cards.
 */
(function () {
  "use strict";

  /* ---------------------------------------------------------------- money */

  /**
   * Minor units to a display string, using the shop's own money format.
   *
   * Integer/string manipulation only. The amount is split on its last two
   * digits rather than divided, so no floating point is involved at any point.
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
    // Shopify's money formats differ in whether they show cents. Honour the
    // two common tokens; anything else falls back to the full amount.
    if (format.indexOf("amount_no_decimals") !== -1) {
      return format.replace(/\{\{\s*amount_no_decimals\s*\}\}/g, grouped);
    }
    return format.replace(/\{\{\s*amount\s*\}\}/g, grouped + "." + cents);
  }

  /* ------------------------------------------------------------- countdown */

  /**
   * Seconds to a calm, human remainder: "2 days 14 hours", "6 hours".
   *
   * Deliberately coarse. A ticking second-by-second timer on a jewellery page
   * reads as a pressure tactic, and the requirement was explicit about not
   * manufacturing urgency. Integer arithmetic throughout.
   */
  function formatRemaining(totalSeconds) {
    if (totalSeconds == null) return "";
    var seconds = totalSeconds < 0 ? 0 : totalSeconds;

    var days = (seconds - (seconds % 86400)) / 86400;
    var afterDays = seconds - days * 86400;
    var hours = (afterDays - (afterDays % 3600)) / 3600;
    var afterHours = afterDays - hours * 3600;
    var minutes = (afterHours - (afterHours % 60)) / 60;

    function unit(value, singular) {
      return value + " " + singular + (value === 1 ? "" : "s");
    }

    if (days > 0) return hours > 0 ? unit(days, "day") + " " + unit(hours, "hour") : unit(days, "day");
    if (hours > 0) return minutes > 0 ? unit(hours, "hour") + " " + unit(minutes, "minute") : unit(hours, "hour");
    if (minutes > 0) return unit(minutes, "minute");
    return "less than a minute";
  }

  /* ----------------------------------------------------------------- cards */

  function progressLine(campaign) {
    var pieces = campaign.qualifyingUnitsSold;
    var joined = pieces + (pieces === 1 ? " piece joined" : " pieces joined");

    if (campaign.bestPriceUnlocked) return joined + " · Best price unlocked";

    if (
      campaign.unitsToNextTier != null &&
      campaign.unitsToNextTier > 0 &&
      campaign.nextTierFromRegularCardPriceMinorUnits
    ) {
      return (
        joined +
        " · " +
        campaign.unitsToNextTier +
        " more unlock " +
        formatMoney(campaign.nextTierFromRegularCardPriceMinorUnits, window.__gbMoneyFormat)
      );
    }
    return joined;
  }

  function renderCard(template, campaign, detailBase, moneyFormat) {
    var node = template.content.firstElementChild.cloneNode(true);

    function field(name) {
      return node.querySelector('[data-field="' + name + '"]');
    }

    var href = detailBase + "?campaign=" + encodeURIComponent(campaign.code);
    var link = field("link");
    var titleLink = field("title-link");
    link.setAttribute("href", href);
    titleLink.setAttribute("href", href);
    titleLink.textContent = campaign.headline;

    // The media anchor is decorative — the title anchor carries the accessible
    // name — so it is hidden from assistive technology rather than announcing
    // the same destination twice.
    link.setAttribute("tabindex", "-1");
    link.setAttribute("aria-hidden", "true");

    var image = field("image");
    if (campaign.cardImage && campaign.cardImage.url) {
      image.setAttribute("src", campaign.cardImage.url);
      // Shopify's own alt text, preserved rather than invented.
      image.setAttribute("alt", campaign.cardImage.altText || "");
      // Responsive: Shopify's CDN resizes on the `width` parameter, and the
      // card is one column on a phone, two on a tablet, three on a desktop.
      if (campaign.cardImage.url.indexOf("cdn.shopify.com") !== -1) {
        var sep = campaign.cardImage.url.indexOf("?") === -1 ? "?" : "&";
        image.setAttribute(
          "srcset",
          [400, 600, 800, 1200]
            .map(function (w) {
              return campaign.cardImage.url + sep + "width=" + w + " " + w + "w";
            })
            .join(", ")
        );
        image.setAttribute("sizes", "(min-width: 990px) 30vw, (min-width: 750px) 45vw, 92vw");
      }
    } else {
      // No card image configured: keep the frame, drop the broken <img>.
      image.remove();
    }

    field("label").textContent = campaign.productType
      ? "Group Buy · " + campaign.productType
      : "Group Buy";

    var desc = field("desc");
    if (campaign.shortDescription) desc.textContent = campaign.shortDescription;
    else desc.remove();

    var price = field("price");
    if (campaign.fromRegularCardPriceMinorUnits) {
      price.innerHTML = "";
      price.appendChild(document.createTextNode("From "));
      var strong = document.createElement("strong");
      strong.textContent = formatMoney(campaign.fromRegularCardPriceMinorUnits, moneyFormat);
      price.appendChild(strong);
    } else {
      // Omitted rather than guessed — a campaign with no determinable price
      // still belongs on the page.
      price.remove();
    }

    field("progress").textContent = progressLine(campaign);

    var countdown = field("countdown");
    if (campaign.secondsRemaining != null) {
      countdown.textContent =
        campaign.secondsRemaining > 0 ? "Ends in " + formatRemaining(campaign.secondsRemaining) : "Closing";
    } else {
      countdown.remove();
    }

    field("cta").textContent = "View Group Buy →";

    return node;
  }

  /* ------------------------------------------------------------------ init */

  function init(root) {
    var endpoint = root.getAttribute("data-endpoint");
    var detailBase = root.getAttribute("data-detail-base");
    var moneyFormat = root.getAttribute("data-money-format");
    window.__gbMoneyFormat = moneyFormat;

    var stateNode = root.querySelector("[data-carat-gb-hub-state]");
    var grid = root.querySelector("[data-carat-gb-hub-grid]");
    var cardTemplate = root.querySelector("[data-carat-gb-card-template]");
    var emptyTemplate = root.querySelector("[data-carat-gb-empty-template]");

    function fail(message) {
      // An honest failure, never a permanent "Loading".
      stateNode.textContent = message;
      stateNode.hidden = false;
      grid.hidden = true;
    }

    fetch(endpoint, { headers: { Accept: "application/json" }, credentials: "same-origin" })
      .then(function (response) {
        if (!response.ok) throw new Error("status " + response.status);
        return response.json();
      })
      .then(function (payload) {
        var campaigns = (payload && payload.campaigns) || [];

        if (campaigns.length === 0) {
          stateNode.hidden = true;
          grid.hidden = true;
          root.appendChild(emptyTemplate.content.cloneNode(true));
          return;
        }

        var fragment = document.createDocumentFragment();
        campaigns.forEach(function (campaign) {
          fragment.appendChild(renderCard(cardTemplate, campaign, detailBase, moneyFormat));
        });

        grid.innerHTML = "";
        grid.appendChild(fragment);
        stateNode.hidden = true;
        grid.hidden = false;

        // Returning from a campaign should land where the shopper left off.
        // Restored after the cards exist, because the page has no height
        // until then.
        restoreScroll(root);
      })
      .catch(function () {
        fail("Group Buys could not be loaded just now. Please refresh to try again.");
      });

    // Remember the scroll position when leaving for a campaign, so Back does
    // not dump the shopper at the top of a list they had scrolled through.
    root.addEventListener("click", function (event) {
      var link = event.target.closest ? event.target.closest("a[href]") : null;
      if (!link) return;
      try {
        sessionStorage.setItem("caratGbHubScroll", String(window.scrollY));
      } catch (e) {
        /* Private mode: the hub still works, it just forgets the position. */
      }
    });
  }

  function restoreScroll(root) {
    var saved = null;
    try {
      saved = sessionStorage.getItem("caratGbHubScroll");
      sessionStorage.removeItem("caratGbHubScroll");
    } catch (e) {
      return;
    }
    if (saved === null) return;
    var y = parseInt(saved, 10);
    if (isNaN(y) || y <= 0) return;
    // Only when the browser has not already restored it itself.
    if (window.scrollY < 10) window.scrollTo(0, y);
    void root;
  }

  function boot() {
    var roots = document.querySelectorAll("[data-carat-gb-hub]");
    for (var i = 0; i < roots.length; i++) init(roots[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
