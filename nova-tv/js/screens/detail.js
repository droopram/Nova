/*
 * Title detail: billboard, Play/Resume, My List, seasons + episodes, More Like This.
 * Streams for the Play target start resolving the moment the page opens, so pressing Play
 * is near-instant.
 */
(function (g) {
  'use strict';
  var h = U.h;

  var state = null; // { el, layer, item, meta, season, ... }

  function sortedVideos(meta) {
    return (meta.videos || []).slice().sort(function (a, b) {
      var sa = a.season || 0, sb = b.season || 0;
      if ((sa === 0) !== (sb === 0)) return sa === 0 ? 1 : -1;
      return sa - sb || (a.episode || a.number || 0) - (b.episode || b.number || 0);
    });
  }

  function aired(v) { return !v.released || Date.parse(v.released) <= Date.now() + 864e5; }

  function playTarget(meta) {
    if (meta.type !== 'series' || !meta.videos || !meta.videos.length) return { id: meta.videos && meta.videos.length === 1 ? meta.videos[0].id : meta.id, video: null };
    var vids = sortedVideos(meta);
    var lib = Library.get(meta.id);
    var vid = lib && lib.state && lib.state.video_id;
    var v = vid && vids.filter(function (x) { return x.id === vid; })[0];
    if (v) {
      var pr = Library.videoProgress(v.id);
      if (pr && pr.done) {
        var i = vids.indexOf(v);
        if (vids[i + 1] && aired(vids[i + 1])) v = vids[i + 1];
      }
    }
    if (!v) v = vids.filter(function (x) { return (x.season || 0) > 0 && aired(x); })[0] || vids[0];
    return { id: v.id, video: v };
  }

  function resumeInfo(meta, videoId) {
    var pr = Library.videoProgress(videoId);
    if (pr && !pr.done && pr.t > 60) return { t: pr.t, d: pr.d };
    var lib = Library.get(meta.id);
    var s = lib && lib.state;
    if (s && s.video_id === videoId && s.timeOffset > 60000 && s.duration && s.timeOffset / s.duration < 0.92) return { t: s.timeOffset / 1000, d: s.duration / 1000 };
    return null;
  }

  function seasonsOf(meta) {
    var seen = {};
    sortedVideos(meta).forEach(function (v) { seen[v.season || 0] = 1; });
    return Object.keys(seen).map(Number).sort(function (a, b) { if ((a === 0) !== (b === 0)) return a === 0 ? 1 : -1; return a - b; });
  }

  function epCard(v, meta) {
    var pr = Library.videoProgress(v.id);
    var num = v.episode || v.number || '';
    var bar = pr ? h('div', { class: 'card-progress' }, h('i', { style: { width: (pr.done ? 100 : Math.max(3, pr.t / pr.d * 100)) + '%' } })) : null;
    var card = h('div', { class: 'card ep' + (aired(v) ? '' : ' unaired'), 'data-f': true }, [
      h('div', { class: 'card-img' }, [
        h('img', { 'data-src': LiteSized((v.thumbnail || meta.background || '').replace(/\/w780\.jpg$/, '/w500.jpg'), 500), alt: '' }),
        h('div', { class: 'ep-play' }, '▶'),
        bar
      ]),
      h('div', { class: 'ep-title' }, (num ? num + '. ' : '') + (v.name || v.title || 'Episode ' + num)),
      h('div', { class: 'ep-desc' }, aired(v) ? (v.overview || v.description || '') : 'Coming ' + new Date(v.released).toLocaleDateString())
    ]);
    card._video = v;
    // Resting on an episode switches the preload to that episode.
    var epDwell = null;
    card._onFocus = function () {
      clearTimeout(epDwell);
      epDwell = setTimeout(function () {
        if (Nav.focused !== card || !aired(v) || !state) return;
        var rr = resumeInfo(state.meta, v.id);
        Player.preloadTitle(state.meta, v.id, rr ? rr.t : 0);
      }, 900);
    };
    card._onSelect = function () {
      if (!aired(v)) { UI.toast('This episode has not aired yet'); return; }
      play(v.id, v);
    };
    return card;
  }

  function play(videoId, video, opts) {
    opts = opts || {};
    var resume = opts.restart ? null : resumeInfo(state.meta, videoId);
    Player.play({ meta: state.meta, videoId: videoId, video: video, resumeAt: resume ? resume.t : 0, ranked: opts.ranked });
  }

  function renderEpisodes(season) {
    var st = state;
    st.season = season;
    var vids = sortedVideos(st.meta).filter(function (v) { return (v.season || 0) === season; });
    var track = st.epRow.querySelector('.track');
    track.innerHTML = '';
    track._x = 0; track.style.transform = '';
    st.epRow._idx = 0;
    vids.forEach(function (v) { track.appendChild(epCard(v, st.meta)); });
    var t = st.target && st.target.video && (st.target.video.season || 0) === season ? vids.indexOf(st.target.video) : 0;
    st.epRow._idx = Math.max(0, t);
    var cards = track.children;
    if (cards[st.epRow._idx]) {
      track._x = -cards[st.epRow._idx].offsetLeft;
      track.classList.add('no-anim');
      track.style.transform = 'translate3d(' + track._x + 'px,0,0)';
      void track.offsetWidth; track.classList.remove('no-anim');
    }
    UI.lazyRow(st.epRow, st.epRow._idx, 6);
    st.epRow._onScroll = function (idx) { UI.lazyRow(st.epRow, idx, 6); };
  }

  function buttons(meta) {
    var st = state;
    var target = st.target = playTarget(meta);
    var resume = resumeInfo(meta, target.id);
    var label;
    if (meta.type === 'series' && target.video) {
      var ep = UI.epLabel(target.id);
      label = (resume ? 'Resume ' : 'Play ') + ep;
    } else label = resume ? 'Resume' : 'Play';

    var items = [];
    var released = meta.released ? Date.parse(meta.released) : 0;
    var notYet = Fresh.isAvailable(meta.id) === false || (released && released > Date.now());
    if (notYet) {
      // Not watchable yet: Remind Me leads; Nova tells the viewer on launch once it is.
      var remIc = h('span', { class: 'ic' });
      var remLabel = h('span');
      var paintRem = function () {
        var on = Fresh.isReminded(meta.id);
        remIc.textContent = on ? '✓' : '🔔';
        remLabel.textContent = on ? 'Reminder set' : 'Remind Me';
      };
      paintRem();
      var remBtn = h('div', { class: 'btn primary autofocus', 'data-f': true }, [remIc, remLabel]);
      remBtn._onSelect = function () {
        var on = Fresh.toggleReminder(Addons.lite(meta));
        paintRem();
        UI.toast(on ? 'We\u2019ll let you know when ' + meta.name + ' is on Nova' : 'Reminder removed', 2400);
      };
      items.push(remBtn);
    }
    var playBtn = h('div', { class: 'btn' + (notYet ? '' : ' primary autofocus'), 'data-f': true }, [h('span', { class: 'ic' }, '▶'), notYet ? 'Try anyway' : label]);
    playBtn._onSelect = function () { play(target.id, target.video); };
    items.push(playBtn);
    if (resume) {
      var left = U.fmtLeft(resume.d - resume.t) + ' left';
      playBtn.appendChild(h('span', { class: 'btn-sub' }, left));
      var restart = h('div', { class: 'btn', 'data-f': true }, [h('span', { class: 'ic' }, '↺'), 'Start over']);
      restart._onSelect = function () { play(target.id, target.video, { restart: true }); };
      items.push(restart);
    }
    var inList = Library.inList(meta.id);
    var listBtn = h('div', { class: 'btn', 'data-f': true }, [h('span', { class: 'ic' }, inList ? '✓' : '+'), 'My List']);
    listBtn._onSelect = function () {
      var added = Library.toggleList(Addons.lite(meta));
      listBtn.querySelector('.ic').textContent = added ? '✓' : '+';
      UI.toast(added ? 'Added to My List' : 'Removed from My List', 1800);
    };
    items.push(listBtn);
    // Full-screen trailer; the button appears once we know the title has one.
    if (Trailer.available) {
      var trailerBtn = h('div', { class: 'btn trailer-btn', 'data-f': true }, [h('span', { class: 'ic' }, '\u25b7'), 'Trailer']);
      trailerBtn._onSelect = function () {
        Trailer.playFull(meta, function () {
          // Put the Play stream back in the player, as when the page opened.
          if (state !== st || Player.active) return;
          var r = resumeInfo(meta, target.id);
          Player.preloadTitle(meta, target.id, r ? r.t : 0);
        });
      };
      trailerBtn.style.display = 'none';
      Trailer.ids(meta).then(function (ids) { if (ids.length) trailerBtn.style.display = ''; });
      items.push(trailerBtn);
    }
    // Rating right in the button row: one press rates, pressing the lit thumb again clears it.
    var thumbs = [-1, 1, 2].map(function (r) {
      var b = h('div', { class: 'btn thumb', 'data-f': true, 'data-tip': Ratings.LABELS[r], html: UI.RATE_ICONS[r] });
      b._r = r;
      b._onSelect = function () {
        var clearing = Ratings.get(meta.id) === r;
        Ratings.set(Addons.lite(meta), clearing ? 0 : r);
        paint();
        b.classList.remove('pressed'); void b.offsetWidth; b.classList.add('pressed');
        UI.toast(clearing ? 'Rating removed' : Ratings.LABELS[r], 1400);
      };
      return b;
    });
    function paint() {
      var cur = Ratings.get(meta.id);
      thumbs.forEach(function (b) { b.classList.toggle('on', b._r === cur); });
    }
    paint();
    thumbs.forEach(function (b) { items.push(b); });
    var srcBtn = h('div', { class: 'btn', 'data-f': true }, [h('span', { class: 'ic' }, '☰'), 'Sources']);
    srcBtn._onSelect = function () { showSources(target.id, target.video); };
    items.push(srcBtn);

    var track = h('div', { class: 'track' }, items);
    return h('div', { class: 'row btn-row', 'data-row': true, 'data-row-scroll': 'visible' }, track);
  }

  function showSources(videoId, video) {
    UI.toast('Looking for sources…', 1500);
    Player.ranked(state.meta, videoId).then(function (ranked) {
      if (!ranked.length) { UI.toast('No playable sources found. Check your addons in Stremio.'); return; }
      UI.menu({
        title: 'Choose a source',
        subtitle: 'Best match is picked automatically when you press Play',
        side: true,
        items: ranked.slice(0, 40).map(function (r, i) {
          var p = r.p;
          var tags = [p.res ? (p.res === 2160 ? '4K' : p.res + 'p') : '', p.hdr ? 'HDR' : '', p.dv ? 'DV' : '', p.hevc ? 'HEVC' : '', p.cached ? '⚡ Instant' : '', p.torrent ? 'Torrent' + (p.seeds ? ' · ' + p.seeds + ' seeds' : '') : '', p.sizeGB ? p.sizeGB.toFixed(1) + ' GB' : '', p.badAudio ? '⚠ DTS/TrueHD' : ''].filter(Boolean).join('  ·  ');
          return {
            label: (i === 0 ? '★ ' : '') + (p.label.name || r.s._addon),
            sub: tags + (p.label.title ? '\n' + p.label.title : ''),
            onSelect: function () {
              var rest = ranked.slice(i).concat(ranked.slice(0, i));
              play(videoId, video, { ranked: rest });
            }
          };
        })
      });
    });
  }

  function render(meta) {
    var st = state;
    st.meta = meta;
    var lite = Addons.lite(meta);
    var body = st.body;
    body.innerHTML = '';
    if (meta.background) st.bg.src = LiteSized(meta.background, 1280);

    var logo = h('img', { class: 'd-logo', src: lite.logo || '', alt: '' });
    var title = h('div', { class: 'd-title hide' }, meta.name);
    logo.onerror = function () { logo.remove(); title.classList.remove('hide'); };
    var head = h('div', { class: 'd-head' }, [
      h('div', { class: 'd-logo-wrap' }, [logo, title]),
      h('div', { class: 'd-meta' }, UI.Hero.metaLine(Object.assign(lite, { match: st.item.match }))),
      h('div', { class: 'd-desc' }, meta.description || ''),
      (meta.cast && meta.cast.length) ? h('div', { class: 'd-people' }, [h('span', null, 'Starring: '), meta.cast.slice(0, 4).join(', ')]) : null,
      (meta.director && meta.director.length) ? h('div', { class: 'd-people' }, [h('span', null, 'Director: '), meta.director.slice(0, 2).join(', ')]) : null
    ]);
    body.appendChild(head);
    body.appendChild(buttons(meta));

    if (meta.type === 'series' && meta.videos && meta.videos.length) {
      var seasons = seasonsOf(meta);
      var pills = seasons.map(function (s) {
        var p = h('div', { class: 'pill-btn', 'data-f': true }, s === 0 ? 'Specials' : 'Season ' + s);
        p._season = s;
        var sw = U.debounce(function () { if (Nav.focused === p && st.season !== s) { renderEpisodes(s); markSeason(); } }, 220);
        p._onFocus = sw;
        p._onSelect = function () { if (st.season !== s) { renderEpisodes(s); markSeason(); } Nav.move('down'); };
        return p;
      });
      function markSeason() { pills.forEach(function (p) { p.classList.toggle('selected', p._season === st.season); }); }
      var seasonRow = h('div', { class: 'row season-row', 'data-row': true, 'data-row-scroll': 'visible' }, h('div', { class: 'track' }, pills));
      st.epRow = h('div', { class: 'row ep-row', 'data-row': true, 'data-row-scroll': 'anchor' }, h('div', { class: 'track' }));
      body.appendChild(h('section', { class: 'd-section' }, [h('h2', { class: 'row-title' }, 'Episodes'), seasonRow, st.epRow]));
      var startSeason = st.target.video ? (st.target.video.season || 0) : seasons[0];
      renderEpisodes(startSeason);
      markSeason();
      seasonRow._idx = Math.max(0, seasons.indexOf(startSeason));
    }

    var simWrap = h('section', { class: 'd-section similar' }, [h('h2', { class: 'row-title' }, 'More Like This')]);
    body.appendChild(simWrap);
    Recs.similar(lite).then(function (list) {
      if (state !== st || !list.length) { if (!list.length) simWrap.remove(); return; }
      var r = UI.row({ key: 'similar', title: '', kind: 'landscape' }, list, function (item) { Detail.open(item, true); }, null);
      simWrap.appendChild(r._row);
      UI.lazyRow(r._row, 0);
    });

    var playBtn = body.querySelector('.btn.primary');
    Nav.focus(playBtn, { instant: true });

    // Resolve streams for the Play target and preload it into the player: Play just starts it.
    var res0 = resumeInfo(meta, st.target.id);
    Player.preloadTitle(meta, st.target.id, res0 ? res0.t : 0);
  }

  var Detail = {
    isOpen: function () { return !!state; },

    // Billboard "Play": straight into the right episode / resume point without opening details.
    playItem: function (item) {
      UI.toast('Loading…', 1200);
      Addons.meta(item.type, item.id).then(function (meta) {
        var t = playTarget(meta);
        var r = resumeInfo(meta, t.id);
        Player.play({ meta: meta, videoId: t.id, video: t.video, resumeAt: r ? r.t : 0 });
      }).catch(function () { UI.toast('Could not load this title'); });
    },

    open: function (item, replace) {
      Trailer.stop();
      if (state && replace) Detail.close(true);
      var bg = h('img', { class: 'd-bg', src: item.bgLarge || item.bg || '', alt: '' });
      bg.onload = function () { bg.classList.add('in'); };
      var body = h('div', { class: 'd-body', 'data-vscroll': 'visible', 'data-margin': '90' }, [
        h('div', { class: 'd-head' }, [
          h('div', { class: 'd-logo-wrap' }, item.logo ? h('img', { class: 'd-logo', src: item.logo }) : h('div', { class: 'd-title' }, item.name)),
          h('div', { class: 'd-desc' }, item.desc || ''),
          h('div', { class: 'spinner small' })
        ])
      ]);
      var el = h('div', { class: 'screen detail' }, [h('div', { class: 'd-bg-wrap' }, bg), h('div', { class: 'd-shade' }), h('div', { class: 'd-viewport' }, body)]);
      U.$('#stage').appendChild(el);
      document.body.classList.add('in-detail');
      state = { el: el, body: body, bg: bg, item: item };
      var my = state;
      state.layer = Nav.pushLayer(el, { onBack: function () { Detail.close(); } });
      Addons.meta(item.type, item.id).then(function (meta) {
        if (state !== my) return;
        render(meta);
      }).catch(function () {
        if (state !== my) return;
        body.innerHTML = '';
        body.appendChild(h('div', { class: 'd-head' }, [h('div', { class: 'd-title' }, item.name), h('div', { class: 'd-desc' }, 'Could not load details. Check your connection.')]));
      });
    },

    close: function (silent) {
      if (!state) return;
      if (!Player.active) Player.cancelPreload();
      var st = state;
      state = null;
      Nav.popLayer(st.layer);
      st.el.classList.add('leaving');
      setTimeout(function () { st.el.remove(); }, silent ? 0 : 220);
      document.body.classList.remove('in-detail');
    },

    refreshProgress: function () {
      if (!state || !state.meta) return;
      var focusedIsPlay = Nav.focused && Nav.focused.classList.contains('primary');
      var row = state.body.querySelector('.btn-row');
      var fresh = buttons(state.meta);
      row.parentNode.replaceChild(fresh, row);
      if (state.epRow) {
        var idx = state.epRow._idx;
        var focusedEp = Nav.focused && state.epRow.contains(Nav.focused);
        renderEpisodes(state.season);
        if (focusedEp) { var c = state.epRow.querySelector('.track').children[idx]; if (c) Nav.focus(c, { instant: true }); }
      }
      if (focusedIsPlay || !document.body.contains(Nav.focused)) Nav.focus(fresh.querySelector('.btn'), { instant: true });
    }
  };

  g.Detail = Detail;
})(window);
