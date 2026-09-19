/**
 * The mode-aware cart pricing applier (Stage 2B task 2B-4, R12 §"the theme
 * applies and re-applies" — docs/specs/SLICE-2B-CART-SURFACE-INVENTORY.md).
 *
 * THE SINGLE PRICE SOURCE IS THE SERVER. This module never computes,
 * selects, or otherwise decides a price — every `data-carat-money` kind
 * below is a direct read of one field the proxy response already carries
 * (see selectDisplayMinorUnits' own comment). It POSTs the cart's lines and
 * payment mode to `/apps/carat/cart` (the App Proxy route at
 * app/app/routes/apps.carat.cart.tsx) and writes the figures that route
 * returns into the DOM nodes 2B-3's Liquid marks with `data-carat-money`.
 * R12's original fixed DOM contract named four mode-toggled kinds —
 * `line-unit`, `line-total`, `cart-subtotal`, `cart-total` — keyed by
 * `data-carat-line-id` where per-line; 2B-3's owner §3 amendment added six
 * more, non-toggled ones for the simultaneous Card/Bank/saving breakdown —
 * see selectDisplayMinorUnits' own comment for the full ten-kind list. Every
 * money figure a customer sees on a cart surface traces
 * back to `priceCart`, which is typed, money-safety-scanned and unit tested
 * server-side — this file only formats and places already-decided integers,
 * using plain string/integer manipulation on the minor-units string so no
 * floating point ever touches a money value here either (CLAUDE.md
 * principle 6, extended to the theme even though check-money-safety.mjs
 * only walks app/tests/prisma today).
 *
 * WHY THIS IS THE ONLY THING THAT WRITES THESE NODES. Dawn re-renders cart
 * sections through the Section Rendering API (this file's own
 * getSectionsToRender/updateQuantity/onCartUpdate, and assets/cart-drawer.js
 * — two separate implementations there, both call in here) and swaps
 * `innerHTML` with fresh SERVER-RENDERED markup that is always Card-basis
 * (L1: there is no mode-aware Shopify cart object to read instead). A
 * surface "fixed" once and not re-applied after the next swap silently
 * reverts to Card pricing on the next quantity change — L3's whole point.
 * So every call site in this theme that replaces cart money markup calls
 * `apply()` again afterward. `apply()` re-scans the WHOLE document by
 * attribute rather than a specific section list, which is what makes it
 * correct regardless of which of the several different
 * `getSectionsToRender()` variants fired, or which unrelated component
 * (product-form add-to-cart, quick-add, quick-order-list, the Standard
 * Actions refresh path) triggered the swap.
 *
 * PENDING / FAIL-SAFE (the R12 cost). In Bank mode the Liquid renders a
 * money node pending (`data-carat-mode-pending`) because the server-rendered
 * value under it is Card-basis and must never be shown to a Bank-mode
 * customer, even briefly. This module clears that attribute only once it
 * has written a real mode-correct figure. If the proxy call fails, pending
 * nodes are left pending AND given a plain-language error state — the Card
 * figure underneath must never be revealed just because the correction
 * failed.
 *
 * NO CLIENT-SIDE STATE. `apply()` always re-reads the `carat_payment_mode`
 * cart attribute from a fresh cart fetch (or from an already-fresh AJAX
 * response a caller passes in) rather than caching mode in a JS variable,
 * and always asks the server to price the CURRENT cart from scratch. That is
 * what makes repeated Bank <-> Card switching safe: there is nothing
 * client-side to compound or double-apply.
 */
window.CaratCartPricing = (function () {
  var PROXY_PATH = '/apps/carat/cart';
  var MODE_ATTRIBUTE = 'carat_payment_mode';
  var DEFAULT_MODE = 'card';
  var MONEY_SELECTOR = '[data-carat-money]';
  var CURRENCY_SYMBOLS = { USD: '$' };

  // Guards against an in-flight apply() resolving AFTER a later one and
  // overwriting a newer (correct) state with a stale one — e.g. two quick
  // successive quantity changes whose responses arrive out of order.
  var requestSequence = 0;

  function currencySymbol(currency) {
    return CURRENCY_SYMBOLS[currency] || currency + ' ';
  }

  // Formats an integer minor-units DECIMAL STRING (e.g. "123450") for
  // display. Pure string/integer manipulation — never converts the value to
  // a floating-point number, so there is no rounding hazard between what the
  // server decided and what is shown.
  function formatMoneyFromMinorUnits(minorUnitsString, currency) {
    if (typeof minorUnitsString !== 'string' || !/^-?\d+$/.test(minorUnitsString)) return null;

    var negative = minorUnitsString.charAt(0) === '-';
    var digits = negative ? minorUnitsString.slice(1) : minorUnitsString;
    var padded = digits.length < 3 ? digits.padStart(3, '0') : digits;
    var dollars = padded.slice(0, -2);
    var cents = padded.slice(-2);
    var groupedDollars = dollars.replace(/\B(?=(\d{3})+(?!\d))/g, ',');

    return (negative ? '-' : '') + currencySymbol(currency) + groupedDollars + '.' + cents;
  }

  function readModeFromCart(cart) {
    var mode = cart && cart.attributes && cart.attributes[MODE_ATTRIBUTE];
    return mode === 'bank' ? 'bank' : DEFAULT_MODE;
  }

  function buildRequestLines(cart) {
    var items = (cart && cart.items) || [];
    return items.map(function (item) {
      return {
        lineId: String(item.key),
        shopifyVariantId: String(item.variant_id != null ? item.variant_id : item.id),
        quantity: item.quantity,
      };
    });
  }

  function fetchCart() {
    var cartUrl = (typeof routes !== 'undefined' && routes && routes.cart_url) || '/cart';
    return fetch(cartUrl + '.js', { headers: { Accept: 'application/json' } }).then(function (response) {
      if (!response.ok) throw new Error('CaratCartPricing: cart fetch failed with status ' + response.status);
      return response.json();
    });
  }

  function fetchPricing(mode, lines) {
    return fetch(PROXY_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ mode: mode, lines: lines }),
    }).then(function (response) {
      if (!response.ok) throw new Error('CaratCartPricing: proxy responded with status ' + response.status);
      return response.json();
    });
  }

  function findPurchasableLine(dto, lineId) {
    for (var i = 0; i < dto.lines.length; i++) {
      if (dto.lines[i].purchasable && dto.lines[i].lineId === lineId) return dto.lines[i];
    }
    return null;
  }

  // Picks the minor-units figure a given money node should display. Returns
  // null when the node cannot be resolved (e.g. a line the proxy marked
  // unpurchasable, an unrecognized kind, or a stale/removed line id) —
  // callers leave such a node untouched rather than guessing at a figure.
  //
  // TEN kinds total (R12, amended by 2B-3's owner §3 addendum —
  // docs/specs/SLICE-2B-CART-SURFACE-INVENTORY.md, cartR12DomContract.test.ts
  // VALID_CARAT_MONEY_VALUES is the authoritative enum this must stay in
  // sync with): the original four active-mode figures (line-unit,
  // line-total, cart-subtotal, cart-total — mode-toggled), plus owner §3's
  // simultaneous, non-toggled Card/Bank/saving breakdown shown regardless of
  // the cart's current mode (line-card, line-bank, line-saving at line
  // scope; cart-card-total, cart-bank-total, cart-saving at cart scope).
  //
  // EVERY ONE OF THESE IS A DIRECT DTO FIELD READ. No selection, no
  // eligibility branch, no arithmetic of any kind lives in this function.
  // line-card/line-bank used to read the eligibility-aware unit price via a
  // branch here (`bankPaymentDiscountEligible ? bank : card`) — that
  // reimplemented owner §18's eligibility rule client-side, which is exactly
  // the kind of duplication CLAUDE.md principle 3 forbids: the rule already
  // lives in priceCartLine (app/app/domain/cart/pricing.ts), which sets
  // lineBankBasisTotalMinorUnits equal to lineCardBasisTotalMinorUnits for
  // an ineligible line BY CONSTRUCTION, so reading lineBankBasisTotalMinorUnits
  // unconditionally is already correct for both eligible and ineligible
  // lines — the branch was correct but redundant, and was deleted rather
  // than kept "just in case" (team lead ruling, 2026-09-19: "every
  // eligibility decision now lives in one place... the client just renders
  // what it is given"). lineCardBasisTotalMinorUnits/lineBankBasisTotalMinorUnits
  // are also quantity-extended, the same scale as lineBankPaymentSavingsMinorUnits,
  // so line-card minus line-bank now equals line-saving on screen at any
  // quantity — the scale mismatch flagged in an earlier revision of this
  // file is resolved, not just hidden.
  function selectDisplayMinorUnits(dto, kind, lineId) {
    switch (kind) {
      case 'cart-subtotal':
      case 'cart-total':
        return dto.activeMerchandiseTotalMinorUnits;
      case 'cart-card-total':
        return dto.cardMerchandiseTotalMinorUnits;
      case 'cart-bank-total':
        return dto.bankMerchandiseTotalMinorUnits;
      case 'cart-saving':
        return dto.bankPaymentSavingsMinorUnits;
      case 'line-unit':
      case 'line-total':
      case 'line-card':
      case 'line-bank':
      case 'line-saving': {
        var line = findPurchasableLine(dto, lineId);
        if (!line) return null;
        if (kind === 'line-unit') return line.activeUnitPriceMinorUnits;
        if (kind === 'line-total') return line.lineActiveTotalMinorUnits;
        if (kind === 'line-card') return line.lineCardBasisTotalMinorUnits;
        if (kind === 'line-bank') return line.lineBankBasisTotalMinorUnits;
        return line.lineBankPaymentSavingsMinorUnits;
      }
      default:
        // Unreachable from applyDtoToDocument, which gates on
        // VALID_CARAT_MONEY_KINDS before ever calling this function —
        // undefined (not null) so a caller that skips that gate gets the
        // "missing field on an otherwise-resolved DTO" loud-failure
        // treatment rather than the "line not found, try again" one.
        return undefined;
    }
  }

  // The authoritative ten (cartR12DomContract.test.ts's VALID_CARAT_MONEY_VALUES
  // is the source of truth this must stay in sync with).
  var VALID_CARAT_MONEY_KINDS = [
    'line-unit',
    'line-total',
    'cart-subtotal',
    'cart-total',
    'line-card',
    'line-bank',
    'line-saving',
    'cart-card-total',
    'cart-bank-total',
    'cart-saving',
  ];

  // Puts one node into the same visible, non-price error state used on a
  // fetch/proxy failure. `logMessage`, when given, is logged distinctly from
  // apply()'s own fetch-failure log so the two failure modes (a request that
  // failed vs. a value this file does not know how to display) are
  // distinguishable in the console rather than reading as the same error.
  function setNodeErrorState(node, logMessage) {
    node.setAttribute('data-carat-mode-error', 'true');
    // Not localized — this task owns JS only, and the theme's locale JSON is
    // out of scope for it. Flagged in the 2B-4 handoff for an owner/locale
    // decision rather than silently guessed at here.
    node.textContent =
      (window.cartStrings && window.cartStrings.caratPriceUnavailable) || 'Price unavailable. Please refresh.';
    if (logMessage && typeof console !== 'undefined' && console.error) {
      console.error('[CaratCartPricing] ' + logMessage);
    }
  }

  function applyDtoToDocument(dto) {
    var nodes = document.querySelectorAll(MONEY_SELECTOR);
    nodes.forEach(function (node) {
      var kind = node.getAttribute('data-carat-money');

      // LOUD FAILURE BY DESIGN (team lead correction, 2026-09-19): an
      // unrecognized data-carat-money value must never sit pending forever
      // showing "Calculating…" as if nothing were wrong — that is the exact
      // silent-miss shape the C4 inventory exists to prevent, reproduced at
      // the level of one attribute value instead of one file. It must also
      // never fall through to some OTHER kind's figure; showing the wrong
      // price is worse than showing none.
      if (VALID_CARAT_MONEY_KINDS.indexOf(kind) === -1) {
        setNodeErrorState(node, 'unrecognized data-carat-money value "' + kind + '" has no display mapping');
        return;
      }

      var lineId = node.getAttribute('data-carat-line-id');
      var minorUnits = selectDisplayMinorUnits(dto, kind, lineId);

      // NULL is the one legitimate "not yet" case: a per-line kind whose
      // line isn't resolvable right now (a stale/removed line id, or one
      // the proxy marked unpurchasable) — left pending, not erred, because
      // the NEXT apply() call (already scheduled by the same cart mutation)
      // corrects it. selectDisplayMinorUnits returns this literal `null`
      // ONLY from its "line not found" branches.
      if (minorUnits === null) return;

      // UNDEFINED means something different and worse: a recognized kind
      // whose line (or the cart-level DTO itself) WAS found, but the
      // specific field this kind reads is missing from it — an upstream
      // fault (a malformed/incomplete proxy response), never patched over
      // with a different field's figure (team lead ruling, 2026-09-19: "if
      // lineBankBasisTotalMinorUnits is ever absent, that is an upstream
      // fault and should hit your loud-failure path, not be patched over
      // with the card figure").
      if (minorUnits === undefined) {
        setNodeErrorState(node, 'kind "' + kind + '" resolved to a missing field on an otherwise-resolved DTO');
        return;
      }

      var formatted = formatMoneyFromMinorUnits(minorUnits, dto.currency);
      if (formatted == null) {
        setNodeErrorState(node, 'kind "' + kind + '" resolved to a non-numeric minor-units value: ' + minorUnits);
        return;
      }

      // cart-live-region-text.liquid (A4/L2) carries a localized label and
      // expects the applying JS to compose "<label>: <amount>" rather than
      // the bare figure, so the announcement reads as a sentence rather than
      // a lone dollar amount.
      var liveRegionLabel = node.getAttribute('data-carat-live-region-label');
      node.textContent = liveRegionLabel ? liveRegionLabel + ': ' + formatted : formatted;
      node.removeAttribute('data-carat-mode-pending');
      node.removeAttribute('data-carat-mode-error');
    });
  }

  // Failure path (R12: "never show a Card figure ... even for 200ms"). Only
  // nodes still marked pending are touched — a pending node's underlying
  // server-rendered content is Card-basis and must stay hidden/replaced; a
  // non-pending node (Card mode, or an ineligible line) already shows a
  // figure that was safe to render on the server and is left alone.
  function markPendingNodesAsFailed() {
    var nodes = document.querySelectorAll('[data-carat-money][data-carat-mode-pending]');
    nodes.forEach(function (node) {
      setNodeErrorState(node);
    });
  }

  function apply(options) {
    options = options || {};
    var sequence = ++requestSequence;

    var cartPromise = options.cart ? Promise.resolve(options.cart) : fetchCart();

    return cartPromise
      .then(function (cart) {
        var mode = readModeFromCart(cart);
        var lines = buildRequestLines(cart);
        return fetchPricing(mode, lines);
      })
      .then(function (dto) {
        if (sequence !== requestSequence) return; // superseded by a later apply()
        applyDtoToDocument(dto);
      })
      .catch(function (error) {
        if (sequence !== requestSequence) return;
        markPendingNodesAsFailed();
        if (typeof console !== 'undefined' && console.error) {
          console.error('[CaratCartPricing] apply() failed', error);
        }
      });
  }

  function initGlobalCartUpdateSubscription() {
    if (typeof subscribe !== 'function' || typeof PUB_SUB_EVENTS === 'undefined') return;
    // Every cart mutation in this theme (add-to-cart, quick-add,
    // quick-order-list, recipient-form gifting, the Standard Actions refresh
    // path in standard-actions-override.js) publishes this event once it has
    // swapped in fresh (Card-basis) server-rendered markup. 'cart-items' is
    // skipped because CartItems#updateQuantity below already calls apply()
    // itself with the precise ordering L2 needs (reapply BEFORE announcing
    // the live region, not after) — subscribing here too would just be a
    // redundant duplicate request for that one path.
    subscribe(PUB_SUB_EVENTS.cartUpdate, function (event) {
      if (event && event.source === 'cart-items') return;
      apply();
    });
  }

  if (typeof subscribe === 'function' && typeof PUB_SUB_EVENTS !== 'undefined') {
    initGlobalCartUpdateSubscription();
  } else {
    document.addEventListener('DOMContentLoaded', initGlobalCartUpdateSubscription, { once: true });
  }

  return {
    apply: apply,
    // Exposed only for the Vitest sandbox harness under app/app/theme/ to
    // unit test this file's real pure logic without duplicating it — see
    // that suite's header comment. Not a public API for other theme
    // scripts; call apply() from there.
    _internal: {
      formatMoneyFromMinorUnits: formatMoneyFromMinorUnits,
      readModeFromCart: readModeFromCart,
      buildRequestLines: buildRequestLines,
      selectDisplayMinorUnits: selectDisplayMinorUnits,
      applyDtoToDocument: applyDtoToDocument,
      markPendingNodesAsFailed: markPendingNodesAsFailed,
    },
  };
})();

class CartRemoveButton extends HTMLElement {
  constructor() {
    super();

    this.addEventListener('click', (event) => {
      event.preventDefault();
      const cartItems = this.closest('cart-items') || this.closest('cart-drawer-items');
      cartItems.updateQuantity(this.dataset.index, 0, event);
    });
  }
}

customElements.define('cart-remove-button', CartRemoveButton);

class CartItems extends window.StandardEvents.createViewEventElement(HTMLElement) {
  constructor() {
    super();
    this.lineItemStatusElement =
      document.getElementById('shopping-cart-line-item-status') || document.getElementById('CartDrawer-LineItemStatus');

    const debouncedOnChange = debounce((event) => {
      this.onChange(event);
    }, ON_CHANGE_DEBOUNCE_TIMER);

    this.addEventListener('change', debouncedOnChange.bind(this));
  }

  cartUpdateUnsubscriber = undefined;

  static pendingCartDataPromise = null;

  connectedCallback() {
    // The factory base class auto-dispatches cart:view from the
    // `view-event-payload` attribute (Liquid filter output). The drawer
    // sets `view-event-trigger="manual"` to skip auto-dispatch.
    super.connectedCallback();

    this.cartUpdateUnsubscriber = subscribe(PUB_SUB_EVENTS.cartUpdate, (event) => {
      if (event.source === 'cart-items') return;
      return this.onCartUpdate();
    });

    // Stage 2B L5 "reload persistence": the server renders this element with
    // Card-basis figures (and, in Bank mode, 2B-3's pending markers) on every
    // full page load and on every Section Rendering API mount, including the
    // drawer's initial skeleton on pages where the drawer is never opened.
    // Apply once on connect so a reload reveals mode-aware pricing
    // immediately rather than waiting for the first quantity change.
    window.CaratCartPricing.apply();
  }

  // Fetches the full cart shape (used to resolve the cart:lines-update event
  // promise after /cart/add.js, which only returns the added line — not the
  // post-mutation cart aggregates). De-duplicated across concurrent callers.
  static fetchCartData() {
    if (!CartItems.pendingCartDataPromise) {
      const pendingCartDataPromise = fetch(`${routes.cart_url}.json`)
        .then((response) => response.json())
        .catch(() => null)
        .finally(() => {
          if (CartItems.pendingCartDataPromise === pendingCartDataPromise) CartItems.pendingCartDataPromise = null;
        });

      CartItems.pendingCartDataPromise = pendingCartDataPromise;
    }
    return CartItems.pendingCartDataPromise;
  }

  disconnectedCallback() {
    if (this.cartUpdateUnsubscriber) {
      this.cartUpdateUnsubscriber();
    }
  }

  resetQuantityInput(id) {
    const input = this.querySelector(`#Quantity-${id}`);
    input.value = input.getAttribute('value');
    this.isEnterPressed = false;
  }

  setValidity(event, index, message) {
    event.target.setCustomValidity(message);
    event.target.reportValidity();
    this.resetQuantityInput(index);
    event.target.select();
  }

  validateQuantity(event) {
    const inputValue = parseInt(event.target.value);
    const index = event.target.dataset.index;
    let message = '';

    if (inputValue < event.target.dataset.min) {
      message = window.quickOrderListStrings.min_error.replace('[min]', event.target.dataset.min);
    } else if (inputValue > parseInt(event.target.max)) {
      message = window.quickOrderListStrings.max_error.replace('[max]', event.target.max);
    } else if (inputValue % parseInt(event.target.step) !== 0) {
      message = window.quickOrderListStrings.step_error.replace('[step]', event.target.step);
    }

    if (message) {
      this.setValidity(event, index, message);
    } else {
      event.target.setCustomValidity('');
      event.target.reportValidity();
      this.updateQuantity(
        index,
        inputValue,
        event,
        document.activeElement.getAttribute('name'),
        event.target.dataset.quantityVariantId
      );
    }
  }

  onChange(event) {
    this.validateQuantity(event);
  }

  onCartUpdate() {
    if (this.tagName === 'CART-DRAWER-ITEMS') {
      return fetch(`${routes.cart_url}?section_id=cart-drawer`)
        .then((response) => response.text())
        .then((responseText) => {
          const html = new DOMParser().parseFromString(responseText, 'text/html');
          const selectors = ['cart-drawer-items', '.cart-drawer__footer'];
          for (const selector of selectors) {
            const targetElement = document.querySelector(selector);
            const sourceElement = html.querySelector(selector);
            if (targetElement && sourceElement) {
              targetElement.replaceWith(sourceElement);
            }
          }
          // D2: this branch swaps in fresh Card-basis markup independently of
          // updateQuantity()'s own section-rendering path, so it needs its
          // own reapplication too (L3).
          window.CaratCartPricing.apply();
        })
        .catch((e) => {
          console.error(e);
        });
    } else {
      return fetch(`${routes.cart_url}?section_id=main-cart-items`)
        .then((response) => response.text())
        .then((responseText) => {
          const html = new DOMParser().parseFromString(responseText, 'text/html');
          const sourceQty = html.querySelector('cart-items');
          this.innerHTML = sourceQty.innerHTML;
          // Same reasoning as the drawer branch above (D1/L3).
          window.CaratCartPricing.apply();
        })
        .catch((e) => {
          console.error(e);
        });
    }
  }

  getSectionsToRender() {
    return [
      {
        id: 'main-cart-items',
        section: document.getElementById('main-cart-items').dataset.id,
        selector: '.js-contents',
      },
      {
        id: 'cart-icon-bubble',
        section: 'cart-icon-bubble',
        selector: '.shopify-section',
      },
      {
        id: 'cart-live-region-text',
        section: 'cart-live-region-text',
        selector: '.shopify-section',
      },
      {
        id: 'main-cart-footer',
        section: document.getElementById('main-cart-footer').dataset.id,
        selector: '.js-contents',
      },
    ];
  }

  updateQuantity(line, quantity, event, name, variantId) {
    const eventTarget = event.currentTarget instanceof CartRemoveButton ? 'clear' : 'change';
    const cartPerformanceUpdateMarker = CartPerformance.createStartingMarker(`${eventTarget}:user-action`);

    this.enableLoading(line);

    const action = quantity === 0 ? 'remove' : 'update';
    const quantityInput = this.querySelector(`#Quantity-${line}`) || this.querySelector(`#Drawer-quantity-${line}`);
    const lineVariantId = variantId || quantityInput?.dataset.quantityVariantId;
    const lineKey = quantityInput?.dataset.quantityLineKey;
    const linesUpdateDeferred = this.createCartLinesUpdateEvent(action, lineVariantId, quantity, lineKey);

    // Cache sections before the fetch so we read dataset.id while elements still exist in the DOM
    const sectionsToRender = this.getSectionsToRender();

    const body = JSON.stringify({
      line,
      quantity,
      sections: sectionsToRender.map((section) => section.section),
      sections_url: window.location.pathname,
    });

    fetch(`${routes.cart_change_url}`, { ...fetchConfig(), ...{ body } })
      .then((response) => {
        return response.text();
      })
      .then((state) => {
        const parsedState = JSON.parse(state);

        if (parsedState.errors) {
          this.dispatchCartErrorEvent(parsedState.errors, 'INVALID');
          linesUpdateDeferred?.reject(new Error(parsedState.errors));
        } else {
          this.resolveCartLinesUpdate(linesUpdateDeferred, parsedState);
        }

        // Populated inside the measure callback below and read after it, so
        // the live-region announcement (L2) can be deferred until AFTER
        // mode-aware pricing has been reapplied — see the comment past the
        // measure() call for why the deferral itself is necessary.
        let liveRegionMessage;

        CartPerformance.measure(`${eventTarget}:paint-updated-sections`, () => {
          const quantityElement =
            document.getElementById(`Quantity-${line}`) || document.getElementById(`Drawer-quantity-${line}`);
          const items = document.querySelectorAll('.cart-item');

          if (parsedState.errors) {
            quantityElement.value = quantityElement.getAttribute('value');
            this.updateLiveRegions(line, parsedState.errors);
            return;
          }

          this.classList.toggle('is-empty', parsedState.item_count === 0);
          const cartDrawerWrapper = document.querySelector('cart-drawer');
          const cartFooter = document.getElementById('main-cart-footer');

          if (cartFooter) cartFooter.classList.toggle('is-empty', parsedState.item_count === 0);
          if (cartDrawerWrapper) cartDrawerWrapper.classList.toggle('is-empty', parsedState.item_count === 0);

          sectionsToRender.forEach((section) => {
            const elementToReplace =
              document.getElementById(section.id).querySelector(section.selector) ||
              document.getElementById(section.id);
            elementToReplace.innerHTML = this.getSectionInnerHTML(
              parsedState.sections[section.section],
              section.selector
            );
          });
          const updatedValue = parsedState.items[line - 1] ? parsedState.items[line - 1].quantity : undefined;
          let message = '';
          if (items.length === parsedState.items.length && updatedValue !== parseInt(quantityElement.value)) {
            if (typeof updatedValue === 'undefined') {
              message = window.cartStrings.error;
            } else {
              message = window.cartStrings.quantityError.replace('[quantity]', updatedValue);
            }
          }
          liveRegionMessage = message;

          const lineItem =
            document.getElementById(`CartItem-${line}`) || document.getElementById(`CartDrawer-Item-${line}`);
          if (lineItem && lineItem.querySelector(`[name="${name}"]`)) {
            cartDrawerWrapper
              ? trapFocus(cartDrawerWrapper, lineItem.querySelector(`[name="${name}"]`))
              : lineItem.querySelector(`[name="${name}"]`).focus();
          } else if (parsedState.item_count === 0 && cartDrawerWrapper?.querySelector('.drawer__inner-empty')) {
            trapFocus(cartDrawerWrapper.querySelector('.drawer__inner-empty'), cartDrawerWrapper.querySelector('a'));
          } else if (document.querySelector('.cart-item') && cartDrawerWrapper) {
            trapFocus(cartDrawerWrapper, document.querySelector('.cart-item__name'));
          }
        });

        // L2: sectionsToRender just swapped in fresh Card-basis markup
        // (D1) — reapply mode-aware pricing to it, and only THEN announce
        // the live region. Announcing immediately (the original Dawn
        // ordering) would read the raw Card total to a screen-reader user
        // in Bank mode, with no visual cue that it was about to be
        // corrected — worse than the sighted flash, because nothing tells
        // them it changed. The error-branch call above (still synchronous)
        // is unaffected: it returns before any section is swapped, so the
        // live region's money content there is untouched and already
        // correct from the previous apply().
        if (!parsedState.errors) {
          window.CaratCartPricing.apply({ cart: parsedState }).finally(() => {
            this.updateLiveRegions(line, liveRegionMessage);
          });
        }

        publish(PUB_SUB_EVENTS.cartUpdate, { source: 'cart-items', cartData: parsedState, variantId: variantId });
      })
      .catch((e) => {
        this.querySelectorAll('.loading__spinner').forEach((overlay) => overlay.classList.add('hidden'));
        const errors = document.getElementById('cart-errors') || document.getElementById('CartDrawer-CartErrors');
        if (errors) errors.textContent = window.cartStrings.error;
        this.dispatchCartErrorEvent(window.cartStrings.error, 'SERVICE_UNAVAILABLE');
        linesUpdateDeferred?.reject(e);
      })
      .finally(() => {
        this.disableLoading(line);
        CartPerformance.measureFromMarker(`${eventTarget}:user-action`, cartPerformanceUpdateMarker);
      });
  }

  createCartLinesUpdateEvent(action, variantId, quantity, lineKey) {
    const { CartLinesUpdateEvent } = window.StandardEvents || {};
    if (!CartLinesUpdateEvent || !variantId) return null;
    // No AJAX line key on the row — likely cached HTML rendered before this
    // attribute landed. Skip dispatch rather than emit an event with id: ''.
    if (!lineKey) return null;

    const deferred = CartLinesUpdateEvent.createPromise();
    this.dispatchEvent(
      new CartLinesUpdateEvent({
        action,
        context: 'cart',
        lines: [{ id: lineKey, quantity }],
        promise: deferred.promise,
      })
    );
    return deferred;
  }

  resolveCartLinesUpdate(deferred, parsedState) {
    if (!deferred) return;
    const { CartLinesUpdateEvent } = window.StandardEvents || {};
    if (!CartLinesUpdateEvent) return;

    deferred.resolve({ cart: CartLinesUpdateEvent.createCartFromAjaxResponse(parsedState) });
  }

  dispatchCartErrorEvent(message, code) {
    const { CartErrorEvent } = window.StandardEvents || {};
    if (!CartErrorEvent) return;
    this.dispatchEvent(new CartErrorEvent({ error: message, code }));
  }

  updateLiveRegions(line, message) {
    const lineItemError =
      document.getElementById(`Line-item-error-${line}`) || document.getElementById(`CartDrawer-LineItemError-${line}`);
    if (lineItemError) lineItemError.querySelector('.cart-item__error-text').textContent = message;

    this.lineItemStatusElement.setAttribute('aria-hidden', true);

    const cartStatus =
      document.getElementById('cart-live-region-text') || document.getElementById('CartDrawer-LiveRegionText');
    cartStatus.setAttribute('aria-hidden', false);

    setTimeout(() => {
      cartStatus.setAttribute('aria-hidden', true);
    }, 1000);
  }

  getSectionInnerHTML(html, selector) {
    return new DOMParser().parseFromString(html, 'text/html').querySelector(selector).innerHTML;
  }

  enableLoading(line) {
    const mainCartItems = document.getElementById('main-cart-items') || document.getElementById('CartDrawer-CartItems');
    mainCartItems.classList.add('cart__items--disabled');

    const cartItemElements = this.querySelectorAll(`#CartItem-${line} .loading__spinner`);
    const cartDrawerItemElements = this.querySelectorAll(`#CartDrawer-Item-${line} .loading__spinner`);

    [...cartItemElements, ...cartDrawerItemElements].forEach((overlay) => overlay.classList.remove('hidden'));

    document.activeElement.blur();
    this.lineItemStatusElement.setAttribute('aria-hidden', false);
  }

  disableLoading(line) {
    const mainCartItems = document.getElementById('main-cart-items') || document.getElementById('CartDrawer-CartItems');
    mainCartItems.classList.remove('cart__items--disabled');

    const cartItemElements = this.querySelectorAll(`#CartItem-${line} .loading__spinner`);
    const cartDrawerItemElements = this.querySelectorAll(`#CartDrawer-Item-${line} .loading__spinner`);

    cartItemElements.forEach((overlay) => overlay.classList.add('hidden'));
    cartDrawerItemElements.forEach((overlay) => overlay.classList.add('hidden'));
  }
}

customElements.define('cart-items', CartItems);

if (!customElements.get('cart-note')) {
  customElements.define(
    'cart-note',
    class CartNote extends HTMLElement {
      constructor() {
        super();

        this.addEventListener(
          'input',
          debounce((event) => {
            const newNote = event.target.value;
            const noteDeferred = this.dispatchNoteUpdateEvent(newNote);

            const body = JSON.stringify({ note: newNote });
            fetch(`${routes.cart_update_url}`, { ...fetchConfig(), ...{ body } })
              .then((r) => r.json())
              .then((cart) => {
                if (!cart || cart.errors) {
                  throw Object.assign(new Error(cart?.errors), { code: 'INVALID' });
                }

                if (noteDeferred) {
                  const { CartNoteUpdateEvent } = window.StandardEvents || {};
                  if (CartNoteUpdateEvent) {
                    noteDeferred.resolve({ cart: CartNoteUpdateEvent.createCartFromAjaxResponse(cart) });
                  }
                }
                CartPerformance.measureFromEvent('note-update:user-action', event);
              })
              .catch((e) => {
                noteDeferred?.reject(e);
                const { CartErrorEvent } = window.StandardEvents || {};
                if (CartErrorEvent) {
                  this.dispatchEvent(
                    new CartErrorEvent({
                      error: e.message || 'Note update failed',
                      code: e.code || 'SERVICE_UNAVAILABLE',
                    })
                  );
                }
              });
          }, ON_CHANGE_DEBOUNCE_TIMER)
        );
      }

      dispatchNoteUpdateEvent(newNote) {
        const { CartNoteUpdateEvent } = window.StandardEvents || {};
        if (!CartNoteUpdateEvent) return null;

        const context = this.closest('dialog') || this.closest('cart-drawer') ? 'dialog' : 'cart';
        const deferred = CartNoteUpdateEvent.createPromise();

        this.dispatchEvent(
          new CartNoteUpdateEvent({
            context,
            note: newNote,
            promise: deferred.promise,
          })
        );

        return deferred;
      }
    }
  );
}
