'use strict';
// Trusted devices, the matching number maths, and the returning-phone challenge on the real server.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const WebSocket = require('ws');
const { start, proofFor } = require('./server');
const { createStore } = require('./devices');
const Sas = require('./renderer/sas');

let passed = 0;
async function check(name, fn) { try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; } }

function client(port) {
  const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
  const q = [], waiters = [];
  ws.on('message', (d) => { const m = JSON.parse(d.toString()); const w = waiters.shift(); if (w) w(m); else q.push(m); });
  let closed = false; ws.on('close', (code) => { closed = code || true; });
  return {
    ws, opened: new Promise((r) => ws.on('open', r)),
    send: (o) => ws.send(JSON.stringify(o)),
    next: (ms = 2000) => new Promise((res, rej) => { if (q.length) return res(q.shift()); const t = setTimeout(() => rej(new Error('timeout waiting for a message')), ms); waiters.push((m) => { clearTimeout(t); res(m); }); }),
    isClosed: () => closed,
    closeWait: () => new Promise((r) => { if (closed) return r(); ws.on('close', r); }),
  };
}

(async () => {
  console.log('Testing trusted devices and the returning-phone challenge');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-dev-'));
  const file = path.join(dir, 'devices.json');

  await check('the device list never shows secrets, and survives a restart', () => {
    const s = createStore(file);
    const d = s.add('  My <b>phone</b>\n');
    assert.ok(/^[0-9a-f]{16}$/.test(d.id) && /^[0-9a-f]{64}$/.test(d.secret));
    assert.strictEqual(d.name, 'My bphone/b');
    assert.ok(!JSON.stringify(s.list()).includes(d.secret));
    const again = createStore(file);
    assert.strictEqual(again.list().length, 1);
    assert.strictEqual(again.lookup(d.id), d.secret);
  });
  await check('rename, remove and unknown ids behave', () => {
    const s = createStore(file);
    const id = s.list()[0].id;
    assert.ok(s.rename(id, 'Work phone') && s.name(id) === 'Work phone');
    assert.strictEqual(s.lookup('nope'), null);
    assert.ok(s.remove(id) && s.lookup(id) === null && !s.remove(id));
    assert.strictEqual(createStore(file).list().length, 0);
  });
  await check('a damaged devices file is ignored, not fatal', () => {
    fs.writeFileSync(file, '{not json');
    assert.deepStrictEqual(createStore(file).list(), []);
  });

  await check('the in-page fingerprint machine matches the real SHA-256 and HMAC', () => {
    for (const s of ['', 'abc', 'x'.repeat(55), 'x'.repeat(56), 'x'.repeat(64), 'é€'.repeat(40)])
      assert.strictEqual(Sas.hex(Sas.sha256(s)), crypto.createHash('sha256').update(s).digest('hex'));
    assert.strictEqual(Sas.hmacHex('k'.repeat(64), 'hello'), crypto.createHmac('sha256', 'k'.repeat(64)).update('hello').digest('hex'));
  });
  await check('both sides get the same four digits, and a swapped fingerprint changes them', () => {
    const mk = (fp) => 'v=0\r\na=fingerprint:sha-256 ' + fp + '\r\n';
    const A = mk('AA:BB:CC'), B = mk('11:22:33');
    const one = Sas.sas(A, B), other = Sas.sas(B, A);
    assert.ok(/^\d{4}$/.test(one));
    assert.strictEqual(one, other);
    const tampered = Sas.sas(A, mk('11:22:34'));
    assert.notStrictEqual(tampered, one);
    assert.strictEqual(Sas.sas('nothing', 'here'), null);
  });

  const store = createStore(path.join(dir, 'd2.json'));
  const dev = store.add('Test phone');
  const s = await start({ port: 0, trust: store });
  const hostC = client(s.port); await hostC.opened;
  hostC.send({ type: 'hello', role: 'host', hostKey: s.hostKey }); assert.strictEqual((await hostC.next()).type, 'ready');

  await check('a returning phone gets a challenge, answers it, and the laptop is told who it is', async () => {
    const p = client(s.port); await p.opened;
    p.send({ type: 'hello', role: 'viewer', deviceId: dev.id });
    const ch = await p.next(); assert.strictEqual(ch.type, 'challenge'); assert.ok(/^[0-9a-f]{32}$/.test(ch.nonce));
    p.send({ type: 'proof', mac: proofFor(dev.secret, ch.nonce) });
    const ready = await p.next(); assert.strictEqual(ready.type, 'ready'); assert.strictEqual(ready.trusted, true);
    const joined = await hostC.next();
    assert.deepStrictEqual([joined.type, joined.trusted, joined.deviceId, joined.name], ['peer-joined', true, dev.id, 'Test phone']);
    p.ws.close(); await hostC.next(); // peer-left
  });
  await check('the in-page proof maker produces what the server expects', async () => {
    const p = client(s.port); await p.opened;
    p.send({ type: 'hello', role: 'viewer', deviceId: dev.id });
    const ch = await p.next();
    p.send({ type: 'proof', mac: Sas.hmacHex(dev.secret, 'ultracast-proof:' + ch.nonce) });
    assert.strictEqual((await p.next()).type, 'ready');
    await hostC.next(); p.ws.close(); await hostC.next();
  });
  await check('a wrong proof is refused and the laptop hears nothing', async () => {
    const p = client(s.port); await p.opened;
    p.send({ type: 'hello', role: 'viewer', deviceId: dev.id });
    await p.next();
    p.send({ type: 'proof', mac: 'f'.repeat(64) });
    assert.strictEqual((await p.next()).reason, 'bad-proof');
    await p.closeWait();
  });
  await check('a proof for an old challenge cannot be replayed on a new one', async () => {
    const a = client(s.port); await a.opened; a.send({ type: 'hello', role: 'viewer', deviceId: dev.id });
    const c1 = await a.next(); a.ws.close();
    const b = client(s.port); await b.opened; b.send({ type: 'hello', role: 'viewer', deviceId: dev.id });
    const c2 = await b.next(); assert.notStrictEqual(c1.nonce, c2.nonce);
    b.send({ type: 'proof', mac: proofFor(dev.secret, c1.nonce) });
    assert.strictEqual((await b.next()).reason, 'bad-proof');
  });
  await check('an unknown or removed device is refused', async () => {
    const p = client(s.port); await p.opened;
    p.send({ type: 'hello', role: 'viewer', deviceId: 'deadbeefdeadbeef' });
    assert.strictEqual((await p.next()).reason, 'unknown-device');
  });
  await check('five wrong answers lock that address out, even for the right proof', async () => {
    for (let i = 0; i < 3; i++) { // two bad proofs already happened above plus the unknown device: 3 more reaches 5
      const p = client(s.port); await p.opened; p.send({ type: 'hello', role: 'viewer', deviceId: 'deadbeefdeadbeef' }); await p.next();
    }
    const p = client(s.port); await p.opened;
    p.send({ type: 'hello', role: 'viewer', deviceId: dev.id });
    assert.strictEqual((await p.next()).reason, 'locked');
  });
  await check('a new pairing code carries the phone name to the laptop', async () => {
    const s2 = await start({ port: 0, trust: store });
    const h = client(s2.port); await h.opened; h.send({ type: 'hello', role: 'host', hostKey: s2.hostKey }); await h.next();
    const tok = s2.newPairing().token;
    const p = client(s2.port); await p.opened; p.send({ type: 'hello', role: 'viewer', token: tok, name: ' Pixel <7> ' });
    const r = await p.next(); assert.strictEqual(r.trusted, false);
    const j = await h.next(); assert.deepStrictEqual([j.trusted, j.deviceId, j.name], [false, null, 'Pixel 7']);
    s2.disconnect(); await p.closeWait();
    await s2.close();
  });

  console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', some failed' : ''));
  await s.close(); process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
