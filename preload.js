'use strict';
// The preload is a narrow service hatch between the app window and the caretaker (main.js).
// The window can only use the things listed here, nothing else.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ultracast', {
  info: () => ipcRenderer.invoke('ultracast:info'),
  newPairing: () => ipcRenderer.invoke('ultracast:new-pairing'),
  onEvent: (cb) => ipcRenderer.on('ultracast:event', (_e, data) => cb(data)),
  // step 3: phone controls laptop
  controlRequest: () => ipcRenderer.invoke('ultracast:control-request'),
  controlRelease: () => ipcRenderer.send('ultracast:control-release'),
  input: (msg) => ipcRenderer.send('ultracast:input', msg),
  onControlStarted: (cb) => ipcRenderer.on('ultracast:control-started', () => cb()),
  onControlEnded: (cb) => ipcRenderer.on('ultracast:control-ended', (_e, why) => cb(why)),
  // step 4: files from the phone
  fileOffer: (name, size) => ipcRenderer.invoke('ultracast:file-offer', name, size),
  fileChunk: (buf) => ipcRenderer.send('ultracast:file-chunk', buf),
  fileEnd: () => ipcRenderer.invoke('ultracast:file-end'),
  fileAbort: () => ipcRenderer.send('ultracast:file-abort'),
  // step 5: devices and pairing
  addresses: () => ipcRenderer.invoke('ultracast:addresses'),
  devices: () => ipcRenderer.invoke('ultracast:devices'),
  trustDevice: (name) => ipcRenderer.invoke('ultracast:device-trust', name),
  removeDevice: (id) => ipcRenderer.invoke('ultracast:device-remove', id),
  renameDevice: (id, name) => ipcRenderer.invoke('ultracast:device-rename', id, name),
  disconnect: () => ipcRenderer.send('ultracast:disconnect'),
  diagCopy: (t) => ipcRenderer.invoke('ultracast:diag-copy', t),
  diagSave: (t) => ipcRenderer.invoke('ultracast:diag-save', t),
  diag: () => ipcRenderer.invoke('ultracast:diag'),
  diagCover: () => ipcRenderer.invoke('ultracast:diag-cover'),
  cover: (on) => ipcRenderer.invoke('ultracast:cover', !!on),
  onCoverChanged: (cb) => ipcRenderer.on('ultracast:cover-changed', (_e, d) => cb(d)),
  onLocked: (cb) => ipcRenderer.on('ultracast:locked', (_e, on) => cb(!!on)),
  power: (action) => ipcRenderer.invoke('ultracast:power', action),
  sdpSign: (type, sdp) => ipcRenderer.invoke('ultracast:sdp-sign', type, sdp),
  sdpVerify: (type, sdp, mac) => ipcRenderer.invoke('ultracast:sdp-verify', type, sdp, mac),
  clipRead: () => ipcRenderer.invoke('ultracast:clip-read'),
  clipWrite: (t) => ipcRenderer.invoke('ultracast:clip-write', t),
  fullscreen: (on) => ipcRenderer.send('ultracast:fullscreen', !!on),
  float: (on, aspect) => ipcRenderer.invoke('ultracast:float', !!on, aspect),
  getSettings: () => ipcRenderer.invoke('ultracast:get-settings'),
  setSettings: (s) => ipcRenderer.invoke('ultracast:set-settings', s),
});
