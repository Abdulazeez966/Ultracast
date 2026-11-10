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
const { note } = require('./ping');
const { EventEmitter } = require('events');
const { WebSocketServer } = require('ws');

const DEFAULT_PORT = Number(process.env.ULTRACAST_PORT || 8765);
const TOKEN_TTL_MS = 2 * 60 * 1000; // a pairing code works for 2 minutes
const MAX_BAD_TRIES = 5;            // wrong codes allowed before the code is locked
const HELLO_TIMEOUT_MS = 5000;      // a new connection must say hello within 5 seconds
const MAX_MESSAGE_BYTES = 64 * 1024;
const PROOF_TIMEOUT_MS = 5000;      // a returning phone must answer the challenge within 5 seconds
const MAX_BAD_PROOFS = 5;           // wrong proofs from one address before it is locked out
const PROOF_LOCK_MS = 60 * 1000;

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

// What a returning phone must send back to prove it holds the secret.
function proofFor(secret, nonce) {
  return crypto.createHmac('sha256', String(secret)).update('ultracast-proof:' + nonce).digest('hex');
}

// What the laptop sends back so a returning phone knows it is talking to the real laptop, not an impostor.
// Signs a call description so a returning phone and the laptop know nobody changed it on the way
// (the description carries the fingerprints that protect the whole encrypted call). role: 'host' (laptop) or 'phone'.
function sdpMacFor(secret, role, type, sdp) {
  return crypto.createHmac('sha256', String(secret)).update('ultracast-sdp:' + role + ':' + type + ':' + sdp).digest('hex');
}
function hostProofFor(secret, cnonce) {
  return crypto.createHmac('sha256', String(secret)).update('ultracast-host:' + cnonce).digest('hex');
}

function cleanName(n) {
  return String(n == null ? '' : n).replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40);
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

  const info = typeof options.info === 'function' ? options.info : () => ({});
  const trust = options.trust || { lookup: () => null, name: () => null };
  const badProofs = new Map(); // address -> { n, lockedUntil }

  let pairing = null;   // { token, expires, badTries }
  let host = null;      // the laptop app's connection
  let viewer = null;    // the paired phone's connection
  // True while the laptop is waiting to add a new phone (answered to phones that knock on /ping).
  function pairingOpen() { return !!pairing && Date.now() < pairing.expires && !viewer; }

  const viewerPage = fs.readFileSync(path.join(__dirname, 'public', 'viewer.html'));
  // The few scripts the phone page needs (both also run inside the laptop window).
  const scripts = {
    '/transfer.js': fs.readFileSync(path.join(__dirname, 'renderer', 'transfer.js')),
    '/sas.js': fs.readFileSync(path.join(__dirname, 'renderer', 'sas.js')),
  };
  // The two fonts the app uses, for the phone's web page too.
  const fonts = {
    '/fonts/Jost.ttf': fs.readFileSync(path.join(__dirname, 'renderer', 'fonts', 'Jost.ttf')),
    '/fonts/Barlow-Medium.ttf': fs.readFileSync(path.join(__dirname, 'renderer', 'fonts', 'Barlow-Medium.ttf')),
  };

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
          "default-src 'none'; script-src 'self' 'unsafe-inline'; style-src 'unsafe-inline'; font-src 'self'; connect-src ws: wss:; img-src data: blob:; media-src blob:",
      });
      res.end(viewerPage);
      return;
    }
    if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(scripts, url)) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(scripts[url]);
      return;
    }
    if (req.method === 'GET' && Object.prototype.hasOwnProperty.call(fonts, url)) {
      res.writeHead(200, { 'Content-Type': 'font/ttf', 'Cache-Control': 'max-age=86400', 'X-Content-Type-Options': 'nosniff' });
      res.end(fonts[url]);
      return;
    }
    if (req.method === 'GET' && url === '/ping') {
      // The answer to a phone app knocking: who am I, and am I adding new phones right now.
      let i = {}; try { i = info() || {}; } catch (e) {}
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
      res.end(note({ port: server.address().port, name: i.name, hid: i.hid, open: pairingOpen() }));
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
          if (viewer) send(ws, { type: 'peer-joined', trusted: !!viewer.deviceId, deviceId: viewer.deviceId || null, name: viewer.deviceName || '' });
          return;
        }

        if (msg.role === 'viewer' && typeof msg.deviceId === 'string' && !msg.token) {
          // A phone that was added before: it must answer a fresh challenge with a proof made from its secret.
          const rec = badProofs.get(remote);
          if (rec && rec.lockedUntil > Date.now()) { send(ws, { type: 'error', reason: 'locked' }); ws.close(1008, 'locked'); return; }
          const secret = trust.lookup(msg.deviceId);
          if (!secret) {
            noteBadProof(remote);
            send(ws, { type: 'error', reason: 'unknown-device' }); ws.close(1008, 'unknown-device'); return;
          }
          if (viewer && viewer.deviceId !== msg.deviceId) { send(ws, { type: 'error', reason: 'busy' }); ws.close(1008, 'busy'); return; }   // the same phone may come back: it is checked again after its proof
          const nonce = crypto.randomBytes(16).toString('hex');
          ws.role = 'challenge'; ws.challenge = { deviceId: msg.deviceId, nonce, secret };
          ws.proofTimer = setTimeout(() => { if (ws.role === 'challenge') ws.close(1008, 'proof-timeout'); }, PROOF_TIMEOUT_MS);
          send(ws, { type: 'challenge', nonce });
          return;
        }

        if (msg.role === 'viewer') {
          if (!pairing || Date.now() > pairing.expires) {
            send(ws, { type: 'error', reason: 'expired' }); ws.close(1008, 'expired'); return;
          }
          if (pairing.badTries >= MAX_BAD_TRIES) {
            send(ws, { type: 'error', reason: 'locked' }); ws.close(1008, 'locked'); return;
          }
          // The phone app has no code to type: while "Add new device" is open on the laptop it may say "pair" instead.
          // This is safe because nothing is trusted until the laptop owner compares the 4-digit number and says Yes.
          const appPairing = msg.pair === true && !msg.token;
          if (!appPairing && !safeEqual(msg.token || '', pairing.token)) {
            pairing.badTries += 1;
            events.emit('bad-token', { from: remote, tries: pairing.badTries });
            send(ws, { type: 'error', reason: 'bad-token' }); ws.close(1008, 'bad-token'); return;
          }
          if (viewer) { send(ws, { type: 'error', reason: 'busy' }); ws.close(1008, 'busy'); return; }

          pairing = null;               // the code is now used up
          viewer = ws; ws.role = 'viewer'; ws.remote = remote; ws.deviceId = null; ws.deviceName = cleanName(msg.name);
          send(ws, { type: 'ready', role: 'viewer', trusted: false });
          send(host, { type: 'peer-joined', trusted: false, deviceId: null, name: ws.deviceName });
          events.emit('paired', { from: remote, trusted: false, deviceId: null, name: ws.deviceName });
          return;
        }

        ws.close(1008, 'unknown-role');
        return;
      }

      // ----- a returning phone answering the challenge -----
      if (ws.role === 'challenge') {
        if (msg.type !== 'proof' || typeof msg.mac !== 'string' || typeof msg.cnonce !== 'string' || !/^[0-9a-f]{16,64}$/.test(msg.cnonce)) { ws.close(1008, 'proof-required'); return; }
        clearTimeout(ws.proofTimer);
        const c = ws.challenge; ws.challenge = null;
        if (!safeEqual(msg.mac, proofFor(c.secret, c.nonce))) {
          noteBadProof(remote);
          send(ws, { type: 'error', reason: 'bad-proof' }); ws.close(1008, 'bad-proof'); return;
        }
        if (viewer && viewer.deviceId === c.deviceId) {
          // The same trusted phone is back before the laptop noticed the old link died: the old link is replaced, not refused.
          const old = viewer; viewer = null;
          send(host, { type: 'peer-left' }); events.emit('unpaired');
          try { old.terminate(); } catch (e) {}
        }
        if (viewer) { send(ws, { type: 'error', reason: 'busy' }); ws.close(1008, 'busy'); return; }
        badProofs.delete(remote);
        viewer = ws; ws.role = 'viewer'; ws.remote = remote; ws.deviceId = c.deviceId; ws.deviceName = trust.name(c.deviceId) || '';
        send(ws, { type: 'ready', role: 'viewer', trusted: true, hostProof: hostProofFor(c.secret, msg.cnonce) });
        send(host, { type: 'peer-joined', trusted: true, deviceId: ws.deviceId, name: ws.deviceName });
        events.emit('paired', { from: remote, trusted: true, deviceId: ws.deviceId, name: ws.deviceName });
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
      clearTimeout(helloTimer); clearTimeout(ws.proofTimer);
      if (ws === host) host = null;
      if (ws === viewer) {
        viewer = null;
        send(host, { type: 'peer-left' });
        events.emit('unpaired');
      }
    });
    ws.on('error', () => {});
  });

  function noteBadProof(addr) {
    const r = badProofs.get(addr) || { n: 0, lockedUntil: 0 };
    r.n += 1;
    if (r.n >= MAX_BAD_PROOFS) { r.lockedUntil = Date.now() + PROOF_LOCK_MS; r.n = 0; }
    badProofs.set(addr, r);
  }

  // Drop connections that stopped answering.
  const heartbeat = setInterval(() => {
    wss.clients.forEach((c) => {
      // A busy phone or a slow hotspot may miss a beat: only give up after three in a row (about 45 seconds).
      if (c.isAlive) c.missed = 0; else c.missed = (c.missed || 0) + 1;
      if (c.missed >= 3) { c.terminate(); return; }
      c.isAlive = false;
      try { c.ping(); } catch (e) {}
    });
  }, options.heartbeatMs || 15000);
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

      // Disconnects the phone (used by the Disconnect button).
      function disconnect() { if (viewer) viewer.close(1000, 'host-disconnect'); }

      function close() {
        clearInterval(heartbeat);
        wss.clients.forEach((c) => c.terminate());
        return new Promise((r) => server.close(() => r()));
      }

      resolve({ port: actualPort, hostKey, events, newPairing, pairingOpen, disconnect, close });
    });
  });
}

module.exports = { start, isPrivate, isLoopback, privateIPv4s, proofFor, hostProofFor, sdpMacFor };

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
