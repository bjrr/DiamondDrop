/**
 * POLICY TERMS — renders the authoritative wording, verbatim.
 *
 * Slice 12. Consumes `GET /apps/carat/policies?group=<group>`
 * (app/app/routes/apps.carat.policies.tsx).
 *
 * ============================================================================
 * THE TEXT IS RENDERED AS TEXT, NEVER AS MARKUP
 * ============================================================================
 * Every term goes through `textContent`, never `innerHTML`. Two reasons, and
 * the second is the one people forget:
 *
 *   1. it is untrusted-by-construction — the value crosses a network boundary
 *      and must never be able to introduce markup into a page;
 *   2. a material term that renders differently from how it is stored is a
 *      term we cannot prove we showed. Bold, a line break, a swallowed
 *      character — any of it puts the page out of step with the evidence.
 *
 * ============================================================================
 * A FAILURE IS VISIBLE. IT IS NEVER A CACHED TERM.
 * ============================================================================
 * There is no local copy to fall back to, deliberately. A stale material term
 * shown as current is worse than a visible error, because the customer cannot
 * tell the difference and we have no record of what they read.
 *
 * `incomplete: true` from the endpoint means a term we expected could not be
 * read. The page shows what it has AND says so — a policy page silently short
 * a section looks exactly like one that was always that length.
 */
(function () {
  "use strict";

  var ENDPOINT = "/apps/carat/policies";

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    // textContent, always. See the header.
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function renderError(container) {
    container.textContent = "";
    container.appendChild(
      el(
        "p",
        "carat-policy-terms__error",
        "We could not load the current terms just now. Please refresh, or contact us and we will send them to you."
      )
    );
  }

  function renderTerms(container, payload) {
    container.textContent = "";

    var terms = (payload && payload.terms) || [];
    if (terms.length === 0) {
      renderError(container);
      return;
    }

    var list = el("div", "carat-policy-terms__list");

    terms.forEach(function (term) {
      var item = el("section", "carat-policy-terms__item");

      var heading = el("h3", "carat-policy-terms__title", term.title);
      item.appendChild(heading);

      // THE AUTHORITATIVE SENTENCE. Verbatim, as text.
      var body = el("p", "carat-policy-terms__text", term.text);
      item.appendChild(body);

      if (container.getAttribute("data-show-version") === "true" && term.version) {
        var version = el("p", "carat-policy-terms__version", "Version " + term.version);
        item.appendChild(version);
      }

      list.appendChild(item);
    });

    container.appendChild(list);

    if (payload.incomplete) {
      // Say so rather than letting a short page look complete.
      container.appendChild(
        el(
          "p",
          "carat-policy-terms__error",
          "Some terms could not be loaded. Please contact us for the complete current terms."
        )
      );
    }
  }

  function load(container) {
    var group = container.getAttribute("data-group");
    var url = ENDPOINT;
    if (group) url += "?group=" + encodeURIComponent(group);

    fetch(url, { headers: { Accept: "application/json" }, credentials: "same-origin" })
      .then(function (response) {
        if (!response.ok) throw new Error("status " + response.status);
        return response.json();
      })
      .then(function (payload) {
        renderTerms(container, payload);
      })
      .catch(function () {
        renderError(container);
      });
  }

  function init() {
    var containers = document.querySelectorAll("[data-carat-policy-terms]");
    for (var i = 0; i < containers.length; i += 1) load(containers[i]);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
