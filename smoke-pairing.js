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
  const port = await win.evaluate(async () => (await window.ultracast.info()).port);
  const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const view = (id) => win.evaluate((i) => !document.getElementById(i).hidden, id);
  const phoneText = (p) => p.evaluate(() => document.body.innerText);
  const digits = () => win.evaluate(() => Array.from(document.querySelectorAll('#sas span')).map((s) => s.textContent).join(''));

  async function openAdd() {
    await win.click('[data-view=devices]'); await win.click('#add-device');
    await sleep(300);
    // The test machine may have no hotspot-style address to show, so ask the caretaker for a code directly.
    const t = await win.evaluate(async () => (await window.ultracast.newPairing()).token);
    return 'http://127.0.0.1:' + port + '/?t=' + t;
  }

  // ----- 1. add a new phone with the matching number -----
  const ctx1 = await browser.newContext({ viewport: { width: 390, height: 780 } });
  const phone1 = await ctx1.newPage();
  await phone1.goto(await openAdd());
  const code = await until(async () => { const d = await digits(); return /^\d{4}$/.test(d) && d; }, 15000, 'number on laptop');
  await until(async () => (await phoneText(phone1)).includes(code), 8000, 'same number on phone');
  say('laptop and phone show the same 4-digit number (' + code + ')', true);
  say('before "Yes", the laptop refuses control, files and input', await win.evaluate(async () => (await window.ultracast.controlRequest()) === false && (await window.ultracast.fileOffer('x.txt', 1)).ok === false));
  say('before "Yes", Share is disabled and nothing is trusted', (await win.evaluate(() => document.getElementById('share').disabled)) && (await win.evaluate(async () => (await window.ultracast.devices()).length)) === 0);
  await win.click('#sas-yes');
  await until(() => view('v-control'), 10000, 'control page');
  say('after "Yes": control page opens', true);
  const saved = await phone1.evaluate(() => localStorage.getItem('uc-device'));
  say('the phone stored its key', !!saved && /"id"/.test(saved));
  const list1 = await win.evaluate(() => window.ultracast.devices());
  say('Devices has exactly one trusted phone, and the list never contains secrets', list1.length === 1 && !JSON.stringify(list1).includes('secret'));
  await until(async () => !(await win.evaluate(() => document.getElementById('share').disabled)), 5000, 'share enabled');
  await win.click('#share');
  await until(() => phone1.evaluate(() => { const v = document.querySelector('video'); return v && v.videoWidth > 0; }), 25000, 'picture on the phone');
  say('after pairing, sharing the screen shows the picture on the phone', true);
  await until(() => win.evaluate(() => /\d/.test(document.getElementById('speed').textContent)), 10000, 'ring speed');
  say('the ring shows a speed', true);

  // ----- 2. disconnect, then come back with no code and no number -----
  const state = await ctx1.storageState();
  await win.click('#disconnect');
  await until(async () => !(await view('v-control')), 8000, 'left control page');
  say('Disconnect returns to Devices', true);
  await ctx1.close();
  const ctx2 = await browser.newContext({ viewport: { width: 390, height: 780 }, storageState: state });
  const phone2 = await ctx2.newPage();
  await phone2.goto('http://127.0.0.1:' + port + '/');
  await until(() => view('v-control'), 10000, 'trusted phone reconnects');
  say('a trusted phone reconnects from the steady address with no code and no number', true);
  say('and is not shown a matching number', !(await phoneText(phone2)).match(/same number/i));
  await win.click('#disconnect'); await sleep(500);

  // ----- 3. wrong secret is refused -----
  const bad = JSON.parse(JSON.stringify(state));
  bad.origins.forEach((o) => o.localStorage.forEach((it) => { if (it.name === 'uc-device') { const d = JSON.parse(it.value); d.secret = 'f'.repeat(64); it.value = JSON.stringify(d); } }));
  const ctx3 = await browser.newContext({ storageState: bad });
  const phone3 = await ctx3.newPage();
  await phone3.goto('http://127.0.0.1:' + port + '/');
  await until(async () => /did not accept/.test(await phoneText(phone3)), 8000, 'refusal on phone');
  await sleep(500);
  say('a phone with the wrong secret is refused and never reaches the control page', !(await view('v-control')));
  await ctx3.close();

  // ----- 4. "They do not match" adds nothing -----
  const ctx4 = await browser.newContext();
  const phone4 = await ctx4.newPage();
  await phone4.goto(await openAdd());
  await until(async () => /^\d{4}$/.test(await digits()), 15000, 'number');
  await win.click('#sas-no');
  await until(async () => /numbers did not match|Not connected/i.test(await phoneText(phone4)), 8000, 'phone told');
  say('"They do not match": the phone is told and nothing is added', (await win.evaluate(async () => (await window.ultracast.devices()).length)) === 1);
  await ctx4.close();

  // ----- 5. removing a device ends its trust -----
  await win.click('[data-view=devices]');
  await until(() => win.evaluate(() => document.querySelectorAll('#dev-list .devrow').length === 1), 5000, 'device row');
  await win.click('#dev-list .devrow .danger'); await win.click('#dev-list .devrow .danger');
  await until(() => win.evaluate(async () => (await window.ultracast.devices()).length === 0), 5000, 'removed');
  say('Remove deletes the phone from Devices', true);
  const ctx5 = await browser.newContext({ storageState: state });
  const phone5 = await ctx5.newPage();
  await phone5.goto('http://127.0.0.1:' + port + '/');
  await until(async () => /no longer trusts/.test(await phoneText(phone5)), 8000, 'refusal after removal');
  say('a removed phone can no longer get in', !(await view('v-control')));
  const stored = fs.existsSync(path.join(home, '.config')) ? fs.readdirSync(path.join(home, '.config'), { recursive: true }).filter((f) => /devices\.json$/.test(f)) : [];
  say('the guest book file exists in the app data folder', stored.length === 1);

  console.log(ok + ' checks passed');
  await browser.close(); await app.close();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
