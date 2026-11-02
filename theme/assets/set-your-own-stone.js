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
    /**
     * The last server response, kept so the fork can be re-shown without a
     * second round trip. NOT a source of truth: every figure in it came from
     * the server moments earlier, and reloading the page rehydrates from the
     * server rather than from this.
     */
    var lastPayload = null;
    /** The approved Review Required explanation, as sent by the server. */
    var reviewExplanation = null;

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
        // LOOSE / MOUNTED_PRONG / MOUNTED_UNSUPPORTED. Empty until the
        // customer answers -- nothing here is defaulted, because this decides
        // whether we may cut metal away from their stone.
        mountedState: get('mountedState'),
        stoneRemovalSelected: get('stoneRemovalSelected') === 'true',
        notes: get('notes'),
      };
    }

    /**
     * Reveal the block that belongs to the chosen answer.
     *
     * Presentation only -- whether the service is actually offered is the
     * server's decision, re-made on every response. If the customer switches
     * away from the prong answer the checkbox is cleared as well as hidden, so
     * a hidden tick can never travel with the request.
     */
    function syncRemovalBlocks() {
      var chosen = form.querySelector('[name="mountedState"]:checked');
      var state = chosen ? chosen.value : '';
      var prong = root.querySelector('[data-carat-syos-removal-prong]');
      var unsupported = root.querySelector('[data-carat-syos-removal-unsupported]');
      var box = form.querySelector('[name="stoneRemovalSelected"]');
      if (prong) prong.hidden = state !== 'MOUNTED_PRONG';
      if (unsupported) unsupported.hidden = state !== 'MOUNTED_UNSUPPORTED';
      if (box && state !== 'MOUNTED_PRONG') box.checked = false;
      if (state) {
        var mountedField = root.querySelector('[data-carat-syos-mounted]');
        if (mountedField) fieldError(mountedField, null);
      }
    }

    Array.prototype.forEach.call(
      form.querySelectorAll('[name="mountedState"]'),
      function (radio) { radio.addEventListener('change', syncRemovalBlocks); }
    );
    syncRemovalBlocks();

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

      // Required, and not pre-filled. A missing answer is a question the
      // customer has not answered, not a loose stone.
      if (!body.mountedState) {
        var mountedField = root.querySelector('[data-carat-syos-mounted]');
        if (mountedField) fieldError(mountedField, s('required', 'This is required.'));
        ok = false;
      }

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

    /**
     * What the customer's order will say about removal.
     *
     * Reads the SERVER's verdict, never the form. Three outcomes, three
     * different things worth saying -- and for a loose stone, nothing at all,
     * because there is no service and no decision.
     */
    function renderRemoval(payload) {
      var removal = payload && payload.removal;
      var nodes = root.querySelectorAll('[data-carat-syos-removal-summary]');
      for (var i = 0; i < nodes.length; i += 1) {
        var node = nodes[i];
        if (!removal || removal.kind === 'not_needed') {
          node.textContent = '';
          node.hidden = true;
          continue;
        }
        if (removal.kind === 'offered') {
          // The named charge, and only when they asked for it. An offer they
          // declined is not a line on their order, so it is not reported as one.
          node.textContent = removal.selected
            ? s('removalOfferLabel', 'Stone Removal — $50')
            : removal.message || '';
        } else {
          node.textContent = removal.message || '';
        }
        node.hidden = !node.textContent;
      }
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
    /**
     * One mounting, jewelry-first (owner section 3, 2026-11-02).
     *
     * The image is the primary element rather than a thumbnail: someone
     * choosing a setting for their own diamond is looking at the ring, not
     * reading a spec list. Image and title are both links into the detail
     * view, as is an explicit View Details action, because people click
     * different things.
     *
     * THE CENTRE SIZE IS SHOWN, NOT OFFERED. It was decided by measuring the
     * customer's stone; handing it back as a dropdown would invite them to
     * pick a head that does not fit the diamond they already own.
     *
     * BOTH PRICES, AND THE SAVING AS AN ABSOLUTE FIGURE. Never a percentage,
     * never "surcharge", "card fee", "cash price" or "cash discount".
     */
    function renderMounting(card, qualifier) {
      var root = el('div', 'carat-syos__mounting');
      var detailHref = detailUrlFor(card, null);

      // ---- media, as a link
      var mediaLink = document.createElement('a');
      mediaLink.className = 'carat-syos__mounting-media';
      mediaLink.setAttribute('href', detailHref);
      if (card.featuredImageUrl) {
        var img = document.createElement('img');
        img.className = 'carat-syos__mounting-image';
        img.src = card.featuredImageUrl;
        img.alt = card.productTitle;
        img.loading = 'lazy';
        mediaLink.appendChild(img);
      } else {
        mediaLink.appendChild(el('span', 'carat-syos__mounting-image carat-syos__mounting-image--empty', ''));
      }
      root.appendChild(mediaLink);

      var body = el('div', 'carat-syos__mounting-body');

      var badge = el('span', 'carat-syos__badge carat-syos__badge--' + card.status, card.label);
      body.appendChild(badge);

      var titleLink = document.createElement('a');
      titleLink.className = 'carat-syos__mounting-title-link';
      titleLink.setAttribute('href', detailHref);
      titleLink.appendChild(el('h3', 'carat-syos__mounting-title', card.productTitle));
      body.appendChild(titleLink);

      body.appendChild(el('p', 'carat-syos__mounting-matched',
        s('matchedSize', 'Matched for your stone: ') + card.matchedCenterSize));

      if (card.status === 'automatic' && qualifier) {
        body.appendChild(el('p', 'carat-syos__card-qualifier', qualifier));
      }

      // The approved Review Required explanation, from the server. It says a
      // jeweler reviews AFTER the order and may need extra time -- true, and
      // purchasable. It never guarantees fit, never says the mounting will or
      // will not work, and never mentions the thresholds behind the verdict.
      if (card.status === 'review_required' && reviewExplanation) {
        body.appendChild(el('p', 'carat-syos__review-note', reviewExplanation));
      }

      // ---- prices: Regular, Bank Payment, and the exact saving
      var priceBox = el('div', 'carat-syos__prices');
      var regularEl = el('p', 'carat-syos__price-regular', '');
      var bankEl = el('p', 'carat-syos__price-bank', '');
      var saveEl = el('p', 'carat-syos__price-save', '');
      priceBox.appendChild(regularEl);
      priceBox.appendChild(bankEl);
      priceBox.appendChild(saveEl);
      body.appendChild(priceBox);

      // ---- selectors, one per option the customer still chooses
      var chosen = {};
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
        field.appendChild(select);
        body.appendChild(field);
      });

      var actions = el('div', 'carat-syos__mounting-actions');
      var choose = el('button', 'button carat-syos__choose', s('addToCart', 'Add to Cart'));
      choose.type = 'button';
      actions.appendChild(choose);

      var details = document.createElement('a');
      details.className = 'carat-syos__details-link';
      details.setAttribute('href', detailHref);
      details.textContent = s('viewDetails', 'View details');
      actions.appendChild(details);

      // "Customize this setting for my stone" — for the customer who likes
      // this mounting but wants it changed. Carries the mounting into Custom
      // Jewelry as inspiration, with the stone still attached by reference.
      var customiseThis = document.createElement('a');
      customiseThis.className = 'carat-syos__customise-link';
      customiseThis.setAttribute('href', customUrl({ card: card, variant: null }));
      customiseThis.textContent = s('customizeThis', 'Customize this setting for my stone');
      actions.appendChild(customiseThis);

      body.appendChild(actions);

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
        var p = (v && v.prices) || card.pricesFrom || null;

        if (p) {
          regularEl.textContent = s('regularPrice', 'Regular price ') +
            formatMinor(p.regularCardPriceMinorUnits, p.currency);
          bankEl.textContent = s('bankPrice', 'Bank Payment Price: ') +
            formatMinor(p.bankPaymentPriceMinorUnits, p.currency);
          // An absolute figure, never a percentage (policy section 6).
          saveEl.textContent = s('bankSavePrefix', 'Save ') +
            formatMinor(p.bankPaymentSavingsMinorUnits, p.currency) +
            s('bankSaveSuffix', ' with Bank Payment');
          saveEl.hidden = p.bankPaymentSavingsMinorUnits === '0';
        } else if (v && v.price) {
          // No computed pair: show Shopify's own price rather than nothing.
          regularEl.textContent = formatMoney(v.price, card.currencyCode);
          bankEl.textContent = '';
          saveEl.textContent = '';
        } else {
          regularEl.textContent = '';
          bankEl.textContent = '';
          saveEl.textContent = '';
        }

        // A real combination Shopify says is sold out must not look buyable,
        // and a combination that does not exist must not silently submit the
        // wrong variant.
        var usable = !!v && v.availableForSale !== false;
        choose.disabled = !usable;
        unavailable.hidden = usable;
        details.setAttribute('href', detailUrlFor(card, v));
        // The inspiration line follows the customer's current choices.
        customiseThis.setAttribute('href', customUrl({ card: card, variant: v }));
      }

      choose.addEventListener('click', function () {
        var v = currentVariant();
        if (!v) return;
        choose.disabled = true;

        /**
         * RECORD FIRST, THEN BUY.
         *
         * The selection is recorded server-side before anything reaches the
         * cart, because that record -- with the compatibility verdict
         * RECOMPUTED on the server, never taken from this page -- is the
         * evidence staff act on. If the cart add then failed, we would still
         * know what the customer chose and why it was offered; the reverse
         * order could put a Review Required mounting in a cart with no record
         * that a jeweler needs to look at it.
         */
        selectSetting({
          variantGid: v.variantGid,
          productGid: card.productGid,
          selectedOptions: chosen,
        }, function (recorded) {
          addToCart(card, v, recorded, function (ok) {
            choose.disabled = false;
            if (ok) window.location.href = '/cart';
          });
        });
      });

      refresh();
      root.appendChild(body);
      return root;
    }

    /**
     * Add the chosen variant to the normal Shopify cart.
     *
     * The REAL variant, the normal cart, the normal checkout. Review Required
     * does not get a pseudo-product or a parallel purchase path.
     *
     * Line item properties carry what operations needs. Each key is prefixed
     * with an underscore, which is Shopify's own convention for a property
     * that stays off the cart and checkout display while still arriving on
     * the order -- so staff can see it and the customer is not shown internal
     * compatibility metadata.
     *
     * DELIBERATELY MINIMAL. The session reference plus the verdict is enough
     * for staff to find the full record; the matched size is already shown to
     * the customer on the card, so it is not a secret. Profile ids, tolerance
     * figures and anything else internal stay server-side where the
     * StoneSession already holds them.
     */
    function addToCart(card, variant, recorded, done) {
      var id = String(variant.variantGid).split('/').pop();
      var status = (recorded && recorded.compatibility && recorded.compatibility.status) ||
        card.status;
      var body = {
        id: id,
        quantity: 1,
        properties: {
          _syos_session: sessionReference || '',
          // AUTOMATIC / REVIEW_REQUIRED, upper-cased for operations.
          _syos_compatibility: String(status).toUpperCase(),
          _syos_matched_size: card.matchedCenterSize || '',
        },
      };

      var items = [body];

      /**
       * The $50 Stone Removal service, as its own cart line.
       *
       * A SEPARATE LINE ON PURPOSE. §17.5 forbids itemising the mounting's
       * pricing components to the customer and names this service as the one
       * approved exception, so it has to be visible on its own rather than
       * folded into the ring's price. A real Shopify product also means the
       * $50 comes from Shopify's price field — this page never sends an
       * amount, so there is no amount here to tamper with.
       *
       * THE SERVER DECIDES WHETHER IT APPLIES. `removal.kind === 'offered'`
       * and `removal.selected` both come from the last server response, which
       * re-derives them from the stored mounted state. The page does not get
       * a vote on whether a prong-only service applies.
       */
      var removal = lastPayload && lastPayload.removal;
      var service = window.setYourOwnStoneRemoval;
      if (removal && removal.kind === 'offered' && removal.selected &&
          service && service.variantId) {
        items.push({
          id: String(service.variantId),
          // One centre stone, one removal. Never scaled by prongs or carats.
          quantity: 1,
          properties: {
            _syos_session: sessionReference || '',
            _syos_service: 'STONE_REMOVAL',
            // Why we are allowed to do this job at all, recorded for the
            // bench alongside the charge.
            _syos_mounted_state: removal.mountedState || '',
          },
        });
      }

      fetch('/cart/add.js', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ items: items }),
      })
        .then(function (r) {
          if (!r.ok) throw new Error('cart_add_failed');
          return r.json();
        })
        .then(function () { if (done) done(true); })
        .catch(function () {
          showError(s('cartError', 'We could not add that setting to your cart. Please try again.'));
          if (done) done(false);
        });
    }

    /**
     * Where View Details goes.
     *
     * The product handle plus the EXACT matched variant, so the detail page
     * opens on the locked centre size rather than whichever variant Shopify
     * considers first. `?stone=<reference>` carries the session so the page
     * can offer a way back and so returning rehydrates from the server -- the
     * reference is a pointer, never a copy of the stone.
     */
    /**
     * Into Custom Jewelry, carrying the stone and optionally a mounting.
     *
     * The stone travels as a REFERENCE — the server looks it up and links it,
     * which is why the customer never re-enters anything and why this page
     * never becomes a second source of truth for stone data.
     *
     * A mounting, when the customer is customising one they just looked at,
     * travels as a human-readable inspiration line. That is what the existing
     * `inspirationLinks` field is for, so no new workflow and no new column
     * are needed. The values come from the server payload this page was given;
     * the page is relaying them, not inventing them.
     */
    function customUrl(options) {
      var base = root.getAttribute('data-custom-jewelry-url') || '/pages/custom-jewelry';
      var params = [];
      if (sessionReference) params.push('stone=' + encodeURIComponent(sessionReference));

      if (options && options.card) {
        var card = options.card;
        var bits = [card.productTitle];
        var v = options.variant;
        if (v && v.selections) {
          var names = Object.keys(v.selections);
          for (var i = 0; i < names.length; i += 1) {
            // The centre size is matcher-controlled, not a customer choice,
            // so it is not offered back as something they picked.
            if (names[i].toLowerCase().replace(/[^a-z]/g, '') === 'centerstonesize') continue;
            bits.push(names[i] + ': ' + v.selections[names[i]]);
          }
        }
        if (card.matchedCenterSize) bits.push('matched ' + card.matchedCenterSize);
        bits.push(window.location.origin + '/products/' + card.productHandle);
        params.push('mounting=' + encodeURIComponent(bits.join(' — ')));
      }
      return params.length ? base + '?' + params.join('&') : base;
    }

    function detailUrlFor(card, variant) {
      var href = '/products/' + encodeURIComponent(card.productHandle);
      var params = [];
      var v = variant || card.variants[0];
      if (v && v.variantGid) {
        var id = String(v.variantGid).split('/').pop();
        if (id) params.push('variant=' + encodeURIComponent(id));
      }
      if (sessionReference) params.push('stone=' + encodeURIComponent(sessionReference));
      return params.length ? href + '?' + params.join('&') : href;
    }

    /**
     * Minor units to a display string.
     *
     * The server sends integer minor units as decimal STRINGS and this does
     * not do arithmetic on them -- it inserts a separator. Parsing a price
     * into a float to divide by 100 is exactly the floating-point money path
     * the project forbids, and a cent lost on a ring is a cent lost.
     */
    function formatMinor(minorUnits, currency) {
      if (minorUnits === null || minorUnits === undefined || minorUnits === "") return "";
      var digits = String(minorUnits).replace(/[^0-9]/g, "");
      if (!digits) return "";
      while (digits.length < 3) digits = "0" + digits;
      var major = digits.slice(0, -2);
      var cents = digits.slice(-2);
      try {
        return new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: currency || "USD",
        }).format(Number(major + "." + cents));
      } catch (e) {
        return major + "." + cents;
      }
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
      reviewExplanation = payload.reviewExplanation || null;
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

    function selectSetting(candidate, then) {
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
          // A caller that is going on to the cart takes over from here: the
          // selection is recorded, and showing a "done" panel before the
          // customer has actually bought anything would be a lie.
          if (then) { then(data); return; }

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
          if (then) then(null);
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
        mountedState: body.mountedState,
      };
      // Sent only when it could have been offered. The server validates this
      // again and REJECTS a mismatch rather than zeroing it, so a stale page
      // produces an error the customer can see instead of a silent decline.
      if (body.mountedState === 'MOUNTED_PRONG' && body.stoneRemovalSelected) {
        payload.stoneRemovalSelected = true;
      }
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

          lastPayload = data;
          renderSummary(data);
          renderRemoval(data);
          renderResults(data);
          // THE FORK, not the results. The customer has entered their stone
          // once; what happens next is their choice, and a customer who
          // already knows what they want must not be made to browse first.
          showChoice(data);
        })
        .catch(function () {
          showError(s('sessionError', 'We could not save your stone details. Please try again.'));
        })
        .finally(function () {
          submit.disabled = false;
        });
    });

    /**
     * REHYDRATE from ?stone=<reference> (owner section 5, 2026-11-02).
     *
     * Opening a mounting detail page and coming back must not make the
     * customer re-enter their stone. The reference in the URL is a POINTER:
     * the server recomputes the session, the matched profile, the
     * classification and the cards from its own record. Nothing is restored
     * from anything the browser kept, which is what keeps this file honest
     * about state living on the server.
     *
     * A reference that is unknown, expired or owned by somebody else simply
     * leaves the form showing -- the customer enters their stone as normal
     * rather than meeting an error about a session they never knew existed.
     */
    function rehydrateFromUrl() {
      var ref = null;
      try {
        ref = new URLSearchParams(window.location.search).get('stone');
      } catch (e) {
        return;
      }
      if (!ref) return;

      fetch(SESSION_ENDPOINT + '?stone=' + encodeURIComponent(ref), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
      })
        .then(function (r) {
          if (!r.ok) throw new Error('rehydrate_failed');
          return r.json();
        })
        .then(function (data) {
          if (!data || !data.session) return;
          sessionReference = data.session.sessionReference;
          if (customLink) {
            var base = root.getAttribute('data-custom-jewelry-url') || '/pages/custom-jewelry';
            customLink.setAttribute('href', base + '?stone=' + encodeURIComponent(sessionReference));
          }
          lastPayload = data;
          renderSummary(data);
          renderRemoval(data);
          renderResults(data);
          showChoice(data);
        })
        .catch(function () {
          /* Leave the form showing. */
        });
    }

    rehydrateFromUrl();

    /**
     * Show the two paths, and decide which one LEADS.
     *
     * Both are always present and always the same size. When no ready
     * mounting qualified, custom becomes the primary action and the heading
     * becomes "Custom setting recommended" — the one case where the two stop
     * being symmetrical, because offering a browse that returns nothing is a
     * dead end.
     */
    function showChoice(payload) {
      var nothingMatched = !payload.mountings || payload.mountings.length === 0;

      var heading = root.querySelector('[data-carat-syos-choose-heading]');
      var line = root.querySelector('[data-carat-syos-choose-line]');
      var summaryHeading = root.querySelector('[data-carat-syos-summary-heading]');
      var summaryLine = root.querySelector('[data-carat-syos-summary-line]');
      if (heading && summaryHeading) heading.textContent = summaryHeading.textContent;
      if (line && summaryLine) line.textContent = summaryLine.textContent;

      var paths = root.querySelector('.carat-syos__paths');
      if (paths) {
        // Reorder rather than hide: custom first and primary when nothing
        // matched, side by side otherwise.
        paths.classList.toggle('carat-syos__paths--custom-leads', nothingMatched);
      }
      var readyPath = root.querySelector('[data-carat-syos-choose-ready]');
      if (readyPath) {
        readyPath.disabled = nothingMatched;
        var readyCard = readyPath.closest('.carat-syos__path');
        if (readyCard) readyCard.classList.toggle('carat-syos__path--unavailable', nothingMatched);
      }
      var readyHeading = root.querySelector('.carat-syos__paths .carat-syos__path-heading');
      if (readyHeading && nothingMatched) {
        readyHeading.textContent = s('customRecommended', 'Custom setting recommended');
      }

      var customCta = root.querySelector('[data-carat-syos-choose-custom]');
      if (customCta) customCta.setAttribute('href', customUrl(null));

      show('choose');
    }

    var chooseReady = root.querySelector('[data-carat-syos-choose-ready]');
    if (chooseReady) {
      chooseReady.addEventListener('click', function () {
        show('results');
      });
    }

    var backToChoose = root.querySelector('[data-carat-syos-back-to-choose]');
    if (backToChoose) {
      backToChoose.addEventListener('click', function () {
        if (lastPayload) showChoice(lastPayload);
      });
    }

    var editFromChoose = root.querySelector('[data-carat-syos-edit-from-choose]');
    if (editFromChoose) {
      editFromChoose.addEventListener('click', function () {
        // Back to the form with every value still in it.
        show('stone');
      });
    }

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
