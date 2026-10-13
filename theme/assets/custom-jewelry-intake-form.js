/**
 * Custom Jewelry enquiry form (Slice 9).
 *
 * Submits to `POST /apps/carat/custom-jewelry-intake` and, for an
 * authenticated customer, drives the issued-destination upload handshake
 * against `POST /apps/carat/custom-jewelry-upload-destination`.
 *
 * ES5-ish on purpose, matching `warranty-claim-form.js` and
 * `bank-payment-checkout.js`: no build step runs over theme assets, so this
 * file ships exactly as written to every browser the store serves.
 *
 * ============================================================================
 * VALIDATION HERE IS COURTESY, NOT ENFORCEMENT
 * ============================================================================
 * The authority is the Zod schema and the 401/422 branches in
 * `apps.carat.custom-jewelry-intake.tsx`. Everything below exists so the
 * customer learns about a problem before a round trip, never so the server can
 * trust the browser.
 *
 * ============================================================================
 * NO FLOATING-POINT ARITHMETIC ON THE BUDGET
 * ============================================================================
 * The customer types dollars; the server requires minor units as a STRING and
 * refuses a JSON number, because a budget is money. `dollarsToMinorUnits`
 * below does the conversion by STRING MANIPULATION — pad or truncate the
 * fractional digits — rather than multiplying by 100, which is exactly the
 * kind of arithmetic that turns 1234.56 into 123455.99999999999. This mirrors
 * the repo-wide rule in CLAUDE.md.
 */
(function () {
  'use strict';

  var INTAKE_PROXY_PATH = '/apps/carat/custom-jewelry-intake';
  var UPLOAD_DESTINATION_PROXY_PATH = '/apps/carat/custom-jewelry-upload-destination';

  /**
   * Mirrors the photo half of the server's own limits. Duplicated
   * deliberately: a courtesy check so the customer learns immediately rather
   * than after an upload round trip. THE SERVER REMAINS THE AUTHORITY and
   * re-checks both — never treat this list as the enforcement point.
   */
  var UPLOAD_MAX_PHOTOS = 10;
  var UPLOAD_MAX_BYTES = 20000000;
  var UPLOAD_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif'];

  /** The only currency MVP1 sells in. Sent explicitly — the route requires both halves of a budget or neither. */
  var BUDGET_CURRENCY = 'USD';

  var form = document.querySelector('[data-carat-cj-form]');
  if (!form) return;

  var uploadedFiles = [];
  var uploadProjectId = null;
  var uploadsDisabled = false;
  var submitting = false;

  // --------------------------------------------------------------------------
  // Copy. Read from the rendered DOM where the string is already on the page,
  // so there is ONE source for owner-approved text rather than a duplicate
  // here that can drift. Fallbacks are deliberately generic and carry no
  // promise — if a locale key is missing, the customer must not be shown an
  // invented sentence about money or timing.
  // --------------------------------------------------------------------------
  var STRINGS = {
    error_required: 'This field is required.',
    error_email: 'Enter a valid email address.',
    error_budget: 'Enter an approximate budget as a number, for example 3500.',
    error_submit_failed: 'We could not submit your request. Please try again.',
    error_upload_failed: 'That file could not be uploaded. You can try again, or submit without it.',
    error_upload_too_many: 'You can attach up to 10 photos.',
    error_upload_too_large: 'Each photo must be 20 MB or smaller.',
    error_upload_wrong_type: 'Attach photos only (JPEG, PNG, WebP or HEIC).',
    error_summary_heading: 'Please check the following:',
    status_submitting: 'Submitting your request…',
    uploads_pending: 'Uploading…',
    uploads_done: 'Attached',
  };

  function localeString(key) {
    return STRINGS[key] || '';
  }

  // --------------------------------------------------------------------------
  // Field errors
  // --------------------------------------------------------------------------
  function errorSlotFor(element) {
    var container = element.closest('.field') || element.closest('fieldset');
    if (!container) return null;
    return container.querySelector('[data-carat-cj-field-error]');
  }

  function showFieldError(element, message) {
    var slot = errorSlotFor(element);
    if (!slot) return;
    var text = slot.querySelector('[data-carat-cj-field-error-text]');
    if (text) text.textContent = message;
    slot.hidden = false;
    element.setAttribute('aria-invalid', 'true');
  }

  function clearFieldErrors() {
    var slots = form.querySelectorAll('[data-carat-cj-field-error]');
    for (var i = 0; i < slots.length; i++) slots[i].hidden = true;
    var invalid = form.querySelectorAll('[aria-invalid="true"]');
    for (var j = 0; j < invalid.length; j++) invalid[j].removeAttribute('aria-invalid');
  }

  function showErrorSummary(messages) {
    var summary = document.querySelector('[data-carat-cj-error-summary]');
    if (!summary) return;
    summary.textContent = '';
    var heading = document.createElement('p');
    heading.textContent = localeString('error_summary_heading');
    summary.appendChild(heading);
    var list = document.createElement('ul');
    for (var i = 0; i < messages.length; i++) {
      var item = document.createElement('li');
      // textContent, never innerHTML — these strings are ours, but the habit
      // is what keeps the one customer-derived string from slipping in later.
      item.textContent = messages[i];
      list.appendChild(item);
    }
    summary.appendChild(list);
    summary.hidden = false;
    summary.focus();
  }

  function hideErrorSummary() {
    var summary = document.querySelector('[data-carat-cj-error-summary]');
    if (summary) summary.hidden = true;
  }

  function setStatus(message) {
    var status = document.querySelector('[data-carat-cj-status]');
    if (!status) return;
    if (!message) {
      status.hidden = true;
      status.textContent = '';
      return;
    }
    status.textContent = message;
    status.hidden = false;
  }

  // --------------------------------------------------------------------------
  // Money, by string manipulation — see the file header.
  // --------------------------------------------------------------------------
  /**
   * "3500" / "3500.5" / "$3,500.50" -> "350000" / "350050" / "350050".
   * Returns null if the input is not a plain amount.
   */
  function dollarsToMinorUnits(raw) {
    var cleaned = String(raw).replace(/[$,\s]/g, '');
    if (!/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
    var parts = cleaned.split('.');
    var whole = parts[0];
    var fraction = parts.length > 1 ? parts[1] : '';
    while (fraction.length < 2) fraction += '0';
    // Strip leading zeros so "0050" does not reach a BigInt-parsing server as
    // something it has to interpret; keep one digit so "0" survives.
    var minorUnits = (whole + fraction).replace(/^0+(?=\d)/, '');
    return minorUnits;
  }

  // --------------------------------------------------------------------------
  // Uploads
  // --------------------------------------------------------------------------
  function newProjectId() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') {
      return window.crypto.randomUUID();
    }
    // Fallback for browsers without randomUUID. getRandomValues, NOT
    // Math.random: a guessable project id would not grant access to anything,
    // but there is no reason to weaken it.
    var bytes = new Uint8Array(16);
    window.crypto.getRandomValues(bytes);
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    var hex = [];
    for (var i = 0; i < bytes.length; i++) hex.push((bytes[i] + 0x100).toString(16).slice(1));
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

  /**
   * The project's id is minted HERE, before the project exists, because files
   * are uploaded while the form is still being filled in and the server needs
   * something to bind each destination to. Safe because a caller-supplied id
   * can only ever create a BRAND NEW project — the primary key refuses reuse —
   * and the persisted destination's own `customerRef` still gates consumption
   * to the identity that requested it. See the upload-destination route's
   * module comment for the full argument.
   */
  function projectIdForUploads() {
    if (!uploadProjectId) uploadProjectId = newProjectId();
    return uploadProjectId;
  }

  /** SHA-256 of the file bytes, hex, prefixed to name the algorithm. */
  function checksumFor(file) {
    return file.arrayBuffer().then(function (buffer) {
      return window.crypto.subtle.digest('SHA-256', buffer).then(function (digest) {
        var view = new Uint8Array(digest);
        var hex = '';
        for (var i = 0; i < view.length; i++) hex += (view[i] + 0x100).toString(16).slice(1);
        return 'sha256:' + hex;
      });
    });
  }

  function showUploadError(key) {
    var wrapper = document.querySelector('[data-carat-cj-upload-error]');
    var text = document.querySelector('[data-carat-cj-upload-error-text]');
    if (!wrapper || !text) return;
    text.textContent = localeString(key);
    wrapper.hidden = false;
  }

  function clearUploadError() {
    var wrapper = document.querySelector('[data-carat-cj-upload-error]');
    if (wrapper) wrapper.hidden = true;
  }

  /**
   * Storage genuinely unavailable. Hide the control and show the plain note
   * instead — never leave a file input that cannot work. The note names no
   * internal cause; "our bucket isn't provisioned" is not the customer's
   * problem to read about.
   */
  function disableUploads() {
    uploadsDisabled = true;
    var block = document.querySelector('[data-carat-cj-uploads]');
    var note = document.querySelector('[data-carat-cj-uploads-unavailable]');
    if (block) block.hidden = true;
    if (note) note.hidden = false;
  }

  function renderUploadList() {
    var list = document.querySelector('[data-carat-cj-upload-list]');
    if (!list) return;
    list.textContent = '';
    for (var i = 0; i < uploadedFiles.length; i++) {
      var entry = uploadedFiles[i];
      var item = document.createElement('li');
      item.className = 'carat-custom-jewelry__upload-item';
      var name = document.createElement('span');
      // textContent, never innerHTML: the file name comes from the customer's
      // own device and is untrusted input like any other.
      name.textContent = entry.fileName;
      var status = document.createElement('span');
      status.className = 'carat-custom-jewelry__upload-status';
      status.textContent = localeString(entry.storageKey ? 'uploads_done' : 'uploads_pending');
      item.appendChild(name);
      item.appendChild(status);
      list.appendChild(item);
    }
  }

  /** One file, end to end. Resolves to the descriptor, or null if it did not make it. */
  function uploadOne(file) {
    var entry = { fileName: file.name, storageKey: null };
    uploadedFiles.push(entry);
    renderUploadList();

    return fetch(UPLOAD_DESTINATION_PROXY_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectId: projectIdForUploads(),
        kind: 'photo',
        contentType: file.type,
        sizeBytes: file.size,
      }),
    })
      .then(function (response) {
        if (response.status === 503) {
          // Storage unavailable — not this file's fault, and not a thing
          // retrying will fix.
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
        // Network/crypto failure. Swallowed on purpose: the ENQUIRY must stay
        // submittable — inspiration files are optional in a load-bearing way,
        // and the customer is told below.
        return null;
      })
      .then(function (result) {
        if (!result) {
          // Drop the placeholder so a failed file is never shown as attached.
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
    // Clear the control immediately so the same file can be re-picked after a
    // failure, and so the list below is the single record of what is attached.
    input.value = '';

    if (uploadedFiles.length + files.length > UPLOAD_MAX_PHOTOS) {
      showUploadError('error_upload_too_many');
      return;
    }
    for (var j = 0; j < files.length; j++) {
      if (files[j].size > UPLOAD_MAX_BYTES) {
        showUploadError('error_upload_too_large');
        return;
      }
      if (UPLOAD_ALLOWED_TYPES.indexOf(files[j].type) === -1) {
        showUploadError('error_upload_wrong_type');
        return;
      }
    }

    for (var k = 0; k < files.length; k++) uploadOne(files[k]);
  }

  /**
   * Reveal the control only once we know uploads can actually work.
   *
   * `crypto.subtle` is unavailable on insecure origins, and without it there
   * is no checksum, so the server would refuse every file. Showing the input
   * in that case would be offering something that cannot succeed.
   */
  function initUploads() {
    var block = document.querySelector('[data-carat-cj-uploads]');
    if (!block) return; // signed out — the sign-in invitation is rendered instead
    if (!window.crypto || !window.crypto.subtle || typeof window.crypto.subtle.digest !== 'function') {
      disableUploads();
      return;
    }
    block.hidden = false;
    var input = block.querySelector('[data-carat-cj-upload-input]');
    if (input) input.addEventListener('change', handleUploadSelection);
  }

  // --------------------------------------------------------------------------
  // Timing — "no deadline" and a date are two answers to one question, and the
  // route refuses both together. Enforce the exclusion in the UI rather than
  // letting the customer assemble a request that will be rejected.
  // --------------------------------------------------------------------------
  function initTiming() {
    var checkbox = document.querySelector('[data-carat-cj-no-deadline]');
    var date = document.querySelector('[data-carat-cj-desired-date]');
    if (!checkbox || !date) return;
    checkbox.addEventListener('change', function () {
      date.disabled = checkbox.checked;
      if (checkbox.checked) date.value = '';
    });
  }

  // --------------------------------------------------------------------------
  // Validation and submission
  // --------------------------------------------------------------------------
  function valueOf(name) {
    var field = form.elements[name];
    return field && typeof field.value === 'string' ? field.value.trim() : '';
  }

  function checkedValueOf(name) {
    var checked = form.querySelector('input[name="' + name + '"]:checked');
    return checked ? checked.value : '';
  }

  function validate() {
    clearFieldErrors();
    var messages = [];

    var required = ['first_name', 'last_name', 'email', 'phone', 'prompt_text'];
    for (var i = 0; i < required.length; i++) {
      var field = form.elements[required[i]];
      if (field && !field.value.trim()) {
        showFieldError(field, localeString('error_required'));
        messages.push(labelFor(field) + ': ' + localeString('error_required'));
      }
    }

    var email = form.elements['email'];
    // A deliberately loose shape check. The server's validator is the
    // authority; this only catches the obvious typo before a round trip.
    if (email && email.value.trim() && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email.value.trim())) {
      showFieldError(email, localeString('error_email'));
      messages.push(labelFor(email) + ': ' + localeString('error_email'));
    }

    var radios = [
      { name: 'starting_point', node: document.querySelector('[data-carat-cj-starting-point]') },
      { name: 'follow_up_preference', node: document.querySelector('[data-carat-cj-follow-up]') },
    ];
    for (var j = 0; j < radios.length; j++) {
      if (!checkedValueOf(radios[j].name) && radios[j].node) {
        showFieldError(radios[j].node, localeString('error_required'));
        messages.push(legendFor(radios[j].node) + ': ' + localeString('error_required'));
      }
    }

    var budget = form.elements['approximate_budget'];
    if (budget && budget.value.trim() && dollarsToMinorUnits(budget.value) === null) {
      showFieldError(budget, localeString('error_budget'));
      messages.push(labelFor(budget) + ': ' + localeString('error_budget'));
    }

    return messages;
  }

  function labelFor(field) {
    var container = field.closest('.field');
    var label = container ? container.querySelector('.field__label') : null;
    return label ? label.textContent.replace('*', '').trim() : field.name;
  }

  function legendFor(node) {
    var fieldset = node.closest('fieldset');
    var legend = fieldset ? fieldset.querySelector('legend') : null;
    return legend ? legend.textContent.replace('*', '').trim() : '';
  }

  function buildPayload() {
    var payload = {
      firstName: valueOf('first_name'),
      lastName: valueOf('last_name'),
      email: valueOf('email'),
      phone: valueOf('phone'),
      startingPoint: checkedValueOf('starting_point'),
      promptText: valueOf('prompt_text'),
      followUpPreference: checkedValueOf('follow_up_preference'),
    };

    var jewelryType = valueOf('jewelry_type');
    if (jewelryType) payload.jewelryType = jewelryType;

    var inspirationLinks = valueOf('inspiration_links');
    if (inspirationLinks) payload.inspirationLinks = inspirationLinks;

    var budget = valueOf('approximate_budget');
    if (budget) {
      var minorUnits = dollarsToMinorUnits(budget);
      if (minorUnits !== null) {
        // BOTH halves or neither — the route refuses a half-specified budget.
        payload.approximateBudgetMinorUnits = minorUnits;
        payload.approximateBudgetCurrency = BUDGET_CURRENCY;
      }
    }

    var noDeadline = form.elements['has_no_deadline'];
    var desiredDate = valueOf('desired_completion_date');
    if (noDeadline && noDeadline.checked) {
      payload.hasNoDeadline = true;
    } else if (desiredDate) {
      payload.desiredCompletionDate = desiredDate;
    }

    // ONLY files that genuinely completed. A placeholder for a failed upload
    // was already removed from `uploadedFiles`, so there is nothing to filter
    // for here beyond the belt-and-braces check.
    var completed = [];
    for (var i = 0; i < uploadedFiles.length; i++) {
      var entry = uploadedFiles[i];
      if (!entry.storageKey) continue;
      completed.push({
        kind: 'photo',
        storageKey: entry.storageKey,
        contentType: entry.contentType,
        sizeBytes: entry.sizeBytes,
        checksum: entry.checksum,
      });
    }
    if (completed.length > 0) {
      payload.uploads = completed;
      // Sent ONLY alongside uploads. The route honours a client-minted id for
      // exactly one reason — binding files uploaded before the project
      // existed — and ignores it otherwise.
      payload.projectId = projectIdForUploads();
    }

    return payload;
  }

  function showConfirmation(projectReference) {
    var region = document.querySelector('[data-carat-cj-confirmation]');
    if (!region) return;
    // THE OWNER-APPROVED SENTENCE, read from the page where it was rendered
    // from the locale file — one source, not a copy that can drift.
    var template = region.getAttribute('data-confirmation-template') || '';
    region.textContent = template.replace('{projectReference}', projectReference);
    region.hidden = false;
    region.focus();
    form.hidden = true;
  }

  function handleSubmit(event) {
    event.preventDefault();
    if (submitting) return;

    hideErrorSummary();
    var problems = validate();
    if (problems.length > 0) {
      showErrorSummary(problems);
      return;
    }

    submitting = true;
    var button = document.querySelector('[data-carat-cj-submit]');
    if (button) button.disabled = true;
    setStatus(localeString('status_submitting'));

    fetch(INTAKE_PROXY_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildPayload()),
    })
      .then(function (response) {
        return response.json().then(
          function (body) {
            return { status: response.status, body: body };
          },
          function () {
            return { status: response.status, body: {} };
          }
        );
      })
      .then(function (result) {
        if (result.status === 201 && result.body && result.body.projectReference) {
          setStatus('');
          showConfirmation(result.body.projectReference);
          return;
        }
        // DELIBERATELY ONE MESSAGE for every failure. The route's own
        // refusals are generic by design (an upload key issued for someone
        // else is indistinguishable from one that never existed), and
        // relaying a server error code would be noise to a customer and a
        // hint to anyone probing.
        setStatus('');
        showErrorSummary([localeString('error_submit_failed')]);
      })
      .catch(function () {
        setStatus('');
        showErrorSummary([localeString('error_submit_failed')]);
      })
      .then(function () {
        submitting = false;
        if (button) button.disabled = false;
      });
  }

  form.addEventListener('submit', handleSubmit);
  initUploads();
  initTiming();
})();
