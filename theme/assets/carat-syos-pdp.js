/**
 * Carries a Set Your Own Stone session onto a mounting's product page.
 *
 * WHY THIS IS JAVASCRIPT AND NOT LIQUID
 * -------------------------------------
 * This started as a Liquid gate reading `request.url`. Measured against the
 * live store, it never fired: Shopify does not expose the query string to
 * Liquid at all, so the stone reference was always blank and both the custom
 * path and the order property silently disappeared. The URL is the only place
 * that holds the reference, and only the browser can read it.
 *
 * The theme still renders both pieces server-side; this file does one thing --
 * supply the reference the template cannot see.
 *
 * FAILS CLOSED
 * ------------
 * The hidden input ships with NO `name` attribute, so a browser that never
 * runs this file submits no property rather than an empty or wrong one. The
 * custom block ships `hidden`. Nothing here invents a session: no `stone` in
 * the URL means nothing is applied.
 *
 * WHAT TRAVELS IS THE SESSION REFERENCE, NEVER THE VERDICT. The compatibility
 * status is recomputed and stored server-side against that session. A page the
 * customer controls is exactly the wrong source for a claim that a jeweler
 * does or does not need to inspect the stone.
 *
 * RE-RUNS AFTER A VARIANT CHANGE. Dawn replaces the product-info subtree when
 * the customer picks a metal or ring size, which throws away anything applied
 * to the old markup. The observer below reapplies to the replacement, so
 * choosing a ring size cannot quietly drop the session from the order.
 */
(function () {
  'use strict';

  var SESSION_PARAM = 'stone';

  /** The session reference in the current URL, or '' when there is none. */
  function stoneReference() {
    try {
      var value = new URL(window.location.href).searchParams.get(SESSION_PARAM);
      return value ? value.trim() : '';
    } catch (e) {
      return '';
    }
  }

  /** `base` with the stone reference added, leaving its own params intact. */
  function withStone(base, reference) {
    try {
      var url = new URL(base, window.location.origin);
      url.searchParams.set(SESSION_PARAM, reference);
      return url.pathname + url.search;
    } catch (e) {
      return base;
    }
  }

  function apply() {
    var reference = stoneReference();
    if (!reference) return;

    // The order property. Named only now that there is a real value for it.
    var inputs = document.querySelectorAll('input[data-carat-syos-session]');
    for (var i = 0; i < inputs.length; i += 1) {
      inputs[i].value = reference;
      inputs[i].setAttribute('name', 'properties[_syos_session]');
    }

    // "Customize this setting for my stone" / "Back to my stone". Hidden until
    // there is a session, because without one neither link can keep the
    // continuity its wording promises.
    var blocks = document.querySelectorAll('[data-carat-syos-pdp-custom]');
    for (var j = 0; j < blocks.length; j += 1) {
      var links = blocks[j].querySelectorAll('a[data-carat-syos-link-base]');
      for (var k = 0; k < links.length; k += 1) {
        links[k].setAttribute(
          'href',
          withStone(links[k].getAttribute('data-carat-syos-link-base'), reference)
        );
      }
      blocks[j].removeAttribute('hidden');
    }
  }

  apply();

  // Attribute changes only above, childList only here -- this cannot re-trigger
  // itself.
  if (typeof MutationObserver === 'function') {
    var pending = false;
    var observer = new MutationObserver(function () {
      if (pending) return;
      pending = true;
      window.requestAnimationFrame(function () {
        pending = false;
        apply();
      });
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();
