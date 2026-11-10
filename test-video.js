'use strict';
// End-to-end check of the video link using two real browser pages:
//   "laptop" page: runs host-rtc.js with a fake moving picture and a fake tone instead of a real screen
//   "phone" page : the real public/viewer.html served by the real server
// Needs Playwright, which is NOT part of the app. Run only if you have it: node test-video.js
const assert = require('assert');
const path = require('path');
const { chromium } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
const { start } = require('./server');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
async function check(name, fn) {
  try { await fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  while (Date.now() < end) { const v = await fn(); if (v) return v; await sleep(200); }
  throw new Error('timed out waiting for ' + what);
}

(async () => {
  const s = await start({ port: 0, trust: { lookup: (id) => (id === 'dev1' ? 'secret1' : null), name: () => 'Test phone' } });
  const pairing = s.newPairing();
  const browser = await chromium.launch({
    args: ['--disable-features=WebRtcHideLocalIpsWithMdns', '--autoplay-policy=no-user-gesture-required'],
  });
  console.log('Testing the video link through the real server on port ' + s.port);

  const hostPage = await browser.newPage();
  await hostPage.goto('about:blank');
  await hostPage.addScriptTag({ path: path.join(__dirname, 'renderer', 'host-rtc.js') });
  await hostPage.evaluate(({ port, hostKey }) => {
    window.logs = [];
    window.fake = async () => {
      const c = document.createElement('canvas'); c.width = 1280; c.height = 720;
      const x = c.getContext('2d'); let f = 0;
      setInterval(() => { x.fillStyle = '#0b0f1a'; x.fillRect(0, 0, 1280, 720); x.fillStyle = '#22d3ee'; x.fillRect((f * 9) % 1200, 300, 80, 80); f++; }, 33);
      const stream = c.captureStream(30);
      const ac = new AudioContext(); const o = ac.createOscillator(); const d = ac.createMediaStreamDestination();
      o.connect(d); o.start(); stream.addTrack(d.stream.getAudioTracks()[0]);
      return stream;
    };
    window.H = UltraHost.createHost({ wsUrl: 'ws://127.0.0.1:' + port + '/ws', hostKey, getStream: window.fake, onStatus: (st) => window.logs.push(st) });
  }, { port: s.port, hostKey: s.hostKey });

  await check('laptop page connects to the server as host', async () => {
    await until(() => hostPage.evaluate(() => window.logs.some((l) => l.kind === 'server' && l.up)), 4000, 'host ready');
  });

  const phone = await browser.newPage();
  await phone.addInitScript(() => localStorage.setItem('uc-device', JSON.stringify({ id: 'dev1', secret: 'secret1' })));
  await phone.goto('http://127.0.0.1:' + s.port + '/');

  await check('phone page pairs and the laptop sees it', async () => {
    await until(() => phone.evaluate(() => document.getElementById('state').textContent.includes('Waiting')), 4000, 'phone paired');
    await until(() => hostPage.evaluate(() => window.logs.some((l) => l.kind === 'peer' && l.present)), 4000, 'host sees peer');
  });

  await hostPage.evaluate(() => window.H.startShare());

  await check('picture arrives on the phone page', async () => {
    await until(() => phone.evaluate(() => { const v = document.getElementById('v'); return !v.hidden && v.videoWidth > 0; }), 15000, 'video frames');
    const dim = await phone.evaluate(() => { const v = document.getElementById('v'); return [v.videoWidth, v.videoHeight]; });
    assert.ok(dim[0] >= 320, 'width ' + dim[0]);
  });

  await check('sound track arrives and the phone starts muted with a Sound button', async () => {
    const r = await phone.evaluate(() => { const v = document.getElementById('v'); return { audio: v.srcObject.getAudioTracks().length, muted: v.muted, label: document.getElementById('snd').textContent }; });
    assert.strictEqual(r.audio, 1); assert.strictEqual(r.muted, true); assert.strictEqual(r.label, 'Sound off');
  });

  await check('tapping Sound turns it on, tapping again turns it off', async () => {
    await phone.click('#snd');
    assert.strictEqual(await phone.evaluate(() => document.getElementById('v').muted), false);
    assert.strictEqual(await phone.evaluate(() => document.getElementById('snd').textContent), 'Sound on');
    await phone.click('#snd');
    assert.strictEqual(await phone.evaluate(() => document.getElementById('v').muted), true);
  });

  await check('phone shows live speed numbers', async () => {
    await until(() => phone.evaluate(() => /Mbps/.test(document.getElementById('stats').textContent) && /x\d+/.test(document.getElementById('stats').textContent)), 8000, 'stats text');
  });

  await check('laptop reports link health and a quality level', async () => {
    const st = await until(() => hostPage.evaluate(() => window.logs.filter((l) => l.kind === 'stats').pop()), 10000, 'host stats');
    assert.ok(['Excellent', 'Good', 'Fair', 'Weak', 'Poor'].includes(st.tier), 'tier ' + st.tier);
    assert.ok(st.mbps >= 0);
  });

  await check('video link is reported connected', async () => {
    assert.ok(await hostPage.evaluate(() => window.logs.some((l) => l.kind === 'link' && l.state === 'connected')));
  });

  await check('stopping the share tells the phone', async () => {
    await hostPage.evaluate(() => window.H.stopShare());
    await until(() => phone.evaluate(() => document.getElementById('msg').textContent.includes('stopped sharing')), 4000, 'phone notice');
  });

  await check('sharing again works on the same pairing', async () => {
    await hostPage.evaluate(() => window.H.startShare());
    await until(() => phone.evaluate(() => { const v = document.getElementById('v'); return !v.hidden && v.videoWidth > 0; }), 15000, 'second video');
  });

  console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', some failed' : ''));
  await browser.close();
  await s.close();
  process.exit(process.exitCode || 0);
})().catch((e) => { console.error(e); process.exit(1); });
