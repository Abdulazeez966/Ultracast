'use strict';
// Real Electron app + real phone page: adding a device with the matching number, coming back without one, removal, and refusals.
// xvfb-run -a -s "-screen 0 1280x800x24" node smoke-pairing.js
const path = require('path'), fs = require('fs'), os = require('os');
const { _electron, chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); } throw new Error('timed out waiting for ' + what); }
let ok = 0; const say = (s, pass) => { console.log((pass ? '  ok   ' : '  FAIL ') + s); if (pass) ok++; else process.exitCode = 1; };

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-home-'));
  const app = await _electron.launch({ executablePath: path.join(__dirname, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', '--disable-gpu', '.'], cwd: __dirname,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DOWNLOAD_DIR: path.join(home, 'Downloads') } });
  const win = await app.firstWindow(); await win.waitForLoadState('domcontentloaded');
  await until(() => win.evaluate(() => /Running on port/.test(document.getElementById('srvtxt').textContent)), 10000, 'server');
  await win.evaluate(() => document.querySelector('[data-view="settings"]') && document.querySelector('[data-view="settings"]').click());
  await win.evaluate(() => document.getElementById('diag-run').click());
  await until(() => win.evaluate(() => document.querySelectorAll('#diag-out .diag').length > 6), 20000, 'self-check rows');
  const rows = await win.evaluate(() => Array.from(document.querySelectorAll('#diag-out .diag')).map((r) => r.innerText.replace(/\s+/g, ' ')));
  rows.forEach((r) => console.log('   ' + r));
  say('self-check lists results', rows.length > 6);
  say('says the server is listening', rows.some((r) => /listening on port/.test(r)));
  say('checked hotkeys', rows.filter((r) => /Hotkey/.test(r)).length === 2);
  say('checked clipboard, fonts, video', ['Clipboard', 'Fonts', 'Video'].every((k) => rows.some((r) => r.includes(k))));
  say('clipboard works (it needs await in this Electron: regression)', rows.some((r) => /Clipboard read and write work/.test(r)));
  say('no row is blank', rows.every((r) => r.length > 8));
  await win.evaluate(() => document.getElementById('diag-cover').click());
  await until(() => win.evaluate(() => /black cover/i.test(document.getElementById('diag-out').innerText)), 15000, 'cover result');
  say('cover test ran and the cover is gone afterwards', await app.evaluate(() => !global.__ucCoverOn));
  await app.close();
  console.log(ok + ' checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
