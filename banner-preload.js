'use strict';
// The control bar can do exactly one thing: press Stop.
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('banner', { stop: () => ipcRenderer.send('ultracast:banner-stop') });
