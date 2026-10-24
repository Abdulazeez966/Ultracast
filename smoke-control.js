'use strict';
// Real Electron app on a virtual screen + a phone page: request control, banner, input reaching the injector, Stop.
// Run: ULTRACAST_DEBUG_INPUT=1 PLAYWRIGHT_PATH=... xvfb-run -a -s "-screen 0 1280x800x24" node smoke-control.js
const path = require('path');
const { _electron, chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(250); } throw new Error('timed out waiting for ' + what); }
(async () => {
  const logs = [];
  const app = await _electron.launch({ executablePath: path.join(__dirname, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', '--disable-gpu', '.'], cwd: __dirname, env: { ...process.env, ULTRACAST_DEBUG_INPUT: '1' } });
  app.process().stdout.on('data', (d) => logs.push(String(d)));
  const win = await app.firstWindow();
  await win.waitForLoadState('domcontentloaded');
  await until(() => win.evaluate(() => /Running on port/.test(document.getElementById('srvtxt').textContent)), 10000, 'server');
  const { port, token } = await win.evaluate(async () => { const i = await window.ultracast.info(); const p = await window.ultracast.newPairing(); return { port: i.port, token: p.token }; });
  console.log('settings default:', JSON.stringify(await win.evaluate(() => window.ultracast.getSettings())));
  await win.evaluate(() => window.ultracast.setSettings({ controlMode: 'auto' }));
  console.log('after switching to auto:', JSON.stringify(await win.evaluate(() => window.ultracast.getSettings())));
  console.log('bad settings ignored:', JSON.stringify(await win.evaluate(() => window.ultracast.setSettings({ controlMode: 'root' }))));

  const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, hasTouch: true, isMobile: true });
  const phone = await ctx.newPage(); const cdp = await ctx.newCDPSession(phone);
  await phone.goto('http://127.0.0.1:' + port + '/?t=' + token);
  await until(() => win.evaluate(() => document.getElementById('c-peer').className === 'ok'), 6000, 'paired');
  await win.click('#share');
  await until(() => phone.evaluate(() => { const v = document.getElementById('v'); return !v.hidden && v.videoWidth > 0; }), 20000, 'video');
  console.log('video on phone: yes');

  console.log('windows before control:', app.windows().length);
  await phone.click('#ctl');
  await until(() => phone.evaluate(() => document.getElementById('ctl').textContent === 'Release'), 6000, 'granted');
  console.log('control granted (auto mode): yes');
  await until(() => app.windows().length === 2, 5000, 'banner window');
  const banner = app.windows().find((w) => w !== win);
  await until(async () => { try { return await banner.evaluate(() => !!document.getElementById('stop')); } catch (e) { return false; } }, 6000, 'banner loaded');
  console.log('banner text:', (await banner.evaluate(() => document.body.innerText)).replace(/\n/g, ' | '));
  console.log('laptop tick Phone in control:', await win.evaluate(() => document.getElementById('c-ctrl').className));

  const r = await phone.evaluate(() => { const b = document.getElementById('v').getBoundingClientRect(); return { x: b.x + b.width / 2, y: b.y + b.height / 2 }; });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y, id: 0 }] });
  await sleep(50); await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(800);
  const text = logs.join('');
  console.log('injector got a pointer move and a click:', /\[input\]/.test(text) && text.includes("\"dwFlags\":32769") && text.includes("\"dwFlags\":2}"));

  await banner.click('#stop');
  await until(() => phone.evaluate(() => document.getElementById('ctl').textContent === 'Take control'), 5000, 'phone notified');
  console.log('after Stop: phone back to Take control, note =', await phone.evaluate(() => document.getElementById('note').textContent));
  await until(() => app.windows().length === 1, 4000, 'banner closed');
  console.log('banner closed: yes; laptop tick:', JSON.stringify(await win.evaluate(() => document.getElementById('c-ctrl').className)));

  logs.length = 0;
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: r.x, y: r.y, id: 0 }] });
  await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
  await sleep(600);
  console.log('input after Stop ignored:', !/\[input\]/.test(logs.join('')));

  // a forged message straight from the app window while control is off must also do nothing
  await win.evaluate(() => window.ultracast.input({ t: 'c', b: 'l' }));
  await sleep(300);
  console.log('forged input with control off ignored:', !/\[input\]/.test(logs.join('')));
  await browser.close(); await app.close();
})().catch((e) => { console.error('SMOKE FAILED:', e.message); process.exit(1); });
