/**
 * Warranty order-verify landing page controller (D33,
 * app/app/routes/apps.carat.warranty-order-verify.tsx). Reads `?token=` from
 * the page URL and, ONLY on a real `click` of
 * `[data-carat-warranty-verify-submit]`, POSTs it to
 * `/apps/carat/warranty-order-verify` through the App Proxy. On success,
 * lets the customer pick which line item the claim is for, then navigates
 * (a normal page load) to the Warranty Claim Form page with
 * `?order_id=`/`?line_item_id=` already filled in -- see
 * `sections/warranty-order-verify.liquid`'s own header comment for the full
 * reasoning this file assumes throughout, especially why nothing here ever
 * fires on page load and why most failures offer no retry.
 *
 * TOKEN HANDLING. `readTokenFromUrl` reads the token into a local variable
 * exactly once; `scrubTokenFromUrl` then removes it from the visible address
 * bar via `history.replaceState` before this file renders any state. This
 * does not, and cannot, stop the ONE request that already carried the token
 * to Shopify/this app when the page itself was first requested (unavoidable
 * -- that request is how the link works at all, and this app never sees a
 * Referer for its own inbound page load). What it DOES prevent is the token
 * riding along as part of `location.href` in the Referer header of any
 * request this page makes AFTER load (this page's own POST sends the token
 * only in the JSON body, never the URL, precisely so it is never eligible to
 * appear in a Referer at all) and, more importantly, in the Referer of the
 * eventual navigation to the Warranty Claim Form page this file triggers on
 * success -- without the scrub, that cross-page navigation would leak the
 * spent token to that page's own server logs/analytics via
 * `document.referrer`. It also keeps the token out of browser history and
 * off a screenshotted/copied address bar. HONEST LIMIT, not claimed away:
 * this script is `defer`red, so it runs after HTML parsing but is not
 * guaranteed to run before an earlier-loading analytics snippet reads
 * `location.href` for its own pageview payload -- eliminating that would
 * require changing this shop's analytics initialization order, which is
 * outside this file's scope and is flagged in this task's handoff rather
 * than silently assumed fixed here.
 *
 * NEVER RENDERED. The token is never written into any DOM
 * attribute/text/innerHTML anywhere in this file -- it exists only as a
 * local variable passed straight into `JSON.stringify` for the one POST
 * body that needs it.
 */
(function () {
  // Same double-bind guard convention as warranty-claim-form.js/
  // luxury-steal-gate.js.
  if (window.caratWarrantyOrderVerifyLoaded) return;
  window.caratWarrantyOrderVerifyLoaded = true;

  var PROXY_PATH = '/apps/carat/warranty-order-verify';
  var CONTAINER_SELECTOR = '[data-carat-warranty-verify]';
  var DEFAULT_CLAIM_PATH = '/pages/warranty-claim';

  function strings() {
    return window.warrantyOrderVerifyStrings || {};
  }

  function errorEntry(code) {
    var byCode = strings().error_summary_by_code || {};
    return byCode[code] || { heading: code, body: '' };
  }

  // ---------------------------------------------------------------------
  // Token read + scrub -- see this file's header comment.
  // ---------------------------------------------------------------------
  function readTokenFromUrl() {
    var params = new URLSearchParams(window.location.search);
    var token = params.get('token');
    return token && token.length > 0 ? token : null;
  }

  function scrubTokenFromUrl() {
    if (!window.history || typeof window.history.replaceState !== 'function') return;
    var url = new URL(window.location.href);
    if (!url.searchParams.has('token')) return;
    url.searchParams.delete('token');
    window.history.replaceState(null, '', url.pathname + (url.search ? url.search : '') + url.hash);
  }

  // ---------------------------------------------------------------------
  // Panel visibility -- each top-level panel is `hidden`/unhidden as a
  // whole; only one is ever visible at a time. Focus moves to the newly
  // shown panel (or its heading, when it has one) so assistive tech
  // announces the state change, matching warranty-claim-form.js's
  // error-summary/confirmation focus pattern.
  // ---------------------------------------------------------------------
  var PANEL_IDS = ['WarrantyVerifyMissingToken', 'WarrantyVerifyReady', 'WarrantyVerifySuccess', 'WarrantyVerifyError'];

  function showPanel(id, focusTargetId) {
    PANEL_IDS.forEach(function (panelId) {
      var panel = document.getElementById(panelId);
      if (panel) panel.hidden = panelId !== id;
    });
    var focusTarget = document.getElementById(focusTargetId || id);
    if (focusTarget) focusTarget.focus();
  }

  function setStatus(container, text) {
    var status = container.querySelector('[data-carat-warranty-verify-status]');
    if (!status) return;
    if (!text) {
      status.hidden = true;
      status.textContent = '';
      return;
    }
    status.hidden = false;
    status.textContent = text;
  }

  // ---------------------------------------------------------------------
  // Ready-panel inline error -- network failures ONLY (see header comment
  // on why every other failure goes to the standalone Error panel instead).
  // ---------------------------------------------------------------------
  function showReadyError(container) {
    var entry = errorEntry('network');
    var wrapper = container.querySelector('[data-carat-warranty-verify-ready-error]');
    if (!wrapper) return;
    var heading = wrapper.querySelector('[data-carat-warranty-verify-ready-error-heading]');
    var body = wrapper.querySelector('[data-carat-warranty-verify-ready-error-body]');
    if (heading) heading.textContent = entry.heading;
    if (body) body.textContent = entry.body;
    wrapper.hidden = false;
    wrapper.focus();
  }

  function hideReadyError(container) {
    var wrapper = container.querySelector('[data-carat-warranty-verify-ready-error]');
    if (wrapper) wrapper.hidden = true;
  }

  // ---------------------------------------------------------------------
  // Terminal error panel -- every non-network failure. See this file's
  // header comment for why no retry control exists here.
  // ---------------------------------------------------------------------
  function showTerminalError(code) {
    var entry = errorEntry(code);
    var heading = document.getElementById('WarrantyVerifyErrorHeading');
    var body = document.getElementById('WarrantyVerifyErrorBody');
    if (heading) heading.textContent = entry.heading;
    if (body) body.textContent = entry.body;
    showPanel('WarrantyVerifyError');
  }

  // Maps the verify route's documented outcomes to a local error-code key.
  // Never surfaces a raw server `error` string to the customer -- same
  // discipline as warranty-claim-form.js's `messageKeyForFailure`.
  function mapFailureToErrorCode(status, body) {
    var errorCode = body && typeof body.error === 'string' ? body.error : null;
    if (status === 400 || errorCode === 'invalid_token') return 'invalid_token';
    if (status === 410 || errorCode === 'token_expired') return 'token_expired';
    if (status === 409 || errorCode === 'token_already_used') return 'token_already_used';
    if (status === 404 || errorCode === 'order_no_longer_resolvable') return 'order_unresolvable';
    return 'service_unavailable';
  }

  // ---------------------------------------------------------------------
  // Success -- builds the line-item radio group from the server's response
  // and wires Continue to navigate to the Warranty Claim Form page with
  // `?order_id=`/`?line_item_id=` -- see this file's header comment and
  // `sections/warranty-claim-form.liquid`'s `prefillFromQueryString`, which
  // is the code that actually reads those two params on the far side.
  // ---------------------------------------------------------------------
  function escapeHtml(value) {
    var div = document.createElement('div');
    div.textContent = value;
    return div.innerHTML;
  }

  // Placeholder tokens are `[title]`/`[quantity]` (square brackets), NOT
  // Shopify's own `{{ title }}` translation-interpolation syntax -- see
  // this section's own inline `<script>` comment (warranty-order-
  // verify.liquid) for why the calling site can't pass a literal `{{ }}`
  // string as a `t:` filter argument.
  function formatItemOption(title, quantity) {
    var template = strings().item_option_with_quantity || '[title] — Qty [quantity]';
    return template.replace('[title]', title).replace('[quantity]', String(quantity));
  }

  function buildClaimUrl(container, orderRef, lineRef) {
    var claimPath = container.getAttribute('data-claim-url');
    if (!claimPath) claimPath = DEFAULT_CLAIM_PATH;
    var separator = claimPath.indexOf('?') === -1 ? '?' : '&';
    return (
      claimPath +
      separator +
      'order_id=' +
      encodeURIComponent(orderRef) +
      '&line_item_id=' +
      encodeURIComponent(lineRef)
    );
  }

  function showSuccess(container, order) {
    var introEl = document.getElementById('WarrantyVerifySuccessIntro');
    if (introEl) {
      var template = strings().success_intro_html || '';
      // The ONLY server-supplied value interpolated here is the order's own
      // display name (e.g. "#1001") -- already known to the customer, who
      // typed it in on the prior lookup step. Escaped before insertion via
      // innerHTML, same pattern as warranty-claim-form.js's
      // `showConfirmation`.
      introEl.innerHTML = template.replace('[order]', escapeHtml(order.orderName || ''));
    }

    var itemsContainer = container.querySelector('[data-carat-warranty-verify-items]');
    var lineItems = Array.isArray(order.lineItems) ? order.lineItems : [];
    if (itemsContainer) {
      itemsContainer.innerHTML = '';
      lineItems.forEach(function (item) {
        var label = document.createElement('label');
        label.className = 'carat-warranty-verify__radio';

        var input = document.createElement('input');
        input.type = 'radio';
        input.name = 'warranty_verify_line_ref';
        input.value = item.lineRef;
        input.required = true;
        // Sole item: pre-selected for convenience, but the fieldset/legend
        // and radio control stay visible so the customer can see, not just
        // trust, which item is about to be selected -- never auto-navigated
        // past this point without an explicit Continue click.
        if (lineItems.length === 1) input.checked = true;

        // Built via textContent below, never innerHTML -- `item.title`
        // is Shopify catalog data, not something this file needs to trust
        // as markup-free, so it is inserted as a plain text node either way.
        label.appendChild(input);
        var textNode = document.createTextNode(formatItemOption(item.title, item.quantity));
        label.appendChild(textNode);
        itemsContainer.appendChild(label);
      });
    }

    var continueButton = container.querySelector('[data-carat-warranty-verify-continue]');
    var itemsError = document.getElementById('WarrantyVerifyItemsError');
    if (continueButton) {
      continueButton.onclick = function () {
        var checked = itemsContainer ? itemsContainer.querySelector('input[type="radio"]:checked') : null;
        if (!checked) {
          if (itemsError) itemsError.hidden = false;
          return;
        }
        if (itemsError) itemsError.hidden = true;
        window.location.assign(buildClaimUrl(container, order.orderRef, checked.value));
      };
    }

    showPanel('WarrantyVerifySuccess', 'WarrantyVerifySuccessHeading');
  }

  // ---------------------------------------------------------------------
  // The one and only place this file issues the redemption POST -- reached
  // exclusively from a real `click` handler, never from init/DOMContentLoaded.
  // ---------------------------------------------------------------------
  function handleVerifyClick(container, token) {
    var submitButton = container.querySelector('[data-carat-warranty-verify-submit]');
    hideReadyError(container);
    if (submitButton) submitButton.disabled = true;
    setStatus(container, strings().verifying_status);

    fetch(PROXY_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ token: token }),
    })
      .then(function (response) {
        return response
          .json()
          .catch(function () {
            return null;
          })
          .then(function (body) {
            return { response: response, body: body };
          });
      })
      .then(function (result) {
        setStatus(container, null);
        if (submitButton) submitButton.disabled = false;

        if (result.response.ok && result.body && result.body.resolved && result.body.order) {
          showSuccess(container, result.body.order);
          return;
        }

        // Any completed HTTP response -- ok or not -- is terminal for this
        // token; see this file's header comment. The Ready panel's submit
        // button is re-enabled above only so it is not left permanently
        // disabled if this branch is ever reached in an unexpected shape,
        // not because retrying is expected to help.
        showTerminalError(mapFailureToErrorCode(result.response.status, result.body));
      })
      .catch(function () {
        // Genuine network failure -- no response was ever received, so the
        // token was very likely never touched server-side. Stay on the
        // Ready panel and re-enable the same Verify button so the customer
        // can simply press it again; no separate retry control exists.
        if (submitButton) submitButton.disabled = false;
        setStatus(container, null);
        showReadyError(container);
      });
  }

  function init() {
    var container = document.querySelector(CONTAINER_SELECTOR);
    if (!container) return;

    var token = readTokenFromUrl();
    scrubTokenFromUrl();

    if (!token) {
      showPanel('WarrantyVerifyMissingToken');
      return;
    }

    showPanel('WarrantyVerifyReady', 'WarrantyVerifyReadyHeading');

    var submitButton = container.querySelector('[data-carat-warranty-verify-submit]');
    if (submitButton) {
      submitButton.addEventListener('click', function () {
        handleVerifyClick(container, token);
      });
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
