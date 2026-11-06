/**
 * CaratForUs First Access V2.
 *
 * THE PAGE WORKS WITHOUT THIS FILE, with one honest exception. The signup is
 * a native Shopify customer form that is already in the document, so it
 * posts, reloads and renders its own success state. Every feature sentence
 * is on its card, so no explanation is hidden behind a script. What this
 * file adds: opening the modals, folding interests into the one tag field
 * Shopify understands, handing the mobile number to the app proxy, the
 * sticky bar, and sharing.
 *
 * NOTHING HERE TOUCHES V1. Separate file, separate selectors, separate
 * storage key.
 *
 * THE BACKEND IS UNCHANGED. Same `/apps/carat/first-access-phone` route,
 * same payload of exactly two fields. No SMS consent is set or implied here.
 *
 * NO EM DASH CHARACTERS, in code or in comments. Owner rule for V2.
 */
(function () {
  'use strict';

  var ROOT = '[data-fa2]';
  var BASE_TAG = 'first-access';
  var PHONE_ENDPOINT = '/apps/carat/first-access-phone';
  /** V2 specific, so a V1 tab and a V2 tab cannot read each other's stash. */
  var HANDOFF_KEY = 'caratFaV2Pending';

  function cfg() {
    return window.caratFaV2 || {};
  }
  function s(key, fallback) {
    var v = cfg()[key];
    return typeof v === 'string' && v.length > 0 ? v : fallback;
  }

  /* ------------------------------------------------------------- modals */

  var lastFocus = null;

  function openModal(dialog) {
    if (!dialog) return;
    lastFocus = document.activeElement;
    hideSticky(true);
    if (typeof dialog.showModal === 'function') {
      dialog.showModal();
    } else {
      // No dialog support: fall back to an always visible panel rather than
      // a button that does nothing.
      dialog.setAttribute('open', 'open');
    }
    var focusTarget = dialog.querySelector('[data-fa2-success]')
      || dialog.querySelector('input, button, [tabindex]');
    if (focusTarget && typeof focusTarget.focus === 'function') {
      focusTarget.focus({ preventScroll: true });
    }
  }

  function closeModal(dialog) {
    if (!dialog) return;
    if (typeof dialog.close === 'function' && dialog.open) {
      dialog.close();
    } else {
      dialog.removeAttribute('open');
    }
    hideSticky(false);
    if (lastFocus && typeof lastFocus.focus === 'function') {
      lastFocus.focus({ preventScroll: true });
    }
  }

  function wireModals(root) {
    var signup = root.querySelector('[data-fa2-modal]');

    root.querySelectorAll('[data-fa2-open]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        // A detail modal may hold a Get First Access button. Close it first so
        // two dialogs are never stacked.
        var inDialog = btn.closest('dialog');
        if (inDialog) closeModal(inDialog);
        openModal(signup);
      });
    });

    root.querySelectorAll('[data-fa2-detail]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var key = btn.getAttribute('data-fa2-detail');
        openModal(root.querySelector('[data-fa2-detail-modal="' + key + '"]'));
      });
    });

    root.querySelectorAll('[data-fa2-close]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        closeModal(btn.closest('dialog'));
      });
    });

    root.querySelectorAll('dialog').forEach(function (dialog) {
      // Clicking the backdrop closes. The panel stops the event, so a click
      // inside the form never counts as a click outside.
      dialog.addEventListener('click', function (event) {
        if (event.target === dialog) closeModal(dialog);
      });
      dialog.addEventListener('close', function () {
        hideSticky(false);
      });
    });
  }

  /* ------------------------------------------------------- sticky button */

  var sticky = null;
  var stickySuppressed = false;
  /**
   * The last thing the observer told us. Kept because the observer only
   * fires when the hero button CROSSES the threshold: closing a modal while
   * scrolled far down produces no crossing, so without remembering this the
   * bar would stay hidden until the visitor scrolled back up past the hero.
   * Found by testing the real page rather than by reading the code.
   */
  var heroButtonVisible = true;

  function applySticky() {
    if (!sticky) return;
    sticky.hidden = heroButtonVisible || stickySuppressed;
  }

  function hideSticky(suppress) {
    stickySuppressed = suppress;
    applySticky();
  }

  function wireSticky(root) {
    sticky = root.querySelector('[data-fa2-sticky]');
    var anchor = root.querySelector('.fa2-btn--hero');
    if (!sticky || !anchor || typeof IntersectionObserver !== 'function') return;

    // Shown only once the hero button has scrolled away, so it never
    // duplicates a button already on screen.
    new IntersectionObserver(
      function (entries) {
        heroButtonVisible = entries[0].isIntersecting;
        applySticky();
      },
      { rootMargin: '0px 0px -20% 0px' }
    ).observe(anchor);
  }

  /* --------------------------------------------------------- the signup */

  function tagsFor(form) {
    var tags = [BASE_TAG];
    var chosen = form.querySelectorAll('[data-fa2-interest]:checked');
    for (var i = 0; i < chosen.length; i += 1) {
      var value = String(chosen[i].value || '').trim();
      if (value && tags.indexOf(value) === -1) tags.push(value);
    }
    return tags.join(',');
  }

  function showError(form, message) {
    var box = form.querySelector('[data-fa2-error]');
    if (!box) return;
    box.textContent = message;
    box.hidden = false;
  }

  function clearError(form) {
    var box = form.querySelector('[data-fa2-error]');
    if (!box) return;
    box.textContent = '';
    box.hidden = true;
  }

  /**
   * The address and the number, and nothing else.
   *
   * Names and interests are deliberately absent: they persist through the
   * native post, and sending them to a public endpoint would mean a public
   * endpoint could change them. Returns null when there is no number, so a
   * signup without one makes no extra request at all.
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

  /** Fire and forget. A failed phone write must never make a good signup look broken. */
  function sendPhone(submission) {
    if (!submission || typeof window.fetch !== 'function') return;
    fetch(PHONE_ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(submission),
      keepalive: true,
    }).catch(function () {
      /* Nothing to say and nothing to do. */
    });
  }

  function rememberForReload(submission) {
    if (!submission) return;
    try {
      window.sessionStorage.setItem(HANDOFF_KEY, JSON.stringify(submission));
    } catch (e) {
      /* Private mode. The number is simply not captured. */
    }
  }

  function flushReloadHandoff(root) {
    if (!root.querySelector('[data-fa2-success]')) return;
    var raw;
    try {
      raw = window.sessionStorage.getItem(HANDOFF_KEY);
      // Cleared before the send, so a failure cannot leave a number behind.
      window.sessionStorage.removeItem(HANDOFF_KEY);
    } catch (e) {
      return;
    }
    if (!raw) return;
    try {
      sendPhone(JSON.parse(raw));
    } catch (e) {
      /* Corrupt stash, already removed. */
    }
  }

  /**
   * Replace the form with the success panel, parsed out of the very response
   * Shopify would have shown. One success panel in the codebase, rendered by
   * Liquid, rather than a second copy written here that could drift.
   */
  function renderSuccess(signupEl, html) {
    var parsed = new DOMParser().parseFromString(html, 'text/html');
    var panel = parsed.querySelector('[data-fa2-success]');
    if (!panel) return false;
    signupEl.innerHTML = '';
    signupEl.appendChild(document.importNode(panel, true));
    wireShare(signupEl);
    var focusTarget = signupEl.querySelector('[data-fa2-success]');
    if (focusTarget && typeof focusTarget.focus === 'function') {
      focusTarget.focus({ preventScroll: true });
    }
    return true;
  }

  function wireForm(root) {
    var signupEl = root.querySelector('[data-fa2-signup]');
    if (!signupEl) return;
    var form = signupEl.querySelector('form');
    if (!form) return;

    form.addEventListener('submit', function (event) {
      var tagsField = form.querySelector('input[name="contact[tags]"]');
      if (tagsField) tagsField.value = tagsFor(form);

      /**
       * THE SAME THREE REQUIRED FIELDS, IN THE ORDER THEY NOW APPEAR.
       *
       * This list is not the validation rules, it is the order the first
       * empty field is looked for in, and that has to track the layout. The
       * fields were reordered to First, Last, Email, Mobile; leaving Email
       * first here would have sent a visitor who submitted an empty form
       * down to the third field instead of the first.
       *
       * Which fields are required is unchanged, and so are the messages.
       */
      var required = [
        { name: 'contact[first_name]', message: s('errorFirstName', 'Please enter your first name.') },
        { name: 'contact[last_name]', message: s('errorLastName', 'Please enter your last name.') },
        { name: 'contact[email]', message: s('errorEmail', 'Please enter a valid email address.') },
      ];
      var problem = null;
      for (var i = 0; i < required.length; i += 1) {
        var field = form.querySelector('input[name="' + required[i].name + '"]');
        if (!field) continue;
        if (String(field.value || '').trim() === '' || !field.checkValidity()) {
          problem = { field: field, message: required[i].message };
          break;
        }
      }
      if (problem) {
        event.preventDefault();
        showError(form, problem.message);
        problem.field.focus();
        return;
      }
      clearError(form);

      // Captured before either path destroys the form.
      var submission = phoneSubmission(form);

      if (typeof window.fetch !== 'function' || typeof FormData !== 'function') {
        rememberForReload(submission);
        return; // Native post. The page still works.
      }

      event.preventDefault();
      var button = form.querySelector('[data-fa2-submit]');
      var original = button ? button.textContent : null;
      if (button) {
        button.disabled = true;
        button.textContent = s('submitting', 'Joining');
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
          if (!renderSuccess(signupEl, html)) throw new Error('no_success_panel');
          // The customer exists now. Only now may the number be sent.
          sendPhone(submission);
        })
        .catch(function () {
          rememberForReload(submission);
          if (button) {
            button.disabled = false;
            if (original !== null) button.textContent = original;
          }
          form.submit();
        });
    });
  }

  /* ------------------------------------------------------------ sharing */

  function shareDetails() {
    var url = s('shareUrl', window.location.origin + '/pages/first-access');
    var text = s('shareText', 'CaratForUs is launching soon. Join First Access:');
    return { url: url, text: text, full: text + ' ' + url };
  }

  function wireShare(scope) {
    var share = scope.querySelector('[data-fa2-share]');
    if (!share) return;
    var d = shareDetails();

    var whatsapp = share.querySelector('[data-fa2-share-whatsapp]');
    if (whatsapp) {
      whatsapp.setAttribute('href', 'https://wa.me/?text=' + encodeURIComponent(d.full));
    }

    var facebook = share.querySelector('[data-fa2-share-facebook]');
    if (facebook) {
      // Facebook takes the URL only; it builds its own preview from the page.
      facebook.setAttribute(
        'href',
        'https://www.facebook.com/sharer/sharer.php?u=' + encodeURIComponent(d.url)
      );
    }

    var email = share.querySelector('[data-fa2-share-email]');
    if (email) {
      email.setAttribute(
        'href',
        'mailto:?subject=' + encodeURIComponent(s('shareSubject', 'CaratForUs First Access')) +
          '&body=' + encodeURIComponent(d.full)
      );
    }

    var sms = share.querySelector('[data-fa2-share-sms]');
    if (sms) {
      // `?&body=` is the form that works on both iOS and Android; a bare
      // `?body=` is ignored by some iOS versions.
      sms.setAttribute('href', 'sms:?&body=' + encodeURIComponent(d.full));
    }

    var feedback = scope.querySelector('[data-fa2-share-feedback]');
    function say(message) {
      if (!feedback) return;
      feedback.textContent = message;
      feedback.hidden = false;
    }

    var copy = share.querySelector('[data-fa2-share-copy]');
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

    /**
     * The route to Instagram, TikTok, Messages and whatever else the device
     * has installed. Revealed only where `navigator.share` genuinely exists,
     * so the page never offers an app route it cannot deliver.
     */
    var native = share.querySelector('[data-fa2-share-native]');
    if (native && typeof navigator.share === 'function') {
      native.hidden = false;
      native.addEventListener('click', function () {
        navigator.share({ title: s('shareSubject', 'CaratForUs'), text: d.text, url: d.url })
          .catch(function () {
            /* A dismissed share sheet is a normal outcome, not an error. */
          });
      });
    }
  }

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

  /* --------------------------------------------------------------- init */

  function init() {
    var roots = document.querySelectorAll(ROOT);
    for (var i = 0; i < roots.length; i += 1) {
      var root = roots[i];
      wireModals(root);
      wireSticky(root);
      wireForm(root);
      // Present already when Shopify rendered the success state server side.
      wireShare(root);
      flushReloadHandoff(root);
      // A native post reloads the page with the success panel inside the
      // modal, which would otherwise be closed and invisible.
      if (root.querySelector('[data-fa2-success]')) {
        openModal(root.querySelector('[data-fa2-modal]'));
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
