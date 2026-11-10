'use strict';
// End-to-end check of phone-controls-laptop with two real browser pages (needs Playwright; not part of the app).
// Run: PLAYWRIGHT_PATH=/opt/npm-tools/node_modules/playwright node test-control.js
const assert = require('assert');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { start } = require('./server');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function check(name, fn) { try { await fn(); passed++; console.log('  ok   ' + name); } catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; } }
async function until(fn, ms, what) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(100); } throw new Error('timed out waiting for ' + what); }

(async () => {
  const s = await start({ port: 0, trust: { lookup: (id) => (id === 'dev1' ? 'secret1' : null), name: () => 'Test phone' } });
  const pairing = s.newPairing();
  const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'] });
  console.log('Testing phone control through the real server on port ' + s.port);

  const hostPage = await browser.newPage();
  await hostPage.goto('about:blank');
  await hostPage.addScriptTag({ path: path.join(__dirname, 'renderer', 'host-rtc.js') });
  await hostPage.evaluate(({ port, hostKey }) => {
    window.inputs = []; window.denyNext = false;
    window.fake = async () => {
      const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
      const x = c.getContext('2d'); let f = 0;
      setInterval(() => { x.fillStyle = '#0b0f1a'; x.fillRect(0, 0, 1280, 720); x.fillStyle = '#22d3ee'; x.fillRect((f * 9) % 1200, 300, 80, 80); f++; }, 33);
      return c.captureStream(30);
    };
    window.H = UltraHost.createHost({
      wsUrl: 'ws://127.0.0.1:' + port + '/ws', hostKey, getStream: window.fake, onStatus: () => {},
      onInput: (m) => {
        if (m.t === 'req') window.H.send({ t: window.denyNext ? 'deny' : 'grant' });
        else window.inputs.push(m);
      },
    });
  }, { port: s.port, hostKey: s.hostKey });

  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
  const phone = await ctx.newPage();
  const cdp = await ctx.newCDPSession(phone);
  await phone.addInitScript(() => localStorage.setItem('uc-device', JSON.stringify({ id: 'dev1', secret: 'secret1' })));
  await phone.goto('http://127.0.0.1:' + s.port + '/');
  await until(() => hostPage.evaluate(() => true), 1000, 'host');
  await sleep(800);
  await hostPage.evaluate(() => window.H.startShare());
  await until(() => phone.evaluate(() => { const v = document.getElementById('v'); return !v.hidden && v.videoWidth > 0; }), 15000, 'video');

  const got = () => hostPage.evaluate(() => window.inputs.slice());
  const clear = () => hostPage.evaluate(() => { window.inputs.length = 0; });
  const box = async () => phone.evaluate(() => { const r = document.getElementById('v').getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; });
  const touch = (type, pts) => cdp.send('Input.dispatchTouchEvent', { type, touchPoints: pts.map((p, i) => ({ x: p[0], y: p[1], id: p[2] != null ? p[2] : i })) });
  const label = () => phone.evaluate(() => document.getElementById('ctl').textContent);

  await check('taps do nothing until control is granted', async () => {
    const b = await box();
    await touch('touchStart', [[b.x + b.w / 2, b.y + b.h / 2]]); await touch('touchEnd', []);
    await sleep(300);
    assert.strictEqual((await got()).length, 0);
  });

  await check('denied request leaves control off and says so', async () => {
    await hostPage.evaluate(() => { window.denyNext = true; });
    await phone.click('#ctl');
    await until(async () => (await label()) === 'Take control' && /said no/.test(await phone.evaluate(() => document.getElementById('note').textContent)), 4000, 'deny');
    await hostPage.evaluate(() => { window.denyNext = false; });
  });

  await check('allowed request turns control on', async () => {
    await phone.click('#ctl');
    await until(async () => (await label()) === 'Release', 4000, 'grant');
    assert.strictEqual(await phone.evaluate(() => document.getElementById('kbtn').hidden), false);
  });

  await check('a tap moves the pointer to the right spot and clicks', async () => {
    await clear();
    const b = await box();
    await touch('touchStart', [[b.x + b.w / 2, b.y + b.h / 2]]); await sleep(40); await touch('touchEnd', []);
    const m = await until(async () => { const l = await got(); return l.length >= 2 && l; }, 3000, 'tap messages');
    assert.strictEqual(m[0].t, 'm'); assert.ok(Math.abs(m[0].x - 0.5) < 0.03 && Math.abs(m[0].y - 0.5) < 0.03, JSON.stringify(m[0]));
    assert.deepStrictEqual(m[m.length - 1], { t: 'c', b: 'l' });
  });

  await check('a tap in the black bar above the picture lands on the screen edge, not outside it', async () => {
    await clear();
    const b = await box();
    await touch('touchStart', [[b.x + b.w / 2, b.y + 2]]); await sleep(40); await touch('touchEnd', []);
    const m = await until(async () => { const l = await got(); return l.length >= 1 && l; }, 3000, 'edge');
    assert.ok(m[0].y >= 0 && m[0].y <= 1 && m[0].y < 0.01, JSON.stringify(m[0]));
  });

  await check('press and hold is a right-click', async () => {
    await clear();
    const b = await box();
    await touch('touchStart', [[b.x + 100, b.y + b.h / 2]]); await sleep(700); await touch('touchEnd', []);
    const l = await until(async () => { const v = await got(); return v.some((x) => x.t === 'c' && x.b === 'r') && v; }, 3000, 'right click');
    assert.ok(!l.some((x) => x.t === 'c' && x.b === 'l'), 'no extra left click');
  });

  await check('one-finger drag presses, moves, then releases', async () => {
    await clear();
    const b = await box(); const y = b.y + b.h / 2;
    await touch('touchStart', [[b.x + 100, y]]);
    for (let i = 1; i <= 6; i++) { await sleep(30); await touch('touchMove', [[b.x + 100 + i * 20, y]]); }
    await touch('touchEnd', []);
    const l = await until(async () => { const v = await got(); return v.some((x) => x.t === 'u') && v; }, 3000, 'drag end');
    const types = l.map((x) => x.t);
    assert.ok(types.indexOf('d') !== -1 && types.indexOf('d') < types.lastIndexOf('m') && types.lastIndexOf('m') < types.indexOf('u'), types.join(','));
    assert.ok(!l.some((x) => x.t === 'c'), 'a drag is not a click');
  });

  await check('two fingers moving up scroll down (negative wheel)', async () => {
    await clear();
    const b = await box(); const cx = b.x + b.w / 2, y = b.y + b.h / 2;
    await touch('touchStart', [[cx - 40, y, 0], [cx + 40, y, 1]]);
    for (let i = 1; i <= 6; i++) { await sleep(30); await touch('touchMove', [[cx - 40, y - i * 15, 0], [cx + 40, y - i * 15, 1]]); }
    await touch('touchEnd', []);
    const l = await until(async () => { const v = await got(); return v.some((x) => x.t === 'w') && v; }, 3000, 'scroll');
    const sum = l.filter((x) => x.t === 'w').reduce((a, x) => a + x.dy, 0);
    assert.ok(sum < -60, 'sum ' + sum);
    assert.ok(!l.some((x) => x.t === 'z'));
  });

  await check('pinching out zooms in, pinching in zooms out', async () => {
    await clear();
    const b = await box(); const cx = b.x + b.w / 2, y = b.y + b.h / 2;
    await touch('touchStart', [[cx - 30, y, 0], [cx + 30, y, 1]]);
    for (let i = 1; i <= 8; i++) { await sleep(30); await touch('touchMove', [[cx - 30 - i * 20, y, 0], [cx + 30 + i * 20, y, 1]]); }
    await touch('touchEnd', []);
    let l = await until(async () => { const v = await got(); return v.some((x) => x.t === 'z') && v; }, 3000, 'zoom in');
    assert.ok(l.filter((x) => x.t === 'z').every((x) => x.dz > 0));
    await clear();
    await touch('touchStart', [[cx - 150, y, 0], [cx + 150, y, 1]]);
    for (let i = 1; i <= 8; i++) { await sleep(30); await touch('touchMove', [[cx - 150 + i * 15, y, 0], [cx + 150 - i * 15, y, 1]]); }
    await touch('touchEnd', []);
    l = await until(async () => { const v = await got(); return v.some((x) => x.t === 'z') && v; }, 3000, 'zoom out');
    assert.ok(l.filter((x) => x.t === 'z').every((x) => x.dz < 0));
  });

  await check('trackpad mode moves the pointer relatively and taps click where it is', async () => {
    await phone.click('#mode');
    assert.strictEqual(await phone.evaluate(() => document.getElementById('mode').textContent), 'Trackpad');
    await clear();
    const b = await box(); const y = b.y + b.h / 2;
    await touch('touchStart', [[b.x + 50, y]]);
    for (let i = 1; i <= 6; i++) { await sleep(30); await touch('touchMove', [[b.x + 50 + i * 20, y]]); }
    await touch('touchEnd', []);
    const l = await until(async () => { const v = await got(); return v.some((x) => x.t === 'm') && v; }, 3000, 'pad moves');
    const lastM = l.filter((x) => x.t === 'm').pop();
    assert.ok(lastM.x > 0.5, 'moved right of centre ' + lastM.x);
    assert.ok(!l.some((x) => x.t === 'd'), 'no button press in trackpad swipe');
    await clear();
    await touch('touchStart', [[b.x + 10, y + 5]]); await sleep(40); await touch('touchEnd', []);
    const t = await until(async () => { const v = await got(); return v.length && v; }, 3000, 'pad tap');
    assert.deepStrictEqual(t, [{ t: 'c', b: 'l' }]);
    await phone.click('#mode'); // back to touch
  });

  // Rebuilds the text the laptop would show from the messages it received.
  const replay = (l) => { let s = ''; l.forEach((m) => { if (m.t === 'k') s += m.s; else if (m.t === 'key' && m.k === 'Backspace') s = s.slice(0, -1); }); return s; };

  await check('typing on the phone keyboard sends the letters', async () => {
    await clear();
    await phone.click('#kbtn');
    await phone.keyboard.type('hi');
    await until(async () => replay(await got()) === 'hi', 3000, 'hi');
  });

  await check('Backspace and Enter work, even on an empty box', async () => {
    await clear();
    await phone.keyboard.press('Backspace');
    await phone.keyboard.press('Enter');
    await until(async () => (await got()).filter((x) => x.t === 'key').length >= 2, 3000, 'keys');
    const l = await got();
    assert.deepStrictEqual(l.filter((x) => x.t === 'key').map((x) => x.k), ['Backspace', 'Enter']);
  });

  await check('predictive-keyboard composing is sent live and corrected, ending as the final word', async () => {
    await clear();
    await cdp.send('Input.imeSetComposition', { text: 'he', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.imeSetComposition', { text: 'hel', selectionStart: 3, selectionEnd: 3 });
    await cdp.send('Input.imeSetComposition', { text: 'help', selectionStart: 4, selectionEnd: 4 });
    await cdp.send('Input.imeSetComposition', { text: 'held', selectionStart: 4, selectionEnd: 4 }); // keyboard changes its guess
    await cdp.send('Input.insertText', { text: 'held' });
    await sleep(200);
    assert.strictEqual(replay(await got()), 'held');
  });

  await check('the laptop stopping control shows on the phone and hides the extra buttons', async () => {
    await hostPage.evaluate(() => window.H.send({ t: 'revoked' }));
    await until(async () => (await label()) === 'Take control', 3000, 'revoked');
    assert.ok(/stopped on the laptop/.test(await phone.evaluate(() => document.getElementById('note').textContent)));
    assert.strictEqual(await phone.evaluate(() => document.getElementById('kbtn').hidden), true);
  });

  await check('releasing from the phone tells the laptop', async () => {
    await phone.click('#ctl'); await until(async () => (await label()) === 'Release', 4000, 'grant again');
    await clear();
    await phone.click('#ctl');
    const l = await until(async () => { const v = await got(); return v.some((x) => x.t === 'rel') && v; }, 3000, 'rel');
    assert.ok(l.length >= 1);
  });

  console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', some failed' : ''));
  await browser.close(); await s.close();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
