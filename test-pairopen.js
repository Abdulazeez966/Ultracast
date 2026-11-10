'use strict';
// The phone app can say "pair" instead of typing a code, but only while the laptop is waiting to add a phone.
const WebSocket = require('ws');
const { start } = require('./server');
let ok = 0, bad = 0; const say = (s, p) => { console.log((p ? '  ok   ' : '  FAIL ') + s); p ? ok++ : bad++; };
function hello(port, payload) {
  return new Promise((res) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws'); const got = [];
    ws.on('open', () => ws.send(JSON.stringify(Object.assign({ type: 'hello', role: 'viewer' }, payload))));
    ws.on('message', (m) => got.push(JSON.parse(m)));
    ws.on('close', () => res({ got, ws }));
    setTimeout(() => res({ got, ws }), 600);
  });
}
(async () => {
  const s = await start({ port: 0 });
  say('closed by default', s.pairingOpen() === false);
  let r = await hello(s.port, { pair: true, name: 'Pixel' });
  say('"pair" is refused while the laptop is not adding a phone', r.got[0] && r.got[0].reason === 'expired');
  s.newPairing();
  say('open after "Add new device"', s.pairingOpen() === true);
  r = await hello(s.port, { pair: true, name: 'Pixel' });
  say('"pair" is accepted while open, and not marked trusted', r.got[0] && r.got[0].type === 'ready' && r.got[0].trusted === false);
  say('and the laptop stops advertising open pairing', s.pairingOpen() === false);
  r.ws.close();
  s.newPairing();
  r = await hello(s.port, { token: 'wrong', name: 'x' });
  say('a wrong code is still refused', r.got[0] && r.got[0].reason === 'bad-token');
  await s.close(); console.log(ok + ' checks passed'); process.exit(bad ? 1 : 0);
})();
