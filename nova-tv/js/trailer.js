/*
 * Autoplaying previews, Netflix style: after focus rests on the billboard or a tile, the
 * title's trailer (from its Cinemeta metadata) plays inside it. The YouTube embed fades in only
 * once it reports "playing", so a slow or blocked video never shows a black box; it stops the
 * moment focus moves. Only one preview exists at a time.
 */
(function (g) {
  'use strict';

  var current = null; // { frame, host, item, timer, started, seenTimer }
  var seq = 0;

  // YouTube refuses embeds from file:// apps (Error 153). On the TV, previews need the relay page
  // (trailer-relay/index.html hosted on a real web origin, set as NOVA_CONFIG.trailerRelay).
  var RELAY = (g.NOVA_CONFIG || {}).trailerRelay || '';
  var CAN_EMBED = /^https?:$/.test(location.protocol) || !!RELAY;
  function enabled() { return CAN_EMBED && U.store.get('previews', true) && !document.body.classList.contains('lite'); }
  function withSound() { return U.store.get('previewSound', true); }

  // Trailers whose uploader blocks embedding (YouTube errors 100/101/150) are remembered and skipped.
  var blocked = U.store.get('ytBlocked', {});

  // All trailer ids Cinemeta knows for a title, first usable one first.
  function trailerId(item) {
    var pick = function (ids) {
      var ok = ids.filter(function (id) { return id && !blocked[id]; });
      return ok[0] || '';
    };
    if (item._trailers) return Promise.resolve(pick(item._trailers));
    if (!/^tt/.test(item.id || '')) return Promise.resolve(item.trailer && !blocked[item.trailer] ? item.trailer : '');
    return Addons.meta(item.type, item.id).then(function (m) {
      var ids = [];
      (m.trailerStreams || []).forEach(function (t) { if (t.ytId && ids.indexOf(t.ytId) === -1) ids.push(t.ytId); });
      (m.trailers || []).forEach(function (t) { if (t.source && ids.indexOf(t.source) === -1) ids.push(t.source); });
      if (item.trailer && ids.indexOf(item.trailer) === -1) ids.unshift(item.trailer);
      item._trailers = ids;
      return pick(ids);
    }).catch(function () { return item.trailer && !blocked[item.trailer] ? item.trailer : ''; });
  }

  // YouTube embed URL, through the relay page when one is configured.
  function embedUrl(yt, start, muted) {
    var mute = muted ? 1 : 0;
    if (RELAY) return RELAY + (RELAY.indexOf('?') === -1 ? '?' : '&') + 'v=' + encodeURIComponent(yt) + '&start=' + start + '&mute=' + mute;
    return 'https://www.youtube.com/embed/' + encodeURIComponent(yt) + '?autoplay=1&controls=0&disablekb=1&fs=0&iv_load_policy=3' +
      '&modestbranding=1&playsinline=1&rel=0&enablejsapi=1&start=' + start + '&mute=' + mute +
      (/^https?:$/.test(location.protocol) ? '&origin=' + encodeURIComponent(location.origin) : '');
  }

  // Size the 16:9 player to cover its host, cropping YouTube's edges.
  function cover(frame, w, h) {
    var fw = w, fh = w * 9 / 16;
    if (fh < h) { fh = h; fw = h * 16 / 9; }
    fw *= 1.08; fh *= 1.08;
    frame.style.width = Math.round(fw) + 'px';
    frame.style.height = Math.round(fh) + 'px';
    frame.style.left = Math.round((w - fw) / 2) + 'px';
    frame.style.top = Math.round((h - fh) / 2) + 'px';
  }

  function command(frame, func, args) {
    try { frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: func, args: args || [] }), '*'); } catch (e) {}
  }

  function fromPlayer(e) {
    var from = (e.origin || '').replace(/^https?:\/\//, '');
    var relayHost = RELAY ? RELAY.replace(/^https?:\/\//, '').split('/')[0] : '';
    return /youtube(-nocookie)?\.com$/.test(from) || (relayHost && from === relayHost);
  }

  function onMessage(e) {
    if (!fromPlayer(e)) return;
    if (full && full.frame && e.source === full.frame.contentWindow) { onFullMessage(e); return; }
    if (!current) return;
    // Late messages from a previous trailer's player are ignored.
    if (!current.frame || e.source !== current.frame.contentWindow) return;
    var data;
    try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch (err) { return; }
    if (data && data.event === 'onError') {
      // 100: removed, 101/150: uploader blocks embedding -> try the title's next trailer.
      // 153: player refused (no referrer/origin) -> the relay isn't in use.
      var c = current;
      console.warn('trailer: youtube error', data.info, c.item && c.item.name, c.yt);
      Trailer.stop();
      if ((data.info === 150 || data.info === 101 || data.info === 100) && c.yt) {
        blocked[c.yt] = 1;
        U.store.set('ytBlocked', blocked);
        c.item._tries = (c.item._tries || 0) + 1;
        if (c.item._tries < 3 && document.body.contains(c.host)) Trailer.queue(c.host, c.item, 0);
      }
      return;
    }
    if (data && data.event === 'initialDelivery' && !current.handshake) { current.handshake = true; console.log('trailer: handshake ok'); }
    if (!data || !data.info) return;
    var state = data.info.playerState;
    if (state === 1 && !current.started) {
      current.started = true;
      console.log('trailer: playing', current.mutedFallback ? '(muted fallback)' : '(sound)', current.item && current.item.name);
      current.host.classList.add('previewing');
      if (current.spinner) current.spinner.classList.add('done');
      current.frame.classList.add('on');
      // Started muted by the fallback: try sound now (allowed once the viewer has pressed a key).
      if (current.mutedFallback && withSound()) command(current.frame, 'unMute');
      var cur = current;
      cur.seenTimer = setTimeout(function () { if (current === cur) Ratings.trailerSeen(cur.item); }, 10000);
    } else if (state === 0) {
      Trailer.stop();
    }
  }
  window.addEventListener('message', onMessage);

  // ---------- full-screen trailer (detail page) ----------
  var full = null; // { el, frame, layer, ids, idx, state, time, dur, hintTimer }

  function fmt(t) { t = Math.max(0, Math.floor(t || 0)); return Math.floor(t / 60) + ':' + ('0' + t % 60).slice(-2); }

  function showHint(text) {
    if (!full) return;
    if (text) full.status.textContent = text;
    full.el.classList.add('hint');
    clearTimeout(full.hintTimer);
    full.hintTimer = setTimeout(function () { if (full && full.state === 1) full.el.classList.remove('hint'); }, 3000);
  }

  function loadFull(idx) {
    var yt = full.ids[idx];
    full.idx = idx;
    full.state = -1; full.time = 0; full.dur = 0; full.handshake = false;
    if (full.frame) full.frame.remove();
    var frame = document.createElement('iframe');
    frame.className = 'tf-frame';
    frame.setAttribute('allow', 'autoplay; encrypted-media');
    frame.setAttribute('frameborder', '0');
    frame.setAttribute('tabindex', '-1');
    frame.src = embedUrl(yt, 0, false);
    frame.onload = function () {
      try { frame.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: 'full', channel: 'widget' }), '*'); } catch (e) {}
    };
    full.frame = frame;
    full.el.insertBefore(frame, full.el.firstChild);
    full.el.classList.remove('playing');
    console.log('trailer: full screen', yt, full.name);
    var mine = full;
    clearTimeout(full.giveUp);
    full.giveUp = setTimeout(function () { if (full === mine && full.state === -1) nextOrClose('no answer from player'); }, 12000);
  }

  function nextOrClose(why) {
    console.warn('trailer: full screen failed', why, full && full.ids[full.idx]);
    if (full.idx + 1 < full.ids.length) { loadFull(full.idx + 1); return; }
    Trailer.closeFull();
    UI.toast('This trailer can\u2019t be played', 3000);
  }

  function onFullMessage(e) {
    var data;
    try { data = typeof e.data === 'string' ? JSON.parse(e.data) : e.data; } catch (err) { return; }
    if (!data) return;
    if (data.event === 'onError') {
      if (data.info === 150 || data.info === 101 || data.info === 100) { blocked[full.ids[full.idx]] = 1; U.store.set('ytBlocked', blocked); }
      nextOrClose('youtube error ' + data.info);
      return;
    }
    var info = data.info;
    if (!info || typeof info !== 'object') return;
    if (typeof info.currentTime === 'number') full.time = info.currentTime;
    if (typeof info.duration === 'number' && info.duration > 0) full.dur = info.duration;
    if (typeof info.playerState === 'number') {
      var was = full.state;
      full.state = info.playerState;
      if (info.playerState === 1) {
        full.el.classList.add('playing');
        if (was !== 1) showHint('');
      } else if (info.playerState === 2) {
        full.el.classList.add('hint'); clearTimeout(full.hintTimer);
      } else if (info.playerState === 0) {
        Trailer.closeFull();
        return;
      }
    }
    full.bar.style.transform = 'scaleX(' + (full.dur ? Math.min(1, full.time / full.dur) : 0) + ')';
    full.clock.textContent = fmt(full.time) + (full.dur ? ' / ' + fmt(full.dur) : '');
  }

  function fullKey(action) {
    if (!full) return false;
    if (action === 'back' || action === 'stop') { Trailer.closeFull(); return true; }
    if (!full.frame || full.state === -1) return true;
    if (action === 'enter' || action === 'playpause' || action === 'play' || action === 'pause') {
      var pause = action === 'pause' || (action !== 'play' && full.state === 1);
      command(full.frame, pause ? 'pauseVideo' : 'playVideo');
      showHint(pause ? 'Paused' : '');
      return true;
    }
    if (action === 'left' || action === 'right' || action === 'rw' || action === 'ff') {
      var step = action === 'left' || action === 'rw' ? -10 : 10;
      full.time = Math.max(0, Math.min(full.dur || Infinity, full.time + step));
      command(full.frame, 'seekTo', [full.time, true]);
      showHint((step < 0 ? '\u2212' : '+') + '10 s');
      full.clock.textContent = fmt(full.time) + (full.dur ? ' / ' + fmt(full.dur) : '');
      return true;
    }
    showHint('');
    return true;
  }

  var Trailer = {
    /** Play `item`'s trailer inside `host` once focus has rested for `delay` ms. */
    queue: function (host, item, delay) {
      Trailer.stop();
      if (!enabled() || !host || !item) return;
      if (performance.now() < 6000) delay = Math.max(delay || 0, 6000 - performance.now());
      var my = ++seq;
      var timer = setTimeout(function () {
        trailerId(item).then(function (yt) {
          if (my !== seq || !yt || !document.body.contains(host)) return;
          Trailer.start(host, item, yt);
        });
      }, delay || 1800);
      current = { timer: timer, host: host, item: item, frame: null, started: false };
    },

    start: function (host, item, yt) {
      current.yt = yt;
      var frame = document.createElement('iframe');
      frame.className = 'preview-frame';
      frame.setAttribute('allow', 'autoplay; encrypted-media');
      frame.setAttribute('frameborder', '0');
      frame.setAttribute('tabindex', '-1');
      frame.src = embedUrl(yt, 4, !withSound());
      var scale = g.NOVA_SCALE || 1;
      var r = host.getBoundingClientRect();
      cover(frame, r.width / scale, r.height / scale);
      var cur0 = current;
      frame.onload = function () {
        // Ask the embed to stream state events back to us.
        try { frame.contentWindow.postMessage(JSON.stringify({ event: 'listening', id: seq, channel: 'widget' }), '*'); } catch (e) {}
        // Autoplay with sound can be blocked; muted autoplay never is.
        setTimeout(function () {
          if (current !== cur0 || cur0.started) return;
          cur0.mutedFallback = true;
          command(frame, 'mute');
          command(frame, 'playVideo');
        }, 2500);
      };
      var spinner = document.createElement('div');
      spinner.className = 'preview-spinner';
      host.appendChild(spinner);
      current.spinner = spinner;
      console.log('trailer: loading', yt, item.name);
      // The player is oversized to crop YouTube's edges, so it sits in its own clipping layer.
      // Older TV Chromium lets an iframe escape an ancestor's rounded overflow clip; a clip
      // layer with a mask on the iframe's direct parent holds on every version.
      var clip = document.createElement('div');
      clip.className = 'preview-clip';
      clip.appendChild(frame);
      var arts = host.querySelectorAll('.tile-wide-img, .bb-img');
      var art = arts[arts.length - 1];
      host.insertBefore(clip, art ? art.nextSibling : host.firstChild);
      current.frame = frame;
      current.clip = clip;
      // Give up quietly if it never starts (embedding disabled, offline, slow TV).
      var cur = current;
      setTimeout(function () {
        if (current === cur && !cur.started) { console.warn('trailer: gave up', cur.handshake ? '(player answered, never played)' : '(no answer from player)', item.name); Trailer.stop(); }
      }, 9000);
    },

    stop: function () {
      seq++;
      if (!current) return;
      var c = current;
      current = null;
      clearTimeout(c.timer);
      clearTimeout(c.seenTimer);
      if (c.host) c.host.classList.remove('previewing');
      if (c.spinner && c.spinner.parentNode) c.spinner.parentNode.removeChild(c.spinner);
      if (c.frame) {
        c.frame.classList.remove('on');
        try { c.frame.contentWindow.postMessage(JSON.stringify({ event: 'command', func: 'pauseVideo', args: [] }), '*'); } catch (e) {}
        var gone = c.clip || c.frame;
        // The tile collapses right away: hide the clip now so a fading player never shows
        // squeezed into the narrow poster.
        if (c.clip) c.clip.classList.add('leaving');
        setTimeout(function () { if (gone.parentNode) gone.parentNode.removeChild(gone); }, 260);
      }
    },

    /** Trailer ids known for a title (Cinemeta metadata), playable ones first. */
    ids: function (item) {
      return trailerId(item).then(function () { return (item._trailers || []).filter(function (id) { return !blocked[id]; }); });
    },

    /** Play `item`'s trailer full screen. OK pauses, left/right seek 10 s, Back closes. */
    playFull: function (item, onClose) {
      if (!CAN_EMBED) { UI.toast('Trailers need the relay page (see README)', 3000); return; }
      Trailer.stop();
      Trailer.ids(item).then(function (ids) {
        if (!ids.length) { UI.toast('No trailer for this title', 2500); return; }
        if (full) Trailer.closeFull();
        // The TV has one video decoder: a stream preloaded for Play must let go of it first.
        if (g.Player) Player.cancelPreload();
        var h = U.h;
        var bar = h('i');
        var clock = h('div', { class: 'tf-clock' });
        var status = h('div', { class: 'tf-status' });
        var el = h('div', { class: 'trailer-full hint' }, [
          h('div', { class: 'tf-spinner' }),
          h('div', { class: 'tf-shade' }),
          h('div', { class: 'tf-info' }, [
            h('div', { class: 'tf-kicker' }, 'TRAILER'),
            h('div', { class: 'tf-title' }, item.name || ''),
            h('div', { class: 'tf-progress' }, bar),
            h('div', { class: 'tf-row' }, [clock, status, h('div', { class: 'tf-keys' }, 'OK pause  \u00b7  \u25c0 \u25b6 10 s  \u00b7  Back close')])
          ])
        ]);
        U.$('#stage').appendChild(el);
        full = { el: el, bar: bar, clock: clock, status: status, ids: ids, name: item.name, frame: null, onClose: onClose };
        full.layer = Nav.pushLayer(el, { initial: false, onKey: fullKey, onBack: function () { Trailer.closeFull(); } });
        loadFull(0);
      });
    },

    closeFull: function () {
      if (!full) return;
      var f = full;
      full = null;
      clearTimeout(f.hintTimer); clearTimeout(f.giveUp);
      if (f.frame) command(f.frame, 'pauseVideo');
      f.el.classList.add('closing');
      Nav.popLayer(f.layer);
      setTimeout(function () { f.el.remove(); if (f.onClose) f.onClose(); }, 220);
    },

    get fullOpen() { return !!full; },
    get active() { return !!(current && current.started); },
    get available() { return CAN_EMBED; }
  };

  document.addEventListener('visibilitychange', function () { if (document.hidden) { Trailer.stop(); Trailer.closeFull(); } });
  g.Trailer = Trailer;
})(window);
