/*
 * Let Us Beat Your Quote — storefront intake.
 *
 * ===========================================================================
 * TWO THINGS HERE ARE NOT COSMETIC
 * ===========================================================================
 *
 * 1. WHICH ACKNOWLEDGMENT THE CUSTOMER SEES.
 *    Four path acknowledgments exist and the applicable one depends on the
 *    quote's DATE, not just its kind. A custom quote inside the 7-day window
 *    takes the guarantee wording; one day older takes wording that withdraws
 *    the guarantee and the fallback outright. This mirrors the server's rule
 *    so the customer reads the term that will actually be recorded against
 *    them. The server derives treatment independently and remains the only
 *    authority — this is display, not decision.
 *
 * 2. MONEY IS NEVER PARSED AS A FLOAT.
 *    CLAUDE.md rule 6. `parseFloat("1234.56") * 100` is 123455.99999999999 in
 *    IEEE-754, and the route wants an integer string of minor units. The
 *    conversion below is pure string manipulation, so "1234.56" becomes
 *    "123456" exactly, and a value that cannot be represented exactly is
 *    rejected rather than rounded behind the customer's back.
 */
(function () {
  'use strict';

  var PROXY_PATH = '/apps/carat/beat-quote-submission';

  /** Mirrors BEAT_QUOTE_GUARANTEE_WINDOW_CALENDAR_DAYS on the server. */
  var GUARANTEE_WINDOW_DAYS = 7;

  var form = document.querySelector('[data-carat-bq-form]');
  if (!form) return;

  var statusEl = document.querySelector('[data-carat-bq-status]');
  var successEl = document.querySelector('[data-carat-bq-success]');
  var referenceEl = document.querySelector('[data-carat-bq-reference]');
  var pathWrap = document.querySelector('[data-carat-bq-ack-path-wrap]');
  var pathText = document.querySelector('[data-carat-bq-ack-path]');
  var ackPrompt = document.querySelector('[data-carat-bq-ack-prompt]');
  var submitBtn = document.querySelector('[data-carat-bq-submit]');

  /**
   * The four path acknowledgments, verbatim from
   * app/domain/beatyourquote/acknowledgmentText.ts.
   *
   * Duplicated here because the theme cannot import from the app, and pinned
   * character-for-character by beatQuoteAcknowledgmentParity.test.ts. If the
   * approved wording ever changes, that test fails until BOTH sides move —
   * which is the point. Evidence that says something the customer never read
   * is worse than a broken build.
   */
  var PATH_ACK = {
    recent_quote: {
      text:
        'I understand that only verified custom quotes issued within the last 7 calendar days qualify for the ' +
        'guaranteed match-or-beat offer and the 10%-off fallback benefit.',
      action: 'I Understand',
    },
    older_quote: {
      text:
        'This quote is more than 7 days old. CaratForUs will still review it and may offer a competitive price, ' +
        'but there is no guarantee that CaratForUs will match or beat it and the 10%-off fallback does not apply.',
      action: 'Submit for Review Anyway',
    },
    group_buy: {
      text:
        'I understand CaratForUs may review this Group Buy and may choose to match or beat it, but there is no ' +
        'guaranteed match-or-beat outcome and no 10%-off fallback if CaratForUs cannot match or beat the price.',
      action: 'Submit Group Buy for Review',
    },
    online_listing: {
      text:
        'I understand CaratForUs will review this online offer and may choose to match or beat it, but there is ' +
        'no guaranteed match-or-beat outcome and no 10%-off fallback if CaratForUs cannot or chooses not to ' +
        'match or beat the price.',
      action: 'Submit Online Offer for Review',
    },
  };

  /* ------------------------------------------------------------- helpers */

  function el(sel) {
    return form.querySelector(sel);
  }

  function selectedKind() {
    var checked = form.querySelector('[data-carat-bq-kind]:checked');
    return checked ? checked.value : null;
  }

  /** Calendar days between two YYYY-MM-DD strings, UTC, no clock involved. */
  function calendarDaysBetween(fromIso, toIso) {
    var a = Date.parse(fromIso + 'T00:00:00Z');
    var b = Date.parse(toIso + 'T00:00:00Z');
    if (isNaN(a) || isNaN(b)) return null;
    return Math.round((b - a) / 86400000);
  }

  function todayIso() {
    var d = new Date();
    function pad(n) { return n < 10 ? '0' + n : String(n); }
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /**
   * Mirrors deriveIntakeTreatment for DISPLAY. A future-dated quote counts as
   * outside the window exactly as the server treats it — a negative age must
   * not sail through a `<= 7` comparison and hand out the guarantee wording.
   */
  function pathAckIdFor(kind, quoteIssuedOn) {
    if (kind === 'online_listing') return 'online_listing';
    if (kind === 'competing_group_buy') return 'group_buy';
    if (kind !== 'custom_quote') return null;
    if (!quoteIssuedOn) return null;
    var age = calendarDaysBetween(quoteIssuedOn, todayIso());
    if (age === null) return null;
    return age < 0 || age > GUARANTEE_WINDOW_DAYS ? 'older_quote' : 'recent_quote';
  }

  /**
   * Dollars to integer minor units, by string. No floating point.
   * Returns null for anything it cannot represent exactly.
   */
  function toMinorUnits(raw) {
    var s = String(raw == null ? '' : raw).trim().replace(/[$,\s]/g, '');
    if (s === '') return null;
    if (!/^\d+(\.\d{1,2})?$/.test(s)) return null;
    var parts = s.split('.');
    var whole = parts[0];
    var frac = (parts[1] || '').padEnd(2, '0');
    var combined = (whole + frac).replace(/^0+(?=\d)/, '');
    return /^\d{1,15}$/.test(combined) ? combined : null;
  }

  function showError(name, message) {
    var node = form.querySelector('[data-carat-bq-error-for="' + name + '"]');
    if (!node) return;
    node.textContent = message;
    node.hidden = false;
  }

  function clearErrors() {
    form.querySelectorAll('[data-carat-bq-error-for]').forEach(function (n) {
      n.textContent = '';
      n.hidden = true;
    });
    if (statusEl) {
      statusEl.textContent = '';
      statusEl.hidden = true;
    }
  }

  function setStatus(message) {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.hidden = false;
  }

  /* ------------------------------------- conditional fields and the ack */

  function syncConditionals() {
    var kind = selectedKind();

    form.querySelectorAll('[data-carat-bq-when-kind]').forEach(function (node) {
      var kinds = node.getAttribute('data-carat-bq-when-kind').split(/\s+/);
      var show = kind !== null && kinds.indexOf(kind) !== -1;
      node.hidden = !show;
      // A hidden input must not be required, or the browser blocks submit on
      // a field the customer cannot see.
      node.querySelectorAll('input, textarea').forEach(function (i) {
        if (i.name === 'quoteIssuedOn') i.required = show;
        if (!show) i.value = '';
      });
    });

    var dateInput = el('#BqQuoteDate');
    var ackId = pathAckIdFor(kind, dateInput ? dateInput.value : null);

    if (ackId && PATH_ACK[ackId]) {
      pathText.textContent = PATH_ACK[ackId].text;
      pathWrap.hidden = false;
      if (ackPrompt) ackPrompt.hidden = true;
      if (submitBtn) submitBtn.textContent = PATH_ACK[ackId].action;
    } else {
      // Unknown path: hide the checkbox AND clear it, so a customer cannot
      // tick the guarantee wording and then change the date underneath it.
      pathWrap.hidden = true;
      pathText.textContent = '';
      var box = pathWrap.querySelector('input');
      if (box) box.checked = false;
      if (ackPrompt) ackPrompt.hidden = false;
      if (submitBtn) submitBtn.textContent = submitBtn.getAttribute('data-default-label') || submitBtn.textContent;
    }
  }

  if (submitBtn) submitBtn.setAttribute('data-default-label', submitBtn.textContent.trim());

  form.addEventListener('change', function (e) {
    if (e.target.matches('[data-carat-bq-kind]') || e.target.id === 'BqQuoteDate') {
      syncConditionals();
    }
  });
  form.addEventListener('input', function (e) {
    if (e.target.id === 'BqQuoteDate') syncConditionals();
  });

  /* -------------------------------------------------------------- submit */

  /**
   * One id per filled-in form, generated once. The route is idempotent on
   * `submissionId`, so a double-click or a retry after a dropped connection
   * resolves to the SAME submission rather than two — and the loser writes
   * no acknowledgments.
   */
  var submissionId = null;
  function ensureSubmissionId() {
    if (!submissionId) {
      submissionId =
        window.crypto && window.crypto.randomUUID
          ? window.crypto.randomUUID()
          : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
              var r = (Math.random() * 16) | 0;
              return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
            });
    }
    return submissionId;
  }

  form.addEventListener('submit', function (event) {
    event.preventDefault();
    clearErrors();

    var kind = selectedKind();
    if (!kind) {
      showError('kind', form.getAttribute('data-msg-kind') || 'Choose what you are sending us.');
      return;
    }

    var payload = {
      submissionId: ensureSubmissionId(),
      firstName: el('#BqFirstName').value.trim(),
      lastName: el('#BqLastName').value.trim(),
      email: el('#BqEmail').value.trim(),
      kind: kind,
      whatWeMatchAccepted: form.querySelector('[name="whatWeMatchAccepted"]').checked,
      authenticityConfirmed: form.querySelector('[name="authenticityConfirmed"]').checked,
      pathAcknowledgmentAccepted: form.querySelector('[name="pathAcknowledgmentAccepted"]').checked,
    };

    // `.strict()` on the route rejects unknown keys, and optional fields must
    // be ABSENT rather than empty strings. Only add what has a value.
    var optional = {
      phone: el('#BqPhone').value.trim(),
      competitorSellerName: el('#BqSeller').value.trim(),
      competitorWebsite: el('#BqWebsite').value.trim(),
      specifications: el('#BqSpecs').value.trim(),
    };
    Object.keys(optional).forEach(function (k) {
      if (optional[k]) payload[k] = optional[k];
    });

    if (kind === 'custom_quote') {
      var d = el('#BqQuoteDate').value;
      if (!d) {
        showError('quoteIssuedOn', 'Tell us the date on the quote.');
        return;
      }
      payload.quoteIssuedOn = d;
    } else {
      var urlInput = el('#BqListingUrl');
      if (urlInput && urlInput.value.trim()) payload.listingUrl = urlInput.value.trim();
    }

    var priceRaw = el('#BqPrice').value.trim();
    if (priceRaw) {
      var minor = toMinorUnits(priceRaw);
      if (minor === null) {
        showError('competitorPrice', 'Enter the price as a number, for example 2450 or 2450.00.');
        return;
      }
      // The route requires amount and currency together or neither.
      payload.competitorPriceMinorUnits = minor;
      payload.competitorPriceCurrency = 'USD';
    }

    if (!payload.whatWeMatchAccepted || !payload.authenticityConfirmed || !payload.pathAcknowledgmentAccepted) {
      showError('acknowledgments', 'Please confirm all three statements before submitting.');
      return;
    }

    submitBtn.disabled = true;
    setStatus('Sending your quote…');

    fetch(PROXY_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(payload),
    })
      .then(function (res) {
        return res.json().then(function (body) {
          return { ok: res.ok, status: res.status, body: body };
        });
      })
      .then(function (r) {
        if (!r.ok) {
          submitBtn.disabled = false;
          setStatus(
            r.status === 401
              ? 'We could not verify this page. Please reload and try again.'
              : 'Something went wrong sending your quote. Please try again, or email orders@caratforus.com.'
          );
          return;
        }
        form.hidden = true;
        if (statusEl) statusEl.hidden = true;
        if (referenceEl && r.body && r.body.submissionReference) {
          referenceEl.textContent = r.body.submissionReference;
        }
        successEl.hidden = false;
        successEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
      })
      .catch(function () {
        submitBtn.disabled = false;
        setStatus('We could not reach us just then. Please try again, or email orders@caratforus.com.');
      });
  });

  syncConditionals();
})();
