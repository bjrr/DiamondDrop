/**
 * CaratForUs — First Access.
 *
 * THE PAGE WORKS WITHOUT THIS FILE. The signup is a native Shopify customer
 * form that posts, reloads and renders its own success panel. Everything here
 * is an upgrade on top of that: no reload, and a share sheet afterwards. If
 * this file fails to load, or fetch fails, the form submits the ordinary way.
 *
 * TWO THINGS IT DOES THAT THE MARKUP CANNOT.
 *
 *   1. Interests are checkboxes named `interests[]`, which Shopify's customer
 *      form does not understand. They are folded into the single
 *      `contact[tags]` value Shopify DOES understand, just before submit.
 *      Done here rather than with six hidden inputs because the customer may
 *      tick and untick freely until the moment they commit.
 *
 *   2. Share links are built from the live URL, so the page does not have to
 *      know its own address at render time and a shared link always points at
 *      wherever the visitor actually is.
 *
 * NO TRACKING, NO SDK, NO THIRD PARTY. The share targets are `sms:`,
 * `wa.me`, `mailto:` and the clipboard. A landing page for paid traffic earns
 * its conversions by loading fast.
 */
(function () {
  'use strict';

  var ROOT = '[data-carat-first-access]';
  /** Applied to every signup from this page, alongside any interests. */
  var BASE_TAG = 'first-access';

  function strings() {
    return window.caratFirstAccessStrings || {};
  }
  function s(key, fallback) {
    var v = strings()[key];
    return typeof v === 'string' && v.length > 0 ? v : fallback;
  }

  /**
   * The tag string Shopify will store on the customer.
   *
   * Values come from the checkboxes' own `value` attributes, which are
   * rendered by Liquid from a fixed list — the page never invents a tag, and
   * an empty selection simply leaves the base tag on its own.
   */
  function tagsFor(form) {
    var tags = [BASE_TAG];
    var chosen = form.querySelectorAll('[data-carat-fa-interest]:checked');
    for (var i = 0; i < chosen.length; i += 1) {
      var value = String(chosen[i].value || '').trim();
      if (value && tags.indexOf(value) === -1) tags.push(value);
    }
    return tags.join(',');
  }

  function showError(form, message) {
    var box = form.querySelector('[data-carat-fa-error]');
    if (!box) return;
    box.textContent = message;
    box.hidden = false;
  }

  function clearError(form) {
    var box = form.querySelector('[data-carat-fa-error]');
    if (!box) return;
    box.textContent = '';
    box.hidden = true;
  }

  /**
   * Swap the form for the success panel without a reload.
   *
   * The panel's markup comes from the SAME response Shopify would have shown
   * after a normal post, parsed out of the returned document — so there is one
   * success panel in the codebase, rendered by Liquid, not a second copy
   * written in JavaScript that could drift from it.
   */
  function renderSuccess(signup, html) {
    var parsed = new DOMParser().parseFromString(html, 'text/html');
    var panel = parsed.querySelector('[data-carat-fa-success]');
    if (!panel) return false;

    signup.innerHTML = '';
    signup.appendChild(document.importNode(panel, true));
    wireShare(signup);

    var focusTarget = signup.querySelector('[data-carat-fa-success]');
    if (focusTarget && typeof focusTarget.focus === 'function') {
      focusTarget.focus({ preventScroll: true });
      focusTarget.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
    return true;
  }

  function wireForm(signup) {
    var form = signup.querySelector('form');
    if (!form) return;

    form.addEventListener('submit', function (event) {
      var tagsField = form.querySelector('input[name="contact[tags]"]');
      if (tagsField) tagsField.value = tagsFor(form);

      var email = form.querySelector('input[name="contact[email]"]');
      // Email is the only required field, checked here purely so the visitor
      // is told immediately rather than after a round trip. Shopify validates
      // it again regardless.
      if (email && !email.checkValidity()) {
        event.preventDefault();
        showError(form, s('error', 'Please enter a valid email address.'));
        email.focus();
        return;
      }
      clearError(form);

      if (typeof window.fetch !== 'function' || typeof FormData !== 'function') {
        return; // Native submit. The page still works.
      }

      event.preventDefault();
      var button = form.querySelector('[data-carat-fa-submit]');
      var original = button ? button.textContent : null;
      if (button) {
        button.disabled = true;
        button.textContent = s('submitting', 'Joining…');
      }

      fetch(form.action, {
        method: 'POST',
        body: new FormData(form),
        credentials: 'same-origin',
        headers: { Accept: 'text/html' },
      })
        .then(function (response) {
          if (!response.ok) throw new Error('signup_failed');
          return response.text();
        })
        .then(function (html) {
          if (!renderSuccess(signup, html)) throw new Error('no_success_panel');
        })
        .catch(function () {
          // Hand the submission back to the browser rather than leaving the
          // visitor with a dead button: a conversion is worth a page reload.
          if (button) {
            button.disabled = false;
            if (original !== null) button.textContent = original;
          }
          form.submit();
        });
    });
  }

  /** Everything the share targets need, read from the live page. */
  function shareDetails() {
    var url = window.location.origin + window.location.pathname;
    var text = s('shareText', 'CaratForUs is launching soon.');
    return { url: url, text: text, full: text + ' ' + url };
  }

  function wireShare(scope) {
    var share = scope.querySelector('[data-carat-fa-share]');
    if (!share) return;
    var d = shareDetails();

    var sms = share.querySelector('[data-carat-fa-share-sms]');
    if (sms) {
      // `?&body=` is the form that works on both iOS and Android; iOS ignores
      // a bare `?body=` on some versions.
      sms.setAttribute('href', 'sms:?&body=' + encodeURIComponent(d.full));
    }

    var whatsapp = share.querySelector('[data-carat-fa-share-whatsapp]');
    if (whatsapp) {
      whatsapp.setAttribute('href', 'https://wa.me/?text=' + encodeURIComponent(d.full));
    }

    var email = share.querySelector('[data-carat-fa-share-email]');
    if (email) {
      email.setAttribute(
        'href',
        'mailto:?subject=' + encodeURIComponent('CaratForUs — First Access') +
          '&body=' + encodeURIComponent(d.full)
      );
    }

    var feedback = scope.querySelector('[data-carat-fa-share-feedback]');
    function say(message) {
      if (!feedback) return;
      feedback.textContent = message;
      feedback.hidden = false;
    }

    var copy = share.querySelector('[data-carat-fa-share-copy]');
    if (copy) {
      copy.addEventListener('click', function () {
        var done = function () { say(s('copied', 'Link copied')); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(d.url).then(done, function () {
            fallbackCopy(d.url, done);
          });
        } else {
          fallbackCopy(d.url, done);
        }
      });
    }

    // Offered only where the browser actually has a share sheet, so the
    // button is never present and inert.
    var native = share.querySelector('[data-carat-fa-share-native]');
    if (native && typeof navigator.share === 'function') {
      native.hidden = false;
      native.addEventListener('click', function () {
        navigator.share({ title: 'CaratForUs', text: d.text, url: d.url }).catch(function () {
          // A dismissed share sheet is a normal outcome, not an error.
        });
      });
    }
  }

  /** For browsers without the async clipboard API. */
  function fallbackCopy(value, done) {
    var field = document.createElement('textarea');
    field.value = value;
    field.setAttribute('readonly', 'readonly');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    try {
      document.execCommand('copy');
      done();
    } catch (e) {
      /* Nothing useful to say; the link is on screen regardless. */
    }
    document.body.removeChild(field);
  }

  function init() {
    var roots = document.querySelectorAll(ROOT);
    for (var i = 0; i < roots.length; i += 1) {
      var signups = roots[i].querySelectorAll('[data-carat-fa-signup]');
      for (var j = 0; j < signups.length; j += 1) {
        wireForm(signups[j]);
        // Present already when Shopify rendered the success state server-side.
        wireShare(signups[j]);
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
  document.addEventListener('shopify:section:load', init);
})();
