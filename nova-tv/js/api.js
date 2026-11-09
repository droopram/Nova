/* Stremio account API: QR/link-code login, addon collection, library datastore. */
(function (g) {
  'use strict';

  var API = 'https://api.strem.io/api/';
  var LINK = 'https://link.stremio.com/api/v2/';

  function call(method, body) {
    body = Object.assign({ type: method.charAt(0).toUpperCase() + method.slice(1), authKey: g.Api.authKey }, body || {});
    return U.postJSON(API + method, body, { timeout: 20000 }).then(function (r) {
      if (r && r.error) {
        var err = new Error(r.error.message || 'API error');
        err.code = r.error.code;
        throw err;
      }
      return r ? r.result : null;
    });
  }

  function findAuthKey(o) {
    if (!o || typeof o !== 'object') return null;
    if (typeof o.authKey === 'string') return o.authKey;
    for (var k in o) { var v = findAuthKey(o[k]); if (v) return v; }
    return null;
  }

  g.Api = {
    authKey: U.store.get('authKey', null),
    user: U.store.get('user', null),

    get loggedIn() { return !!this.authKey; },

    createLinkCode: function () {
      return U.getJSON(LINK + 'create?type=Create&_=' + Date.now(), { ttl: 0 }).then(function (r) { return r.result || r; });
    },

    // Resolves with authKey once the code is confirmed on the phone, null while pending.
    readLinkCode: function (code) {
      return U.getJSON(LINK + 'read?type=Read&code=' + encodeURIComponent(code) + '&_=' + Date.now(), { ttl: 0 })
        .then(function (r) { return r && r.result ? findAuthKey(r.result) : null; })
        .catch(function () { return null; });
    },

    setAuth: function (key) {
      this.authKey = key;
      U.store.set('authKey', key);
      return this.getUser();
    },

    logout: function () {
      var k = this.authKey;
      this.authKey = null; this.user = null;
      U.store.del('authKey'); U.store.del('user'); U.store.del('addons'); U.store.del('library');
      U.store.del('home'); U.store.purgeCaches();
      if (k) U.postJSON(API + 'logout', { type: 'Logout', authKey: k }).catch(function () {});
    },

    getUser: function () {
      var self = this;
      return call('getUser').then(function (u) { self.user = u; U.store.set('user', u); return u; });
    },

    getAddons: function () {
      return call('addonCollectionGet', { update: true }).then(function (r) { return (r && r.addons) || []; });
    },

    getLibrary: function () {
      return call('datastoreGet', { collection: 'libraryItem', ids: [], all: true }).then(function (r) { return Array.isArray(r) ? r : []; });
    },

    // [[id, mtimeMs], ...] for the whole library: lets sync fetch only what changed.
    getLibraryMeta: function () {
      return call('datastoreMeta', { collection: 'libraryItem' });
    },

    getLibraryItems: function (ids) {
      return call('datastoreGet', { collection: 'libraryItem', ids: ids, all: false }).then(function (r) { return Array.isArray(r) ? r : []; });
    },

    putLibrary: function (items) {
      if (!this.authKey || !items.length) return Promise.resolve();
      return call('datastorePut', { collection: 'libraryItem', changes: items }).catch(function (e) { console.warn('library sync failed', e); });
    }
  };
})(window);
