/**
 * Set Your Own Stone — storefront controller.
 *
 * Authoritative requirements: docs/SET-YOUR-OWN-STONE.md
 *
 * ---------------------------------------------------------------------------
 * THIS FILE DECIDES NO COMPATIBILITY
 * ---------------------------------------------------------------------------
 * It collects a stone, posts it, and renders whatever verdict the server
 * returns. There is no tolerance here, no nominal size table, no comparison
 * of millimetres — §5 forbids hard-coding a catalogue of mount sizes into
 * storefront JavaScript and §11 forbids a client-only trust boundary. If you
 * find yourself adding arithmetic to this file, it belongs in
 * `app/domain/setyourownstone/matching.ts` where it is unit tested.
 *
 * STATE LIVES ON THE SERVER. The only thing kept in the page is a session
 * REFERENCE — an opaque string. §10 says query parameters and localStorage
 * must not be the source of truth, and a reference is a pointer to the
 * truth rather than a copy of it.
 *
 * textContent THROUGHOUT, never innerHTML. Setting titles and labels cross a
 * network boundary; a product name is the last string that should be able to
 * introduce markup.
 */
(function () {
  'use strict';

  var ROOT = '[data-carat-syos]';
  var SESSION_ENDPOINT = '/apps/carat/stone-session';
  var SELECT_ENDPOINT = '/apps/carat/stone-setting-select';

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  /** Locale strings the section rendered, read back off the DOM so this file
   *  hard-codes no customer-facing copy. */
  function strings() {
    return window.setYourOwnStoneStrings || {};
  }
  function s(key, fallback) {
    var v = strings()[key];
    return typeof v === 'string' && v.length > 0 ? v : fallback;
  }

  function setup(root) {
    var form = root.querySelector('[data-carat-syos-form]');
    if (!form) return;

    var steps = {};
    Array.prototype.forEach.call(root.querySelectorAll('[data-carat-syos-step]'), function (node) {
      steps[node.getAttribute('data-carat-syos-step')] = node;
    });

    var errorBox = root.querySelector('[data-carat-syos-error]');
    var resultsBox = root.querySelector('[data-carat-syos-results]');
    var customLink = root.querySelector('[data-carat-syos-custom-link]');
    var customBlock = root.querySelector('[data-carat-syos-custom]');
    var submit = root.querySelector('[data-carat-syos-submit]');

    /** The one piece of state the page holds: a pointer, not a copy. */
    var sessionReference = null;

    function show(name) {
      Object.keys(steps).forEach(function (key) {
        steps[key].hidden = key !== name;
      });
      // Move focus to the step that just appeared, or a keyboard user is
      // left at the bottom of a panel that is no longer on screen.
      var heading = steps[name] && steps[name].querySelector('h2');
      if (heading) {
        heading.setAttribute('tabindex', '-1');
        heading.focus({ preventScroll: true });
        heading.scrollIntoView({ block: 'start', behavior: 'smooth' });
      }
    }

    function showError(message) {
      if (!errorBox) return;
      errorBox.textContent = message;
      errorBox.hidden = false;
      errorBox.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    function clearError() {
      if (!errorBox) return;
      errorBox.textContent = '';
      errorBox.hidden = true;
    }

    /** Only shape checks, never fit checks: that a value LOOKS like a
     *  measurement, not whether it matches anything. */
    var MM = /^\d{1,2}(\.\d{1,3})?$/;
    var CARAT = /^\d{1,3}(\.\d{1,3})?$/;

    function fieldError(input, message) {
      var holder = input.closest('[class*="carat-syos__field"]');
      var slot = holder && holder.querySelector('[data-carat-syos-field-error]');
      if (!slot) return;
      if (message) {
        slot.textContent = message;
        slot.hidden = false;
        input.setAttribute('aria-invalid', 'true');
      } else {
        slot.textContent = '';
        slot.hidden = true;
        input.removeAttribute('aria-invalid');
      }
    }

    function readForm() {
      var data = new FormData(form);
      var get = function (k) {
        var v = data.get(k);
        return typeof v === 'string' ? v.trim() : '';
      };
      return {
        stoneType: get('stoneType'),
        shape: get('shape'),
        caratWeight: get('caratWeight'),
        lengthMm: get('lengthMm'),
        widthMm: get('widthMm'),
        depthMm: get('depthMm'),
        certLab: get('certLab'),
        certNumber: get('certNumber'),
        isCurrentlyMounted: get('isCurrentlyMounted') === 'true',
        notes: get('notes'),
      };
    }

    function validate(body) {
      var ok = true;
      var check = function (name, value, pattern, required) {
        var input = form.querySelector('[name="' + name + '"]');
        if (!input) return;
        if (!value) {
          if (required) {
            fieldError(input, s('required', 'This is required.'));
            ok = false;
          } else {
            fieldError(input, null);
          }
          return;
        }
        if (!pattern.test(value)) {
          fieldError(input, s('badNumber', 'Enter a number with up to 3 decimal places.'));
          ok = false;
          return;
        }
        fieldError(input, null);
      };

      check('caratWeight', body.caratWeight, CARAT, true);
      check('lengthMm', body.lengthMm, MM, true);
      check('widthMm', body.widthMm, MM, true);
      check('depthMm', body.depthMm, MM, false);

      // Caught here as well as on the server so the customer is told
      // immediately rather than after a round trip. The server still
      // refuses it — this is a courtesy, not the check.
      if (ok && body.lengthMm && body.widthMm) {
        if (parseFloat(body.widthMm) > parseFloat(body.lengthMm)) {
          fieldError(
            form.querySelector('[name="widthMm"]'),
            s('widthOverLength', 'Length should be the longer measurement — are these swapped?')
          );
          ok = false;
        }
      }
      return ok;
    }

    function renderSummary(payload) {
      var headingEl = root.querySelector('[data-carat-syos-summary-heading]');
      var lineEl = root.querySelector('[data-carat-syos-summary-line]');
      var session = payload.session;
      var d = payload.display;

      // "Settings for your oval diamond" (§7). Built from a template string
      // the section supplied, so the wording stays translatable.
      if (headingEl) {
        headingEl.textContent = s('summaryHeading', 'Settings for your stone')
          .replace('[shape]', s('shape_' + session.shape, session.shape))
          .replace('[type]', s('type_' + session.stoneType, ''))
          .replace(/\s+/g, ' ')
          .trim();
      }
      if (lineEl) {
        var parts = [session.caratWeight + ' ct', d.lengthMm + ' × ' + d.widthMm + ' mm'];
        if (d.depthMm) parts.push(d.depthMm + ' mm deep');
        lineEl.textContent = parts.join(' · ');
      }
    }

    function renderCandidate(candidate, qualifier) {
      var card = el('div', 'carat-syos__card');
      card.appendChild(el('p', 'carat-syos__card-size',
        candidate.nominalLengthMm + ' × ' + candidate.nominalWidthMm + ' mm'));

      var badge = el('span', 'carat-syos__badge carat-syos__badge--' + candidate.status, candidate.label);
      card.appendChild(badge);

      // §6.3: an automatic match always carries the confirmation line.
      if (candidate.status === 'automatic' && qualifier) {
        card.appendChild(el('p', 'carat-syos__card-qualifier', qualifier));
      }

      var choose = el('button', 'button button--secondary carat-syos__choose',
        s('choose', 'Choose this setting'));
      choose.type = 'button';
      choose.addEventListener('click', function () {
        selectSetting(candidate);
      });
      card.appendChild(choose);
      return card;
    }

    function renderResults(payload) {
      if (!resultsBox) return;
      resultsBox.innerHTML = '';

      var m = payload.matches;
      var any = m.automatic.length + m.reviewRequired.length;

      if (any === 0) {
        // §6.4 — no irrelevant mountings dressed up as compatible. An
        // honest empty state, with the custom path leading. This is also
        // the launch state, since no ready settings exist yet.
        resultsBox.appendChild(
          el('p', 'carat-syos__empty', s('noMatches',
            'No ready settings match this stone right now.'))
        );
        if (customBlock) customBlock.classList.add('carat-syos__custom--lead');
        return;
      }

      if (customBlock) customBlock.classList.remove('carat-syos__custom--lead');

      m.automatic.forEach(function (c) {
        resultsBox.appendChild(renderCandidate(c, payload.qualifier));
      });
      m.reviewRequired.forEach(function (c) {
        resultsBox.appendChild(renderCandidate(c, null));
      });
    }

    function selectSetting(candidate) {
      clearError();
      fetch(SELECT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          sessionReference: sessionReference,
          variantGid: candidate.variantGid,
          productGid: candidate.productGid || candidate.variantGid,
        }),
      })
        .then(function (r) {
          if (!r.ok) throw new Error('select_failed');
          return r.json();
        })
        .then(function (data) {
          var text = root.querySelector('[data-carat-syos-done-text]');
          var ref = root.querySelector('[data-carat-syos-done-reference]');
          if (text) text.textContent = data.nextStep || '';
          if (ref) {
            ref.textContent = s('referenceLabel', 'Your reference') + ': ' + data.sessionReference;
          }
          show('done');
        })
        .catch(function () {
          showError(s('selectError', 'We could not record that choice. Please try again.'));
        });
    }

    form.addEventListener('submit', function (event) {
      event.preventDefault();
      clearError();

      var body = readForm();
      if (!validate(body)) return;

      // Optional fields are omitted entirely rather than sent empty: the
      // server schema is `.strict()` and treats absent and blank
      // differently.
      var payload = {
        stoneType: body.stoneType,
        shape: body.shape,
        caratWeight: body.caratWeight,
        lengthMm: body.lengthMm,
        widthMm: body.widthMm,
        isCurrentlyMounted: body.isCurrentlyMounted,
      };
      if (body.depthMm) payload.depthMm = body.depthMm;
      if (body.certLab) payload.certLab = body.certLab;
      if (body.certNumber) payload.certNumber = body.certNumber;
      if (body.notes) payload.notes = body.notes;

      submit.disabled = true;
      fetch(SESSION_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(payload),
      })
        .then(function (r) {
          if (!r.ok) throw new Error('session_failed');
          return r.json();
        })
        .then(function (data) {
          sessionReference = data.session.sessionReference;

          // The custom path carries the session so Custom Jewelry can
          // prefill without the customer retyping anything (§9.2). The
          // reference is a POINTER — the stone itself stays server-side.
          if (customLink) {
            var base = root.getAttribute('data-custom-jewelry-url') || '/pages/custom-jewelry';
            customLink.setAttribute('href', base + '?stone=' + encodeURIComponent(sessionReference));
          }

          renderSummary(data);
          renderResults(data);
          show('results');
        })
        .catch(function () {
          showError(s('sessionError', 'We could not save your stone details. Please try again.'));
        })
        .finally(function () {
          submit.disabled = false;
        });
    });

    var edit = root.querySelector('[data-carat-syos-edit]');
    if (edit) {
      edit.addEventListener('click', function () {
        // Back to the form with every value still in it — the inputs were
        // never cleared, only hidden.
        show('stone');
      });
    }
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll(ROOT), setup);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  document.addEventListener('shopify:section:load', init);
})();
