/*
 * Library + watch progress. Mirrors Stremio's libraryItem schema so progress made here shows
 * up in the official apps (and vice versa). Per-episode progress is also kept locally so
 * episode lists can show progress bars.
 */
(function (g) {
  'use strict';

  var items = [];
  var byId = Object.create(null);
  var progress = U.store.get('progress', {}); // videoId -> {t, d, at}
  var dirty = Object.create(null);
  var pushTimer = null;

  function index() {
    byId = Object.create(null);
    items.forEach(function (it) { byId[it._id] = it; });
  }

  function nowIso() { return new Date().toISOString(); }

  function blank(meta) {
    return {
      _id: meta.id, name: meta.name, type: meta.type,
      poster: meta.poster || '', posterShape: 'poster',
      removed: false, temp: true, _ctime: nowIso(), _mtime: nowIso(),
      state: { lastWatched: null, timeWatched: 0, timeOffset: 0, overallTimeWatched: 0, timesWatched: 0, flaggedWatched: 0, duration: 0, video_id: null, watched: null, noNotif: false },
      behaviorHints: { defaultVideoId: null, featuredVideoId: null, hasScheduledVideos: false }
    };
  }

  function schedulePush(force) {
    clearTimeout(pushTimer);
    var run = function () {
      var changes = Object.keys(dirty).map(function (k) { return byId[k]; }).filter(Boolean);
      dirty = Object.create(null);
      Api.putLibrary(changes);
    };
    if (force) run(); else pushTimer = setTimeout(run, 45000);
  }

  function persist() {
    U.store.setLater('library', items, 4000);
    U.store.setLater('progress', progress, 2000);
  }

  var Library = {
    init: function () {
      items = U.store.get('library', []);
      index();
    },

    // Incremental sync like stremio-core: compare mtimes, fetch only changed items. Falls back
    // to a full fetch on first run or if the server answers in an unexpected shape.
    refresh: function () {
      if (!Api.loggedIn) return Promise.resolve(items);
      if (!items.length) return Library.fullRefresh();
      return Api.getLibraryMeta().then(function (meta) {
        if (!Array.isArray(meta) || (meta.length && !Array.isArray(meta[0]))) return Library.fullRefresh();
        var remote = Object.create(null);
        var changed = [];
        meta.forEach(function (m) {
          var id = m[0], mt = typeof m[1] === 'number' ? m[1] : Date.parse(m[1]);
          remote[id] = 1;
          var local = byId[id];
          if (!local || dirty[id] || !(Date.parse(local._mtime) >= mt)) { if (!dirty[id]) changed.push(id); }
        });
        var gone = items.filter(function (it) { return !remote[it._id] && !dirty[it._id]; }).length;
        console.log('perf library meta', meta.length, 'changed', changed.length, 'gone', gone);
        if (!changed.length && !gone) return items;
        if (changed.length > 150) return Library.fullRefresh();
        return Api.getLibraryItems(changed).then(function (fresh) {
          fresh.forEach(function (r) { byId[r._id] = r; });
          items = Object.keys(byId).map(function (k) { return byId[k]; }).filter(function (it) { return remote[it._id] || dirty[it._id]; });
          index();
          persist();
          return items;
        });
      }).catch(function () { return Library.fullRefresh(); });
    },

    fullRefresh: function () {
      return Api.getLibrary().then(function (remote) {
        console.log('perf library full fetch', remote.length);
        // Keep local edits that are newer than the server copy.
        var merged = remote.map(function (r) {
          var l = byId[r._id];
          return l && dirty[r._id] && l._mtime > r._mtime ? l : r;
        });
        items = merged.filter(function (it) { return it && it._id && (it.type === 'movie' || it.type === 'series' || it.type === 'anime' || it.type === 'tv' || it.type === 'channel' || it.type === 'other'); });
        index();
        persist();
        return items;
      });
    },

    get items() { return items; },
    get: function (id) { return byId[id] || null; },

    inList: function (id) { var it = byId[id]; return !!(it && !it.removed && !it.temp); },

    toggleList: function (meta) {
      var it = byId[meta.id];
      if (!it) { it = blank(meta); items.push(it); byId[it._id] = it; }
      var adding = it.removed || it.temp;
      it.removed = !adding;
      it.temp = false;
      it._mtime = nowIso();
      dirty[it._id] = 1;
      persist();
      schedulePush(true);
      return adding;
    },

    // Library items the user is part-way through, most recent first.
    continueWatching: function () {
      return items.filter(function (it) {
        var s = it.state || {};
        if (it.removed && !it.temp) return false;
        if (!s.lastWatched) return false;
        if (!(s.timeOffset > 0)) return false;
        if (s.duration && s.timeOffset / s.duration > 0.94) return false;
        return true;
      }).sort(function (a, b) { return (b.state.lastWatched || '') > (a.state.lastWatched || '') ? 1 : -1; });
    },

    myList: function () {
      return items.filter(function (it) { return !it.removed && !it.temp; })
        .sort(function (a, b) { return (b._mtime || '') > (a._mtime || '') ? 1 : -1; });
    },

    // Everything with real viewing history, used to build the taste profile.
    history: function () {
      return items.filter(function (it) {
        var s = it.state || {};
        return s.lastWatched && ((s.overallTimeWatched || 0) > 5 * 60 * 1000 || s.timesWatched > 0 || s.flaggedWatched);
      });
    },

    videoProgress: function (videoId) { return progress[videoId] || null; },

    /**
     * Called from the player. timeSec/durSec in seconds. `next` is the following episode id
     * (if any) so a finished episode turns into "next up" in Continue Watching everywhere.
     */
    updateProgress: function (meta, videoId, timeSec, durSec, opts) {
      opts = opts || {};
      if (!meta || !durSec) return;
      var it = byId[meta.id];
      if (!it) { it = blank(meta); items.push(it); byId[it._id] = it; }
      var s = it.state || (it.state = blank(meta).state);
      var prev = progress[videoId];
      var delta = prev && prev.at ? Math.min(60, Math.max(0, timeSec - prev.t)) : 0;
      progress[videoId] = { t: timeSec, d: durSec, at: Date.now() };

      var ratio = timeSec / durSec;
      s.lastWatched = nowIso();
      s.timeWatched = (s.timeWatched || 0) + delta * 1000;
      s.overallTimeWatched = (s.overallTimeWatched || 0) + delta * 1000;
      s.duration = Math.round(durSec * 1000);
      s.video_id = videoId;
      s.timeOffset = Math.round(timeSec * 1000);

      if (ratio >= 0.92) {
        progress[videoId].done = true;
        if (meta.type === 'movie') {
          s.flaggedWatched = 1; s.timesWatched = (s.timesWatched || 0) + (opts.counted ? 0 : 1); s.timeOffset = 0;
        } else if (opts.next) {
          s.video_id = opts.next; s.timeOffset = 1; s.duration = 0; s.timeWatched = 0;
        } else {
          s.timeOffset = 0; s.timesWatched = (s.timesWatched || 0) + 1;
        }
      }
      it._mtime = nowIso();
      if (it.removed && !it.temp) { it.removed = false; it.temp = true; }
      dirty[it._id] = 1;
      persist();
      schedulePush(!!opts.flush);
    },

    flush: function () { U.store.flush(); schedulePush(true); }
  };

  g.Library = Library;
})(window);
