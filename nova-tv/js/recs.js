/*
 * On-device recommendation engine.
 *
 * 1. Taste profile: every title with real viewing history contributes its genres, cast and
 *    directors, weighted by how much was watched and how recently (60-day half-life).
 * 2. Candidate pool: Cinemeta popular / top-rated / new catalogs plus genre catalogs for the
 *    profile's strongest genres.
 * 3. Scoring: genre affinity, people overlap, quality, popularity, type preference and a small
 *    per-day jitter so rows feel fresh without being random.
 * Also builds "Because you watched X" rows using item-to-item similarity.
 */
(function (g) {
  'use strict';

  var HALF_LIFE_DAYS = 60;
  var liteCache = U.store.get('lite', {}); // id -> lite meta for library items
  var profile = null;

  function today() { return new Date().toISOString().slice(0, 10); }

  function saveLite() {
    // Cap the cache so localStorage never fills up.
    var keys = Object.keys(liteCache);
    if (keys.length > 300) keys.slice(0, keys.length - 300).forEach(function (k) { delete liteCache[k]; });
    U.store.set('lite', liteCache);
  }

  function liteFor(item) {
    if (liteCache[item._id]) return Promise.resolve(liteCache[item._id]);
    return Addons.meta(item.type, item._id).then(function (m) {
      var l = Addons.lite(m);
      if (l) { l.desc = l.desc.slice(0, 160); liteCache[item._id] = l; }
      return l;
    }).catch(function () { return null; });
  }

  function itemWeight(it) {
    var s = it.state || {};
    var mins = (s.overallTimeWatched || 0) / 60000;
    var engagement = Math.log(1 + mins / 20) + (s.flaggedWatched ? 0.6 : 0) + Math.min(1, (s.timesWatched || 0) * 0.3);
    var last = s.lastWatched ? Date.parse(s.lastWatched) : Date.now() - 365 * 864e5;
    var ageDays = Math.max(0, (Date.now() - last) / 864e5);
    var recency = Math.pow(0.5, ageDays / HALF_LIFE_DAYS);
    var listBonus = !it.removed && !it.temp ? 0.3 : 0;
    return (engagement + listBonus) * (0.35 + 0.65 * recency);
  }

  function buildProfile() {
    var hist = Library.history();
    var listed = Library.myList().filter(function (it) { return !(it.state && it.state.lastWatched); }).slice(0, 15);
    var sources = hist.concat(listed);
    sources.sort(function (a, b) { return itemWeight(b) - itemWeight(a); });
    sources = sources.slice(0, 40);
    return Promise.all(sources.map(function (it) { return liteFor(it).then(function (l) { return { it: it, l: l }; }); })).then(function (rows) {
      saveLite();
      var p = { genres: {}, people: {}, neg: {}, negPeople: {}, types: { movie: 0.5, series: 0.5 }, seen: {}, seeds: [], total: 0, disliked: [] };
      Library.items.forEach(function (it) { if (it.state && (it.state.flaggedWatched || it.state.timesWatched || (it.state.overallTimeWatched || 0) > 20 * 60000)) p.seen[it._id] = 1; });
      rows.forEach(function (r) {
        if (!r.l) return;
        var w = itemWeight(r.it);
        p.total += w;
        p.types[r.l.type] = (p.types[r.l.type] || 0) + w;
        r.l.genres.forEach(function (gn) { p.genres[gn] = (p.genres[gn] || 0) + w; });
        r.l.cast.slice(0, 3).forEach(function (c) { p.people[c] = (p.people[c] || 0) + w * 0.6; });
        r.l.director.forEach(function (d) { p.people[d] = (p.people[d] || 0) + w; });
        if (r.it.state && r.it.state.lastWatched) p.seeds.push({ lite: r.l, w: w });
      });

      // Explicit ratings outweigh viewing time: love x4, like x2; recent ratings count more.
      var RW = { '2': 4, '1': 2 };
      var seedIdx = {};
      p.seeds.forEach(function (s, i) { seedIdx[s.lite.id] = i; });
      Ratings.list().forEach(function (e) {
        var l = e.lite;
        if (!l || !l.genres) return;
        l.cast = l.cast || []; l.director = l.director || [];
        var rec = 0.5 + 0.5 * Math.pow(0.5, (Date.now() - e.at) / 864e5 / 120);
        p.seen[l.id] = 1;
        if (e.r > 0) {
          var w = RW[e.r] * rec;
          p.total += w;
          p.types[l.type] = (p.types[l.type] || 0) + w;
          l.genres.forEach(function (gn) { p.genres[gn] = (p.genres[gn] || 0) + w; });
          l.cast.forEach(function (c) { p.people[c] = (p.people[c] || 0) + w * 0.6; });
          l.director.forEach(function (d) { p.people[d] = (p.people[d] || 0) + w; });
          var seed = { lite: l, w: w + (e.r === 2 ? 6 : 2), loved: e.r === 2 };
          if (seedIdx[l.id] != null) p.seeds[seedIdx[l.id]] = seed; else p.seeds.push(seed);
        } else {
          l.genres.forEach(function (gn) { p.neg[gn] = (p.neg[gn] || 0) + 1.5 * rec; });
          l.cast.forEach(function (c) { p.negPeople[c] = 1; });
          l.director.forEach(function (d) { p.negPeople[d] = 1; });
          p.disliked.push(l);
        }
      });
      // Trailers the viewer sat through are a light "interested" signal.
      Ratings.trailersSeen().slice(0, 20).forEach(function (e) {
        (e.lite.genres || []).forEach(function (gn) { p.genres[gn] = (p.genres[gn] || 0) + 0.5; });
        p.total += 0.3;
      });

      normalize(p.genres); normalize(p.people); normalize(p.neg);
      var tt = (p.types.movie || 0) + (p.types.series || 0);
      p.types.movie = (p.types.movie || 0) / tt; p.types.series = (p.types.series || 0) / tt;
      p.topGenres = Object.keys(p.genres).sort(function (a, b) { return p.genres[b] - p.genres[a]; });
      p.hasHistory = p.total > 0;
      profile = p;
      return p;
    });
  }

  function normalize(map) {
    var max = 0, k;
    for (k in map) if (map[k] > max) max = map[k];
    if (max > 0) for (k in map) map[k] /= max;
  }

  function score(m, p) {
    var gsum = 0;
    for (var i = 0; i < m.genres.length; i++) gsum += p.genres[m.genres[i]] || 0;
    var gScore = m.genres.length ? Math.min(1, gsum / Math.sqrt(m.genres.length)) : 0;
    var people = 0;
    m.cast.concat(m.director).forEach(function (n) { people += p.people[n] || 0; });
    people = Math.min(1, people);
    var quality = Math.max(0, Math.min(1, (m.rating - 5.5) / 3.5));
    var pop = Math.min(1, Math.log(1 + m.pop) / 5);
    var typePref = p.types[m.type] != null ? p.types[m.type] : 0.3;
    var jitter = U.hashStr(m.id + today()) * 0.07;
    // "Not for me" pushes away its genres and the people behind it.
    var nsum = 0;
    if (p.neg) for (var j = 0; j < m.genres.length; j++) nsum += p.neg[m.genres[j]] || 0;
    var negScore = m.genres.length ? Math.min(1, nsum / Math.sqrt(m.genres.length)) : 0;
    var negPeople = 0;
    if (p.negPeople) m.cast.concat(m.director).forEach(function (n) { if (p.negPeople[n]) negPeople = 1; });
    var yr = parseInt(m.year, 10), nowY = new Date().getFullYear();
    var recency = yr ? Math.max(0, Math.min(1, (yr - (nowY - 20)) / 20)) : 0.4;
    var oldPenalty = yr && yr < 1995 ? 0.06 : 0;
    return 0.42 * gScore + 0.16 * people + 0.2 * quality + 0.12 * pop + 0.1 * typePref + jitter - 0.3 * negScore - 0.12 * negPeople + 0.16 * recency - oldPenalty;
  }

  function match(s) { return Math.round(62 + 37 * Math.max(0, Math.min(1, (s - 0.18) / 0.55))); }

  function similarity(seed, m) {
    var a = seed.genres, b = m.genres;
    var inter = 0;
    for (var i = 0; i < b.length; i++) if (a.indexOf(b[i]) !== -1) inter++;
    var union = a.length + b.length - inter;
    var jac = union ? inter / union : 0;
    var people = 0;
    var seedPeople = seed.cast.concat(seed.director);
    m.cast.concat(m.director).forEach(function (n) { if (seedPeople.indexOf(n) !== -1) people += 0.5; });
    people = Math.min(1, people);
    var sameType = seed.type === m.type ? 1 : 0;
    var ya = parseInt(seed.year, 10), yb = parseInt(m.year, 10);
    var yearClose = ya && yb ? Math.max(0, 1 - Math.abs(ya - yb) / 25) : 0.4;
    var quality = Math.max(0, Math.min(1, (m.rating - 5.5) / 3.5));
    return 0.48 * jac + 0.2 * people + 0.12 * sameType + 0.08 * yearClose + 0.12 * quality;
  }

  var cm = function () { return Addons.cinemeta(); };
  function cat(type, id, extra) { return Addons.catalog(cm(), type, id, extra).catch(function () { return []; }); }
  function both(id, extra) { return Promise.all([cat('movie', id, extra), cat('series', id, extra)]).then(function (r) { return r[0].concat(r[1]); }); }

  function interleave(a, b) {
    var out = [];
    for (var i = 0; i < Math.max(a.length, b.length); i++) { if (a[i]) out.push(a[i]); if (b[i]) out.push(b[i]); }
    return out;
  }

  function notSeen(list, p) { return list.filter(function (m) { return !p.seen[m.id]; }); }

  function pool(p, type) {
    var jobs = [];
    var types = type ? [type] : ['movie', 'series'];
    types.forEach(function (t) {
      jobs.push(cat(t, 'top'), cat(t, 'top', { skip: 50 }), cat(t, 'imdbRating'));
      p.topGenres.slice(0, 4).forEach(function (gn) { jobs.push(cat(t, 'top', { genre: gn })); });
    });
    return Promise.all(jobs).then(function (lists) { return U.uniqBy([].concat.apply([], lists), function (m) { return m.id; }); });
  }

  var GENRE_LABEL = { 'Sci-Fi': 'Sci-Fi', 'Reality-TV': 'Reality TV', 'Talk-Show': 'Talk Shows', 'Game-Show': 'Game Shows' };
  function genreTitle(gn, type) {
    var label = GENRE_LABEL[gn] || gn;
    return label + (type === 'series' ? ' Series' : ' Movies');
  }

  var Recs = {
    get profile() { return profile; },
    match: match,

    /**
     * Returns row specs: {key, title, kind, load: () => Promise<items>}.
     * `type` limits the page to movies or series (Movies / Series tabs).
     */
    rows: function (type) {
      var tP = performance.now();
      return buildProfile().then(function (p) { console.log('perf profile', Math.round(performance.now() - tP) + 'ms (incl. network)'); return p; }).catch(function () { return { genres: {}, people: {}, types: {}, seen: {}, seeds: [], topGenres: [], hasHistory: false }; }).then(function (p) {
        var rows = [];
        var poolP = null;
        var getPool = function () { return poolP || (poolP = pool(p, type)); };
        var allGenres = type === 'series'
          ? ['Drama', 'Comedy', 'Crime', 'Mystery', 'Sci-Fi', 'Thriller', 'Fantasy', 'Action', 'Animation', 'Documentary', 'Romance', 'Reality-TV', 'Family', 'History', 'Horror']
          : ['Action', 'Comedy', 'Drama', 'Thriller', 'Romance', 'Sci-Fi', 'Horror', 'Animation', 'Family', 'Crime', 'Adventure', 'Fantasy', 'Mystery', 'Documentary', 'History', 'War'];

        rows.push({ key: 'continue', title: 'Continue Watching', kind: 'continue', load: function () {
          return Promise.resolve(Library.continueWatching().filter(function (it) { return !type || it.type === type; }));
        } });

        // What's new on the services the viewer pays for, newest first.
        rows.push({ key: 'new-svc', title: type === 'series' ? 'New Shows & Seasons on Netflix, Prime & more' : type === 'movie' ? 'New Movies on Netflix, Prime & more' : 'New on Netflix, Prime & more', kind: 'landscape', load: function () {
          return Fresh.newOnServices(type).then(function (l) { return l.filter(function (m) { return !Ratings.isDisliked(m.id); }); });
        } });

        rows.push({ key: 'picks', title: p.hasHistory ? 'Today\'s Top Picks for You' : 'Popular Right Now', kind: 'landscape', load: function () {
          return getPool().then(function (all) {
            var cands = notSeen(all, p).filter(function (m) { return !type || m.type === type; });
            cands.forEach(function (m) { m._s = score(m, p); m.match = p.hasHistory ? match(m._s) : null; });
            return cands.sort(function (a, b) { return b._s - a._s; }).slice(0, 24);
          });
        } });

        // Newest releases the viewer's addons can play; ones they can't yet go to Coming Soon.
        var latestP = null;
        var getLatest = function () { return latestP || (latestP = Fresh.latest(type)); };
        rows.push({ key: 'new-releases', title: 'New Releases', kind: 'landscape', load: function () {
          return getLatest().then(function (list) {
            // Check sources quietly in the background; rows re-sort when that finishes.
            Fresh.checkAvailability(list.slice(0, 40), 40).then(function (changed) { if (changed.length && g.App) App.refreshTabs(); });
            return list.filter(function (m) { return Fresh.isAvailable(m.id) !== false; }).slice(0, 30);
          });
        } });

        rows.push({ key: 'top10', title: type === 'series' ? 'Top 10 Series Today' : type === 'movie' ? 'Top 10 Movies Today' : 'Top 10 Today', kind: 'top10', load: function () {
          var src = type ? cat(type, 'top') : both('top');
          return src.then(function (l) { return l.sort(function (a, b) { return b.pop - a.pop; }).slice(0, 10); });
        } });

        var seeds = p.seeds.slice().sort(function (a, b) { return b.w - a.w; });
        var seedLoved = {};
        seeds.forEach(function (s) { if (s.loved) seedLoved[s.lite.id] = 1; });
        var usedSeeds = {};
        function becauseRow(n) {
          var seed = null;
          for (var i = 0; i < seeds.length; i++) {
            var s = seeds[i].lite;
            if (usedSeeds[s.id] || (type && s.type !== type)) continue;
            usedSeeds[s.id] = 1; seed = s; break;
          }
          if (!seed) return null;
          return { key: 'because' + n, title: (seedLoved[seed.id] ? 'Because you loved ' : 'Because you watched ') + seed.name, kind: 'landscape', load: function () {
            var extra = seed.genres.slice(0, 2).map(function (gn) { return cat(seed.type, 'top', { genre: gn }); });
            return Promise.all([getPool()].concat(extra)).then(function (lists) {
              var all = U.uniqBy([].concat.apply([], lists), function (m) { return m.id; });
              var cands = notSeen(all, p).filter(function (m) { return m.id !== seed.id && (!type || m.type === type); });
              cands.forEach(function (m) { m._sim = similarity(seed, m); m.match = match(m._sim * 0.9 + 0.1); });
              return cands.sort(function (a, b) { return b._sim - a._sim; }).slice(0, 20);
            });
          } };
        }

        rows.push({ key: 'coming-soon', title: 'Coming Soon', kind: 'landscape', load: function () {
          // Upcoming episodes of shows the viewer follows plus the popular shows on their services.
          var popular = type === 'movie' ? Promise.resolve([]) : Promise.all([cat('series', 'top'), Fresh.newOnServices(type === 'series' ? 'series' : null)])
            .then(function (r) { return r[0].slice(0, 25).concat(r[1].filter(function (m) { return m.type === 'series'; })); }).catch(function () { return []; });
          return Promise.all([getLatest(), popular]).then(function (r) { return Fresh.comingSoon(type, r[0], r[1]); });
        } });

        var b1 = becauseRow(1); if (b1) rows.push(b1);

        rows.push({ key: 'trending', title: 'Trending Now', kind: 'landscape', load: function () {
          var src = type ? cat(type, 'top') : Promise.all([cat('movie', 'top'), cat('series', 'top')]).then(function (r) { return interleave(r[0], r[1]); });
          return src.then(function (l) { return l.slice(10, 40); });
        } });

        rows.push({ key: 'mylist', title: 'My List', kind: 'landscape', load: function () {
          var list = Library.myList().filter(function (it) { return !type || it.type === type; }).slice(0, 30);
          return Promise.all(list.map(function (it) { return liteFor(it); })).then(function (l) { saveLite(); return l.filter(Boolean); });
        } });

        // Genre rows, strongest affinity first.
        var genres = allGenres.slice().sort(function (a, b) { return (p.genres[b] || 0) - (p.genres[a] || 0); });
        var genreTypes = type ? [type] : null;
        var gi = 0;
        function genreRow() {
          var gn = genres[gi++];
          if (!gn) return null;
          var t = genreTypes ? genreTypes[0] : ((p.types.series || 0) > (p.types.movie || 0) ? (gi % 2 ? 'series' : 'movie') : (gi % 2 ? 'movie' : 'series'));
          return { key: 'genre-' + t + '-' + gn, title: genreTitle(gn, t), kind: 'landscape', load: function () {
            return cat(t, 'top', { genre: gn }).then(function (l) {
              l.forEach(function (m) { m._s = score(m, p) + Math.log(1 + m.pop) * 0.05; m.match = p.hasHistory ? match(score(m, p)) : null; });
              return notSeen(l, p).sort(function (a, b) { return b._s - a._s; }).slice(0, 30);
            });
          } };
        }

        rows.push(genreRow());
        rows.push(genreRow());
        var b2 = becauseRow(2); if (b2) rows.push(b2);

        rows.push({ key: 'acclaimed', title: 'Critically Acclaimed', kind: 'landscape', load: function () {
          var src = type ? cat(type, 'imdbRating') : Promise.all([cat('movie', 'imdbRating'), cat('series', 'imdbRating')]).then(function (r) { return interleave(r[0], r[1]); });
          return src.then(function (l) { return notSeen(l, p).slice(0, 30); });
        } });

        rows.push(genreRow());

        // Rows from the user's other catalog addons (e.g. streaming-service catalogs).
        Addons.browsableCatalogs().filter(function (c) {
          return c.addon.manifest.id !== 'com.linvo.cinemeta' && (!type || c.type === type) && (c.type === 'movie' || c.type === 'series');
        }).slice(0, 10).forEach(function (c) {
          rows.push({ key: 'addon-' + c.addon.manifest.id + '-' + c.type + '-' + c.id, title: c.name || c.addon.manifest.name, kind: 'landscape', load: function () {
            return Addons.catalog(c.addon, c.type, c.id).then(function (l) { return l.slice(0, 30); }).catch(function () { return []; });
          } });
        });

        var b3 = becauseRow(3); if (b3) rows.push(b3);
        for (var k = 0; k < 8; k++) { var gr = genreRow(); if (gr) rows.push(gr); }

        return rows.filter(Boolean);
      });
    },

    // "More like this" for a detail page.
    similar: function (seed) {
      var p = profile || { seen: {}, genres: {}, people: {}, types: {} };
      var extra = seed.genres.slice(0, 3).map(function (gn) { return cat(seed.type, 'top', { genre: gn }); });
      return Promise.all(extra).then(function (lists) {
        var all = U.uniqBy([].concat.apply([], lists), function (m) { return m.id; }).filter(function (m) { return m.id !== seed.id; });
        all.forEach(function (m) { m._sim = similarity(seed, m) + (p.seen[m.id] ? -0.2 : 0); m.match = profile && profile.hasHistory ? match(m._sim * 0.9 + 0.1) : null; });
        return all.sort(function (a, b) { return b._sim - a._sim; }).slice(0, 18);
      });
    },

    matchFor: function (m) {
      if (!profile || !profile.hasHistory || !m.genres) return null;
      return match(score(m, profile));
    }
  };

  g.Recs = Recs;
})(window);
