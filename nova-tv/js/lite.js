/* Slim a Stremio meta down to what cards, hero and the recommender use. Shared by the app and
 * the fetch worker, so catalogs can be parsed and slimmed off the UI thread. */
(function (g) {
  'use strict';
  // "Won 2 Primetime Emmys. 40 wins & 90 nominations total" -> "Emmy Award Winner"
  function awardBadge(a) {
    if (!a) return '';
    if (/Won \d+ Oscars?/i.test(a)) return 'Oscar Winner';
    if (/Won \d+ Primetime Emmys?/i.test(a)) return 'Emmy Award Winner';
    if (/Won \d+ Golden Globes?/i.test(a)) return 'Golden Globe Winner';
    return '';
  }

  g.Lite = function (m, addonId) {
    if (!m || !m.id) return null;
    var id = m.id || m.imdb_id;
    if (m.imdb_id && /^tt\d+/.test(m.imdb_id) && !/^tt\d+/.test(id)) id = m.imdb_id;
    var isImdb = /^tt\d+/.test(id);
    var desc = m.description || '';
    if (desc.length > 320) desc = desc.slice(0, 317) + '…';
    return {
      id: id,
      type: m.type,
      name: m.name || '',
      poster: m.poster || (isImdb ? 'https://images.metahub.space/poster/small/' + id + '/img' : ''),
      bg: isImdb ? 'https://images.metahub.space/background/small/' + id + '/img' : (m.background || m.poster || ''),
      bgLarge: m.background || (isImdb ? 'https://images.metahub.space/background/medium/' + id + '/img' : ''),
      logo: m.logo || (isImdb ? 'https://images.metahub.space/logo/medium/' + id + '/img' : ''),
      genres: m.genres || m.genre || [],
      year: m.releaseInfo || m.year || '',
      rating: parseFloat(m.imdbRating) || 0,
      runtime: m.runtime || '',
      desc: desc,
      cast: (m.cast || []).slice(0, 4),
      director: (m.director || []).slice(0, 2),
      pop: m.popularity || 0,
      released: m.released || '',
      trailer: (m.trailerStreams && m.trailerStreams[0] && m.trailerStreams[0].ytId) || (m.trailers && m.trailers[0] && m.trailers[0].source) || '',
      awards: awardBadge(m.awards),
      src: addonId
    };
  };
})(typeof self !== 'undefined' ? self : window);
