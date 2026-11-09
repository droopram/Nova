/* Fetch worker: downloads catalog and stream JSON, parses and slims it here, and posts back only
 * what the app uses. Keeps megabytes of JSON.parse off the UI thread. */
importScripts('lite.js');

self.onmessage = function (e) {
  var job = e.data;
  var ctrl = new AbortController();
  var timer = setTimeout(function () { ctrl.abort(); }, job.timeout || 15000);
  fetch(job.url, { signal: ctrl.signal })
    .then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function (data) {
      clearTimeout(timer);
      if (job.kind === 'streams') { self.postMessage({ id: job.id, ok: true, items: slimStreams(data && data.streams) }); return; }
      if (job.kind === 'episodes') { self.postMessage({ id: job.id, ok: true, items: slimEpisodes(data && (data.metasDetailed || data.metas)) }); return; }
      var metas = (data && data.metas) || [];
      var out = [];
      for (var i = 0; i < metas.length; i++) {
        var m = metas[i];
        if (!m.type) m.type = job.type;
        var l = self.Lite(m, job.addonId);
        if (l) out.push(l);
      }
      self.postMessage({ id: job.id, ok: true, items: out });
    })
    .catch(function (err) {
      clearTimeout(timer);
      self.postMessage({ id: job.id, ok: false, error: String(err && err.message || err) });
    });
};

// Keep only the stream fields the ranker and player read. Tracker lists ('sources') are only
// needed for torrents played through the streaming server.
function slimStreams(list) {
  var out = [];
  (list || []).forEach(function (s) {
    if (!s) return;
    var bh = s.behaviorHints || {};
    var o = { name: s.name, title: s.title, description: s.description };
    if (s.url) o.url = s.url;
    if (s.infoHash) { o.infoHash = s.infoHash; o.fileIdx = s.fileIdx; if (!s.url && s.sources) o.sources = s.sources.slice(0, 30); }
    if (s.ytId) o.ytId = s.ytId;
    if (s.externalUrl) o.externalUrl = s.externalUrl;
    o.behaviorHints = { bingeGroup: bh.bingeGroup, filename: bh.filename, videoSize: bh.videoSize, videoHash: bh.videoHash, notWebReady: bh.notWebReady };
    out.push(o);
  });
  return out;
}

// Cinemeta last-videos / calendar-videos: per show, the newest aired episode and the next one
// scheduled, plus the card fields. Drops the (large) full episode lists.
function slimEpisodes(metas) {
  var now = Date.now(), out = [];
  (metas || []).forEach(function (m) {
    if (!m || !m.id) return;
    var latest = null, next = null;
    (m.videos || []).forEach(function (v) {
      if (!v.released || !v.season) return;
      var t = Date.parse(v.released);
      var ep = { id: v.id, season: v.season, episode: v.episode || v.number, released: v.released, title: v.name || v.title || '' };
      if (t <= now + 864e5) { if (!latest || t > Date.parse(latest.released)) latest = ep; }
      else if (!next || t < Date.parse(next.released)) next = ep;
    });
    if (!m.type) m.type = 'series';
    var l = self.Lite(m);
    if (!l) return;
    l.latestEp = latest; l.nextEp = next;
    out.push(l);
  });
  return out;
}
