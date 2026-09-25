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
  var FORM_SELECTOR = '[data-carat-warranty-form]';
  var ERROR_SUMMARY_SELECTOR = '[data-carat-warranty-error-summary]';
  var CONFIRMATION_SELECTOR = '[data-carat-warranty-confirmation]';
  var STATUS_SELECTOR = '[data-carat-warranty-status]';
  var SUBMIT_SELECTOR = '[data-carat-warranty-submit]';
  var FIELD_ERROR_TEXT_SELECTOR = '[data-carat-warranty-field-error-text]';

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
  // Deep-link pre-fill -- see this file's header comment on why these are
  // read from the URL rather than asked of the customer as the only path.
  // Visible fields (order/line) are pre-filled but remain editable, so a
  // customer who followed a stale or wrong link can correct it before
  // submitting rather than silently submitting the wrong claim.
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
    order_id: 'WarrantyClaimOrderId-error',
    line_item_id: 'WarrantyClaimLineItemId-error',
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

  function init() {
    var form = document.querySelector(FORM_SELECTOR);
    if (!form) return;

    prefillFromQueryString(form);
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
})();
