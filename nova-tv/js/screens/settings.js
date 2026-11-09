/* Settings: account, playback preferences, streaming server, addons overview. */
(function (g) {
  'use strict';
  var h = U.h;

  var SUB_LANGS = [
    { code: null, label: 'Off' },
    { code: 'nld', label: 'Nederlands' },
    { code: 'eng', label: 'English' },
    { code: 'deu', label: 'Deutsch' },
    { code: 'fra', label: 'Français' },
    { code: 'spa', label: 'Español' },
    { code: 'tur', label: 'Türkçe' },
    { code: 'ara', label: 'العربية' }
  ];

  function host(u) { return (u || '').replace(/^https?:\/\//, ''); }

  // Searches the network with live progress; saves and announces what it finds.
  function findServer(done) {
    UI.toast('Looking for Stremio on your network…', 60000);
    Discover.find({ onProgress: function (p) { UI.toast('Looking for Stremio on ' + p + '.x …', 60000); } }).then(function (u) {
      if (u) {
        U.store.set('server', u); U.store.set('serverAuto', true);
        UI.toast('Found Stremio at ' + host(u) + ' — torrent sources are on', 5000);
      } else {
        UI.toast('No Stremio server found', 2000);
        UI.confirm('No Stremio server found',
          'Open the Stremio app on a computer connected to the same Wi-Fi as this TV and leave it running, then search again.',
          'Search again', function () { findServer(done); });
      }
      if (done) done(u);
    });
  }

  function create() {
    var list = h('div', { class: 'settings-list', 'data-vscroll': 'visible', 'data-margin': '120' });
    var el = h('div', { class: 'screen settings' }, [h('h1', { class: 'screen-title' }, 'Settings'), h('div', { class: 'settings-viewport' }, list)]);

    function item(label, value, onSelect, hint) {
      var it = h('div', { class: 'set-item', 'data-f': true }, [
        h('div', { class: 'set-label' }, [label, hint ? h('div', { class: 'set-hint' }, hint) : null]),
        h('div', { class: 'set-value' }, value)
      ]);
      it._onSelect = onSelect;
      list.appendChild(it);
      return it;
    }

    function render() {
      var focusIdx = Array.prototype.indexOf.call(list.children, Nav.focused);
      list.innerHTML = '';
      list.appendChild(h('div', { class: 'set-head' }, 'Account'));
      if (Api.loggedIn) {
        item('Signed in', (Api.user && Api.user.email) || 'Stremio account', function () {
          UI.confirm('Sign out?', 'Your library stays in your Stremio account.', 'Sign out', function () { App.logout(); });
        });
        item('Sync now', 'Library & addons', function () { UI.toast('Syncing…'); App.refreshData().then(function () { UI.toast('Up to date'); render(); }); });
      } else {
        item('Sign in', 'Use your Stremio account', function () { U.store.del('guest'); location.reload(); }, 'Get your library, addons and progress');
      }

      list.appendChild(h('div', { class: 'set-head' }, 'Playback'));
      var q = parseInt(U.store.get('quality', 1080), 10);
      item('Preferred quality', q === 2160 ? '4K' : q + 'p', function () {
        UI.menu({ title: 'Preferred quality', items: [2160, 1080, 720].map(function (v) {
          return { label: v === 2160 ? '4K Ultra HD' : v + 'p', sub: v === 2160 ? 'Needs a fast connection' : v === 1080 ? 'Best balance for Wi-Fi' : 'Fastest start', selected: v === q, onSelect: function () { U.store.set('quality', v); render(); } };
        }) });
      }, 'Nova picks the best source automatically');

      var pv = U.store.get('previews', true);
      item('Autoplay previews', !Trailer.available ? 'Unavailable' : pv ? 'On' : 'Off', function () { U.store.set('previews', !pv); if (pv) Trailer.stop(); render(); }, 'Trailers play when you rest on a title');
      var ps = U.store.get('previewSound', true);
      item('Preview sound', ps ? 'On' : 'Off', function () { U.store.set('previewSound', !ps); render(); });

      var ap = U.store.get('autoplay', true);
      item('Autoplay next episode', ap ? 'On' : 'Off', function () { U.store.set('autoplay', !ap); render(); });

      var al = U.store.get('audioLang', 'eng');
      var AUDIO = [{ code: 'eng', label: 'English' }, { code: 'nld', label: 'Nederlands' }, { code: 'orig', label: 'Whatever the file starts with' }];
      item('Audio language', (AUDIO.filter(function (a) { return a.code === al; })[0] || { label: al.toUpperCase() }).label, function () {
        UI.menu({ title: 'Audio language', items: AUDIO.map(function (a) { return { label: a.label, selected: a.code === al, onSelect: function () { U.store.set('audioLang', a.code); render(); } }; }) });
      }, 'Skips dubbed releases and picks this track automatically');

      var sl = U.store.get('subLang', 'eng');
      var slLabel = (SUB_LANGS.filter(function (l) { return l.code === sl; })[0] || SUB_LANGS[0]).label;
      item('Subtitles', slLabel, function () {
        UI.menu({ title: 'Default subtitles', items: SUB_LANGS.map(function (l) { return { label: l.label, selected: l.code === sl, onSelect: function () { U.store.set('subLang', l.code); render(); } }; }) });
      }, 'Built-in first, OpenSubtitles as fallback · remembers your last choice');

      var ss = U.store.get('subSizePct', 100);
      var SIZE_LABEL = { 75: 'Small', 100: 'Medium', 125: 'Large', 150: 'Extra large' };
      item('Subtitle size', SIZE_LABEL[ss] || ss + '%', function () {
        UI.menu({ title: 'Subtitle size', items: [75, 100, 125, 150].map(function (v) { return { label: SIZE_LABEL[v], sub: v + '%', selected: v === ss, onSelect: function () { U.store.set('subSizePct', v); render(); } }; }) });
      }, 'Default for new shows · fine-tune per show in the player');

      list.appendChild(h('div', { class: 'set-head' }, 'Sources'));
      var srv = Streams.server();
      item('Streaming server', srv ? host(srv) : 'Off', function () {
        var opts = [];
        if (srv) opts.push({ label: host(srv), sub: 'Current · select to test the connection', selected: true, onSelect: function () { test(srv); } });
        opts.push({ label: 'Find automatically', sub: 'Searches your network for the Stremio app', onSelect: function () { findServer(function () { render(); }); } });
        opts.push({ label: 'Off', sub: 'Only direct / debrid links', selected: !srv, onSelect: function () { U.store.set('server', ''); U.store.set('serverAuto', false); render(); } });
        UI.menu({ title: 'Streaming server', subtitle: 'Torrent sources play through the Stremio app on a computer on your Wi-Fi. Debrid links play without it.', items: opts });
      }, srv ? 'Plays torrent sources through Stremio on your computer' : 'Open Stremio on your computer, then choose Find automatically');

      var names = Addons.list.map(function (a) { return a.manifest.name; });
      item('Addons', names.length + ' installed', function () {
        UI.menu({ title: 'Your addons', subtitle: 'Manage addons in the Stremio app — changes sync here.', items: Addons.list.map(function (a) {
          var res = (a.manifest.resources || []).map(function (r) { return r.name || r; }).join(', ');
          return { label: a.manifest.name, sub: res };
        }) });
      });

      list.appendChild(h('div', { class: 'set-head' }, 'About'));
      item('Nova', 'v1.0', function () { UI.toast('Nova — a Stremio client tuned for Samsung TVs'); });
      item('Clear cache', 'Images & rows', function () { U.store.purgeCaches(); ['home.home', 'home.series', 'home.movies', 'lite'].forEach(function (k) { U.store.del(k); }); UI.toast('Cache cleared'); });

      if (focusIdx >= 0 && Nav.top() && Nav.top().el.id === 'ui') { var f = list.children[focusIdx]; if (f) Nav.focus(f, { instant: true }); }
    }

    function test(u) {
      Discover.probe(u, 2500).then(function (ok) { UI.toast(ok ? 'Server connected' : 'Server not reachable — is Stremio open on that computer?', 4000); });
    }

    return { el: el, hero: false, show: render, refresh: render };
  }

  g.Settings = { create: create };
})(window);
