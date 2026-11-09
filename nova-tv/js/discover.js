/* Finds a Stremio streaming server (port 11470) on the local network, so nobody has to know
 * their computer's IP address. The TV's own address tells us which /24 to scan; without it we
 * fall back to the subnets home routers use most. */
(function (g) {
  'use strict';

  var PORT = 11470;
  var COMMON = ['192.168.1', '192.168.0', '192.168.178', '192.168.2', '192.168.68', '192.168.86', '192.168.50', '10.0.0', '10.0.1', '10.1.1'];
  var running = null;

  function isPrivate(ip) {
    return /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)\d+\.\d+/.test(ip || '');
  }

  function prefixOf(ip) {
    var m = /^(\d+\.\d+\.\d+)\.\d+$/.exec(ip || '');
    return m ? m[1] : null;
  }

  // Chromium keeps a TCP connect to an absent host alive until the OS gives up (seconds on the
  // TV, over a minute on macOS), even after the fetch is aborted, and all origins share one
  // pool of 256 sockets. So the scan counts connects that are really still open and keeps
  // well below that, or every other request in the app (and the probe that would hit) queues.
  var MAX_OPEN = 160;
  var open = 0;

  // Settles (true/false) only when the connection really ends.
  function attempt(base) {
    open++;
    return fetch(base.replace(/\/$/, '') + '/settings', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) { return !!(j && typeof j === 'object' && (j.values || j.options || j.baseUrl)); })
      .catch(function () { return false; })
      .then(function (ok) { open--; return ok; });
  }

  function within(p, ms, onLate) {
    var timer;
    return Promise.race([p, new Promise(function (res) { timer = setTimeout(function () { res(onLate); }, ms); })])
      .then(function (v) { clearTimeout(timer); return v; });
  }

  // True when `base` answers like a Stremio streaming server within `ms`.
  function probe(base, ms) { return within(attempt(base), ms || 1500, false); }

  // A subnet is on this network when its .1 answers at all, even with "connection refused",
  // quickly. An address that isn't here hangs instead.
  function subnetHere(prefix) {
    var t0 = Date.now();
    return within(attempt('http://' + prefix + '.1:' + PORT).then(function () { return Date.now() - t0 < 1500; }), 1500, false);
  }

  // ---- the TV's own IPv4 address, from whichever source this platform offers ----

  function tizenIp() {
    return new Promise(function (res) {
      var si;
      try { si = g.tizen && g.tizen.systeminfo; } catch (e) {}
      if (!si) { res(null); return; }
      var pending = 2, found = null;
      function done(ip) { if (!found && isPrivate(ip)) found = ip; if (--pending === 0) res(found); }
      ['ETHERNET_NETWORK', 'WIFI_NETWORK'].forEach(function (prop) {
        try { si.getPropertyValue(prop, function (v) { done(v && v.ipAddress); }, function () { done(null); }); }
        catch (e) { done(null); }
      });
      setTimeout(function () { res(found); }, 2000);
    });
  }

  function webapisIp() {
    try { var ip = g.webapis && g.webapis.network && g.webapis.network.getIp(); return isPrivate(ip) ? ip : null; }
    catch (e) { return null; }
  }

  // Browsers that still expose host ICE candidates reveal the LAN address (Chrome hides it
  // behind an mDNS name, which we skip).
  function webrtcIp() {
    return new Promise(function (res) {
      var PC = g.RTCPeerConnection || g.webkitRTCPeerConnection;
      if (!PC) { res(null); return; }
      var pc, settled = false;
      function finish(ip) { if (settled) return; settled = true; try { pc.close(); } catch (e) {} res(ip); }
      try {
        pc = new PC({ iceServers: [] });
        pc.createDataChannel('x');
        pc.onicecandidate = function (e) {
          if (!e.candidate) { finish(null); return; }
          var m = /(\d+\.\d+\.\d+\.\d+)/.exec(e.candidate.candidate);
          if (m && isPrivate(m[1])) finish(m[1]);
        };
        pc.createOffer().then(function (o) { return pc.setLocalDescription(o); }).catch(function () { finish(null); });
      } catch (e) { finish(null); return; }
      setTimeout(function () { finish(null); }, 1500);
    });
  }

  function ownIp() {
    return tizenIp().then(function (ip) { return ip || webapisIp() || webrtcIp(); });
  }

  // ---- scanning ----

  // Probes every host in `prefix`.1-254; resolves with the first server found, or null.
  function scanSubnet(prefix, skip, onProgress) {
    return new Promise(function (res) {
      var hosts = [];
      for (var i = 2; i < 255; i++) hosts.push(prefix + '.' + i);
      hosts.push(prefix + '.1');
      hosts = hosts.filter(function (ip) { return ip !== skip; });
      var idx = 0, pending = 0, settled = false, started = Date.now(), lastLaunch = started;
      if (onProgress) onProgress(prefix);
      function finish(u) { if (settled) return; settled = true; clearInterval(tick); res(u); }
      function launch() {
        while (!settled && open < MAX_OPEN && idx < hosts.length) {
          pending++; lastLaunch = Date.now();
          (function (base) {
            attempt(base).then(function (ok) {
              pending--;
              if (ok) { finish(base); return; }
              launch();
            });
          })('http://' + hosts[idx++] + ':' + PORT);
        }
        if (!settled && idx >= hosts.length && pending === 0) finish(null);
      }
      // Hosts that never answer: give up on them 4 s after the last one went out, and on the
      // whole subnet after 45 s (addresses that aren't on this network can hang far longer).
      var tick = setInterval(function () {
        launch();
        if ((idx >= hosts.length && Date.now() - lastLaunch > 4000) || Date.now() - started > 45000) finish(null);
      }, 500);
      launch();
    });
  }

  /**
   * Find a Stremio streaming server. Resolves with its base URL or null.
   * opts.onProgress(prefix) is called as each subnet is scanned.
   */
  function find(opts) {
    if (running) return running;
    opts = opts || {};
    var saved = U.store.get('server', '');
    running = Promise.resolve().then(function () {
      // Same machine (browser preview) and the last known address are one probe each.
      var quick = ['http://127.0.0.1:' + PORT];
      if (saved) quick.unshift(saved);
      return Promise.all(quick.map(function (u) { return probe(u, 1200).then(function (ok) { return ok ? u : null; }); }))
        .then(function (r) { return r.filter(Boolean)[0] || null; });
    }).then(function (hit) {
      if (hit) return hit;
      return ownIp().then(function (ip) {
        console.log('discover: own ip', ip || 'unknown');
        var prefixes = [];
        var mine = prefixOf(ip);
        if (mine) prefixes.push(mine);
        var last = prefixOf((/^https?:\/\/([^:/]+)/.exec(saved) || [])[1]);
        if (last && prefixes.indexOf(last) === -1) prefixes.push(last);
        if (mine) return prefixes;
        // Own address unknown: guess among the subnets home routers use, keeping those whose
        // router answers (each absent subnet would otherwise cost a full slow scan).
        var guesses = COMMON.filter(function (p) { return prefixes.indexOf(p) === -1; });
        return Promise.all(guesses.map(subnetHere)).then(function (here) {
          guesses.forEach(function (p, i) { if (here[i]) prefixes.push(p); });
          return prefixes;
        });
      }).then(function (prefixes) {
        console.log('discover: scanning', prefixes.join(', ') || 'nothing');
        var i = 0;
        function step() {
          if (i >= prefixes.length) return null;
          return scanSubnet(prefixes[i++], null, opts.onProgress).then(function (u) { return u || step(); });
        }
        return step();
      });
    }).then(function (u) {
      running = null;
      console.log('discover:', u || 'no server found');
      return u;
    }, function (e) {
      running = null;
      console.warn('discover failed', e);
      return null;
    });
    return running;
  }

  /**
   * Background setup, run once per boot: picks up a server nobody configured, and follows one
   * the router moved to a new address. Never overrides a server the viewer set or turned off.
   */
  function autoSetup(onFound) {
    var srv = U.store.get('server', null);
    if (srv === '') return Promise.resolve(null);                 // turned off by the viewer
    var auto = U.store.get('serverAuto', false);
    var check = srv ? probe(srv, 2500) : Promise.resolve(false);
    return check.then(function (ok) {
      if (ok) return srv;
      if (srv && !auto) return null;                              // their address: leave it alone
      var lastScan = U.store.get('serverScanAt', 0);
      if (!srv && Date.now() - lastScan < 6 * 3600e3) return null; // nothing found recently
      U.store.set('serverScanAt', Date.now());
      return find().then(function (u) {
        if (u && u !== srv) {
          U.store.set('server', u);
          U.store.set('serverAuto', true);
          if (onFound) onFound(u, !!srv);
        }
        return u;
      });
    });
  }

  g.Discover = { find: find, probe: probe, autoSetup: autoSetup, PORT: PORT };
})(window);
