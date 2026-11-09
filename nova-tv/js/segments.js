/* Intro / recap / credits timestamps from TheIntroDB (https://theintrodb.org), a free community
 * database. Used for the Skip Intro / Skip Recap button and to bring the next-episode card up
 * when the credits really start. Lookups are by IMDb id (+ season/episode), cached on the TV. */
(function (g) {
  'use strict';

  var API = 'https://api.theintrodb.org/v4/media';
  var TTL = 7 * 864e5;       // found: a week
  var MISS_TTL = 864e5;      // not in the database (yet): a day
  var mem = {};

  function keyFor(metaId, video) {
    return metaId + (video && video.season != null ? ':' + video.season + ':' + (video.episode != null ? video.episode : video.number) : '');
  }

  // [{ start_ms, end_ms }] -> [{ start, end }] in seconds; null start = 0, null end = to the end.
  function toSec(list, dur) {
    return (list || []).map(function (s) {
      return { start: s.start_ms == null ? 0 : s.start_ms / 1000, end: s.end_ms == null ? dur || Infinity : s.end_ms / 1000 };
    }).filter(function (s) { return s.end > s.start; });
  }

  function parse(j, dur) {
    return { intro: toSec(j.intro, dur), recap: toSec(j.recap, dur), credits: toSec(j.credits, dur) };
  }

  var Segments = {
    /**
     * Segments for a movie or episode: { intro, recap, credits } (arrays of {start, end} in
     * seconds), or null when unknown. `dur` (seconds) helps the database pick the right cut.
     */
    get: function (meta, video, dur) {
      if (!meta || !/^tt\d{7,8}$/.test(meta.id)) return Promise.resolve(null);
      var series = meta.type === 'series';
      var season = video && video.season, episode = video && (video.episode != null ? video.episode : video.number);
      if (series && (season == null || episode == null)) return Promise.resolve(null);
      var key = keyFor(meta.id, video);
      if (mem[key]) return mem[key];
      var stored = U.store.get('seg.' + key, null);
      if (stored && Date.now() - stored.t < (stored.miss ? MISS_TTL : TTL)) {
        return (mem[key] = Promise.resolve(stored.miss ? null : parse(stored.j, dur)));
      }
      var url = API + '?imdb_id=' + meta.id + (series ? '&season=' + season + '&episode=' + episode : '') +
        (dur ? '&duration_ms=' + Math.round(dur * 1000) : '');
      var p = U.getJSON(url, { ttl: 0, timeout: 6000 }).then(function (j) {
        var found = j && (j.intro || j.recap || j.credits);
        U.store.set('seg.' + key, found ? { t: Date.now(), j: { intro: j.intro, recap: j.recap, credits: j.credits } } : { t: Date.now(), miss: true });
        return found ? parse(j, dur) : null;
      }).catch(function (e) {
        // 404 = no submissions for this title; anything else (offline, rate limit): try again later.
        if (e && /HTTP 404/.test(e.message || '')) U.store.set('seg.' + key, { t: Date.now(), miss: true });
        delete mem[key];
        return null;
      });
      return (mem[key] = p);
    },

    /** The intro or recap the playhead is in (and not near its end), or null. */
    skippable: function (segs, t) {
      if (!segs) return null;
      var kinds = ['recap', 'intro'];
      for (var k = 0; k < kinds.length; k++) {
        var list = segs[kinds[k]];
        for (var i = 0; i < list.length; i++) {
          var s = list[i];
          if (t >= s.start && t < s.end - 1.5 && s.end - s.start >= 5 && s.end - s.start <= 300) return { kind: kinds[k], start: s.start, end: s.end };
        }
      }
      return null;
    },

    /** When the end credits start (the last credits segment that runs to the end), or null. */
    creditsStart: function (segs, dur) {
      if (!segs || !dur) return null;
      var best = null;
      segs.credits.forEach(function (s) {
        // Timestamps from another cut of the episode can land past this file's end: ignore them.
        if (s.end >= dur - 45 && s.start > dur * 0.6 && s.start < dur - 10) best = best == null ? s.start : Math.min(best, s.start);
      });
      return best;
    }
  };

  g.Segments = Segments;
})(window);
