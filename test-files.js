'use strict';
// Checks the file-receiving safety rules and the transfer engine (two engines wired together in memory).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { sanitizeName, isRisky, uniqueName, openIncoming } = require('./filesafe');
const UltraTransfer = require('./renderer/transfer');

let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return; await sleep(10); } throw new Error('timed out waiting for ' + what); }

(async () => {
  console.log('Testing file names, saving and the transfer engine');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-files-'));

  await check('file names lose any folder part and forbidden characters', () => {
    assert.strictEqual(sanitizeName('../../Windows/system32/evil.dll'), 'evil.dll');
    assert.strictEqual(sanitizeName('C:\\Users\\me\\a.txt'), 'a.txt');
    assert.strictEqual(sanitizeName('a<b>c:d"e|f?g*.txt'), 'a_b_c_d_e_f_g_.txt');
    assert.strictEqual(sanitizeName('line\nbreak\u0000.txt'), 'line_break_.txt');
  });
  await check('names Windows reserves, empty names and dot names are fixed', () => {
    assert.strictEqual(sanitizeName('CON'), '_CON');
    assert.strictEqual(sanitizeName('nul.txt'), '_nul.txt');
    assert.strictEqual(sanitizeName('com1.png'), '_com1.png');
    assert.strictEqual(sanitizeName(''), 'file');
    assert.strictEqual(sanitizeName('..'), 'file');
    assert.strictEqual(sanitizeName('report. . '), 'report');
    assert.strictEqual(sanitizeName('.gitignore'), '.gitignore');
  });
  await check('very long names are shortened but keep their ending', () => {
    const n = sanitizeName('x'.repeat(500) + '.mp4');
    assert.ok(n.length <= 200 && n.endsWith('.mp4'));
  });
  await check('program files are flagged as risky', () => {
    assert.ok(isRisky('setup.EXE') && isRisky('a.ps1') && !isRisky('photo.jpg') && !isRisky('exe'));
  });
  await check('a name already in use becomes "name (2).ext"', () => {
    fs.writeFileSync(path.join(dir, 'a.txt'), 'x'); fs.writeFileSync(path.join(dir, 'a (2).txt'), 'x');
    assert.strictEqual(uniqueName(dir, 'a.txt'), 'a (3).txt');
    assert.strictEqual(uniqueName(dir, 'fresh.txt'), 'fresh.txt');
  });
  await check('a complete file is saved under its real name, and the temporary box disappears', () => {
    const w = openIncoming(dir, 'ok.bin', 6, false);
    w.write(Buffer.from('abc')); w.write(Buffer.from('def'));
    assert.ok(fs.existsSync(path.join(dir, 'ok.bin.ucpart')));
    const r = w.finish();
    assert.ok(r.ok && r.path === path.join(dir, 'ok.bin'));
    assert.strictEqual(fs.readFileSync(r.path, 'utf8'), 'abcdef');
    assert.ok(!fs.existsSync(path.join(dir, 'ok.bin.ucpart')));
  });
  await check('an incomplete file is refused and leaves nothing behind', () => {
    const w = openIncoming(dir, 'short.bin', 10, false);
    w.write(Buffer.from('abc'));
    const r = w.finish();
    assert.ok(!r.ok);
    assert.ok(!fs.existsSync(path.join(dir, 'short.bin')) && !fs.existsSync(path.join(dir, 'short.bin.ucpart')));
  });
  await check('more data than announced stops the delivery and cleans up', () => {
    const w = openIncoming(dir, 'big.bin', 4, false);
    w.write(Buffer.from('abcd')); w.write(Buffer.from('e'));
    assert.ok(w.error);
    assert.ok(!w.finish().ok);
    assert.ok(!fs.existsSync(path.join(dir, 'big.bin.ucpart')));
  });
  await check('Replace overwrites; without Replace an appearing name is never overwritten', () => {
    fs.writeFileSync(path.join(dir, 'r.txt'), 'old');
    let w = openIncoming(dir, 'r.txt', 3, true); w.write(Buffer.from('new'));
    assert.strictEqual(fs.readFileSync(w.finish().path, 'utf8'), 'new');
    fs.writeFileSync(path.join(dir, 'q.txt'), 'old');
    w = openIncoming(dir, 'q.txt', 3, false); w.write(Buffer.from('new'));
    const r = w.finish();
    assert.strictEqual(fs.readFileSync(path.join(dir, 'q.txt'), 'utf8'), 'old');
    assert.strictEqual(path.basename(r.path), 'q (2).txt');
  });
  await check('aborting removes the temporary box', () => {
    const w = openIncoming(dir, 'gone.bin', 10, false); w.write(Buffer.from('ab')); w.abort();
    assert.ok(!fs.existsSync(path.join(dir, 'gone.bin.ucpart')));
  });

  // ---- two engines, wired to each other through an in-memory "bridge" ----
  function pair(opts = {}) {
    const got = { chunks: [], offers: [], ended: 0, aborted: 0 };
    const rcvDir = opts.dir || dir;
    let writer = null;
    let A, B;
    const lane = (to) => async (d) => { await sleep(0); if (opts.drop && typeof d !== 'string' && opts.drop()) return; to().onMessage(typeof d === 'string' ? d : d.slice().buffer); };
    const lists = { A: [], B: [] };
    A = UltraTransfer.create({ prefix: 'A', send: lane(() => B), api: {}, onChange: (l) => { lists.A = l; } });
    B = UltraTransfer.create({
      prefix: 'B', send: lane(() => A), onChange: (l) => { lists.B = l; },
      api: {
        offer: async (name, size) => { got.offers.push([name, size]); if (opts.decline) return { ok: false, reason: 'Declined on the laptop' }; writer = openIncoming(rcvDir, sanitizeName(name), size, false); return { ok: true, name: sanitizeName(name) }; },
        chunk: (b) => writer.write(Buffer.from(b)),
        end: async () => { got.ended++; return writer.finish(); },
        abort: () => { got.aborted++; if (writer) writer.abort(); },
      },
    });
    return { A, B, got, lists };
  }
  const fakeFile = (name, buf) => ({ name, size: buf.length, slice: (a, b) => ({ arrayBuffer: async () => buf.subarray(a, b).buffer.slice(buf.byteOffset + a, buf.byteOffset + b) }) });
  const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

  await check('a 3 MB file arrives byte for byte', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-t1-'));
    const { A, lists } = pair({ dir: d });
    const data = crypto.randomBytes(3 * 1024 * 1024 + 123);
    A.sendFiles([fakeFile('photo.jpg', data)]);
    await until(() => lists.A[0] && lists.A[0].state === 'done', 8000, 'sent');
    assert.strictEqual(sha(fs.readFileSync(path.join(d, 'photo.jpg'))), sha(data));
    assert.strictEqual(lists.B[0].state, 'done');
  });
  await check('several files go one after another', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-t2-'));
    const { A, lists } = pair({ dir: d });
    A.sendFiles([fakeFile('1.txt', Buffer.from('one')), fakeFile('2.txt', Buffer.from('two')), fakeFile('empty.txt', Buffer.alloc(0))]);
    await until(() => lists.A.length === 3 && lists.A.every((e) => e.state === 'done'), 5000, 'all three');
    assert.deepStrictEqual(fs.readdirSync(d).sort(), ['1.txt', '2.txt', 'empty.txt']);
  });
  await check('a declined file is reported to the sender and nothing is saved', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-t3-'));
    const { A, lists } = pair({ dir: d, decline: true });
    A.sendFiles([fakeFile('no.txt', Buffer.from('x'))]);
    await until(() => lists.A[0] && lists.A[0].state === 'rejected', 3000, 'rejected');
    assert.strictEqual(lists.A[0].note, 'Declined on the laptop');
    assert.deepStrictEqual(fs.readdirSync(d), []);
  });
  await check('a hostile file name is made safe on the receiving side', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-t4-'));
    const { A, lists } = pair({ dir: d });
    A.sendFiles([fakeFile('../../evil.txt', Buffer.from('x'))]);
    await until(() => lists.A[0] && lists.A[0].state === 'done', 3000, 'sent');
    assert.deepStrictEqual(fs.readdirSync(d), ['evil.txt']);
  });
  await check('cancelling the sender mid-way stops it and leaves no partial file', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-t5-'));
    const { A, lists, got } = pair({ dir: d });
    A.sendFiles([fakeFile('huge.bin', crypto.randomBytes(20 * 1024 * 1024))]);
    await until(() => lists.A[0] && lists.A[0].state === 'sending' && lists.A[0].done > 100000, 5000, 'some progress');
    A.cancel(lists.A[0].id);
    await until(() => lists.A[0].state === 'cancelled' && lists.B[0].state === 'cancelled', 3000, 'both cancelled');
    assert.ok(lists.A[0].done < lists.A[0].size);
    assert.deepStrictEqual(fs.readdirSync(d), []);
  });
  await check('cancelling on the receiving side stops the sender too', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-t6-'));
    const { A, B, lists } = pair({ dir: d });
    A.sendFiles([fakeFile('huge.bin', crypto.randomBytes(20 * 1024 * 1024))]);
    await until(() => lists.B[0] && lists.B[0].state === 'receiving' && lists.B[0].done > 100000, 5000, 'some progress');
    B.cancel(lists.B[0].id);
    await until(() => lists.A[0].state === 'cancelled', 3000, 'sender stops');
    assert.deepStrictEqual(fs.readdirSync(d), []);
  });
  await check('a file above 1 GB asks first and is not sent if the answer is no', async () => {
    let asked = 0, offered = 0;
    const lists = { A: [] };
    const A = UltraTransfer.create({ prefix: 'A', send: async (d) => { if (typeof d === 'string' && JSON.parse(d).t === 'offer') offered++; }, api: {}, confirmLarge: () => { asked++; return false; }, onChange: (l) => { lists.A = l; } });
    A.sendFiles([{ name: 'movie.mkv', size: 2 * 1024 * 1024 * 1024, slice() { throw new Error('should not read'); } }]);
    await until(() => lists.A[0] && lists.A[0].state === 'cancelled', 2000, 'cancelled');
    assert.strictEqual(asked, 1); assert.strictEqual(offered, 0);
  });
  await check('more data than announced is cut off by the receiver', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-t8-'));
    const { B, lists } = pair({ dir: d });
    B.onMessage(JSON.stringify({ t: 'offer', id: 'X1', name: 'a.bin', size: 4 }));
    await until(() => lists.B[0] && lists.B[0].state === 'receiving', 2000, 'accepted');
    B.onMessage(new Uint8Array(10).buffer);
    await until(() => lists.B[0].state === 'failed', 2000, 'failed');
    assert.deepStrictEqual(fs.readdirSync(d), []);
  });
  await check('a second offer while one is arriving gets "busy"', async () => {
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-t9-'));
    const replies = [];
    const B = UltraTransfer.create({ prefix: 'B', send: async (x) => { replies.push(JSON.parse(x)); }, onChange() {}, api: { offer: async () => ({ ok: true, name: 'a' }), chunk() {}, end: async () => ({ ok: true }), abort() {} } });
    B.onMessage(JSON.stringify({ t: 'offer', id: 'X1', name: 'a', size: 5 }));
    await sleep(20);
    B.onMessage(JSON.stringify({ t: 'offer', id: 'X2', name: 'b', size: 5 }));
    await sleep(20);
    assert.ok(replies.some((r) => r.t === 'reject' && r.id === 'X2'));
  });
  await check('garbage offers and messages are ignored', async () => {
    const B = UltraTransfer.create({ prefix: 'B', send: async () => {}, onChange() {}, api: { offer: async () => { throw new Error('should not be asked'); }, chunk() {}, end: async () => ({}), abort() {} } });
    B.onMessage(JSON.stringify({ t: 'offer', id: 5, name: 'a', size: 5 }));
    B.onMessage(JSON.stringify({ t: 'offer', id: 'x', name: 'a', size: -1 }));
    B.onMessage(JSON.stringify({ t: 'offer', id: 'x', name: 'a', size: 1.5 }));
    B.onMessage('not json'); B.onMessage(JSON.stringify([1, 2])); B.onMessage(undefined);
    await sleep(30);
  });

  console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', some failed' : ''));
  process.exit(process.exitCode || 0); // the engine's long answer timers would otherwise keep this running
})();
