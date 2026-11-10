'use strict';
// Checks how phone messages turn into Windows keyboard and mouse actions, and that the
// memory layout we hand to Windows is the right shape. Runs on any computer.
const assert = require('assert');
const { translate, createInjector, defineTypes, toStruct, MOUSE, KEYF, VK } = require('./inject');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}
console.log('Testing phone-to-laptop input');

check('moves the pointer using 0 to 65535 across the screen', () => {
  const [r] = translate({ t: 'm', x: 0.5, y: 1 });
  assert.strictEqual(r.type, 0);
  assert.strictEqual(r.mi.dwFlags, MOUSE.MOVE | MOUSE.ABSOLUTE);
  assert.strictEqual(r.mi.dx, 32768);
  assert.strictEqual(r.mi.dy, 65535);
});

check('keeps positions inside the screen and refuses nonsense', () => {
  const [r] = translate({ t: 'm', x: -4, y: 9 });
  assert.strictEqual(r.mi.dx, 0); assert.strictEqual(r.mi.dy, 65535);
  assert.deepStrictEqual(translate({ t: 'm', x: 'a', y: 1 }), []);
  assert.deepStrictEqual(translate({ t: 'm', x: NaN, y: 1 }), []);
  assert.deepStrictEqual(translate({ t: 'm', x: Infinity, y: 1 }), []);
});

check('left and right clicks are a down then an up', () => {
  assert.deepStrictEqual(translate({ t: 'c', b: 'l' }).map((r) => r.mi.dwFlags), [MOUSE.LEFTDOWN, MOUSE.LEFTUP]);
  assert.deepStrictEqual(translate({ t: 'c', b: 'r' }).map((r) => r.mi.dwFlags), [MOUSE.RIGHTDOWN, MOUSE.RIGHTUP]);
});

check('button down and up work on their own (for dragging)', () => {
  assert.strictEqual(translate({ t: 'd', b: 'l' })[0].mi.dwFlags, MOUSE.LEFTDOWN);
  assert.strictEqual(translate({ t: 'u', b: 'l' })[0].mi.dwFlags, MOUSE.LEFTUP);
  assert.deepStrictEqual(translate({ t: 'd', b: 'x' }), []);
});

check('scrolling goes the natural way and is capped', () => {
  assert.strictEqual(translate({ t: 'w', dx: 0, dy: -40 })[0].mi.mouseData, -120);
  assert.strictEqual(translate({ t: 'w', dx: 0, dy: 40 })[0].mi.mouseData, 120);
  assert.strictEqual(translate({ t: 'w', dx: 0, dy: 99999 })[0].mi.mouseData, 1200);
  const sideways = translate({ t: 'w', dx: 20, dy: 0 });
  assert.strictEqual(sideways[0].mi.dwFlags, MOUSE.HWHEEL);
  assert.deepStrictEqual(translate({ t: 'w', dx: 0, dy: 0 }), []);
});

check('pinch zoom holds Ctrl, turns the wheel, lets go of Ctrl', () => {
  const l = translate({ t: 'z', dz: 1 });
  assert.strictEqual(l.length, 3);
  assert.strictEqual(l[0].ki.wVk, VK.Control); assert.strictEqual(l[0].ki.dwFlags, 0);
  assert.strictEqual(l[1].mi.mouseData, 120);
  assert.strictEqual(l[2].ki.dwFlags, KEYF.KEYUP);
  assert.strictEqual(translate({ t: 'z', dz: -50 })[1].mi.mouseData, -360);
  assert.deepStrictEqual(translate({ t: 'z', dz: 0.2 }), []);
});

check('typed text becomes key presses for each character', () => {
  const l = translate({ t: 'k', s: 'Hi' });
  assert.strictEqual(l.length, 4);
  assert.strictEqual(l[0].ki.wScan, 72); assert.strictEqual(l[0].ki.dwFlags, KEYF.UNICODE);
  assert.strictEqual(l[1].ki.dwFlags, KEYF.UNICODE | KEYF.KEYUP);
  assert.strictEqual(l[2].ki.wScan, 105);
});

check('typing handles new lines, symbols and long text safely', () => {
  const l = translate({ t: 'k', s: 'a\nb' });
  assert.strictEqual(l[2].ki.wVk, VK.Enter);
  assert.strictEqual(translate({ t: 'k', s: '₦' })[0].ki.wScan, 0x20A6);
  assert.strictEqual(translate({ t: 'k', s: 'x'.repeat(5000) }).length, 400);
  assert.deepStrictEqual(translate({ t: 'k', s: '' }), []);
  assert.deepStrictEqual(translate({ t: 'k', s: 42 }), []);
});

check('special keys work and others are refused', () => {
  const b = translate({ t: 'key', k: 'Backspace' });
  assert.strictEqual(b[0].ki.wVk, VK.Backspace);
  assert.strictEqual(b[1].ki.dwFlags & KEYF.KEYUP, KEYF.KEYUP);
  assert.strictEqual(translate({ t: 'key', k: 'ArrowLeft' })[0].ki.dwFlags & KEYF.EXTENDED, KEYF.EXTENDED);
  assert.deepStrictEqual(translate({ t: 'key', k: 'Meta' }), []);
  assert.deepStrictEqual(translate({ t: 'key', k: 'F4' }), []);
});

check('unknown or broken messages do nothing', () => {
  assert.deepStrictEqual(translate(null), []);
  assert.deepStrictEqual(translate('hello'), []);
  assert.deepStrictEqual(translate({ t: 'format-disk' }), []);
  assert.deepStrictEqual(translate({}), []);
});

check('the gatekeeper passes good messages to the backend', () => {
  const sent = [];
  const inj = createInjector({ send: (l) => sent.push(l) });
  assert.strictEqual(inj.handle({ t: 'c', b: 'l' }), 2);
  assert.strictEqual(inj.handle({ t: 'nope' }), 0);
  assert.strictEqual(sent.length, 1);
});

check('the gatekeeper slows a flood down to about 600 per second', () => {
  let clock = 0;
  const sent = [];
  const inj = createInjector({ send: (l) => sent.push(l) }, { now: () => clock });
  let accepted = 0;
  for (let i = 0; i < 5000; i++) accepted += inj.handle({ t: 'm', x: 0.1, y: 0.1 }) ? 1 : 0;
  assert.ok(accepted >= 600 && accepted < 700, 'accepted ' + accepted);
  clock += 1000;
  let later = 0;
  for (let i = 0; i < 5000; i++) later += inj.handle({ t: 'm', x: 0.1, y: 0.1 }) ? 1 : 0;
  assert.ok(later >= 590 && later <= 610, 'after a second ' + later);
});

// ---- the memory layout handed to Windows ----
const koffi = require('koffi');
const T = defineTypes(koffi);

check('the INPUT record is 40 bytes, as Windows expects on 64-bit', () => {
  assert.strictEqual(koffi.sizeof(T.INPUT), 40);
  assert.strictEqual(koffi.sizeof(T.MOUSEINPUT), 32);
});

check('mouse fields sit at the offsets Windows reads them from', () => {
  const b = Buffer.alloc(40);
  const rec = toStruct({ type: 0, mi: { dx: 11, dy: 22, mouseData: -120, dwFlags: MOUSE.WHEEL, time: 0, dwExtraInfo: 0 } });
  koffi.encode(b, 0, T.INPUT, rec);
  assert.strictEqual(b.readUInt32LE(0), 0);          // type = mouse
  assert.strictEqual(b.readInt32LE(8), 11);          // dx
  assert.strictEqual(b.readInt32LE(12), 22);         // dy
  assert.strictEqual(b.readUInt32LE(16), 0xFFFFFF88); // mouseData, negative wheel as a 32-bit number
  assert.strictEqual(b.readUInt32LE(20), MOUSE.WHEEL); // dwFlags
});

check('keyboard fields sit at the offsets Windows reads them from', () => {
  const b = Buffer.alloc(40);
  const rec = toStruct({ type: 1, ki: { wVk: VK.Enter, wScan: 0x20A6, dwFlags: KEYF.UNICODE } });
  koffi.encode(b, 0, T.INPUT, rec);
  assert.strictEqual(b.readUInt32LE(0), 1);          // type = keyboard
  assert.strictEqual(b.readUInt16LE(8), VK.Enter);   // wVk
  assert.strictEqual(b.readUInt16LE(10), 0x20A6);    // wScan
  assert.strictEqual(b.readUInt32LE(12), KEYF.UNICODE); // dwFlags
});

check('a whole list of records is handed over in order, 40 bytes apart', () => {
  const list = [
    toStruct({ type: 0, mi: { dx: 1, dy: 2, mouseData: 0, dwFlags: MOUSE.LEFTDOWN } }),
    toStruct({ type: 1, ki: { wVk: 65, wScan: 0, dwFlags: 0 } }),
    toStruct({ type: 0, mi: { dx: 3, dy: 4, mouseData: 0, dwFlags: MOUSE.LEFTUP } }),
  ];
  const out = Buffer.alloc(120);
  koffi.encode(out, 0, koffi.array(T.INPUT, 3), list);
  assert.strictEqual(out.readUInt32LE(0), 0);   assert.strictEqual(out.readInt32LE(8), 1);
  assert.strictEqual(out.readUInt32LE(40), 1);  assert.strictEqual(out.readUInt16LE(48), 65);
  assert.strictEqual(out.readUInt32LE(80), 0);  assert.strictEqual(out.readInt32LE(88), 3);
});

console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', some failed' : ''));
