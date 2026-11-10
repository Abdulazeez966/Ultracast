'use strict';
/*
  UltraCast input injection (step 3)

  Turns the phone's small, simple messages ("move here", "click", "scroll", "type this")
  into real keyboard and mouse actions on Windows.

  Think of it as a puppeteer's hands. The phone sends instructions on a card, this module checks the
  card is sane (no nonsense numbers, nothing huge, not too many per second), then performs the action
  through Windows' own "SendInput" function, the same door a real mouse and keyboard use.

  Two halves:
    translate()  - pure logic, works anywhere, easy to test
    backends     - the part that really touches Windows (only runs on Windows)
*/

// ---- Windows constants ----
const MOUSE = {
  MOVE: 0x0001, LEFTDOWN: 0x0002, LEFTUP: 0x0004, RIGHTDOWN: 0x0008, RIGHTUP: 0x0010,
  WHEEL: 0x0800, HWHEEL: 0x1000, ABSOLUTE: 0x8000,
};
const KEYF = { EXTENDED: 0x0001, KEYUP: 0x0002, UNICODE: 0x0004 };
const VK = {
  Backspace: 0x08, Tab: 0x09, Enter: 0x0D, Escape: 0x1B, Delete: 0x2E,
  Home: 0x24, End: 0x23, ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  Control: 0x11,
};
// Keys on the grey "navigation" block need an extra flag so Windows treats them correctly.
const EXTENDED = new Set(['Delete', 'Home', 'End', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']);
const ALLOWED_KEYS = new Set(['Backspace', 'Tab', 'Enter', 'Escape', 'Delete', 'Home', 'End', 'ArrowLeft', 'ArrowUp', 'ArrowRight', 'ArrowDown']);

const MAX_TEXT = 200;      // characters per message
const MAX_WHEEL = 1200;    // wheel units per message (10 notches)
const BURST = 600;         // messages allowed in a burst
const REFILL_PER_MS = 0.6; // then 600 messages per second

// ---- helpers ----
const isNum = (v) => typeof v === 'number' && Number.isFinite(v);
const clamp = (n, lo, hi) => (n < lo ? lo : n > hi ? hi : n);
const mouse = (flags, data = 0, dx = 0, dy = 0) => ({ type: 0, mi: { dx, dy, mouseData: data, dwFlags: flags } });
const keybd = (vk, scan, flags) => ({ type: 1, ki: { wVk: vk, wScan: scan, dwFlags: flags } });
const wheelUnits = (px) => Math.round(clamp(px * 3, -MAX_WHEEL, MAX_WHEEL));

function pressKey(name) {
  const f = EXTENDED.has(name) ? KEYF.EXTENDED : 0;
  return [keybd(VK[name], 0, f), keybd(VK[name], 0, f | KEYF.KEYUP)];
}

// Turns one phone message into a list of Windows input records. Invalid message -> empty list.
function translate(msg) {
  if (!msg || typeof msg !== 'object') return [];
  switch (msg.t) {
    case 'm': { // move the pointer (x and y are 0 to 1 across the shared screen)
      if (!isNum(msg.x) || !isNum(msg.y)) return [];
      return [mouse(MOUSE.MOVE | MOUSE.ABSOLUTE, 0, Math.round(clamp(msg.x, 0, 1) * 65535), Math.round(clamp(msg.y, 0, 1) * 65535))];
    }
    case 'd': case 'u': { // button down / button up
      if (msg.b !== 'l' && msg.b !== 'r') return [];
      const down = msg.t === 'd';
      const flag = msg.b === 'l' ? (down ? MOUSE.LEFTDOWN : MOUSE.LEFTUP) : (down ? MOUSE.RIGHTDOWN : MOUSE.RIGHTUP);
      return [mouse(flag)];
    }
    case 'c': { // a full click
      if (msg.b !== 'l' && msg.b !== 'r') return [];
      return msg.b === 'l'
        ? [mouse(MOUSE.LEFTDOWN), mouse(MOUSE.LEFTUP)]
        : [mouse(MOUSE.RIGHTDOWN), mouse(MOUSE.RIGHTUP)];
    }
    case 'w': { // scroll, in finger pixels
      const out = [];
      if (isNum(msg.dy) && wheelUnits(msg.dy) !== 0) out.push(mouse(MOUSE.WHEEL, wheelUnits(msg.dy)));
      if (isNum(msg.dx) && wheelUnits(msg.dx) !== 0) out.push(mouse(MOUSE.HWHEEL, wheelUnits(msg.dx)));
      return out;
    }
    case 'z': { // pinch zoom = hold Ctrl and turn the wheel
      if (!isNum(msg.dz)) return [];
      const notches = clamp(Math.round(msg.dz), -3, 3);
      if (notches === 0) return [];
      return [keybd(VK.Control, 0, 0), mouse(MOUSE.WHEEL, notches * 120), keybd(VK.Control, 0, KEYF.KEYUP)];
    }
    case 'k': { // typed text
      if (typeof msg.s !== 'string' || msg.s.length === 0) return [];
      const out = [];
      const s = msg.s.slice(0, MAX_TEXT);
      for (let i = 0; i < s.length; i++) {
        const code = s.charCodeAt(i);
        if (code === 13) continue;                       // carriage return: ignore
        if (code === 10) { out.push(...pressKey('Enter')); continue; }
        out.push(keybd(0, code, KEYF.UNICODE), keybd(0, code, KEYF.UNICODE | KEYF.KEYUP));
      }
      return out;
    }
    case 'key': { // one special key
      if (typeof msg.k !== 'string' || !ALLOWED_KEYS.has(msg.k)) return [];
      return pressKey(msg.k);
    }
    default: return [];
  }
}

// The gatekeeper: limits how fast messages are accepted, then performs them through a backend.
function createInjector(backend, opts = {}) {
  const now = opts.now || Date.now;
  let tokens = BURST;
  let last = now();
  return {
    handle(msg) {
      const t = now();
      tokens = Math.min(BURST, tokens + (t - last) * REFILL_PER_MS);
      last = t;
      if (tokens < 1) return 0;
      tokens -= 1;
      const list = translate(msg);
      if (!list.length) return 0;
      backend.send(list);
      return list.length;
    },
  };
}

// ---- the real Windows backend ----
// These definitions must match Windows' own memory layout exactly (INPUT is 40 bytes on 64-bit).
function defineTypes(koffi) {
  const MOUSEINPUT = koffi.struct('MOUSEINPUT', { dx: 'int32', dy: 'int32', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
  const KEYBDINPUT = koffi.struct('KEYBDINPUT', { wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t' });
  const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' });
  const INPUT_UNION = koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT });
  const INPUT = koffi.struct('INPUT', { type: 'uint32', u: INPUT_UNION });
  return { MOUSEINPUT, KEYBDINPUT, HARDWAREINPUT, INPUT_UNION, INPUT };
}

// Converts our simple record into the shape the Windows struct expects.
function toStruct(r) {
  if (r.mi) {
    return { type: 0, u: { mi: { dx: r.mi.dx | 0, dy: r.mi.dy | 0, mouseData: r.mi.mouseData >>> 0, dwFlags: r.mi.dwFlags >>> 0, time: 0, dwExtraInfo: 0 } } };
  }
  return { type: 1, u: { ki: { wVk: r.ki.wVk, wScan: r.ki.wScan, dwFlags: r.ki.dwFlags >>> 0, time: 0, dwExtraInfo: 0 } } };
}

function windowsBackend() {
  const koffi = require('koffi');
  const T = defineTypes(koffi);
  const user32 = koffi.load('user32.dll');
  const SendInput = user32.func('uint32 __stdcall SendInput(uint32 cInputs, INPUT *pInputs, int cbSize)');
  const size = koffi.sizeof(T.INPUT);
  return {
    send(list) {
      const arr = list.map(toStruct);
      return SendInput(arr.length, arr, size);
    },
  };
}

// Off Windows there is nothing to control, so we only note what would have happened.
function noopBackend() {
  const log = !!process.env.ULTRACAST_DEBUG_INPUT;
  return { send(list) { if (log) console.log('[input]', JSON.stringify(list)); return list.length; } };
}

function createBackend() {
  if (process.platform === 'win32') {
    try { return windowsBackend(); } catch (e) { console.error('Could not start Windows input:', e.message); }
  }
  return noopBackend();
}

module.exports = { translate, createInjector, createBackend, defineTypes, toStruct, MOUSE, KEYF, VK };
