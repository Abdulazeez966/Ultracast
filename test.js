'use strict';
// Automated checks for the server. Run with: npm test
const assert = require('assert');
const http = require('http');
const WebSocket = require('ws');
const { start } = require('./server');

function connect(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket('ws://127.0.0.1:' + port + '/ws');
    const queue = [];
    const waiters = [];
    let closed = null;
    ws.on('message', (d) => {
      const m = JSON.parse(d.toString());
      if (waiters.length) waiters.shift()(m); else queue.push(m);
    });
    ws.on('close', (code) => { closed = code; });
    ws.on('error', reject);
    ws.on('open', () => resolve({
      ws,
      send: (o) => ws.send(typeof o === 'string' ? o : JSON.stringify(o)),
      next: () => new Promise((res, rej) => {
        if (queue.length) return res(queue.shift());
        const t = setTimeout(() => rej(new Error('timed out waiting for a message')), 2000);
        waiters.push((m) => { clearTimeout(t); res(m); });
      }),
      closedWith: () => new Promise((res) => {
        if (closed !== null) return res(closed);
        ws.on('close', (c) => res(c));
      }),
    }));
  });
}

function get(port, p) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: p }, (r) => {
      let body = '';
      r.on('data', (c) => (body += c));
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body }));
    }).on('error', reject);
  });
}

let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}

(async () => {
  const s = await start({ port: 0 });
  const port = s.port;
  console.log('Testing server on port ' + port);

  await check('serves the viewer page with safe headers', async () => {
    const r = await get(port, '/');
    assert.strictEqual(r.status, 200);
    assert.ok(r.body.includes('UltraCast'));
    assert.ok(r.headers['content-security-policy']);
    assert.strictEqual(r.headers['cache-control'], 'no-store');
  });

  await check('returns 404 for other paths', async () => {
    const r = await get(port, '/server.js');
    assert.strictEqual(r.status, 404);
  });

  await check('rejects a host with the wrong key', async () => {
    const h = await connect(port);
    h.send({ type: 'hello', role: 'host', hostKey: 'nope' });
    assert.strictEqual((await h.next()).reason, 'bad-host-key');
  });

  const host = await connect(port);
  await check('accepts the real host', async () => {
    host.send({ type: 'hello', role: 'host', hostKey: s.hostKey });
    assert.strictEqual((await host.next()).type, 'ready');
  });

  const p1 = s.newPairing();
  await check('makes a pairing address for each private network', async () => {
    assert.strictEqual(p1.token.length, 32);
    p1.urls.forEach((u) => assert.ok(u.url.includes('?t=' + p1.token)));
  });

  await check('rejects a wrong code', async () => {
    const v = await connect(port);
    v.send({ type: 'hello', role: 'viewer', token: 'wrong' });
    assert.strictEqual((await v.next()).reason, 'bad-token');
  });

  const viewer = await connect(port);
  await check('pairs a phone with the right code', async () => {
    viewer.send({ type: 'hello', role: 'viewer', token: p1.token });
    assert.strictEqual((await viewer.next()).type, 'ready');
    assert.strictEqual((await host.next()).type, 'peer-joined');
  });

  await check('relays signals both ways', async () => {
    host.send({ type: 'signal', data: { sdp: 'offer' } });
    const a = await viewer.next();
    assert.strictEqual(a.type, 'signal');
    assert.deepStrictEqual(a.data, { sdp: 'offer' });
    viewer.send({ type: 'signal', data: { sdp: 'answer' } });
    const b = await host.next();
    assert.deepStrictEqual(b.data, { sdp: 'answer' });
  });

  await check('a used code cannot be used again', async () => {
    const v2 = await connect(port);
    v2.send({ type: 'hello', role: 'viewer', token: p1.token });
    assert.strictEqual((await v2.next()).reason, 'expired');
  });

  await check('tells the host when the phone leaves', async () => {
    viewer.ws.close();
    assert.strictEqual((await host.next()).type, 'peer-left');
  });

  await check('rejects broken messages', async () => {
    const c = await connect(port);
    c.send('this is not json');
    assert.strictEqual(await c.closedWith(), 1003);
  });

  await check('rejects a first message that is not hello', async () => {
    const c = await connect(port);
    c.send({ type: 'signal', data: {} });
    assert.strictEqual(await c.closedWith(), 1008);
  });

  await check('closes oversized messages', async () => {
    const c = await connect(port);
    c.send(JSON.stringify({ type: 'hello', pad: 'x'.repeat(70 * 1024) }));
    assert.strictEqual(await c.closedWith(), 1009);
  });

  await check('locks the code after 5 wrong tries', async () => {
    const p2 = s.newPairing();
    for (let i = 0; i < 5; i++) {
      const v = await connect(port);
      v.send({ type: 'hello', role: 'viewer', token: 'bad' + i });
      assert.strictEqual((await v.next()).reason, 'bad-token');
    }
    const good = await connect(port);
    good.send({ type: 'hello', role: 'viewer', token: p2.token });
    assert.strictEqual((await good.next()).reason, 'locked');
  });

  await check('a new code resets the lock', async () => {
    const p3 = s.newPairing();
    const v = await connect(port);
    v.send({ type: 'hello', role: 'viewer', token: p3.token });
    assert.strictEqual((await v.next()).type, 'ready');
  });

  console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', some failed' : ''));
  await s.close();
  process.exit(process.exitCode || 0);
})();
