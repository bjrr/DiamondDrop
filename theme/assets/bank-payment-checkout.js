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
  /** The authenticated durable instructions page — `templates/page.bank-payment-orders.json`. */
  var ORDERS_PAGE_PATH = '/pages/bank-payment-orders';
  var MODAL_ID = 'CaratBankCheckoutModal';
  var TRIGGER_SELECTOR = '[data-carat-checkout-action="bank-payment"]';
  var DISMISS_SELECTOR = '[data-carat-bank-checkout-dismiss]';
  var FORM_SELECTOR = '[data-carat-bank-checkout-form]';
  var SUBMIT_SELECTOR = '[data-carat-bank-checkout-submit]';
  var STATUS_SELECTOR = '[data-carat-bank-checkout-status]';
  var ERROR_SUMMARY_SELECTOR = '[data-carat-bank-checkout-error-summary]';
  var FIELD_ERROR_TEXT_SELECTOR = '[data-carat-bank-checkout-field-error-text]';
  var SHIPPING_SELECTOR = '[data-carat-bank-checkout-shipping]';
  var SHIPPING_OPTIONS_SELECTOR = '[data-carat-bank-checkout-shipping-options]';
  var SHIPPING_RADIO_NAME = 'caratBankCheckoutShippingService';

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
  /**
   * TWO BODIES, ONE BUILDER (owner decision 2026-11-15).
   *
   * `shippingServiceTitle` absent -> `intent: 'shipping_rates'`, which asks
   * the server what services this basket and destination can have and creates
   * NOTHING. Present -> an order-creation body carrying the chosen service.
   *
   * ONLY A TITLE CROSSES THE WIRE. No price and no rate handle: the server
   * re-calculates the authoritative rates and looks the handle up from its own
   * list, so there is nothing here a tampered browser could turn into cheaper
   * shipping. See `app/app/domain/shipping/shippingRateSelection.ts`.
   *
   * The two shapes must stay mutually exclusive — the route REFUSES a body
   * that sends a service title alongside the quote intent, rather than
   * ignoring one of them.
   */
  function buildRequestBody(values, lines, shippingServiceTitle) {
    var body = {
      mode: 'bank',
      email: values.email,
      shippingAddress: buildShippingAddress(values),
      lines: lines,
    };
    if (nonEmptyString(shippingServiceTitle)) {
      body.shippingServiceTitle = shippingServiceTitle;
    } else {
      body.intent = 'shipping_rates';
    }
    return body;
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
   * status/body this file does not recognize (unauthorized,
   * method_not_allowed, an unparsed body, a network failure the caller
   * detects separately) falls back to a single generic message — never a
   * blank or a raw error code shown to the customer.
   *
   * authentication_required (401, docs/REQUIRED-CUSTOMER-ACCOUNTS.md §4) is
   * its own distinct case rather than falling through to error_generic. The
   * dialog itself is gated server-side in Liquid (bank-payment-checkout-
   * dialog.liquid only renders this form for a signed-in `customer`), so
   * this branch should be unreachable in the intended flow — but a session
   * that expires between page load and submit is a real, if rare, gap that
   * client-side gating alone cannot close. The customer still deserves the
   * real reason rather than a generic failure, matching the same
   * owner-approved gate sentence used everywhere else this rule applies.
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
      case 'authentication_required':
        return 'error_authentication_required';
      // Shipping (owner decision 2026-11-15). Two codes, two distinct
      // messages, because the customer's next action differs: an
      // undeliverable address needs correcting, whereas a service that has
      // just stopped being available needs re-picking from a refreshed list.
      // Collapsing them to one message would tell half the customers to do
      // the wrong thing.
      case 'shipping_unavailable':
        return 'error_shipping_unavailable';
      case 'shipping_service_unavailable':
        return 'error_shipping_service_unavailable';
      default:
        return 'error_generic';
    }
  }

  function nonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
  }

  /**
   * Pure. The server sends minor units as a STRING and never a float, so this
   * formats from the string rather than parsing to a Number first — $1,055.00
   * in cents is well inside Number's safe range, but the habit is what keeps a
   * larger figure from silently losing precision later.
   *
   * Two-decimal minor units only, which is every currency this store sells in.
   */
  function formatShippingPrice(priceMinorUnits, currency) {
    var digits = String(priceMinorUnits == null ? '' : priceMinorUnits).replace(/[^0-9]/g, '');
    if (digits === '') return '';
    while (digits.length < 3) digits = '0' + digits;
    var major = digits.slice(0, -2).replace(/^0+(?=\d)/, '');
    var minor = digits.slice(-2);
    return major + '.' + minor + ' ' + (currency || '');
  }

  /**
   * Pure. Turns a rate into the label the customer reads.
   *
   * A ZERO PRICE IS NAMED, NOT SHOWN AS "0.00". "Complimentary Express Insured
   * Shipping with Signature — 0.00 USD" invites the question "zero of what?";
   * the service name already says it is complimentary, so the price is
   * replaced by the word rather than printed.
   */
  function shippingOptionLabel(rate) {
    if (String(rate.priceMinorUnits) === '0') {
      return rate.title + ' — ' + localeString('shipping_included');
    }
    return rate.title + ' — ' + formatShippingPrice(rate.priceMinorUnits, rate.currency);
  }

  /**
   * Replaces the shipping options with `rates`, selecting the cheapest by
   * default so the customer is never pushed toward the dearer service.
   *
   * RETURNS the title it pre-selected, or null when there is nothing to
   * choose — the caller needs to know, because "no rates" is a refusal rather
   * than an empty list to render.
   */
  function renderShippingOptions(form, rates) {
    var fieldset = form.querySelector(SHIPPING_SELECTOR);
    var container = form.querySelector(SHIPPING_OPTIONS_SELECTOR);
    if (!fieldset || !container) return null;

    container.textContent = '';
    if (!rates || rates.length === 0) {
      fieldset.hidden = true;
      return null;
    }

    var cheapestIndex = 0;
    for (var i = 1; i < rates.length; i += 1) {
      if (Number(rates[i].priceMinorUnits) < Number(rates[cheapestIndex].priceMinorUnits)) {
        cheapestIndex = i;
      }
    }

    rates.forEach(function (rate, index) {
      var id = 'CaratBankCheckoutShipping-' + index;
      var wrapper = document.createElement('div');
      wrapper.className = 'carat-bank-checkout-modal__shipping-option';

      var input = document.createElement('input');
      input.type = 'radio';
      input.name = SHIPPING_RADIO_NAME;
      input.id = id;
      // THE TITLE IS THE VALUE, and it is the only thing submitted. No price
      // and no rate handle ride along, so a tampered DOM cannot buy cheaper
      // shipping — the server re-resolves the rate from its own list.
      input.value = rate.title;
      if (index === cheapestIndex) input.checked = true;

      var label = document.createElement('label');
      label.setAttribute('for', id);
      label.textContent = shippingOptionLabel(rate);

      wrapper.appendChild(input);
      wrapper.appendChild(label);
      container.appendChild(wrapper);
    });

    fieldset.hidden = false;
    return rates[cheapestIndex].title;
  }

  /** The service the customer has chosen, or null while none is offered/selected. */
  function selectedShippingService(form) {
    var checked = form.querySelector('input[name="' + SHIPPING_RADIO_NAME + '"]:checked');
    return checked && nonEmptyString(checked.value) ? checked.value : null;
  }

  function shippingRatesFromBody(body) {
    if (!body || typeof body !== 'object' || !Array.isArray(body.shippingRates)) return [];
    return body.shippingRates.filter(function (rate) {
      return rate && nonEmptyString(rate.title);
    });
  }

  /**
   * REMOVED — `replaceAll` / `buildSuccessMessage`.
   *
   * They filled a one-line success template with the amount, the Zelle
   * recipient and the reference. `renderPaymentInstructions` below supersedes
   * that: it renders the full panel — Zelle AND domestic wire, the deadline,
   * what reference to include, the commitment notice and the support address
   * — from the server-composed instructions object.
   *
   * The one-liner told the customer their wire details had been emailed,
   * which is precisely the email dependency D12 exists to remove: a customer
   * paying by wire had nothing on screen to act on.
   */

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

  /**
   * Renders the CaratForUs Bank Payment confirmation in place of the form.
   *
   * EVERY VALUE COMES FROM THE SERVER RESPONSE. Nothing is recomputed here —
   * no price arithmetic, no deadline arithmetic, no currency maths. The
   * amount is already a formatted decimal string produced from bigint minor
   * units server-side, and the deadline is already an ISO instant.
   *
   * textContent throughout, never innerHTML: these values cross a network
   * boundary, and a payment destination is the last thing that should be
   * able to introduce markup into the page.
   */
  function renderPaymentInstructions(modal, form, dto) {
    var ins = dto.instructions;
    var host = form.parentNode || form;

    function el(tag, className, text) {
      var node = document.createElement(tag);
      if (className) node.className = className;
      if (text !== undefined && text !== null) node.textContent = text;
      return node;
    }

    function row(dl, label, value) {
      dl.appendChild(el('dt', 'carat-bank-confirmation__label', label));
      dl.appendChild(el('dd', 'carat-bank-confirmation__value', value));
    }

    var panel = el('div', 'carat-bank-confirmation');
    panel.setAttribute('role', 'status');
    panel.setAttribute('aria-live', 'polite');

    panel.appendChild(el('h3', 'carat-bank-confirmation__heading', localeString('confirmation_heading')));
    panel.appendChild(el('p', 'carat-bank-confirmation__still-required', ins.paymentStillRequired));
    // The approved commitment language, chosen server-side by flow — Buy Now
    // and Group Buy say materially different things and must not be merged.
    panel.appendChild(el('p', 'carat-bank-confirmation__commitment', ins.commitmentNotice));

    var summary = el('dl', 'carat-bank-confirmation__summary');
    row(summary, localeString('confirmation_reference'), ins.reference);
    row(summary, localeString('confirmation_amount_due'), ins.formattedAmountDue + ' ' + ins.currency);
    row(summary, localeString('confirmation_deadline'), formatDeadline(ins.paymentDeadline));
    panel.appendChild(summary);

    if (ins.extensionNotice) {
      panel.appendChild(el('p', 'carat-bank-confirmation__extension', ins.extensionNotice));
    }

    panel.appendChild(el('h4', 'carat-bank-confirmation__methods-heading', localeString('confirmation_methods')));
    for (var i = 0; i < ins.methods.length; i += 1) {
      var m = ins.methods[i];
      var block = el('div', 'carat-bank-confirmation__method');
      var fields = el('dl', 'carat-bank-confirmation__method-fields');
      if (m.kind === 'zelle') {
        block.appendChild(el('h5', 'carat-bank-confirmation__method-name', localeString('confirmation_zelle')));
        row(fields, localeString('confirmation_send_to'), m.recipient);
        row(fields, localeString('confirmation_memo'), m.memo);
      } else {
        block.appendChild(el('h5', 'carat-bank-confirmation__method-name', localeString('confirmation_wire')));
        row(fields, localeString('confirmation_bank_name'), m.bankName);
        row(fields, localeString('confirmation_account_name'), m.accountName);
        row(fields, localeString('confirmation_routing'), m.routingNumber);
        row(fields, localeString('confirmation_account_number'), m.accountNumber);
        row(fields, localeString('confirmation_reference_label'), m.reference);
      }
      block.appendChild(fields);
      panel.appendChild(block);
    }

    panel.appendChild(el('p', 'carat-bank-confirmation__include', ins.includeWithPayment));

    /**
     * THE DURABLE SURFACE. This panel disappears the moment the customer
     * closes the dialog, and that was half of register D12: a customer who
     * navigated away had nothing but an email. The orders page is
     * authenticated, bookmarkable and reachable from another device, and
     * saying so here is what makes it findable.
     *
     * An anchor, not a redirect: nothing should navigate the customer away
     * from instructions they may still be reading.
     */
    var durable = el('p', 'carat-bank-confirmation__durable');
    var link = el('a', 'carat-bank-confirmation__durable-link', localeString('confirmation_view_orders_link'));
    link.setAttribute('href', ORDERS_PAGE_PATH);
    durable.appendChild(document.createTextNode(localeString('confirmation_view_orders') + ' '));
    durable.appendChild(link);
    panel.appendChild(durable);

    panel.appendChild(
      el('p', 'carat-bank-confirmation__support', localeString('confirmation_support') + ' ' + ins.supportEmail)
    );

    form.hidden = true;
    host.appendChild(panel);
    if (modal) hideErrorSummary(modal);
  }

  /** ISO instant to a readable UTC string. No arithmetic — the server decided the instant. */
  function formatDeadline(iso) {
    var parsed = new Date(iso);
    if (isNaN(parsed.getTime())) return iso;
    var text = parsed.toISOString();
    return text.slice(0, 10) + ' ' + text.slice(11, 16) + ' UTC';
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

    // ========================================================================
    // TWO SUBMITS, DELIBERATELY (owner decision 2026-11-15)
    // ========================================================================
    // The first press quotes shipping and creates NOTHING; the second, with a
    // service chosen, creates the order. The rates depend on the destination
    // the customer has just finished typing AND on the Bank Payment
    // merchandise total, so there is no earlier moment at which they could
    // honestly be shown.
    //
    // `chosenService` is read from the DOM at submit time rather than held in
    // a module variable: the radios ARE the state, and a cached copy could
    // disagree with what the customer can see — which is the one thing that
    // must never happen about a charge.
    var chosenService = selectedShippingService(form);

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
          body: JSON.stringify(buildRequestBody(values, lines, chosenService)),
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
          // A service that has just stopped being available comes back with
          // the LIVE list attached — usually because the basket crossed
          // $1,000 between the quote and the submit, so complimentary Express
          // replaced the paid options. Re-render from that list so the
          // customer can act on the message instead of guessing.
          var replacement = shippingRatesFromBody(result.body);
          if (replacement.length > 0) renderShippingOptions(form, replacement);
          showErrorSummary(modal, [localeString(messageKeyForFailure(result.response.status, result.body))]);
          setSubmitting(form, false);
          return;
        }

        // ====================================================================
        // THE RATE QUOTE. No order exists yet.
        // ====================================================================
        // A 200 carrying `shippingRates` is the answer to the quote intent.
        // Render the choices and stop — pressing submit again, now with a
        // service selected, is what creates the order.
        if (!chosenService && result.body && Array.isArray(result.body.shippingRates)) {
          var rates = shippingRatesFromBody(result.body);
          var preselected = renderShippingOptions(form, rates);
          setSubmitting(form, false);
          if (!preselected) {
            // Nothing can be shipped to this address. A refusal, never a
            // silent $0 — the customer is told, and no order is created.
            showErrorSummary(modal, [localeString('error_shipping_unavailable')]);
            return;
          }
          setStatus(form, localeString('shipping_choose_prompt'));
          return;
        }

        // ====================================================================
        // CARATFORUS OWNS THIS MOMENT. NO REDIRECT. (register D12 + D15)
        // ====================================================================
        // This used to send the customer to Shopify's draft-order invoice,
        // which (a) exposed a **Confirm order** button letting them advance a
        // draft that must stay staff-controlled until payment is verified,
        // and (b) meant the only place they were ever told HOW to pay was an
        // email — so a mail-provider outage left them holding an order with
        // no destination for the money.
        //
        // The server now returns the instructions in the response, resolved
        // per request and never persisted. They are rendered here, so the
        // customer has them whether or not the email arrives.
        var dto = result.body;
        setSubmitting(form, false);
        if (dto && dto.instructions) {
          renderPaymentInstructions(modal, form, dto);
          return;
        }

        // Defensive only: a 200 with no instructions should be impossible,
        // because the server refuses the checkout outright when payment
        // coordinates are unconfigured. Say something true rather than
        // leaving a form that silently stopped.
        setStatus(form, localeString('success_no_instructions'));
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
