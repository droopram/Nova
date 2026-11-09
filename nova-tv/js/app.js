/* App shell: boot, top navigation bar, screen stack, Tizen lifecycle. */
(function (g) {
  'use strict';
  var h = U.h;

  var ICONS = {
    search: '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.5"/><path d="M15.5 15.5L21 21"/></svg>'
  };

  // Top bar, Netflix TV style: profile on the left, search + sections centred, brand on the right.
  var TABS = [
    { key: 'search', label: '', icon: true },
    { key: 'home', label: 'Home' },
    { key: 'series', label: 'Shows' },
    { key: 'movies', label: 'Movies' },
    { key: 'mylist', label: 'My Nova' }
  ];

  var tabScreens = {};
  var currentTab = null;
  var navItems = {};
  var inNav = false;
  var baseLayer = null;
  var lastRefresh = 0;

  function registerKeys() {
    if (!U.IS_TIZEN || !tizen.tvinputdevice) return;
    var keys = ['MediaPlayPause', 'MediaPlay', 'MediaPause', 'MediaStop', 'MediaFastForward', 'MediaRewind',
      'MediaTrackNext', 'MediaTrackPrevious', 'ColorF0Red', 'ColorF1Green', 'ColorF2Yellow', 'ColorF3Blue', 'Info', 'ChannelUp', 'ChannelDown'];
    try { tizen.tvinputdevice.registerKeyBatch(keys); } catch (e) {
      keys.forEach(function (k) { try { tizen.tvinputdevice.registerKey(k); } catch (e2) {} });
    }
  }

  function fitStage() {
    // TV web apps render at 1920x1080. In a desktop browser, scale to fit the window.
    var s = Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
    var st = U.$('#stage');
    if (Math.abs(s - 1) < 0.01) { st.style.transform = ''; g.NOVA_SCALE = 1; return; }
    g.NOVA_SCALE = s;
    st.style.transform = 'scale(' + s + ')';
  }

  function buildTopNav() {
    var nav = U.$('#topnav');
    nav.innerHTML = '';
    var initial = Api.user && Api.user.email ? Api.user.email.charAt(0).toUpperCase() : 'N';
    var avatar = h('div', { class: 'tn-item tn-avatar', 'data-f': true }, [h('span', { class: 'tn-face' }, initial), h('span', { class: 'tn-caret' }, '▾')]);
    avatar._onSelect = function () { App.showTab('settings', true); };
    navItems.settings = avatar;
    var center = h('div', { class: 'tn-center' });
    TABS.forEach(function (t) {
      var it = h('div', { class: 'tn-item' + (t.icon ? ' tn-icon' : ''), 'data-f': true, 'data-tab': t.key }, t.icon ? h('span', { html: ICONS.search }) : t.label);
      it._onSelect = function () { App.showTab(t.key, true); };
      navItems[t.key] = it;
      center.appendChild(it);
    });
    U.append(nav, [h('div', { class: 'tn-left' }, avatar), center, h('div', { class: 'tn-right' }, h('span', { class: 'tn-mark' }, 'nova'))]);
  }

  function createTab(key) {
    if (key === 'home') return Home.create('home', null);
    if (key === 'series') return Home.create('series', 'series');
    if (key === 'movies') return Home.create('movies', 'movie');
    if (key === 'mylist') return Home.create('mynova', null, { provider: Home.myNovaRows, noBillboard: true, live: true });
    if (key === 'search') return Search.create();
    if (key === 'settings') return Settings.create();
  }

  function onBaseFocus(el) {
    var nowNav = U.$('#topnav').contains(el);
    var scr = tabScreens[currentTab];
    if (nowNav && !inNav) {
      inNav = true;
      Trailer.stop();
      document.body.classList.add('nav-focus');
      // Coming up from content: land on the current section, like Netflix.
      var active = navItems[currentTab];
      if (active && el !== active && !el.classList.contains('tn-avatar')) { Nav.focus(active); return; }
    } else if (!nowNav && inNav) {
      inNav = false;
      document.body.classList.remove('nav-focus');
      // Going down from the bar: resume where you were on the page, not the nearest tile.
      var resume = scr && scr.initialFocus ? scr.initialFocus() : null;
      if (resume && resume !== el && document.body.contains(resume)) { Nav.focus(resume); return; }
    }
    if (!nowNav && scr && scr.onFocus) scr.onFocus(el);
  }

  // Back from anywhere on a page returns to the top bar (and the page to its top).
  function onBaseBack() {
    var scr = tabScreens[currentTab];
    if (!inNav) {
      if (scr && scr.onBack && scr.onBack() === true) return;
      if (scr && scr.scrollTop) scr.scrollTop();
      Nav.focus(navItems[currentTab] || navItems.home);
      return;
    }
    if (currentTab !== 'home') { App.showTab('home', false); Nav.focus(navItems.home); return; }
    UI.confirm('Leave Nova?', null, 'Exit', function () { App.exit(); });
  }

  var App = {
    init: function () {
      var tI = performance.now(), mark = function (n) { var t = performance.now(); console.log('perf init', n, Math.round(t - tI) + 'ms'); tI = t; };
      console.log('perf scripts evaluated by', Math.round(tI) + 'ms');
      fitStage();
      window.addEventListener('resize', fitStage);
      UI.Hero.init();
      // A rating reshapes recommendations right away (batched if the viewer rates several in a row).
      var rerank = U.debounce(function () {
        Object.keys(tabScreens).forEach(function (k) { if (tabScreens[k].refresh) tabScreens[k].refresh(); });
      }, 1200);
      Ratings.onChange(rerank);
      App.refreshTabs = rerank;
      // Reminded titles that became watchable since last time.
      setTimeout(function () { Fresh.checkReminders(); }, 9000);
      mark('keys+hero');
      Addons.init(); mark('addons');
      Library.init(); mark('library');
      Player.init(); mark('player');
      console.log('nova boot', JSON.stringify({ engine: document.body.className, w: window.innerWidth, h: window.innerHeight, ua: navigator.userAgent, loggedIn: Api.loggedIn }));

      document.addEventListener('visibilitychange', function () {
        if (document.hidden) { Player.onHide(); Library.flush(); }
        else if (Date.now() - lastRefresh > 20 * 60000) App.refreshData();
      });

      // Dev only: play a sample clip on boot to exercise the video pipeline on the device.
      var dev = (g.NOVA_CONFIG || {}).devAutoplay;
      if (dev) setTimeout(function () {
        Addons.meta('series', 'tt0306414').then(function (meta) {
          var v = meta.videos.filter(function (x) { return x.id === 'tt0306414:1:1'; })[0];
          var s = { url: dev, name: 'Dev sample', title: 'sample.mp4', _addon: 'Dev' };
          Player.play({ meta: meta, videoId: v.id, video: v, resumeAt: 0, ranked: [{ s: s, p: Streams.parse(s), score: 1 }] });
        }).catch(function (e) { console.error('dev autoplay', e); });
      }, 3000);

      var boot = U.$('#boot');
      var done = function () { boot.classList.add('gone'); setTimeout(function () { boot.remove(); }, 600); };

      if (!Api.loggedIn && !U.store.get('guest', false)) {
        done();
        setTimeout(registerKeys, 60);
        Login.show(function () { App.start(); });
        return;
      }
      App.start(); mark('start (nav + home render)');
      // Remote media keys are a slow system call; register them right after the first frame.
      setTimeout(registerKeys, 60);
      setTimeout(function () { console.log('webapis avplay ready:', !!(g.webapis && g.webapis.avplay)); }, 3000);
      setTimeout(done, 250);
    },

    start: function () {
      buildTopNav();
      baseLayer = Nav.replaceBase(U.$('#ui'), { initial: false, onFocus: onBaseFocus, onBack: onBaseBack });
      App.showTab('home');
      App.refreshData();
      // Find the Stremio streaming server on the network once rows have loaded (torrent sources).
      setTimeout(function () {
        Discover.autoSetup(function (u, moved) {
          UI.toast(moved ? 'Stremio moved to ' + u.replace(/^https?:\/\//, '') + ' — reconnected' : 'Found Stremio on your computer — torrent sources are on', 5000);
        });
      }, 8000);
    },

    // Pull addons + library in the background; screens re-render when it lands.
    refreshData: function () {
      lastRefresh = Date.now();
      if (!Api.loggedIn) return Promise.resolve();
      return Promise.all([
        Addons.refresh().catch(function (e) { console.warn('addons', e); }),
        Library.refresh().catch(function (e) { console.warn('library', e); }),
        Api.getUser().catch(function (e) { if (e.code === 1) { UI.toast('Session expired, please sign in again'); App.logout(); } })
      ]).then(function () {
        console.log('data', JSON.stringify({ addons: Addons.list.map(function (a) { return a.manifest.name; }), library: Library.items.length, continue: Library.continueWatching().length }));
        Object.keys(tabScreens).forEach(function (k) { if (tabScreens[k].refresh) tabScreens[k].refresh(); });
      });
    },

    showTab: function (key, focusContent) {
      Trailer.stop();
      if (!tabScreens[key]) {
        tabScreens[key] = createTab(key);
        U.$('#screens').appendChild(tabScreens[key].el);
      }
      Object.keys(tabScreens).forEach(function (k) { tabScreens[k].el.classList.toggle('hidden', k !== key); });
      var prev = currentTab;
      currentTab = key;
      Object.keys(navItems).forEach(function (k) { navItems[k].classList.toggle('active', k === key); });
      var scr = tabScreens[key];
      UI.Hero.hide(!scr.hero);
      document.body.setAttribute('data-tab', key);
      if (scr.show) scr.show(prev !== key);
      if (focusContent !== false) {
        var t = scr.initialFocus ? scr.initialFocus() : scr.el.querySelector('[data-f]');
        if (t) Nav.focus(t, { instant: true });
      }
    },

    tab: function (key) { return tabScreens[key]; },

    openDetail: function (item) { Detail.open(item); },

    // Continue Watching card -> straight into playback, like Netflix.
    resume: function (lib) {
      var s = lib.state || {};
      Player.playFromLibrary(lib, s.video_id);
    },

    onPlayerClosed: function () {
      Object.keys(tabScreens).forEach(function (k) { if (tabScreens[k].refreshContinue) tabScreens[k].refreshContinue(); });
      if (Detail.isOpen()) Detail.refreshProgress();
    },

    logout: function () {
      Api.logout();
      U.store.del('guest');
      location.reload();
    },

    exit: function () {
      Player.cancelPreload();
      Library.flush();
      try { tizen.application.getCurrentApplication().exit(); } catch (e) { window.close(); }
    }
  };

  g.App = App;
  // DOMContentLoaded, not load: don't wait for images or the async Samsung webapis script.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { App.init(); });
  else App.init();
})(window);
