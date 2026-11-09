/*
 * Player.
 *
 * Engine: Samsung AVPlay on the TV (hardware decoding, plays MKV/HEVC/HDR natively, no
 * transcoding), HTML5 <video> in a desktop browser.
 *
 * Smoothness features:
 *  - Streams are resolved before you press Play (detail page prefetch).
 *  - Bad source? Automatically falls through to the next-best one (start-up error, stall,
 *    unsupported audio) instead of showing an error.
 *  - Halfway through an episode the next episode's best source (same release group) is
 *    resolved and pre-warmed, so "Next Episode" starts in about a second.
 *  - Netflix-style next-episode countdown, scrubbing with acceleration, remembered subtitle
 *    language, progress synced to Stremio.
 */
(function (g) {
  'use strict';
  var h = U.h;

  var root, ui = {}, engine, st = null, gen = 0, preSeq = 0;
  var pre = Object.create(null);
  var osdTimer = null, scrubTimer = null, subTimer = null, nextTimer = null, stallTimer = null;
  var PRE_TTL = 20 * 60000;
  var NEXT_PROMPT_SEC = 35;
  var NEXT_COUNTDOWN = 12;

  var LANG = {
    nl: 'nld', nld: 'nld', dut: 'nld', en: 'eng', eng: 'eng', de: 'deu', deu: 'deu', ger: 'deu', fr: 'fra', fra: 'fra', fre: 'fra',
    es: 'spa', spa: 'spa', tr: 'tur', tur: 'tur', ar: 'ara', ara: 'ara', it: 'ita', ita: 'ita', pt: 'por', por: 'por', pob: 'pob',
    pl: 'pol', pol: 'pol', ru: 'rus', rus: 'rus', ja: 'jpn', jpn: 'jpn', ko: 'kor', kor: 'kor', zh: 'zho', chi: 'zho', zho: 'zho',
    sv: 'swe', swe: 'swe', da: 'dan', dan: 'dan', no: 'nor', nor: 'nor', nob: 'nor', fi: 'fin', fin: 'fin', hi: 'hin', hin: 'hin',
    cs: 'ces', cze: 'ces', ces: 'ces', el: 'ell', gre: 'ell', ell: 'ell', he: 'heb', heb: 'heb', bs: 'bos', bos: 'bos',
    bg: 'bul', bul: 'bul', ca: 'cat', cat: 'cat', hr: 'hrv', hrv: 'hrv', scr: 'hrv', hu: 'hun', hun: 'hun', mk: 'mkd', mac: 'mkd', mkd: 'mkd',
    fa: 'fas', per: 'fas', fas: 'fas', ro: 'ron', rum: 'ron', ron: 'ron', sl: 'slv', slv: 'slv', sr: 'srp', scc: 'srp', srp: 'srp',
    sk: 'slk', slo: 'slk', slk: 'slk', uk: 'ukr', ukr: 'ukr', vi: 'vie', vie: 'vie', th: 'tha', tha: 'tha', id: 'ind', ind: 'ind',
    ms: 'msa', may: 'msa', msa: 'msa', et: 'est', est: 'est', lv: 'lav', lav: 'lav', lt: 'lit', lit: 'lit', sq: 'sqi', alb: 'sqi', sqi: 'sqi',
    is: 'isl', ice: 'isl', isl: 'isl', bn: 'ben', ben: 'ben', ur: 'urd', urd: 'urd', ta: 'tam', tam: 'tam', te: 'tel', tel: 'tel'
  };
  var LANG_NAME = { nld: 'Nederlands', eng: 'English', deu: 'Deutsch', fra: 'Français', spa: 'Español', tur: 'Türkçe', ara: 'العربية', ita: 'Italiano', por: 'Português', pob: 'Português (BR)', pol: 'Polski', rus: 'Русский', jpn: '日本語', kor: '한국어', zho: '中文', swe: 'Svenska', dan: 'Dansk', nor: 'Norsk', fin: 'Suomi', hin: 'हिन्दी',
    ces: 'Čeština', ell: 'Ελληνικά', heb: 'עברית', bos: 'Bosanski', bul: 'Български', cat: 'Català', hrv: 'Hrvatski', hun: 'Magyar',
    mkd: 'Македонски', fas: 'فارسی', ron: 'Română', slv: 'Slovenščina', srp: 'Srpski', slk: 'Slovenčina', ukr: 'Українська',
    vie: 'Tiếng Việt', tha: 'ไทย', ind: 'Bahasa Indonesia', msa: 'Bahasa Melayu', est: 'Eesti', lav: 'Latviešu', lit: 'Lietuvių',
    sqi: 'Shqip', isl: 'Íslenska', ben: 'বাংলা', urd: 'اردو', tam: 'தமிழ்', tel: 'తెలుగు', und: 'Unknown language' };
  function normLang(l) { if (!l) return null; l = String(l).toLowerCase().slice(0, 3); return LANG[l] || LANG[l.slice(0, 2)] || l; }
  function langName(c) { return LANG_NAME[c] || (c ? c.toUpperCase() : 'Unknown'); }

  // ---------------- engines ----------------
  /*
   * Engines can hold one *preloaded* stream: opened, prepared (connected, headers read, start
   * buffer filled) and parked at the resume point, but not playing. open() with the same URL
   * adopts it and only has to press play.
   */
  function avEngine() {
    var av = webapis.avplay;
    var active = null;   // callbacks of the real playback
    var slot = null;     // { url, status: 'preparing'|'ready'|'failed', at, onPrepared }
    var fwd = function (name) {
      return function (a, b) {
        if (active && active[name]) active[name](a, b);
        else if (name === 'onError' && slot) slot.status = 'failed';
      };
    };
    var listener = {
      onbufferingstart: function () { fwd('onBuffer')(0); },
      onbufferingprogress: function (p) { fwd('onBuffer')(p); },
      onbufferingcomplete: function () { fwd('onBuffer')(null); },
      oncurrentplaytime: function (ms) { fwd('onTime')(ms / 1000); },
      onstreamcompleted: function () { fwd('onEnd')(); },
      onerror: function (e) { fwd('onError')(String(e)); },
      onevent: function () {},
      onsubtitlechange: function (dur, text) { fwd('onSubtitle')(text, dur); },
      ondrmevent: function () {}
    };
    function reset() {
      try { av.stop(); } catch (e) {}
      try { av.close(); } catch (e) {}
    }
    function setup(url, opts) {
      reset();
      av.open(url);
      av.setDisplayRect(0, 0, 1920, 1080);
      try { av.setDisplayMethod('PLAYER_DISPLAY_MODE_LETTER_BOX'); } catch (e) {}
      if (opts.uhd) { try { av.setStreamingProperty('SET_MODE_4K', 'TRUE'); } catch (e) {} }
      try {
        av.setBufferingParam('PLAYER_BUFFER_FOR_PLAY', 'PLAYER_BUFFER_SIZE_IN_SECOND', 4);
        av.setBufferingParam('PLAYER_BUFFER_FOR_RESUME', 'PLAYER_BUFFER_SIZE_IN_SECOND', 6);
      } catch (e) {}
      av.setListener(listener);
    }
    return {
      name: 'avplay',
      open: function (url, opts, cb) {
        if (slot && slot.url === url && slot.status !== 'failed') {
          var s0 = slot; slot = null;
          active = cb;
          var go = function () { if (active === cb) cb.onReady({ preloaded: true, at: s0.at }); };
          if (s0.status === 'ready') setTimeout(go, 0); else s0.onPrepared = go;
          return;
        }
        slot = null;
        active = cb;
        setup(url, opts);
        av.prepareAsync(function () { if (active === cb) cb.onReady({}); }, function (e) { if (active === cb) cb.onError('prepare ' + e); });
      },
      preload: function (url, opts, at) {
        if (active) return false;
        if (slot && slot.url === url) return true;
        var s0 = slot = { url: url, status: 'preparing', at: at || 0, onPrepared: null };
        try { setup(url, opts); } catch (e) { slot = null; return false; }
        var done = function () { if (slot !== s0 && !s0.onPrepared) return; s0.status = 'ready'; if (s0.onPrepared) s0.onPrepared(); };
        av.prepareAsync(function () {
          if (s0.at > 5) { try { av.seekTo(Math.floor(s0.at * 1000), done, done); } catch (e) { done(); } }
          else done();
        }, function () { s0.status = 'failed'; if (s0.onPrepared) { var cb = active; s0.onPrepared = null; if (cb) cb.onError('prepare (preloaded)'); } });
        return true;
      },
      cancelPreload: function () { if (slot && !active) { slot = null; reset(); } },
      preloadedUrl: function () { return slot && slot.status !== 'failed' ? slot.url : null; },
      play: function () { try { av.play(); } catch (e) {} },
      pause: function () { try { av.pause(); } catch (e) {} },
      seek: function (sec, done) { try { av.seekTo(Math.max(0, Math.floor(sec * 1000)), function () { if (done) done(); }, function () { if (done) done(); }); } catch (e) { if (done) done(); } },
      time: function () { try { return av.getCurrentTime() / 1000; } catch (e) { return 0; } },
      duration: function () { try { return av.getDuration() / 1000; } catch (e) { return 0; } },
      paused: function () { try { return av.getState() === 'PAUSED'; } catch (e) { return false; } },
      stop: function () { active = null; slot = null; reset(); },
      tracks: function () {
        var out = [];
        try {
          av.getTotalTrackInfo().forEach(function (t) {
            var info = {};
            try { info = JSON.parse(t.extra_info || '{}'); } catch (e) {}
            var type = t.type === 'AUDIO' ? 'audio' : t.type === 'TEXT' ? 'text' : null;
            if (!type) return;
            out.push({ type: type, index: t.index, raw: type === 'text' ? t.extra_info : undefined, lang: normLang(info.language || info.track_lang || info.lang), codec: (info.fourCC || '').toUpperCase(), channels: parseInt(info.channels, 10) || 0 });
          });
        } catch (e) {}
        return out;
      },
      currentAudio: function () {
        try { var c = av.getCurrentStreamInfo().filter(function (s) { return s.type === 'AUDIO'; })[0]; return c ? c.index : null; } catch (e) { return null; }
      },
      selectTrack: function (type, index) { try { av.setSelectTrack(type === 'audio' ? 'AUDIO' : 'TEXT', index); } catch (e) { console.warn(e); } },
      silentSubs: function (b) { try { av.setSilentSubtitle(b); } catch (e) {} },
      subDelay: function (sec) { try { av.setSubtitlePosition(Math.round(sec * 1000)); } catch (e) { console.warn('subDelay', e); } },
      suspend: function () { try { av.suspend(); } catch (e) {} },
      restore: function () { try { av.restore(); } catch (e) {} }
    };
  }

  function h5Engine() {
    var v = U.$('#html5video');
    var cb = null;
    var slot = null;
    var bind = function (ev, fn) { v.addEventListener(ev, function () { if (cb) fn(); }); };
    bind('loadedmetadata', function () { cb.onReady({}); });
    bind('timeupdate', function () { cb.onTime(v.currentTime); });
    bind('waiting', function () { cb.onBuffer(0); });
    bind('playing', function () { cb.onBuffer(null); });
    bind('ended', function () { cb.onEnd(); });
    bind('error', function () { cb.onError('media error ' + (v.error && v.error.code)); });
    v.addEventListener('loadedmetadata', function () {
      if (cb || !slot) return;
      if (slot.at > 5) v.currentTime = slot.at;
      slot.status = 'ready';
      if (slot.onPrepared) slot.onPrepared();
    });
    v.addEventListener('error', function () { if (!cb && slot) slot.status = 'failed'; });
    return {
      name: 'html5',
      open: function (url, opts, callbacks) {
        if (slot && slot.url === url && slot.status !== 'failed') {
          var s0 = slot; slot = null;
          cb = callbacks;
          var go = function () { if (cb === callbacks) callbacks.onReady({ preloaded: true, at: s0.at }); };
          if (s0.status === 'ready') setTimeout(go, 0); else s0.onPrepared = go;
          return;
        }
        slot = null; cb = callbacks; v.src = url; v.load();
      },
      preload: function (url, opts, at) {
        if (cb) return false;
        if (slot && slot.url === url) return true;
        slot = { url: url, status: 'preparing', at: at || 0, onPrepared: null };
        v.preload = 'auto'; v.src = url; v.load();
        return true;
      },
      cancelPreload: function () { if (slot && !cb) { slot = null; v.removeAttribute('src'); v.load(); } },
      preloadedUrl: function () { return slot && slot.status !== 'failed' ? slot.url : null; },
      play: function () { var p = v.play(); if (p && p.catch) p.catch(function () {}); },
      pause: function () { v.pause(); },
      seek: function (sec, done) { v.currentTime = Math.max(0, sec); if (done) setTimeout(done, 50); },
      time: function () { return v.currentTime || 0; },
      duration: function () { return isFinite(v.duration) ? v.duration : 0; },
      paused: function () { return v.paused; },
      stop: function () { cb = null; slot = null; v.pause(); v.removeAttribute('src'); v.load(); },
      tracks: function () { return []; },
      currentAudio: function () { return null; },
      selectTrack: function () {}, silentSubs: function () {}, subDelay: function () {}, suspend: function () { v.pause(); }, restore: function () {}
    };
  }

  // ---------------- helpers ----------------
  function sortedVideos(meta) {
    return (meta.videos || []).slice().sort(function (a, b) {
      var sa = a.season || 0, sb = b.season || 0;
      if ((sa === 0) !== (sb === 0)) return sa === 0 ? 1 : -1;
      return sa - sb || (a.episode || a.number || 0) - (b.episode || b.number || 0);
    });
  }

  function nextOf(meta, videoId) {
    if (meta.type !== 'series') return null;
    var vids = sortedVideos(meta);
    for (var i = 0; i < vids.length; i++) {
      if (vids[i].id === videoId) {
        var n = vids[i + 1];
        if (!n) return null;
        if ((n.season || 0) === 0 && (vids[i].season || 0) !== 0) return null;
        if (n.released && Date.parse(n.released) > Date.now() + 864e5) return null;
        return n;
      }
    }
    return null;
  }

  function videoById(meta, id) { return (meta.videos || []).filter(function (v) { return v.id === id; })[0] || null; }

  function titleLines(meta, video) {
    if (video) {
      var ep = UI.epLabel(video.id);
      return { title: meta.name, sub: ep + ' · ' + (video.name || video.title || 'Episode ' + (video.episode || '')) };
    }
    return { title: meta.name, sub: [meta.releaseInfo || meta.year, meta.runtime].filter(Boolean).join(' · ') };
  }

  function ctxFor(meta) {
    return Streams.context({ bingeGroup: U.store.get('binge.' + meta.id, null), lastAddon: U.store.get('lastAddon', null) });
  }

  // ---------------- subtitles ----------------
  function parseSubs(text) {
    var cues = [];
    var blocks = text.replace(/\r/g, '').replace(/^﻿/, '').split(/\n\s*\n/);
    var re = /(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})\s*-->\s*(?:(\d+):)?(\d{1,2}):(\d{2})[,.](\d{1,3})/;
    blocks.forEach(function (b) {
      var lines = b.split('\n');
      for (var i = 0; i < lines.length; i++) {
        var m = re.exec(lines[i]);
        if (!m) continue;
        var s = (+m[1] || 0) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / Math.pow(10, m[4].length);
        var e = (+m[5] || 0) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / Math.pow(10, m[8].length);
        var txt = lines.slice(i + 1).join('\n').replace(/\{\\[^}]*\}/g, '').replace(/<(?!\/?i>)[^>]+>/g, '').trim();
        if (txt) cues.push({ s: s, e: e, t: txt });
        break;
      }
    });
    return cues.sort(function (a, b) { return a.s - b.s; });
  }

  function fetchSubs(url) {
    return fetch(url).then(function (r) { if (!r.ok) throw new Error('subs ' + r.status); return r.arrayBuffer(); }).then(function (buf) {
      var txt = new TextDecoder('utf-8').decode(buf);
      if (txt.indexOf('�') !== -1) { try { txt = new TextDecoder('windows-1252').decode(buf); } catch (e) {} }
      return parseSubs(txt);
    });
  }

  function escapeHtml(s) { return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/&lt;(\/?)i&gt;/g, '<$1i>'); }

  function showSubText(t) {
    if (t === ui.subs._t) return;
    ui.subs._t = t;
    ui.subs.innerHTML = t ? '<span>' + escapeHtml(t).replace(/\n/g, '<br>') + '</span>' : '';
  }

  function startSubClock() {
    clearInterval(subTimer);
    subTimer = setInterval(function () {
      if (!st || !st.subs.cues) return;
      var t = st.t + (st.playing ? (performance.now() - st.tAt) / 1000 : 0) - (st.subs.delay || 0);
      var cues = st.subs.cues, i = st.subs.i || 0;
      if (i >= cues.length || cues[i].s > t) i = 0;
      while (i < cues.length && cues[i].e < t) i++;
      st.subs.i = i;
      var c = cues[i];
      showSubText(c && c.s <= t && c.e >= t ? c.t : '');
    }, 120);
  }

  // ---------------- UI ----------------
  function build() {
    root = U.$('#player');
    root.innerHTML = '';
    ui.loading = h('div', { class: 'p-loading' }, [
      ui.lBg = h('img', { class: 'p-l-bg', alt: '' }),
      h('div', { class: 'p-l-shade' }),
      h('div', { class: 'p-l-center' }, [
        ui.lLogo = h('img', { class: 'p-l-logo', alt: '' }),
        ui.lTitle = h('div', { class: 'p-l-title' }),
        h('div', { class: 'spinner' }),
        ui.lStatus = h('div', { class: 'p-l-status' })
      ])
    ]);
    ui.subs = h('div', { class: 'p-subs' });
    ui.pill = h('div', { class: 'p-pill hidden' }, [
      h('div', { class: 'p-pill-row' }, [ui.pLabel = h('span', { class: 'p-pill-label' }), h('span', { class: 'p-pill-arrow l' }, '◀'), ui.pValue = h('span', { class: 'p-pill-value' }), h('span', { class: 'p-pill-arrow r' }, '▶')]),
      ui.pHint = h('div', { class: 'p-pill-hint' })
    ]);
    ui.buffer = h('div', { class: 'p-buffer hidden' }, [h('div', { class: 'spinner' }), ui.bufPct = h('div', { class: 'p-buf-pct' })]);
    ui.center = h('div', { class: 'p-center' });

    ui.fill = h('div', { class: 'p-fill' });
    ui.thumb = h('div', { class: 'p-thumb' });
    ui.tip = h('div', { class: 'p-tip' });
    ui.bar = h('div', { class: 'p-bar', 'data-f': true }, [h('div', { class: 'p-track' }, [ui.fill]), ui.thumb, ui.tip]);
    ui.cur = h('div', { class: 'p-time' });
    ui.left = h('div', { class: 'p-time right' });

    ui.btnSubs = pbtn('Subtitles', openSubtitles);
    ui.btnAudio = pbtn('Audio', openAudio);
    ui.btnEpisodes = pbtn('Episodes', openEpisodes);
    ui.btnNext = pbtn('Next Episode ▸', function () { playNext(); });
    ui.btnSources = pbtn('Sources', openSources);
    ui.btns = h('div', { class: 'row p-btns', 'data-row': true, 'data-row-scroll': 'visible' }, h('div', { class: 'track' }, [ui.btnSubs, ui.btnAudio, ui.btnEpisodes, ui.btnNext, ui.btnSources]));

    ui.title = h('div', { class: 'p-title' });
    ui.sub = h('div', { class: 'p-sub' });
    ui.osd = h('div', { class: 'p-osd' }, [
      h('div', { class: 'p-top' }, [ui.title, ui.sub]),
      h('div', { class: 'p-bottom' }, [h('div', { class: 'p-times' }, [ui.cur, ui.left]), ui.bar, ui.btns])
    ]);

    ui.nThumb = h('img', { class: 'p-n-thumb', alt: '' });
    ui.nTitle = h('div', { class: 'p-n-title' });
    ui.nFill = h('i');
    ui.nBtn = h('div', { class: 'p-n-btn', 'data-f': true }, [h('span', { class: 'p-n-fill' }, ui.nFill), ui.nLabel = h('span', { class: 'p-n-label' }, 'Next Episode')]);
    ui.nBtn._onSelect = function () { playNext(); };
    ui.next = h('div', { class: 'p-next hidden' }, [ui.nThumb, h('div', { class: 'p-n-info' }, [h('div', { class: 'p-n-kicker' }, 'Next Episode'), ui.nTitle, ui.nBtn])]);

    ui.skip = h('div', { class: 'p-skip hidden', 'data-f': true });
    ui.skip._onSelect = function () { if (st && st.skip) doSkip(st.skip.seg); };
    U.append(root, [ui.subs, ui.pill, ui.center, ui.buffer, ui.osd, ui.next, ui.skip, ui.loading]);
  }

  function pbtn(label, fn) {
    var b = h('div', { class: 'p-btn', 'data-f': true }, label);
    b._onSelect = fn;
    return b;
  }

  function setLoading(on, status, failed) {
    ui.loading.classList.toggle('hidden', !on);
    root.classList.toggle('failed', !!failed);
    if (status != null) ui.lStatus.textContent = status;
  }

  function showOSD(focusBar) {
    if (!ui.next.classList.contains('hidden')) return;
    root.classList.add('osd');
    if (focusBar || !root.contains(Nav.focused) || ui.next.contains(Nav.focused)) Nav.focus(ui.bar, { instant: true });
    renderProgress();
    poke();
  }
  function hideOSD() { root.classList.remove('osd'); clearTimeout(osdTimer); }
  function osdVisible() { return root.classList.contains('osd'); }
  function poke() {
    clearTimeout(osdTimer);
    osdTimer = setTimeout(function () { if (st && st.playing && st.scrubT == null) hideOSD(); }, 4500);
  }

  function flashCenter(sym) {
    ui.center.textContent = sym;
    ui.center.classList.remove('flash'); void ui.center.offsetWidth; ui.center.classList.add('flash');
  }

  function renderProgress() {
    if (!st) return;
    var d = st.dur || 0;
    var t = st.scrubT != null ? st.scrubT : st.t;
    var pct = d ? Math.max(0, Math.min(1, t / d)) : 0;
    ui.fill.style.transform = 'scaleX(' + pct + ')';
    ui.thumb.style.transform = 'translate3d(' + (pct * 1680) + 'px,0,0)';
    ui.tip.style.transform = 'translate3d(' + (pct * 1680) + 'px,0,0)';
    ui.tip.textContent = U.fmtTime(t);
    root.classList.toggle('scrubbing', st.scrubT != null);
    ui.cur.textContent = U.fmtTime(t);
    ui.left.textContent = d ? '-' + U.fmtTime(d - t) : '';
  }

  // ---------------- session ----------------
  function liteMeta() { return Addons.lite(st.meta); }

  function saveProgress(flush) {
    if (!st || !st.started || !st.dur || st.t < 5) return;
    var next = st.nextVideo ? st.nextVideo.id : null;
    Library.updateProgress(liteMeta(), st.videoId, st.t, st.dur, { next: next, counted: st.counted, flush: flush });
    if (st.t / st.dur >= 0.92) st.counted = true;
  }

  function open(opts) {
    var wasOpen = !!st;
    if (st) { stopEngine(); }
    gen++;
    st = {
      meta: opts.meta, videoId: opts.videoId, video: opts.video || videoById(opts.meta, opts.videoId),
      resumeAt: opts.resumeAt || 0, ranked: null, ci: -1, tries: 0, started: false, playing: false,
      t: opts.resumeAt || 0, tAt: performance.now(), openedAt: performance.now(), dur: 0, scrubT: null, lastSave: 0,
      nextVideo: null, nextRanked: null, nextPreloading: false, nextShown: false, nextDismissed: false,
      segs: null, skip: null, skipped: {},
      subs: { cues: null, i: 0, mode: null, delay: 0 }, ss: loadStreamState(opts.meta.id, opts.videoId), embedded: false, counted: false, recovered: false, audioChecked: false
    };
    st.nextVideo = nextOf(st.meta, st.videoId);
    st.subs.delay = st.ss.subtitleDelay || 0;
    applySubStyle();
    adjust = null;
    ui.pill.classList.add('hidden');
    var tl = titleLines(st.meta, st.video);
    ui.title.textContent = tl.title;
    ui.sub.textContent = tl.sub;
    ui.lTitle.textContent = tl.sub;
    ui.lBg.src = (st.video && st.video.thumbnail) || LiteSized(st.meta.background, 1280) || '';
    ui.lLogo.src = LiteSized(st.meta.logo, 500) || '';
    ui.lLogo.onerror = function () { ui.lLogo.removeAttribute('src'); };
    ui.btnEpisodes.classList.toggle('disabled', st.meta.type !== 'series');
    ui.btnNext.classList.toggle('disabled', !st.nextVideo);
    ui.next.classList.add('hidden');
    hideSkip();
    showSubText('');
    hideOSD();
    setLoading(true, 'Finding the best source…');
    ui.buffer.classList.add('hidden');

    if (!wasOpen) {
      root.classList.remove('hidden');
      document.body.classList.add('playing');
      st.layer = Nav.pushLayer(root, { initial: ui.bar, onKey: onKey, onBack: function () {} });
    } else {
      st.layer = Nav.top();
    }

    var my = gen;
    var rp = opts.ranked ? Promise.resolve(opts.ranked) : Player.ranked(st.meta, st.videoId);
    rp.then(function (ranked) {
      if (my !== gen) return;
      st.ranked = ranked;
      if (!ranked.length) {
        setLoading(true, Streams.server()
          ? 'No playable sources found for this title.'
          : 'No direct sources found. To play torrents, open the Stremio app on a computer on this Wi-Fi, then choose Settings → Streaming server → Find automatically.', true);
        return;
      }
      tryCandidate(0);
    });
  }

  function stopEngine() {
    clearTimeout(stallTimer); clearInterval(nextTimer);
    try { engine.stop(); } catch (e) {}
  }

  function tryCandidate(i) {
    if (!st) return;
    var c = st.ranked[i];
    if (!c || st.tries >= 6) {
      setLoading(true, 'Couldn’t play this title. Press Back, then try “Sources”.', true);
      return;
    }
    st.ci = i; st.tries++;
    st.cur = c; st.started = false; st.playing = false; st.audioChecked = false;
    var res = c.p.res ? (c.p.res === 2160 ? '4K' : c.p.res + 'p') : '';
    setLoading(true, ['Starting', res, c.p.cached ? '· instant' : '', '· ' + (c.s._addon || '')].filter(Boolean).join(' '));
    var url = Streams.urlFor(c.s, ctxFor(st.meta));
    console.log('trying source', i, res, c.p.torrent ? 'torrent' : 'http', 'host=' + (/^https?:\/\/([^/]+)/.exec(url) || [])[1]);
    var my = ++gen;
    clearTimeout(stallTimer);
    stallTimer = setTimeout(function () {
      if (my === gen && st && !st.started) fallback('Source is slow — trying another…');
    }, c.p.torrent ? 45000 : 25000);

    try {
      engine.open(url, { uhd: c.p.res === 2160 }, {
        onReady: function (info) {
          if (my !== gen) return;
          var startAt = st.t > 5 ? st.t : st.resumeAt;
          if (info && info.preloaded) console.log('playback: using preloaded stream', Math.round(performance.now() - st.openedAt) + 'ms after Play');
          if (info && info.preloaded && Math.abs((info.at || 0) - startAt) < 3) { engine.play(); return; }
          if (startAt > 5) engine.seek(startAt, function () { if (my === gen) engine.play(); });
          else engine.play();
        },
        onTime: function (sec) { if (my === gen) onTime(sec); },
        onBuffer: function (p) { if (my === gen) onBuffer(p); },
        onEnd: function () { if (my === gen) onEnd(); },
        onError: function (e) { if (my === gen) onError(e); },
        onSubtitle: function (text, dur) {
          if (my !== gen || st.subs.mode !== 'embedded') return;
          showSubText(text);
          clearTimeout(st.subHide);
          st.subHide = setTimeout(function () { showSubText(''); }, Math.max(800, dur || 3000));
        }
      });
    } catch (e) {
      onError(e.message || String(e));
    }
  }

  function fallback(msg) {
    if (!st) return;
    UI.toast(msg || 'Trying another source…', 2500);
    stopEngine();
    tryCandidate(st.ci + 1);
  }

  function onError(e) {
    console.warn('player error', e, st && st.started ? 'mid-playback t=' + Math.round(st.t) : 'before start');
    if (!st) return;
    if (!st.started) { fallback('Source failed — trying another…'); return; }
    // Mid-playback: reopen the same source once at the current position, then fall through.
    if (!st.recovered) {
      st.recovered = true;
      UI.toast('Reconnecting…', 2000);
      stopEngine();
      st.ci--; st.tries--;
      tryCandidate(st.ci + 1);
      return;
    }
    fallback('Playback problem — switching source…');
  }

  function onBuffer(p) {
    if (!st.started) { if (p != null) setLoading(true, 'Buffering ' + Math.round(p) + '%'); return; }
    if (p == null) { ui.buffer.classList.add('hidden'); return; }
    ui.buffer.classList.remove('hidden');
    ui.bufPct.textContent = p ? Math.round(p) + '%' : '';
  }

  function onTime(sec) {
    if (!st) return;
    if (!st.started && sec > 0.05) {
      st.started = true;
      clearTimeout(stallTimer);
      setLoading(false);
      ui.buffer.classList.add('hidden');
      showOSD(true);
      console.log('playback started', engine.name, Math.round(performance.now() - st.openedAt) + 'ms after Play', 'at', sec.toFixed(1), 'dur', engine.duration().toFixed(0), st.cur.p.label.name);
      if (st.cur.p.bingeGroup) U.store.set('binge.' + st.meta.id, st.cur.p.bingeGroup);
      U.store.set('lastAddon', st.cur.s._addon);
      setTimeout(setupTracks, 1200);
      loadSegments();
      if (st.subs.delay) setTimeout(function () { if (st) flashPill('Subtitle delay', PROPS.delay.fmt(st.subs.delay) + ' · saved', 2500); }, 1500);
    }
    st.playing = !engine.paused();
    st.t = sec; st.tAt = performance.now();
    var d = engine.duration();
    if (d > 0) st.dur = d;
    if (osdVisible()) renderProgress();

    var now = Date.now();
    if (now - st.lastSave > 10000) { st.lastSave = now; saveProgress(false); }

    updateSkip();
    if (!st.dur || !st.nextVideo) return;
    var ratio = st.t / st.dur;
    if (ratio > 0.5 && !st.nextPreloading) preloadNext();
    // The next-episode card comes up when the credits start (TheIntroDB), else 35 s before the end.
    var credits = Segments.creditsStart(st.segs, st.dur);
    var due = credits != null ? st.t >= credits : st.dur - st.t <= NEXT_PROMPT_SEC;
    if (!st.nextShown && !st.nextDismissed && due && st.dur > 300) showNextCard();
  }

  // ---------------- skip intro / recap ----------------
  var SKIP_LABEL = { intro: 'Skip Intro', recap: 'Skip Recap' };
  function skipMode() { return U.store.get('skipIntro', 'button'); } // 'button' | 'auto' | 'off'

  function loadSegments() {
    var my = st;
    if (skipMode() === 'off' && !my.nextVideo) return;
    Segments.get(my.meta, my.video, engine.duration()).then(function (segs) {
      if (my !== st || !segs) return;
      my.segs = segs;
      console.log('segments:', ['intro', 'recap', 'credits'].map(function (k) { return k + ' ' + segs[k].map(function (x) { return Math.round(x.start) + '-' + (x.end === Infinity ? 'end' : Math.round(x.end)); }).join(','); }).join(' · '));
    });
  }

  function updateSkip() {
    var seg = skipMode() === 'off' || st.scrubT != null ? null : Segments.skippable(st.segs, st.t);
    var id = seg ? seg.kind + seg.start : null;
    if (seg && skipMode() === 'auto' && !st.skipped[id]) {
      st.skipped[id] = true;
      doSkip(seg);
      flashPill(SKIP_LABEL[seg.kind].replace('Skip ', '') + ' skipped', 'Back to rewatch', 2500);
      return;
    }
    if (!seg || st.skipped[id]) { if (st.skip) hideSkip(); return; }
    if (st.skip && st.skip.id === id) return;
    st.skip = { id: id, seg: seg };
    ui.skip.textContent = SKIP_LABEL[seg.kind];
    ui.skip.classList.remove('hidden');
    // OK skips, as on Netflix: the button takes focus unless the viewer is in the controls.
    if (!osdVisible() && ui.next.classList.contains('hidden')) Nav.focus(ui.skip, { instant: true });
  }

  function hideSkip() {
    if (st) st.skip = null;
    ui.skip.classList.add('hidden');
    if (Nav.focused === ui.skip) Nav.focus(ui.bar, { instant: true });
  }

  function doSkip(seg) {
    var to = Math.min(seg.end, (st.dur || 1e9) - 2);
    st.skipped[seg.kind + seg.start] = true;
    st.lastSkip = { from: st.t, at: performance.now() };
    console.log('skip', seg.kind, Math.round(st.t) + 's ->', Math.round(to) + 's');
    st.t = to; st.subs.i = 0;
    engine.seek(to);
    hideSkip();
  }

  function onEnd() {
    saveProgress(true);
    if (st.nextVideo && U.store.get('autoplay', true)) playNext();
    else close();
  }

  function preloadNext() {
    st.nextPreloading = true;
    var my = st;
    var ctx = ctxFor(st.meta);
    ctx.bingeGroup = st.cur && st.cur.p.bingeGroup || ctx.bingeGroup;
    var p = Streams.resolve(st.meta.type, st.nextVideo.id, ctx).then(function (r) {
      if (r[0]) {
        Streams.prewarm(r[0], ctx);
        Addons.subtitles(my.meta.type, my.nextVideo.id, subExtra(r[0].s)).catch(function () {});
      }
      if (my === st) my.nextRanked = r;
      return r;
    });
    pre[st.nextVideo.id] = { t: Date.now(), p: p };
    if (st.nextVideo.thumbnail) { var im = new Image(); im.src = st.nextVideo.thumbnail; }
  }

  function showNextCard() {
    st.nextShown = true;
    var nv = st.nextVideo;
    ui.nThumb.src = nv.thumbnail || LiteSized(st.meta.background, 780) || '';
    ui.nTitle.textContent = UI.epLabel(nv.id) + ' · ' + (nv.name || nv.title || '');
    hideOSD();
    ui.next.classList.remove('hidden');
    Nav.focus(ui.nBtn, { instant: true });
    var auto = U.store.get('autoplay', true);
    var left = NEXT_COUNTDOWN;
    ui.nFill.style.transition = 'none';
    ui.nFill.style.transform = 'scaleX(0)';
    void ui.nFill.offsetWidth;
    if (auto) {
      ui.nFill.style.transition = 'transform ' + NEXT_COUNTDOWN + 's linear';
      ui.nFill.style.transform = 'scaleX(1)';
    }
    ui.nLabel.textContent = auto ? 'Next Episode in ' + left : 'Play Next Episode';
    clearInterval(nextTimer);
    if (!auto) return;
    nextTimer = setInterval(function () {
      if (!st || st.nextDismissed) { clearInterval(nextTimer); return; }
      if (!st.playing) return; // paused: freeze countdown
      left--;
      ui.nLabel.textContent = 'Next Episode in ' + Math.max(0, left);
      if (left <= 0) { clearInterval(nextTimer); playNext(); }
    }, 1000);
  }

  function dismissNext() {
    st.nextDismissed = true;
    clearInterval(nextTimer);
    ui.next.classList.add('hidden');
    Nav.focus(ui.bar, { instant: true });
  }

  function playNext() {
    if (!st || !st.nextVideo) return;
    clearInterval(nextTimer);
    if (st.started && st.dur) { st.t = Math.max(st.t, st.dur * 0.95); saveProgress(true); }
    var nv = st.nextVideo;
    var ranked = st.nextRanked;
    var pr = Library.videoProgress(nv.id);
    open({ meta: st.meta, videoId: nv.id, video: nv, resumeAt: pr && !pr.done ? pr.t : 0, ranked: ranked && ranked.length ? ranked : null });
  }

  function close() {
    if (!st) return;
    saveProgress(true);
    Library.flush();
    stopEngine();
    clearInterval(subTimer); clearTimeout(osdTimer);
    if (adjust) { clearTimeout(adjust.idle); adjust = null; }
    ui.pill.classList.add('hidden');
    var layer = st.layer;
    st = null; gen++;
    showSubText('');
    root.classList.add('hidden');
    root.classList.remove('osd');
    document.body.classList.remove('playing');
    Nav.popLayer(layer);
    App.onPlayerClosed();
  }

  function togglePause() {
    if (!st || !st.started) return;
    if (engine.paused()) { engine.play(); st.playing = true; flashCenter('▶'); poke(); }
    else { engine.pause(); st.playing = false; saveProgress(false); flashCenter('❚❚'); showOSD(false); clearTimeout(osdTimer); }
  }

  var scrubCount = 0, lastScrub = 0;
  var STEPS = [10, 10, 10, 15, 20, 30, 30, 60, 60, 90, 120];
  function scrub(dir) {
    if (!st || !st.started) return;
    var now = performance.now();
    scrubCount = now - lastScrub < 450 ? scrubCount + 1 : 0;
    lastScrub = now;
    var step = STEPS[Math.min(scrubCount, STEPS.length - 1)];
    var base = st.scrubT != null ? st.scrubT : st.t;
    st.scrubT = Math.max(0, Math.min((st.dur || base + step) - 2, base + dir * step));
    renderProgress();
    clearTimeout(scrubTimer);
    scrubTimer = setTimeout(commitScrub, 700);
  }
  function commitScrub() {
    if (!st || st.scrubT == null) return;
    var t = st.scrubT;
    st.scrubT = null;
    st.t = t; st.tAt = performance.now();
    st.subs.i = 0;
    engine.seek(t, function () {});
    renderProgress();
    poke();
  }
  function jump(sec) {
    if (!st || !st.started) return;
    var t = Math.max(0, Math.min((st.dur || 1e9) - 2, st.t + sec));
    st.t = t; st.subs.i = 0;
    engine.seek(t);
    showOSD(true);
  }

  function onKey(action, e) {
    if (!st) return true;
    if (adjust) { adjustKey(action, e); return true; }
    if ((action === 'chup' || action === 'chdown') && st.started) { nudge('delay', action === 'chup' ? 1 : -1, e); return true; }
    // Media keys work everywhere.
    if (action === 'playpause') { togglePause(); return true; }
    if (action === 'play') { if (engine.paused()) togglePause(); return true; }
    if (action === 'pause') { if (!engine.paused()) togglePause(); return true; }
    if (action === 'stop') { close(); return true; }
    if (action === 'ff') { jump(30); return true; }
    if (action === 'rw') { jump(-30); return true; }
    if (action === 'next') { if (st.nextVideo) playNext(); return true; }

    if (!st.started) { if (action === 'back') close(); return true; }

    if (!ui.next.classList.contains('hidden') && ui.next.contains(Nav.focused)) {
      if (action === 'enter') { playNext(); return true; }
      if (action === 'back' || action === 'down') { dismissNext(); return true; }
      if (action === 'up') { dismissNext(); showOSD(true); return true; }
      return true;
    }

    if (st.skip && !osdVisible()) {
      if (action === 'enter') { doSkip(st.skip.seg); return true; }
      if (action === 'back') { st.skipped[st.skip.id] = true; hideSkip(); return true; }
    }
    // Back within a few seconds of an automatic skip returns to where it jumped from.
    if (action === 'back' && !osdVisible() && st.lastSkip && performance.now() - st.lastSkip.at < 6000) {
      var back = st.lastSkip.from; st.lastSkip = null;
      st.t = back; st.subs.i = 0; engine.seek(back); flashPill('Rewound', '', 1200);
      return true;
    }
    if (!osdVisible()) {
      if (action === 'left' || action === 'right') { showOSD(true); scrub(action === 'right' ? 1 : -1); return true; }
      if (action === 'enter') { togglePause(); return true; }
      if (action === 'up' || action === 'down') { showOSD(true); return true; }
      if (action === 'back') { close(); return true; }
      return true;
    }

    poke();
    var onBar = Nav.focused === ui.bar;
    if (action === 'back') {
      if (st.scrubT != null) { st.scrubT = null; clearTimeout(scrubTimer); renderProgress(); return true; }
      hideOSD(); return true;
    }
    if (onBar) {
      if (action === 'left' || action === 'right') { scrub(action === 'right' ? 1 : -1); return true; }
      if (action === 'enter') { if (st.scrubT != null) { clearTimeout(scrubTimer); commitScrub(); } else togglePause(); return true; }
      if (action === 'up') { hideOSD(); return true; }
    }
    return false;
  }

  // ---------------- tracks ----------------
  function setupTracks() {
    if (!st || !st.started) return;
    var tracks = engine.tracks();
    st.tracks = tracks;
    console.log('tracks', JSON.stringify(tracks));
    var audio = tracks.filter(function (t) { return t.type === 'audio'; });
    // The TV can't decode DTS/TrueHD: switch to a compatible track, or to another source.
    var bad = function (t) { return /DTS|TRUEHD|MLP/.test(t.codec); };
    var cur = engine.currentAudio();
    var curTrack = audio.filter(function (t) { return t.index === cur; })[0] || audio[0];
    if (curTrack && bad(curTrack)) {
      var good = audio.filter(function (t) { return !bad(t); });
      var sameLang = good.filter(function (t) { return t.lang === curTrack.lang; })[0];
      if (sameLang || good[0]) { engine.selectTrack('audio', (sameLang || good[0]).index); UI.toast('Switched to a TV-compatible audio track', 2500); }
      else if (st.t < 120 && st.ranked[st.ci + 1]) { fallback('Audio format not supported by this TV — switching source…'); return; }
    }
    // Pick the preferred audio language (multi-language releases often default to a dub).
    var audioPref = U.store.get('audioLang', 'eng');
    if (audioPref !== 'orig') {
      var curNow = engine.currentAudio();
      var cur2 = audio.filter(function (t) { return t.index === curNow; })[0] || audio[0];
      var prefs = [audioPref, 'eng'];
      for (var pi = 0; pi < prefs.length; pi++) {
        if (cur2 && cur2.lang === prefs[pi]) break;
        var hit = audio.filter(function (t) { return t.lang === prefs[pi] && !bad(t); })[0];
        if (hit) { engine.selectTrack('audio', hit.index); console.log('audio ->', hit.lang); break; }
      }
    }

    autoSubtitles(tracks);
  }

  /*
   * Subtitle choice, in order:
   *  0. what was saved for this episode (or carried over from the last one watched)
   *  1. embedded track tagged with the preferred language (English unless changed)
   *  2. OpenSubtitles (matched to this release's filename/size) in that language
   *  3. untagged embedded track, only when the release itself is English
   * Untagged tracks are a last resort because they are often "forced" or foreign subs.
   */
  function autoSubtitles(tracks) {
    var saved = st.ss.subtitleTrack;
    if (saved === null && st.ss.exact) { engine.silentSubs(true); return; }
    var want = saved && saved.lang ? saved.lang : U.store.get('subLang', 'eng');
    if (!want) { engine.silentSubs(true); return; }
    var text = tracks.filter(function (t) { return t.type === 'text'; });
    if (saved && saved.embedded && st.ss.exact) {
      var same = text.filter(function (t) { return 'emb:' + t.index === saved.id; })[0];
      if (same) { selectEmbedded(same, true); return; }
    }
    var emb = text.filter(function (t) { return t.lang === want; })[0];
    if (emb && !(saved && !saved.embedded)) { selectEmbedded(emb, true); console.log('subs -> embedded', want); return; }
    var my = st;
    loadExternal().then(function (list) {
      if (my !== st) return;
      var exact = saved && !saved.embedded && st.ss.exact ? list.filter(function (s) { return 'ext:' + s.url === saved.id; })[0] : null;
      var m = exact || list.filter(function (s) { return s._lang === want; })[0];
      if (m) { selectExternal(m, true); console.log('subs -> opensubs', want); return; }
      if (emb) { selectEmbedded(emb, true); return; }
      var untagged = text.filter(function (t) { return !t.lang || t.lang === 'und'; })[0];
      if (untagged && want === 'eng' && st.cur && !st.cur.p.dub) { selectEmbedded(untagged, true); console.log('subs -> untagged embedded'); }
    }).catch(function () {});
  }

  function subExtra(stream) {
    var bh = (stream && stream.behaviorHints) || {};
    var extra = {};
    if (bh.videoHash) extra.videoHash = bh.videoHash;
    if (bh.videoSize) extra.videoSize = bh.videoSize;
    if (bh.filename) extra.filename = bh.filename;
    return extra;
  }

  function selectEmbedded(t, quiet) {
    st.subs.mode = 'embedded'; st.subs.cues = null; st.subs.sel = 'emb:' + t.index;
    engine.selectTrack('text', t.index);
    engine.silentSubs(false);
    engine.subDelay(st.subs.delay);
    showSubText('');
    if (!quiet) { saveStreamState({ subtitleTrack: { id: st.subs.sel, embedded: true, lang: t.lang } }); flashPill('Subtitles', langName(t.lang) + ' · built-in'); }
  }

  function selectExternal(s, quiet) {
    engine.silentSubs(true);
    st.subs.mode = 'external'; st.subs.sel = 'ext:' + s.url;
    var my = st;
    if (!quiet) saveStreamState({ subtitleTrack: { id: st.subs.sel, embedded: false, lang: s._lang } });
    fetchSubs(s.url).then(function (cues) {
      if (my !== st) return;
      st.subs.cues = cues; st.subs.i = 0;
      startSubClock();
      if (!quiet) flashPill('Subtitles', langName(s._lang));
    }).catch(function () { if (!quiet) UI.toast('Could not load those subtitles'); });
  }

  function subsOff(quiet) {
    st.subs.mode = null; st.subs.cues = null; st.subs.sel = null;
    engine.silentSubs(true);
    showSubText('');
    if (!quiet) saveStreamState({ subtitleTrack: null });
  }

  function loadExternal() {
    if (st.extSubs) return Promise.resolve(st.extSubs);
    var my = st;
    return Addons.subtitles(st.meta.type, st.videoId, subExtra(st.cur && st.cur.s)).then(function (list) {
      list.forEach(function (s) { s._lang = normLang(s.lang); });
      if (my === st) st.extSubs = list;
      return list;
    });
  }

  // ---------- per-episode stream state (mirrors Stremio's StreamsBucket) ----------
  // Saved per show + episode; a new episode starts from the last-watched episode's state, so a
  // delay fixed once carries over while binge-watching.
  function ssKey(metaId, videoId) { return 'ss.' + metaId + '.' + videoId; }

  function loadStreamState(metaId, videoId) {
    var exact = U.store.get(ssKey(metaId, videoId), null);
    if (exact) return Object.assign({ exact: true }, exact);
    var last = U.store.get('ssLast.' + metaId, null);
    var prev = last ? U.store.get(ssKey(metaId, last), null) : null;
    return Object.assign({ exact: false }, prev || {});
  }

  function saveStreamState(patch) {
    if (!st) return;
    Object.assign(st.ss, patch);
    var copy = Object.assign({}, st.ss);
    delete copy.exact;
    U.store.set(ssKey(st.meta.id, st.videoId), copy);
    U.store.set('ssLast.' + st.meta.id, st.videoId);
  }

  // ---------- adjustable properties ----------
  var DELAY_STEP = 0.1, REPEAT_DELAY = 250, REPEAT_INTERVAL = 100;
  var SIZES = [75, 100, 125, 150, 175, 200];
  var PROPS = {
    delay: {
      label: 'Subtitle delay',
      get: function () { return st.subs.delay || 0; },
      fmt: function (v) { return (v > 0 ? '+' : v < 0 ? '−' : '') + Math.abs(v).toFixed(2) + ' s'; },
      hint: function (v) { return v > 0 ? 'Subtitles appear later' : v < 0 ? 'Subtitles appear earlier' : 'As in the file'; },
      step: function (dir, mult) {
        // Snap to 0.1 s like Stremio, rounding toward the direction of travel.
        var raw = Math.round(((st.subs.delay || 0) + dir * DELAY_STEP * mult) * 1000);
        var snapped = (dir > 0 ? Math.floor : Math.ceil)(raw / 100) * 100 / 1000;
        setDelay(snapped);
        saveStreamState({ subtitleDelay: st.subs.delay });
      }
    },
    size: {
      label: 'Subtitle size',
      get: function () { return subSize(); },
      fmt: function (v) { return v + '%'; },
      hint: function () { return ''; },
      step: function (dir) {
        var i = SIZES.indexOf(subSize());
        var v = SIZES[Math.max(0, Math.min(SIZES.length - 1, (i === -1 ? 1 : i) + dir))];
        saveStreamState({ subtitleSize: v });
        applySubStyle();
        if (!ui.subs._t) showSubText('Subtitle size preview');
      }
    },
    offset: {
      label: 'Subtitle position',
      get: function () { return st.ss.subtitleOffset || 0; },
      fmt: function (v) { return v + '%'; },
      hint: function (v) { return v ? 'Raised from the bottom' : 'Default'; },
      step: function (dir) {
        var v = Math.max(0, Math.min(40, (st.ss.subtitleOffset || 0) + dir * 2));
        saveStreamState({ subtitleOffset: v });
        applySubStyle();
        if (!ui.subs._t) showSubText('Subtitle position preview');
      }
    }
  };
  var PROP_ORDER = ['delay', 'size', 'offset'];

  function subSize() {
    var v = st && st.ss.subtitleSize;
    return v || U.store.get('subSizePct', 100);
  }

  function applySubStyle() {
    ui.subs.style.fontSize = Math.round(46 * subSize() / 100) + 'px';
    ui.subs.style.bottom = (90 + Math.round(1080 * ((st && st.ss.subtitleOffset) || 0) / 100)) + 'px';
  }

  function setDelay(sec) {
    st.subs.delay = Math.round(sec * 1000) / 1000;
    st.subs.i = 0;
    if (st.subs.mode === 'embedded') engine.subDelay(st.subs.delay);
  }

  // ---------- pill (Stremio's indicator) ----------
  var pillTimer = null;
  function renderPill(prop) {
    var p = PROPS[prop];
    var v = p.get();
    ui.pLabel.textContent = p.label;
    ui.pValue.textContent = p.fmt(v);
    ui.pHint.textContent = adjust ? 'OK to finish · ▲▼ size & position' : p.hint(v);
    ui.pill.classList.toggle('editing', !!adjust);
    ui.pill.classList.remove('hidden');
    ui.pValue.classList.remove('bump'); void ui.pValue.offsetWidth; ui.pValue.classList.add('bump');
  }

  function flashPill(label, value, ms) {
    if (adjust) return;
    ui.pLabel.textContent = label;
    ui.pValue.textContent = value;
    ui.pHint.textContent = '';
    ui.pill.classList.remove('editing', 'hidden');
    clearTimeout(pillTimer);
    pillTimer = setTimeout(function () { ui.pill.classList.add('hidden'); }, ms || 1200);
  }

  // Quick nudge without any menu (CH▲/CH▼), like Stremio's G/H keys.
  var hold = null;
  function nudge(prop, dir, e) {
    var now = performance.now();
    if (!e || !e.repeat || !hold || hold.dir !== dir) {
      hold = { dir: dir, start: now, last: now };
      PROPS[prop].step(dir, 1);
    } else {
      if (now - hold.start < REPEAT_DELAY || now - hold.last < REPEAT_INTERVAL) return;
      hold.last = now;
      // Hold accelerates: x3 after the first repeat, up to x6 after 3 seconds.
      var mult = prop === 'delay' ? Math.min(Math.floor((now - hold.start) / 1000) + 3, 6) : 1;
      PROPS[prop].step(dir, mult);
    }
    renderPill(prop);
    clearTimeout(pillTimer);
    if (!adjust) pillTimer = setTimeout(function () { ui.pill.classList.add('hidden'); }, 1200);
  }

  // Adjust mode: the menu collapses into the pill so the whole picture stays visible.
  var adjust = null;
  function startAdjust(prop) {
    adjust = { prop: prop, idle: null };
    hideOSD();
    renderPill(prop);
    clearTimeout(pillTimer);
    bumpIdle();
  }
  function bumpIdle() {
    clearTimeout(adjust.idle);
    adjust.idle = setTimeout(endAdjust, 8000);
  }
  function endAdjust() {
    if (!adjust) return;
    var prop = adjust.prop;
    clearTimeout(adjust.idle);
    adjust = null;
    flashPill(PROPS[prop].label, PROPS[prop].fmt(PROPS[prop].get()) + '  ✓ saved', 1400);
  }
  function adjustKey(action, e) {
    bumpIdle();
    if (action === 'left' || action === 'right') { nudge(adjust.prop, action === 'right' ? 1 : -1, e); return; }
    if (action === 'up' || action === 'down') {
      var i = PROP_ORDER.indexOf(adjust.prop) + (action === 'down' ? 1 : -1);
      adjust.prop = PROP_ORDER[(i + PROP_ORDER.length) % PROP_ORDER.length];
      renderPill(adjust.prop);
      return;
    }
    if (action === 'enter' || action === 'back') { endAdjust(); return; }
    if (action === 'playpause' || action === 'play' || action === 'pause') togglePause();
  }

  // ---------- subtitles menu: Language | Variant | Settings ----------
  function openSubtitles() {
    if (!st) return;
    hideOSD();
    var tracks = st.tracks || engine.tracks();
    var text = tracks.filter(function (t) { return t.type === 'text'; });
    var panel = h('div', { class: 'sp' }, h('div', { class: 'sp-loading' }, 'Loading subtitles…'));
    var host = U.$('#modal');
    host.innerHTML = '';
    host.classList.remove('hidden');
    host.classList.add('sp-host');
    host.appendChild(panel);
    var inSettings = false;
    var layer = Nav.pushLayer(host, { initial: false, onBack: close, onKey: function (a) {
      if (a === 'playpause' || a === 'play' || a === 'pause') { togglePause(); return true; }
      return false;
    }, onFocus: function (el) {
      // Entering the Settings column always lands on Delay, the one you came for.
      var now = !!el.closest('.sp-settings');
      if (now && !inSettings) {
        inSettings = true;
        var first = host.querySelector('.sp-set');
        if (first && el !== first) Nav.focus(first);
        return;
      }
      inSettings = now;
    } });

    function close() {
      host.classList.add('hidden');
      host.classList.remove('sp-host');
      host.innerHTML = '';
      Nav.popLayer(layer);
    }

    loadExternal().catch(function () { return []; }).then(function (ext) {
      if (!st) { close(); return; }
      var groups = {};
      text.forEach(function (t) {
        var k = t.lang && t.lang !== 'und' ? t.lang : 'und';
        var n = (groups[k] || []).filter(function (o) { return o.key.indexOf('emb:') === 0; }).length + 1;
        (groups[k] = groups[k] || []).push({ key: 'emb:' + t.index, label: 'Built-in' + (n > 1 ? ' ' + n : ''), pick: function () { selectEmbedded(t); } });
      });
      ext.forEach(function (s) {
        var k = s._lang || 'und';
        var n = (groups[k] || []).filter(function (o) { return o.key.indexOf('ext:') === 0; }).length + 1;
        (groups[k] = groups[k] || []).push({ key: 'ext:' + s.url, label: (s._addon || 'Online').replace(/ v\d+$/, '') + ' ' + n, pick: function () { selectExternal(s); } });
      });
      var pref = U.store.get('subLang', 'eng') || 'eng';
      var langs = Object.keys(groups).sort(function (a, b) {
        var r = function (l) { return l === pref ? 0 : l === 'eng' ? 1 : l === 'nld' ? 2 : l === 'und' ? 9 : 3; };
        return r(a) - r(b) || langName(a).localeCompare(langName(b));
      });
      var curLang = null;
      langs.forEach(function (l) { groups[l].forEach(function (o) { if (o.key === st.subs.sel) curLang = l; }); });

      var langList = h('div', { class: 'sp-list', 'data-vscroll': 'visible', 'data-margin': '30' });
      var varList = h('div', { class: 'sp-list', 'data-vscroll': 'visible', 'data-margin': '30' });

      function item(list, label, selected, onSelect, onFocus) {
        var el = h('div', { class: 'sp-item' + (selected ? ' selected' : ''), 'data-f': true }, label);
        el._onSelect = onSelect;
        if (onFocus) el._onFocus = onFocus;
        list.appendChild(el);
        return el;
      }
      function mark(list, el) { U.$$('.sp-item', list).forEach(function (x) { x.classList.toggle('selected', x === el); }); }

      function renderVariants(lang) {
        varList.innerHTML = ''; varList._y = 0; varList.style.transform = '';
        if (!lang) { varList.appendChild(h('div', { class: 'sp-empty' }, 'Subtitles off')); return; }
        groups[lang].forEach(function (o) {
          item(varList, o.label, o.key === st.subs.sel, function (el) {
            o.pick();
            if (lang !== 'und') U.store.set('subLang', lang);
            mark(varList, el);
            U.$$('.sp-item', langList).forEach(function (x) { x.classList.toggle('selected', x._lang === lang); });
          });
        });
      }

      var offEl = item(langList, 'Off', !st.subs.sel, function (el) {
        subsOff(); U.store.set('subLang', null); mark(langList, el); renderVariants(null);
      }, function () { renderVariants(null); });
      var initial = offEl;
      langs.forEach(function (l) {
        var el = item(langList, langName(l), l === curLang, function () {
          groups[l][0].pick();
          if (l !== 'und') U.store.set('subLang', l);
          U.$$('.sp-item', langList).forEach(function (x) { x.classList.toggle('selected', x._lang === l); });
          renderVariants(l);
        }, function () { renderVariants(l); });
        el._lang = l;
        if (l === curLang) initial = el;
      });

      // Settings: each row opens the pill, keeping the picture free while you tune it.
      var settings = h('div', { class: 'sp-settings' });
      PROP_ORDER.forEach(function (prop) {
        var p = PROPS[prop];
        var row = h('div', { class: 'sp-set', 'data-f': true }, [h('span', null, p.label.replace('Subtitle ', '').replace(/^./, function (c) { return c.toUpperCase(); })), h('b', null, p.fmt(p.get())), h('i', null, '›')]);
        row._onSelect = function () { close(); startAdjust(prop); };
        settings.appendChild(row);
      });
      settings.appendChild(h('div', { class: 'sp-tip' }, 'Tip: CH ▲ / ▼ shifts the delay anytime'));

      panel.innerHTML = '';
      U.append(panel, [
        h('div', { class: 'sp-col' }, [h('div', { class: 'sp-head' }, 'Language'), h('div', { class: 'sp-view' }, langList)]),
        h('div', { class: 'sp-col' }, [h('div', { class: 'sp-head' }, 'Variant'), h('div', { class: 'sp-view' }, varList)]),
        h('div', { class: 'sp-col settings' }, [h('div', { class: 'sp-head' }, 'Settings'), settings])
      ]);
      renderVariants(curLang);
      Nav.focus(initial, { instant: true });
    });
  }

  function openAudio() {
    if (!st) return;
    var tracks = st.tracks || engine.tracks();
    var audio = tracks.filter(function (t) { return t.type === 'audio'; });
    var curA = engine.currentAudio();
    if (!audio.length) { UI.toast('No alternative audio tracks'); return; }
    UI.menu({ title: 'Audio', side: true, items: audio.map(function (t) {
      var ch = t.channels >= 6 ? ' 5.1' : t.channels === 2 ? ' Stereo' : '';
      var unsupported = /DTS|TRUEHD|MLP/.test(t.codec);
      return { label: langName(t.lang) + ch, sub: (t.codec || '') + (unsupported ? ' · not supported by this TV' : ''), selected: t.index === curA, onSelect: function () {
        engine.selectTrack('audio', t.index);
        if (t.lang && t.lang !== 'und') U.store.set('audioLang', t.lang);
      } };
    }), onClose: function () { if (st) showOSD(false); } });
  }

  function openEpisodes() {
    if (!st || st.meta.type !== 'series') return;
    var season = st.video ? st.video.season || 0 : 1;
    var vids = sortedVideos(st.meta).filter(function (v) { return (v.season || 0) === season; });
    UI.menu({ title: season ? 'Season ' + season : 'Specials', side: true, items: vids.map(function (v) {
      var pr = Library.videoProgress(v.id);
      return { label: (v.episode || v.number) + '. ' + (v.name || v.title || ''), sub: pr ? (pr.done ? 'Watched' : U.fmtLeft(pr.d - pr.t) + ' left') : '', selected: v.id === st.videoId, onSelect: function () {
        if (v.id === st.videoId) return;
        saveProgress(true);
        var p2 = Library.videoProgress(v.id);
        open({ meta: st.meta, videoId: v.id, video: v, resumeAt: p2 && !p2.done ? p2.t : 0 });
      } };
    }) });
  }

  function openSources() {
    if (!st || !st.ranked) return;
    UI.menu({ title: 'Sources', side: true, items: st.ranked.slice(0, 30).map(function (r, i) {
      var p = r.p;
      var tags = [p.res ? (p.res === 2160 ? '4K' : p.res + 'p') : '', p.hdr ? 'HDR' : '', p.cached ? '⚡' : '', p.torrent ? 'Torrent' : '', p.sizeGB ? p.sizeGB.toFixed(1) + ' GB' : ''].filter(Boolean).join(' · ');
      return { label: p.label.name || r.s._addon, sub: tags + (p.label.title ? '\n' + p.label.title : ''), selected: i === st.ci, onSelect: function () {
        if (i === st.ci) return;
        stopEngine(); st.tries = 0; tryCandidate(i);
      } };
    }) });
  }

  function libraryTarget(meta, videoId) {
    var video = videoId ? videoById(meta, videoId) : null;
    if (meta.type !== 'movie' && video) return { id: videoId, video: video };
    if (meta.type === 'movie') return { id: meta.videos && meta.videos.length === 1 ? meta.videos[0].id : meta.id, video: null };
    var first = sortedVideos(meta).filter(function (v) { return (v.season || 0) > 0; })[0];
    return { id: first && first.id, video: first || null };
  }

  // Samsung's webapis.js loads async (it used to block boot); the engine is picked on first play.
  function withEngine(cb) {
    if (engine) { cb(); return; }
    var waited = 0;
    (function check() {
      var ready = !U.IS_TIZEN || (g.webapis && webapis.avplay);
      if (ready || waited >= 4000) {
        engine = U.IS_TIZEN && g.webapis && webapis.avplay ? avEngine() : h5Engine();
        document.body.classList.add('engine-' + engine.name);
        cb();
        return;
      }
      waited += 50;
      setTimeout(check, 50);
    })();
  }

  // ---------------- public ----------------
  g.Player = {
    init: function () {
      build();
    },

    ranked: function (meta, videoId) {
      var hit = pre[videoId];
      if (hit && Date.now() - hit.t < PRE_TTL) return hit.p;
      return Player.prefetch(meta, videoId);
    },

    prefetch: function (meta, videoId) {
      var hit = pre[videoId];
      if (hit && Date.now() - hit.t < PRE_TTL) return hit.p;
      var ctx = ctxFor(meta);
      var p = Streams.resolve(meta.type, videoId, ctx).then(function (r) {
        if (r[0]) Streams.prewarm(r[0], ctx);
        return r;
      });
      pre[videoId] = { t: Date.now(), p: p };
      p.then(function (r) { if (!r.length) delete pre[videoId]; });
      return p;
    },

    play: function (opts) {
      Trailer.stop();
      withEngine(function () { open(opts); });
    },

    // Continue Watching card resting in focus: resolve its stream and preload it into the player.
    prefetchFromLibrary: function (lib) {
      var my = ++preSeq;
      Addons.meta(lib.type, lib._id).then(function (meta) {
        if (my !== preSeq) return;
        var tgt = libraryTarget(meta, lib.state && lib.state.video_id);
        if (!tgt.id) return;
        var s = lib.state || {};
        var pr = Library.videoProgress(tgt.id);
        var at = pr && !pr.done ? pr.t : (s.video_id === tgt.id && s.timeOffset > 1000 ? s.timeOffset / 1000 : 0);
        Player.preloadTitle(meta, tgt.id, at, my);
      }).catch(function () {});
    },

    /**
     * Predictive preload: resolve the best source and have the player open + buffer it at the
     * resume point, so pressing Play only has to start it. One preload at a time; a newer one
     * (or cancelPreload) replaces it.
     */
    preloadTitle: function (meta, videoId, resumeAt, token) {
      var my = token || ++preSeq;
      if (st) return;
      withEngine(function () {
        Player.ranked(meta, videoId).then(function (ranked) {
          if (my !== preSeq || st || !ranked.length) return;
          var c = ranked[0];
          var url = Streams.urlFor(c.s, ctxFor(meta));
          if (!url || engine.preloadedUrl() === url) return;
          if (engine.preload(url, { uhd: c.p.res === 2160 }, resumeAt || 0)) {
            console.log('preload:', meta.name, videoId, resumeAt ? 'at ' + Math.round(resumeAt) + 's' : '');
          }
        });
      });
    },

    cancelPreload: function () {
      preSeq++;
      if (engine && !st && engine.preloadedUrl()) { engine.cancelPreload(); console.log('preload: dropped'); }
    },

    // From a Continue Watching card: fetch meta, then play the remembered episode.
    playFromLibrary: function (lib, videoId) {
      UI.toast('Loading…', 1200);
      Addons.meta(lib.type, lib._id).then(function (meta) {
        var tgt = libraryTarget(meta, videoId);
        var vid = tgt.id, video = tgt.video;
        var s = lib.state || {};
        var pr = Library.videoProgress(vid);
        var at = pr && !pr.done ? pr.t : (s.video_id === vid && s.timeOffset > 1000 ? s.timeOffset / 1000 : 0);
        Player.play({ meta: meta, videoId: vid, video: video, resumeAt: at });
      }).catch(function () { UI.toast('Could not load this title'); });
    },

    onHide: function () {
      Player.cancelPreload();
      if (engine && st && st.started && !engine.paused()) { engine.pause(); st.playing = false; saveProgress(true); showOSD(false); }
    },

    get active() { return !!st; },

    // Dev hook: lets the browser preview exercise the next-episode card on short samples.
    _debug: { showNext: function () { if (st && st.nextVideo) showNextCard(); }, state: function () { return st; } }
  };
})(window);
