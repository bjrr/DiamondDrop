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

    /**
     * One mounting, not one variant.
     *
     * The matcher answers per variant and the pilot's 9 x 7 pear matches
     * fifteen of them -- three metals times five ring sizes, all genuinely
     * compatible. The server groups them; this renders the group.
     *
     * THE CENTRE SIZE IS SHOWN, NOT OFFERED. It was decided by measuring the
     * customer's stone. Handing it back as a dropdown would invite them to
     * pick a head that does not fit the diamond they already own.
     *
     * Metal and ring size resolve to a REAL Shopify variant from the list the
     * server sent. Nothing here invents an identity; the chosen variant gid
     * is one Shopify already issued.
     */
    function renderMounting(card, qualifier) {
      var root = el('div', 'carat-syos__mounting');

      if (card.featuredImageUrl) {
        var img = document.createElement('img');
        img.className = 'carat-syos__mounting-image';
        img.src = card.featuredImageUrl;
        img.alt = card.productTitle;
        img.loading = 'lazy';
        root.appendChild(img);
      }

      var body = el('div', 'carat-syos__mounting-body');
      body.appendChild(el('h3', 'carat-syos__mounting-title', card.productTitle));

      var badge = el('span', 'carat-syos__badge carat-syos__badge--' + card.status, card.label);
      body.appendChild(badge);

      body.appendChild(el('p', 'carat-syos__mounting-matched',
        s('matchedSize', 'Matched for your stone: ') + card.matchedCenterSize));

      if (card.status === 'automatic' && qualifier) {
        body.appendChild(el('p', 'carat-syos__card-qualifier', qualifier));
      }

      var priceEl = el('p', 'carat-syos__mounting-price', '');
      body.appendChild(priceEl);

      // ---- selectors, one per option the customer still chooses
      var chosen = {};
      var selects = [];

      card.options.forEach(function (option) {
        var field = el('div', 'carat-syos__field');
        var id = 'syos-opt-' + card.productGid.replace(/\D/g, '') + '-' +
          option.name.replace(/\W/g, '');

        var label = el('label', 'carat-syos__label', option.name);
        label.setAttribute('for', id);
        field.appendChild(label);

        var select = document.createElement('select');
        select.className = 'carat-syos__input';
        select.id = id;
        option.values.forEach(function (value, i) {
          var opt = document.createElement('option');
          opt.value = value;
          opt.textContent = value;
          if (i === 0) opt.selected = true;
          select.appendChild(opt);
        });
        chosen[option.name] = option.values[0];
        select.addEventListener('change', function () {
          chosen[option.name] = select.value;
          refresh();
        });
        selects.push(select);
        field.appendChild(select);
        root.appendChild(field);
        body.appendChild(field);
      });

      var choose = el('button', 'button carat-syos__choose', s('choose', 'Choose this setting'));
      choose.type = 'button';
      body.appendChild(choose);

      var unavailable = el('p', 'carat-syos__field-error', s('unavailable',
        'That combination is not available. Try another metal or ring size.'));
      unavailable.hidden = true;
      body.appendChild(unavailable);

      /** Which real Shopify variant do the current choices name? */
      function currentVariant() {
        for (var i = 0; i < card.variants.length; i += 1) {
          var v = card.variants[i];
          var ok = true;
          for (var name in chosen) {
            if (Object.prototype.hasOwnProperty.call(chosen, name) &&
                v.selections[name] !== chosen[name]) { ok = false; break; }
          }
          if (ok) return v;
        }
        return null;
      }

      function refresh() {
        var v = currentVariant();
        if (v && v.price) {
          priceEl.textContent = formatMoney(v.price, card.currencyCode);
        } else if (card.priceFrom) {
          priceEl.textContent = s('from', 'From ') + formatMoney(card.priceFrom, card.currencyCode);
        } else {
          priceEl.textContent = '';
        }
        // A real combination that Shopify says is sold out must not look
        // buyable, and a combination that does not exist must not silently
        // submit the wrong variant.
        var usable = !!v && v.availableForSale !== false;
        choose.disabled = !usable;
        unavailable.hidden = usable;
      }

      choose.addEventListener('click', function () {
        var v = currentVariant();
        if (!v) return;
        selectSetting({
          variantGid: v.variantGid,
          productGid: card.productGid,
          selectedOptions: chosen,
        });
      });

      refresh();
      root.appendChild(body);
      return root;
    }

    /** Money as the shop stores it. No rounding, no re-derivation. */
    function formatMoney(amount, currency) {
      if (!amount) return '';
      try {
        return new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency: currency || 'USD',
        }).format(Number(amount));
      } catch (e) {
        return amount;
      }
    }

    function renderResults(payload) {
      if (!resultsBox) return;
      resultsBox.innerHTML = '';

      // One card per mounting, from the server's grouping. The flat
      // `matches` list is still in the payload for diagnostics; rendering it
      // would put fifteen identical cards on screen.
      var cards = payload.mountings || [];
      var any = cards.length;

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

      cards.forEach(function (c) {
        resultsBox.appendChild(
          renderMounting(c, c.status === 'automatic' ? payload.qualifier : null)
        );
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
          selectedOptions: candidate.selectedOptions || undefined,
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
