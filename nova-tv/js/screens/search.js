/* Search: remote-friendly letter grid + results across all catalog addons.
 * Typing on a remote is slow, so every letter counts: from the first letter, titles Nova already
 * knows (popular, your library, past picks) match instantly while the addons are asked;
 * suggestion chips complete the query in one press, and recent searches wait when it's empty. */
(function (g) {
  'use strict';
  var h = U.h;

  var KEYS = 'abcdefghijklmnopqrstuvwxyz1234567890'.split('');
  var RECENT_MAX = 8;

  function recent() { return U.store.get('recentSearches', []); }
  function remember(q) {
    q = (q || '').trim().toLowerCase();
    if (q.length < 2) return;
    var list = recent().filter(function (x) { return x !== q; });
    list.unshift(q);
    U.store.set('recentSearches', list.slice(0, RECENT_MAX));
  }

  function create() {
    var query = '';
    var qEl = h('div', { class: 'q' }, '');
    var hint = h('div', { class: 'q-hint' }, 'Search movies & series');
    var kb = h('div', { class: 'kb' });
    var grid = h('div', { class: 'grid', 'data-vscroll': 'visible', 'data-margin': '140' });
    var label = h('h2', { class: 'row-title' }, 'Popular searches');
    var chipTrack = h('div', { class: 'track' });
    var chips = h('div', { class: 'row q-chips', 'data-row': true, 'data-row-scroll': 'visible' }, chipTrack);
    var right = h('div', { class: 'search-right' }, [label, chips, h('div', { class: 'grid-viewport' }, grid)]);
    var seq = 0;
    var pool = [];           // titles known locally: popular + library + past picks
    var popular = [];

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

    // ---- local pool ----
    function buildPool() {
      var seen = {}, out = [];
      function add(m) { if (m && m.id && m.name && !seen[m.id]) { seen[m.id] = 1; out.push(m); } }
      (U.store.get('searchPicks', []) || []).forEach(add);
      (Library.items || []).forEach(function (it) {
        if (it.removed && !it.state) return;
        add({ id: it._id, type: it.type, name: it.name, poster: it.poster, pop: 5 });
      });
      popular.forEach(add);
      pool = out;
    }

    function pick(m) {
      remember(query);
      var picks = (U.store.get('searchPicks', []) || []).filter(function (x) { return x.id !== m.id; });
      picks.unshift({ id: m.id, type: m.type, name: m.name, poster: m.poster, pop: m.pop || 0 });
      U.store.set('searchPicks', picks.slice(0, 30));
      App.openDetail(m);
    }

    // ---- chips: recent searches (empty query) or completions (typing) ----
    function setChips(list, kind) {
      chipTrack.innerHTML = '';
      chipTrack._x = 0; chipTrack.style.transform = '';
      chips._idx = 0;
      right.classList.toggle('has-chips', list.length > 0);
      list.forEach(function (text) {
        var c = h('div', { class: 'q-chip' + (kind === 'recent' ? ' recent' : ''), 'data-f': true }, text);
        c._onSelect = function () { query = text; update(true); };
        chipTrack.appendChild(c);
      });
    }

    function completions(q, items) {
      var nq = q.toLowerCase(), out = [], seen = {};
      items.forEach(function (m) {
        var n = (m.name || '').toLowerCase();
        if (out.length >= 5 || seen[n] || n === nq) return;
        // Only offer what really completes the typed text, at a word start.
        if (n.indexOf(nq) === 0 || n.indexOf(' ' + nq) !== -1) { seen[n] = 1; out.push(m.name); }
      });
      return out;
    }

    var remoteRun = U.debounce(function (my, q) {
      Addons.search(q, function (partial) {
        if (my !== seq || !partial.length) return;
        label.textContent = 'Results for “' + q + '”';
        fill(merge(q, partial).slice(0, 40), true);
      }).then(function (res) {
        if (my !== seq) return;
        var all = merge(q, res);
        label.textContent = all.length ? 'Results for “' + q + '”' : 'No matches for “' + q + '”';
        setChips(completions(q, all), 'complete');
        if (!grid.children.length || !res.length) fill(all.slice(0, 40));
        else fill(all.slice(0, 40), true);
      }).catch(function (e) { console.warn('search', e); });
    }, 380);

    // Local matches first only when the addons found nothing better for them.
    function merge(q, remote) {
      var ids = {};
      remote.forEach(function (m) { ids[m.id] = 1; });
      var local = Addons.rankLocal(pool, q).filter(function (m) { return !ids[m.id]; }).slice(0, 8);
      return Addons.rankLocal(remote.concat(local), q).concat(remote.filter(function (m) { return !Addons.rankLocal([m], q).length; }));
    }

    function update(fromChip) {
      qEl.textContent = query;
      hint.style.display = query ? 'none' : '';
      var my = ++seq;
      var q = query.trim();
      if (!q) { showDefault(); return; }
      // Instant: what we already know.
      var local = Addons.rankLocal(pool, q);
      label.textContent = (q.length < 2 ? 'Top matches for “' : 'Searching for “') + q + (q.length < 2 ? '”' : '”…');
      setChips(completions(q, local), 'complete');
      if (local.length) fill(local.slice(0, 40));
      else if (q.length < 2) fill([]);
      if (q.length >= 2) remoteRun(my, q);
      if (fromChip) remember(q);
    }

    // keep: an update while the viewer may be browsing results; keeps their focus in place.
    function fill(items, keep) {
      var focusId = keep && Nav.focused && grid.contains(Nav.focused) && Nav.focused._item ? Nav.focused._item.id : null;
      if (keep && Nav.focused && grid.contains(Nav.focused) && !focusId) return;
      grid.innerHTML = '';
      grid._y = 0; grid.style.transform = '';
      if (!items.length) {
        if (query.trim().length >= 2) grid.appendChild(h('div', { class: 'empty' }, 'Searching your addons…'));
        return;
      }
      items.forEach(function (m) {
        var c = UI.posterCard(m);
        c._onSelect = function () { pick(m); };
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
      setChips(recent(), 'recent');
      var mix = [];
      for (var i = 0; i < 15; i++) {
        var s = popular.filter(function (m) { return m.type === 'series'; })[i], mv = popular.filter(function (m) { return m.type === 'movie'; })[i];
        if (s) mix.push(s); if (mv) mix.push(mv);
      }
      if (mix.length) fill(mix);
    }

    function loadPopular() {
      var cm = Addons.cinemeta();
      buildPool();
      return Promise.all([Addons.catalog(cm, 'movie', 'top'), Addons.catalog(cm, 'series', 'top')]).then(function (r) {
        popular = r[0].concat(r[1]);
        buildPool();
        if (!query.trim()) showDefault();
      }).catch(function () {});
    }

    var el = h('div', { class: 'screen search' }, [
      h('div', { class: 'search-left' }, [h('div', { class: 'q-box' }, [qEl, hint]), kb]),
      right
    ]);

    var shown = false;
    return {
      el: el, hero: false,
      show: function () { if (!shown) { shown = true; loadPopular(); showDefault(); } else buildPool(); },
      initialFocus: function () { return kb.children[2]; },
      onBack: function () {
        if (query) { query = query.slice(0, -1); update(); return true; }
        return false;
      }
    };
  }

  g.Search = { create: create };
})(window);
