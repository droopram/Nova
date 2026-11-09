/*
 * Taste signals, Netflix style: "Not for me" (-1), "I like this" (1), "Love this!" (2), plus
 * trailers watched as a light positive signal. Each entry keeps a small snapshot of the title so
 * the recommender and My Nova can use it without refetching.
 */
(function (g) {
  'use strict';

  var ratings = U.store.get('ratings', {});   // id -> { r, at, lite }
  var trailers = U.store.get('trailersSeen', {}); // id -> { at, lite }
  var listeners = [];
  var version = U.store.get('ratingsVer', 0);

  function snap(m) {
    return {
      id: m.id, type: m.type, name: m.name, poster: m.poster, bg: m.bg, bgLarge: m.bgLarge, logo: m.logo,
      genres: (m.genres || []).slice(0, 4), year: m.year, rating: m.rating, desc: (m.desc || '').slice(0, 220),
      cast: (m.cast || []).slice(0, 3), director: (m.director || []).slice(0, 2), runtime: m.runtime, trailer: m.trailer
    };
  }

  function emit(id, r) {
    version++;
    U.store.set('ratingsVer', version);
    listeners.forEach(function (fn) { try { fn(id, r); } catch (e) {} });
  }

  var LABELS = { '-1': 'Not for me', '1': 'I like this', '2': 'Love this!' };

  g.Ratings = {
    LABELS: LABELS,
    // Persistent fingerprint: changes whenever a rating is added, changed or removed.
    sig: function () {
      var latest = 0, n = 0;
      Object.keys(ratings).forEach(function (k) { n++; if (ratings[k].at > latest) latest = ratings[k].at; });
      return n + ':' + latest + ':' + version;
    },

    get: function (id) { var e = ratings[id]; return e ? e.r : 0; },

    set: function (item, r) {
      if (!item || !item.id) return;
      if (!r || ratings[item.id] && ratings[item.id].r === r) delete ratings[item.id];
      else ratings[item.id] = { r: r, at: Date.now(), lite: snap(item) };
      U.store.set('ratings', ratings);
      emit(item.id, Ratings.get(item.id));
    },

    isDisliked: function (id) { return !!(ratings[id] && ratings[id].r < 0); },

    // [{ r, at, lite }] newest first, optionally filtered.
    list: function (filter) {
      return Object.keys(ratings).map(function (k) { return ratings[k]; })
        .filter(function (e) { return !filter || filter(e); })
        .sort(function (a, b) { return b.at - a.at; });
    },

    trailerSeen: function (item) {
      if (!item || !item.id) return;
      trailers[item.id] = { at: Date.now(), lite: snap(item) };
      var keys = Object.keys(trailers);
      if (keys.length > 60) {
        keys.sort(function (a, b) { return trailers[a].at - trailers[b].at; }).slice(0, keys.length - 60).forEach(function (k) { delete trailers[k]; });
      }
      U.store.setLater('trailersSeen', trailers, 3000);
    },

    trailersSeen: function () {
      return Object.keys(trailers).map(function (k) { return trailers[k]; }).sort(function (a, b) { return b.at - a.at; });
    },

    onChange: function (fn) { listeners.push(fn); }
  };
})(window);
