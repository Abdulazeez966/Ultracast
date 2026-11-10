'use strict';
// A quiet connection is kept for three missed beats (not one), and a normal one is never dropped.
const WebSocket = require('ws');
const { start } = require('./server');
let ok = 0, bad = 0; const say = (s, p) => { console.log((p ? '  ok   ' : '  FAIL ') + s); p ? ok++ : bad++; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const s = await start({ port: 0, heartbeatMs: 100, info: () => ({ name: 'T', hid: 'bbbbbbbbbbbbbbbb' }) });
  // a client that answers beats normally stays
  const good = new WebSocket('ws://127.0.0.1:' + s.port + '/ws');
  await new Promise((r) => good.on('open', r));
  // a client that never answers beats
  const mute = new WebSocket('ws://127.0.0.1:' + s.port + '/ws', { autoPong: false });
  await new Promise((r) => mute.on('open', r));
  const t0 = Date.now(); let closedAt = 0; mute.on('close', () => { closedAt = Date.now() - t0; });
  await sleep(220);
  say('a client that missed one or two beats is still connected', closedAt === 0);
  await sleep(600);
  say('a client that never answers is dropped after about three missed beats', closedAt >= 250 && closedAt <= 800);
  say('a client that answers beats is never dropped', good.readyState === WebSocket.OPEN);
  good.close(); await s.close(); console.log(ok + ' checks passed'); process.exit(bad ? 1 : 0);
})();
