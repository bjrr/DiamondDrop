/**
 * Bank Payment Checkout details-form controller (Slice 2C task 2C-6,
 * docs/specs/SLICE-2C-BANK-PAYMENT-CHECKOUT.md §5.3/§5.6, criteria 83-86,
 * 94-95, D20).
 *
 * WHAT THIS FILE FIXES. `data-carat-checkout-action="bank-payment"` renders
 * on three surfaces (main-cart-footer.liquid, cart-drawer.liquid,
 * cart-notification.liquid) and previously had no handler anywhere — a
 * `type="button"` element that did nothing when clicked. This file opens
 * `snippets/bank-payment-checkout-dialog.liquid`'s `<modal-dialog>`, collects
 * an email + shipping address, and POSTs to `/apps/carat/bank-checkout`
 * (apps.carat.bank-checkout.tsx) — the real endpoint, not a stub.
 *
 * LOADED UNCONDITIONALLY (layout/theme.liquid), UNLIKE cart.js. cart.js only
 * loads on the cart page or inside the drawer (guarded by
 * `settings.cart_type == 'drawer'`), so on a `cart_type: notification`
 * storefront it is NOT present on an arbitrary product page where the
 * notification popup's own Bank Payment Checkout button can appear right
 * after an add-to-cart. A handler that only existed in cart.js would
 * reproduce exactly the "renders, does nothing" bug this task exists to fix,
 * on that path. This file is therefore independent of cart.js/CaratCart
 * Pricing (no shared state, no shared load-order dependency) and is loaded
 * the same way cart-notification.js already is — unconditionally, once,
 * every page.
 *
 * EVERY PRICE FIGURE IS SERVER-RESOLVED. This file sends WHICH lines (variant
 * id + quantity) and identity/address fields; it never computes or sends a
 * price. The route re-resolves every unit price from the published
 * calculation at request time (criterion 72) — same discipline as
 * CaratCartPricing's `/apps/carat/cart` call, restated here because this is
 * an independent module rather than a shared one.
 *
 * DOCUMENT-LEVEL EVENT DELEGATION, NOT PER-BUTTON BINDING. All three trigger
 * buttons live inside sections the Section Rendering API swaps on a quantity
 * change (SLICE-2B-CART-SURFACE-INVENTORY.md D1/D2/L3). Binding a listener to
 * a specific button element would silently stop working the next time that
 * section's markup is replaced. Delegating from `document` means a freshly
 * swapped-in button (same `data-carat-checkout-action="bank-payment"`
 * attribute) is caught with no re-apply step required.
 *
 * The dialog element itself is NOT inside any re-rendered section (rendered
 * once in layout/theme.liquid; `<modal-dialog>` moves itself to
 * `document.body` on connect — see global.js's ModalDialog), so it is never
 * at risk of being wiped by a section swap either.
 *
 * WHAT THIS FILE DELIBERATELY DOES NOT REIMPLEMENT. `<modal-dialog>`
 * (global.js) already provides ESC-to-close, overlay-click-to-close, focus
 * trap (`trapFocus`/`removeTrapFocus`), body scroll lock and restoring focus
 * to the opener on close. This file only wires the OPEN trigger, the
 * secondary "Cancel" action (the auto-wired close button uses
 * `id="ModalClose-CaratBankCheckoutModal"`, which ModalDialog's own
 * constructor already binds), and the form submission itself.
 */
window.CaratBankPaymentCheckout = (function () {
  var PROXY_PATH = '/apps/carat/bank-checkout';
  var MODAL_ID = 'CaratBankCheckoutModal';
  var TRIGGER_SELECTOR = '[data-carat-checkout-action="bank-payment"]';
  var DISMISS_SELECTOR = '[data-carat-bank-checkout-dismiss]';
  var FORM_SELECTOR = '[data-carat-bank-checkout-form]';
  var SUBMIT_SELECTOR = '[data-carat-bank-checkout-submit]';
  var STATUS_SELECTOR = '[data-carat-bank-checkout-status]';
  var ERROR_SUMMARY_SELECTOR = '[data-carat-bank-checkout-error-summary]';
  var FIELD_ERROR_TEXT_SELECTOR = '[data-carat-bank-checkout-field-error-text]';

  // Mirrors `shippingAddressRequestSchema` in apps.carat.bank-checkout.tsx —
  // required vs optional here MUST stay in sync with that schema, since a
  // field marked optional here that the schema requires would let a
  // client-valid submission fail server-side with no field-level guidance.
  var REQUIRED_FIELDS = [
    { name: 'email', errorKey: 'error_email_required' },
    { name: 'address1', errorKey: 'error_address1_required' },
    { name: 'city', errorKey: 'error_city_required' },
    { name: 'zip', errorKey: 'error_zip_required' },
    { name: 'countryCode', errorKey: 'error_country_required' },
  ];
  var OPTIONAL_FIELDS = ['firstName', 'lastName', 'address2', 'provinceCode', 'phone'];
  var ALL_FIELD_NAMES = REQUIRED_FIELDS.map(function (field) {
    return field.name;
  }).concat(OPTIONAL_FIELDS);

  // Deliberately permissive (not RFC 5322) — this is a client-side pre-check
  // for a fast error message. The server's zod `.email()` check is the
  // actual authority; this can never be stricter than necessary and reject
  // something the server would accept.
  var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function localeString(key) {
    var strings = (window.cartStrings && window.cartStrings.caratBankCheckout) || {};
    return strings[key] || key;
  }

  /** Trims every named field on a plain object, defaulting a missing/non-string value to "". Pure. */
  function normalizeValues(rawValues) {
    var values = {};
    ALL_FIELD_NAMES.forEach(function (name) {
      var raw = rawValues ? rawValues[name] : undefined;
      values[name] = typeof raw === 'string' ? raw.trim() : '';
    });
    return values;
  }

  /** Reads and trims the real form's fields via FormData. The only DOM-touching step before validation. */
  function readFormValues(form) {
    var data = new FormData(form);
    var raw = {};
    ALL_FIELD_NAMES.forEach(function (name) {
      raw[name] = data.get(name);
    });
    return normalizeValues(raw);
  }

  /** Pure. Returns [] when valid, else a list of {field, messageKey}. */
  function validateFormValues(values) {
    var errors = [];
    REQUIRED_FIELDS.forEach(function (field) {
      var value = values[field.name];
      if (!value) {
        errors.push({ field: field.name, messageKey: field.errorKey });
        return;
      }
      if (field.name === 'email' && !EMAIL_PATTERN.test(value)) {
        errors.push({ field: field.name, messageKey: field.errorKey });
      }
    });
    return errors;
  }

  /**
   * Pure. Builds the `shippingAddress` object exactly as
   * `shippingAddressRequestSchema` expects: required fields always present,
   * optional fields OMITTED (not sent as "") when blank — the schema's
   * `.optional()` fields are still `.min(1)` when PRESENT, so an empty
   * string would fail validation a client that simply left the field blank
   * never intended to trigger.
   */
  function buildShippingAddress(values) {
    var address = {
      address1: values.address1,
      city: values.city,
      zip: values.zip,
      countryCode: values.countryCode,
    };
    OPTIONAL_FIELDS.forEach(function (name) {
      if (values[name]) address[name] = values[name];
    });
    return address;
  }

  /** Pure. `lines` is already in the shape the route expects — see buildRequestLines. */
  function buildRequestBody(values, lines) {
    return {
      mode: 'bank',
      email: values.email,
      shippingAddress: buildShippingAddress(values),
      lines: lines,
    };
  }

  /**
   * Pure. Same technique as `CaratCartPricing._internal.buildRequestLines`
   * in cart.js (deliberately restated, not imported — this module has no
   * load-order dependency on cart.js, see this file's own header comment).
   * Sends the bare numeric id as a string; `normalizeShopifyVariantGid`
   * server-side accepts either a bare id or a full gid.
   */
  function buildRequestLines(cart) {
    var items = (cart && cart.items) || [];
    return items.map(function (item) {
      return {
        shopifyVariantId: String(item.variant_id != null ? item.variant_id : item.id),
        quantity: item.quantity,
      };
    });
  }

  /**
   * Pure. Maps a failed response to a locale message KEY — never text
   * directly, so this stays testable without a locale fixture. Every
   * branch is one of the documented error codes returned by
   * apps.carat.bank-checkout.tsx (that route's own header comment / 2C spec
   * §5.1): unpurchasable_lines, group_buy_variant_present,
   * checkout_unresolved, checkout_failed_previously,
   * checkout_upstream_failed, checkout_unavailable, invalid_request. A
   * status/body this file does not recognize (unauthorized, an unparsed
   * body, a network failure the caller detects separately) falls back to a
   * single generic message — never a blank or a raw error code shown to the
   * customer.
   */
  function messageKeyForFailure(_status, body) {
    var code = body && typeof body === 'object' ? body.error : null;
    switch (code) {
      case 'unpurchasable_lines':
        return 'error_unpurchasable_lines';
      case 'group_buy_variant_present':
        return 'error_group_buy_variant_present';
      case 'checkout_unresolved':
        return 'error_checkout_unresolved';
      case 'checkout_failed_previously':
        return 'error_checkout_failed_previously';
      case 'checkout_upstream_failed':
        return 'error_checkout_upstream_failed';
      case 'checkout_unavailable':
        return 'error_checkout_unavailable';
      case 'invalid_request':
        return 'error_invalid_request';
      default:
        return 'error_generic';
    }
  }

  function fetchCart() {
    var cartUrl = (typeof routes !== 'undefined' && routes && routes.cart_url) || '/cart';
    return fetch(cartUrl + '.js', { headers: { Accept: 'application/json' } }).then(function (response) {
      if (!response.ok) {
        throw new Error('CaratBankPaymentCheckout: cart fetch failed with status ' + response.status);
      }
      return response.json();
    });
  }

  // ---- DOM glue below. Kept thin and deliberately untangled from the pure
  // functions above so the money/validation-relevant logic can be unit
  // tested without a browser — same split cart.js uses for
  // CaratCartPricing._internal. ----

  function getModal() {
    return document.getElementById(MODAL_ID);
  }

  function fieldErrorContainer(form, fieldName) {
    var input = form.querySelector('[name="' + fieldName + '"]');
    if (!input) return null;
    var describedBy = input.getAttribute('aria-describedby');
    return describedBy ? document.getElementById(describedBy) : null;
  }

  function setFieldInvalid(form, fieldName, message) {
    var input = form.querySelector('[name="' + fieldName + '"]');
    if (input) input.setAttribute('aria-invalid', 'true');
    var container = fieldErrorContainer(form, fieldName);
    if (!container) return;
    var textEl = container.querySelector(FIELD_ERROR_TEXT_SELECTOR);
    if (textEl) textEl.textContent = message;
    container.hidden = false;
  }

  function clearFieldErrors(form) {
    ALL_FIELD_NAMES.forEach(function (name) {
      var input = form.querySelector('[name="' + name + '"]');
      if (input) input.removeAttribute('aria-invalid');
      var container = fieldErrorContainer(form, name);
      if (container) container.hidden = true;
    });
  }

  function showErrorSummary(modal, messages) {
    var summary = modal ? modal.querySelector(ERROR_SUMMARY_SELECTOR) : null;
    if (!summary) return;
    var heading = document.createElement('p');
    heading.className = 'form-status caption-large text-body';
    heading.textContent = localeString('error_summary_heading');
    var list = document.createElement('ul');
    list.setAttribute('role', 'list');
    messages.forEach(function (message) {
      var item = document.createElement('li');
      item.textContent = message;
      list.appendChild(item);
    });
    summary.innerHTML = '';
    summary.appendChild(heading);
    summary.appendChild(list);
    summary.hidden = false;
    summary.focus();
  }

  function hideErrorSummary(modal) {
    var summary = modal ? modal.querySelector(ERROR_SUMMARY_SELECTOR) : null;
    if (!summary) return;
    summary.hidden = true;
    summary.innerHTML = '';
  }

  function setStatus(form, text) {
    var status = form.querySelector(STATUS_SELECTOR);
    if (!status) return;
    if (!text) {
      status.hidden = true;
      status.textContent = '';
      return;
    }
    status.hidden = false;
    status.textContent = text;
  }

  function setSubmitting(form, isSubmitting) {
    var button = form.querySelector(SUBMIT_SELECTOR);
    if (!button) return;
    button.disabled = isSubmitting;
    if (isSubmitting) {
      setStatus(form, localeString('submitting'));
    }
  }

  function resetFormState(form) {
    if (!form) return;
    clearFieldErrors(form);
    setStatus(form, null);
    var modal = form.closest ? form.closest('modal-dialog') : null;
    hideErrorSummary(modal || getModal());
    var submit = form.querySelector(SUBMIT_SELECTOR);
    if (submit) submit.disabled = false;
  }

  function openModal(trigger) {
    var modal = getModal();
    if (!modal || typeof modal.show !== 'function') return;
    var form = modal.querySelector(FORM_SELECTOR);
    resetFormState(form);
    modal.show(trigger);
  }

  function closeModal(fromElement) {
    var modal = (fromElement && fromElement.closest && fromElement.closest('modal-dialog')) || getModal();
    if (modal && typeof modal.hide === 'function') modal.hide();
  }

  function handleDocumentClick(event) {
    var target = event.target;
    if (!target || typeof target.closest !== 'function') return;

    var trigger = target.closest(TRIGGER_SELECTOR);
    if (trigger) {
      event.preventDefault();
      openModal(trigger);
      return;
    }

    var dismiss = target.closest(DISMISS_SELECTOR);
    if (dismiss) {
      event.preventDefault();
      closeModal(dismiss);
    }
  }

  function handleSubmit(event) {
    var form = event.target;
    if (!form || typeof form.matches !== 'function' || !form.matches(FORM_SELECTOR)) return;
    event.preventDefault();

    var modal = form.closest('modal-dialog') || getModal();

    clearFieldErrors(form);
    hideErrorSummary(modal);
    setStatus(form, null);

    var values = readFormValues(form);
    var validationErrors = validateFormValues(values);
    if (validationErrors.length > 0) {
      validationErrors.forEach(function (error) {
        setFieldInvalid(form, error.field, localeString(error.messageKey));
      });
      showErrorSummary(
        modal,
        validationErrors.map(function (error) {
          return localeString(error.messageKey);
        })
      );
      return;
    }

    setSubmitting(form, true);

    fetchCart()
      .then(function (cart) {
        var lines = buildRequestLines(cart);
        if (lines.length === 0) {
          // Not a server round trip: nothing to quote. Same message as an
          // unpurchasable-lines rejection, since the customer-facing
          // guidance ("refresh your cart") is the same.
          return Promise.reject({ localMessageKey: 'error_unpurchasable_lines' });
        }
        return fetch(PROXY_PATH, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify(buildRequestBody(values, lines)),
        });
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
        if (!result.response.ok) {
          showErrorSummary(modal, [localeString(messageKeyForFailure(result.response.status, result.body))]);
          setSubmitting(form, false);
          return;
        }

        var dto = result.body;
        if (dto && dto.invoiceUrl) {
          setStatus(form, localeString('redirecting'));
          window.location.href = dto.invoiceUrl;
          return;
        }

        // Success, but Shopify did not return an invoice URL to redirect to
        // (e.g. `invoiceUrl: null` — see checkoutResponseDto.ts). The order
        // and invoice email already exist (criterion 85 carries the same
        // not-committed disclosure); tell the customer to check their email
        // rather than leaving them on a form that just silently stopped.
        setSubmitting(form, false);
        setStatus(form, localeString('success_check_email'));
        var submit = form.querySelector(SUBMIT_SELECTOR);
        if (submit) submit.disabled = true;
      })
      .catch(function (error) {
        var key = (error && error.localMessageKey) || 'error_network';
        showErrorSummary(modal, [localeString(key)]);
        setSubmitting(form, false);
        setStatus(form, null);
      });
  }

  function init() {
    document.addEventListener('click', handleDocumentClick);
    document.addEventListener('submit', handleSubmit);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  return {
    _internal: {
      normalizeValues: normalizeValues,
      validateFormValues: validateFormValues,
      buildShippingAddress: buildShippingAddress,
      buildRequestBody: buildRequestBody,
      buildRequestLines: buildRequestLines,
      messageKeyForFailure: messageKeyForFailure,
    },
  };
})();
