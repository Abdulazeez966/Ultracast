'use strict';
// Real browser E2E: the real phone page + a fake laptop page (host-rtc + transfer engine, with an in-page "disk").
// PLAYWRIGHT_PATH=... node test-files-e2e.js
const assert = require('assert');
const path = require('path');
const crypto = require('crypto');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { start } = require('./server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function check(n, f) { try { await f(); passed++; console.log('  ok   ' + n); } catch (e) { console.log('  FAIL ' + n + '\n       ' + e.message); process.exitCode = 1; } }
async function until(fn, ms, w) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); } throw new Error('timed out waiting for ' + w); }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

(async () => {
  const s = await start({ port: 0, trust: { lookup: (id) => (id === 'dev1' ? 'secret1' : null), name: () => 'Test phone' } }); const pairing = s.newPairing();
  const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'] });
  console.log('Testing file transfer through the real server on port ' + s.port);
  const hostPage = await browser.newPage();
  await hostPage.goto('about:blank');
  await hostPage.addScriptTag({ path: path.join(__dirname, 'renderer', 'host-rtc.js') });
  await hostPage.addScriptTag({ path: path.join(__dirname, 'renderer', 'transfer.js') });
  await hostPage.evaluate(({ port, hostKey }) => {
    window.saved = {}; window.cur = null; window.decline = false; window.lists = []; window.big = 0;
    window.fake = async () => { const c = document.createElement('canvas'); c.width = 640; c.height = 360; const x = c.getContext('2d'); let f = 0; setInterval(() => { x.fillStyle = '#123'; x.fillRect(0, 0, 640, 360); x.fillStyle = '#2dd'; x.fillRect(f++ % 500, 100, 60, 60); }, 50); return c.captureStream(15); };
    const hex = async (b) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', b))).map((v) => v.toString(16).padStart(2, '0')).join('');
    window.hex = hex;
    window.tx = UltraTransfer.create({
      prefix: 'L', send: (d) => window.H.fileSend(d), onChange: (l) => { window.lists = l; },
      confirmLarge: () => { window.big++; return false; },
      api: {
        offer: async (name, size) => { if (window.decline) return { ok: false, reason: 'Declined on the laptop' }; window.cur = { name, parts: [] }; return { ok: true, name }; },
        chunk: (b) => window.cur.parts.push(new Uint8Array(b.slice ? b.slice(0) : b)),
        end: async () => { const blob = new Blob(window.cur.parts); window.saved[window.cur.name] = { size: blob.size, b64: await new Promise((r) => { const fr = new FileReader(); fr.onload = () => r(fr.result.split(',')[1]); fr.readAsDataURL(blob); }) }; window.cur = null; return { ok: true, path: 'fake' }; },
        abort: () => { window.cur = null; },
      },
    });
    window.H = UltraHost.createHost({ wsUrl: 'ws://127.0.0.1:' + port + '/ws', hostKey, getStream: window.fake, onStatus: () => {}, onFile: (d) => window.tx.onMessage(d), onInput: () => {} });
  }, { port: s.port, hostKey: s.hostKey });

  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, acceptDownloads: true });
  const phone = await ctx.newPage();
  await phone.addInitScript(() => localStorage.setItem('uc-device', JSON.stringify({ id: 'dev1', secret: 'secret1' })));
  await phone.goto('http://127.0.0.1:' + s.port + '/');
  await sleep(800);
  await hostPage.evaluate(() => window.H.startShare());
  await until(() => phone.evaluate(() => { const v = document.getElementById('v'); return !v.hidden && v.videoWidth > 0; }), 15000, 'video');

  await check('the Send files button appears once the files lane is open', async () => {
    await until(() => phone.evaluate(() => !document.getElementById('sendf').hidden), 5000, 'button');
  });

  const mk = (name, n) => ({ name, mimeType: 'application/octet-stream', buffer: crypto.randomBytes(n) });

  await check('phone to laptop: a 2.5 MB file arrives identical', async () => {
    const f = mk('from-phone.bin', 2.5 * 1024 * 1024);
    await phone.setInputFiles('#pick', f);
    await until(() => hostPage.evaluate(() => window.saved['from-phone.bin']), 20000, 'arrival');
    const r = await hostPage.evaluate(() => window.saved['from-phone.bin']);
    assert.strictEqual(r.size, f.buffer.length); assert.strictEqual(sha(Buffer.from(r.b64, 'base64')), sha(f.buffer));
    await until(() => phone.evaluate(() => /Sent/.test(document.getElementById('xfer').textContent)), 5000, 'phone shows Sent');
  });

  await check('phone to laptop: declined on the laptop shows the reason on the phone', async () => {
    await hostPage.evaluate(() => { window.decline = true; });
    await phone.setInputFiles('#pick', mk('nope.bin', 1000));
    await until(() => phone.evaluate(() => /Declined on the laptop/.test(document.getElementById('xfer').textContent)), 5000, 'reason');
    assert.ok(!(await hostPage.evaluate(() => 'nope.bin' in window.saved)));
    await hostPage.evaluate(() => { window.decline = false; });
  });

  await check('laptop to phone: phone asks, Accept downloads an identical file', async () => {
    const data = crypto.randomBytes(1.5 * 1024 * 1024);
    await hostPage.evaluate((arr) => { window.tx.sendFiles([new File([new Uint8Array(arr)], 'from-laptop.bin')]); }, Array.from(data));
    await until(() => phone.evaluate(() => !document.getElementById('ask').hidden), 8000, 'ask dialog');
    assert.ok(/from-laptop\.bin/.test(await phone.textContent('#askname')));
    const [dl] = await Promise.all([phone.waitForEvent('download', { timeout: 20000 }), phone.click('#askyes')]);
    assert.strictEqual(dl.suggestedFilename(), 'from-laptop.bin');
    const p = await dl.path(); const got = require('fs').readFileSync(p);
    assert.strictEqual(sha(got), sha(data));
    await until(() => hostPage.evaluate(() => window.lists[0] && window.lists[0].state === 'done'), 5000, 'laptop shows done');
  });

  await check('laptop to phone: Decline on the phone is reported to the laptop', async () => {
    await hostPage.evaluate(() => { window.tx.sendFiles([new File(['hello'], 'declined.txt')]); });
    await until(() => phone.evaluate(() => !document.getElementById('ask').hidden), 8000, 'ask');
    await phone.click('#askno');
    await until(() => hostPage.evaluate(() => window.lists[0] && window.lists[0].state === 'rejected'), 5000, 'rejected');
    assert.strictEqual(await hostPage.evaluate(() => window.lists[0].note), 'Declined on the phone');
  });

  await check('laptop to phone: a file over the phone page limit is refused with a reason', async () => {
    await hostPage.evaluate(() => { const f = new File(['x'], 'giant.bin'); Object.defineProperty(f, 'size', { value: 600 * 1024 * 1024 }); window.tx.sendFiles([f]); });
    await until(() => hostPage.evaluate(() => window.lists[0] && window.lists[0].name === 'giant.bin' && window.lists[0].state === 'rejected'), 8000, 'rejected');
    assert.ok(/500 MB/.test(await hostPage.evaluate(() => window.lists[0].note)));
  });

  await check('phone: a file above 1 GB asks "Send it anyway?" and No sends nothing', async () => {
    let asked = 0;
    phone.once('dialog', async (d) => { asked++; await d.dismiss(); });
    const before = await hostPage.evaluate(() => Object.keys(window.saved).length);
    await phone.evaluate(() => {
      const f = new File(['x'], 'movie.mkv'); Object.defineProperty(f, 'size', { value: 2 * 1024 * 1024 * 1024 });
      const dt = new DataTransfer(); dt.items.add(f);
      const i = document.getElementById('pick'); i.files = dt.files; i.dispatchEvent(new Event('change'));
    });
    await sleep(600);
    assert.strictEqual(asked, 1);
    assert.strictEqual(await hostPage.evaluate(() => Object.keys(window.saved).length), before);
  });

  await check('phone: Cancel mid-transfer stops it and the laptop sees it cancelled', async () => {
    await phone.setInputFiles('#pick', mk('long.bin', 40 * 1024 * 1024));
    await until(() => phone.evaluate(() => /\d+%/.test(document.getElementById('xfer').textContent) && !/Waiting/.test(document.getElementById('xfer').textContent)), 10000, 'progress');
    await phone.click('#xfer button');
    await until(() => hostPage.evaluate(() => window.lists[0] && window.lists[0].state === 'cancelled'), 8000, 'laptop cancelled');
    assert.ok(!(await hostPage.evaluate(() => 'long.bin' in window.saved)));
  });

  await check('after stopping the share the phone hides Send files', async () => {
    await hostPage.evaluate(() => window.H.stopShare());
    await until(() => phone.evaluate(() => document.getElementById('sendf').hidden), 5000, 'hidden');
  });

  console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', some failed' : ''));
  await browser.close(); await s.close(); process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
