/*
 * What's new and what's coming.
 *
 *  - New on Netflix, Prime & more: the Streaming Catalogs addon lists what is popular on each
 *    service; keep only what is actually new there (recent films, new shows, and older shows
 *    whose latest episode aired in the last weeks — via Cinemeta's last-videos, one request).
 *  - New Releases: TMDB "Latest Releases" + Cinemeta's current year, newest first, limited to
 *    titles the viewer's own addons can actually play.
 *  - Coming Soon: releases without a viable source yet (still in cinemas / CAM only), the next
 *    scheduled episodes of shows the viewer follows, and future-dated films. Remind Me tells the viewer when a
 *    title becomes watchable.
 */
(function (g) {
  'use strict';

  var DAY = 864e5;
  var STREAMING_CATALOGS = 'https://7a82163c306e-stremio-netflix-catalog-addon.baby-beamup.club/manifest.json';
  var TMDB = 'https://94c8cb9f702d-tmdb-addon.baby-beamup.club/manifest.json';
  var CINEMETA = 'https://v3-cinemeta.strem.io';
  var SERVICES = { nfx: 'Netflix', amp: 'Prime Video', dnp: 'Disney+', hbm: 'HBO Max', atp: 'Apple TV+' };

  var avail = U.store.get('avail', {});        // id -> { ok, t }
  var checking = null;                          // the running background check, if any
  var reminders = U.store.get('reminders', {}); // id -> { lite, at, notified }

  // The viewer's installed copy of an addon (keeps their country/service config), else the public one.
  function addonFor(manifestId, fallbackUrl, name) {
    var mine = Addons.list.filter(function (a) { return a.manifest.id === manifestId; })[0];
    return mine || { transportUrl: fallbackUrl, manifest: { id: manifestId, name: name, catalogs: [] } };
  }

  function cat(addon, type, id, extra) { return Addons.catalog(addon, type, id, extra, 3 * 3600).catch(function () { return []; }); }
  function days(d) { return d ? (Date.now() - Date.parse(d)) / DAY : Infinity; }
  function playableId(m) { return m && /^tt\d+/.test(m.id); }
  function fmtDay(d) {
    var t = Date.parse(d), diff = Math.round((t - Date.now()) / DAY);
    if (diff <= 0) return 'Today';
    if (diff === 1) return 'Tomorrow';
    if (diff < 7) return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(t).getDay()];
    return new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  }

  // Latest / next episode for many shows at once (Cinemeta last-videos & calendar-videos).
  function episodes(kind, ids) {
    ids = ids.filter(function (id) { return /^tt\d+/.test(id); }).slice(0, 60);
    if (!ids.length) return Promise.resolve({});
    var chunks = [];
    for (var i = 0; i < ids.length; i += 30) chunks.push(ids.slice(i, i + 30));
    return Promise.all(chunks.map(function (c) {
      var key = kind === 'last' ? 'lastVideosIds' : 'calendarVideosIds';
      var url = CINEMETA + '/catalog/series/' + (kind === 'last' ? 'last-videos' : 'calendar-videos') + '/' + key + '=' + c.join(',') + '.json';
      return U.catalogJSON(url, { kind: 'episodes', ttl: 3 * 3600 }).catch(function () { return []; });
    })).then(function (lists) {
      var map = {};
      [].concat.apply([], lists).forEach(function (l) { map[l.id] = l; });
      return map;
    });
  }

  var Fresh = {
    // ---------- New on Netflix, Prime & more ----------
    newOnServices: function (type) {
      var sc = addonFor('pw.ers.netflix-catalog', STREAMING_CATALOGS, 'Streaming Catalogs');
      var have = (sc.manifest.catalogs || []).map(function (c) { return c.type + '/' + c.id; });
      var jobs = [];
      Object.keys(SERVICES).forEach(function (svc) {
        ['movie', 'series'].forEach(function (t) {
          if (type && t !== type) return;
          if (have.length && have.indexOf(t + '/' + svc) === -1) return; // the viewer disabled this service
          jobs.push(cat(sc, t, svc).then(function (list) { list.forEach(function (m) { m.svc = SERVICES[svc]; }); return list; }));
        });
      });
      return Promise.all(jobs).then(function (lists) {
        var all = U.uniqBy([].concat.apply([], lists).filter(playableId), function (m) { return m.id; });
        var series = all.filter(function (m) { return m.type === 'series'; });
        return episodes('last', series.map(function (m) { return m.id; })).then(function (eps) {
          var out = [];
          all.forEach(function (m) {
            if (m.type === 'movie') {
              if (days(m.released) <= 240) { m.fresh = m.released; m.newKind = days(m.released) <= 45 ? 'New' : ''; out.push(m); }
              return;
            }
            var e = eps[m.id] && eps[m.id].latestEp;
            var firstAir = days(m.released);
            if (e && days(e.released) <= 45) {
              m.fresh = e.released;
              m.newKind = e.episode === 1 ? 'New Season' : 'New Episodes';
              m.sub = 'S' + e.season + ' · ' + (e.episode === 1 ? 'New season' : 'New episode');
              out.push(m);
            } else if (firstAir <= 240) { m.fresh = m.released; m.newKind = 'New Series'; out.push(m); }
          });
          // A new film/series/season outranks "another weekly episode"; freshness decays over weeks.
          var W = { 'New Season': 1, 'New Series': 1, 'New': 1, '': 0.8, 'New Episodes': 0.5 };
          out.forEach(function (m) {
            var d = Math.max(0, days(m.fresh));
            m._fs = Math.exp(-d / 25) * (W[m.newKind] != null ? W[m.newKind] : 0.8) + 0.2 * Math.min(1, Math.log(1 + (m.pop || 0)) / 5);
          });
          return out.sort(function (a, b) { return b._fs - a._fs; }).slice(0, 36);
        });
      });
    },

    // ---------- New Releases (candidates; availability splits them later) ----------
    latest: function (type) {
      var tmdb = addonFor('tmdb-addon', TMDB, 'The Movie Database Addon');
      var cm = Addons.cinemeta();
      var y = String(new Date().getFullYear());
      var types = type ? [type] : ['movie', 'series'];
      var jobs = [];
      types.forEach(function (t) {
        jobs.push(cat(tmdb, t, 'tmdb.latest'));
        jobs.push(cat(cm, t, 'year', { genre: y }));
      });
      return Promise.all(jobs).then(function (lists) {
        var all = U.uniqBy([].concat.apply([], lists).filter(playableId), function (m) { return m.id; });
        return all.filter(function (m) {
          var d = days(m.released);
          return (d >= 0 && d <= 150) || (!m.released && String(m.year).indexOf(y) === 0);
        })
          .sort(function (a, b) { return Date.parse(b.released || 0) - Date.parse(a.released || 0); });
      });
    },

    // ---------- availability (can the viewer's addons play it?) ----------
    isAvailable: function (id) { var a = avail[id]; return a ? a.ok : null; },
    sig: function () { var n = 0, ok = 0; Object.keys(avail).forEach(function (k) { n++; if (avail[k].ok) ok++; }); return n + '/' + ok; },

    /** Check up to `max` unchecked titles in the background; resolves with the ids that changed. */
    checkAvailability: function (items, max) {
      if (checking) return checking;
      var now = Date.now();
      var todo = items.filter(function (m) {
        var a = avail[m.id];
        return !a || now - a.t > (a.ok ? 24 : 6) * 3600 * 1000;
      }).slice(0, max || 16);
      var changed = [];
      var i = 0;
      function next() {
        if (i >= todo.length) {
          U.store.setLater('avail', avail, 1000); checking = null;
          if (todo.length) console.log('avail: checked', todo.length, 'playable', todo.filter(function (m) { return avail[m.id] && avail[m.id].ok; }).length);
          return Promise.resolve(changed);
        }
        var batch = todo.slice(i, i + 3); i += 3;
        return Promise.all(batch.map(function (m) {
          var vid = m.type === 'series' ? (m.latestEp && m.latestEp.id) || m.id + ':1:1' : m.id;
          return Addons.streams(m.type, vid).then(function (list) {
            var ranked = Streams.rank(list, Streams.context());
            // Viable = something that isn't a cinema camera recording and isn't an uncached debrid download.
            var ok = ranked.some(function (r) { return !r.p.cam && !r.p.uncached && r.score > -20; });
            var prev = avail[m.id];
            avail[m.id] = { ok: ok, t: Date.now() };
            if (!prev || prev.ok !== ok) changed.push(m.id);
          }).catch(function () {});
        })).then(next);
      }
      checking = next();
      return checking;
    },

    // ---------- Coming Soon ----------
    comingSoon: function (type, releases, extraSeries) {
      var out = [];
      // 1. Recent releases the viewer's addons can't play yet.
      (releases || []).forEach(function (m) {
        if (days(m.released) < 0) return; // future-dated ones come from the year catalogs below
        if (Fresh.isAvailable(m.id) !== false) return;
        m.soonKind = m.type === 'movie' && days(m.released) < 75 ? 'In cinemas now' : 'Expected soon';
        m.sub = m.type === 'movie' && days(m.released) < 75 ? 'In cinemas' : 'Soon';
        m.soonAt = m.released;
        out.push(m);
      });
      // 2. Next episodes of shows the viewer watches (and new on the services).
      var followed = Library.items.filter(function (it) { return it.type === 'series' && it.state && it.state.lastWatched && days(it.state.lastWatched) < 180; })
        .map(function (it) { return it._id; });
      var watchIds = U.uniqBy(followed.concat((extraSeries || []).map(function (m) { return m.id; })), function (x) { return x; });
      var jobs = [type === 'movie' ? Promise.resolve({}) : episodes('calendar', watchIds)];
      // 3. Future-dated films.
      if (type !== 'series') {
        var y = new Date().getFullYear();
        jobs.push(Promise.all([cat(Addons.cinemeta(), 'movie', 'year', { genre: String(y) }), cat(Addons.cinemeta(), 'movie', 'year', { genre: String(y + 1) })])
          .then(function (r) { return r[0].concat(r[1]).filter(function (m) { return m.released && days(m.released) < 0; }); }));
      }
      return Promise.all(jobs).then(function (r) {
        var cal = r[0] || {};
        Object.keys(cal).forEach(function (id) {
          var m = cal[id];
          if (!m.nextEp || days(m.nextEp.released) < -120) return;
          // Shows the viewer doesn't follow only count with a season premiere, not every weekly episode.
          if (followed.indexOf(id) === -1 && m.nextEp.episode !== 1) return;
          var e = m.nextEp;
          m.soonKind = (e.episode === 1 ? 'Season ' + e.season + ' · ' : 'New episode · ') + fmtDay(e.released);
          m.sub = fmtDay(e.released);
          m.soonAt = e.released;
          out.push(m);
        });
        (r[1] || []).forEach(function (m) { m.soonKind = 'Coming ' + fmtDay(m.released); m.sub = fmtDay(m.released); m.soonAt = m.released; out.push(m); });
        out = U.uniqBy(out, function (m) { return m.id; });
        // Soonest first; "expected soon" (no date ahead) after dated ones.
        return out.sort(function (a, b) {
          var da = Date.parse(a.soonAt || 0), db = Date.parse(b.soonAt || 0), now = Date.now();
          var fa = da > now, fb = db > now;
          if (fa !== fb) return fa ? -1 : 1;
          return fa ? da - db : db - da;
        }).slice(0, 30);
      });
    },

    // ---------- Remind Me ----------
    isReminded: function (id) { return !!reminders[id]; },
    toggleReminder: function (lite) {
      if (reminders[lite.id]) delete reminders[lite.id];
      else reminders[lite.id] = { lite: { id: lite.id, type: lite.type, name: lite.name, poster: lite.poster, bg: lite.bg, bgLarge: lite.bgLarge, logo: lite.logo, genres: lite.genres, year: lite.year, desc: lite.desc, released: lite.released }, at: Date.now() };
      U.store.set('reminders', reminders);
      return !!reminders[lite.id];
    },
    reminders: function () { return Object.keys(reminders).map(function (k) { return reminders[k]; }); },

    /** On launch: re-check reminded titles; tell the viewer about the ones that became watchable. */
    checkReminders: function () {
      var pending = Fresh.reminders().filter(function (r) { return !r.notified; }).map(function (r) { return r.lite; });
      if (!pending.length) return;
      pending.forEach(function (m) { delete avail[m.id]; });
      Fresh.checkAvailability(pending, 8).then(function () {
        var ready = pending.filter(function (m) { return Fresh.isAvailable(m.id); });
        ready.forEach(function (m) { reminders[m.id].notified = Date.now(); });
        if (ready.length) {
          U.store.set('reminders', reminders);
          UI.toast('Now on Nova: ' + ready.map(function (m) { return m.name; }).slice(0, 2).join(', ') + (ready.length > 2 ? ' and more' : ''), 5000);
        }
      });
    }
  };

  g.Fresh = Fresh;
})(window);
