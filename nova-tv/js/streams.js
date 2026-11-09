/*
 * Stream selection: parse what each addon returns, rank by "will this start fast and play
 * cleanly on this TV", and turn the winner into a playable URL. The user never has to look at
 * a source list unless they want to.
 *
 * TV-specific rules (Samsung 2018-2022 panels, e.g. The Frame LS03B):
 *  - No DTS / TrueHD decoding  -> heavy penalty (silent or failing playback).
 *  - No Dolby Vision           -> DV-only files show green/purple tint; penalised unless HDR10 too.
 *  - HEVC / AV1 / HDR10(+)     -> fine.
 */
(function (g) {
  'use strict';

  var RES_RANK = { 2160: 4, 1440: 3.5, 1080: 3, 720: 2, 576: 1.4, 480: 1, 0: 2.2 };

  function textOf(s) {
    var bh = s.behaviorHints || {};
    return [s.name, s.title, s.description, bh.filename].filter(Boolean).join(' \n ');
  }

  function parse(s) {
    var t = textOf(s);
    var bh = s.behaviorHints || {};
    var res = /2160p|\b4k\b|\buhd\b/i.test(t) ? 2160 : /1440p/i.test(t) ? 1440 : /1080p|\bfhd\b/i.test(t) ? 1080 : /720p/i.test(t) ? 720 : /576p/i.test(t) ? 576 : /480p|\bsd\b/i.test(t) ? 480 : 0;
    var sizeGB = 0;
    var sm = t.match(/(\d+(?:[.,]\d+)?)\s*(gb|gib|mb|mib)\b/i);
    if (sm) sizeGB = parseFloat(sm[1].replace(',', '.')) / (/m/i.test(sm[2]) ? 1024 : 1);
    if (!sizeGB && bh.videoSize) sizeGB = bh.videoSize / 1073741824;
    var seeds = 0;
    var sd = t.match(/👤\s*(\d+)/) || t.match(/seed(?:s|ers)?\s*[:=]?\s*(\d+)/i);
    if (sd) seeds = parseInt(sd[1], 10);
    var debrid = /\[(rd|ad|pm|dl|tb|ed|oc|pp|pk|en|dr)[+ ]|\b(real-?debrid|alldebrid|premiumize|debrid-?link|torbox|easydebrid)\b|\b(RD|AD|PM|TB)\+/i.test(t);
    var cached = /\[(rd|ad|pm|dl|tb|ed|oc|pp|pk|en|dr)\+\]|⚡|\binstant\b|\bcached\b|\b(RD|AD|PM|TB)\+/i.test(t);
    var uncached = /\[(rd|ad|pm|dl|tb|ed|oc|pp|pk|en|dr) download\]|⏳|\buncached\b|\bdownload\]/i.test(t);
    return {
      res: res,
      hdr: /hdr10\+?|\bhdr\b|\bhlg\b/i.test(t),
      dv: /\b(dv|dovi|dolby[ .-]?vision)\b/i.test(t),
      hevc: /x265|hevc|h\.?265/i.test(t),
      av1: /\bav1\b/i.test(t),
      badAudio: /\bdts\b|dts-?hd|dts-?x|truehd|true-hd/i.test(t) && !/\b(aac|ac3|eac3|ddp|dd\+|dd5|dolby digital)\b/i.test(t),
      remux: /remux/i.test(t),
      cam: /\b(cam|camrip|hdcam|ts|telesync|tc|telecine|hdts)\b/i.test(t),
      // Foreign dubs: tagged releases, Cyrillic titles, or Torrentio language flags without UK/US.
      dub: /\b(vff|vfq|vfi|vf2|truefrench|french|fran[cç]ais|castellano|latino|espa[nñ]ol|italiano|ita|german|deutsch|russian|rus|hindi|tamil|telugu|turkish|dublado|subfrench)\b/i.test(t) || /[\u0400-\u04FF]/.test(t) || (/[\uD83C][\uDDE6-\uDDFF]/.test(t) && !/\uD83C\uDDEC\uD83C\uDDE7|\uD83C\uDDFA\uD83C\uDDF8/.test(t)),
      multi: /\bmulti\b/i.test(t),
      english: /\b(eng|english)\b/i.test(t) || /\uD83C\uDDEC\uD83C\uDDE7|\uD83C\uDDFA\uD83C\uDDF8/.test(t),
      sizeGB: sizeGB,
      seeds: seeds,
      torrent: !!s.infoHash && !s.url,
      debrid: debrid,
      cached: cached,
      uncached: uncached,
      http: !!s.url && /^https?:/i.test(s.url),
      hls: !!s.url && /\.m3u8(\?|$)/i.test(s.url),
      bingeGroup: bh.bingeGroup || null,
      label: shortLabel(s, res)
    };
  }

  function shortLabel(s, res) {
    var name = (s.name || s._addon || '').replace(/\n/g, ' ').trim();
    var first = (s.title || s.description || '').split('\n')[0].trim();
    return { name: name, title: first, res: res };
  }

  function score(s, p, ctx) {
    var sc = 0;
    var pref = RES_RANK[ctx.quality] || 3;
    var r = RES_RANK[p.res] != null ? RES_RANK[p.res] : 2.2;
    sc += 40 - (r > pref ? 8 : 14) * Math.abs(r - pref);
    if (p.cached) sc += 38;
    else if (p.http && !p.debrid) sc += 14;
    if (p.uncached) sc -= 70;
    if (p.torrent) sc += Math.min(18, Math.log2(p.seeds + 1) * 3) - (p.seeds === 0 ? 45 : 0) - 6;
    if (p.dv && !p.hdr) sc -= 55; else if (p.dv) sc -= 4;
    if (p.badAudio) sc -= 48;
    if (p.remux) sc -= 18;
    if (p.cam) sc -= 80;
    if (p.dub && !p.english) sc -= 32;
    else if (p.multi || p.dub) sc -= 6;
    if (p.sizeGB > 30) sc -= 22;
    else if (p.sizeGB > 14 && p.res < 2160) sc -= 10;
    if (p.sizeGB && p.sizeGB < 0.35 && p.res >= 1080) sc -= 15;
    // Stick with the release group from the last episode — unless it is a foreign dub (a group
    // remembered from an earlier wrong pick must never lock the show into French audio).
    if (ctx.bingeGroup && p.bingeGroup === ctx.bingeGroup && !(p.dub && !p.english)) sc += 90;
    if (ctx.lastAddon && s._addon === ctx.lastAddon) sc += 6;
    sc -= (s._order || 0) * 1.5;
    return sc;
  }

  function playable(s, ctx) {
    if (s.ytId || s.externalUrl) return false;
    if (s.url) return /^https?:/i.test(s.url);
    if (s.infoHash) return !!ctx.server;
    return false;
  }

  var Streams = {
    parse: parse,

    // null = never configured -> use the build default; '' = explicitly off.
    server: function () {
      var v = U.store.get('server', null);
      return v == null ? ((g.NOVA_CONFIG || {}).defaultServer || '') : v;
    },

    context: function (extra) {
      return Object.assign({
        quality: parseInt(U.store.get('quality', 1080), 10),
        server: Streams.server()
      }, extra || {});
    },

    rank: function (streams, ctx) {
      ctx = ctx || this.context();
      return streams.filter(function (s) { return playable(s, ctx); }).map(function (s) {
        var p = parse(s);
        return { s: s, p: p, score: score(s, p, ctx) };
      }).sort(function (a, b) { return b.score - a.score; });
    },

    urlFor: function (s, ctx) {
      ctx = ctx || this.context();
      if (s.url) return s.url;
      if (s.infoHash) {
        var srv = ctx.server.replace(/\/$/, '');
        var idx = s.fileIdx == null ? -1 : s.fileIdx;
        var trackers = (s.sources || []).filter(function (x) { return /^tracker:/.test(x); }).map(function (x) { return 'tr=' + encodeURIComponent(x.replace(/^tracker:/, '')); });
        return srv + '/' + s.infoHash + '/' + idx + (trackers.length ? '?' + trackers.join('&') : '');
      }
      return null;
    },

    /**
     * Resolve the best source for a video. Starts playback-ready as soon as a "good enough"
     * candidate shows up (score above threshold) instead of waiting for the slowest addon.
     */
    resolve: function (type, videoId, ctx) {
      ctx = ctx || this.context();
      var self = this;
      return new Promise(function (resolve) {
        var done = false;
        var latest = [];
        var finish = function (list) {
          if (done) return;
          done = true;
          var ranked = self.rank(list, ctx);
          console.log('streams', videoId, 'raw', list.length, 'playable', ranked.length, JSON.stringify(ranked.slice(0, 3).map(function (r) {
            return [Math.round(r.score), r.p.res, r.p.cached ? 'cached' : '', r.p.torrent ? 'torrent' : 'http', (r.p.label.title || '').slice(0, 70)];
          })));
          resolve(ranked);
        };
        var early = setTimeout(function () { if (latest.length) finish(latest); }, 6000);
        Addons.streams(type, videoId, function (partial) {
          latest = partial;
          var ranked = self.rank(partial, ctx);
          // Great match (cached / same release group) => go now.
          if (ranked.length && ranked[0].score >= (ctx.bingeGroup ? 120 : 70)) { clearTimeout(early); finish(partial); }
        }).then(function (all) { clearTimeout(early); finish(all); });
      });
    },

    // Kick the source so it is hot when we actually play it (debrid unrestrict / torrent swarm).
    prewarm: function (candidate, ctx) {
      var url = this.urlFor(candidate.s, ctx);
      if (!url) return;
      U.warm(url, candidate.p.torrent ? 12000 : 0);
    }
  };

  g.Streams = Streams;
})(window);
