/* Search: remote-friendly letter grid + instant results across all catalog addons. */
(function (g) {
  'use strict';
  var h = U.h;

  var KEYS = 'abcdefghijklmnopqrstuvwxyz1234567890'.split('');

  function create() {
    var query = '';
    var qEl = h('div', { class: 'q' }, '');
    var hint = h('div', { class: 'q-hint' }, 'Search movies & series');
    var kb = h('div', { class: 'kb' });
    var grid = h('div', { class: 'grid', 'data-vscroll': 'visible', 'data-margin': '140' });
    var label = h('h2', { class: 'row-title' }, 'Popular searches');
    var seq = 0;

    function key(lbl, cls, fn) {
      var k = h('div', { class: 'kb-key ' + (cls || ''), 'data-f': true }, lbl);
      k._onSelect = fn;
      kb.appendChild(k);
      return k;
    }
    key('Space', 'wide', function () { type(' '); });
    key('⌫', 'wide', function () { query = query.slice(0, -1); update(); });
    KEYS.forEach(function (c) { key(c, '', function () { type(c); }); });
    key('Clear', 'full', function () { query = ''; update(); });

    function type(c) { if (query.length < 40) { query += c; update(); } }

    var run = U.debounce(function () {
      var my = ++seq;
      var q = query.trim();
      if (q.length < 2) { showDefault(); return; }
      label.textContent = 'Searching for “' + q + '”…';
      var shown = false;
      Addons.search(q, function (partial) {
        if (my !== seq || !partial.length) return;
        shown = true;
        label.textContent = 'Results for “' + q + '”';
        fill(partial.slice(0, 40), true);
      }).then(function (res) {
        if (my !== seq) return;
        label.textContent = 'Results for “' + q + '”';
        if (!shown || !res.length) fill(res.slice(0, 40));
      }).catch(function (e) { console.warn('search', e); if (my === seq) fill([]); });
    }, 380);

    function update() {
      qEl.textContent = query;
      hint.style.display = query ? 'none' : '';
      run();
    }

    // keep: an update while the viewer may be browsing results; keeps their focus in place.
    function fill(items, keep) {
      var focusId = keep && Nav.focused && grid.contains(Nav.focused) && Nav.focused._item ? Nav.focused._item.id : null;
      if (keep && Nav.focused && grid.contains(Nav.focused) && !focusId) return;
      grid.innerHTML = '';
      grid._y = 0; grid.style.transform = '';
      if (!items.length) { grid.appendChild(h('div', { class: 'empty' }, 'No matches. Try another spelling.')); return; }
      items.forEach(function (m) {
        var c = UI.posterCard(m);
        c._onSelect = function () { App.openDetail(m); };
        grid.appendChild(c);
        UI.setImg(c.querySelector('img'));
      });
      if (focusId) {
        var again = [].filter.call(grid.children, function (c) { return c._item && c._item.id === focusId; })[0] || grid.children[0];
        if (again) Nav.focus(again, { instant: true });
      }
    }

    function showDefault() {
      label.textContent = 'Popular searches';
      var cm = Addons.cinemeta();
      Promise.all([Addons.catalog(cm, 'movie', 'top'), Addons.catalog(cm, 'series', 'top')]).then(function (r) {
        var mix = [];
        for (var i = 0; i < 15; i++) { if (r[1][i]) mix.push(r[1][i]); if (r[0][i]) mix.push(r[0][i]); }
        if (!query.trim()) fill(mix);
      }).catch(function () {});
    }

    var el = h('div', { class: 'screen search' }, [
      h('div', { class: 'search-left' }, [h('div', { class: 'q-box' }, [qEl, hint]), kb]),
      h('div', { class: 'search-right' }, [label, h('div', { class: 'grid-viewport' }, grid)])
    ]);

    var shown = false;
    return {
      el: el, hero: false,
      show: function () { if (!shown) { shown = true; showDefault(); } },
      initialFocus: function () { return kb.children[2]; },
      onBack: function () {
        if (query) { query = query.slice(0, -1); update(); return true; }
        return false;
      }
    };
  }

  g.Search = { create: create };
})(window);
