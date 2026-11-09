/* Stremio addon protocol client: catalogs, meta, streams, subtitles, search. */
(function (g) {
  'use strict';

  var CINEMETA = 'https://v3-cinemeta.strem.io/manifest.json';
  var OPENSUBS = 'https://opensubtitles-v3.strem.io/manifest.json';

  function base(url) { return url.replace(/\/manifest\.json$/, ''); }

  function resourceEntry(addon, name) {
    var res = addon.manifest.resources || [];
    for (var i = 0; i < res.length; i++) {
      var r = res[i];
      if (r === name) return { name: name };
      if (r && r.name === name) return r;
    }
    return null;
  }

  function supports(addon, resource, type, id) {
    var e = resourceEntry(addon, resource);
    if (!e) return false;
    var types = e.types || addon.manifest.types || [];
    if (type && types.length && types.indexOf(type) === -1) return false;
    var prefixes = e.idPrefixes || addon.manifest.idPrefixes;
    if (id && prefixes && prefixes.length) {
      var ok = false;
      for (var i = 0; i < prefixes.length; i++) if (id.indexOf(prefixes[i]) === 0) { ok = true; break; }
      if (!ok) return false;
    }
    return true;
  }

  function url(addon, resource, type, id, extra) {
    var u = base(addon.transportUrl) + '/' + resource + '/' + type + '/' + encodeURIComponent(id);
    if (extra) {
      var parts = [];
      for (var k in extra) if (extra[k] != null && extra[k] !== '') parts.push(k + '=' + encodeURIComponent(extra[k]));
      if (parts.length) u += '/' + parts.join('&');
    }
    return u + '.json';
  }

  // Search ranking: lower case, no accents or punctuation, no leading article.
  function norm(t) {
    t = String(t || '').toLowerCase();
    if (t.normalize) t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return t.replace(/[^a-z0-9]+/g, ' ').trim().replace(/^(the|a|an) /, '');
  }

  function relevance(name, q) {
    if (!q) return 0;
    if (name === q) return 4;
    if (name.indexOf(q) === 0) return 3;
    if ((' ' + name).indexOf(' ' + q) !== -1) return 2;   // a word starts with it
    return name.indexOf(q) !== -1 ? 1 : 0;
  }

  function lite(m, addon) { return Lite(m, addon ? addon.manifest.id : undefined); }

  var Addons = {
    list: [],

    init: function () {
      var cached = U.store.get('addons', null);
      this.list = cached && cached.length ? cached : this.defaults();
    },

    defaults: function () {
      return [
        { transportUrl: CINEMETA, manifest: { id: 'com.linvo.cinemeta', name: 'Cinemeta', resources: ['catalog', 'meta'], types: ['movie', 'series'], idPrefixes: ['tt'], catalogs: [
          { type: 'movie', id: 'top', name: 'Popular', extra: [{ name: 'genre' }, { name: 'search' }, { name: 'skip' }] },
          { type: 'series', id: 'top', name: 'Popular', extra: [{ name: 'genre' }, { name: 'search' }, { name: 'skip' }] },
          { type: 'movie', id: 'year', name: 'New', extra: [{ name: 'genre', isRequired: true }] },
          { type: 'series', id: 'year', name: 'New', extra: [{ name: 'genre', isRequired: true }] },
          { type: 'movie', id: 'imdbRating', name: 'Featured', extra: [{ name: 'genre' }, { name: 'skip' }] },
          { type: 'series', id: 'imdbRating', name: 'Featured', extra: [{ name: 'genre' }, { name: 'skip' }] }
        ] } },
        { transportUrl: OPENSUBS, manifest: { id: 'org.stremio.opensubtitlesv3', name: 'OpenSubtitles v3', resources: ['subtitles'], types: ['movie', 'series'], idPrefixes: ['tt'], catalogs: [] } }
      ];
    },

    refresh: function () {
      var self = this;
      if (!Api.loggedIn) { this.list = this.defaults(); return Promise.resolve(this.list); }
      return Api.getAddons().then(function (addons) {
        addons = addons.filter(function (a) { return a && a.manifest && a.transportUrl; });
        if (!addons.some(function (a) { return a.manifest.id === 'com.linvo.cinemeta'; })) addons.unshift(self.defaults()[0]);
        // Strip fields we never use so the cache stays small.
        var slim = addons.map(function (a) {
          var m = a.manifest;
          return { transportUrl: a.transportUrl, manifest: { id: m.id, name: m.name, resources: m.resources, types: m.types, idPrefixes: m.idPrefixes, catalogs: (m.catalogs || []).map(function (c) {
            return { type: c.type, id: c.id, name: c.name, extra: c.extra || (c.extraSupported || []).map(function (n) { return { name: n, isRequired: (c.extraRequired || []).indexOf(n) !== -1 }; }) };
          }) } };
        });
        self.list = slim;
        U.store.set('addons', slim);
        return slim;
      });
    },

    cinemeta: function () {
      return this.list.filter(function (a) { return a.manifest.id === 'com.linvo.cinemeta'; })[0] || this.defaults()[0];
    },

    // Catalogs that can be shown as a row without user input.
    browsableCatalogs: function () {
      var out = [];
      this.list.forEach(function (a) {
        (a.manifest.catalogs || []).forEach(function (c) {
          var required = (c.extra || []).some(function (e) { return e.isRequired; });
          if (required) return;
          out.push({ addon: a, type: c.type, id: c.id, name: c.name, extra: c.extra || [] });
        });
      });
      return out;
    },

    // Catalogs are fetched, parsed and slimmed in a worker; callers get fresh copies so row
    // builders can annotate items (match %, scores) without leaking into other rows.
    catalog: function (addon, type, id, extra, ttl) {
      return U.catalogJSON(url(addon, 'catalog', type, id, extra), { ttl: ttl || 3600, type: type, addonId: addon.manifest.id }).then(function (list) {
        return list.map(function (m) { return Object.assign({}, m); });
      });
    },

    meta: function (type, id) {
      var list = this.list.filter(function (a) { return supports(a, 'meta', type, id); });
      // Cinemeta first for tt ids; it has the richest data.
      list.sort(function (a, b) { return (b.manifest.id === 'com.linvo.cinemeta') - (a.manifest.id === 'com.linvo.cinemeta'); });
      var i = 0;
      function next() {
        if (i >= list.length) return Promise.reject(new Error('No metadata for ' + id));
        var a = list[i++];
        return U.getJSON(url(a, 'meta', type, id), { ttl: 6 * 3600, persist: type === 'movie' }).then(function (r) {
          if (!r || !r.meta) return next();
          return r.meta;
        }, next);
      }
      return next();
    },

    lite: lite,

    /**
     * Ask every stream addon in parallel. onPartial(allSoFar) fires as each addon answers so
     * the UI can start playing as soon as one good source exists.
     */
    streams: function (type, videoId, onPartial) {
      var list = this.list.filter(function (a) { return supports(a, 'stream', type, videoId); });
      var all = [];
      var jobs = list.map(function (a, order) {
        return U.catalogJSON(url(a, 'stream', type, videoId), { kind: 'streams', ttl: 1800, timeout: 14000 }).then(function (streams) {
          streams.forEach(function (s0) { var s = Object.assign({}, s0); s._addon = a.manifest.name; s._order = order; all.push(s); });
          if (onPartial) onPartial(all.slice());
        }).catch(function (e) { console.warn('stream addon failed', a.manifest.name, e.message); });
      });
      return Promise.all(jobs).then(function () { return all; });
    },

    subtitles: function (type, id, extra) {
      var list = this.list.filter(function (a) { return supports(a, 'subtitles', type, id); });
      return Promise.all(list.map(function (a) {
        return U.getJSON(url(a, 'subtitles', type, id, extra), { ttl: 3600, timeout: 10000 }).then(function (r) {
          return (r.subtitles || []).map(function (s) { s._addon = a.manifest.name; return s; });
        }).catch(function () { return []; });
      })).then(function (lists) { return [].concat.apply([], lists); });
    },

    /**
     * Searches every addon catalog that supports it. Results stream in: onPartial(list) gets the
     * merged, ranked list each time another addon answers, so one slow or broken addon never
     * holds the rest back. Resolves with the final list.
     */
    search: function (query, onPartial) {
      var q = norm(query);
      var lists = [];
      var jobs = [];
      function merged() {
        var all = U.uniqBy([].concat.apply([], lists), function (m) { return m.id; }).filter(function (m) { return m && m.id && m.name; });
        all.forEach(function (m) { m._rel = relevance(norm(m.name), q) + Math.min(1, Math.log(1 + (m.pop || 0)) / 5); });
        return all.sort(function (a, b) { return b._rel - a._rel; });
      }
      this.list.forEach(function (a) {
        (a.manifest.catalogs || []).forEach(function (c) {
          var hasSearch = (c.extra || []).some(function (e) { return e.name === 'search'; });
          if (!hasSearch) return;
          var u = url(a, 'catalog', c.type, c.id, { search: query });
          jobs.push(U.catalogJSON(u, { ttl: 600, type: c.type, addonId: a.manifest.id, timeout: 8000, direct: true }).then(function (list) {
            lists.push((list || []).map(function (m) { return Object.assign({}, m); }));
            if (onPartial) onPartial(merged());
          }, function (e) { console.warn('search failed', a.manifest.name, c.type, e && e.message); }));
        });
      });
      return Promise.all(jobs).then(merged);
    }
  };

  g.Addons = Addons;
})(window);
