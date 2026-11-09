/**
 * Hero photography crossfade.
 *
 * The copy is stationary and lives outside this entirely — this file only
 * decides which photograph is visible. CSS owns the fade.
 *
 * THINGS WORTH KNOWING BEFORE EDITING:
 *
 * 1. Nothing is announced. No text changes when the photograph does, so a
 *    live region would make a screen reader narrate a purely visual event.
 *    The dots are labelled instead, which is where the control actually is.
 *
 * 2. Under prefers-reduced-motion the rotation never starts. The dots still
 *    work, so every photograph remains reachable — that is why they exist
 *    rather than being decoration.
 *
 * 3. Autoplay stops for good once a person picks a dot. They chose that
 *    picture; moving it on would be arguing with them.
 */
(function () {
  'use strict';

  var SECTION = '[data-carat-hslider]';

  function reducedMotion() {
    return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  }

  function setup(root) {
    var shots = Array.prototype.slice.call(root.querySelectorAll('[data-carat-hshot]'));
    if (shots.length < 2) return;

    var dots = Array.prototype.slice.call(root.querySelectorAll('[data-carat-hslider-dot]'));

    var index = 0;
    var timer = null;
    var interval = parseInt(root.getAttribute('data-interval'), 10);
    if (isNaN(interval) || interval < 3000) interval = 6000;
    var autoplayWanted = root.getAttribute('data-autoplay') === 'true' && !reducedMotion();
    var stoppedByUser = false;

    function show(n) {
      index = (n + shots.length) % shots.length;

      shots.forEach(function (shot, i) {
        var active = i === index;
        shot.classList.toggle('is-active', active);
        if (active) {
          shot.removeAttribute('aria-hidden');
        } else {
          shot.setAttribute('aria-hidden', 'true');
        }
      });

      dots.forEach(function (dot, i) {
        var active = i === index;
        dot.classList.toggle('is-active', active);
        dot.setAttribute('aria-pressed', active ? 'true' : 'false');
      });
    }

    function start() {
      if (!autoplayWanted || stoppedByUser || timer) return;
      timer = window.setInterval(function () { show(index + 1); }, interval);
    }

    function pause() {
      if (timer) { window.clearInterval(timer); timer = null; }
    }

    dots.forEach(function (dot) {
      dot.addEventListener('click', function () {
        stoppedByUser = true;
        pause();
        show(parseInt(dot.getAttribute('data-index'), 10) || 0);
      });
    });

    // NO HOVER PAUSE. There used to be one, and it was a real bug: this hero
    // is full-bleed at the top of the page, so a cursor resting anywhere near
    // the middle of the window is ON it. Autoplay paused on mouseenter and
    // only resumed on mouseleave, which meant someone who loaded the page and
    // did not move their mouse saw a slideshow that never moved. Measured:
    // with the cursor parked over the hero, one slide in sixteen seconds;
    // moved away, three.
    //
    // Hovering is not interacting with the slideshow anyway. Choosing a dot
    // is, and that still stops it for good.

    // Keyboard focus IS an interaction: someone tabbing to the dots is about
    // to choose, and moving the picture under them would be rude.
    if (dots.length > 0) {
      var dotsWrap = dots[0].parentNode;
      dotsWrap.addEventListener('focusin', pause);
      dotsWrap.addEventListener('focusout', start);
    }

    // A hidden tab is wasted work, and resuming on return is invisible to the
    // reader either way.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) pause(); else start();
    });

    show(0);
    start();

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
