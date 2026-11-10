'use strict';
/*
  UltraCast laptop app (Electron main process)

  Electron is a ready-made "house" for a desktop app. This file is the caretaker of that house. It:
    - starts the front-desk server from step 1,
    - opens the app window,
    - decides WHICH screen gets shared (the main one) and includes the laptop's sound,
    - (step 3) is the ONLY place that decides whether the phone may control the laptop.

  Control rules, kept here in the caretaker's hands so a web page can never skip them:
    1. The phone asks. Unless you switched on "allow without asking", a Windows box asks you: Allow or Deny.
    2. While the phone is in control, a small bar stays on top of every window with a Stop button.
    3. The hotkey Ctrl+Alt+J stops control instantly, even if the bar is hidden behind something.
    4. Nothing the phone sends is performed unless control is currently granted.
*/

const { app, BrowserWindow, Menu, ipcMain, session, desktopCapturer, screen, dialog, globalShortcut, clipboard, powerSaveBlocker, powerMonitor } = require('electron');
const path = require('path');
const fs = require('fs');
const { start, privateIPv4s, sdpMacFor } = require('./server');
const crypto = require('crypto');
const { createStore } = require('./devices');
const os = require('os');
const { createInjector, createBackend } = require('./inject');
const { sanitizeName, isRisky, uniqueName, openIncoming } = require('./filesafe');
const { createPower } = require('./power');
const { chooseSource } = require('./pick');
const diag = require('./diag');

// Chromium normally hides this laptop's real address behind a made-up name when it makes a call.
// A phone on a hotspot often can't look that name up, so we turn the hiding off. Safe here:
// the call never leaves your own hotspot network.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');
// Windows slows down hidden or covered windows; that must not make a live link look dead.
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows');

const HOTKEY = 'Control+Alt+J';
const UNCOVER_KEY = 'Control+Alt+K';   // always removes the black cover

let srv = null;
let devices = null;
let win = null;
let banner = null;
let injector = null;
let controlling = false;
let asking = false;
let phoneAddr = '';
let trustedId = null;     // the id of the trusted phone that is connected now (its secret signs the call descriptions)
let authorized = false;   // true only for a phone that is trusted (returned with its proof, or confirmed by the laptop's Yes)

// ---------- settings (saved in a small file in the app's own data folder) ----------
const DEFAULTS = {
  controlMode: 'ask',      // 'ask' = ask me every time, 'auto' = allow without asking
  receiveMode: 'every',    // files: 'every' = ask each time, 'session' = ask once per connection, 'auto' = accept automatically
  saveMode: 'default',     // files: 'default' = Downloads/UltraCast, 'ask' = choose a folder each time
  theme: 'dark',           // 'dark', 'light' or 'system'
  clipSync: 'on',          // copy and paste between laptop and phone: 'on' or 'off'
  keepAwake: 'on',         // keep this laptop (and its screen) awake while a trusted phone is connected: 'on' or 'off'
  shareWhat: 'main',       // when sharing this laptop: 'main' = the main screen, 'ask' = ask which screen or window each time
};
const CHOICES = { controlMode: ['ask', 'auto'], receiveMode: ['every', 'session', 'auto'], saveMode: ['default', 'ask'], theme: ['dark', 'light', 'system'], clipSync: ['on', 'off'], keepAwake: ['on', 'off'], shareWhat: ['main', 'ask'] };
let settings = { ...DEFAULTS };
const settingsFile = () => path.join(app.getPath('userData'), 'settings.json');
function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    for (const k of Object.keys(CHOICES)) if (raw && CHOICES[k].includes(raw[k])) settings[k] = raw[k];
  } catch (e) { /* first run: defaults */ }
}
function saveSettings() {
  try { fs.mkdirSync(path.dirname(settingsFile()), { recursive: true }); fs.writeFileSync(settingsFile(), JSON.stringify(settings)); } catch (e) {}
}

// ---------- keeping the laptop awake ----------
// If the screen turned itself off, the picture sent to the phone would go black. While a trusted phone is connected the laptop
// (and its screen) is kept awake. It cannot help if the lid is closed or the power button is pressed: Windows then sleeps for real.
let blockerId = null;
function updateBlocker() {
  const want = authorized && settings.keepAwake === 'on';
  if (want && blockerId === null) blockerId = powerSaveBlocker.start('prevent-display-sleep');
  else if (!want && blockerId !== null) { try { powerSaveBlocker.stop(blockerId); } catch (e) {} blockerId = null; }
  global.__ucBlockerOn = blockerId !== null;   // read by the automated tests
}


// ---------- black cover (hide the laptop screen while the phone still sees and controls it) ----------
// One black window per display, on top of everything, that clicks pass through and that screen capture skips. To anyone standing
// near the laptop it looks switched off; the phone still gets the real picture. Ctrl+Alt+K always removes it.
let covers = [];
function coverOn() { return covers.length > 0; }
function showCover() {
  if (coverOn()) return { ok: true };
  try {
    for (const d of screen.getAllDisplays()) {
      const w = new BrowserWindow({
        x: d.bounds.x, y: d.bounds.y, width: d.bounds.width, height: d.bounds.height,
        frame: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
        skipTaskbar: true, alwaysOnTop: true, focusable: false, show: false, hasShadow: false, backgroundColor: '#000000',
        webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
      });
      w.setAlwaysOnTop(true, 'screen-saver');
      w.setContentProtection(true);          // Windows leaves this window out of screen capture
      w.setIgnoreMouseEvents(true);          // clicks go straight through to what is underneath
      w.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      w.webContents.on('will-navigate', (e) => e.preventDefault());
      w.loadURL('data:text/html,<body style="background:%23000;margin:0;cursor:none">');
      w.once('ready-to-show', () => { try { w.setBounds(d.bounds); w.showInactive(); } catch (e) {} });
      w.on('closed', () => { covers = covers.filter((c) => c !== w); });
      covers.push(w);
    }
    try { globalShortcut.register(UNCOVER_KEY, () => hideCover('hotkey')); } catch (e) {}
    global.__ucCoverOn = true;
    tellWindow('ultracast:cover-changed', { on: true });
    return { ok: true };
  } catch (e) { hideCover('error'); return { ok: false, reason: 'Windows would not show the cover' }; }
}
function hideCover(why) {
  const was = coverOn();
  const list = covers; covers = [];
  for (const w of list) { try { w.destroy(); } catch (e) {} }
  try { globalShortcut.unregister(UNCOVER_KEY); } catch (e) {}
  global.__ucCoverOn = false;
  if (was) tellWindow('ultracast:cover-changed', { on: false, why: why || 'off' });
}

// ---------- control ----------
function showBanner() {
  if (banner) return;
  const d = screen.getPrimaryDisplay().workArea;
  const w = 360, h = 54;
  banner = new BrowserWindow({
    width: w, height: h, x: Math.round(d.x + (d.width - w) / 2), y: d.y + 10,
    frame: false, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, alwaysOnTop: true, focusable: false, show: false, hasShadow: true,
    backgroundColor: '#141B2D',
    webPreferences: { preload: path.join(__dirname, 'banner-preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  banner.setAlwaysOnTop(true, 'screen-saver');
  banner.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  banner.webContents.on('will-navigate', (e) => e.preventDefault());
  banner.loadFile(path.join(__dirname, 'renderer', 'banner.html'));
  banner.once('ready-to-show', () => { if (banner) banner.showInactive(); });
  banner.on('closed', () => { banner = null; });
}

function beginControl() {
  controlling = true;
  showBanner();
  try { globalShortcut.register(HOTKEY, () => endControl('hotkey')); } catch (e) {}
  tellWindow('ultracast:control-started');
}

function endControl(reason) {
  if (!controlling) return;
  controlling = false;
  hideCover('control-ended');
  try { globalShortcut.unregister(HOTKEY); } catch (e) {}
  if (banner) { try { banner.close(); } catch (e) {} banner = null; }
  tellWindow('ultracast:control-ended', reason || 'stopped');
}

function tellWindow(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

async function decideControl() {
  if (controlling) return true;
  if (asking) return false;                 // already showing a question
  if (settings.controlMode === 'auto') { beginControl(); return true; }
  asking = true;
  try {
    const r = await dialog.showMessageBox(win && !win.isDestroyed() ? win : undefined, {
      type: 'question',
      title: 'UltraCast',
      message: 'Your phone wants to control this laptop',
      detail: 'It will be able to move the pointer, click and type until you stop it.\n' +
              'You can stop it any time with the Stop button on the bar at the top of your screen, or by pressing Ctrl+Alt+J.' +
              (phoneAddr ? '\n\nPhone: ' + phoneAddr : ''),
      buttons: ['Deny', 'Allow'], defaultId: 0, cancelId: 0, noLink: true,
    });
    if (r.response === 1) { beginControl(); return true; }
    return false;
  } finally { asking = false; }
}

// ---------- receiving files from the phone ----------
let incoming = null;       // the file currently arriving (only one at a time)
let sessionAccepted = false;

const mb = (n) => (n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB');
const parent = () => (win && !win.isDestroyed() ? win : undefined);

async function acceptIncoming(rawName, size) {
  if (incoming) return { ok: false, reason: 'Another file is already arriving' };
  incoming = { reserved: true };
  let opened = null;
  try {
    const clean = sanitizeName(rawName);

    // 1. Do we want it?
    const trusted = settings.receiveMode === 'auto' || (settings.receiveMode === 'session' && sessionAccepted);
    if (!trusted) {
      const r = await dialog.showMessageBox(parent(), {
        type: 'question', title: 'UltraCast', message: 'Your phone wants to send you a file',
        detail: clean + '\n' + mb(size) + (phoneAddr ? '\nFrom: ' + phoneAddr : '') +
                (isRisky(clean) ? '\n\nCareful: this is a program or script file. Only accept it if you know what it is.' : ''),
        buttons: ['Decline', 'Accept'], defaultId: 0, cancelId: 0, noLink: true,
      });
      if (r.response !== 1) return { ok: false, reason: 'Declined on the laptop' };
      if (settings.receiveMode === 'session') sessionAccepted = true;
    }

    // 2. Where does it go?
    let dir;
    if (settings.saveMode === 'ask') {
      const r = await dialog.showOpenDialog(parent(), { title: 'Choose where to save ' + clean, properties: ['openDirectory', 'createDirectory'] });
      if (r.canceled || !r.filePaths[0]) return { ok: false, reason: 'No folder chosen on the laptop' };
      dir = r.filePaths[0];
    } else {
      dir = path.join(app.getPath('downloads'), 'UltraCast');
    }
    fs.mkdirSync(dir, { recursive: true });

    // 3. Is there already a file with this name?
    let name = clean, replace = false;
    if (fs.existsSync(path.join(dir, clean))) {
      const r = await dialog.showMessageBox(parent(), {
        type: 'question', title: 'UltraCast', message: 'A file called "' + clean + '" is already in that folder',
        detail: 'What should happen to the new one?', buttons: ['Skip', 'Keep both', 'Replace'], defaultId: 1, cancelId: 0, noLink: true,
      });
      if (r.response === 0) return { ok: false, reason: 'Skipped because the name already exists' };
      if (r.response === 1) name = uniqueName(dir, clean); else replace = true;
    }

    opened = openIncoming(dir, name, size, replace);
    incoming = opened;
    return { ok: true, name };
  } catch (err) {
    return { ok: false, reason: 'Could not save: ' + err.message };
  } finally {
    if (!opened) incoming = null;
  }
}
function dropIncoming() { if (incoming && incoming.abort) incoming.abort(); incoming = null; }

// ---------- window ----------
async function createWindow() {
  devices = createStore(path.join(app.getPath('userData'), 'devices.json'));
  // A public name tag for this laptop (not a secret), made once and kept.
  let hid = '';
  const hidFile = path.join(app.getPath('userData'), 'laptop-id.txt');
  try { hid = fs.readFileSync(hidFile, 'utf8').trim(); } catch (e) {}
  if (!/^[0-9a-f]{16}$/.test(hid)) {
    hid = require('crypto').randomBytes(8).toString('hex');
    try { fs.mkdirSync(path.dirname(hidFile), { recursive: true }); fs.writeFileSync(hidFile, hid); } catch (e) {}
  }
  srv = await start({ trust: devices, info: () => ({ name: os.hostname(), hid }) });
  injector = createInjector(createBackend());

  win = new BrowserWindow({
    width: 980, height: 760, minWidth: 720, minHeight: 560,
    backgroundColor: '#0B0F1A', title: 'UltraCast', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      backgroundThrottling: false,   // keep the link's timers running when the window is hidden, minimised or covered
      contextIsolation: true,   // the page cannot reach Electron's powers directly
      nodeIntegration: false,   // the page cannot use Node
      sandbox: true,
    },
  });

  // Share the whole main screen. Sound (everything the laptop plays) is only available on Windows.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const primary = String(screen.getPrimaryDisplay().id);
      let pick;
      if (settings.shareWhat === 'ask') {
        const all = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
        pick = await chooseSource(all, primary, async (message, labels) => {
          const r = await dialog.showMessageBox(parent(), { type: 'question', title: 'UltraCast', message, buttons: [...labels, 'Cancel'], cancelId: labels.length, noLink: true });
          return r.response >= labels.length ? -1 : r.response;
        });
      } else {
        const sources = await desktopCapturer.getSources({ types: ['screen'] });
        pick = sources.find((s) => s.display_id === primary) || sources[0];
      }
      if (!pick) { callback({}); return; }
      const grant = { video: pick };
      if (process.platform === 'win32') grant.audio = 'loopback';
      callback(grant);
    } catch (e) { callback({}); }
  }, { useSystemPicker: false });

  // Only allow what UltraCast needs: capturing the screen.
  session.defaultSession.setPermissionRequestHandler((_wc, permission, cb) => {
    cb(permission === 'display-capture' || permission === 'media');
  });

  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (e) => e.preventDefault());

  srv.events.on('paired', (e) => { phoneAddr = e.from || ''; authorized = !!e.trusted; trustedId = e.trusted && e.deviceId ? e.deviceId : null; updateBlocker(); if (e.deviceId) devices.touch(e.deviceId); tellWindow('ultracast:event', { type: 'paired', from: e.from, trusted: !!e.trusted, deviceId: e.deviceId || null, name: e.name || '' }); });
  srv.events.on('unpaired', () => { trustedId = null; endControl('phone-left'); dropIncoming(); sessionAccepted = false; phoneAddr = ''; authorized = false; updateBlocker(); tellWindow('ultracast:event', { type: 'unpaired' }); });
  srv.events.on('bad-token', (e) => tellWindow('ultracast:event', { type: 'bad-token', from: e.from, tries: e.tries }));

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('enter-full-screen', () => tellWindow('ultracast:event', { type: 'fullscreen', on: true }));
  win.on('leave-full-screen', () => tellWindow('ultracast:event', { type: 'fullscreen', on: false }));
  win.on('closed', () => { endControl('closed'); dropIncoming(); win = null; });
}

// Only the app's own window may talk to these doors.
const fromMain = (e) => win && !win.isDestroyed() && e.sender === win.webContents;

ipcMain.handle('ultracast:info', (e) => (fromMain(e) ? { port: srv.port, hostKey: srv.hostKey, name: os.hostname() } : null));
ipcMain.handle('ultracast:new-pairing', (e) => (fromMain(e) ? srv.newPairing() : null));
ipcMain.handle('ultracast:control-request', (e) => (fromMain(e) && authorized ? decideControl() : false));
ipcMain.on('ultracast:control-release', (e) => { if (fromMain(e)) endControl('released'); });
ipcMain.on('ultracast:input', (e, msg) => { if (fromMain(e) && authorized && controlling && injector) injector.handle(msg); });
ipcMain.handle('ultracast:addresses', (e) => (fromMain(e) ? privateIPv4s().map((n) => ({ network: n.name, url: 'http://' + n.address + ':' + srv.port + '/' })) : []));
ipcMain.handle('ultracast:devices', (e) => (fromMain(e) ? devices.list() : []));
// The laptop's "Yes, they match": only now is the phone added to the guest book and allowed in.
ipcMain.handle('ultracast:device-trust', (e, name) => {
  if (!fromMain(e) || !phoneAddr || authorized) return null;
  authorized = true;
  const rec = devices.add(typeof name === 'string' ? name : '');
  trustedId = rec.id;
  updateBlocker();
  return rec;
});
ipcMain.handle('ultracast:device-remove', (e, id) => (fromMain(e) && typeof id === 'string' ? devices.remove(id) : false));
ipcMain.handle('ultracast:device-rename', (e, id, name) => (fromMain(e) && typeof id === 'string' && typeof name === 'string' ? devices.rename(id, name) : false));
// Power actions asked for by the (trusted) phone. The laptop owner confirms on a dialog whose default is Cancel.
const power = createPower({
  confirm: async (action, label) => {
    const r = await dialog.showMessageBox(parent(), {
      type: 'warning', title: 'UltraCast', message: 'Your phone asks: ' + label.toLowerCase() + '?',
      detail: 'Save your work first. This will happen about 5 seconds after you press the button.',
      buttons: ['Cancel', label], defaultId: 0, cancelId: 0, noLink: true,
    });
    return r.response === 1;
  },
});
// The phone asks to hide or show the laptop screen. Only while control is granted; the cover is always removed when control ends.
ipcMain.handle('ultracast:cover', (e, on) => {
  if (!fromMain(e) || !authorized || !controlling) return { ok: false, reason: 'Control is not on' };
  if (on) return showCover();
  hideCover('phone'); return { ok: true };
});
// The self-check (Settings > Run self-check). Read-only; the cover test flashes the screen for about a second.
function diagDeps() {
  return {
    electron: { app, desktopCapturer, globalShortcut, clipboard, powerSaveBlocker, screen },
    server: { port: srv && srv.port, addresses: privateIPv4s().map((n) => ({ network: n.name, url: 'http://' + n.address + ':' + (srv && srv.port) + '/' })) },
    userData: app.getPath('userData'),
    showCover, hideCover: () => hideCover('test'),
  };
}
// Copy and save for the self-check. The text goes through the main side because the window's own clipboard is not always allowed.
ipcMain.handle('ultracast:diag-copy', async (e, text) => { if (!fromMain(e) || typeof text !== 'string' || text.length > 60000) return false; try { await clipboard.writeText(text); return (await clipboard.readText()) === text; } catch (err) { return false; } });
ipcMain.handle('ultracast:diag-save', (e, text) => {
  if (!fromMain(e) || typeof text !== 'string' || text.length > 60000) return '';
  try { const dir = path.join(app.getPath('downloads'), 'UltraCast'); fs.mkdirSync(dir, { recursive: true }); const f = path.join(dir, 'ultracast-log.txt'); fs.writeFileSync(f, text); return f; } catch (err) { return ''; }
});
ipcMain.handle('ultracast:diag', async (e) => (fromMain(e) ? diag.runChecks(diagDeps()) : []));
ipcMain.handle('ultracast:diag-cover', async (e) => (fromMain(e) && !controlling ? diag.coverCaptureTest(diagDeps()) : { kind: 'NOTE', text: 'Stop phone control first, then run this test.' }));
ipcMain.handle('ultracast:power', (e, action) => (fromMain(e) && authorized ? power.run(action) : { ok: false, reason: 'Not allowed' }));
// Signing the call descriptions of a trusted phone (see sdpMacFor in server.js). Without a trusted phone there is nothing to sign with.
const MAX_SDP_CHARS = 60000;
ipcMain.handle('ultracast:sdp-sign', (e, type, sdp) => {
  if (!fromMain(e) || !trustedId || typeof type !== 'string' || typeof sdp !== 'string' || sdp.length > MAX_SDP_CHARS) return null;
  const secret = devices.lookup(trustedId);
  return secret ? sdpMacFor(secret, 'host', type, sdp) : null;
});
ipcMain.handle('ultracast:sdp-verify', (e, type, sdp, mac) => {
  if (!fromMain(e) || !trustedId || typeof type !== 'string' || typeof sdp !== 'string' || typeof mac !== 'string' || sdp.length > MAX_SDP_CHARS || mac.length !== 64) return false;
  const secret = devices.lookup(trustedId);
  if (!secret) return false;
  const want = Buffer.from(sdpMacFor(secret, 'phone', type, sdp)), got = Buffer.from(mac);
  return want.length === got.length && crypto.timingSafeEqual(want, got);
});

// Copy and paste between the devices (plain text only, never more than 6000 characters).
const CLIP_MAX = 6000;
// Note: in this Electron version the clipboard calls return Promises, so they must be awaited (not awaiting made laptop-to-phone copy send nothing).
ipcMain.handle('ultracast:clip-read', async (e) => {
  if (!fromMain(e) || !authorized || settings.clipSync !== 'on') return '';
  const t = await clipboard.readText();
  return typeof t === 'string' && t.length <= CLIP_MAX ? t : '';
});
ipcMain.handle('ultracast:clip-write', async (e, text) => {
  if (!fromMain(e) || !authorized || settings.clipSync !== 'on' || typeof text !== 'string' || text.length > CLIP_MAX) return false;
  await clipboard.writeText(text); return true;
});

// Full screen and the small always-on-top window for the phone's picture.
let floatSaved = null;
ipcMain.on('ultracast:fullscreen', (e, on) => { if (fromMain(e)) win.setFullScreen(!!on); });
ipcMain.handle('ultracast:float', (e, on, aspect) => {
  if (!fromMain(e)) return false;
  if (on && !floatSaved) {
    floatSaved = { bounds: win.getBounds(), min: win.getMinimumSize(), full: win.isFullScreen() };
    if (floatSaved.full) win.setFullScreen(false);
    const a = Number.isFinite(aspect) && aspect > 0.2 && aspect < 5 ? aspect : 0.5;   // width / height of the phone picture
    const wa = screen.getPrimaryDisplay().workArea;
    const h = Math.min(560, wa.height - 40), w = Math.round(Math.min(Math.max(h * a, 200), wa.width - 40));
    win.setMinimumSize(160, 160);
    win.setBounds({ x: wa.x + wa.width - w - 16, y: wa.y + wa.height - h - 16, width: w, height: h });
    win.setAlwaysOnTop(true, 'floating');
    return true;
  }
  if (!on && floatSaved) {
    win.setAlwaysOnTop(false);
    win.setMinimumSize(floatSaved.min[0], floatSaved.min[1]);
    win.setBounds(floatSaved.bounds);
    floatSaved = null;
    return false;
  }
  return !!floatSaved;
});
ipcMain.on('ultracast:disconnect', (e) => { if (fromMain(e)) srv.disconnect(); });
ipcMain.handle('ultracast:get-settings', (e) => (fromMain(e) ? { ...settings } : null));
ipcMain.handle('ultracast:set-settings', (e, next) => {
  if (!fromMain(e) || !next || typeof next !== 'object') return null;
  for (const k of Object.keys(CHOICES)) if (CHOICES[k].includes(next[k])) settings[k] = next[k];
  saveSettings();
  updateBlocker();
  return { ...settings };
});
ipcMain.handle('ultracast:file-offer', (e, name, size) => (fromMain(e) && authorized && typeof name === 'string' && Number.isSafeInteger(size) && size >= 0 ? acceptIncoming(name, size) : { ok: false, reason: 'Bad offer' }));
ipcMain.on('ultracast:file-chunk', (e, buf) => { if (fromMain(e) && incoming && incoming.write && buf) incoming.write(Buffer.from(buf)); });
ipcMain.handle('ultracast:file-end', (e) => {
  if (!fromMain(e) || !incoming || !incoming.finish) return { ok: false, reason: 'Nothing was arriving' };
  const r = incoming.finish(); incoming = null; return r;
});
ipcMain.on('ultracast:file-abort', (e) => { if (fromMain(e)) dropIncoming(); });
ipcMain.on('ultracast:banner-stop', (e) => { if (banner && !banner.isDestroyed() && e.sender === banner.webContents) endControl('stop-button'); });

app.whenReady().then(() => {
  Menu.setApplicationMenu(null);
  loadSettings();
  createWindow();
});

// Tell the phone when this laptop locks or unlocks (Windows lock screen), so it can show "laptop is locked" instead of a mystery black picture.
try {
  app.whenReady().then(() => {
    powerMonitor.on('lock-screen', () => tellWindow('ultracast:locked', true));
    powerMonitor.on('unlock-screen', () => tellWindow('ultracast:locked', false));
  });
} catch (e) {}
app.on('will-quit', () => { hideCover('quit'); try { globalShortcut.unregisterAll(); } catch (e) {} });
app.on('window-all-closed', () => {
  if (srv) srv.close().finally(() => app.quit()); else app.quit();
});
