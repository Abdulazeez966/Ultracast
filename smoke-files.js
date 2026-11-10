'use strict';
// Real Electron app + real phone page; the Windows pop-up boxes are replaced by scripted answers so we can test every branch.
// xvfb-run -a -s "-screen 0 1280x800x24" node smoke-files.js
const path = require('path'), fs = require('fs'), os = require('os'), crypto = require('crypto');
const { _electron, chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); } throw new Error('timed out waiting for ' + what); }
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
let ok = 0; const say = (s, pass) => { console.log((pass ? '  ok   ' : '  FAIL ') + s); if (pass) ok++; else process.exitCode = 1; };

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-home-'));
  const app = await _electron.launch({ executablePath: path.join(__dirname, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', '--disable-gpu', '.'], cwd: __dirname,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DOWNLOAD_DIR: path.join(home, 'Downloads') } });
  const win = await app.firstWindow(); await win.waitForLoadState('domcontentloaded');
  await until(() => win.evaluate(() => /Running on port/.test(document.getElementById('srvtxt').textContent)), 10000, 'server');
  const dl = await app.evaluate(({ app }) => app.getPath('downloads')); const target = path.join(dl, 'UltraCast');
  console.log('downloads folder used:', dl);
  await app.evaluate(({ dialog }) => {
    globalThis.__box = []; globalThis.__ans = []; globalThis.__open = [];
    dialog.showMessageBox = async (...a) => { const o = a[a.length - 1]; globalThis.__box.push({ message: o.message, detail: o.detail, buttons: o.buttons }); return { response: globalThis.__ans.shift() ?? 0 }; };
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [globalThis.__open.shift()] });
  });
  const boxes = () => app.evaluate(() => globalThis.__box.slice());
  const answer = (...r) => app.evaluate((_m, r) => { globalThis.__ans.push(...r); }, r);

  const { port, token } = await win.evaluate(async () => { const i = await window.ultracast.info(); const p = await window.ultracast.newPairing(); return { port: i.port, token: p.token }; });
  console.log('defaults:', JSON.stringify(await win.evaluate(() => window.ultracast.getSettings())));
  const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, acceptDownloads: true });
  const phone = await ctx.newPage();
  await phone.goto('http://127.0.0.1:' + port + '/?t=' + token);
  await until(async () => /^\d{4}$/.test(await win.evaluate(() => Array.from(document.querySelectorAll('#sas span')).map((s) => s.textContent).join(''))), 15000, 'matching number');
  await win.click('#sas-yes');
  await until(() => win.evaluate(() => !document.getElementById('v-control').hidden && !document.getElementById('share').disabled), 12000, 'paired');
  await win.click('#share');
  await until(() => phone.evaluate(() => !document.getElementById('sendf').hidden), 20000, 'files lane');
  say('Send files appears on the phone and the laptop button is enabled', await win.evaluate(() => !document.getElementById('sendfiles').disabled));

  const send = (name, buf) => phone.setInputFiles('#pick', { name, mimeType: 'application/octet-stream', buffer: buf });
  const phoneText = () => phone.evaluate(() => document.getElementById('xfer').textContent);

  // 1. ask every time -> Accept
  const d1 = crypto.randomBytes(1.2 * 1024 * 1024);
  await answer(1);
  await send('first.bin', d1);
  await until(() => fs.existsSync(path.join(target, 'first.bin')), 15000, 'first.bin saved');
  say('Accept: file saved in Downloads/UltraCast, identical', sha(fs.readFileSync(path.join(target, 'first.bin'))) === sha(d1));
  const b1 = await boxes();
  say('the laptop asked first, naming the file', b1.length === 1 && /first\.bin/.test(b1[0].detail) && b1[0].buttons[1] === 'Accept');
  say('no half-delivered leftovers', !fs.readdirSync(target).some((f) => f.endsWith('.ucpart')));

  // 2. Decline
  await answer(0);
  await send('declined.bin', Buffer.from('nope'));
  await until(async () => /Declined on the laptop/.test(await phoneText()), 8000, 'decline message');
  say('Decline: nothing saved and the phone is told', !fs.existsSync(path.join(target, 'declined.bin')));

  // 3. same name -> Accept, then Keep both
  await answer(1, 1);
  await send('first.bin', Buffer.from('second copy'));
  await until(() => fs.existsSync(path.join(target, 'first (2).bin')), 15000, 'first (2).bin');
  say('same name + Keep both: saved as "first (2).bin", original untouched', sha(fs.readFileSync(path.join(target, 'first.bin'))) === sha(d1));
  const b3 = await boxes();
  say('the laptop offered Skip / Keep both / Replace', b3.some((b) => b.buttons.join() === 'Skip,Keep both,Replace'));

  // 4. same name -> Replace
  await answer(1, 2);
  await send('first.bin', Buffer.from('replaced!'));
  await until(() => fs.readFileSync(path.join(target, 'first.bin'), 'utf8') === 'replaced!', 15000, 'replaced');
  say('same name + Replace: overwritten', true);

  // 5. same name -> Skip
  await answer(1, 0);
  await send('first.bin', Buffer.from('should not land'));
  await until(async () => /Skipped/.test(await phoneText()), 8000, 'skip message');
  say('same name + Skip: untouched', fs.readFileSync(path.join(target, 'first.bin'), 'utf8') === 'replaced!');

  // 6. risky file warning + hostile name
  await answer(0);
  await send('..\\..\\setup.exe', Buffer.from('MZ'));
  await until(async () => (await boxes()).some((b) => /program or script/.test(b.detail)), 8000, 'risky warning');
  say('a program file gets an extra warning in the question', true);

  // 7. once per connection
  await win.evaluate(() => window.ultracast.setSettings({ receiveMode: 'session' }));
  const before = (await boxes()).length;
  await answer(1);
  await send('s1.txt', Buffer.from('1')); await until(() => fs.existsSync(path.join(target, 's1.txt')), 10000, 's1');
  await send('s2.txt', Buffer.from('2')); await until(() => fs.existsSync(path.join(target, 's2.txt')), 10000, 's2');
  say('once per connection: asked only the first time', (await boxes()).length - before === 1);

  // 8. automatic + ask-where-to-save
  await win.evaluate(() => window.ultracast.setSettings({ receiveMode: 'auto', saveMode: 'ask' }));
  const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-else-'));
  await app.evaluate((_m, p) => { globalThis.__open.push(p); }, elsewhere);
  const before2 = (await boxes()).length;
  await send('auto.txt', Buffer.from('auto'));
  await until(() => fs.existsSync(path.join(elsewhere, 'auto.txt')), 10000, 'auto.txt');
  say('automatic accept + ask-where: no question box, saved in the chosen folder', (await boxes()).length === before2);
  await win.evaluate(() => window.ultracast.setSettings({ receiveMode: 'every', saveMode: 'default' }));

  // 9. laptop -> phone via the real picker
  const d2 = crypto.randomBytes(800 * 1024);
  const fpath = path.join(home, 'laptop-file.bin'); fs.writeFileSync(fpath, d2);
  await win.setInputFiles('#picker', fpath);
  await until(() => phone.evaluate(() => !document.getElementById('ask').hidden), 10000, 'phone ask');
  const [dload] = await Promise.all([phone.waitForEvent('download', { timeout: 15000 }), phone.click('#askyes')]);
  say('laptop to phone: phone accepts and gets an identical file', sha(fs.readFileSync(await dload.path())) === sha(d2));
  await until(() => win.evaluate(() => /Sent/.test(document.getElementById('xlist').textContent)), 8000, 'laptop shows Sent');
  say('the laptop list shows the transfer as Sent', true);

  // 10. forged file messages from the window with nothing arriving
  const r = await win.evaluate(() => window.ultracast.fileEnd());
  say('a stray "end" with nothing arriving is refused', r.ok === false);

  console.log('\n' + ok + ' checks passed' + (process.exitCode ? ', some failed' : ''));
  await browser.close(); await app.close();
})().catch((e) => { console.error('SMOKE FAILED:', e.message); process.exit(1); });
