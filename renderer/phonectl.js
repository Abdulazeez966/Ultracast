'use strict';
/*
  Turns the laptop's mouse and keyboard into the phone control messages of PHONE-SCREEN-PROTOCOL.md:
  click = tap, hold = long press, drag = swipe, mouse wheel = scroll swipe, typing = text / Backspace / Enter.
  Pure logic (no page needed) so it can be tested in Node. The page feeds it positions in screen pixels and
  the rectangle where the phone picture really sits (it is letterboxed inside its box).
*/
(function (root) {
  var LONG_MS = 500, MOVE_PX = 6, WHEEL_WAIT = 120, TEXT_WAIT = 40, MAX_TEXT = 200;

  function clamp(v, a, b) { return Math.min(b, Math.max(a, v)); }
  function r4(v) { return Math.round(v * 10000) / 10000; }

  // Where the picture sits inside a box when it is scaled to fit without stretching.
  function pictureRect(boxW, boxH, vw, vh) {
    if (!(vw > 0) || !(vh > 0) || !(boxW > 0) || !(boxH > 0)) return { left: 0, top: 0, w: boxW || 1, h: boxH || 1 };
    var sc = Math.min(boxW / vw, boxH / vh), w = vw * sc, h = vh * sc;
    return { left: (boxW - w) / 2, top: (boxH - h) / 2, w: w, h: h };
  }
  // Pixel position (relative to the box) -> 0..1 on the picture. inside tells if it was on the picture itself.
  function norm(px, py, rect) {
    var x = (px - rect.left) / rect.w, y = (py - rect.top) / rect.h;
    return { x: r4(clamp(x, 0, 1)), y: r4(clamp(y, 0, 1)), inside: x >= 0 && x <= 1 && y >= 0 && y <= 1 };
  }

  // send(obj) delivers a message; enabled() says if controlling is allowed right now; rect() gives the picture rectangle.
  function create(o) {
    var send = o.send, enabled = o.enabled || function () { return true; }, rect = o.rect;
    var down = null, longTimer = null, wheelAcc = null, wheelTimer = null, textBuf = '', textTimer = null;
    var setT = o.setTimeout || setTimeout, clearT = o.clearTimeout || clearTimeout;

    function out(m) { if (enabled()) send(m); }

    function mouseDown(px, py, now) {
      var n = norm(px, py, rect());
      if (!n.inside || !enabled()) return;
      down = { px: px, py: py, x: n.x, y: n.y, t: now, moved: false, long: false };
      clearT(longTimer);
      longTimer = setT(function () {
        if (down && !down.moved && !down.long) { down.long = true; out({ t: 'long', x: down.x, y: down.y }); }
      }, LONG_MS);
    }
    function mouseMove(px, py) {
      if (!down) return;
      if (Math.hypot(px - down.px, py - down.py) > MOVE_PX) { down.moved = true; clearT(longTimer); }
    }
    function mouseUp(px, py, now) {
      if (!down) return;
      var d = down; down = null; clearT(longTimer);
      if (d.long) return;                       // already sent as a long press
      var n = norm(px, py, rect());
      if (!d.moved) { out({ t: 'tap', x: d.x, y: d.y }); return; }
      out({ t: 'swipe', x1: d.x, y1: d.y, x2: n.x, y2: n.y, ms: clamp(Math.round(now - d.t), 50, 3000) });
    }
    function cancel() { down = null; clearT(longTimer); }

    // dx, dy are the wheel deltas in pixels (browser convention: positive dy = scroll down).
    function wheel(px, py, dx, dy) {
      var n = norm(px, py, rect());
      if (!n.inside || !enabled()) return;
      if (!wheelAcc) wheelAcc = { x: n.x, y: n.y, dx: 0, dy: 0 };
      wheelAcc.dx += dx; wheelAcc.dy += dy;
      clearT(wheelTimer);
      wheelTimer = setT(flushWheel, WHEEL_WAIT);
    }
    function flushWheel() {
      var a = wheelAcc; wheelAcc = null; if (!a) return;
      var r = rect();
      // Scrolling down means the finger moves up the picture. A full picture height of wheel = half the screen.
      var sy = clamp(a.dy / r.h, -0.5, 0.5), sx = clamp(a.dx / r.w, -0.5, 0.5);
      if (Math.abs(sx) < 0.005 && Math.abs(sy) < 0.005) return;
      var x1 = clamp(a.x + sx / 2, 0.05, 0.95), y1 = clamp(a.y + sy / 2, 0.05, 0.95);
      var x2 = clamp(a.x - sx / 2, 0.05, 0.95), y2 = clamp(a.y - sy / 2, 0.05, 0.95);
      out({ t: 'swipe', x1: r4(x1), y1: r4(y1), x2: r4(x2), y2: r4(y2), ms: 250 });
    }

    function flushText() {
      clearT(textTimer); textTimer = null;
      if (!textBuf) return;
      var s = textBuf; textBuf = '';
      out({ t: 'text', s: s });
    }
    function typeText(s) {
      if (!enabled() || typeof s !== 'string') return;
      s = s.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '');
      while (s.length) {
        var room = MAX_TEXT - textBuf.length;
        if (room <= 0) { flushText(); continue; }
        textBuf += s.slice(0, room); s = s.slice(room);
      }
      clearT(textTimer); textTimer = setT(flushText, TEXT_WAIT);
    }
    // A key press in the picture box. Returns true if it was used (so the page can stop the browser acting on it).
    function key(e) {
      if (!enabled()) return false;
      if (e.key === 'Backspace' || e.key === 'Enter') { flushText(); out({ t: 'key', k: e.key }); return true; }
      if (e.ctrlKey || e.altKey || e.metaKey) return false;
      if (typeof e.key === 'string' && e.key.length === 1) { typeText(e.key); return true; }
      return false;
    }
    function nav(k) { if (k === 'back' || k === 'home' || k === 'recents' || k === 'notifications') out({ t: 'nav', k: k }); }

    return { mouseDown: mouseDown, mouseMove: mouseMove, mouseUp: mouseUp, cancel: cancel, wheel: wheel, typeText: typeText, key: key, nav: nav, flush: function () { flushWheel(); flushText(); } };
  }

  var api = { create: create, pictureRect: pictureRect, norm: norm, LONG_MS: LONG_MS };
  root.UltraPhoneCtl = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
