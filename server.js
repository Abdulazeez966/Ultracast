'use strict';
/*
  UltraCast laptop server (step 1)

  Does three jobs:
    1. Serves the phone viewer page over your hotspot network.
    2. Pairs one phone using a one-time secret token (the QR code carries it).
    3. Relays WebRTC "signal" messages between the laptop app (host) and the phone (viewer)
       so the two can set up their direct, encrypted video link.

  It never sees video. Video goes straight between the devices over WebRTC.
*/

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');

const DEFAULT_PORT = Number(process.env.ULTRACAST_PORT || 8765);
const TOKEN_TTL_MS = 2 * 60 * 1000; // a pairing code works for 2 minutes
const MAX_BAD_TRIES = 5;            // wrong codes allowed before the code is locked
const HELLO_TIMEOUT_MS = 5000;      // a new connection must say hello within 5 seconds
const MAX_MESSAGE_BYTES = 64 * 1024;

// ---------- helpers ----------

function isLoopback(addr) {
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
}

// Only devices on a private network (your hotspot or home WiFi) may connect.
function isPrivate(addr) {
  if (!addr) return false;
  if (isLoopback(addr)) return true;
  const a = addr.replace(/^::ffff:/, '');
  return (
    /^10\./.test(a) ||
    /^192\.168\./.test(a) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(a) ||
    /^169\.254\./.test(a)
  );
}

function privateIPv4s() {
  const out = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const n of nets[name] || []) {
      if (n.family === 'IPv4' && !n.internal && isPrivate(n.address)) {
        out.push({ name, address: n.address });
      }
    }
  }
  return out;
}

// Compares two secrets without leaking how many characters matched.
function safeEqual(a, b) {
  const A = Buffer.from(String(a));
  const B = Buffer.from(String(b));
  return A.length === B.length && crypto.timingSafeEqual(A, B);
}

function send(ws, obj) {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj));
}

// ---------- server ----------

function start(options = {}) {
  const port = options.port === undefined ? DEFAULT_PORT : options.port;
  const events = new EventEmitter();

  // The laptop app proves it is the real host with this key. It stays in memory only.
  const hostKey = crypto.randomBytes(24).toString('hex');

  let pairing = null;   // { token, expires, badTries }
  let host = null;      // the laptop app's connection
  let viewer = null;    // the paired phone's connection

  const viewerPage = fs.readFileSync(path.join(__dirname, 'public', 'viewer.html'));
  const transferJs = fs.readFileSync(path.join(__dirname, 'renderer', 'transfer.js'));

  const server = http.createServer((req, res) => {
    if (!isPrivate(req.socket.remoteAddress)) {
      res.writeHead(403); res.end('Forbidden'); return;
    }
    const url = (req.url || '/').split('?')[0];
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy':
          "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; connect-src ws: wss:; img-src data: blob:; media-src blob:",
      });
      res.end(viewerPage);
      return;
    }
    if (req.method === 'GET' && url === '/transfer.js') {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(transferJs);
      return;
    }
    res.writeHead(404); res.end('Not found');
  });

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: MAX_MESSAGE_BYTES });

  wss.on('connection', (ws, req) => {
    const remote = req.socket.remoteAddress;
    if (!isPrivate(remote)) { ws.close(1008, 'forbidden'); return; }

    ws.role = null;
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    const helloTimer = setTimeout(() => { if (!ws.role) ws.close(1008, 'hello-timeout'); }, HELLO_TIMEOUT_MS);

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch (e) { ws.close(1003, 'bad-json'); return; }
      if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') { ws.close(1003, 'bad-message'); return; }

      // ----- first message must be hello -----
      if (!ws.role) {
        if (msg.type !== 'hello') { ws.close(1008, 'hello-required'); return; }
        clearTimeout(helloTimer);

        if (msg.role === 'host') {
          if (!isLoopback(remote) || !safeEqual(msg.hostKey || '', hostKey)) {
            send(ws, { type: 'error', reason: 'bad-host-key' }); ws.close(1008, 'bad-host-key'); return;
          }
          if (host && host !== ws) host.close(1000, 'replaced');
          host = ws; ws.role = 'host';
          send(ws, { type: 'ready', role: 'host' });
          if (viewer) send(ws, { type: 'peer-joined' });
          return;
        }

        if (msg.role === 'viewer') {
          if (!pairing || Date.now() > pairing.expires) {
            send(ws, { type: 'error', reason: 'expired' }); ws.close(1008, 'expired'); return;
          }
          if (pairing.badTries >= MAX_BAD_TRIES) {
            send(ws, { type: 'error', reason: 'locked' }); ws.close(1008, 'locked'); return;
          }
          if (!safeEqual(msg.token || '', pairing.token)) {
            pairing.badTries += 1;
            events.emit('bad-token', { from: remote, tries: pairing.badTries });
            send(ws, { type: 'error', reason: 'bad-token' }); ws.close(1008, 'bad-token'); return;
          }
          if (viewer) { send(ws, { type: 'error', reason: 'busy' }); ws.close(1008, 'busy'); return; }

          pairing = null;               // the code is now used up
          viewer = ws; ws.role = 'viewer'; ws.remote = remote;
          send(ws, { type: 'ready', role: 'viewer' });
          send(host, { type: 'peer-joined' });
          events.emit('paired', { from: remote });
          return;
        }

        ws.close(1008, 'unknown-role');
        return;
      }

      // ----- after hello: only "signal" messages are relayed -----
      if (msg.type === 'signal') {
        const target = ws.role === 'host' ? viewer : host;
        send(target, { type: 'signal', data: msg.data });
      }
      // anything else is ignored
    });

    ws.on('close', () => {
      clearTimeout(helloTimer);
      if (ws === host) host = null;
      if (ws === viewer) {
        viewer = null;
        send(host, { type: 'peer-left' });
        events.emit('unpaired');
      }
    });
    ws.on('error', () => {});
  });

  // Drop connections that stopped answering.
  const heartbeat = setInterval(() => {
    wss.clients.forEach((c) => {
      if (!c.isAlive) { c.terminate(); return; }
      c.isAlive = false;
      try { c.ping(); } catch (e) {}
    });
  }, 15000);
  heartbeat.unref();

  return new Promise((resolve) => {
    server.listen(port, '0.0.0.0', () => {
      const actualPort = server.address().port;

      // Makes a fresh one-time code. Any phone already connected is disconnected.
      function newPairing() {
        if (viewer) viewer.close(1000, 'new-pairing');
        const token = crypto.randomBytes(16).toString('hex');
        pairing = { token, expires: Date.now() + TOKEN_TTL_MS, badTries: 0 };
        return {
          token,
          expiresAt: pairing.expires,
          urls: privateIPv4s().map((n) => ({
            network: n.name,
            url: 'http://' + n.address + ':' + actualPort + '/?t=' + token,
          })),
        };
      }

      function close() {
        clearInterval(heartbeat);
        wss.clients.forEach((c) => c.terminate());
        return new Promise((r) => server.close(() => r()));
      }

      resolve({ port: actualPort, hostKey, events, newPairing, close });
    });
  });
}

module.exports = { start, isPrivate, isLoopback, privateIPv4s };

// ---------- run directly: node server.js ----------

if (require.main === module) {
  start().then((s) => {
    const p = s.newPairing();
    console.log('');
    console.log('UltraCast server is running on port ' + s.port);
    console.log('');
    if (p.urls.length === 0) {
      console.log('No private network found. Join your phone\'s hotspot first, then run this again.');
    } else {
      console.log('On your phone, open this address (valid for 2 minutes):');
      p.urls.forEach((u) => console.log('  ' + u.url + '   [' + u.network + ']'));
    }
    console.log('');
    console.log('Waiting for the phone...');
    s.events.on('paired', (e) => console.log('Phone paired from ' + e.from));
    s.events.on('unpaired', () => console.log('Phone disconnected'));
    s.events.on('bad-token', (e) => console.log('Wrong code from ' + e.from + ' (try ' + e.tries + ')'));
  });
}
