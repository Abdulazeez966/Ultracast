'use strict';
// Mouse/keyboard -> phone control messages (no browser needed).
const assert = require('assert');
const P = require('./renderer/phonectl');
let ok = 0; const say = (s, f) => { try { f(); console.log('  ok   ' + s); ok++; } catch (e) { console.log('  FAIL ' + s + ' -> ' + e.message); process.exitCode = 1; } };

// fake clock
let now = 0, timers = [];
const setT = (fn, ms) => { const t = { fn, at: now + ms, id: Math.random() }; timers.push(t); return t; };
const clearT = (t) => { timers = timers.filter((x) => x !== t); };
const advance = (ms) => { now += ms; timers.filter((t) => t.at <= now).forEach((t) => { timers = timers.filter((x) => x !== t); t.fn(); }); };

// a 1000x500 box showing a 1080x2400 portrait phone: picture is letterboxed to 225x500, centered at left 387.5
const r = P.pictureRect(1000, 500, 1080, 2400);
let sent = [], on = true;
const c = P.create({ send: (m) => sent.push(m), enabled: () => on, rect: () => r, setTimeout: setT, clearTimeout: clearT });
const px = (nx) => r.left + nx * r.w, py = (ny) => r.top + ny * r.h;

say('picture is letterboxed to the right shape and centered', () => { assert(Math.abs(r.w - 225) < 0.01 && Math.abs(r.h - 500) < 0.01 && Math.abs(r.left - 387.5) < 0.01 && r.top === 0); });
say('positions are normalized to the picture, clamped', () => {
  const n = P.norm(px(0.5), py(0.25), r); assert(n.x === 0.5 && n.y === 0.25 && n.inside);
  const o = P.norm(10, 10, r); assert(!o.inside && o.x === 0);
});
say('click = tap at the right spot', () => { sent = []; c.mouseDown(px(0.3), py(0.6), now); advance(100); c.mouseUp(px(0.3), py(0.6), now); assert.deepStrictEqual(sent, [{ t: 'tap', x: 0.3, y: 0.6 }]); });
say('click outside the picture does nothing', () => { sent = []; c.mouseDown(10, 10, now); c.mouseUp(10, 10, now); assert.deepStrictEqual(sent, []); });
say('hold 500 ms = long press (once, not also a tap)', () => { sent = []; c.mouseDown(px(0.5), py(0.5), now); advance(499); assert.strictEqual(sent.length, 0); advance(2); c.mouseUp(px(0.5), py(0.5), now); assert.deepStrictEqual(sent, [{ t: 'long', x: 0.5, y: 0.5 }]); });
say('drag = swipe with the real duration', () => { sent = []; c.mouseDown(px(0.5), py(0.8), now); c.mouseMove(px(0.5), py(0.5)); advance(300); c.mouseUp(px(0.5), py(0.2), now); assert.deepStrictEqual(sent, [{ t: 'swipe', x1: 0.5, y1: 0.8, x2: 0.5, y2: 0.2, ms: 300 }]); });
say('swipe time is clamped to 50..3000 ms', () => {
  sent = []; c.mouseDown(px(0.5), py(0.8), now); c.mouseMove(px(0.5), py(0.5)); c.mouseUp(px(0.5), py(0.2), now); assert.strictEqual(sent[0].ms, 50);
  sent = []; c.mouseDown(px(0.5), py(0.8), now); c.mouseMove(px(0.5), py(0.5)); advance(10000); c.mouseUp(px(0.5), py(0.2), now); assert.strictEqual(sent[0].ms, 3000);
});
say('drag ending outside the picture is clamped to its edge', () => { sent = []; c.mouseDown(px(0.5), py(0.5), now); c.mouseMove(0, 0); advance(200); c.mouseUp(0, 0, now); assert(sent[0].x2 === 0 && sent[0].y2 === 0); });
say('wheel down = finger swipes up (content scrolls down); events are merged', () => {
  sent = []; c.wheel(px(0.5), py(0.5), 0, 50); c.wheel(px(0.5), py(0.5), 0, 50); assert.strictEqual(sent.length, 0); advance(130);
  assert.strictEqual(sent.length, 1); const m = sent[0]; assert(m.t === 'swipe' && m.y1 > m.y2 && m.ms === 250 && m.x1 === m.x2);
});
say('wheel up = finger swipes down', () => { sent = []; c.wheel(px(0.5), py(0.5), 0, -100); advance(130); assert(sent[0].y1 < sent[0].y2); });
say('typing is batched into one text message; Backspace and Enter are keys', () => {
  sent = []; c.key({ key: 'h' }); c.key({ key: 'i' }); advance(50);
  assert.deepStrictEqual(sent, [{ t: 'text', s: 'hi' }]);
  sent = []; c.key({ key: 'a' }); c.key({ key: 'Backspace' }); assert.deepStrictEqual(sent, [{ t: 'text', s: 'a' }, { t: 'key', k: 'Backspace' }]);
  sent = []; assert(c.key({ key: 'Enter' })); assert.deepStrictEqual(sent, [{ t: 'key', k: 'Enter' }]);
});
say('shortcuts and special keys are left to the browser', () => { sent = []; assert(!c.key({ key: 'c', ctrlKey: true })); assert(!c.key({ key: 'ArrowLeft' })); advance(100); assert.deepStrictEqual(sent, []); });
say('pasted text over 200 characters is split into messages of at most 200', () => { sent = []; c.typeText('x'.repeat(450)); advance(50); assert(sent.length === 3 && sent.every((m) => m.s.length <= 200) && sent.map((m) => m.s).join('').length === 450); });
say('control characters are removed from typed text', () => { sent = []; c.typeText('a\u0000b\u001bc'); advance(50); assert.strictEqual(sent[0].s, 'abc'); });
say('nav buttons: only the four allowed names', () => { sent = []; c.nav('back'); c.nav('home'); c.nav('recents'); c.nav('notifications'); c.nav('power'); assert.deepStrictEqual(sent.map((m) => m.k), ['back', 'home', 'recents', 'notifications']); });
say('nothing is sent while controlling is switched off', () => {
  on = false; sent = []; c.mouseDown(px(0.5), py(0.5), now); c.mouseUp(px(0.5), py(0.5), now); c.wheel(px(0.5), py(0.5), 0, 100); c.key({ key: 'q' }); c.nav('home'); advance(500); assert.deepStrictEqual(sent, []); on = true;
});
console.log(ok + ' checks passed');
