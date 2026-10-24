'use strict';
// Starts the REAL Electron app on a virtual screen and connects a phone page to it.
// Not part of the shipped app. Run: xvfb-run -a node smoke-electron.js
const { _electron, chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(250); }
  throw new Error('timed out waiting for ' + what);
}
(async () => {
  const errors = [];
  const app = await _electron.launch({ executablePath: require('path').join(__dirname, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', '--disable-gpu', '.'], cwd: __dirname });
  const win = await app.firstWindow();
  win.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  win.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await win.waitForLoadState('domcontentloaded');
  console.log('window title:', await win.title());

  await until(() => win.evaluate(() => /Running on port/.test(document.getElementById('srvtxt').textContent)), 10000, 'server chip');
  console.log('server chip:', await win.evaluate(() => document.getElementById('srvtxt').textContent));

  const { port, token } = await win.evaluate(async () => {
    const info = await window.ultracast.info();
    const p = await window.ultracast.newPairing();
    return { port: info.port, token: p.token };
  });

  const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const phone = await browser.newPage();
  await phone.goto('http://127.0.0.1:' + port + '/?t=' + token);
  await until(() => win.evaluate(() => document.getElementById('c-peer').className === 'ok'), 6000, 'phone paired tick');
  console.log('phone paired tick: yes');

  await win.click('#share');
  await sleep(2500);
  const state = await win.evaluate(() => ({ err: document.getElementById('err').textContent, share: document.getElementById('c-share').className, audio: document.getElementById('c-audio').className, btn: document.getElementById('share').textContent }));
  console.log('after Share click:', JSON.stringify(state));

  if (state.share === 'ok') {
    await until(() => phone.evaluate(() => { const v = document.getElementById('v'); return !v.hidden && v.videoWidth > 0; }), 20000, 'real screen video on the phone page');
    const dim = await phone.evaluate(() => [document.getElementById('v').videoWidth, document.getElementById('v').videoHeight]);
    console.log('phone page is showing video:', dim.join('x'));
    await sleep(7000);
    console.log('link health:', await win.evaluate(() => ({ mbps: document.getElementById('mbps').textContent, tier: document.getElementById('tier').textContent, pic: document.getElementById('pic').textContent, linkTick: document.getElementById('c-link').className })));
    await phone.screenshot({ path: process.env.SHOT || 'phone.png' });
  }
  console.log('errors in the app window:', errors.length ? errors : 'none');
  await win.screenshot({ path: process.env.WSHOT || 'win.png' });
  await browser.close();
  await app.close();
})().catch((e) => { console.error('SMOKE FAILED:', e.message); process.exit(1); });
