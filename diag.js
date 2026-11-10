'use strict';
/*
  UltraCast self-check ("laptop probe").
  Runs a fixed list of read-only checks on THIS laptop and says OK / FAILED / NOTE for each, with the real reason.
  It only runs fixed commands (never anything the phone sends) and changes nothing.
  The "does the black cover really stay out of screen capture" test is separate (it flashes the screen), see coverCaptureTest.
*/
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const run = (cmd, args, ms) => new Promise((res) => execFile(cmd, args, { windowsHide: true, timeout: ms || 8000 }, (err, stdout) => res({ err, out: String(stdout || '') })));
const item = (kind, text) => ({ kind, text });

function get(host, port, p) {
  return new Promise((resolve) => {
    const r = http.get({ host, port, path: p, timeout: 3000 }, (res) => { let b = ''; res.on('data', (d) => (b += d)); res.on('end', () => resolve({ status: res.statusCode, body: b })); });
    r.on('error', (e) => resolve({ error: e.message })); r.on('timeout', () => { r.destroy(); resolve({ error: 'timeout' }); });
  });
}

/** deps: { electron: {app, desktopCapturer, globalShortcut, clipboard, powerSaveBlocker, screen}, server: {port, addresses: [{network,url}]}, userData } */
async function runChecks(deps) {
  const E = deps.electron; const out = [];
  const add = (k, t) => out.push(item(k, t));

  add('OK', 'UltraCast ' + E.app.getVersion() + ' on Electron ' + process.versions.electron + ', ' + os.platform() + ' ' + os.release() + ' (' + os.arch() + ')');

  // ----- the front desk -----
  if (deps.server && deps.server.port) {
    add('OK', 'The laptop side is listening on port ' + deps.server.port);
    const addrs = deps.server.addresses || [];
    if (!addrs.length) add('FAILED', 'No hotspot-style address found. Join the phone\'s hotspot on this laptop (Wi-Fi), then run this again.');
    for (const a of addrs) {
      const host = a.url.replace(/^http:\/\//, '').replace(/[:/].*$/, '');
      const r = await get(host, deps.server.port, '/ping');
      if (r.status === 200) add('OK', 'Answers on ' + a.url + ' (network "' + a.network + '"). On the phone, opening this address in a browser should show a small text answer. If it does not, Windows Firewall is blocking it.');
      else add('FAILED', 'Did not answer on ' + a.url + ': ' + (r.error || ('status ' + r.status)));
    }
  } else add('FAILED', 'The laptop side is not running.');

  // ----- Windows Firewall (read-only) -----
  if (os.platform() === 'win32') {
    const st = await run('netsh.exe', ['advfirewall', 'show', 'allprofiles', 'state']);
    if (st.err) add('NOTE', 'Could not read the firewall state (' + (st.err.message || st.err) + ')');
    else {
      const lines = st.out.replace(/\r/g, '').split('\n'); const parts = []; let prof = '';
      for (const l of lines) { const p = l.match(/^\s*(\w+) Profile Settings/i); if (p) prof = p[1]; const s = l.match(/^\s*State\s+(\w+)/i); if (s && prof) { parts.push(prof + ' ' + s[1]); prof = ''; } }
      add('NOTE', 'Firewall: ' + (parts.join(', ') || st.out.trim().slice(0, 120)));
    }
    const rules = await run('netsh.exe', ['advfirewall', 'firewall', 'show', 'rule', 'name=all', 'dir=in'], 15000);
    if (!rules.err) {
      const exe = path.basename(process.execPath).toLowerCase();
      const blocks = rules.out.split(/\r?\n\r?\n/).filter((b) => b.toLowerCase().includes(exe));
      const blocked = blocks.filter((b) => /Action:\s*Block/i.test(b)).length;
      const allowed = blocks.filter((b) => /Action:\s*Allow/i.test(b)).length;
      if (blocked) add('FAILED', 'Windows Firewall has a BLOCK rule for ' + exe + '. The phone cannot reach this laptop. Open "Windows Defender Firewall > Allow an app" and allow UltraCast on Private networks.');
      else if (allowed) add('OK', 'Windows Firewall has an allow rule for ' + exe);
      else add('NOTE', 'No firewall rule for ' + exe + ' yet. The first time a phone connects, Windows asks "Allow access?". Tick Private networks and press Allow. If that box never appeared, the phone is being blocked.');
    }
  }

  // ----- screen capture -----
  try {
    const displays = E.screen.getAllDisplays();
    const srcs = await E.desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 160, height: 90 } });
    const scr = srcs.filter((s) => /^screen:/.test(s.id));
    if (scr.length) add('OK', 'Screen capture works: ' + displays.length + ' display(s), ' + scr.length + ' screen source(s), ' + (srcs.length - scr.length) + ' window(s)');
    else add('FAILED', 'Windows gave no screen to capture.');
  } catch (e) { add('FAILED', 'Screen capture: ' + (e && e.message ? e.message : e)); }

  // ----- hotkeys -----
  for (const key of ['Control+Alt+J', 'Control+Alt+K']) {
    try {
      const was = E.globalShortcut.isRegistered(key);
      const ok = was || E.globalShortcut.register(key, () => {});
      if (ok && !was) E.globalShortcut.unregister(key);
      add(ok ? 'OK' : 'FAILED', 'Hotkey ' + key.replace('Control', 'Ctrl') + (ok ? (was ? ' is in use right now (that is normal while the phone is controlling)' : ' can be used') : ' is taken by another program, so it cannot stop control or remove the cover. Close the other program that uses it.'));
    } catch (e) { add('FAILED', 'Hotkey ' + key + ': ' + (e && e.message ? e.message : e)); }
  }

  // ----- keeping awake -----
  try { const id = E.powerSaveBlocker.start('prevent-display-sleep'); const on = E.powerSaveBlocker.isStarted(id); E.powerSaveBlocker.stop(id); add(on ? 'OK' : 'FAILED', 'Keeping the screen awake ' + (on ? 'works' : 'did not start')); }
  catch (e) { add('FAILED', 'Keep awake: ' + (e && e.message ? e.message : e)); }

  // ----- clipboard -----
  try {
    const before = (await E.clipboard.readText()) || ''; const probe = 'uc-probe-' + Date.now();
    let back = '';
    for (let i = 0; i < 5 && back !== probe; i++) {   // Windows can hold the clipboard for a moment (clipboard history, other apps)
      await E.clipboard.writeText(probe); await new Promise((r) => setTimeout(r, 120)); back = await E.clipboard.readText();
    }
    await E.clipboard.writeText(String(before || ''));
    add(back === probe ? 'OK' : 'FAILED', 'Clipboard ' + (back === probe ? 'read and write work (your own clipboard text was put back)' : 'did not round-trip after 5 tries. Another program is probably holding the clipboard (clipboard manager, remote-desktop tool). Phone-to-laptop copy may not work until it lets go. Close it and run again.'));
  } catch (e) { add('FAILED', 'Clipboard: ' + (e && e.message ? e.message : e)); }

  // ----- tapping and typing from the phone -----
  if (os.platform() === 'win32') {
    try { require('koffi'); const { createBackend } = require('./inject'); const b = createBackend(); add(b && typeof b.send === 'function' && b.send.length >= 0 ? 'OK' : 'FAILED', 'Windows input (tap, type) component loaded'); }
    catch (e) { add('FAILED', 'Windows input component did not load: ' + (e && e.message ? e.message : e) + '. The phone could see this laptop but not control it.'); }
  } else add('NOTE', 'Tap and type from the phone only works on Windows.');

  // ----- files and settings -----
  try { const f = path.join(deps.userData, 'probe.tmp'); fs.mkdirSync(deps.userData, { recursive: true }); fs.writeFileSync(f, 'x'); fs.unlinkSync(f); add('OK', 'Settings folder is writable'); }
  catch (e) { add('FAILED', 'Settings folder is not writable: ' + (e && e.message ? e.message : e)); }
  try { const dl = path.join(os.homedir(), 'Downloads'); fs.accessSync(fs.existsSync(dl) ? dl : os.homedir(), fs.constants.W_OK); add('OK', 'Downloads folder is writable (received files go to Downloads/UltraCast)'); }
  catch (e) { add('FAILED', 'Downloads folder is not writable: ' + (e && e.message ? e.message : e)); }

  return out;
}

function lum(bitmap) {   // average brightness 0..255 of a BGRA bitmap, sampled
  let sum = 0, n = 0;
  for (let i = 0; i + 3 < bitmap.length; i += 4 * 17) { sum += 0.114 * bitmap[i] + 0.587 * bitmap[i + 1] + 0.299 * bitmap[i + 2]; n++; }
  return n ? sum / n : 0;
}

/** Shows the black cover for about a second and checks whether screen capture still sees the real screen through it. */
async function coverCaptureTest(deps) {
  const E = deps.electron;
  const grab = async () => { const s = await E.desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 320, height: 180 } }); return s[0] ? lum(s[0].thumbnail.toBitmap()) : -1; };
  const before = await grab();
  if (before < 0) return item('FAILED', 'Could not capture the screen to compare.');
  const shown = deps.showCover();
  if (!shown.ok) return item('FAILED', 'The cover could not be shown: ' + (shown.reason || ''));
  await new Promise((r) => setTimeout(r, 900));
  const during = await grab();
  deps.hideCover();
  if (before < 6) return item('NOTE', 'Your desktop is nearly black already, so this test cannot tell. Open a bright window and run it again.');
  if (during > before * 0.5) return item('OK', 'The black cover stays out of screen capture (brightness ' + Math.round(before) + ' without it, ' + Math.round(during) + ' with it). The phone will see the real screen while this laptop looks switched off.');
  return item('FAILED', 'Screen capture SAW the black cover (brightness ' + Math.round(before) + ' without it, ' + Math.round(during) + ' with it). The phone would see black. Tell Claude.');
}

module.exports = { runChecks, coverCaptureTest, lum };
