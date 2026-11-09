/* Small shared helpers: DOM, storage, fetch with caching and a concurrency limit. */
(function (g) {
  'use strict';

  var IS_TIZEN = typeof g.tizen !== 'undefined';

  // Dev-only remote log mirror (see NOVA_CONFIG.logUrl).
  var LOG_URL = g.NOVA_CONFIG && g.NOVA_CONFIG.logUrl;
  if (LOG_URL) {
    var send = function (level, args) {
      try {
        var msg = Array.prototype.map.call(args, function (a) { return a && a.stack ? a.stack : typeof a === 'object' ? JSON.stringify(a) : String(a); }).join(' ');
        fetch(LOG_URL, { method: 'POST', body: level + ' ' + msg, mode: 'no-cors' }).catch(function () {});
      } catch (e) {}
    };
    ['log', 'warn', 'error'].forEach(function (lvl) {
      var orig = console[lvl].bind(console);
      console[lvl] = function () { send(lvl, arguments); orig.apply(null, arguments); };
    });
    g.addEventListener('error', function (e) { send('uncaught', [e.message + ' @ ' + e.filename + ':' + e.lineno + ':' + e.colno + (e.error && e.error.stack ? '\n' + e.error.stack.split('\n').slice(0, 6).join('\n') : '')]); });
    g.addEventListener('unhandledrejection', function (e) { send('rejection', [e.reason]); });
    // Main-thread tasks over 50 ms are what the eye sees as stutter; report them from the TV.
    try {
      new PerformanceObserver(function (list) {
        list.getEntries().forEach(function (en) { send('longtask', [Math.round(en.duration) + 'ms at ' + Math.round(en.startTime) + 'ms']); });
      }).observe({ entryTypes: ['longtask'] });
    } catch (e) {}
  }

  function h(tag, attrs, children) {
    var el = document.createElement(tag);
    if (attrs) {
      for (var k in attrs) {
        var v = attrs[k];
        if (v == null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'html') el.innerHTML = v;
        else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
        else if (k.slice(0, 2) === 'on' && typeof v === 'function') el[k.toLowerCase()] = v;
        else if (k[0] === '_') el[k] = v;
        else el.setAttribute(k, v === true ? '' : v);
      }
    }
    if (children != null) append(el, children);
    return el;
  }

  function append(el, children) {
    if (!Array.isArray(children)) children = [children];
    for (var i = 0; i < children.length; i++) {
      var c = children[i];
      if (c == null || c === false) continue;
      el.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
    }
    return el;
  }

  function $(sel, root) { return (root || document).querySelector(sel); }
  function $$(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); }

  var pending = Object.create(null), pendingTimers = Object.create(null);
  var store = {
    get: function (k, def) {
      try { var v = localStorage.getItem('nova.' + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; }
    },
    set: function (k, v) {
      var t0 = performance.now();
      try {
        var str = JSON.stringify(v);
        localStorage.setItem('nova.' + k, str);
        var dt = performance.now() - t0;
        if (dt > 30) console.log('perf store.set', k, Math.round(str.length / 1024) + 'KB', Math.round(dt) + 'ms');
      } catch (e) {
        // Quota hit: drop disposable caches and retry once.
        store.purgeCaches();
        try { localStorage.setItem('nova.' + k, JSON.stringify(v)); } catch (e2) { /* give up */ }
      }
    },
    del: function (k) { try { localStorage.removeItem('nova.' + k); } catch (e) {} },
    // Coalesce frequent writes of big values (library, progress) into one write per key.
    setLater: function (k, v, ms) {
      pending[k] = v;
      clearTimeout(pendingTimers[k]);
      pendingTimers[k] = setTimeout(function () { var x = pending[k]; delete pending[k]; store.set(k, x); }, ms || 2000);
    },
    flush: function () {
      Object.keys(pending).forEach(function (k) { clearTimeout(pendingTimers[k]); store.set(k, pending[k]); delete pending[k]; });
    },
    purgeCaches: function () {
      try {
        Object.keys(localStorage).forEach(function (k) { if (k.indexOf('nova.c.') === 0) localStorage.removeItem(k); });
      } catch (e) {}
    }
  };

  // ---- fetch with timeout, memory + persistent cache, and a global concurrency cap ----
  var MAX_PARALLEL = 6;
  var active = 0;
  var queue = [];
  var mem = Object.create(null);
  var inflight = Object.create(null);

  function slot() {
    if (active < MAX_PARALLEL) { active++; return Promise.resolve(); }
    return new Promise(function (res) { queue.push(res); });
  }
  function release() {
    var next = queue.shift();
    if (next) next(); else active--;
  }

  function rawFetch(url, opts) {
    opts = opts || {};
    var timeout = opts.timeout || 15000;
    var ctrl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctrl) ctrl.abort(); }, timeout);
    var init = { method: opts.method || 'GET', headers: opts.headers || {} };
    if (ctrl) init.signal = ctrl.signal;
    if (opts.body != null) {
      init.body = typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body);
      init.headers['Content-Type'] = 'application/json';
    }
    return slot().then(function () {
      return fetch(url, init);
    }).then(function (r) {
      clearTimeout(timer); release();
      if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
      if (opts.text) return r.text();
      return r.text().then(function (txt) {
        var t0 = performance.now();
        var v = JSON.parse(txt);
        var dt = performance.now() - t0;
        if (dt > 30) console.log('perf JSON.parse', Math.round(txt.length / 1024) + 'KB', Math.round(dt) + 'ms', url.replace(/^https?:\/\/([^/]+).*$/, '$1'));
        return v;
      });
    }, function (e) {
      clearTimeout(timer); release();
      throw e;
    });
  }

  /**
   * getJSON(url, {ttl: seconds, persist: bool})
   * Memory cache always; localStorage cache when persist is set. Concurrent identical
   * requests share one network call.
   */
  function getJSON(url, opts) {
    opts = opts || {};
    var ttl = (opts.ttl == null ? 600 : opts.ttl) * 1000;
    var now = Date.now();
    var m = mem[url];
    if (m && now - m.t < ttl) return Promise.resolve(m.v);
    if (opts.persist) {
      var p = store.get('c.' + url);
      if (p && now - p.t < ttl) { mem[url] = p; return Promise.resolve(p.v); }
    }
    if (inflight[url]) return inflight[url];
    var pr = rawFetch(url, opts).then(function (v) {
      delete inflight[url];
      var entry = { t: Date.now(), v: v };
      mem[url] = entry;
      if (opts.persist) store.set('c.' + url, entry);
      return v;
    }, function (e) { delete inflight[url]; throw e; });
    inflight[url] = pr;
    return pr;
  }

  // ---- catalog fetches through the worker (falls back to the main thread) ----
  var worker = null, jobs = Object.create(null), jobSeq = 0, liteMem = Object.create(null), liteInflight = Object.create(null);
  try { worker = new Worker('js/worker.js'); } catch (e) { worker = null; }
  if (worker) {
    worker.onmessage = function (e) {
      var j = jobs[e.data.id];
      if (!j) return;
      delete jobs[e.data.id];
      if (e.data.ok) j.resolve(e.data.items); else j.reject(new Error(e.data.error));
    };
    worker.onerror = function () { worker = null; };
  }

  function catalogJSON(url, opts) {
    var ttl = (opts.ttl == null ? 600 : opts.ttl) * 1000;
    var hit = liteMem[url];
    if (hit && Date.now() - hit.t < ttl) return Promise.resolve(hit.v);
    if (liteInflight[url]) return liteInflight[url];
    // opts.direct skips the shared queue (search: typed queries must not wait behind row loads
    // or behind a previous query's slow addon).
    var gate = opts.direct ? function () { return Promise.resolve(); } : slot;
    var done = opts.direct ? function () {} : release;
    var run = worker
      ? gate().then(function () {
          return new Promise(function (resolve, reject) {
            var id = ++jobSeq;
            jobs[id] = { resolve: resolve, reject: reject };
            worker.postMessage({ id: id, url: url, kind: opts.kind, type: opts.type, addonId: opts.addonId, timeout: opts.timeout || 15000 });
          }).then(function (v) { done(); return v; }, function (e) { done(); throw e; });
        })
      : rawFetch(url, opts).then(function (r) {
          if (opts.kind === 'streams') return r.streams || [];
          return (r.metas || []).map(function (m) { if (!m.type) m.type = opts.type; return g.Lite(m, opts.addonId); }).filter(Boolean);
        });
    var p = run.then(function (v) { delete liteInflight[url]; liteMem[url] = { t: Date.now(), v: v }; return v; },
      function (e) { delete liteInflight[url]; throw e; });
    liteInflight[url] = p;
    return p;
  }

  function postJSON(url, body, opts) {
    opts = Object.assign({}, opts || {}, { method: 'POST', body: body });
    return rawFetch(url, opts);
  }

  function debounce(fn, ms) {
    var t;
    return function () {
      var a = arguments, self = this;
      clearTimeout(t);
      t = setTimeout(function () { fn.apply(self, a); }, ms);
    };
  }

  function fmtTime(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    var hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
    return (hh ? hh + ':' + (mm < 10 ? '0' : '') : '') + mm + ':' + (ss < 10 ? '0' : '') + ss;
  }

  function fmtLeft(sec) {
    var m = Math.round(sec / 60);
    if (m < 60) return m + 'm';
    return Math.floor(m / 60) + 'h ' + (m % 60) + 'm';
  }

  function hashStr(s) {
    var x = 2166136261;
    for (var i = 0; i < s.length; i++) { x ^= s.charCodeAt(i); x = Math.imul(x, 16777619); }
    return (x >>> 0) / 4294967295;
  }

  function uniqBy(arr, key) {
    var seen = Object.create(null), out = [];
    for (var i = 0; i < arr.length; i++) {
      var k = key(arr[i]);
      if (k == null || seen[k]) continue;
      seen[k] = 1; out.push(arr[i]);
    }
    return out;
  }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // Warm a source: follow its redirects (debrid unrestrict, addon resolve) and stop as soon as
  // the response headers arrive, so no video bytes are downloaded twice. Torrents get a longer
  // hold so the streaming server can find peers.
  function warm(url, ms) {
    try {
      var ctrl = new AbortController();
      var hold = ms || 0;
      fetch(url, { mode: 'no-cors', signal: ctrl.signal, cache: 'no-store' })
        .then(function () { setTimeout(function () { ctrl.abort(); }, hold); }, function () {});
      setTimeout(function () { ctrl.abort(); }, Math.max(hold, 8000));
    } catch (e) {}
  }

  g.U = {
    IS_TIZEN: IS_TIZEN, h: h, append: append, $: $, $$: $$, store: store,
    getJSON: getJSON, postJSON: postJSON, catalogJSON: catalogJSON, fetchText: function (u, o) { return rawFetch(u, Object.assign({ text: true }, o || {})); },
    debounce: debounce, fmtTime: fmtTime, fmtLeft: fmtLeft, hashStr: hashStr, uniqBy: uniqBy, sleep: sleep, warm: warm
  };
})(window);
