/**
 * Warranty Claim Form controller (Slice 5 task 5-5,
 * docs/WARRANTY-CLAIMS.md, docs/specs/SLICE-5-WARRANTY-CLAIMS.md criteria
 * 153-156). Validates client-side, then POSTs JSON to
 * `/apps/carat/warranty-claim` (apps.carat.warranty-claim.tsx) through the
 * App Proxy -- mirrors `assets/bank-payment-checkout.js`'s validate/fetch/
 * error-summary/field-error pattern closely, adapted to a plain page form
 * instead of a modal.
 *
 * CRITERION 156 LIVES HERE TOO, NOT JUST IN THE LIQUID. This file never
 * constructs, requests, or displays a shipping address or instruction on
 * ANY response path -- success or failure. The success confirmation reads
 * only `claimReference` from the server's response, exactly the closed
 * allow-list `buildConfirmationDto` in the route returns (`claimId`/
 * `claimReference`/`status`) -- there is nothing else in that response TO
 * render, by construction on the server side, and this file does not
 * invent additional content around it.
 *
 * ORDER PICKER (docs/REQUIRED-CUSTOMER-ACCOUNTS.md §5). `wireOrderLookup`
 * below is what actually fills the form's hidden `order_id`/`line_item_id`
 * inputs: it POSTs the order NUMBER the customer typed (e.g. "1001") to
 * `/apps/carat/warranty-order-lookup` (an authenticated-only route -- see
 * its own module comment), and on a resolved match, lets the customer pick
 * one of the returned line items. THIS IS UX ONLY: the route's own 401 is
 * what actually enforces that only a signed-in customer can look up their
 * own orders, and the route deliberately returns the SAME `{ resolved:
 * false }` whether an order doesn't exist or belongs to someone else --
 * this file never tries to tell those two cases apart, and
 * `order_lookup_not_found` is worded generically for exactly that reason.
 *
 * `variant_id` IS A BEST-EFFORT CONVENIENCE ONLY. `shopifyVariantId`
 * resolution never gates claim creation (see the route's own module
 * comment) and most customers have no way to know a Shopify variant id at
 * all, so this file never asks for it directly -- it only reads
 * `?variant_id=` from the page URL (a possible future deep-link source, not
 * built by this task) and includes it in the request when present. Its
 * absence changes nothing about whether the claim can be filed.
 *
 * EVERY OPTIONAL FIELD IS OMITTED, NEVER SENT EMPTY. The server's zod
 * schema treats an empty string differently from an absent key for several
 * fields (`dateOnly` requires `YYYY-MM-DD` or omission, not "";
 * `certificateOrSerialIdentifier`/`impactOrDamageDetails`/
 * `alterationDetails` are `.optional()`, not `.optional().nullable()` --
 * sending "" would be a present-but-possibly-invalid value instead of a
 * cleanly absent one). `buildRequestBody` below only ever adds a key when
 * the corresponding field actually has a trimmed, non-empty value.
 *
 * `_internal` IS EXPOSED ON `window.CaratWarrantyClaimForm` PURELY FOR
 * TESTING (`app/app/theme/warrantyClaimFormSandbox.ts` /
 * `warrantyClaimForm.test.ts`), same technique as
 * `window.CaratBankPaymentCheckout` in `bank-payment-checkout.js`. Only the
 * genuinely pure order-lookup helpers are exposed -- the rest of this file
 * still reads the DOM directly, unchanged from before this task.
 */
(function () {
  // Guards against double-binding the document-level submit listener if
  // this section is ever placed twice on one page/template (the theme
  // editor allows it even though this form has no reason to appear twice) —
  // same guard pattern `assets/luxury-steal-gate.js` uses for the same
  // reason.
  if (window.caratWarrantyClaimFormLoaded) return;
  window.caratWarrantyClaimFormLoaded = true;

  var PROXY_PATH = '/apps/carat/warranty-claim';
  var ORDER_LOOKUP_PROXY_PATH = '/apps/carat/warranty-order-lookup';
  var FORM_SELECTOR = '[data-carat-warranty-form]';
  var ERROR_SUMMARY_SELECTOR = '[data-carat-warranty-error-summary]';
  var CONFIRMATION_SELECTOR = '[data-carat-warranty-confirmation]';
  var STATUS_SELECTOR = '[data-carat-warranty-status]';
  var SUBMIT_SELECTOR = '[data-carat-warranty-submit]';
  var FIELD_ERROR_TEXT_SELECTOR = '[data-carat-warranty-field-error-text]';

  // Order picker selectors -- theme/sections/warranty-claim-form.liquid's
  // `data-carat-warranty-order-picker` fieldset.
  var ORDER_NUMBER_INPUT_SELECTOR = '[data-carat-warranty-order-number-input]';
  var LOOKUP_BUTTON_SELECTOR = '[data-carat-warranty-lookup-submit]';
  var ORDER_LOOKUP_STATUS_SELECTOR = '[data-carat-warranty-order-lookup-status]';
  var ORDER_SEARCH_SELECTOR = '[data-carat-warranty-order-search]';
  var ORDER_RESULT_SELECTOR = '[data-carat-warranty-order-result]';
  var ORDER_RESULT_SUMMARY_SELECTOR = '[data-carat-warranty-order-result-summary]';
  var LINE_ITEM_OPTIONS_SELECTOR = '[data-carat-warranty-line-item-options]';
  var SEARCH_AGAIN_SELECTOR = '[data-carat-warranty-order-search-again]';

  // Deliberately permissive (not RFC 5322) -- a fast client-side pre-check
  // only. The server's zod `.email()` check is the actual authority; this
  // can never be stricter than necessary and reject something the server
  // would accept. Same pattern and same caveat as bank-payment-checkout.js.
  var EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function localeString(key) {
    var strings = (window.warrantyClaimStrings) || {};
    return strings[key] || key;
  }

  function trimmedValue(form, name) {
    var field = form.querySelector('[name="' + name + '"]');
    return field && typeof field.value === 'string' ? field.value.trim() : '';
  }

  function checkedRadioValue(form, name) {
    var checked = form.querySelector('[name="' + name + '"]:checked');
    return checked ? checked.value : '';
  }

  // ---------------------------------------------------------------------
  // Order lookup -- PURE helpers only (no `document`/`window`/`fetch`),
  // exposed via `window.CaratWarrantyClaimForm._internal` at the bottom of
  // this file for `warrantyClaimForm.test.ts`. The DOM-wiring counterpart
  // (`wireOrderLookup`, below the conditional-details helpers) calls these
  // but is not itself pure.
  // ---------------------------------------------------------------------

  // Mirrors bank-payment-checkout.js's own `messageKeyForFailure` pattern:
  // never surfaces a raw HTTP status or the route's internal error code to
  // the customer. The route
  // (apps.carat.warranty-order-lookup.tsx) only ever returns 400/401/405/
  // 500/502 on a non-2xx path; a signed-in customer hitting 401 mid-session
  // (e.g. an expired login) gets the same sign-in sentence used elsewhere,
  // everything else gets the generic "try again" copy.
  function orderLookupMessageKeyForFailure(status) {
    if (status === 401) return 'sign_in_required_message';
    return 'error_service_unavailable';
  }

  /**
   * Normalizes the order-lookup route's JSON body into a small, defensive
   * shape this file actually understands. The route's documented contract
   * (apps.carat.warranty-order-lookup.tsx) is
   * `{ resolved: true, order: { orderRef, orderName, lineItems: [{ lineRef,
   * title, quantity }] } }` or `{ resolved: false }` -- but this function
   * treats ANYTHING that doesn't match that shape (malformed JSON, a
   * resolved order with no line items, a line item missing its `lineRef`)
   * the same as "not resolved" rather than throwing or rendering a partial
   * result the customer could submit against.
   */
  function normalizeOrderLookupResult(body) {
    var notResolved = { resolved: false, order: null };
    if (!body || typeof body !== 'object' || body.resolved !== true) return notResolved;

    var order = body.order;
    if (!order || typeof order !== 'object' || !Array.isArray(order.lineItems)) return notResolved;

    var lineItems = [];
    for (var i = 0; i < order.lineItems.length; i++) {
      var item = order.lineItems[i];
      if (!item || typeof item.lineRef !== 'string' || !item.lineRef) continue;
      lineItems.push({
        lineRef: item.lineRef,
        title: typeof item.title === 'string' ? item.title : '',
        quantity: typeof item.quantity === 'number' ? item.quantity : 0,
      });
    }
    if (lineItems.length === 0) return notResolved;
    if (typeof order.orderRef !== 'string' || !order.orderRef) return notResolved;

    return {
      resolved: true,
      order: {
        orderRef: order.orderRef,
        orderName: typeof order.orderName === 'string' ? order.orderName : '',
        lineItems: lineItems,
      },
    };
  }

  // Pure string templating, same `{{ placeholder }}` replace technique as
  // `showConfirmation`'s `success_body_html` handling below -- not a
  // templating library. Takes the locale TEMPLATE as a parameter (rather
  // than reading `window.warrantyClaimStrings` itself) so it stays pure and
  // independently testable.
  function buildLineItemOptionLabel(template, item) {
    return template.replace('{{ title }}', item.title).replace('{{ quantity }}', String(item.quantity));
  }

  // ---------------------------------------------------------------------
  // Conditional detail fields -- shown, and made required, only when the
  // paired yes/no question is answered "yes". Kept ALWAYS PRESENT in the
  // DOM (never removed), only `hidden`/`required` toggled, so a screen
  // reader user who already has focus inside is never surprised by an
  // element vanishing out from under them mid-interaction.
  // ---------------------------------------------------------------------
  function wireConditionalDetails(radioSelector, wrapperSelector, detailsFieldName) {
    var radios = document.querySelectorAll(radioSelector);
    if (!radios.length) return;
    var wrapper = document.querySelector(wrapperSelector);
    var details = wrapper ? wrapper.querySelector('[name="' + detailsFieldName + '"]') : null;

    function apply() {
      var form = radios[0].form;
      var shouldShow = checkedRadioValue(form, radios[0].name) === 'yes';
      if (!wrapper) return;
      wrapper.hidden = !shouldShow;
      if (details) {
        if (shouldShow) {
          details.setAttribute('required', '');
        } else {
          details.removeAttribute('required');
        }
      }
    }

    radios.forEach(function (radio) {
      radio.addEventListener('change', apply);
    });
    apply();
  }

  // ---------------------------------------------------------------------
  // Deep-link pre-fill -- see this file's header comment ("ORDER PICKER")
  // on why these are read from the URL rather than requiring the order
  // picker as the only path. `order_id`/`line_item_id` are now the hidden
  // inputs the picker also fills; a link carrying real GIDs bypasses the
  // picker entirely and lets the customer proceed straight to the rest of
  // the form. There is no real caller of this today -- see the header
  // comment.
  // ---------------------------------------------------------------------
  function prefillFromQueryString(form) {
    var params = new URLSearchParams(window.location.search);
    var orderId = params.get('order_id');
    var lineItemId = params.get('line_item_id');
    var variantId = params.get('variant_id');

    if (orderId) {
      var orderField = form.querySelector('[name="order_id"]');
      if (orderField && !orderField.value) orderField.value = orderId;
    }
    if (lineItemId) {
      var lineField = form.querySelector('[name="line_item_id"]');
      if (lineField && !lineField.value) lineField.value = lineItemId;
    }
    if (variantId) {
      var variantField = form.querySelector('[name="variant_id"]');
      if (variantField) variantField.value = variantId;
    }
  }

  // ---------------------------------------------------------------------
  // Field-level error display -- mirrors bank-payment-checkout.js's
  // `setFieldInvalid`/`clearFieldErrors` exactly, generalized to this
  // form's field set via a name -> error-element-id map built once.
  // ---------------------------------------------------------------------
  var FIELD_ERROR_IDS = {
    // Point at the VISIBLE order-picker elements, not the hidden
    // `order_id`/`line_item_id` inputs themselves -- a hidden input cannot
    // usefully carry a visible error next to it. `setFieldInvalid`/
    // `clearFieldErrors` still look up the hidden input by `name` to set/
    // clear `aria-invalid` (harmless on a hidden element); only the visible
    // container these ids point to actually matters to the customer.
    order_id: 'WarrantyClaimOrderNumber-error',
    line_item_id: 'WarrantyClaimLineItemPicker-error',
    purchaser_name: 'WarrantyClaimPurchaserName-error',
    purchaser_email: 'WarrantyClaimPurchaserEmail-error',
    item_configuration: 'WarrantyClaimItemConfiguration-error',
    problem_description: 'WarrantyClaimProblemDescription-error',
    impact_or_damage_details: 'WarrantyClaimImpactDetails-error',
    alteration_details: 'WarrantyClaimAlterationDetails-error',
    acknowledgment: 'WarrantyClaimAcknowledgment-error',
  };

  function setFieldInvalid(form, fieldName, message) {
    var input = form.querySelector('[name="' + fieldName + '"]');
    if (input) input.setAttribute('aria-invalid', 'true');
    var errorId = FIELD_ERROR_IDS[fieldName];
    var container = errorId ? document.getElementById(errorId) : null;
    if (!container) return;
    var textEl = container.querySelector(FIELD_ERROR_TEXT_SELECTOR);
    if (textEl) textEl.textContent = message;
    container.hidden = false;
  }

  function clearFieldErrors(form) {
    Object.keys(FIELD_ERROR_IDS).forEach(function (fieldName) {
      var input = form.querySelector('[name="' + fieldName + '"]');
      if (input) input.removeAttribute('aria-invalid');
      var container = document.getElementById(FIELD_ERROR_IDS[fieldName]);
      if (container) container.hidden = true;
    });
  }

  function showErrorSummary(messages) {
    var summary = document.querySelector(ERROR_SUMMARY_SELECTOR);
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

  function hideErrorSummary() {
    var summary = document.querySelector(ERROR_SUMMARY_SELECTOR);
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
    if (button) button.disabled = isSubmitting;
    if (isSubmitting) setStatus(form, localeString('submitting'));
  }

  // ---------------------------------------------------------------------
  // Success -- REPLACES the form with a confirmation block. Only
  // `claimReference` from the response is ever interpolated; the rest of
  // the confirmation text is static, pinned locale copy (see this file's
  // header comment and the Liquid file's own comment on criterion 156 --
  // nothing here ever renders a shipping address or instruction).
  // ---------------------------------------------------------------------
  function showConfirmation(form, claimReference) {
    var confirmation = document.querySelector(CONFIRMATION_SELECTOR);
    if (!confirmation) return;

    var heading = document.createElement('p');
    heading.className = 'form-status caption-large text-body';
    heading.textContent = localeString('success_heading');

    var body = document.createElement('p');
    // The ONLY server-supplied value ever interpolated here. `escape`-
    // equivalent by construction: `claimReference` is inserted via
    // `textContent`/template replacement on a STRING already sourced from
    // a translated locale value, never via `innerHTML` with the reference
    // itself, so it cannot introduce markup even if a future claim
    // reference format ever changed.
    var template = localeString('success_body_html');
    body.innerHTML = template.replace('{{ reference }}', escapeHtml(claimReference));

    confirmation.innerHTML = '';
    confirmation.appendChild(heading);
    confirmation.appendChild(body);
    confirmation.hidden = false;
    confirmation.focus();

    form.hidden = true;
  }

  function escapeHtml(value) {
    var div = document.createElement('div');
    div.textContent = value;
    return div.innerHTML;
  }

  // ---------------------------------------------------------------------
  // Pure. Validates trimmed form values; returns [] when valid, else a
  // list of {field, messageKey}. Every server-side `.min(1)`/required rule
  // this mirrors is named in a comment at its check so the two stay
  // traceable to each other.
  // ---------------------------------------------------------------------
  function validate(form) {
    var errors = [];

    if (!trimmedValue(form, 'order_id')) errors.push({ field: 'order_id', messageKey: 'error_order_id_required' });
    if (!trimmedValue(form, 'line_item_id')) {
      errors.push({ field: 'line_item_id', messageKey: 'error_line_item_id_required' });
    }
    if (!trimmedValue(form, 'purchaser_name')) {
      errors.push({ field: 'purchaser_name', messageKey: 'error_purchaser_name_required' });
    }
    var email = trimmedValue(form, 'purchaser_email');
    if (!email || !EMAIL_PATTERN.test(email)) {
      errors.push({ field: 'purchaser_email', messageKey: 'error_purchaser_email_required' });
    }
    if (!trimmedValue(form, 'item_configuration')) {
      errors.push({ field: 'item_configuration', messageKey: 'error_item_configuration_required' });
    }
    if (!trimmedValue(form, 'problem_description')) {
      errors.push({ field: 'problem_description', messageKey: 'error_problem_description_required' });
    }

    // hadImpactOrDamageEvent / wasAlteredAfterDelivery: z.boolean() with no
    // default -- both yes/no questions are required client-side via the
    // `required` radio attribute already, so a genuinely empty selection is
    // caught by native constraint validation before this function is even
    // reached in practice; these checks are the defensive JS-level mirror.
    var impactAnswer = checkedRadioValue(form, 'had_impact_or_damage_event');
    if (impactAnswer === 'yes' && !trimmedValue(form, 'impact_or_damage_details')) {
      errors.push({ field: 'impact_or_damage_details', messageKey: 'error_impact_details_required' });
    }
    var alteredAnswer = checkedRadioValue(form, 'was_altered_after_delivery');
    if (alteredAnswer === 'yes' && !trimmedValue(form, 'alteration_details')) {
      errors.push({ field: 'alteration_details', messageKey: 'error_alteration_details_required' });
    }

    var acknowledgment = form.querySelector('[data-carat-warranty-acknowledgment]');
    if (!acknowledgment || !acknowledgment.checked) {
      errors.push({ field: 'acknowledgment', messageKey: 'error_acknowledgment_required' });
    }

    return errors;
  }

  // Pure. Omits every optional field that is blank, per this file's header
  // comment on the server's `.optional()`/`dateOnly` schema treatment.
  function buildRequestBody(form) {
    var body = {
      orderRef: trimmedValue(form, 'order_id'),
      lineRef: trimmedValue(form, 'line_item_id'),
      purchaserName: trimmedValue(form, 'purchaser_name'),
      purchaserEmail: trimmedValue(form, 'purchaser_email'),
      itemConfigurationDescription: trimmedValue(form, 'item_configuration'),
      problemDescription: trimmedValue(form, 'problem_description'),
      hadImpactOrDamageEvent: checkedRadioValue(form, 'had_impact_or_damage_event') === 'yes',
      wasAlteredAfterDelivery: checkedRadioValue(form, 'was_altered_after_delivery') === 'yes',
      // Gated on by client validation above; only reachable here when the
      // customer actually checked the box, never defaulted or inferred.
      claimAcknowledgmentAccepted: true,
    };

    // UPLOADS AND THEIR CLAIM ID TRAVEL TOGETHER OR NOT AT ALL. The server
    // requires `claimId` only when `uploads` is non-empty, and honours it
    // only then -- so one without the other is refused, and neither is a
    // perfectly valid claim.
    var uploads = collectUploads();
    if (uploads.length > 0) {
      body.claimId = claimIdForUploads();
      body.uploads = uploads;
    }

    var variantId = trimmedValue(form, 'variant_id');
    if (variantId) body.shopifyVariantId = variantId;

    var purchaseDate = trimmedValue(form, 'purchase_date');
    if (purchaseDate) body.purchaseDate = purchaseDate;
    var deliveryDate = trimmedValue(form, 'delivery_date');
    if (deliveryDate) body.deliveryDate = deliveryDate;
    var issueNoticedDate = trimmedValue(form, 'issue_first_noticed_date');
    if (issueNoticedDate) body.issueFirstNoticedDate = issueNoticedDate;

    var impactDetails = trimmedValue(form, 'impact_or_damage_details');
    if (impactDetails) body.impactOrDamageDetails = impactDetails;
    var alterationDetails = trimmedValue(form, 'alteration_details');
    if (alterationDetails) body.alterationDetails = alterationDetails;
    var certificate = trimmedValue(form, 'certificate_or_serial');
    if (certificate) body.certificateOrSerialIdentifier = certificate;

    return body;
  }

  // Maps a non-ok response to a locale error-message KEY. Never surfaces
  // the raw `error`/`reason` string from the server -- those are internal
  // identifiers (e.g. "order_lookup_failed", "acknowledgment_copy_pending
  // _approval"), and criterion "no internal reason anywhere a customer can
  // read it" (this slice's own follow-up ruling from the cart price-
  // unavailable task) applies here just as much as it did there.
  function messageKeyForFailure(status, body) {
    var errorCode = body && typeof body.error === 'string' ? body.error : null;
    if (errorCode === 'order_or_line_unresolved') return 'error_order_not_found';
    if (status === 503 || status === 500 || status === 502) return 'error_service_unavailable';
    return 'error_service_unavailable';
  }

  function handleSubmit(event) {
    var form = event.target;
    if (!form || typeof form.matches !== 'function' || !form.matches(FORM_SELECTOR)) return;
    event.preventDefault();

    clearFieldErrors(form);
    hideErrorSummary();
    setStatus(form, null);

    var errors = validate(form);
    if (errors.length > 0) {
      errors.forEach(function (error) {
        setFieldInvalid(form, error.field, localeString(error.messageKey));
      });
      showErrorSummary(
        errors.map(function (error) {
          return localeString(error.messageKey);
        })
      );
      return;
    }

    setSubmitting(form, true);

    fetch(PROXY_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(buildRequestBody(form)),
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
          showErrorSummary([localeString(messageKeyForFailure(result.response.status, result.body))]);
          setSubmitting(form, false);
          setStatus(form, null);
          return;
        }

        var claimReference = result.body && result.body.claimReference;
        setSubmitting(form, false);
        showConfirmation(form, claimReference || '');
      })
      .catch(function () {
        showErrorSummary([localeString('error_network')]);
        setSubmitting(form, false);
        setStatus(form, null);
      });
  }

  // ---------------------------------------------------------------------
  // Order picker -- DOM wiring around the pure helpers above. Finds the
  // order by number, lets the customer choose a line item, and fills the
  // form's hidden `order_id`/`line_item_id` inputs. See this file's own
  // header comment: the route's 401 is the actual enforcement, this is UX.
  // ---------------------------------------------------------------------
  function wireOrderLookup(form) {
    var numberInput = form.querySelector(ORDER_NUMBER_INPUT_SELECTOR);
    var lookupButton = form.querySelector(LOOKUP_BUTTON_SELECTOR);
    var searchWrapper = form.querySelector(ORDER_SEARCH_SELECTOR);
    var resultWrapper = form.querySelector(ORDER_RESULT_SELECTOR);
    var summaryEl = form.querySelector(ORDER_RESULT_SUMMARY_SELECTOR);
    var optionsContainer = form.querySelector(LINE_ITEM_OPTIONS_SELECTOR);
    var searchAgainButton = form.querySelector(SEARCH_AGAIN_SELECTOR);
    var orderIdField = form.querySelector('[name="order_id"]');
    var lineItemIdField = form.querySelector('[name="line_item_id"]');
    if (!numberInput || !lookupButton || !resultWrapper || !orderIdField || !lineItemIdField) return;

    function setLookupStatus(text) {
      var status = form.querySelector(ORDER_LOOKUP_STATUS_SELECTOR);
      if (!status) return;
      if (!text) {
        status.hidden = true;
        status.textContent = '';
        return;
      }
      status.hidden = false;
      status.textContent = text;
    }

    function clearOrderLevelErrors() {
      var orderError = document.getElementById(FIELD_ERROR_IDS.order_id);
      if (orderError) orderError.hidden = true;
      var lineError = document.getElementById(FIELD_ERROR_IDS.line_item_id);
      if (lineError) lineError.hidden = true;
      numberInput.removeAttribute('aria-invalid');
    }

    function resetToSearch() {
      orderIdField.value = '';
      lineItemIdField.value = '';
      if (optionsContainer) optionsContainer.innerHTML = '';
      resultWrapper.hidden = true;
      if (searchWrapper) searchWrapper.hidden = false;
      clearOrderLevelErrors();
      numberInput.focus();
    }

    function renderLineItemOptions(order) {
      if (!optionsContainer) return;
      optionsContainer.innerHTML = '';
      var template = localeString('line_item_option_label');
      order.lineItems.forEach(function (item, index) {
        var label = document.createElement('label');
        label.className = 'carat-warranty-claim__radio';

        var radio = document.createElement('input');
        radio.type = 'radio';
        radio.name = 'order_line_selection';
        radio.value = item.lineRef;
        radio.id = 'WarrantyClaimLineItemOption' + index;
        radio.addEventListener('change', function () {
          lineItemIdField.value = radio.value;
          clearOrderLevelErrors();
        });

        label.setAttribute('for', radio.id);
        label.appendChild(radio);
        label.appendChild(document.createTextNode(buildLineItemOptionLabel(template, item)));
        optionsContainer.appendChild(label);
      });
    }

    function handleLookupResponse(result) {
      if (!result.response.ok) {
        setFieldInvalid(form, 'order_id', localeString(orderLookupMessageKeyForFailure(result.response.status)));
        numberInput.focus();
        return;
      }

      var normalized = normalizeOrderLookupResult(result.body);
      if (!normalized.resolved) {
        setFieldInvalid(form, 'order_id', localeString('order_lookup_not_found'));
        numberInput.focus();
        return;
      }

      orderIdField.value = normalized.order.orderRef;
      lineItemIdField.value = '';
      if (summaryEl) {
        summaryEl.textContent = localeString('order_result_found').replace(
          '{{ order }}',
          normalized.order.orderName
        );
      }
      renderLineItemOptions(normalized.order);

      if (searchWrapper) searchWrapper.hidden = true;
      resultWrapper.hidden = false;
      resultWrapper.focus();
    }

    lookupButton.addEventListener('click', function () {
      var orderNumber = numberInput.value.trim();
      clearOrderLevelErrors();
      setLookupStatus(null);

      if (!orderNumber) {
        setFieldInvalid(form, 'order_id', localeString('error_order_number_required'));
        numberInput.focus();
        return;
      }

      lookupButton.disabled = true;
      setLookupStatus(localeString('searching_order'));

      fetch(ORDER_LOOKUP_PROXY_PATH, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ orderNumber: orderNumber }),
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
          lookupButton.disabled = false;
          setLookupStatus(null);
          handleLookupResponse(result);
        })
        .catch(function () {
          lookupButton.disabled = false;
          setLookupStatus(null);
          setFieldInvalid(form, 'order_id', localeString('error_network'));
        });
    });

    if (searchAgainButton) {
      searchAgainButton.addEventListener('click', resetToSearch);
    }
  }

  // =========================================================================
  // PHOTO UPLOADS
  // =========================================================================
  //
  // OPTIONAL, AND THAT IS LOAD-BEARING. A claim with no photos is a complete
  // claim. Nothing in this block may prevent submission: every failure path
  // ends with the customer still able to submit, and `collectUploads()`
  // returning only the files that genuinely reached R2.
  //
  // THE THREE-STEP HANDSHAKE, and why the claim id is minted here.
  // Evidence is uploaded BEFORE the claim exists, so the server cannot bind a
  // destination to a claim row that is not there yet. Instead this file
  // generates the claim's id up front, uses it for every destination request,
  // and submits it as `claimId`. That is safe because a caller-supplied id can
  // only ever create a BRAND NEW claim -- the primary key refuses reuse -- so
  // it cannot attach evidence to someone else's claim, and the persisted
  // destination's own `customerRef` still gates consumption to the identity
  // that requested it. (See `apps.carat.warranty-claim-upload-destination.tsx`.)
  //
  // PHOTOS ONLY. The server also accepts video, but the checksum it requires
  // is computed here, in the browser, and hashing a 300 MB video in a phone
  // tab is a hang. The 20 MB photo ceiling keeps it bounded.
  var UPLOAD_DESTINATION_PROXY_PATH = '/apps/carat/warranty-claim-upload-destination';
  var UPLOAD_MAX_PHOTOS = 5;
  // Mirrors `WARRANTY_CLAIM_UPLOAD_MAX_SIZE_BYTES.photo` and the photo half of
  // `WARRANTY_CLAIM_UPLOAD_ALLOWED_CONTENT_TYPES`. Duplicated deliberately:
  // this is a courtesy check so the customer learns immediately rather than
  // after an upload round trip. The SERVER remains the authority and re-checks
  // both -- never treat this list as the enforcement point.
  var UPLOAD_MAX_BYTES = 20000000;
  var UPLOAD_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

  // Populated only by uploads that actually completed.
  var uploadedFiles = [];
  var uploadClaimId = null;
  var uploadsDisabled = false;

  function newClaimId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    // Fallback for browsers without randomUUID. Uses crypto.getRandomValues
    // (not Math.random) so the id is still unguessable -- a guessable claim id
    // would not grant access to anything, but there is no reason to weaken it.
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = [];
    for (var i = 0; i < bytes.length; i++) {
      hex.push((bytes[i] + 0x100).toString(16).slice(1));
    }
    return (
      hex.slice(0, 4).join('') +
      '-' +
      hex.slice(4, 6).join('') +
      '-' +
      hex.slice(6, 8).join('') +
      '-' +
      hex.slice(8, 10).join('') +
      '-' +
      hex.slice(10, 16).join('')
    );
  }

  function claimIdForUploads() {
    if (!uploadClaimId) uploadClaimId = newClaimId();
    return uploadClaimId;
  }

  /** SHA-256 of the file bytes, hex, prefixed to name the algorithm. */
  function checksumFor(file) {
    return file.arrayBuffer().then(function (buffer) {
      return window.crypto.subtle.digest('SHA-256', buffer).then(function (digest) {
        var view = new Uint8Array(digest);
        var hex = '';
        for (var i = 0; i < view.length; i++) {
          hex += (view[i] + 0x100).toString(16).slice(1);
        }
        return 'sha256:' + hex;
      });
    });
  }

  function showUploadError(messageKey) {
    var wrapper = document.querySelector('[data-carat-warranty-upload-error]');
    var text = document.querySelector('[data-carat-warranty-upload-error-text]');
    if (!wrapper || !text) return;
    text.textContent = localeString(messageKey);
    wrapper.hidden = false;
  }

  function clearUploadError() {
    var wrapper = document.querySelector('[data-carat-warranty-upload-error]');
    if (wrapper) wrapper.hidden = true;
  }

  /**
   * Storage is unavailable. Replace the control with the plain note rather
   * than leaving a file input that cannot work -- the original reason this
   * form shipped without uploads at all, kept as the failure path.
   */
  function disableUploads() {
    uploadsDisabled = true;
    var fieldset = document.querySelector('[data-carat-warranty-uploads]');
    var note = document.querySelector('[data-carat-warranty-uploads-unavailable]');
    if (fieldset) fieldset.hidden = true;
    if (note) note.hidden = false;
  }

  function renderUploadList() {
    var list = document.querySelector('[data-carat-warranty-upload-list]');
    if (!list) return;
    list.textContent = '';
    for (var i = 0; i < uploadedFiles.length; i++) {
      var entry = uploadedFiles[i];
      var item = document.createElement('li');
      item.className = 'carat-warranty-claim__upload-item';
      var name = document.createElement('span');
      // textContent, never innerHTML: the file name comes from the customer's
      // own device and is untrusted input like any other.
      name.textContent = entry.fileName;
      var status = document.createElement('span');
      status.className = 'carat-warranty-claim__upload-status';
      status.textContent = localeString(entry.storageKey ? 'uploads_done' : 'uploads_pending');
      item.appendChild(name);
      item.appendChild(status);
      list.appendChild(item);
    }
  }

  /** One file, end to end. Resolves to the descriptor, or null if it did not make it. */
  function uploadOne(file) {
    var claimId = claimIdForUploads();
    var entry = { fileName: file.name, storageKey: null };
    uploadedFiles.push(entry);
    renderUploadList();

    return fetch(UPLOAD_DESTINATION_PROXY_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        claimId: claimId,
        kind: 'photo',
        contentType: file.type,
        sizeBytes: file.size,
      }),
    })
      .then(function (response) {
        if (response.status === 503) {
          // Storage genuinely unavailable — not this file's fault.
          disableUploads();
          return null;
        }
        if (!response.ok) return null;
        return response.json();
      })
      .then(function (destination) {
        if (!destination || !destination.uploadUrl || !destination.storageKey) return null;
        return fetch(destination.uploadUrl, {
          method: 'PUT',
          headers: { 'Content-Type': file.type },
          body: file,
        }).then(function (putResponse) {
          if (!putResponse.ok) return null;
          return checksumFor(file).then(function (checksum) {
            entry.storageKey = destination.storageKey;
            entry.contentType = file.type;
            entry.sizeBytes = file.size;
            entry.checksum = checksum;
            renderUploadList();
            return entry;
          });
        });
      })
      .catch(function () {
        // Network/crypto failure. Swallowed on purpose: the claim must remain
        // submittable, and the customer is told below.
        return null;
      })
      .then(function (result) {
        if (!result) {
          // Drop the placeholder so a failed file is not shown as attached.
          var index = uploadedFiles.indexOf(entry);
          if (index >= 0) uploadedFiles.splice(index, 1);
          renderUploadList();
          if (!uploadsDisabled) showUploadError('error_upload_failed');
        }
        return result;
      });
  }

  function handleUploadSelection(event) {
    var input = event.target;
    if (!input || !input.files || input.files.length === 0) return;
    clearUploadError();

    var files = [];
    for (var i = 0; i < input.files.length; i++) files.push(input.files[i]);

    // Courtesy validation, in the order a customer would care about.
    if (uploadedFiles.length + files.length > UPLOAD_MAX_PHOTOS) {
      showUploadError('error_upload_too_many');
      input.value = '';
      return;
    }
    for (var j = 0; j < files.length; j++) {
      if (UPLOAD_ALLOWED_TYPES.indexOf(files[j].type) === -1) {
        showUploadError('error_upload_type');
        input.value = '';
        return;
      }
      if (files[j].size > UPLOAD_MAX_BYTES) {
        showUploadError('error_upload_too_large');
        input.value = '';
        return;
      }
    }

    // Sequential, not parallel: several 20 MB PUTs at once on a phone
    // connection is how an upload appears to hang.
    var chain = Promise.resolve();
    for (var k = 0; k < files.length; k++) {
      chain = chain.then(
        (function (file) {
          return function () {
            return uploadOne(file);
          };
        })(files[k])
      );
    }
    chain.then(function () {
      input.value = '';
    });
  }

  /** The descriptors for `uploads`, and nothing that failed. */
  function collectUploads() {
    var ready = [];
    for (var i = 0; i < uploadedFiles.length; i++) {
      var entry = uploadedFiles[i];
      if (!entry.storageKey) continue;
      ready.push({
        kind: 'photo',
        storageKey: entry.storageKey,
        contentType: entry.contentType,
        sizeBytes: entry.sizeBytes,
        checksum: entry.checksum,
      });
    }
    return ready;
  }

  function wireUploads() {
    var fieldset = document.querySelector('[data-carat-warranty-uploads]');
    var input = document.querySelector('[data-carat-warranty-upload-input]');
    if (!fieldset || !input) return;
    // `crypto.subtle` is unavailable on insecure origins, and without it the
    // checksum the server requires cannot be produced. Offering the control
    // anyway would fail at the last step, after the customer had waited for
    // an upload — so it is not offered.
    if (!window.crypto || !window.crypto.subtle || typeof window.crypto.subtle.digest !== 'function') {
      disableUploads();
      return;
    }
    fieldset.hidden = false;
    input.addEventListener('change', handleUploadSelection);
  }

  function init() {
    var form = document.querySelector(FORM_SELECTOR);
    if (!form) return;

    prefillFromQueryString(form);
    wireOrderLookup(form);
    wireUploads();
    wireConditionalDetails(
      '[data-carat-warranty-impact-radio]',
      '[data-carat-warranty-impact-details-wrapper]',
      'impact_or_damage_details'
    );
    wireConditionalDetails(
      '[data-carat-warranty-altered-radio]',
      '[data-carat-warranty-alteration-details-wrapper]',
      'alteration_details'
    );

    document.addEventListener('submit', handleSubmit);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }

  // Exposed for `app/app/theme/warrantyClaimFormSandbox.ts` /
  // `warrantyClaimForm.test.ts` ONLY. Assigned here -- inside the
  // double-load guard at the top of this file, after a genuine first
  // load -- rather than by returning a value from the IIFE the way
  // `bank-payment-checkout.js` does: that file has no double-load guard,
  // but this one does (the theme editor allows this section to appear
  // twice on one page), and a second, guarded load must never overwrite an
  // already-set `window.CaratWarrantyClaimForm` with `undefined`.
  window.CaratWarrantyClaimForm = {
    _internal: {
      orderLookupMessageKeyForFailure: orderLookupMessageKeyForFailure,
      normalizeOrderLookupResult: normalizeOrderLookupResult,
      buildLineItemOptionLabel: buildLineItemOptionLabel,
      collectUploads: collectUploads,
      claimIdForUploads: claimIdForUploads,
    },
  };
})();
