/* Lighter mode for slower TVs. Watches how long the main thread stays busy right after a key
 * press; when the TV keeps lagging, it drops the costliest effects (trailer previews, the tile
 * grow animation and slide, full-HD tile art) so moving around stays responsive.
 * Settings → Performance: Auto (default), Full effects, or Lighter. */
(function (g) {
  'use strict';

  var AUTO_DAYS = 7;          // an automatic switch is re-evaluated after a week
  var SLOW_MS = 120;          // a key press followed by a task this long felt slow
  var WINDOW = 20;            // judge the last 20 key presses…
  var LIMIT = 6;              // …lite when 6 of them were slow

  function mode() { return U.store.get('perfMode', 'auto'); }
  function autoLite() {
    var a = U.store.get('perfAutoLite', null);
    return !!(a && Date.now() - a.t < AUTO_DAYS * 864e5);
  }
  function apply() {
    var m = mode();
    var on = m === 'lite' || (m === 'auto' && autoLite());
    document.body.classList.toggle('lite', on);
    return on;
  }

  // ---- automatic detection ----
  var presses = [];           // [{ at, slow }]
  var bootAt = performance.now();
  function watch() {
    if (typeof PerformanceObserver === 'undefined') return;
    document.addEventListener('keydown', function () {
      if (performance.now() - bootAt < 15000) return;    // startup work isn't the remote's fault
      presses.push({ at: performance.now(), slow: false });
      if (presses.length > WINDOW) presses.shift();
    }, true);
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (en) {
          if (en.duration < SLOW_MS) return;
          // Attribute the task to a key press that happened just before it.
          for (var i = presses.length - 1; i >= 0; i--) {
            var p = presses[i];
            if (en.startTime >= p.at - 5 && en.startTime - p.at < 400) { p.slow = true; break; }
          }
        });
        check();
      }).observe({ entryTypes: ['longtask'] });
    } catch (e) {}
  }

  function check() {
    if (mode() !== 'auto' || document.body.classList.contains('lite') || presses.length < 10) return;
    var slow = presses.filter(function (p) { return p.slow; }).length;
    if (slow < LIMIT) return;
    console.warn('perf: ' + slow + ' of the last ' + presses.length + ' key presses were slow, switching to lighter mode');
    U.store.set('perfAutoLite', { t: Date.now(), slow: slow });
    apply();
    if (g.Trailer) Trailer.stop();
    if (g.UI) UI.toast('Switched to lighter effects to keep this TV responsive · Settings → Performance', 5000);
  }

  g.Perf = {
    mode: mode,
    get lite() { return document.body.classList.contains('lite'); },
    get autoSwitched() { return mode() === 'auto' && autoLite(); },
    setMode: function (m) {
      U.store.set('perfMode', m);
      if (m !== 'auto') U.store.del('perfAutoLite');
      presses = [];
      apply();
      if (g.Trailer && document.body.classList.contains('lite')) Trailer.stop();
    }
  };

  if (document.body) apply();
  else document.addEventListener('DOMContentLoaded', apply);
  watch();
})(window);
