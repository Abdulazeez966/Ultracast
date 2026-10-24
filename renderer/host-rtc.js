/*
  UltraCast laptop-side video link (step 2)

  Runs inside the laptop app's window. It:
    1. Talks to the local server (the front desk) as the "host".
    2. When a phone is paired AND the screen is being shared, starts a WebRTC call to the phone.
    3. Every 2 seconds checks how healthy the link is and, if needed, turns the picture quality
       up or down so it never stutters.

  It is plain browser JavaScript, and the quality rules at the top can also be loaded by Node for tests.
*/
(function (root) {
  'use strict';

  // ---------- quality ladder ----------
  // "min" is how much bandwidth the link must have for this rung. Higher index = lower quality.
  var TIERS = [
    { name: 'Excellent', min: 6e6,   bitrate: 8e6,   scale: 1,   fps: 60 },
    { name: 'Good',      min: 3e6,   bitrate: 4.5e6, scale: 1,   fps: 30 },
    { name: 'Fair',      min: 1.5e6, bitrate: 2.2e6, scale: 1.5, fps: 30 },
    { name: 'Weak',      min: 6e5,   bitrate: 1e6,   scale: 2,   fps: 24 },
    { name: 'Poor',      min: 0,     bitrate: 4e5,   scale: 3,   fps: 15 }
  ];

  function pickTier(avail) {
    for (var i = 0; i < TIERS.length; i++) if (avail >= TIERS[i].min) return i;
    return TIERS.length - 1;
  }

  // Decides the next rung. Drops fast (2 bad readings in a row), climbs slowly (4 good readings, one rung at a time).
  function step(state, avail) {
    var want = pickTier(avail);
    if (want === state.idx) return { idx: state.idx, want: want, count: 0 };
    var worse = want > state.idx;
    var need = worse ? 2 : 4;
    var count = want === state.want ? state.count + 1 : 1;
    if (count >= need) return { idx: worse ? want : state.idx - 1, want: want, count: 0 };
    return { idx: state.idx, want: want, count: count };
  }

  // ---------- the host ----------
  function createHost(opts) {
    var ws = null, pc = null, stream = null, peer = false, timer = null, ch = null, fch = null;
    var gov = { idx: 1, want: 1, count: 0 };
    var ema = 0, lastBytes = 0, lastT = 0, ticks = 0;
    var chain = Promise.resolve();

    function status(o) { try { if (opts.onStatus) opts.onStatus(o); } catch (e) {} }
    function sendWs(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

    function connect() {
      ws = new WebSocket(opts.wsUrl);
      ws.onopen = function () { ws.send(JSON.stringify({ type: 'hello', role: 'host', hostKey: opts.hostKey })); };
      ws.onmessage = function (e) {
        var m; try { m = JSON.parse(e.data); } catch (x) { return; }
        handle(m);
      };
      ws.onclose = function () { status({ kind: 'server', up: false }); closeCall(false); };
    }

    function handle(m) {
      if (m.type === 'ready') status({ kind: 'server', up: true });
      else if (m.type === 'error') status({ kind: 'error', reason: m.reason });
      else if (m.type === 'peer-joined') { peer = true; status({ kind: 'peer', present: true }); if (stream) startCall(); }
      else if (m.type === 'peer-left') { peer = false; status({ kind: 'peer', present: false }); closeCall(false); }
      else if (m.type === 'signal') {
        chain = chain.then(function () { return onSignal(m.data); })
          .catch(function (err) { status({ kind: 'error', reason: String((err && err.message) || err) }); });
      }
    }

    async function onSignal(d) {
      if (!pc || !d) return;
      if (d.sdp) { await pc.setRemoteDescription(d.sdp); await applyTier(); }
      else if (d.candidate) { try { await pc.addIceCandidate(d.candidate); } catch (e) {} }
    }

    async function startCall() {
      closeCall(false);
      var thisPc = new RTCPeerConnection({ iceServers: [] }); // no internet helpers: both devices share a local network
      pc = thisPc;
      thisPc.onicecandidate = function (e) { if (e.candidate) sendWs({ type: 'signal', data: { candidate: e.candidate } }); };
      thisPc.onconnectionstatechange = function () { status({ kind: 'link', state: thisPc.connectionState }); };
      // A second lane on the same call, just for the phone's touches and typing (step 3).
      var lane = thisPc.createDataChannel('input', { ordered: true });
      ch = lane;
      lane.onopen = function () { status({ kind: 'input', open: true }); };
      lane.onclose = function () { status({ kind: 'input', open: false }); };
      lane.onmessage = function (e) {
        if (typeof e.data !== 'string' || e.data.length > 1024) return; // oversized messages are dropped
        var m; try { m = JSON.parse(e.data); } catch (x) { return; }
        if (m && typeof m === 'object' && opts.onInput) { try { opts.onInput(m); } catch (err) {} }
      };
      // A third lane, just for files (step 4). Binary crates arrive as ArrayBuffers.
      var fl = thisPc.createDataChannel('files', { ordered: true });
      fch = fl; fl.binaryType = 'arraybuffer'; fl.bufferedAmountLowThreshold = 1024 * 1024;
      fl.onopen = function () { status({ kind: 'files', open: true }); };
      fl.onclose = function () { status({ kind: 'files', open: false }); };
      fl.onmessage = function (e) {
        var d = e.data;
        if (typeof d === 'string' ? d.length > 2048 : (!d || d.byteLength > 65536)) return; // oversized: dropped
        if (opts.onFile) { try { opts.onFile(d); } catch (err) {} }
      };
      stream.getTracks().forEach(function (t) {
        if (t.kind === 'video') { try { t.contentHint = 'detail'; } catch (e) {} } // text and UI stay sharp
        thisPc.addTrack(t, stream);
      });
      gov = { idx: 1, want: 1, count: 0 }; ema = 0; lastBytes = 0; lastT = 0; ticks = 0;
      var offer = await thisPc.createOffer();
      await thisPc.setLocalDescription(offer);
      sendWs({ type: 'signal', data: { sdp: thisPc.localDescription } });
      timer = setInterval(tick, 2000);
    }

    function closeCall(tellPhone) {
      if (timer) { clearInterval(timer); timer = null; }
      if (ch) { try { ch.close(); } catch (e) {} ch = null; }
      if (fch) { try { fch.close(); } catch (e) {} fch = null; }
      if (pc) { try { pc.close(); } catch (e) {} pc = null; }
      if (tellPhone) sendWs({ type: 'signal', data: { bye: true } });
    }

    async function applyTier() {
      if (!pc) return;
      var s = pc.getSenders().filter(function (x) { return x.track && x.track.kind === 'video'; })[0];
      if (!s) return;
      var t = TIERS[gov.idx];
      var p = s.getParameters();
      if (!p.encodings || !p.encodings.length) p.encodings = [{}];
      p.encodings[0].maxBitrate = t.bitrate;
      p.encodings[0].scaleResolutionDownBy = t.scale;
      p.encodings[0].maxFramerate = t.fps;
      try { await s.setParameters(p); } catch (e) {}
    }

    async function tick() {
      if (!pc) return;
      var stats;
      try { stats = await pc.getStats(); } catch (e) { return; }
      var pair = null, out = null;
      stats.forEach(function (r) {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.nominated || r.selected)) pair = r;
        if (r.type === 'outbound-rtp' && r.kind === 'video') out = r;
      });
      var avail = (pair && pair.availableOutgoingBitrate) || 0;
      var rtt = pair && pair.currentRoundTripTime ? pair.currentRoundTripTime * 1000 : null;
      var mbps = 0;
      if (out) {
        if (lastT && out.timestamp > lastT) mbps = (out.bytesSent - lastBytes) * 8 / ((out.timestamp - lastT) / 1000) / 1e6;
        lastBytes = out.bytesSent; lastT = out.timestamp;
      }
      ticks++;
      if (avail) {
        ema = ema ? ema * 0.6 + avail * 0.4 : avail;
        if (ticks > 3) { // the first 6 seconds are a warm-up while the link measures itself
          var next = step(gov, ema);
          var changed = next.idx !== gov.idx;
          gov = next;
          if (changed) await applyTier();
        }
      }
      status({
        kind: 'stats', mbps: mbps, availMbps: ema / 1e6, rttMs: rtt, tier: TIERS[gov.idx].name,
        fps: out && out.framesPerSecond, width: out && out.frameWidth, height: out && out.frameHeight
      });
    }

    async function startShare() {
      stream = await opts.getStream();
      var v = stream.getVideoTracks()[0];
      if (v) v.addEventListener('ended', stopShare);
      status({ kind: 'share', on: true, audio: stream.getAudioTracks().length > 0 });
      if (peer) await startCall();
    }
    function stopShare() {
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
      closeCall(true);
      status({ kind: 'share', on: false });
    }
    function close() { stopShare(); if (ws) ws.close(); }

    // Sends one message on the files lane and, if the lane is getting full, waits until it has room.
    function fileSend(d) {
      var lane = fch;
      if (!lane || lane.readyState !== 'open') return Promise.reject(new Error('files lane is closed'));
      lane.send(d);
      if (lane.bufferedAmount <= 1024 * 1024) return Promise.resolve();
      return new Promise(function (res, rej) {
        lane.onbufferedamountlow = function () { lane.onbufferedamountlow = null; res(); };
        var prev = lane.onclose;
        lane.onclose = function () { if (prev) prev(); rej(new Error('closed')); };
      });
    }

    function send(obj) { if (ch && ch.readyState === 'open') ch.send(JSON.stringify(obj)); }

    connect();
    return { startShare: startShare, stopShare: stopShare, close: close, send: send, fileSend: fileSend };
  }

  var api = { createHost: createHost, pickTier: pickTier, step: step, TIERS: TIERS };
  root.UltraHost = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
