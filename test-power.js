'use strict';
const assert = require('assert');
const { createPower } = require('./power');
(async () => {
  const ran = [];
  const mk = (confirmAns, platform) => createPower({ platform: platform || 'win32', exec: (c, a, cb) => { ran.push([c, a]); cb(null); }, confirm: async () => confirmAns });
  // unknown / injection attempts never run anything
  for (const bad of ['', 'format', 'lock; calc', null, 5, '__proto__', 'constructor']) assert.strictEqual((await mk(true).run(bad)).ok, false);
  assert.strictEqual(ran.length, 0);
  // lock needs no dialog
  assert.deepStrictEqual(await mk(false).run('lock'), { ok: true }); assert.strictEqual(ran.length, 1);
  // dangerous ones obey the dialog
  assert.strictEqual((await mk(false).run('shutdown')).ok, false); assert.strictEqual(ran.length, 1);
  assert.strictEqual((await mk(true).run('shutdown')).ok, true); assert.deepStrictEqual(ran[1], ['shutdown.exe', ['/s', '/t', '5']]);
  assert.strictEqual((await mk(true).run('restart')).ok, true);
  assert.strictEqual((await mk(true).run('sleep')).ok, true);
  // not Windows
  assert.strictEqual((await mk(true, 'linux').run('lock')).ok, false);
  // exec failure is reported
  const p = createPower({ platform: 'win32', exec: (c, a, cb) => cb(new Error('boom')), confirm: async () => true });
  assert.strictEqual((await p.run('lock')).ok, false);
  // one at a time
  let release; const slow = createPower({ platform: 'win32', exec: (c, a, cb) => cb(null), confirm: () => new Promise((r) => { release = r; }) });
  const first = slow.run('restart'); const second = await slow.run('lock'); assert.strictEqual(second.ok, false); release(true); assert.strictEqual((await first).ok, true);
  console.log('power: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
