if (!customElements.get('product-form')) {
  customElements.define(
    'product-form',
    class ProductForm extends HTMLElement {
      constructor() {
        super();

        this.form = this.querySelector('form');
        this.variantIdInput.disabled = false;
        this.form.addEventListener('submit', this.onSubmitHandler.bind(this));
        this.cart = document.querySelector('cart-notification') || document.querySelector('cart-drawer');
        this.submitButton = this.querySelector('[type="submit"]');
        this.submitButtonText = this.submitButton.querySelector('span');

        // Owner §20: the form can now have a second submit button ("Add to
        // Cart with Bank Payment Discount") that opens the same
        // drawer/notification dialog as the default one — both need the
        // same popup affordance, not just whichever `querySelector` finds
        // first.
        if (document.querySelector('cart-drawer')) {
          this.querySelectorAll('[type="submit"]').forEach((button) => button.setAttribute('aria-haspopup', 'dialog'));
        }

        this.hideErrors = this.dataset.hideErrors === 'true';
      }

      onSubmitHandler(evt) {
        evt.preventDefault();

        // Owner §20 (docs/SLICE-2-AND-GROUP-BUY-OWNER-DECISIONS.md): the form
        // now has TWO submit buttons (default Add to Cart and Add to Cart
        // with Bank Payment Discount, marked `data-carat-add-to-cart`), not
        // one. `evt.submitter` is the button the browser actually activated
        // — captured here, synchronously, because it is only reliable on the
        // originating SubmitEvent, not after any awaited work. Every loading-
        // state toggle below acts on THIS button rather than the
        // constructor-cached `this.submitButton` (which is unconditionally
        // the FIRST submit button in the form), so clicking the Bank Payment
        // action shows loading/disabled feedback on the button the customer
        // actually pressed instead of silently animating the other one.
        // Falls back to `this.submitButton` only when the browser does not
        // populate `submitter` (e.g. an ambiguous Enter-key submission).
        const submitter = evt.submitter || this.submitButton;
        const submitterTextEl = submitter.querySelector('span') || this.submitButtonText;
        const wantsBankPaymentMode = submitter.getAttribute('data-carat-add-to-cart') === 'bank';

        if (submitter.getAttribute('aria-disabled') === 'true') return;

        this.handleErrorMessage();

        submitter.setAttribute('aria-disabled', true);
        submitter.classList.add('loading');
        submitter.querySelector('.loading__spinner')?.classList.remove('hidden');

        const config = fetchConfig('javascript');
        config.headers['X-Requested-With'] = 'XMLHttpRequest';
        delete config.headers['Content-Type'];

        const formData = new FormData(this.form);
        if (this.cart) {
          formData.append(
            'sections',
            this.cart.getSectionsToRender().map((section) => section.id)
          );
          formData.append('sections_url', window.location.pathname);
          this.cart.setActiveElement(document.activeElement);
        }
        config.body = formData;

        const variantId = formData.get('id');
        const quantity = parseInt(formData.get('quantity')) || 1;
        const linesUpdateDeferred = this.createCartLinesUpdateEvent(variantId, quantity);

        fetch(`${routes.cart_add_url}`, config)
          .then((response) => response.json())
          .then((response) => {
            if (response.status) {
              publish(PUB_SUB_EVENTS.cartError, {
                source: 'product-form',
                productVariantId: variantId,
                errors: response.errors || response.description,
                message: response.message,
              });
              this.handleErrorMessage(response.description);
              this.dispatchCartErrorEvent(response.description || response.message, 'INVALID');
              linesUpdateDeferred?.reject(new Error(response.description || response.message));

              const soldOutMessage = submitter.querySelector('.sold-out-message');
              if (!soldOutMessage) return;
              submitter.setAttribute('aria-disabled', true);
              submitterTextEl?.classList.add('hidden');
              soldOutMessage.classList.remove('hidden');
              this.error = true;
              return;
            } else if (!this.cart) {
              this.resolveCartLinesUpdate(linesUpdateDeferred);
              // Owner §20: "Add to Cart with Bank Payment Discount" must
              // switch the whole cart to Bank mode even on a theme
              // configured to redirect straight to the cart page (no
              // drawer/notification) — the mode has to be persisted through
              // /cart/update.js BEFORE navigating away, or the cart page
              // would load still showing Card mode.
              this.applyCaratPaymentModeIfRequested(wantsBankPaymentMode).finally(() => {
                window.location = window.routes.cart_url;
              });
              return;
            }

            this.resolveCartLinesUpdate(linesUpdateDeferred);

            const startMarker = CartPerformance.createStartingMarker('add:wait-for-subscribers');
            if (!this.error)
              publish(PUB_SUB_EVENTS.cartUpdate, {
                source: 'product-form',
                productVariantId: variantId,
                cartData: response,
              }).then(() => {
                CartPerformance.measureFromMarker('add:wait-for-subscribers', startMarker);
              });
            this.error = false;

            // Owner §20: switch to Bank mode BEFORE the drawer/notification
            // renders, so a customer who chose "Add to Cart with Bank
            // Payment Discount" never sees the popup open on Card pricing
            // for even one frame. The plain "Add to Cart" action deliberately
            // does none of this — it must preserve whatever mode the cart
            // was already in (owner §19), and doing nothing to the
            // `carat_payment_mode` attribute is what preserves it.
            this.applyCaratPaymentModeIfRequested(wantsBankPaymentMode).finally(() => {
              const quickAddModal = this.closest('quick-add-modal');
              if (quickAddModal) {
                document.body.addEventListener(
                  'modalClosed',
                  () => {
                    setTimeout(() => {
                      CartPerformance.measure("add:paint-updated-sections", () => {
                        this.cart.renderContents(response);
                      });
                    });
                  },
                  { once: true }
                );
                quickAddModal.hide(true);
              } else {
                CartPerformance.measure("add:paint-updated-sections", () => {
                  this.cart.renderContents(response);
                });
              }
            });
          })
          .catch((e) => {
            console.error(e);
            this.dispatchCartErrorEvent(e.message || 'Network error', 'SERVICE_UNAVAILABLE');
            linesUpdateDeferred?.reject(e);
          })
          .finally(() => {
            submitter.classList.remove('loading');
            if (this.cart && this.cart.classList.contains('is-empty')) this.cart.classList.remove('is-empty');
            if (!this.error) submitter.removeAttribute('aria-disabled');
            submitter.querySelector('.loading__spinner')?.classList.add('hidden');

            CartPerformance.measureFromEvent("add:user-action", evt);
          });
      }

      // Owner §20's Bank Payment add-to-cart action, isolated into its own
      // method so onSubmitHandler's two call sites (redirect-to-cart-page
      // and drawer/notification) share one path rather than two copies of
      // the same "is CaratCartPricing even loaded on this page" guard.
      // ALWAYS resolves (never rejects) — a failed mode switch must not
      // block the add-to-cart flow that already succeeded; it only means the
      // customer keeps whatever mode the cart already had, which is the
      // same fallback behaviour as the "default" action never touching mode
      // at all.
      applyCaratPaymentModeIfRequested(wantsBankPaymentMode) {
        if (!wantsBankPaymentMode) return Promise.resolve();
        // Defensive optional-chaining, not a "should never happen": some
        // cart_type theme settings do not load cart.js on every page (see
        // 2B-5 handoff) — a missing module here must fall back to leaving
        // the cart's mode untouched rather than throwing.
        const setPaymentMode = window.CaratCartPricing?.setPaymentMode;
        if (typeof setPaymentMode !== 'function') return Promise.resolve();
        return setPaymentMode('bank').catch((e) => {
          console.error('[CaratCartPricing] failed to switch to Bank Payment mode after add-to-cart', e);
        });
      }

      handleErrorMessage(errorMessage = false) {
        if (this.hideErrors) return;

        this.errorMessageWrapper =
          this.errorMessageWrapper || this.querySelector('.product-form__error-message-wrapper');
        if (!this.errorMessageWrapper) return;
        this.errorMessage = this.errorMessage || this.errorMessageWrapper.querySelector('.product-form__error-message');

        this.errorMessageWrapper.toggleAttribute('hidden', !errorMessage);

        if (errorMessage) {
          this.errorMessage.textContent = errorMessage;
        }
      }

      toggleSubmitButton(disable = true, text) {
        if (disable) {
          this.submitButton.setAttribute('disabled', 'disabled');
          if (text) this.submitButtonText.textContent = text;
        } else {
          this.submitButton.removeAttribute('disabled');
          this.submitButtonText.textContent = window.variantStrings.addToCart;
        }
      }

      createCartLinesUpdateEvent(variantId, quantity) {
        const { CartLinesUpdateEvent } = window.StandardEvents || {};
        if (!CartLinesUpdateEvent) return null;

        const deferred = CartLinesUpdateEvent.createPromise();
        this.dispatchEvent(
          new CartLinesUpdateEvent({
            action: 'add',
            context: 'product',
            lines: [{ merchandiseId: variantId, quantity }],
            promise: deferred.promise,
          })
        );
        return deferred;
      }

      resolveCartLinesUpdate(deferred) {
        if (!deferred) return;
        const { CartLinesUpdateEvent } = window.StandardEvents || {};
        if (!CartLinesUpdateEvent) return;

        const pendingCartDataPromise = typeof CartItems !== 'undefined'
          ? CartItems.fetchCartData()
          : fetch(`${routes.cart_url}.json`).then((response) => response.json());

        pendingCartDataPromise
          .then((cart) => {
            if (!cart?.currency) return deferred.reject(new Error('Missing currency in cart response'));
            deferred.resolve({ cart: CartLinesUpdateEvent.createCartFromAjaxResponse(cart) });
          })
          .catch((e) => deferred.reject(e));
      }

      dispatchCartErrorEvent(message, code) {
        const { CartErrorEvent } = window.StandardEvents || {};
        if (!CartErrorEvent) return;
        this.dispatchEvent(new CartErrorEvent({ error: message, code }));
      }

      get variantIdInput() {
        return this.form.querySelector('[name=id]');
      }
    }
  );
}
