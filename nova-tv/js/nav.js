/*
 * Remote-control focus engine.
 *
 * - Focusable elements carry [data-f].
 * - A horizontal list is `.row[data-row]` with a `.track` child; left/right inside a row is
 *   index based (no geometry), and the row remembers its last index so moving up/down lands
 *   where you left it (Netflix behaviour).
 * - [data-row-scroll="anchor"] keeps the focused card pinned at the row's left edge;
 *   "visible" only scrolls when the card would leave the viewport.
 * - [data-vscroll="rows"] pins the focused section at the top of the container;
 *   [data-vscroll="visible"] scrolls just enough to keep the focused element on screen.
 * - Layers (screen, modal, player) form a stack; only the top layer receives focus/keys.
 */
(function (g) {
  'use strict';

  var KEYS = {
    37: 'left', 38: 'up', 39: 'right', 40: 'down', 13: 'enter', 29443: 'enter',
    10009: 'back', 8: 'back', 27: 'back', 461: 'back',
    415: 'play', 19: 'pause', 10252: 'playpause', 32: 'playpause', 413: 'stop',
    417: 'ff', 412: 'rw', 10233: 'next', 10232: 'prev',
    403: 'red', 404: 'green', 405: 'yellow', 406: 'blue', 457: 'info',
    427: 'chup', 428: 'chdown'
  };

  var layers = [];
  var focused = null;
  var lastMove = 0;
  var fastTimer = null;

  function topLayer() { return layers[layers.length - 1]; }

  function isVisible(el) {
    if (el.classList.contains('disabled')) return false;
    return el.offsetParent !== null || getComputedStyle(el).position === 'fixed';
  }

  function rowOf(el) { return el.closest ? el.closest('[data-row]') : null; }
  function rowCards(row) { return Array.prototype.filter.call(row.querySelector('.track').children, function (c) { return c.hasAttribute('data-f'); }); }

  function candidates(layer, exclude) {
    var out = [];
    var seenRows = [];
    var all = layer.el.querySelectorAll('[data-f]');
    for (var i = 0; i < all.length; i++) {
      var el = all[i];
      var row = rowOf(el);
      if (row && layer.el.contains(row)) {
        if (seenRows.indexOf(row) !== -1) continue;
        seenRows.push(row);
        if (row === exclude) continue;
        var cards = rowCards(row);
        if (!cards.length) continue;
        var idx = Math.min(row._idx || 0, cards.length - 1);
        if (isVisible(cards[idx])) out.push(cards[idx]);
      } else if (el !== focused && isVisible(el)) {
        out.push(el);
      }
    }
    return out;
  }

  function geometric(dir) {
    var layer = topLayer();
    if (!layer) return null;
    var cur = focused;
    var curRow = cur ? rowOf(cur) : null;
    var cands = candidates(layer, curRow);
    if (!cur) return cands[0] || null;
    var a = cur.getBoundingClientRect();
    var ax = a.left + a.width / 2, ay = a.top + a.height / 2;
    var best = null, bestScore = Infinity;
    for (var i = 0; i < cands.length; i++) {
      var b = cands[i].getBoundingClientRect();
      if (b.width === 0 && b.height === 0) continue;
      var bx = b.left + b.width / 2, by = b.top + b.height / 2;
      var primary, secondary;
      if (dir === 'down') { if (by <= ay + 2 || b.top < a.top + 4) continue; primary = Math.max(0, b.top - a.bottom); secondary = overlap1d(a.left, a.right, b.left, b.right) ? 0 : Math.abs(bx - ax); }
      else if (dir === 'up') { if (by >= ay - 2 || b.bottom > a.bottom - 4) continue; primary = Math.max(0, a.top - b.bottom); secondary = overlap1d(a.left, a.right, b.left, b.right) ? 0 : Math.abs(bx - ax); }
      else if (dir === 'right') { if (bx <= ax + 2 || b.left < a.left + 4) continue; primary = Math.max(0, b.left - a.right); secondary = overlap1d(a.top, a.bottom, b.top, b.bottom) ? 0 : Math.abs(by - ay); }
      else { if (bx >= ax - 2 || b.right > a.right - 4) continue; primary = Math.max(0, a.left - b.right); secondary = overlap1d(a.top, a.bottom, b.top, b.bottom) ? 0 : Math.abs(by - ay); }
      var score = primary + secondary * 2.2;
      if (score < bestScore) { bestScore = score; best = cands[i]; }
    }
    return best;
  }

  function overlap1d(a1, a2, b1, b2) { return Math.min(a2, b2) - Math.max(a1, b1) > 8; }

  function scrollRow(row, el, idx, instant) {
    var track = row.querySelector('.track');
    var mode = row.getAttribute('data-row-scroll') || 'anchor';
    var x;
    if (mode === 'anchor') {
      x = -el.offsetLeft;
    } else {
      var cur = track._x || 0;
      var vw = row.clientWidth;
      var pad = 60;
      x = cur;
      if (el.offsetLeft + cur < pad) x = pad - el.offsetLeft;
      if (el.offsetLeft + el.offsetWidth + cur > vw - pad) x = vw - pad - el.offsetLeft - el.offsetWidth;
      x = Math.min(0, x);
    }
    if (x !== track._x) {
      track._x = x;
      if (instant) track.classList.add('no-anim');
      track.style.transform = 'translate3d(' + x + 'px,0,0)';
      if (instant) { void track.offsetWidth; track.classList.remove('no-anim'); }
    }
    if (row._onScroll) row._onScroll(idx);
  }

  function scrollVertical(el, instant) {
    var box = el.closest('[data-vscroll]');
    if (!box) return;
    var mode = box.getAttribute('data-vscroll');
    var y;
    if (mode === 'rows') {
      var sec = el;
      while (sec && sec.parentElement !== box) sec = sec.parentElement;
      if (!sec) return;
      y = -sec.offsetTop;
      var kids = box.children, above = true;
      for (var i = 0; i < kids.length; i++) {
        if (kids[i] === sec) above = false;
        kids[i].classList.toggle('above', above);
      }
    } else {
      var cur = box._y || 0;
      var top = (el.getBoundingClientRect().top - box.getBoundingClientRect().top) / (g.NOVA_SCALE || 1);
      var hgt = el.offsetHeight;
      var vh = (box.parentElement || box).clientHeight;
      var m = parseInt(box.getAttribute('data-margin') || '120', 10);
      y = cur;
      if (top + cur < m) y = m - top;
      if (top + hgt + cur > vh - m) y = vh - m - top - hgt;
      y = Math.min(0, y);
    }
    if (y !== box._y) {
      box._y = y;
      if (instant) box.classList.add('no-anim');
      box.style.transform = 'translate3d(0,' + y + 'px,0)';
      if (instant) { void box.offsetWidth; box.classList.remove('no-anim'); }
    }
  }

  function focus(el, opts) {
    opts = opts || {};
    if (!el) return;
    var prev = focused;
    if (prev && prev !== el) {
      prev.classList.remove('focused');
      if (prev._onBlur) prev._onBlur(prev);
    }
    focused = el;
    var layer = topLayer();
    if (layer) layer.last = el;
    el.classList.add('focused');
    var row = rowOf(el);
    // Expanding tile rows: collapse the row we left, expand the focused tile before measuring.
    var prevRow = prev && prev !== el ? rowOf(prev) : null;
    if (prevRow && prevRow !== row && prevRow._expand) prevRow._expand(null);
    if (row && row._expand) row._expand(el);
    if (row) {
      var cards = rowCards(row);
      var idx = cards.indexOf(el);
      row._idx = idx;
      scrollRow(row, el, idx, opts.instant);
    }
    scrollVertical(el, opts.instant);
    if (el._onFocus) el._onFocus(el);
    if (layer && layer.onFocus) layer.onFocus(el);
  }

  function move(dir) {
    var cur = focused;
    if (cur && !document.body.contains(cur)) cur = focused = null;
    var row = cur ? rowOf(cur) : null;
    if (row && (dir === 'left' || dir === 'right')) {
      var cards = rowCards(row);
      var i = cards.indexOf(cur) + (dir === 'right' ? 1 : -1);
      if (i >= 0 && i < cards.length) { focus(cards[i]); return true; }
      if (dir === 'right') return false;
    }
    // Stacked rows (home): up/down is index based too — previous/next row at its remembered
    // card. No layout reads, so it stays instant however many rows exist.
    if (row && (dir === 'up' || dir === 'down')) {
      var box = row.closest('[data-vscroll="rows"]');
      if (box) {
        var sec = row;
        while (sec && sec.parentElement !== box) sec = sec.parentElement;
        var sib = sec && (dir === 'down' ? sec.nextElementSibling : sec.previousElementSibling);
        var r2 = sib && sib.querySelector('[data-row]');
        if (r2) {
          var cs = rowCards(r2);
          if (cs.length) { focus(cs[Math.min(r2._idx || 0, cs.length - 1)]); return true; }
        }
        if (dir === 'down') return false;
      }
    }
    var next = geometric(dir);
    if (next) { focus(next); return true; }
    var layer = topLayer();
    if (layer && layer.onEdge) layer.onEdge(dir);
    return false;
  }

  function select() {
    if (!focused) return;
    // Tactile press: a quick scale-down the compositor handles on its own.
    var el = focused;
    el.classList.remove('pressed'); void el.offsetWidth; el.classList.add('pressed');
    setTimeout(function () { el.classList.remove('pressed'); }, 160);
    if (focused._onSelect) focused._onSelect(focused);
    else focused.click();
  }

  function onKey(e) {
    var action = KEYS[e.keyCode];
    if (!action) return;
    // Let real text inputs keep their keys (except navigation off the field).
    var t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') && ['left', 'right', 'back'].indexOf(action) !== -1 && t.value) {
      if (action !== 'back') return;
    }
    e.preventDefault();
    var layer = topLayer();
    if (!layer) return;

    var now = performance.now();
    var isMove = action === 'left' || action === 'right' || action === 'up' || action === 'down';
    if (isMove && e.repeat) {
      if (now - lastMove < 85) return;
      document.body.classList.add('fast');
      clearTimeout(fastTimer);
      fastTimer = setTimeout(function () { document.body.classList.remove('fast'); document.dispatchEvent(new Event('nav:settle')); }, 260);
    }
    if (isMove) lastMove = now;

    if (layer.onKey && layer.onKey(action, e) === true) return;
    if (isMove) { move(action); return; }
    if (action === 'enter') {
      // A held OK auto-repeats: never treat repeats as new presses, and after a long-press
      // swallow everything until the button is released.
      if (longFired) return;
      if (e.repeat && !pressTimer) return;
      // Elements with a long-press action (tiles: hold OK to rate) select on release instead.
      if (focused && focused._onLongPress) {
        // A held button auto-repeats; only that counts as a long press. If the TV never
        // delivers key-up and nothing repeated, it was a normal press: select when the timer ends.
        if (e.repeat || pressTimer) { if (pressTimer) held = true; return; }
        var target = focused;
        held = false;
        pressStart = performance.now();
        pressTimer = setTimeout(function () {
          pressTimer = null;
          if (focused !== target) return;
          if (held) { longFired = true; target._onLongPress(target); }
          else select();
        }, 550);
        return;
      }
      select();
      return;
    }
    if (action === 'back') { if (layer.onBack) layer.onBack(); return; }
    if (focused && focused._onKey) focused._onKey(action, e);
  }

  var pressTimer = null, longFired = false, held = false, pressStart = 0;
  function onKeyUp(e) {
    if (KEYS[e.keyCode] !== 'enter') return;
    if (pressTimer) {
      clearTimeout(pressTimer); pressTimer = null;
      // Decide by how long it was actually held, not by whether the timer got to run.
      if (held && performance.now() - pressStart >= 450 && focused && focused._onLongPress) { longFired = true; focused._onLongPress(focused); }
      else select();
    }
    longFired = false;
  }
  document.addEventListener('keyup', onKeyUp, true);

  function pushLayer(el, opts) {
    var layer = Object.assign({ el: el, last: null }, opts || {});
    if (focused) focused.classList.remove('focused');
    var below = topLayer();
    if (below) below.last = focused;
    layers.push(layer);
    focused = null;
    if (opts && opts.initial === false) return layer;
    var first = opts && opts.initial ? opts.initial : null;
    if (!first) first = el.querySelector('[data-f].autofocus') || candidates(layer, null)[0];
    if (first) focus(first, { instant: true });
    return layer;
  }

  function popLayer(layer) {
    var i = layers.indexOf(layer || topLayer());
    if (i === -1) return;
    var removed = layers.splice(i, 1)[0];
    if (removed.onClose) removed.onClose();
    var top = topLayer();
    if (top) {
      if (focused) focused.classList.remove('focused');
      focused = null;
      var target = top.last && document.body.contains(top.last) && isVisible(top.last) ? top.last : candidates(top, null)[0];
      if (target) focus(target, { instant: true });
    }
  }

  function replaceBase(el, opts) {
    while (layers.length) layers.pop();
    focused = null;
    return pushLayer(el, opts);
  }

  document.addEventListener('keydown', onKey, true);

  // Pointer support so the UI is usable in a desktop browser while developing.
  document.addEventListener('click', function (e) {
    var el = e.target.closest && e.target.closest('[data-f]');
    var layer = topLayer();
    if (!el || !layer || !layer.el.contains(el)) return;
    if (e.isTrusted === false && el === focused) return;
    if (focused !== el) focus(el);
    if (el._onSelect) { e.preventDefault(); el._onSelect(el); }
  });

  g.Nav = {
    focus: focus, move: move, select: select, pushLayer: pushLayer, popLayer: popLayer,
    replaceBase: replaceBase, top: topLayer, layers: layers,
    get focused() { return focused; },
    refocus: function () { if (focused && document.body.contains(focused)) focus(focused, { instant: true }); else { var l = topLayer(); var c = l && candidates(l, null)[0]; if (c) focus(c, { instant: true }); } },
    KEYS: KEYS
  };
})(window);
