'use strict';
// Guide security-and-attacks.md #19: another website must not be able to open a socket to the front desk.
const WebSocket = require('ws');
const { start, originAllowed } = require('./server');
let ok = 0, bad = 0; const say = (s, p) => { console.log((p ? '  ok   ' : '  FAIL ') + s); p ? ok++ : bad++; };
const tryOpen = (url, headers) => new Promise((res) => { const w = new WebSocket(url, { headers }); w.on('open', () => { w.close(); res(true); }); w.on('error', () => res(false)); w.on('unexpected-response', () => res(false)); });
(async () => {
  const s = await start({ port: 0, info: () => ({ name: 'T', hid: 'cccccccccccccccc' }) });
  const url = 'ws://127.0.0.1:' + s.port + '/ws', host = '127.0.0.1:' + s.port;
  say('the Android app (no Origin) is allowed', await tryOpen(url, {}));
  say('the phone page served by this front desk is allowed', await tryOpen(url, { Origin: 'http://' + host }));
  say('the laptop window (file origin) is allowed', await tryOpen(url, { Origin: 'file://' }));
  say('another website is refused', !(await tryOpen(url, { Origin: 'https://evil.example' })));
  say('another site on a lookalike port is refused', !(await tryOpen(url, { Origin: 'http://127.0.0.1:1' })));
  say('a made-up host name (DNS rebinding) is refused', !originAllowed('http://evil.example:8765', 'evil.example:8765'));
  say('localhost is a fine host', originAllowed(undefined, 'localhost:8765'));
  await s.close(); console.log(ok + ' checks passed'); process.exit(bad ? 1 : 0);
})();
