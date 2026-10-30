/**
 * The authenticated Bank Payment orders page (register D12).
 *
 * Reads `GET /apps/carat/bank-payment-orders` and renders the signed-in
 * customer's own orders with payment instructions for the ones still
 * awaiting money.
 *
 * ============================================================================
 * THIS FILE DECIDES NOTHING THAT MATTERS
 * ============================================================================
 * It computes no money, no deadline, no eligibility and no authorization.
 * Amounts arrive as formatted decimal strings produced from bigint minor
 * units server-side; deadlines arrive as ISO instants; whether an order is
 * still payable is decided by the route, which attaches `instructions` only
 * when it is. If `instructions` is null, this file shows the status and no
 * payment destination — telling someone to send money for a cancelled order
 * is worse than telling them nothing.
 *
 * NO IDENTITY IS SENT. The fetch below passes no customer id, no email and
 * no order reference. The App Proxy signs `logged_in_customer_id` into the
 * request and the route matches it against the stored `customerGid`. Adding
 * any identity parameter here would not grant access — it would just be a
 * lie about where authorization comes from.
 *
 * textContent THROUGHOUT, NEVER innerHTML. These values cross a network
 * boundary and include payment destinations; a bank account number is the
 * last string that should be able to introduce markup into the page.
 */
(function () {
  'use strict';

  var ENDPOINT = '/apps/carat/bank-payment-orders';
  var SECTION_SELECTOR = '[data-carat-bank-orders-section]';
  var RESULTS_SELECTOR = '[data-carat-bank-orders-results]';

  function localeString(key) {
    var strings = window.bankPaymentOrdersStrings;
    if (strings && typeof strings[key] === 'string' && strings[key].length > 0) {
      return strings[key];
    }
    return key;
  }

  // ---- Pure helpers. Exported on `_internal` and unit tested without a DOM,
  // the same split `bank-payment-checkout.js` and `cart.js` use. ----

  /** ISO instant to a readable UTC string. No arithmetic — the server decided the instant. */
  function formatDeadline(iso) {
    var parsed = new Date(iso);
    if (isNaN(parsed.getTime())) return iso;
    var text = parsed.toISOString();
    return text.slice(0, 10) + ' ' + text.slice(11, 16) + ' UTC';
  }

  /**
   * The customer-facing label for a stored status value.
   *
   * DELIBERATELY TOTAL, AND DELIBERATELY NOT CLEVER. An unrecognised status
   * returns the raw value rather than guessing or hiding the row: a customer
   * seeing an unfamiliar word can quote it to support, whereas a row that
   * silently vanished is indistinguishable from a lost order. The two flows
   * have separate maps because the same word means different things —
   * Group Buy `inactive` is the 96-hour lapse and is reactivatable, which
   * has no Buy Now equivalent.
   */
  function statusLabel(flow, status) {
    var key = 'status_' + flow + '_' + status;
    var strings = window.bankPaymentOrdersStrings;
    if (strings && typeof strings[key] === 'string' && strings[key].length > 0) {
      return strings[key];
    }
    return status;
  }

  /**
   * Whether a Group Buy order has consumed its automatic extension and
   * lapsed. `reactivatedAt` later than `inactivatedAt` means staff already
   * brought it back, so it is not lapsed now.
   */
  function isLapsedGroupBuy(order) {
    if (!order || !order.inactivatedAt) return false;
    if (!order.reactivatedAt) return true;
    return new Date(order.reactivatedAt).getTime() < new Date(order.inactivatedAt).getTime();
  }

  /**
   * What the page should show, decided once, so the DOM code below has no
   * branches of its own worth testing.
   *
   * `coordinatesAvailable: false` is NOT an error state. The orders are real
   * and the customer should still see them, their references, their amounts
   * and their deadlines — just without a destination, plus a line telling
   * them to email us for it. Hiding the whole page because a Fly secret is
   * unset would turn a configuration problem into a lost customer.
   */
  function summarize(payload) {
    var buyNow = (payload && payload.buyNow) || [];
    var groupBuy = (payload && payload.groupBuy) || [];
    var total = buyNow.length + groupBuy.length;
    return {
      buyNow: buyNow,
      groupBuy: groupBuy,
      isEmpty: total === 0,
      // True only when there is something the customer could pay but we
      // cannot say where to send it.
      coordinatesMissing:
        !(payload && payload.coordinatesAvailable) &&
        total > 0 &&
        buyNow.concat(groupBuy).some(function (order) {
          return !order.instructions;
        }),
    };
  }

  /** Maps a failed fetch to a locale key. Never surfaces a server detail. */
  function messageKeyForFailure(status) {
    if (status === 401) return 'error_authentication_required';
    if (status === 404) return 'error_not_found';
    return 'error_generic';
  }

  // ---- DOM glue. ----

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  function row(dl, label, value) {
    dl.appendChild(el('dt', 'carat-bank-orders__label', label));
    dl.appendChild(el('dd', 'carat-bank-orders__value', value));
  }

  /**
   * The instruction block — the same facts, in the same order, as the
   * checkout confirmation panel and the email, because all three are
   * rendering ONE server-composed object (`paymentInstructionsView.ts`).
   * Changing the wording here would silently make the three disagree.
   */
  function renderInstructions(ins) {
    var block = el('div', 'carat-bank-orders__instructions');

    block.appendChild(el('p', 'carat-bank-orders__still-required', ins.paymentStillRequired));
    block.appendChild(el('p', 'carat-bank-orders__commitment', ins.commitmentNotice));

    if (ins.extensionNotice) {
      block.appendChild(el('p', 'carat-bank-orders__extension', ins.extensionNotice));
    }

    block.appendChild(
      el('h4', 'carat-bank-orders__methods-heading', localeString('confirmation_methods'))
    );

    for (var i = 0; i < ins.methods.length; i += 1) {
      var m = ins.methods[i];
      var method = el('div', 'carat-bank-orders__method');
      var fields = el('dl', 'carat-bank-orders__method-fields');
      if (m.kind === 'zelle') {
        method.appendChild(
          el('h5', 'carat-bank-orders__method-name', localeString('confirmation_zelle'))
        );
        row(fields, localeString('confirmation_send_to'), m.recipient);
        row(fields, localeString('confirmation_memo'), m.memo);
      } else {
        method.appendChild(
          el('h5', 'carat-bank-orders__method-name', localeString('confirmation_wire'))
        );
        row(fields, localeString('confirmation_bank_name'), m.bankName);
        row(fields, localeString('confirmation_account_name'), m.accountName);
        row(fields, localeString('confirmation_routing'), m.routingNumber);
        row(fields, localeString('confirmation_account_number'), m.accountNumber);
        row(fields, localeString('confirmation_reference_label'), m.reference);
      }
      method.appendChild(fields);
      block.appendChild(method);
    }

    block.appendChild(el('p', 'carat-bank-orders__include', ins.includeWithPayment));
    block.appendChild(
      el(
        'p',
        'carat-bank-orders__support',
        localeString('confirmation_support') + ' ' + ins.supportEmail
      )
    );
    return block;
  }

  /**
   * Which visual tone a status gets. Grouped by what the customer has to
   * DO, not by the stored value:
   *   waiting  — we need something from them (money, or time to pass)
   *   good     — money received or the order is done
   *   closed   — nothing further will happen
   *
   * Unknown statuses fall through to neutral rather than guessing. A
   * mislabelled badge on a payment surface is worse than an unstyled one.
   */
  function statusTone(status) {
    if (status === 'open' || status === 'active') return 'waiting';
    if (status === 'completed' || status === 'verified' || status === 'paid') return 'good';
    if (status === 'cancelled' || status === 'inactive' || status === 'expired') return 'closed';
    return 'neutral';
  }

  /** The badge element for a status, or null when there is nothing to show. */
  function statusBadge(flow, status) {
    if (!status) return null;
    return el(
      'span',
      'carat-bank-orders__badge carat-bank-orders__badge--' + statusTone(status),
      statusLabel(flow, status)
    );
  }
  function renderBuyNowOrder(order) {
    var card = el('li', 'carat-bank-orders__order');
    var head = el('div', 'carat-bank-orders__order-head');
    head.appendChild(el('h4', 'carat-bank-orders__order-heading', localeString('buy_now_order')));
    var badge = statusBadge('buy_now', order.status);
    if (badge) head.appendChild(badge);
    card.appendChild(head);

    var summary = el('dl', 'carat-bank-orders__summary');
    row(summary, localeString('field_reference'), order.reference);
    row(summary, localeString('field_status'), statusLabel('buy_now', order.status));
    row(
      summary,
      localeString('field_amount'),
      order.formattedAmountDue + ' ' + order.currency
    );
    row(summary, localeString('field_placed'), formatDeadline(order.quotedAt));
    row(summary, localeString('field_guarantee'), formatDeadline(order.guaranteeExpiresAt));
    card.appendChild(summary);

    if (order.instructions) {
      card.appendChild(renderInstructions(order.instructions));
    } else {
      card.appendChild(el('p', 'carat-bank-orders__no-instructions', localeString('no_instructions')));
    }
    return card;
  }

  function renderGroupBuyOrder(order) {
    var card = el('li', 'carat-bank-orders__order');
    var head = el('div', 'carat-bank-orders__order-head');
    head.appendChild(el('h4', 'carat-bank-orders__order-heading', localeString('group_buy_order')));
    var badge = statusBadge('group_buy', order.status);
    if (badge) head.appendChild(badge);
    card.appendChild(head);

    var summary = el('dl', 'carat-bank-orders__summary');
    row(summary, localeString('field_reference'), order.reference);
    row(summary, localeString('field_campaign'), order.campaignName + ' (' + order.campaignCode + ')');
    row(summary, localeString('field_status'), statusLabel('group_buy', order.status));
    row(summary, localeString('field_tier'), String(order.tierNumberAtQuote));
    row(summary, localeString('field_amount'), order.formattedAmountDue + ' ' + order.currency);
    row(summary, localeString('field_placed'), formatDeadline(order.quotedAt));
    row(summary, localeString('field_payment_deadline'), formatDeadline(order.paymentDeadline));
    card.appendChild(summary);

    if (order.instructions) {
      card.appendChild(renderInstructions(order.instructions));
    } else if (isLapsedGroupBuy(order)) {
      // The 96-hour lapse. The campaign may still be open, in which case the
      // SAME order and its ORIGINAL locked price can be reactivated by email
      // — so this says to write to us, not to place a new order.
      card.appendChild(el('p', 'carat-bank-orders__no-instructions', localeString('lapsed_reactivate')));
    } else {
      card.appendChild(el('p', 'carat-bank-orders__no-instructions', localeString('no_instructions')));
    }
    return card;
  }

  function renderGroup(container, headingKey, orders, renderOne) {
    if (orders.length === 0) return;
    container.appendChild(el('h3', 'carat-bank-orders__group-heading', localeString(headingKey)));
    var list = el('ul', 'carat-bank-orders__list');
    list.setAttribute('role', 'list');
    for (var i = 0; i < orders.length; i += 1) {
      list.appendChild(renderOne(orders[i]));
    }
    container.appendChild(list);
  }

  function render(results, payload) {
    var view = summarize(payload);
    results.innerHTML = '';
    results.setAttribute('aria-busy', 'false');

    if (view.isEmpty) {
      results.appendChild(el('p', 'carat-bank-orders__empty', localeString('empty')));
      return;
    }

    if (view.coordinatesMissing) {
      results.appendChild(
        el('p', 'carat-bank-orders__coordinates-missing', localeString('coordinates_unavailable'))
      );
    }

    renderGroup(results, 'buy_now_heading', view.buyNow, renderBuyNowOrder);
    renderGroup(results, 'group_buy_heading', view.groupBuy, renderGroupBuyOrder);
  }

  function renderError(results, messageKey) {
    results.innerHTML = '';
    results.setAttribute('aria-busy', 'false');
    results.appendChild(el('p', 'carat-bank-orders__error', localeString(messageKey)));
  }

  function load(section) {
    var results = section.querySelector(RESULTS_SELECTOR);
    if (!results) return;

    fetch(ENDPOINT, {
      headers: { Accept: 'application/json' },
      // Same-origin credentials so the proxy sees the storefront session.
      credentials: 'same-origin',
    })
      .then(function (response) {
        if (!response.ok) {
          renderError(results, messageKeyForFailure(response.status));
          return null;
        }
        return response.json();
      })
      .then(function (payload) {
        if (payload === null) return;
        render(results, payload);
      })
      .catch(function () {
        renderError(results, 'error_network');
      });
  }

  function init() {
    var section = document.querySelector(SECTION_SELECTOR);
    if (!section) return;
    if (!section.querySelector(RESULTS_SELECTOR)) return; // signed out
    load(section);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  window.CaratBankPaymentOrders = {
    _internal: {
      formatDeadline: formatDeadline,
      statusLabel: statusLabel,
      isLapsedGroupBuy: isLapsedGroupBuy,
      summarize: summarize,
      messageKeyForFailure: messageKeyForFailure,
    },
  };
})();
