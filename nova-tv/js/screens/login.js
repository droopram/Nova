/* Sign in by scanning a QR code with a phone (Stremio link codes). No typing on the remote. */
(function (g) {
  'use strict';
  var h = U.h;

  g.Login = {
    show: function (onDone) {
      var root = h('div', { class: 'screen login' });
      var qr = h('img', { class: 'qr', alt: '' });
      var code = h('div', { class: 'code' }, '····');
      var status = h('div', { class: 'login-status' }, 'Waiting for your phone…');
      var newCode = h('div', { class: 'btn', 'data-f': true }, 'New code');
      var guest = h('div', { class: 'btn ghost', 'data-f': true }, 'Continue without account');

      root.appendChild(h('div', { class: 'login-card' }, [
        h('div', { class: 'login-brand' }, 'nova'),
        h('div', { class: 'login-left' }, [
          h('h1', null, 'Sign in with your Stremio account'),
          h('ol', null, [
            h('li', null, 'Scan the code with your phone camera'),
            h('li', null, 'Log in to Stremio on your phone'),
            h('li', null, 'Your library, addons and progress appear here')
          ]),
          h('div', { class: 'login-alt' }, ['Or open ', h('b', null, 'link.stremio.com'), ' and enter']),
          code,
          status,
          h('div', { class: 'login-actions' }, [newCode, guest])
        ]),
        h('div', { class: 'login-right' }, h('div', { class: 'qr-wrap' }, qr))
      ]));
      document.body.querySelector('#stage').appendChild(root);
      document.body.classList.add('login-mode');

      var timer = null, refreshTimer = null, current = null, finished = false;

      function finish() {
        finished = true;
        clearInterval(timer); clearTimeout(refreshTimer);
        Nav.popLayer(layer);
        root.remove();
        document.body.classList.remove('login-mode');
        onDone();
      }

      function fresh() {
        clearInterval(timer); clearTimeout(refreshTimer);
        status.textContent = 'Waiting for your phone…';
        Api.createLinkCode().then(function (r) {
          current = r.code;
          console.log('login code ready');
          code.textContent = r.code;
          qr.src = r.qrcode;
          timer = setInterval(poll, 2500);
          refreshTimer = setTimeout(fresh, 4 * 60000);
        }).catch(function (e) {
          console.warn('link code failed', e && e.message);
          status.textContent = 'No connection. Retrying…';
          refreshTimer = setTimeout(fresh, 4000);
        });
      }

      function poll() {
        if (!current || finished) return;
        Api.readLinkCode(current).then(function (key) {
          if (!key || finished) return;
          status.textContent = 'Signed in! Loading your library…';
          clearInterval(timer);
          console.log('login linked, fetching user');
          Api.setAuth(key).then(function () { console.log('login ok'); finish(); }, function (e) { console.warn('login getUser failed', e && e.message); status.textContent = 'Sign-in failed, try a new code'; fresh(); });
        });
      }

      newCode._onSelect = fresh;
      guest._onSelect = function () { U.store.set('guest', true); finish(); };
      var layer = Nav.pushLayer(root, { initial: newCode, onBack: function () {} });
      fresh();
    }
  };
})(window);
