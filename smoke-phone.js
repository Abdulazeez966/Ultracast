'use strict';
// Real Electron app + a FAKE Android phone (a plain browser page) that speaks PHONE-SCREEN-PROTOCOL.md.
// Proves: share request, phone picture on the laptop, viewing-only vs controlling, every control message normalized,
// denied/stopped, an untrusted phone is ignored, and closing the phone closes call B.
// xvfb-run -a -s "-screen 0 1280x800x24" node smoke-phone.js
const path = require('path'), fs = require('fs'), os = require('os');
const { _electron, chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { proofFor, sdpMacFor } = require('./server');
const P = require('./renderer/phonectl');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(fn, ms, what) { const end = Date.now() + ms; while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(150); } throw new Error('timed out waiting for ' + what); }
let ok = 0; const say = (s, pass) => { console.log((pass ? '  ok   ' : '  FAIL ') + s); if (pass) ok++; else process.exitCode = 1; };
const near = (a, b) => Math.abs(a - b) < 0.02;

// The fake phone. mode "token": untrusted (hello with a one-time code). mode "trusted": hello with id + proof.
function installFake(page, cfg) {
  return page.evaluate((cfg) => {
    const F = window.F = { got: [], sig: [], ready: false, answered: false, hello: null, ws: null, pc: null, lane: null };
    const ws = F.ws = new WebSocket('ws://127.0.0.1:' + cfg.port + '/ws');
    const send = (o) => ws.readyState === 1 && ws.send(JSON.stringify(o));
    F.send = send;
    ws.onopen = () => send(cfg.mode === 'token' ? { type: 'hello', role: 'viewer', token: cfg.token, name: 'Fake phone' } : { type: 'hello', role: 'viewer', deviceId: cfg.id });
    ws.onmessage = async (e) => {
      const m = JSON.parse(e.data);
      if (m.type === 'challenge') send({ type: 'proof', mac: await window.proofFor(cfg.secret, m.nonce), cnonce: 'ab'.repeat(8) });
      else if (m.type === 'ready') F.ready = true;
      else if (m.type === 'signal') {
        const d = m.data || {}; F.sig.push(d);
        if (d.call === 'b' && d.sdp) { F.answered = true; F.answerMacOk = d.mac === await window.sdpMacFor(cfg.secret, 'host', d.sdp.type, d.sdp.sdp); await F.pc.setRemoteDescription(d.sdp); }
        else if (d.call === 'b' && d.candidate) { try { await F.pc.addIceCandidate(d.candidate); } catch (x) {} }
      }
    };
    // Offer call B with a moving picture (portrait 270x600) and the pctl lane.
    F.startB = async (ctl, unsigned) => {
      F.answered = false; F.answerMacOk = null;
      const cv = document.createElement('canvas'); cv.width = 270; cv.height = 600; document.body.appendChild(cv);
      const g = cv.getContext('2d'); let n = 0; setInterval(() => { g.fillStyle = 'hsl(' + (n++ * 7 % 360) + ',70%,50%)'; g.fillRect(0, 0, 270, 600); g.fillStyle = '#fff'; g.fillRect(100, 250, 70, 100); }, 50);
      const stream = cv.captureStream(15);
      const pc = F.pc = new RTCPeerConnection({ iceServers: [] });
      let offerSent = false; const held = [];
      pc.onicecandidate = (e) => { if (!e.candidate) return; const m = { type: 'signal', data: { call: 'b', candidate: e.candidate } }; if (offerSent) send(m); else held.push(m); };
      stream.getTracks().forEach((t) => pc.addTrack(t, stream));
      const lane = F.lane = pc.createDataChannel('pctl', { ordered: true });
      const au = F.audio = pc.createDataChannel('paudio', { ordered: false, maxRetransmits: 0 });
      lane.onopen = () => lane.send(JSON.stringify({ t: 'hello', w: 1080, h: 2400, ctl, snd: true, rot: true }));
      lane.onmessage = (e) => F.got.push(JSON.parse(e.data));
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      const ld = pc.localDescription, data = { call: 'b', sdp: { type: ld.type, sdp: ld.sdp } };
      if (cfg.mode === 'trusted' && !unsigned) data.mac = await window.sdpMacFor(cfg.secret, 'phone', ld.type, ld.sdp);
      send({ type: 'signal', data }); offerSent = true; held.forEach(send);
    };
    F.beep = (n) => { let seq = 0; const mk = () => { const b = new ArrayBuffer(3 + 960 * 4), v = new DataView(b); v.setUint8(0, 1); v.setUint16(1, seq++, false); for (let i = 0; i < 960; i++) { const x = Math.round(Math.sin((seq * 960 + i) * 2 * Math.PI * 440 / 48000) * 12000); v.setInt16(3 + i * 4, x, true); v.setInt16(5 + i * 4, x, true); } return b; }; const t = setInterval(() => { if (F.audio.readyState === 'open') F.audio.send(mk()); if (seq >= n) clearInterval(t); }, 20); };
    F.hello = (ctl) => F.lane.send(JSON.stringify({ t: 'hello', w: 1080, h: 2400, ctl }));
    F.closeB = () => { try { F.lane.close(); F.pc.close(); } catch (x) {} F.pc = null; };
  }, cfg);
}

(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-home-'));
  const app = await _electron.launch({ executablePath: path.join(__dirname, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', '--disable-gpu', '.'], cwd: __dirname,
    env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config'), XDG_DOWNLOAD_DIR: path.join(home, 'Downloads') } });
  const win = await app.firstWindow(); await win.waitForLoadState('domcontentloaded');
  await win.setViewportSize({ width: 1280, height: 800 }).catch(() => {});
  await until(() => win.evaluate(() => /Running on port/.test(document.getElementById('srvtxt').textContent)), 10000, 'server');
  const port = await win.evaluate(async () => (await window.ultracast.info()).port);
  const browser = await chromium.launch({ args: ['--disable-features=WebRtcHideLocalIpsWithMdns'] });
  const view = (id) => win.evaluate((i) => !document.getElementById(i).hidden, id);
  const txt = (id) => win.evaluate((i) => document.getElementById(i).textContent, id);
  const digits = () => win.evaluate(() => Array.from(document.querySelectorAll('#sas span')).map((s) => s.textContent).join(''));
  const newToken = () => win.evaluate(async () => (await window.ultracast.newPairing()).token);

  // ----- 1. an untrusted phone (code only, number not confirmed) gets nothing from call B -----
  const ctlA = await browser.newContext(); const pageA = await ctlA.newPage(); await pageA.goto('about:blank');
  await pageA.exposeFunction('proofFor', proofFor);
  await win.click('[data-view=devices]'); await win.click('#add-device'); await sleep(300);
  await installFake(pageA, { port, mode: 'token', token: await newToken() });
  await until(async () => /Phone found: Fake phone/.test(await txt('st-phone-text')), 15000, 'untrusted phone joined');
  await pageA.evaluate(() => window.F.startB(true));
  await sleep(2500);
  say('an untrusted phone gets no answer to a call-B offer', await pageA.evaluate(() => !window.F.answered));
  say('and no phone picture appears on the laptop', await win.evaluate(() => !document.getElementById('ph-video').srcObject));
  await win.click('#m-close'); await sleep(600); await ctlA.close();

  // ----- 2. get a trusted phone (real phone page does the pairing) -----
  const ctlP = await browser.newContext(); const pageP = await ctlP.newPage();
  await win.click('[data-view=devices]'); await win.click('#add-device'); await sleep(300);
  await pageP.goto('http://127.0.0.1:' + port + '/?t=' + await newToken());
  await until(async () => /^\d{4}$/.test(await digits()), 15000, 'number');
  await win.click('#sas-yes');
  await until(() => view('v-control'), 10000, 'control page');
  const dev = JSON.parse(await pageP.evaluate(() => localStorage.getItem('uc-device')));
  await win.click('#disconnect'); await sleep(500); await ctlP.close();

  // ----- 3. the fake trusted phone shares its screen -----
  const ctlT = await browser.newContext(); const page = await ctlT.newPage(); await page.goto('about:blank');
  await page.exposeFunction('proofFor', proofFor);
  await page.exposeFunction('sdpMacFor', sdpMacFor);
  await installFake(page, { port, mode: 'trusted', id: dev.id, secret: dev.secret });
  await until(() => view('v-control'), 10000, 'trusted fake phone connected');
  await win.click('#dir-out');
  say('the direction button works and shows the phone panel', (await view('panel-out')) && !(await view('panel-in')));
  say('Start is offered, controls are off before anything is shared', !(await win.evaluate(() => document.getElementById('ph-start').disabled)) && (await win.evaluate(() => document.querySelector('#sv-menu [data-act=home]').disabled)));
  await win.click('#ph-start');
  await until(() => page.evaluate(() => window.F.sig.some((d) => d.ctl === 'share-request')), 5000, 'share-request');
  say('"Ask phone to share" sends ctl share-request and shows the waiting text', /Waiting for the phone owner/.test(await txt('ph-status')));

  // a trusted phone whose call description is NOT signed (as if someone swapped it on the way) is ignored
  await page.evaluate(() => window.F.startB(false, true));
  await sleep(2500);
  say('an unsigned call-B offer from a trusted phone gets no answer', await page.evaluate(() => !window.F.answered));
  say('and the laptop says why', /not signed/.test(await win.evaluate(() => document.getElementById('err').textContent)));
  await page.evaluate(() => window.F.closeB());
  await page.evaluate(() => window.F.startB(false));
  await until(() => win.evaluate(() => { const v = document.getElementById('ph-video'); return v.videoWidth > 0; }), 20000, 'phone picture');
  say('the phone picture shows on the laptop (portrait shape kept)', await win.evaluate(() => { const v = document.getElementById('ph-video'); return v.videoWidth > 0 && Math.abs(v.videoWidth / v.videoHeight - 0.45) < 0.02; }));
  await page.evaluate(() => window.F.beep(60));
  await until(async () => ((await win.evaluate(() => window.__uc.sound)) || { pushed: 0 }).pushed >= 40, 8000, 'phone sound chunks');
  say('the phone\'s sound arrives and is queued for playing', true);
  say('the menu offers Phone sound on/off', await win.evaluate(() => !document.getElementById('sv-snd').disabled));
  say('the phone screen opened on its own page, without the side bar', (await view('v-screen')) && await win.evaluate(() => getComputedStyle(document.querySelector('.side')).display === 'none'));
  const bg = await win.evaluate(() => { const b = document.getElementById('sv-burger').getBoundingClientRect(); const cs = getComputedStyle(document.getElementById('sv-burger')); return { right: window.innerWidth - b.right, top: b.top, w: b.width, bg: cs.backgroundColor, lines: document.querySelectorAll('#sv-burger i').length, line: getComputedStyle(document.querySelector('#sv-burger i')).backgroundColor }; });
  say('the menu button is a small black square with 3 cyan lines in the top right corner', bg.right < 30 && bg.top < 30 && bg.w < 50 && bg.bg === 'rgb(0, 0, 0)' && bg.lines === 3 && bg.line === 'rgb(34, 211, 238)');
  const fillsWindow = await win.evaluate(() => { const b = document.getElementById('ph-stage').getBoundingClientRect(); return b.width >= window.innerWidth - 2 && b.height >= window.innerHeight - 2; });
  say('the phone screen covers the whole window', fillsWindow);
  await win.click('#sv-burger');
  say('the menu opens with the phone buttons, turn options and power', !(await win.evaluate(() => document.getElementById('sv-menu').hidden)) && (await win.evaluate(() => ['back','home','recents','notifications','rot-land','rot-port','rot-auto','lock','power','clip','full','float','stop','close'].every((a) => document.querySelector('#sv-menu [data-act=' + a + ']')))));
  await win.keyboard.press('Escape');
  say('Escape closes the menu', await win.evaluate(() => document.getElementById('sv-menu').hidden));
  await win.click('#sv-burger'); await win.click('#sv-menu [data-act=float]'); await sleep(500);
  say('Float on top makes a small always-on-top window', await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return w.isAlwaysOnTop() && w.getBounds().width < 700; }));
  await win.click('#sv-burger'); await win.click('#sv-menu [data-act=float]'); await sleep(500);
  say('Dock back restores the normal window', await app.evaluate(({ BrowserWindow }) => { const w = BrowserWindow.getAllWindows()[0]; return !w.isAlwaysOnTop() && w.getBounds().width > 900; }));
  await until(async () => /Viewing only/.test(await txt('ph-status')), 5000, 'viewing only text');
  say('hello with ctl:false = viewing only, control buttons stay off', await win.evaluate(() => document.querySelector('#sv-menu [data-act=home]').disabled));
  await win.mouse.click(600, 400); await sleep(300);
  say('clicks send nothing while viewing only', (await page.evaluate(() => window.F.got.length)) === 0);

  await page.evaluate(() => window.F.hello(true));
  await until(async () => /Controlling/.test(await txt('ph-status')), 5000, 'controlling text');
  say('hello with ctl:true = controlling, buttons on', !(await win.evaluate(() => document.querySelector('#sv-menu [data-act=home]').disabled)));

  // geometry of the picture as drawn
  await win.locator('#ph-stage').scrollIntoViewIfNeeded();
  const geo = await win.evaluate(() => { const b = document.getElementById('ph-stage').getBoundingClientRect(); const v = document.getElementById('ph-video'); return { l: b.left, t: b.top, w: b.width, h: b.height, vw: v.videoWidth, vh: v.videoHeight }; });
  const rect = P.pictureRect(geo.w, geo.h, geo.vw, geo.vh);
  const at = (nx, ny) => [geo.l + rect.left + nx * rect.w, geo.t + rect.top + ny * rect.h];
  const last = () => page.evaluate(() => window.F.got[window.F.got.length - 1]);
  const count = () => page.evaluate(() => window.F.got.length);
  const waitNew = async (n) => { await until(async () => (await count()) > n, 4000, 'message'); return last(); };

  let n0 = await count(); let [x, y] = at(0.3, 0.7);
  await win.mouse.click(x, y); let m = await waitNew(n0);
  say('click -> tap, normalized to the picture (letterbox-aware)', m.t === 'tap' && near(m.x, 0.3) && near(m.y, 0.7));

  n0 = await count(); [x, y] = at(0.5, 0.5);
  await win.mouse.move(x, y); await win.mouse.down(); await sleep(700); await win.mouse.up(); m = await waitNew(n0);
  say('hold 500 ms -> long press (and only that)', m.t === 'long' && near(m.x, 0.5) && near(m.y, 0.5) && (await count()) === n0 + 1);

  n0 = await count(); const [sx, sy] = at(0.5, 0.8), [ex, ey] = at(0.5, 0.2);
  await win.mouse.move(sx, sy); await win.mouse.down(); await win.mouse.move(sx, (sy + ey) / 2, { steps: 4 }); await sleep(250); await win.mouse.move(ex, ey, { steps: 4 }); await win.mouse.up(); m = await waitNew(n0);
  say('drag -> swipe with start, end and a real duration', m.t === 'swipe' && near(m.x1, 0.5) && near(m.y1, 0.8) && near(m.y2, 0.2) && m.ms >= 250 && m.ms <= 3000);

  n0 = await count(); [x, y] = at(0.5, 0.5);
  await win.mouse.move(x, y); await win.mouse.wheel(0, 120); m = await waitNew(n0);
  say('mouse wheel down -> swipe up (scroll)', m.t === 'swipe' && m.y1 > m.y2 && m.ms === 250);

  for (const k of ['back', 'home', 'recents']) {
    n0 = await count(); await win.click('#sv-burger'); await win.click('#sv-menu [data-act=' + k + ']'); m = await waitNew(n0);
    say('menu ' + k + ' -> nav ' + k, m.t === 'nav' && m.k === k);
  }

  n0 = await count(); await win.click('#ph-stage', { position: { x: geo.w / 2, y: geo.h / 2 } }); await waitNew(n0); // focuses and taps
  n0 = await count(); await win.keyboard.type('hi'); m = await waitNew(n0);
  say('typing -> text', m.t === 'text' && m.s === 'hi');
  n0 = await count(); await win.keyboard.press('Backspace'); m = await waitNew(n0);
  say('Backspace -> key', m.t === 'key' && m.k === 'Backspace');
  n0 = await count(); await win.keyboard.press('Enter'); m = await waitNew(n0);
  say('Enter -> key', m.t === 'key' && m.k === 'Enter');

  // a hostile phone message does not disturb the laptop
  await page.evaluate(() => { window.F.lane.send('x'.repeat(2000)); window.F.lane.send('{"t":"evil","k":1}'); window.F.lane.send('[1,2]'); window.F.hello(true); });
  await sleep(500);
  say('oversized, unknown and malformed phone messages are ignored', /Controlling/.test(await txt('ph-status')));

  // ----- 4. stop, denied, and closing -----
  say('the laptop is kept awake while the trusted phone is connected', await app.evaluate(() => global.__ucBlockerOn === true));
  say('Control has its own menu item while the phone is connected', await win.evaluate(() => !document.getElementById('nav-control').disabled));
  say('the phone-screen menu has the dark-screen options', await win.evaluate(() => ['aw-on', 'aw-dark', 'aw-wake', 'aw-off'].every((a) => document.querySelector('#sv-menu [data-act=' + a + ']'))));
  say('the phone picture opened on its own page', await view('v-screen'));
  await win.click('#sv-burger'); await win.click('#sv-menu [data-act=stop]');
  await until(() => page.evaluate(() => window.F.sig.some((d) => d.ctl === 'share-stop')), 5000, 'share-stop');
  say('Stop sends ctl share-stop and clears the picture', await win.evaluate(() => !document.getElementById('ph-video').srcObject));
  await page.evaluate(() => { window.F.closeB(); window.F.send({ type: 'signal', data: { ctl: 'share-stopped' } }); });
  await sleep(400);
  await win.click('#ph-start');
  await until(() => page.evaluate(() => window.F.sig.filter((d) => d.ctl === 'share-request').length === 2), 5000, 'second request');
  await page.evaluate(() => window.F.send({ type: 'signal', data: { ctl: 'share-denied' } }));
  await until(async () => /said no/.test(await txt('ph-status')), 5000, 'denied text');
  say('phone says no -> the laptop shows it and offers to try again', !(await win.evaluate(() => document.getElementById('ph-start').disabled)));

  await win.click('#ph-start');
  await page.evaluate(() => window.F.startB(true));
  await until(() => win.evaluate(() => document.getElementById('ph-video').videoWidth > 0), 20000, 'picture again');
  say('sharing can be started again after a no', true);
  await ctlT.close();
  await until(async () => !(await view('v-control')), 10000, 'phone gone');
  say('Control menu item is switched off again once the phone is gone', await win.evaluate(() => document.getElementById('nav-control').disabled));
  say('the laptop may sleep again once the phone is gone', await app.evaluate(() => global.__ucBlockerOn === false));
  say('closing the phone closes call B and leaves the control page', await win.evaluate(() => !document.getElementById('ph-video').srcObject));

  console.log(ok + ' checks passed');
  await browser.close(); await app.close();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
