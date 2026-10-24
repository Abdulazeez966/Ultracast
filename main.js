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

const { app, BrowserWindow, Menu, ipcMain, session, desktopCapturer, screen, dialog, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { start } = require('./server');
const { createInjector, createBackend } = require('./inject');
const { sanitizeName, isRisky, uniqueName, openIncoming } = require('./filesafe');

// Chromium normally hides this laptop's real address behind a made-up name when it makes a call.
// A phone on a hotspot often can't look that name up, so we turn the hiding off. Safe here:
// the call never leaves your own hotspot network.
app.commandLine.appendSwitch('disable-features', 'WebRtcHideLocalIpsWithMdns');

const HOTKEY = 'Control+Alt+J';

let srv = null;
let win = null;
let banner = null;
let injector = null;
let controlling = false;
let asking = false;
let phoneAddr = '';

// ---------- settings (saved in a small file in the app's own data folder) ----------
const DEFAULTS = {
  controlMode: 'ask',      // 'ask' = ask me every time, 'auto' = allow without asking
  receiveMode: 'every',    // files: 'every' = ask each time, 'session' = ask once per connection, 'auto' = accept automatically
  saveMode: 'default',     // files: 'default' = Downloads/UltraCast, 'ask' = choose a folder each time
};
const CHOICES = { controlMode: ['ask', 'auto'], receiveMode: ['every', 'session', 'auto'], saveMode: ['default', 'ask'] };
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
  srv = await start();
  injector = createInjector(createBackend());

  win = new BrowserWindow({
    width: 980, height: 760, minWidth: 720, minHeight: 560,
    backgroundColor: '#0B0F1A', title: 'UltraCast', autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,   // the page cannot reach Electron's powers directly
      nodeIntegration: false,   // the page cannot use Node
      sandbox: true,
    },
  });

  // Share the whole main screen. Sound (everything the laptop plays) is only available on Windows.
  session.defaultSession.setDisplayMediaRequestHandler(async (_request, callback) => {
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      const primary = String(screen.getPrimaryDisplay().id);
      const pick = sources.find((s) => s.display_id === primary) || sources[0];
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

  srv.events.on('paired', (e) => { phoneAddr = e.from || ''; tellWindow('ultracast:event', { type: 'paired', from: e.from }); });
  srv.events.on('unpaired', () => { endControl('phone-left'); dropIncoming(); sessionAccepted = false; phoneAddr = ''; tellWindow('ultracast:event', { type: 'unpaired' }); });
  srv.events.on('bad-token', (e) => tellWindow('ultracast:event', { type: 'bad-token', from: e.from, tries: e.tries }));

  win.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  win.on('closed', () => { endControl('closed'); dropIncoming(); win = null; });
}

// Only the app's own window may talk to these doors.
const fromMain = (e) => win && !win.isDestroyed() && e.sender === win.webContents;

ipcMain.handle('ultracast:info', (e) => (fromMain(e) ? { port: srv.port, hostKey: srv.hostKey } : null));
ipcMain.handle('ultracast:new-pairing', (e) => (fromMain(e) ? srv.newPairing() : null));
ipcMain.handle('ultracast:control-request', (e) => (fromMain(e) ? decideControl() : false));
ipcMain.on('ultracast:control-release', (e) => { if (fromMain(e)) endControl('released'); });
ipcMain.on('ultracast:input', (e, msg) => { if (fromMain(e) && controlling && injector) injector.handle(msg); });
ipcMain.handle('ultracast:get-settings', (e) => (fromMain(e) ? { ...settings } : null));
ipcMain.handle('ultracast:set-settings', (e, next) => {
  if (!fromMain(e) || !next || typeof next !== 'object') return null;
  for (const k of Object.keys(CHOICES)) if (CHOICES[k].includes(next[k])) settings[k] = next[k];
  saveSettings();
  return { ...settings };
});
ipcMain.handle('ultracast:file-offer', (e, name, size) => (fromMain(e) && typeof name === 'string' && Number.isSafeInteger(size) && size >= 0 ? acceptIncoming(name, size) : { ok: false, reason: 'Bad offer' }));
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

app.on('will-quit', () => { try { globalShortcut.unregisterAll(); } catch (e) {} });
app.on('window-all-closed', () => {
  if (srv) srv.close().finally(() => app.quit()); else app.quit();
});
