/*
 * Browse screens (Home / Series / Movies): hero billboard + stacked rows.
 * Renders the last session's rows from cache instantly, then reconciles with fresh rows in
 * the background without disturbing the row you're on.
 */
(function (g) {
  'use strict';
  var h = U.h;

  var MAX_CACHE_ITEMS = 20;

  function ids(items) { return items.map(function (i) { return i._id || i.id; }).join(','); }

  function slimForCache(items) {
    return items.slice(0, MAX_CACHE_ITEMS).map(function (m) {
      var c = Object.assign({}, m);
      delete c._s; delete c._sim; delete c._rel; delete c._enriching;
      if (c.desc && c.desc.length > 220) c.desc = c.desc.slice(0, 217) + '…';
      return c;
    });
  }

  function create(key, type, opts) {
    opts = opts || {};
    var rowsEl = h('div', { class: 'rows', 'data-vscroll': 'rows' });
    var el = h('div', { class: 'screen browse' }, h('div', { class: 'rows-viewport' }, rowsEl));
    var built = false;
    var loading = false;
    var cacheKey = 'home.' + key;

    function onSelect(item, card) {
      if (card._lib) App.resume(card._lib);
      else App.openDetail(item);
    }
    // Resting on a card for a moment prefetches what OK will need: details for any title,
    // and for Continue Watching also the stream (resolved + warmed) so playback starts at once.
    var dwell = null;
    function onFocusItem(item, card) {
      // Continue Watching cards preload the episode instead of playing a trailer.
      if (card._lib) Trailer.stop();
      else if (card._wide) Trailer.queue(card._wide, item, 2600);
      clearTimeout(dwell);
      // Another card chosen: drop the previous preload right away.
      if (!card._lib) Player.cancelPreload();
      var idle = window.requestIdleCallback || function (fn) { return setTimeout(fn, 0); };
      dwell = setTimeout(function () {
        if (Nav.focused !== card) return;
        idle(function () {
          if (Nav.focused !== card) return;
          if (card._lib) Player.prefetchFromLibrary(card._lib);
          else if (item.type && item.id) Addons.meta(item.type, item.id).catch(function () {});
        }, { timeout: 400 });
      }, 650);
    }

    function makeRow(spec) {
      var w;
      if (spec.kind === 'billboard') {
        var item = spec.items[0];
        w = UI.billboard(item, [
          { icon: '▶', label: 'Play', onSelect: function () { Detail.playItem(item); } },
          { icon: 'ⓘ', label: 'More Info', onSelect: function () { App.openDetail(item); } }
        ]);
      } else {
        w = UI.tileRow(Object.assign({ deferred: true }, spec, { kind: spec.kind === 'landscape' ? 'tile' : spec.kind }), spec.items, onSelect, onFocusItem);
      }
      w._ids = ids(spec.items);
      return w;
    }

    // Featured title for the billboard: the best personal pick, else what's trending.
    function withBillboard(data) {
      if (opts.noBillboard || (data[0] && data[0].kind === 'billboard')) return data;
      var top10 = data.filter(function (d) { return d.key === 'top10' && d.items; })[0];
      if (top10) UI.setRanks(top10.items);
      var svc = data.filter(function (d) { return d.key === 'new-svc'; })[0];
      var star = svc && svc.items && svc.items.slice(0, 12).filter(function (m) { return m.newKind && m.newKind !== 'New Episodes' && m.bgLarge; })
        .sort(function (a, b) { return (b.pop || 0) - (a.pop || 0); })[0];
      if (star) return [{ key: 'billboard', kind: 'billboard', items: [star] }].concat(data);
      var src = data.filter(function (d) { return d.key === 'picks' && d.items.length; })[0]
        || data.filter(function (d) { return d.kind !== 'continue' && d.items && d.items.length; })[0];
      if (!src) return data;
      return [{ key: 'billboard', kind: 'billboard', items: [src.items[0]] }].concat(data);
    }

    function lazyAround(focusWrap) {
      var wraps = Array.prototype.slice.call(rowsEl.children);
      var fi = Math.max(0, wraps.indexOf(focusWrap));
      wraps.forEach(function (w, i) {
        var d = i - fi;
        if (d >= -2 && d <= 3) w._materialize();
        // Only rows near focus get their own GPU layer; far rows drop images to save memory.
        w.classList.toggle('live', d >= -1 && d <= 2);
        if (d >= -1 && d <= 2) UI.lazyRow(w._row, w._row._idx || 0);
        else if (Math.abs(d) > 5) UI.unloadRow(w._row);
      });
    }

    function continueSpec() {
      var items = Library.continueWatching().filter(function (it) { return !type || it.type === type; });
      return { key: 'continue', title: 'Continue Watching', kind: 'continue', items: items };
    }

    /** Reconcile DOM rows with new data, keeping the row under focus untouched. */
    function reconcile(data) {
      var tR = performance.now();
      try { return reconcileInner(data); } finally { var d = performance.now() - tR; if (d > 30) console.log('perf reconcile', key, data.length + ' rows', Math.round(d) + 'ms'); }
    }
    function reconcileInner(data) {
      // "Not for me" titles vanish from every row (Continue Watching keeps what the viewer started).
      data = data.map(function (d) {
        if (d.keepExisting || d.kind === 'continue' || !d.items || d.key === 'mn-notforme') return d;
        var items = d.items.filter(function (m) { return !Ratings.isDisliked(m.id); });
        return items.length === d.items.length ? d : Object.assign({}, d, { items: items });
      });
      data = withBillboard(data);
      var focused = Nav.focused && rowsEl.contains(Nav.focused) ? Nav.focused : null;
      var focusedWrap = focused ? focused.closest('.row-wrap') : null;
      var existing = {};
      Array.prototype.forEach.call(rowsEl.children, function (w) { existing[w.getAttribute('data-key')] = w; });
      var next = [];
      data.forEach(function (d) {
        var w = existing[d.key];
        if (d.keepExisting) { if (w) { next.push(w); delete existing[d.key]; } return; }
        if (!d.items || !d.items.length) return;
        if (w && (w === focusedWrap || w._ids === ids(d.items))) { next.push(w); delete existing[d.key]; return; }
        next.push(makeRow(d));
      });
      if (focusedWrap && next.indexOf(focusedWrap) === -1) next.unshift(focusedWrap);
      next.forEach(function (w, i) {
        if (rowsEl.children[i] !== w) rowsEl.insertBefore(w, rowsEl.children[i] || null);
      });
      while (rowsEl.children.length > next.length) rowsEl.removeChild(rowsEl.lastChild);
      if (!built && data.length) console.log('first rows on screen', key, Math.round(performance.now()) + 'ms after launch');
      built = true;
      var isActive = !el.classList.contains('hidden');
      if (!focusedWrap) for (var mi = 0; mi < 4 && mi < rowsEl.children.length; mi++) rowsEl.children[mi]._materialize();
      if (focused && document.body.contains(focused)) { Nav.focus(focused, { instant: true }); lazyAround(focusedWrap); }
      else if (isActive && Nav.top() && Nav.top().el.id === 'ui' && (!Nav.focused || !document.body.contains(Nav.focused))) {
        var first = rowsEl.querySelector('[data-f]');
        if (first) Nav.focus(first, { instant: true });
        lazyAround(rowsEl.children[0]);
      } else {
        lazyAround(focusedWrap || rowsEl.children[0]);
      }
    }

    // Cache = { t, sig, rows }. sig changes when the viewer's viewing history does, which is when
    // recommendations actually need recomputing.
    var FRESH_MS = 45 * 60000;
    function librarySig() {
      var latest = '';
      Library.items.forEach(function (it) { var w = it.state && it.state.lastWatched; if (w && w > latest) latest = w; });
      return Library.items.length + '|' + latest + '|' + Addons.list.length + '|' + Ratings.sig() + '|' + Fresh.sig();
    }
    function readCache() {
      var c = U.store.get(cacheKey, null);
      if (Array.isArray(c)) c = { t: 0, sig: '', rows: c }; // older format
      return c && c.rows && c.rows.length ? c : null;
    }
    function isFresh() {
      var c = readCache();
      var ok = !!c && Date.now() - c.t < FRESH_MS && c.sig === librarySig();
      if (!ok) console.log('perf cache stale', key, JSON.stringify({ has: !!c, ageMin: c ? Math.round((Date.now() - c.t) / 60000) : null, cached: c && c.sig, now: librarySig() }));
      return ok;
    }
    function fromCache() {
      var cached = readCache();
      if (!cached) return false;
      reconcile([continueSpec()].concat(cached.rows));
      return true;
    }

    var again = false;
    function load() {
      if (loading) { again = true; return; }
      loading = true;
      again = false;
      var results = {};
      var specs = [];
      var apply = U.debounce(function () {
        var data = specs.map(function (s) {
          if (s.key === 'continue') return continueSpec();
          return results[s.key] ? { key: s.key, title: s.title, kind: s.kind, items: results[s.key] } : { key: s.key, keepExisting: true };
        }).filter(Boolean);
        reconcile(data);
      }, 120);

      (opts.provider ? opts.provider() : Recs.rows(type)).then(function (list) {
        specs = list;
        return Promise.all(list.map(function (s) {
          if (s.key === 'continue') return null;
          return s.load().then(function (items) { results[s.key] = items || []; apply(); }).catch(function () { results[s.key] = []; });
        }));
      }).then(function () {
        loading = false;
        if (again) { setTimeout(load, 300); }
        if (opts.live) return;
        var toCache = specs.filter(function (s) { return s.key !== 'continue' && results[s.key] && results[s.key].length; })
          .map(function (s) { return { key: s.key, title: s.title, kind: s.kind, items: slimForCache(results[s.key]) }; });
        U.store.set(cacheKey, { t: Date.now(), sig: librarySig(), rows: toCache });
        console.log('rows ready', key, toCache.length);
        ['new-svc', 'new-releases', 'coming-soon'].forEach(function (k) {
          var r = results[k];
          if (r) console.log('row', k, r.length, r.slice(0, 4).map(function (m) { return m.name + (m.svc ? ' [' + m.svc + ']' : '') + (m.soonKind ? ' (' + m.soonKind + ')' : ''); }).join(' | '));
        });
      }).catch(function (e) { loading = false; console.warn('home load failed', e); });
    }

    var screen = {
      el: el,
      hero: false,
      show: function () {
        if (opts.live) { load(); return; }
        if (!built) {
          if (!fromCache()) { el.classList.add('is-loading'); load(); }
          // Cached: let the first interactions run on an idle main thread, then revalidate.
          else if (!isFresh()) setTimeout(load, 2500);
        }
        var f = Nav.focused;
      },
      initialFocus: function () {
        var wrap = rowsEl.children[rowsEl._lastIdx || 0] || rowsEl.children[0];
        if (!wrap) return null;
        var cards = wrap.querySelectorAll('[data-f]');
        return cards[wrap._row._idx || 0] || cards[0];
      },
      onFocus: function (cardEl) {
        el.classList.remove('is-loading');
        var bb = cardEl.closest('.billboard');
        if (!cardEl.classList.contains('tile')) Player.cancelPreload();
        if (bb) Trailer.queue(bb, bb.parentNode._item, 3200);
        else if (!cardEl.classList.contains('tile')) Trailer.stop();
        var wrap = cardEl.closest('.row-wrap');
        if (!wrap) return;
        rowsEl._lastIdx = Array.prototype.indexOf.call(rowsEl.children, wrap);
        lazyAround(wrap);
      },
      // Back goes to the top bar (handled by the shell); the page returns to the billboard.
      scrollTop: function () {
        rowsEl._lastIdx = 0;
        rowsEl._y = 0;
        rowsEl.style.transform = '';
        Array.prototype.forEach.call(rowsEl.children, function (w) { w.classList.remove('above'); });
        if (rowsEl.children[0]) lazyAround(rowsEl.children[0]);
      },
      refresh: function () { if (!built || !isFresh()) load(); else screen.refreshContinue(); },
      refreshContinue: function () {
        // Re-render only the continue row; keep other rows as-is.
        var cw = continueSpec();
        var existing = rowsEl.querySelector('[data-key="continue"]');
        if (existing && existing._ids === ids(cw.items)) return;
        var focusedIn = existing && Nav.focused && existing.contains(Nav.focused);
        var nw = cw.items.length ? makeRow(cw) : null;
        if (nw) nw._materialize();
        if (existing && nw) rowsEl.replaceChild(nw, existing);
        else if (existing) rowsEl.removeChild(existing);
        else if (nw) rowsEl.insertBefore(nw, rowsEl.firstChild);
        if (focusedIn && nw) Nav.focus(nw.querySelector('[data-f]'), { instant: true });
        else Nav.refocus();
        if (nw) UI.lazyRow(nw._row, 0);
      }
    };
    return screen;
  }

  // My List: a grid of posters.
  function createMyList() {
    var grid = h('div', { class: 'grid', 'data-vscroll': 'visible', 'data-margin': '160' });
    var el = h('div', { class: 'screen mylist' }, [h('h1', { class: 'screen-title' }, 'My List'), h('div', { class: 'grid-viewport' }, grid)]);
    function render() {
      grid.innerHTML = '';
      var items = Library.myList();
      if (!items.length) { grid.appendChild(h('div', { class: 'empty' }, 'Add titles with “My List” on any detail page.')); return; }
      items.forEach(function (it) {
        var c = UI.posterCard(UI.libToLite(it));
        c._onSelect = function () { App.openDetail(c._item); };
        grid.appendChild(c);
        UI.setImg(c.querySelector('img'));
      });
    }
    return { el: el, hero: false, show: render, refresh: render, refreshContinue: render };
  }

  // My Nova: Netflix's "My Netflix" — everything the viewer has done, one row each.
  function myNovaRows() {
    var lite = function (it) { return UI.libToLite(it); };
    var snaps = function (list) { return list.map(function (e) { return e.lite; }).filter(Boolean); };
    var watched = Library.history().slice().sort(function (a, b) { return (b.state.lastWatched || '') > (a.state.lastWatched || '') ? 1 : -1; });
    return Promise.resolve([
      { key: 'continue', title: 'Continue Watching', kind: 'continue', load: function () { return Promise.resolve([]); } },
      { key: 'mn-list', title: 'My List', kind: 'landscape', load: function () { return Promise.resolve(Library.myList().slice(0, 40).map(lite)); } },
      { key: 'mn-reminders', title: 'Reminders', kind: 'landscape', load: function () { return Promise.resolve(Fresh.reminders().map(function (r) { return r.lite; })); } },
      { key: 'mn-loved', title: 'Titles You\u2019ve Loved & Liked', kind: 'landscape', load: function () { return Promise.resolve(snaps(Ratings.list(function (e) { return e.r > 0; }))); } },
      { key: 'mn-trailers', title: 'Trailers You\u2019ve Watched', kind: 'landscape', load: function () { return Promise.resolve(snaps(Ratings.trailersSeen())); } },
      { key: 'mn-history', title: 'Watched Recently', kind: 'landscape', load: function () { return Promise.resolve(watched.slice(0, 40).map(lite)); } },
      { key: 'mn-notforme', title: 'Rated \u201cNot for me\u201d \u2014 hold OK to change', kind: 'landscape', load: function () { return Promise.resolve(snaps(Ratings.list(function (e) { return e.r < 0; }))); } }
    ]);
  }

  g.Home = { create: create, createMyList: createMyList, myNovaRows: myNovaRows };
})(window);
