/* Shared UI building blocks: cards, rows, hero billboard, lazy images, menus, toasts. */
(function (g) {
  'use strict';
  var h = U.h;

  var BLANK = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';

  // ---------- lazy images ----------
  function setImg(img) {
    var src = img.getAttribute('data-src');
    if (!src || img._loaded === src) return;
    img._loaded = src;
    img.onload = function () { img.classList.add('in'); };
    img.onerror = function () {
      var fb = img.getAttribute('data-fallback');
      if (fb && img.src !== fb) { img.src = fb; return; }
      img.classList.add('in', 'broken');
    };
    img.decoding = 'async';
    img.src = src;
  }
  function unsetImg(img) {
    if (!img._loaded) return;
    img._loaded = null;
    img.classList.remove('in');
    img.src = BLANK;
  }

  // ---------- deferred work while a key is held ----------
  // Holding an arrow sweeps past dozens of cards; loading each one's art (and details) on the
  // way only competes with where the viewer lands. Such work waits for the key to be released.
  var settleQueue = {};
  function fast() { return document.body.classList.contains('fast'); }
  function whenSettled(key, fn) {
    if (!fast()) { fn(); return; }
    settleQueue[key] = fn;
  }
  document.addEventListener('nav:settle', function () {
    var q = settleQueue; settleQueue = {};
    Object.keys(q).forEach(function (k) { q[k](); });
  });
  var rowSeq = 0;

  function lazyRow(row, center, span) {
    if (!row) return;
    if (fast()) { var k = row._lazyKey || (row._lazyKey = 'row' + (++rowSeq)); settleQueue[k] = function () { lazyRow(row, row._idx != null ? row._idx : center, span); }; return; }
    var cards = row.querySelector('.track').children;
    var from = Math.max(0, center - 2), to = center + (span || 9);
    for (var i = 0; i < cards.length; i++) {
      var imgs = cards[i]._imgs || (cards[i]._imgs = cards[i].querySelectorAll('img[data-src]'));
      for (var j = 0; j < imgs.length; j++) { if (i >= from && i <= to) setImg(imgs[j]); }
    }
  }
  function unloadRow(row) {
    if (!row) return;
    var imgs = row.querySelectorAll('img[data-src]');
    for (var i = 0; i < imgs.length; i++) unsetImg(imgs[i]);
    var cards = row.querySelector('.track').children;
    for (var j = 0; j < cards.length; j++) releaseWide(cards[j], true);
  }

  // A tile's wide art is only visible while it is expanded. Collapsing drops the full-HD
  // version (~8 MB decoded); rows far from focus also drop the small one. Re-expanding loads
  // them again (from the HTTP cache).
  function releaseWide(card, all) {
    if (!card._wide) return;
    var hds = card._wide.querySelectorAll('.tile-wide-img.hd');
    for (var i = 0; i < hds.length; i++) { hds[i].src = BLANK; hds[i].remove(); }
    var it = card._item;
    card._hd = it.bgLarge && it.bgLarge !== it.bg ? it.bgLarge : null;
    if (all && card._wideImg && card._wideImg._src) {
      card._wideImg._src = null;
      card._wideImg.classList.remove('in');
      card._wideImg.src = BLANK;
      card.classList.remove('wide-ready');
    }
  }

  function loadWide(card) {
    var img = card._wideImg, it = card._item;
    if (!img || img._src) return;
    img._src = it.bg || it.poster;
    img.src = img._src;
  }

  // ---------- cards ----------
  function epLabel(videoId) {
    var m = /:(\d+):(\d+)$/.exec(videoId || '');
    return m ? 'S' + m[1] + ':E' + m[2] : '';
  }

  function landscapeCard(item, opts) {
    opts = opts || {};
    var bar = null;
    if (opts.progress != null) bar = h('div', { class: 'card-progress' }, h('i', { style: { width: Math.max(3, Math.min(100, opts.progress * 100)) + '%' } }));
    var card = h('div', { class: 'card land', 'data-f': true }, [
      h('div', { class: 'card-img' }, [
        h('img', { 'data-src': item.bg || item.poster, 'data-fallback': item.poster || '', alt: '' }),
        h('div', { class: 'card-shade' }),
        h('div', { class: 'card-title' }, item.name),
        opts.sub ? h('div', { class: 'card-sub' }, opts.sub) : null,
        bar
      ])
    ]);
    card._item = item;
    return card;
  }

  function top10Card(item, rank) {
    var card = h('div', { class: 'card top10', 'data-f': true }, [
      h('div', { class: 'rank' }, String(rank)),
      h('div', { class: 'card-img poster' }, [h('img', { 'data-src': item.poster, alt: '' })])
    ]);
    card._item = item;
    return card;
  }

  function posterCard(item) {
    var card = h('div', { class: 'card poster', 'data-f': true }, [
      h('div', { class: 'card-img' }, [
        h('img', { 'data-src': item.poster, alt: '' }),
        h('div', { class: 'poster-fallback' }, item.name)
      ])
    ]);
    card._item = item;
    return card;
  }

  // Library item (continue watching) -> card. Library items are not lite metas, adapt.
  function libToLite(it) {
    var id = it._id;
    var isImdb = /^tt\d+/.test(id);
    var cached = (U.store.get('lite', {}) || {})[id];
    if (cached) return cached;
    return {
      id: id, type: it.type, name: it.name, poster: g.LiteSized(it.poster, 342),
      bg: isImdb ? 'https://images.metahub.space/background/small/' + id + '/img' : g.LiteSized(it.poster, 780),
      bgLarge: isImdb ? 'https://images.metahub.space/background/medium/' + id + '/img' : g.LiteSized(it.poster, 1280),
      logo: isImdb ? 'https://images.metahub.space/logo/medium/' + id + '/img' : '',
      genres: [], year: '', rating: 0, desc: '', cast: [], director: [], pop: 0
    };
  }

  function continueCard(it) {
    var lite = libToLite(it);
    var s = it.state || {};
    var isNextUp = s.timeOffset <= 1000 && s.video_id;
    var prog = s.duration ? s.timeOffset / s.duration : null;
    var sub = it.type === 'series' && s.video_id ? (isNextUp ? 'Next: ' : '') + epLabel(s.video_id) : (s.duration ? U.fmtLeft((s.duration - s.timeOffset) / 1000) + ' left' : '');
    var card = landscapeCard(lite, { progress: isNextUp ? null : prog, sub: sub });
    card._lib = it;
    card.classList.add('cw');
    return card;
  }

  // Cards are built in batches: a row starts with BATCH cards and grows as you approach its
  // end, so boot builds ~1/3 of the DOM it otherwise would.
  var BATCH = 10;
  function row(spec, items, onSelect, onFocusItem) {
    var track = h('div', { class: 'track' });
    var kind = spec.kind || 'landscape';
    var built = 0;
    function grow(n) {
      var frag = document.createDocumentFragment();
      var end = Math.min(items.length, built + n);
      for (var i = built; i < end; i++) {
        var it = items[i];
        var c = kind === 'top10' ? top10Card(it, i + 1) : kind === 'continue' ? continueCard(it) : kind === 'poster' ? posterCard(it) : landscapeCard(it);
        (function (c) {
          c._onSelect = function () { onSelect(c._item, c); };
          c._onFocus = function () { if (onFocusItem) onFocusItem(c._item, c); };
        })(c);
        frag.appendChild(c);
      }
      built = end;
      track.appendChild(frag);
    }
    if (!spec.deferred) grow(BATCH);
    var r = h('div', { class: 'row', 'data-row': true, 'data-row-scroll': 'anchor' }, track);
    r._onScroll = function (idx) {
      if (idx > built - 5 && built < items.length) grow(BATCH);
      lazyRow(r, idx);
    };
    var wrap = h('section', { class: 'row-wrap kind-' + kind, 'data-key': spec.key }, [
      h('h2', { class: 'row-title' }, spec.title),
      r
    ]);
    wrap._row = r;
    // Deferred rows are placeholders (fixed height, no cards) until focus comes near.
    wrap._materialize = function () { if (!built) grow(BATCH); };
    return wrap;
  }

  // ---------- Netflix-style tiles ----------
  // At rest a tile is tall boxart. When focused it expands in place to wide art with the title
  // logo, a kicker and callout badges; details appear under the row. The expansion is an
  // instant width change plus a clip reveal, and neighbours slide via FLIP transforms, so no
  // frame ever needs layout.
  var ranks = Object.create(null); // id -> { n, type } from Top 10
  function setRanks(list) {
    ranks = Object.create(null);
    var per = { movie: 0, series: 0 };
    list.forEach(function (m) { if (per[m.type] != null && per[m.type] < 10) ranks[m.id] = { n: ++per[m.type], type: m.type }; });
  }

  function badgesFor(item) {
    var out = [];
    if (item.svc) out.push({ kind: 'svc', icon: '▶', text: item.svc });
    if (item.soonKind) out.push({ kind: 'soon', icon: '◷', text: item.soonKind });
    else if (item.newKind) out.push({ kind: 'new', icon: '+', text: item.newKind });
    var r = ranks[item.id];
    if (r) out.push({ kind: 'top', icon: 'TOP', text: '#' + r.n + ' in ' + (r.type === 'series' ? 'Shows' : 'Movies') });
    if (item.awards) out.push({ kind: 'award', icon: '★', text: item.awards });
    if (item.released && item.type === 'movie' && !item.soonKind && !item.newKind) {
      var age = (Date.now() - Date.parse(item.released)) / 864e5;
      if (age >= 0 && age < 120) out.push({ kind: 'new', icon: '+', text: 'Recently Added' });
    }
    if (item.type === 'series' && /\d{4}–$/.test(String(item.year)) && out.length < 2 && (item.pop || 0) > 8) out.push({ kind: 'new', icon: '●', text: 'New Episodes' });
    return out.slice(0, 2);
  }

  function infoLine(item, extra) {
    var parts = [];
    if (extra) parts.push(extra);
    if (item.genres && item.genres[0]) parts.push(item.genres[0]);
    if (item.year) parts.push(String(item.year));
    if (item.runtime && item.type === 'movie') parts.push(item.runtime.replace(' min', 'm'));
    if (item.rating) parts.push('IMDb ' + item.rating.toFixed(1));
    return parts.join('  ·  ');
  }

  function tileCard(item, opts) {
    opts = opts || {};
    var art = h('div', { class: 'tile-art' }, [
      h('div', { class: 'tile-fallback' }, item.name),
      h('img', { class: 'tile-poster', 'data-src': item.poster, alt: '' }),
      opts.rank ? h('div', { class: 'tile-rank' }, String(opts.rank)) : null,
      opts.sub ? h('div', { class: 'tile-sub' }, opts.sub) : null,
      opts.progress != null ? h('div', { class: 'tile-progress' }, h('i', { style: { transform: 'scaleX(' + Math.max(0.03, Math.min(1, opts.progress)) + ')' } })) : null
    ]);
    var card = h('div', { class: 'card tile', 'data-f': true }, art);
    card._item = item;
    card._opts = opts;
    return card;
  }

  // The wide layer is only built the first time a tile is focused.
  function ensureWide(card) {
    if (card._wide) { whenSettled('wide', function () { if (card.classList.contains('expanded')) loadWide(card); }); return card._wide; }
    var it = card._item;
    var kicker = card._opts.kicker || (it.type === 'series' ? 'SERIES' : it.type === 'movie' ? 'FILM' : '');
    var img = h('img', { class: 'tile-wide-img', alt: '' });
    var logo = h('img', { class: 'tile-logo', alt: '' });
    var title = h('div', { class: 'tile-title hide' }, it.name);
    var badges = badgesFor(it);
    var wide = h('div', { class: 'tile-wide' }, [
      img,
      h('div', { class: 'tile-wide-shade' }),
      h('div', { class: 'tile-brand' }, [
        kicker ? h('div', { class: 'tile-kicker' }, [h('span', { class: 'k-mark' }), kicker]) : null,
        logo, title
      ]),
      badges.length ? h('div', { class: 'tile-badges' }, badges.map(function (b) {
        return h('span', { class: 'badge' }, [h('i', { class: 'b-ic b-' + b.kind }, b.icon), b.text]);
      })) : null
    ]);
    img.decoding = 'async';
    img.onload = function () {
      if (!img._src) return;
      var show = function () { if (img._src) { img.classList.add('in'); card.classList.add('wide-ready'); } };
      if (img.decode) img.decode().then(show, show); else show();
    };
    // Sharper art once the tile has been in focus for a moment.
    card._hd = it.bgLarge && it.bgLarge !== it.bg ? it.bgLarge : null;
    if (it.logo) {
      logo.onload = function () { logo.classList.add('in'); };
      logo.onerror = function () { logo.remove(); title.classList.remove('hide'); };
      logo.src = it.logo;
    } else { logo.remove(); title.classList.remove('hide'); }
    card.querySelector('.tile-art').appendChild(wide);
    card._wide = wide;
    card._wideImg = img;
    whenSettled('wide', function () { if (card.classList.contains('expanded')) loadWide(card); });
    return wide;
  }

  function warmWide(card) {
    if (!card || !card._item || card._warm || fast()) return;
    card._warm = true;
    var im = new Image();
    im.decoding = 'async';
    im.src = card._item.bg || card._item.poster;
    if (im.decode) im.decode().catch(function () {});
  }


  function tileRow(spec, items, onSelect, onFocusItem) {
    var track = h('div', { class: 'track' });
    var kind = spec.kind || 'tile';
    var built = 0;
    var info = h('div', { class: 'row-info' }, [h('div', { class: 'ri-meta' }), h('div', { class: 'ri-desc' }), h('div', { class: 'ri-hint' }, 'Hold OK to rate')]);
    function grow(n) {
      var frag = document.createDocumentFragment();
      var end = Math.min(items.length, built + n);
      for (var i = built; i < end; i++) {
        var it = items[i], c;
        if (kind === 'continue') {
          var lite = libToLite(it), s = it.state || {};
          var nextUp = s.timeOffset <= 1000 && s.video_id;
          var ep = it.type === 'series' && s.video_id ? epLabel(s.video_id) : '';
          c = tileCard(lite, {
            progress: nextUp ? null : (s.duration ? s.timeOffset / s.duration : null),
            sub: ep ? (nextUp ? 'Next · ' : '') + ep : (s.duration ? U.fmtLeft((s.duration - s.timeOffset) / 1000) + ' left' : ''),
            kicker: ep ? (nextUp ? 'UP NEXT · ' : 'CONTINUE · ') + ep : 'CONTINUE',
            extra: ep || (s.duration ? U.fmtLeft((s.duration - s.timeOffset) / 1000) + ' left' : '')
          });
          c._lib = it;
        } else {
          c = tileCard(it, { rank: kind === 'top10' ? i + 1 : 0, sub: it.sub });
        }
        (function (c) {
          c._onSelect = function () { onSelect(c._item, c); };
          c._onFocus = function () { if (onFocusItem) onFocusItem(c._item, c); };
          c._onLongPress = function () {
            rateInline(c, function () { if (r._expanded === c) fillInfo(c); });
          };
        })(c);
        frag.appendChild(c);
      }
      built = end;
      track.appendChild(frag);
    }
    var RATED = { '-1': 'Not for you', '1': 'You liked this', '2': 'You loved this' };
    function fillInfo(card) {
      var it = card._item, rr = Ratings.get(it.id);
      info.firstChild.textContent = (rr ? RATED[rr] + '  ·  ' : '') + infoLine(it, card._opts.extra);
      info.children[1].textContent = it.desc || '';
    }
    if (!spec.deferred) grow(BATCH);
    var r = h('div', { class: 'row tiles', 'data-row': true, 'data-row-scroll': 'anchor' }, track);
    var wrap = h('section', { class: 'row-wrap tile-row kind-' + kind, 'data-key': spec.key }, [
      h('h2', { class: 'row-title' }, spec.title), r, info
    ]);
    var hdTimer = null;

    r._onScroll = function (idx) {
      if (idx > built - 5 && built < items.length) grow(BATCH);
      lazyRow(r, idx, 5);
    };

    // Called by the focus engine before it scrolls the row (card = null collapses the row).
    r._expand = function (card) {
      var prev = r._expanded;
      if (prev === card) return;
      var kids = track.children;
      var animate = !!(card && prev) && !document.body.classList.contains('fast') && !document.body.classList.contains('lite');
      var lo = 0, hi = -1, before = null, i;
      if (animate) {
        var a = Array.prototype.indexOf.call(kids, prev), b = Array.prototype.indexOf.call(kids, card);
        lo = Math.max(0, Math.min(a, b) - 1); hi = Math.min(kids.length - 1, Math.max(a, b) + 5);
        before = [];
        for (i = lo; i <= hi; i++) before.push(kids[i].offsetLeft);
      }
      if (prev) { prev.classList.remove('expanded'); releaseWide(prev, false); }
      clearTimeout(hdTimer);
      r._expanded = card;
      wrap.classList.toggle('active', !!card);
      if (!card) return;
      card.classList.add('expanded');
      ensureWide(card);
      var ci = Array.prototype.indexOf.call(kids, card);
      for (i = 0; i < kids.length; i++) kids[i].classList.toggle('gone', i < ci);
      if (before) {
        for (i = lo; i <= hi; i++) {
          var dx = before[i - lo] - kids[i].offsetLeft;
          if (dx) { kids[i].style.transition = 'none'; kids[i].style.transform = 'translate3d(' + dx + 'px,0,0)'; }
        }
        void track.offsetWidth;
        for (i = lo; i <= hi; i++) if (kids[i].style.transform) { kids[i].style.transition = ''; kids[i].style.transform = ''; }
      }
      var it = card._item;
      fillInfo(card);
      whenSettled('enrich', function () {
        if (r._expanded !== card || it.desc || !/^tt/.test(it.id) || it._enriching) return;
        it._enriching = true;
        Addons.meta(it.type, it.id).then(function (m) {
          var l = Addons.lite(m);
          if (!l) return;
          Object.keys(l).forEach(function (k) { if (!it[k] || (Array.isArray(it[k]) && !it[k].length)) it[k] = l[k]; });
          if (r._expanded === card) fillInfo(card);
        }).catch(function () {});
      });
      warmWide(kids[ci + 1]); warmWide(kids[ci - 1]);
      if (document.body.classList.contains('lite')) return; // lite mode: no full-HD upgrade
      hdTimer = setTimeout(function () {
        if (r._expanded !== card || !card._hd) return;
        var hd = new Image();
        hd.decoding = 'async';
        hd.className = 'tile-wide-img hd';
        hd.onload = function () {
          var show = function () { hd.classList.add('in'); };
          if (hd.decode) hd.decode().then(show, show); else show();
        };
        if (card._wideImg && card._wideImg.parentNode) card._wideImg.parentNode.insertBefore(hd, card._wideImg.nextSibling);
        hd.src = card._hd;
        card._hd = null;
      }, 600);
    };

    wrap._row = r;
    wrap._materialize = function () { if (!built) grow(BATCH); };
    return wrap;
  }

  // ---------- billboard (featured title at the top of a page) ----------
  function billboard(item, actions) {
    var badges = badgesFor(item);
    var logo = h('img', { class: 'bb-logo', alt: '' });
    var title = h('div', { class: 'bb-title hide' }, item.name);
    if (item.logo) { logo.onerror = function () { logo.remove(); title.classList.remove('hide'); }; logo.src = item.logo; }
    else { logo.remove(); title.classList.remove('hide'); }
    var img = h('img', { class: 'bb-img', alt: '' });
    img.decoding = 'async';
    img.onload = function () { img.classList.add('in'); };
    img.src = item.bgLarge || item.bg || '';
    var btns = actions.map(function (a, i) {
      var b = h('div', { class: 'bb-btn' + (i === 0 ? ' primary' : ''), 'data-f': true }, [h('span', { class: 'ic' }, a.icon), a.label]);
      b._onSelect = a.onSelect;
      return b;
    });
    var actionsRow = h('div', { class: 'row bb-actions', 'data-row': true, 'data-row-scroll': 'visible' }, h('div', { class: 'track' }, btns));
    var kicker = item.type === 'series' ? 'SERIES' : item.type === 'movie' ? 'FILM' : '';
    var meta = [item.type === 'series' ? 'Show' : 'Movie', item.genres && item.genres[0], item.year, item.rating ? 'IMDb ' + item.rating.toFixed(1) : ''].filter(Boolean).join('  ·  ');
    var wrap = h('section', { class: 'row-wrap billboard-wrap', 'data-key': 'billboard' }, h('div', { class: 'billboard' }, [
      img, h('div', { class: 'bb-shade' }),
      h('div', { class: 'bb-info' }, [
        kicker ? h('div', { class: 'tile-kicker' }, [h('span', { class: 'k-mark' }), kicker]) : null,
        h('div', { class: 'bb-logo-wrap' }, [logo, title]),
        h('div', { class: 'bb-meta' }, meta),
        h('div', { class: 'bb-desc' }, item.desc || ''),
        actionsRow
      ]),
      badges[0] ? h('div', { class: 'bb-badge' }, h('span', { class: 'badge' }, [h('i', { class: 'b-ic b-' + badges[0].kind }, badges[0].icon), badges[0].text])) : null
    ]));
    wrap._row = actionsRow;
    wrap._item = item;
    wrap._materialize = function () {};
    wrap._ids = 'bb:' + item.id;
    return wrap;
  }

  // ---------- rating popover (Not for me / I like this / Love this!) ----------
  var THUMB = 'M2 21h4V9H2v12zm22-11c0-1.1-.9-2-2-2h-6.31l.95-4.57.03-.32c0-.41-.17-.79-.44-1.06L15.17 1 8.59 7.59C8.22 7.95 8 8.45 8 9v10c0 1.1.9 2 2 2h9c.83 0 1.54-.5 1.84-1.22l3.02-7.05c.09-.23.14-.47.14-.73v-2z';
  var RATE_ICONS = {
    '-1': '<svg viewBox="0 0 24 24"><path transform="rotate(180 12 12)" d="' + THUMB + '"/></svg>',
    '1': '<svg viewBox="0 0 24 24"><path d="' + THUMB + '"/></svg>',
    '2': '<svg viewBox="0 0 30 24"><path transform="translate(7 0) scale(0.92)" opacity="0.55" d="' + THUMB + '"/><path transform="translate(0 2) scale(0.92)" d="' + THUMB + '"/></svg>'
  };
  var RATE_THANKS = { '-1': 'Got it — you’ll see fewer titles like this', '1': 'Thanks! More like this coming up', '2': 'Love it! Expect more like this' };

  function rate(item, anchor, onDone) {
    if (!item || !item.id) return;
    var host = U.$('#modal');
    host.innerHTML = '';
    host.classList.remove('hidden');
    host.classList.add('rate-host');
    var current = Ratings.get(item.id);
    var label = h('div', { class: 'rate-label' });
    var btns = [-1, 1, 2].map(function (r) {
      var b = h('div', { class: 'rate-btn' + (current === r ? ' selected' : ''), 'data-f': true, html: RATE_ICONS[r] });
      b._r = r;
      b._onFocus = function () { label.textContent = current === r ? LABEL_REMOVE(r) : Ratings.LABELS[r]; };
      b._onSelect = function () {
        var removing = current === r;
        Ratings.set(item, r);
        btns.forEach(function (x) { x.classList.toggle('selected', !removing && x === b); });
        b.classList.add('chosen');
        label.textContent = removing ? 'Rating removed' : Ratings.LABELS[r];
        setTimeout(function () {
          close();
          toast(removing ? 'Rating removed' : RATE_THANKS[r], 2600);
          if (onDone) onDone(removing ? 0 : r);
        }, 380);
      };
      return b;
    });
    var pop = h('div', { class: 'rate-pop' }, [
      h('div', { class: 'rate-title' }, item.name),
      h('div', { class: 'row rate-row', 'data-row': true, 'data-row-scroll': 'visible' }, h('div', { class: 'track' }, btns)),
      label
    ]);
    // Sit over the bottom of the title it rates (or centred when there is no anchor).
    var scale = g.NOVA_SCALE || 1;
    if (anchor && anchor.getBoundingClientRect) {
      var a = anchor.getBoundingClientRect(), s = U.$('#stage').getBoundingClientRect();
      pop.style.left = Math.round((a.left - s.left) / scale + 24) + 'px';
      pop.style.top = Math.round((a.bottom - s.top) / scale - 250) + 'px';
    } else {
      pop.classList.add('centered');
    }
    host.appendChild(pop);
    var layer;
    function close() {
      host.classList.add('hidden');
      host.classList.remove('rate-host');
      host.innerHTML = '';
      Nav.popLayer(layer);
    }
    var initial = btns.filter(function (b) { return b._r === (current || 1); })[0];
    layer = Nav.pushLayer(host, { initial: initial, onBack: close });
  }
  // Instant rating on a card: holding OK records "I like this" right away, and the three thumbs
  // appear inside the card for a moment so ◀ ▶ + OK can change it. No dimmed popup.
  function rateInline(card, onChange) {
    var item = card._item;
    var art = card.querySelector('.tile-wide') || card.querySelector('.tile-art');
    if (!item || !art) return;
    var current = Ratings.get(item.id);
    var fresh = !current;
    if (fresh) { Ratings.set(item, 1); current = 1; if (onChange) onChange(1); }
    var label = h('div', { class: 'ri-label' });
    var idle = null;
    var btns = [-1, 1, 2].map(function (r) {
      var b = h('div', { class: 'rate-btn mini' + (current === r ? ' selected' : ''), 'data-f': true, html: RATE_ICONS[r] });
      b._r = r;
      b._onFocus = function () { label.textContent = current === r ? Ratings.LABELS[r] + ' ✓' : Ratings.LABELS[r]; bump(); };
      b._onSelect = function () {
        var removing = current === r && !fresh;
        if (removing) Ratings.set(item, 0);
        else if (Ratings.get(item.id) !== r) Ratings.set(item, r);
        current = removing ? 0 : r;
        fresh = false;
        btns.forEach(function (x) { x.classList.toggle('selected', x === b && !removing); });
        b.classList.add('chosen');
        label.textContent = removing ? 'Rating removed' : Ratings.LABELS[r] + ' ✓';
        if (onChange) onChange(current);
        clearTimeout(idle);
        idle = setTimeout(close, 700);
      };
      return b;
    });
    var strip = h('div', { class: 'rate-inline' }, [
      h('div', { class: 'row rate-row', 'data-row': true, 'data-row-scroll': 'visible' }, h('div', { class: 'track' }, btns)),
      label
    ]);
    art.appendChild(strip);
    var layer;
    function bump() { clearTimeout(idle); idle = setTimeout(close, 2600); }
    function close() {
      clearTimeout(idle);
      if (!strip.parentNode) return;
      strip.classList.add('leaving');
      setTimeout(function () { if (strip.parentNode) strip.parentNode.removeChild(strip); }, 200);
      Nav.popLayer(layer);
    }
    var initial = btns.filter(function (b) { return b._r === current; })[0] || btns[1];
    layer = Nav.pushLayer(strip, { initial: initial, onBack: close, onKey: function (a) {
      // Up/down leave the strip (and keep browsing); everything else stays inside it.
      if (a === 'up' || a === 'down') { close(); return true; }
      return false;
    } });
    if (fresh) toast('Liked — hold OK and use ◀ ▶ to love or dislike', 2400);
  }

  function LABEL_REMOVE(r) { return Ratings.LABELS[r] + ' · press OK to remove'; }

  // ---------- hero billboard ----------
  var Hero = (function () {
    var el, imgs, logo, title, meta, desc, active = 0, current = null, pending = null;
    function init() {
      el = U.$('#hero');
      imgs = U.$$('.hero-img', el);
      logo = U.$('.hero-logo', el);
      title = U.$('.hero-title', el);
      meta = U.$('.hero-meta', el);
      desc = U.$('.hero-desc', el);
      logo.onerror = function () { logo.classList.add('hide'); title.classList.remove('hide'); };
      logo.onload = function () { logo.classList.remove('hide'); title.classList.add('hide'); };
    }
    function metaLine(item) {
      var parts = [];
      var m = item.match != null ? item.match : Recs.matchFor(item);
      if (m) parts.push(h('span', { class: 'match' }, m + '% Match'));
      if (item.year) parts.push(h('span', null, String(item.year).replace(/–$/, '–')));
      if (item.rating) parts.push(h('span', { class: 'imdb' }, 'IMDb ' + item.rating.toFixed(1)));
      if (item.runtime) parts.push(h('span', null, item.runtime));
      if (item.type) parts.push(h('span', { class: 'pill' }, item.type === 'series' ? 'Series' : 'Film'));
      if (item.genres && item.genres.length) parts.push(h('span', { class: 'genres' }, item.genres.slice(0, 3).join(' · ')));
      return parts;
    }
    function apply(item) {
      current = item;
      var next = imgs[1 - active];
      var src = item.bgLarge || item.bg || item.poster;
      var swap = function () {
        if (current !== item) return;
        next.classList.add('on'); imgs[active].classList.remove('on');
        active = 1 - active;
      };
      // Decode off the main thread first so the crossfade never stalls a frame.
      next.onload = function () {
        if (next.decode) next.decode().then(swap, swap); else swap();
      };
      next.onerror = function () {};
      next.decoding = 'async';
      if (next.getAttribute('src') === src) next.onload(); else next.src = src;
      title.textContent = item.name;
      logo.classList.add('hide');
      if (item.logo && logo.getAttribute('src') !== item.logo) { title.classList.add('hide'); logo.src = item.logo; }
      else if (item.logo && logo.complete && logo.naturalWidth) { logo.classList.remove('hide'); title.classList.add('hide'); }
      else { title.classList.remove('hide'); }
      meta.innerHTML = '';
      U.append(meta, metaLine(item));
      desc.textContent = item.desc || '';
      el.classList.remove('dim');
    }
    var debounced = U.debounce(function () { if (pending) apply(pending); }, 230);
    return {
      init: init,
      show: function (item, instant) {
        if (!item || item === current) return;
        pending = item;
        if (instant) apply(item); else { el.classList.add('dim'); debounced(); }
        // Fill in missing details (library items) in the background.
        if (!item.desc && /^tt/.test(item.id) && !item._enriching) {
          item._enriching = true;
          Addons.meta(item.type, item.id).then(function (m) {
            var l = Addons.lite(m);
            if (!l) return;
            Object.keys(l).forEach(function (k) { if (!item[k] || (Array.isArray(item[k]) && !item[k].length)) item[k] = l[k]; });
            if (current === item) { current = null; apply(item); }
          }).catch(function () {});
        }
      },
      hide: function (v) { el.classList.toggle('hidden', !!v); },
      metaLine: metaLine
    };
  })();

  // ---------- toast ----------
  var toastTimer;
  function toast(msg, ms) {
    var t = U.$('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.classList.remove('show'); }, ms || 3000);
  }

  // ---------- modal menu ----------
  function menu(opts) {
    var root = U.$('#modal');
    root.innerHTML = '';
    var list = h('div', { class: 'menu-list', 'data-vscroll': 'visible', 'data-margin': '60' });
    var initial = null;
    opts.items.forEach(function (it) {
      var b = h('div', { class: 'menu-item' + (it.selected ? ' selected' : ''), 'data-f': true }, [
        h('div', { class: 'menu-label' }, it.label),
        it.sub ? h('div', { class: 'menu-sub' }, it.sub) : null,
        it.selected ? h('div', { class: 'menu-check' }, '✓') : null
      ]);
      b._onSelect = function () {
        if (!it.keepOpen) close();
        if (it.onSelect) it.onSelect(it);
      };
      if (it.selected && !initial) initial = b;
      list.appendChild(b);
    });
    var panel = h('div', { class: 'menu ' + (opts.side ? 'side' : '') }, [
      h('div', { class: 'menu-title' }, opts.title || ''),
      opts.subtitle ? h('div', { class: 'menu-subtitle' }, opts.subtitle) : null,
      h('div', { class: 'menu-viewport' }, list)
    ]);
    root.appendChild(panel);
    root.classList.remove('hidden');
    var layer;
    function close() {
      root.classList.add('hidden');
      root.innerHTML = '';
      Nav.popLayer(layer);
      if (opts.onClose) opts.onClose();
    }
    layer = Nav.pushLayer(root, { initial: initial, onBack: close });
    return { close: close };
  }

  function confirm(title, sub, yesLabel, onYes) {
    menu({ title: title, subtitle: sub, items: [{ label: yesLabel, onSelect: onYes }, { label: 'Cancel' }] });
  }

  g.UI = {
    BLANK: BLANK, row: row, landscapeCard: landscapeCard, posterCard: posterCard, continueCard: continueCard,
    lazyRow: lazyRow, whenSettled: whenSettled, tileRow: tileRow, billboard: billboard, setRanks: setRanks, rate: rate, rateInline: rateInline, RATE_ICONS: RATE_ICONS, unloadRow: unloadRow, setImg: setImg, epLabel: epLabel, libToLite: libToLite,
    Hero: Hero, toast: toast, menu: menu, confirm: confirm
  };
})(window);
