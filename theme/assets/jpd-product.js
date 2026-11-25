/*
 * Jewelry product design for Dawn (jpd-*).
 * Works WITH Dawn's own product-info / variant-selects / product-form:
 *  - Dawn fetches the section for every option change; on PUB_SUB_EVENTS.variantChange
 *    we copy each [data-jpd-refresh] panel from that same response (no extra request).
 *  - When Dawn marks a combination unavailable it hides #price-<section>; we hide our
 *    variant-specific panels too, so nothing describes a variant that does not exist.
 *  - Metal purity buttons select a real native option input; Dawn does the rest.
 *  - <jpd-chain-addon> adds pendant + chain as two real cart lines via /cart/add.js.
 */
(() => {
  if (window.jpdProductLoaded) return;
  window.jpdProductLoaded = true;

  const hasPubSub = typeof subscribe === 'function' && typeof PUB_SUB_EVENTS !== 'undefined';

  /* Theme preview only: Dawn rewrites the URL to ?variant=; keep ?view=jpd-* so a reload stays on this template. */
  const previewView = new URLSearchParams(window.location.search).get('view');
  function keepPreviewView() {
    if (!previewView || !/^jpd-/.test(previewView)) return;
    const url = new URL(window.location.href);
    if (url.searchParams.get('view') === previewView) return;
    url.searchParams.set('view', previewView);
    window.history.replaceState(window.history.state, '', url);
  }

  /* ---------- panel refresh ---------- */
  function refreshPanels(sectionId, html) {
    document.querySelectorAll(`[data-jpd-refresh][id$="-${sectionId}"]`).forEach((panel) => {
      const fresh = html.getElementById(panel.id);
      if (fresh) panel.innerHTML = fresh.innerHTML;
      panel.hidden = false;
    });
  }

  function setPanelsUnavailable(sectionId, unavailable) {
    document.querySelectorAll(`[data-jpd-refresh][id$="-${sectionId}"]`).forEach((panel) => {
      if (/^jpd-(availability|details|item|price)-/.test(panel.id)) panel.hidden = unavailable;
    });
  }

  if (hasPubSub) {
    subscribe(PUB_SUB_EVENTS.variantChange, (event) => {
      const data = event && event.data;
      if (!data || !data.html) return;
      refreshPanels(data.sectionId, data.html);
      document.dispatchEvent(new CustomEvent('jpd:variant-change', { detail: { sectionId: data.sectionId, variant: data.variant } }));
      keepPreviewView();
    });
  }

  function watchUnavailable() {
    document.querySelectorAll('.jpd-assets[data-section]').forEach((marker) => {
      const sectionId = marker.dataset.section;
      if (marker.dataset.jpdWatching) return;
      marker.dataset.jpdWatching = 'true';
      const price = document.getElementById(`price-${sectionId}`);
      if (!price) return;
      new MutationObserver(() => setPanelsUnavailable(sectionId, price.classList.contains('hidden'))).observe(price, {
        attributes: true,
        attributeFilter: ['class'],
      });
    });
  }

  /* ---------- metal purity (split from a combined "14K Yellow Gold" option) ---------- */
  document.addEventListener('click', (event) => {
    const button = event.target.closest('[data-jpd-select]');
    if (!button) return;
    event.preventDefault();
    if (button.getAttribute('aria-pressed') === 'true') return;
    const input = document.getElementById(button.dataset.jpdSelect);
    if (!input) return;
    input.checked = true;
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  /* ---------- bracelet request: keep variant title current, focus result ---------- */
  document.addEventListener('jpd:variant-change', (event) => {
    const variant = event.detail && event.detail.variant;
    if (!variant) return;
    document.querySelectorAll('[data-jpd-variant-title]').forEach((input) => {
      input.value = variant.title || '';
    });
  });

  function focusMessages() {
    const message = document.querySelector('[data-jpd-focus]');
    if (message) {
      message.closest('details')?.setAttribute('open', '');
      message.focus();
    }
  }

  /* ---------- optional chain ---------- */
  class JpdChainAddon extends HTMLElement {
    connectedCallback() {
      this.controller = new AbortController();
      const signal = this.controller.signal;
      this.form = document.getElementById(this.dataset.form);
      this.add = this.querySelector('[data-chain-add]');
      this.select = this.querySelector('[data-chain-select]');
      this.picker = this.querySelector('[data-chain-picker]');
      this.error = this.querySelector('[data-chain-error]');
      this.status = this.querySelector('[data-chain-status]');
      this.scope = this.closest('product-info') || document.body;
      if (!this.form || !this.select) return;

      this.addEventListener('change', () => this.update(), { signal });
      document.addEventListener(
        'jpd:variant-change',
        (event) => {
          if (event.detail?.sectionId !== this.dataset.section) return;
          if (event.detail.variant) this.dataset.price = event.detail.variant.price;
          this.update();
        },
        { signal }
      );
      // Capture on document so this runs before Dawn's product-form submit handler.
      document.addEventListener('submit', (event) => this.onSubmit(event), { capture: true, signal });
      this.update();
    }

    disconnectedCallback() {
      this.controller?.abort();
      this.scope?.classList.remove('jpd-chain-selected');
    }

    get chainSelected() {
      return Boolean(this.add && this.add.checked);
    }

    money(cents) {
      try {
        return new Intl.NumberFormat(document.documentElement.lang || undefined, {
          style: 'currency',
          currency: this.dataset.currency || 'USD',
        }).format(cents / 100);
      } catch {
        return (cents / 100).toFixed(2);
      }
    }

    update() {
      const selected = this.chainSelected;
      this.picker.hidden = !selected;
      this.select.disabled = !selected;
      this.select.required = selected;
      this.scope.classList.toggle('jpd-chain-selected', selected);
      const option = this.select.selectedOptions[0];
      const valid = selected && option && option.value;
      this.querySelector('[data-chain-price]').textContent = valid ? option.dataset.money : '';
      this.querySelector('[data-chain-total]').textContent = valid
        ? this.money(Number(this.dataset.price) + Number(option.dataset.price))
        : '';
      this.error.textContent = '';
    }

    buildItems(formData, chainId) {
      const pendantId = Number(formData.get('id'));
      const quantity = Math.max(1, parseInt(formData.get('quantity'), 10) || 1);
      const chain = Number(chainId);
      if (!Number.isSafeInteger(pendantId) || pendantId <= 0 || !Number.isSafeInteger(chain) || chain <= 0 || chain === pendantId) {
        throw new Error('Invalid selection');
      }
      const pendant = { id: pendantId, quantity };
      const properties = {};
      for (const [key, value] of formData.entries()) {
        const match = /^properties\[(.+)\]$/.exec(key);
        if (match && typeof value === 'string') properties[match[1]] = value;
      }
      if (Object.keys(properties).length) pendant.properties = properties;
      if (formData.get('selling_plan')) pendant.selling_plan = formData.get('selling_plan');
      return [pendant, { id: chain, quantity }];
    }

    async onSubmit(event) {
      if (event.target !== this.form) return;
      if (!this.chainSelected) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (this.busy) return;

      const option = this.select.selectedOptions[0];
      if (!option || !option.value) {
        this.select.reportValidity();
        this.select.focus();
        return;
      }
      const formData = new FormData(this.form);
      let items;
      try {
        items = this.buildItems(formData, option.value);
      } catch {
        this.error.textContent = this.dataset.error;
        return;
      }

      const submitter = event.submitter || this.form.querySelector('[type="submit"]');
      const productForm = this.form.closest('product-form');
      const cart = document.querySelector('cart-drawer');
      this.busy = true;
      submitter?.setAttribute('aria-disabled', 'true');
      submitter?.classList.add('loading');
      this.error.textContent = '';

      try {
        const body = { items };
        if (cart) {
          body.sections = cart.getSectionsToRender().map((section) => section.id);
          body.sections_url = window.location.pathname;
        }
        const response = await fetch(`${window.routes?.cart_add_url || '/cart/add'}.js`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
          body: JSON.stringify(body),
        });
        const result = await response.json();
        if (!response.ok || result.status) {
          // Shopify adds nothing when any line in an items[] request fails.
          this.error.textContent = `${this.dataset.error} ${typeof result.description === 'string' ? result.description : ''}`.trim();
          return;
        }

        if (submitter?.dataset.caratAddToCart === 'bank' && typeof productForm?.applyCaratPaymentModeIfRequested === 'function') {
          await productForm.applyCaratPaymentModeIfRequested(true);
        }
        this.status.textContent = this.dataset.added;
        if (hasPubSub) publish(PUB_SUB_EVENTS.cartUpdate, { source: 'jpd-chain-addon', cartData: result });

        if (cart && result.sections) {
          // Cart drawer reads the first added line for its focus target.
          const first = result.items?.[0] || {};
          cart.renderContents({ ...first, sections: result.sections });
        } else {
          window.location = window.routes?.cart_url || '/cart';
        }
      } catch {
        this.error.textContent = this.dataset.error;
      } finally {
        this.busy = false;
        submitter?.removeAttribute('aria-disabled');
        submitter?.classList.remove('loading');
      }
    }
  }
  if (!customElements.get('jpd-chain-addon')) customElements.define('jpd-chain-addon', JpdChainAddon);

  function init() {
    watchUnavailable();
    focusMessages();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
