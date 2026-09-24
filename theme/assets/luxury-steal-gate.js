/**
 * Luxury Steals Final Sale acknowledgment gate (Slice 3 task 3-5,
 * docs/specs/SLICE-3-LUXURY-STEALS.md §4.2-4.3 and §4.7, criteria 130, 133,
 * 134, 146). Drives the markup `snippets/luxury-product-gate.liquid` renders
 * -- see that file's header comment for why it renders where it does and
 * what the order-time check (task 3-4) covers that this gate cannot.
 *
 * THIS FILE NEVER DECIDES WHETHER A VARIANT IS A LUXURY STEAL. It only
 * reflects `data-carat-ls-assigned`, a value the SERVER already decided when
 * it rendered `luxury-product-gate.liquid` for the selected variant
 * (criterion 149's `.value` read happens in Liquid, not here). Nothing here
 * ever infers, defaults, or restores a previous "checked" state.
 *
 * THE ONLY THING THIS FILE IS ALLOWED TO DISABLE. It sets `aria-disabled` on
 * the product form's submit button(s) -- and ONLY sets/clears that attribute
 * itself, never the native `disabled` attribute, which stays exclusively
 * owned by Dawn's own sold-out/unavailable logic
 * (`product-info.js`/`buy-buttons.liquid`). Because this file only ever
 * WRITES `aria-disabled`, it is always safe for it to clear its own writes
 * without risking un-disabling a button that is legitimately unavailable for
 * an unrelated reason -- a sold-out button stays inert via its own
 * `disabled` attribute regardless of what this file does to `aria-disabled`.
 * `assets/product-form.js`'s own submit handler already refuses to submit
 * when `aria-disabled === 'true'` on the clicked button (its `submitter`),
 * so gating here requires no change to that file at all.
 *
 * WHY THE BUTTONS ALSO GET `aria-describedby`. `aria-disabled` alone only
 * announces "dimmed"/"unavailable" -- a screen-reader user who tabs straight
 * to Add to Cart without passing through the disclosure/checkbox first would
 * hear that a control is unavailable with no explanation why. This file
 * cannot add that association from `buy-buttons.liquid` (not this task's
 * file to edit), so it adds/removes ONE `aria-describedby` token -- this
 * root's own `role="status"` hint element's id -- on the same buttons, at
 * the same moments it sets/clears `aria-disabled`. `addDescribedByToken` /
 * `removeDescribedByToken` only ever touch that one token, preserving
 * whatever else Dawn (or a future block) may already have listed there, and
 * restoring the attribute to exactly its prior state -- including removing
 * it entirely, not leaving `aria-describedby=""` -- once this file's own
 * disabling is lifted or the selected variant is no longer assigned.
 *
 * THE HIDDEN INPUT THIS FILE FILLS IN (`[data-carat-ls-ack-input]`,
 * `properties[_carat_ls_ack]`) LIVES OUTSIDE THE `<form>` IN THE DOM. It is
 * associated to it purely via the input's own `form="<product_form_id>"`
 * attribute (see the Liquid snippet), a native HTML mechanism -- no JS is
 * needed to make `FormData(form)` pick it up on submit, only to set/clear
 * its VALUE as acknowledgment succeeds, fails, or is revoked.
 *
 * VARIANT-CHANGE RESET (criterion 146) -- THE MECHANISM AND ITS LIMIT.
 * Dawn re-renders the product page's data through TWO different paths
 * depending on whether the selected option maps to a different product URL
 * (`product-info.js`'s `handleSwapProduct` vs `handleUpdateProductInfo`):
 *
 *   1. ORDINARY OPTION CHANGE ON THE SAME PRODUCT (ring size, metal, etc. --
 *      the case this criterion is actually about) goes through
 *      `handleUpdateProductInfo`, which patches specific elements by id
 *      rather than replacing the whole section, and publishes
 *      `PUB_SUB_EVENTS.variantChange` with the freshly fetched section HTML.
 *      This file subscribes to that event and swaps THIS container's markup
 *      (by id, `Luxury-Steal-Gate-<sectionId>`) from that fresh render, which
 *      is why the swap is correct rather than re-derived client-side: the
 *      new HTML was rendered server-side from the newly selected variant's
 *      OWN `.value`, including a checkbox that is unchecked by construction
 *      because Liquid never renders one pre-checked.
 *
 *   2. COMBINED-LISTINGS OPTION CHANGE (a different, linked PRODUCT/URL for
 *      that option -- an edge case, not this project's default catalogue
 *      shape) replaces the WHOLE `<product-info>` element instead and does
 *      NOT publish `variantChange`. `<product-info>`'s `connectedCallback`
 *      still dispatches a bubbling `product-info:loaded` event on every
 *      (re)connect, including this one, so this file also listens for that
 *      as a second, catch-all rebind path. THIS PATH IS CODE-REVIEWED BUT NOT
 *      LIVE-VERIFIED -- there is no combined-listings fixture in this repo to
 *      exercise it against; see the handoff for what was and was not tested.
 *
 * Elements swapped in by either path are FRESH, unbound DOM nodes (parsed
 * from a fetch response, never the live nodes this file originally attached
 * listeners to), so `bindGate` is called again on them each time. A
 * `data-carat-ls-bound` flag guards against binding the same live node twice
 * in the case both paths somehow observe it.
 */
(function () {
  if (window.caratLuxuryStealGateLoaded) return;
  window.caratLuxuryStealGateLoaded = true;

  var SELECTOR = '[data-carat-luxury-gate]';
  var PROXY_PATH = '/apps/carat/luxury-acknowledgment';
  var DESCRIBEDBY_ATTR = 'aria-describedby';
  var DYNAMIC_CHECKOUT_SELECTOR = '[data-carat-dynamic-checkout-wrapper]';
  var LS_GATE_REQUIRED_ATTR = 'data-carat-ls-gate-required';
  var LS_ACKNOWLEDGED_ATTR = 'data-carat-ls-acknowledged';

  // Owner ruling, 2026-09-24: "we don't display any payment method or allow
  // anything to happen until it is acknowledged." `buy-buttons.liquid`
  // renders the accelerated/dynamic checkout wrapper (Shop Pay etc.) hidden
  // when EITHER the cart is in Bank mode OR the selected variant is an
  // unacknowledged Luxury Steal -- two independent reasons composed into one
  // `hidden` attribute. This file NEVER sets or clears that `hidden`
  // attribute directly for the "reveal" direction, because it has no
  // visibility into the OTHER reason (cart mode); see
  // `assets/cart.js`'s `showModeRedundantControls` (and buy-buttons.liquid's
  // own comment) for the composed decision. Revoking is different: hiding is
  // always safe regardless of mode, so that direction IS applied directly
  // here, immediately, with no round trip -- a revealed payment method must
  // never outlive the acknowledgment that revealed it by even one network
  // round trip.
  //
  // `syncDynamicCheckoutGate(form, assigned)` -- called at every BIND
  // (initial render, variant-change swap, product-info:loaded rebind), i.e.
  // the same moments the checkbox/hidden-input/buttons are reset -- puts the
  // wrapper into the correct STRUCTURAL state for the currently selected
  // variant: gated-and-hidden when assigned, not-gated-by-us when not. Dawn's
  // own variant-change patch (`product-info.js` `handleUpdateProductInfo`)
  // does NOT touch buy-buttons markup at all (verified by reading that
  // function -- it only patches price/SKU/inventory/volume nodes and the
  // hidden `id` input), so without this call the wrapper would carry
  // whatever Luxury Steal state the INITIAL page load happened to render,
  // silently wrong after any same-page variant switch.
  //
  // `setDynamicCheckoutAcknowledged(form, acknowledged)` -- called only from
  // the checkbox's own change handler, assumes `syncDynamicCheckoutGate` has
  // already run for this bind (so `LS_GATE_REQUIRED_ATTR` is already
  // correct) and only flips the acknowledgment marker (and, on revoke,
  // `hidden` directly). On GRANT it asks `assets/cart.js`'s PUBLIC `apply()`
  // -- never its `_internal` -- to recompute, exactly as
  // `product-form.js` already calls `window.CaratCartPricing?.setPaymentMode`
  // defensively elsewhere in this theme.
  function syncDynamicCheckoutGate(form, assigned) {
    if (!form) return;
    var wrappers = form.querySelectorAll(DYNAMIC_CHECKOUT_SELECTOR);
    var wasGated = false;
    for (var i = 0; i < wrappers.length; i++) {
      var wrapper = wrappers[i];
      if (assigned) {
        wrapper.setAttribute(LS_GATE_REQUIRED_ATTR, 'true');
        wrapper.setAttribute(LS_ACKNOWLEDGED_ATTR, 'false');
        wrapper.setAttribute('hidden', '');
      } else {
        if (wrapper.getAttribute(LS_GATE_REQUIRED_ATTR) === 'true') wasGated = true;
        wrapper.removeAttribute(LS_GATE_REQUIRED_ATTR);
        wrapper.removeAttribute(LS_ACKNOWLEDGED_ATTR);
        // `hidden` is deliberately NOT touched here -- see the file-level
        // comment. Ask apply() to recompute (composing with current mode)
        // only when this wrapper was actually gated by us a moment ago;
        // otherwise this would fire on every ordinary non-Luxury-Steal bind.
      }
    }
    if (!assigned && wasGated) requestDynamicCheckoutRecompute();
  }

  function setDynamicCheckoutAcknowledged(form, acknowledged) {
    if (!form) return;
    var wrappers = form.querySelectorAll(DYNAMIC_CHECKOUT_SELECTOR);
    var relevant = false;
    for (var i = 0; i < wrappers.length; i++) {
      var wrapper = wrappers[i];
      if (wrapper.getAttribute(LS_GATE_REQUIRED_ATTR) !== 'true') continue;
      relevant = true;
      wrapper.setAttribute(LS_ACKNOWLEDGED_ATTR, acknowledged ? 'true' : 'false');
      if (!acknowledged) wrapper.setAttribute('hidden', '');
    }
    if (acknowledged && relevant) requestDynamicCheckoutRecompute();
  }

  // Fire-and-forget by design: a failed recompute must not block the rest of
  // the acknowledgment flow (the hidden ack-id input is already set by the
  // caller before this runs), and apply()'s own failure handling never
  // reveals anything on a failed request -- so the fail-safe direction here
  // is "stays hidden", matching the owner ruling's spirit even on an error.
  function requestDynamicCheckoutRecompute() {
    if (!window.CaratCartPricing || typeof window.CaratCartPricing.apply !== 'function') return;
    window.CaratCartPricing.apply().catch(function (e) {
      console.error('[CaratLuxurySteals] dynamic checkout visibility recompute failed', e);
    });
  }

  // Adds/removes ONE token from a (possibly pre-existing, possibly
  // Dawn-owned) space-separated `aria-describedby` list, leaving every other
  // token untouched. This is what makes `setButtonsDisabled` below safe to
  // call repeatedly and in either order: adding a token that is already
  // present is a no-op, and removing restores the attribute to exactly what
  // it would be had our token never been added -- including dropping the
  // attribute entirely if our token was the only one there, rather than
  // leaving a stray empty `aria-describedby=""`.
  function addDescribedByToken(el, id) {
    var tokens = (el.getAttribute(DESCRIBEDBY_ATTR) || '').split(/\s+/).filter(Boolean);
    if (tokens.indexOf(id) === -1) {
      tokens.push(id);
      el.setAttribute(DESCRIBEDBY_ATTR, tokens.join(' '));
    }
  }

  function removeDescribedByToken(el, id) {
    var tokens = (el.getAttribute(DESCRIBEDBY_ATTR) || '').split(/\s+/).filter(Boolean);
    var next = tokens.filter(function (token) {
      return token !== id;
    });
    if (next.length) {
      el.setAttribute(DESCRIBEDBY_ATTR, next.join(' '));
    } else {
      el.removeAttribute(DESCRIBEDBY_ATTR);
    }
  }

  // `statusId` is the id of THIS root's `role="status"` hint element
  // (`Luxury-Steal-Status-<sectionId>`), constructed from `data-section-id`
  // rather than looked up via `querySelector` -- the status element only
  // exists in the DOM when the selected variant is assigned (see the Liquid
  // template), but a NOT-assigned bind still needs to remove a token it may
  // have left on a PREVIOUSLY selected (assigned) sibling variant's buttons,
  // so the id has to be derivable even when the element itself is absent.
  function setButtonsDisabled(form, disabled, statusId) {
    if (!form) return;
    var buttons = form.querySelectorAll('[type="submit"]');
    for (var i = 0; i < buttons.length; i++) {
      if (disabled) {
        buttons[i].setAttribute('aria-disabled', 'true');
        if (statusId) addDescribedByToken(buttons[i], statusId);
      } else {
        buttons[i].removeAttribute('aria-disabled');
        if (statusId) removeDescribedByToken(buttons[i], statusId);
      }
    }
  }

  function setStatus(root, message) {
    var statusEl = root.querySelector('[data-carat-ls-status]');
    if (!statusEl) return;
    statusEl.textContent = message || '';
    statusEl.hidden = !message;
  }

  function setError(root, message) {
    var errorEl = root.querySelector('[data-carat-ls-error]');
    if (!errorEl) return;
    errorEl.textContent = message || '';
    errorEl.hidden = !message;
  }

  function bindGate(root) {
    if (!root || root.dataset.caratLsBound === 'true') return;

    var form = root.dataset.productFormId ? document.getElementById(root.dataset.productFormId) : null;
    var assigned = root.dataset.caratLsAssigned === 'true';
    var statusId = root.dataset.sectionId ? 'Luxury-Steal-Status-' + root.dataset.sectionId : null;

    if (!assigned) {
      // Nothing to gate for the currently selected variant. Explicitly clear
      // any disabling THIS file may have left behind from a PREVIOUSLY
      // selected (assigned) sibling variant -- never touches the native
      // `disabled` attribute, so a genuinely sold-out button is unaffected --
      // and restores `aria-describedby` to exactly what it was before this
      // file's own token was added, per `setButtonsDisabled`'s contract.
      setButtonsDisabled(form, false, statusId);
      syncDynamicCheckoutGate(form, false);
      root.dataset.caratLsBound = 'true';
      return;
    }

    var checkbox = root.querySelector('[data-carat-ls-checkbox]');
    var hiddenInput = root.querySelector('[data-carat-ls-ack-input]');
    var variantId = root.dataset.shopifyVariantId;
    var cartToken = root.dataset.cartToken;
    var errorText = root.dataset.errorText || "We couldn't record your acknowledgment. Please try again.";
    // Rendered even without this script (progressive baseline), but only
    // ANNOUNCED via the `role="status"` region once JS actually disables the
    // buttons below -- a screen-reader user who tabs straight to a disabled
    // button hears "dimmed"/"unavailable" from `aria-disabled` alone, and
    // this text is what explains why, for whichever control they reach
    // first.
    var hintText = root.dataset.gateHint || '';

    // NEVER PRE-CHECKED (criterion 133), and always reset on a fresh bind --
    // covers both the initial render and every variant-change swap, even
    // though the server-rendered markup already starts unchecked by
    // construction; this is a second, defensive guarantee against a browser
    // restoring stale form state (e.g. bfcache) onto this checkbox.
    if (checkbox) checkbox.checked = false;
    if (hiddenInput) hiddenInput.value = '';
    setStatus(root, hintText);
    setError(root, '');
    setButtonsDisabled(form, true, statusId);
    syncDynamicCheckoutGate(form, true);

    if (checkbox) {
      checkbox.addEventListener('change', function () {
        if (!checkbox.checked) {
          if (hiddenInput) hiddenInput.value = '';
          setButtonsDisabled(form, true, statusId);
          setDynamicCheckoutAcknowledged(form, false);
          setStatus(root, hintText);
          setError(root, '');
          return;
        }

        checkbox.disabled = true;
        setError(root, '');
        setStatus(root, '');

        var body = { shopifyVariantId: variantId };
        if (cartToken) body.cartRef = cartToken;

        fetch(PROXY_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(body),
        })
          .then(function (response) {
            if (!response.ok) throw new Error('luxury acknowledgment request failed with status ' + response.status);
            return response.json();
          })
          .then(function (data) {
            if (!data || !data.acknowledgmentId) throw new Error('acknowledgment response missing acknowledgmentId');
            if (hiddenInput) hiddenInput.value = data.acknowledgmentId;
            setButtonsDisabled(form, false, statusId);
            setDynamicCheckoutAcknowledged(form, true);
            setStatus(root, '');
          })
          .catch(function (e) {
            console.error('[CaratLuxurySteals] acknowledgment failed', e);
            // The customer's click did not result in recorded evidence, so
            // the checkbox must not be left showing "checked" -- that would
            // visually claim an acknowledgment that was never captured.
            checkbox.checked = false;
            if (hiddenInput) hiddenInput.value = '';
            setButtonsDisabled(form, true, statusId);
            setDynamicCheckoutAcknowledged(form, false);
            setStatus(root, hintText);
            setError(root, errorText);
          })
          .finally(function () {
            checkbox.disabled = false;
          });
      });
    }

    root.dataset.caratLsBound = 'true';
  }

  function bindAll(scope) {
    var roots = (scope || document).querySelectorAll(SELECTOR);
    for (var i = 0; i < roots.length; i++) bindGate(roots[i]);
  }

  // Initial page load: run once the DOM for this render is parsed. This
  // script is loaded `defer`, so it already runs after parsing completes --
  // no need to wait for DOMContentLoaded separately.
  bindAll(document);

  // Ordinary same-product variant/option change (criterion 146's primary
  // case) -- see this file's header comment, path 1.
  if (typeof subscribe === 'function' && typeof PUB_SUB_EVENTS === 'object' && PUB_SUB_EVENTS.variantChange) {
    subscribe(PUB_SUB_EVENTS.variantChange, function (payload) {
      var data = payload && payload.data;
      if (!data || !data.html || !data.sectionId) return;

      var currentId = 'Luxury-Steal-Gate-' + data.sectionId;
      var current = document.getElementById(currentId);
      var fresh = data.html.getElementById(currentId);
      if (!current || !fresh) return;

      current.outerHTML = fresh.outerHTML;
      var replaced = document.getElementById(currentId);
      if (replaced) bindGate(replaced);
    });
  }

  // Combined-listings / whole-product-info swap (criterion 146, path 2 --
  // see this file's header comment for why this is defensive, not primary).
  document.addEventListener('product-info:loaded', function (evt) {
    if (!evt.target) return;
    bindAll(evt.target);
  });
})();
