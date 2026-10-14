/**
 * PAST GROUP BUYS — the public archive of closed campaigns.
 *
 * Slice 13. Consumes `GET /apps/carat/past-group-buys`
 * (app/app/routes/apps.carat.past-group-buys.tsx).
 *
 * ============================================================================
 * EVERY FIGURE IS RENDERED EXACTLY AS THE SERVER SENT IT
 * ============================================================================
 * Prices arrive as decimal STRINGS, derived server-side from integer minor
 * units under the campaign's own frozen pricing rules. This file must not
 * parse, round, re-format or do arithmetic on any of them. `parseFloat` on a
 * price here would reintroduce exactly the floating-point question the whole
 * money layer exists to avoid, and would do it on the one surface nobody
 * checks because the campaign is over.
 *
 * The same goes for the unit count and the tier number: printed, not computed.
 *
 * ============================================================================
 * THE REGULAR/CARD NOTE COMES FROM THE PAYLOAD, NOT FROM HERE
 * ============================================================================
 * CLAUDE.md rule 13 requires the note that lower pricing was available with
 * Bank Payment. The endpoint sends that sentence; this file prints it. It is
 * deliberately NOT a constant in the theme — a second copy is a copy that can
 * drift from the policy it restates. If the payload omits it, nothing is
 * invented in its place.
 *
 * "From" PRICING IS NOT COSMETIC. `priceIsFromLowestVariant` means the figures
 * are the cheapest variant's, not the campaign's only ones. Dropping the word
 * "from" would present one variant's price as what everybody paid.
 *
 * ============================================================================
 * TEXT, NEVER MARKUP
 * ============================================================================
 * Same rule as `policy-terms.js`: every server value goes through
 * `textContent`. Campaign names are staff-entered and cross a network
 * boundary; neither is a reason to allow markup into the page.
 */
(function () {
  "use strict";

  var ENDPOINT = "/apps/carat/past-group-buys";

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  /** `2026-03-04T…` → `4 March 2026`, or the raw value if it is not parseable. */
  function formatClosedAt(iso) {
    var parsed = new Date(iso);
    if (isNaN(parsed.getTime())) return iso;
    try {
      return parsed.toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" });
    } catch (e) {
      return iso;
    }
  }

  function money(currency, amount) {
    // Concatenation, never arithmetic. See the header.
    return amount + " " + currency;
  }

  function renderCampaign(campaign, container) {
    var item = el("article", "carat-past-group-buys__item");

    item.appendChild(el("h3", "carat-past-group-buys__name", campaign.name));

    var meta = el("p", "carat-past-group-buys__meta");
    meta.appendChild(el("span", "carat-past-group-buys__code", campaign.code));
    meta.appendChild(
      el("span", "carat-past-group-buys__closed", "Closed " + formatClosedAt(campaign.closedAt))
    );
    item.appendChild(meta);

    var prefix = campaign.priceIsFromLowestVariant ? "From " : "";

    var prices = el("dl", "carat-past-group-buys__prices");

    prices.appendChild(el("dt", "carat-past-group-buys__label", "Started at"));
    prices.appendChild(
      el(
        "dd",
        "carat-past-group-buys__value carat-past-group-buys__value--start",
        prefix + money(campaign.currency, campaign.startingRegularCardPrice)
      )
    );

    prices.appendChild(el("dt", "carat-past-group-buys__label", "Finished at"));
    prices.appendChild(
      el(
        "dd",
        "carat-past-group-buys__value carat-past-group-buys__value--final",
        prefix + money(campaign.currency, campaign.finalRegularCardPrice)
      )
    );

    item.appendChild(prices);

    var outcome = el("p", "carat-past-group-buys__outcome");
    outcome.appendChild(
      el(
        "span",
        "carat-past-group-buys__units",
        campaign.finalQualifyingUnits +
          (campaign.finalQualifyingUnits === 1 ? " unit bought" : " units bought") +
          " · tier " +
          campaign.finalTierNumber
      )
    );
    // Only when the group actually moved the price. The server sends null
    // when it did not, and an absent saving must not read as a zero one.
    if (campaign.priceFellBy) {
      outcome.appendChild(
        el(
          "span",
          "carat-past-group-buys__saving",
          "Price fell by " + money(campaign.currency, campaign.priceFellBy)
        )
      );
    }
    item.appendChild(outcome);

    // BRING IT BACK, for THIS campaign. The code travels with the form, which
    // is why the affordance lives next to the campaign rather than once at the
    // bottom of the page — a single form would have to ask the customer to
    // retype a code they can see.
    var interest = container.getAttribute("data-interest-template");
    if (interest) {
      var host = el("div", "carat-past-group-buys__interest");
      host.setAttribute("data-carat-group-buy-interest", "bring_it_back");
      host.setAttribute("data-campaign-ref", campaign.code);
      host.setAttribute("data-campaign-name", campaign.name);
      item.appendChild(host);
    }

    return item;
  }

  function renderError(container) {
    container.textContent = "";
    container.appendChild(
      el(
        "p",
        "carat-past-group-buys__error",
        "We could not load past Group Buys just now. Please refresh and try again."
      )
    );
  }

  function renderEmpty(container) {
    container.textContent = "";
    container.appendChild(
      el(
        "p",
        "carat-past-group-buys__empty",
        "No Group Buys have closed yet. When one does, it will appear here with the price the group reached."
      )
    );
  }

  function render(container, payload) {
    container.textContent = "";

    var campaigns = (payload && payload.campaigns) || [];
    if (campaigns.length === 0) {
      renderEmpty(container);
      return;
    }

    var list = el("div", "carat-past-group-buys__list");
    for (var i = 0; i < campaigns.length; i += 1) {
      list.appendChild(renderCampaign(campaigns[i], container));
    }
    container.appendChild(list);

    // The note the server sent, verbatim. Never a local substitute.
    if (payload.regularCardPriceNote) {
      container.appendChild(
        el("p", "carat-past-group-buys__price-note", payload.regularCardPriceNote)
      );
    }

    // The interest forms were appended as empty hosts above; wire them now
    // that they are in the document.
    if (window.CaratGroupBuyInterest && window.CaratGroupBuyInterest.init) {
      window.CaratGroupBuyInterest.init(container);
    }
  }

  function load(container) {
    fetch(ENDPOINT, { headers: { Accept: "application/json" }, credentials: "same-origin" })
      .then(function (response) {
        if (!response.ok) throw new Error("status " + response.status);
        return response.json();
      })
      .then(function (payload) {
        render(container, payload);
      })
      .catch(function () {
        renderError(container);
      });
  }

  function init() {
    var containers = document.querySelectorAll("[data-carat-past-group-buys]");
    for (var i = 0; i < containers.length; i += 1) load(containers[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
