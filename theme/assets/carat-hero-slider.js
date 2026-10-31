/**
 * The homepage hero slider.
 *
 * Deliberately small and dependency-free. It changes which slide is visible
 * and keeps the accessibility state honest; CSS owns every transition.
 *
 * THREE THINGS WORTH KNOWING BEFORE EDITING:
 *
 * 1. `aria-hidden` and focusability move together. An off-screen slide that
 *    is only visually hidden still hands its links to the keyboard, so a
 *    sighted keyboard user tabs into a button they cannot see. Every
 *    inactive slide is `aria-hidden` AND has its focusable children given
 *    `tabindex="-1"`.
 *
 * 2. Autoplay stops permanently the first time a person uses a control.
 *    Resuming after an explicit choice fights the user — they pressed a
 *    button because they wanted to look at that slide.
 *
 * 3. Under `prefers-reduced-motion` autoplay never starts at all. The
 *    controls still work; nothing moves on its own.
 */
(function () {
  'use strict';

  var SECTION = '[data-carat-hslider]';
  var FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]';

  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function setup(root) {
    var slides = Array.prototype.slice.call(root.querySelectorAll('[data-carat-hslide]'));
    if (slides.length < 2) return;

    var dots = Array.prototype.slice.call(root.querySelectorAll('[data-carat-hslider-dot]'));
    var prev = root.querySelector('[data-carat-hslider-prev]');
    var next = root.querySelector('[data-carat-hslider-next]');
    var live = root.querySelector('[data-carat-hslider-live]');

    var index = 0;
    var timer = null;
    var interval = parseInt(root.getAttribute('data-interval'), 10);
    if (isNaN(interval) || interval < 2000) interval = 7000;
    var autoplayWanted = root.getAttribute('data-autoplay') === 'true' && !reducedMotion();
    var stoppedByUser = false;

    function show(n, announce) {
      index = (n + slides.length) % slides.length;

      slides.forEach(function (slide, i) {
        var active = i === index;
        slide.classList.toggle('is-active', active);
        // Both, together — see note 1 above.
        if (active) {
          slide.removeAttribute('aria-hidden');
        } else {
          slide.setAttribute('aria-hidden', 'true');
        }
        Array.prototype.forEach.call(slide.querySelectorAll(FOCUSABLE), function (el) {
          if (active) {
            el.removeAttribute('tabindex');
          } else {
            el.setAttribute('tabindex', '-1');
          }
        });
      });

      dots.forEach(function (dot, i) {
        var active = i === index;
        dot.classList.toggle('is-active', active);
        dot.setAttribute('aria-selected', active ? 'true' : 'false');
      });

      // Only announce a change the person caused or the timer made — not the
      // initial paint, which would make a screen reader talk on page load.
      if (announce && live) {
        live.textContent = 'Slide ' + (index + 1) + ' of ' + slides.length;
      }
    }

    function start() {
      if (!autoplayWanted || stoppedByUser || timer) return;
      timer = window.setInterval(function () { show(index + 1, true); }, interval);
    }

    function pause() {
      if (timer) { window.clearInterval(timer); timer = null; }
    }

    function stopForGood() {
      stoppedByUser = true;
      pause();
    }

    function go(n) {
      stopForGood();
      show(n, true);
    }

    if (prev) prev.addEventListener('click', function () { go(index - 1); });
    if (next) next.addEventListener('click', function () { go(index + 1); });
    dots.forEach(function (dot) {
      dot.addEventListener('click', function () {
        go(parseInt(dot.getAttribute('data-index'), 10) || 0);
      });
    });

    root.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { go(index - 1); }
      else if (e.key === 'ArrowRight') { go(index + 1); }
    });

    // Hover and keyboard focus both pause, because a person reading the slide
    // or tabbing through its buttons should not have it move under them.
    root.addEventListener('mouseenter', pause);
    root.addEventListener('mouseleave', start);
    root.addEventListener('focusin', pause);
    root.addEventListener('focusout', function (e) {
      if (!root.contains(e.relatedTarget)) start();
    });

    // A rotating hero in a background tab is wasted work.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) pause(); else start();
    });

    show(0, false);
    start();

    // Shopify's theme editor tears sections down and rebuilds them.
    document.addEventListener('shopify:section:unload', function (e) {
      if (e.target.contains(root)) pause();
    });
  }

  function init() {
    Array.prototype.forEach.call(document.querySelectorAll(SECTION), setup);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  document.addEventListener('shopify:section:load', init);
})();
