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

  /**
   * App-proxy route that stores, as a customer metafield, the one field
   * Shopify's customer form throws
   * away. See `app/routes/apps.carat.first-access-phone.tsx`.
   */
  var PHONE_ENDPOINT = '/apps/carat/first-access-phone';
  /**
   * Survives the page reload on the no-JS-fetch fallback path, and ONLY that.
   * Written immediately before submit, read and deleted once. sessionStorage
   * rather than localStorage so it cannot outlive the tab, and the key is
   * cleared before the request is even sent so a failure cannot leave a
   * mobile number sitting in storage.
   */
  var HANDOFF_KEY = 'caratFirstAccessPending';

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

  /**
   * Everything the proxy needs, read off the form — which is two fields.
   *
   * THE ADDRESS AND THE NUMBER, AND NOTHING ELSE. The name and the interests
   * are deliberately absent: they already persist through the native customer
   * post, and sending them here would mean a public endpoint could change
   * them. The address is present only because it is how the customer is
   * found.
   *
   * Returns null when there is no number to store — the entire reason this
   * request exists — so a signup without one makes no extra call at all, and
   * an omitted number can never reach a write path.
   */
  function phoneSubmission(form) {
    function value(name) {
      var field = form.querySelector('input[name="' + name + '"]');
      return field ? String(field.value || '').trim() : '';
    }
    var phone = value('contact[phone]');
    if (phone === '') return null;

    return { email: value('contact[email]'), phone: phone };
  }

  /**
   * Hand the number to the app, after Shopify has created the customer.
   *
   * ORDER MATTERS AND IS NOT NEGOTIABLE. The app can only update a customer
   * that already exists; it deliberately cannot create one, because this
   * endpoint has no captcha in front of it. So this runs only once the native
   * post has come back successful.
   *
   * FIRE AND FORGET. The signup has already succeeded by this point. If the
   * request fails the visitor is not told and nothing is retried — a failed
   * phone write must never make a successful signup look broken.
   */
  function sendPhone(submission) {
    if (!submission || typeof window.fetch !== 'function') return;
    fetch(PHONE_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(submission),
      keepalive: true,
    }).catch(function () {
      /* Nothing to say and nothing to do. See above. */
    });
  }

  /** Stash for the reload path, where the form is gone by the time we can send. */
  function rememberForReload(submission) {
    if (!submission) return;
    try {
      window.sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(submission));
    } catch (e) {
      /* Private mode, or storage full. The phone is simply not captured. */
    }
  }

  /**
   * Send anything left behind by a reload.
   *
   * Only ever runs on the success panel: a stash present while the form is
   * still on screen means the post failed, and sending the number for a
   * signup that did not happen would be writing to a customer who does not
   * exist.
   */
  function flushReloadHandoff(signup) {
    if (!signup.querySelector('[data-carat-fa-success]')) return;
    var raw;
    try {
      raw = window.sessionStorage.getItem(HANDOFF_KEY);
      // Cleared BEFORE the send, so a failure cannot leave it in storage.
      window.sessionStorage.removeItem(HANDOFF_KEY);
    } catch (e) {
      return;
    }
    if (!raw) return;
    try {
      sendPhone(JSON.parse(raw));
    } catch (e) {
      /* Corrupt stash. Already removed. */
    }
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

      /**
       * Three required fields now: email, first name, last name.
       *
       * Checked here only so the visitor is told immediately rather than
       * after a round trip; Shopify validates again regardless. The first
       * empty field is the one that gets focus, so a keyboard or screen
       * reader user lands on the thing to fix rather than the top of the
       * form.
       *
       * The phone is deliberately absent from this list. It is optional, and
       * an optional field that blocks submission is just a required field
       * with bad manners.
       */
      var required = [
        { name: 'contact[email]', message: s('errorEmail', 'Please enter a valid email address.') },
        { name: 'contact[first_name]', message: s('errorFirstName', 'Please enter your first name.') },
        { name: 'contact[last_name]', message: s('errorLastName', 'Please enter your last name.') },
      ];
      var firstProblem = null;
      for (var r = 0; r < required.length; r += 1) {
        var field = form.querySelector('input[name="' + required[r].name + '"]');
        if (!field) continue;
        var empty = String(field.value || '').trim() === '';
        if (empty || !field.checkValidity()) {
          firstProblem = { field: field, message: required[r].message };
          break;
        }
      }
      if (firstProblem) {
        event.preventDefault();
        showError(form, firstProblem.message);
        firstProblem.field.focus();
        return;
      }
      clearError(form);

      // Captured BEFORE anything else can touch the form, because both paths
      // below destroy it — one by replacing the markup, the other by
      // navigating away.
      var submission = phoneSubmission(form);

      if (typeof window.fetch !== 'function' || typeof FormData !== 'function') {
        rememberForReload(submission);
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
          // The customer now exists. Only now may the phone be sent.
          sendPhone(submission);
        })
        .catch(function () {
          // Hand the submission back to the browser rather than leaving the
          // visitor with a dead button: a conversion is worth a page reload.
          // The number rides along in sessionStorage, since this page is
          // about to be replaced.
          rememberForReload(submission);
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
        // ...which is also the one case where a number is waiting to be sent.
        flushReloadHandoff(signups[j]);
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
