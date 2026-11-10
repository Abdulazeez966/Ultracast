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

  // The phone can force a quality instead of "auto": low = Weak, med = Good, high = Excellent (index into TIERS).
  var FORCED = { low: 3, med: 1, high: 0 };
  function forcedIndex(q) { return Object.prototype.hasOwnProperty.call(FORCED, q) ? FORCED[q] : null; }

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
    var ws = null, pc = null, stream = null, peer = false, timer = null, ch = null, fch = null, pch = null;
    var pcB = null, bch = null, bStream = null, bAudio = null; // call B: the phone's screen coming to the laptop
    var gov = { idx: 1, want: 1, count: 0 };
    var forced = null, forcedApplied = false; // forced = a rung chosen on the phone, null = auto
    var ema = 0, lastBytes = 0, lastT = 0, ticks = 0;
    var chain = Promise.resolve();

    function trace(t) { try { if (opts.trace) opts.trace(t); } catch (e) {} }
    function status(o) { try { if (opts.onStatus) opts.onStatus(o); } catch (e) {} }
    function sendWs(o) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(o)); }

    function connect() {
      ws = new WebSocket(opts.wsUrl);
      ws.onopen = function () { ws.send(JSON.stringify({ type: 'hello', role: 'host', hostKey: opts.hostKey })); };
      ws.onmessage = function (e) {
        var m; try { m = JSON.parse(e.data); } catch (x) { return; }
        handle(m);
      };
      ws.onclose = function () { status({ kind: 'server', up: false }); closeCall(false); closeB(); };
    }

    function handle(m) {
      if (m.type === 'ready') status({ kind: 'server', up: true });
      else if (m.type === 'error') status({ kind: 'error', reason: m.reason });
      else if (m.type === 'peer-joined') {
        peer = true; peerTrusted = !!m.trusted; closeB();
        status({ kind: 'peer', present: true, trusted: !!m.trusted, deviceId: m.deviceId || null, name: m.name || '' });
        if (!m.trusted) startCall(true);   // a new phone: first a small private call just to show the matching number
        else if (stream) startCall();
      }
      else if (m.type === 'peer-left') { peer = false; peerTrusted = false; status({ kind: 'peer', present: false }); closeCall(false); closeB(); }
      else if (m.type === 'signal') {
        chain = chain.then(function () { return onSignal(m.data); })
          .catch(function (err) { status({ kind: 'error', reason: String((err && err.message) || err) }); });
      }
    }

    // A trusted phone signs every call description with its secret and we sign ours, so nobody in between on the hotspot
    // can swap in their own encryption keys. A description without a good signature is ignored.
    var peerTrusted = false;
    async function acceptSdp(d) {
      if (!peerTrusted || !opts.verifySdp) return true;
      var o = d && d.sdp;
      if (!o || typeof o.sdp !== 'string' || typeof o.type !== 'string' || typeof d.mac !== 'string') return false;
      try { return !!(await opts.verifySdp(o.type, o.sdp, d.mac)); } catch (e) { return false; }
    }
    async function sendSdp(extra, ld) {
      var data = {}; for (var k in extra) data[k] = extra[k];
      data.sdp = { type: ld.type, sdp: ld.sdp };
      if (peerTrusted && opts.signSdp) {
        var mac = null; try { mac = await opts.signSdp(ld.type, ld.sdp); } catch (e) {}
        if (!mac) { status({ kind: 'error', reason: 'Could not sign the call, so it was not started.' }); return false; }
        data.mac = mac;
      }
      sendWs({ type: 'signal', data: data });
      return true;
    }
    function setTrusted(on) { peerTrusted = !!on; }

    async function onSignal(d) {
      if (!d || typeof d !== 'object') return;
      if (d.call === 'b') { await onSignalB(d); return; }        // the phone's own screen call
      if (typeof d.ctl === 'string') { onCtl(d.ctl); return; }    // "share-denied" / "share-stopped"
      if (!pc) return;
      if (d.sdp) {
        if (!(await acceptSdp(d))) { status({ kind: 'error', reason: 'The phone sent a call that was not signed, so UltraCast ignored it. Update the phone app.' }); return; }
        await pc.setRemoteDescription(d.sdp); if (!pch) await applyTier();
      }
      else if (d.candidate) { try { await pc.addIceCandidate(d.candidate); } catch (e) {} }
    }

    // pairMode: a tiny call with one lane ("pair") and no picture, used only to get the matching number.
    async function startCall(pairMode) {
      closeCall(false);
      var thisPc = new RTCPeerConnection({ iceServers: [] }); // no internet helpers: both devices share a local network
      pc = thisPc;
      thisPc.onicecandidate = function (e) { if (e.candidate) sendWs({ type: 'signal', data: { candidate: e.candidate } }); };
      thisPc.onconnectionstatechange = function () { status({ kind: 'link', state: thisPc.connectionState, pair: !!pairMode }); };
      if (pairMode) {
        var pl = thisPc.createDataChannel('pair', { ordered: true });
        pch = pl;
        pl.onopen = function () {
          var code = null;
          try { code = root.UltraSas.sas(thisPc.localDescription.sdp, thisPc.remoteDescription.sdp); } catch (e) {}
          status({ kind: 'sas', code: code });
        };
        pl.onmessage = function (e) {
          if (typeof e.data !== 'string' || e.data.length > 1024) return;
          var m; try { m = JSON.parse(e.data); } catch (x) { return; }
          if (m && typeof m === 'object' && opts.onPair) { try { opts.onPair(m); } catch (err) {} }
        };
        var pOffer = await thisPc.createOffer();
        await thisPc.setLocalDescription(pOffer);
        sendWs({ type: 'signal', data: { sdp: thisPc.localDescription } });
        return;
      }
      // A second lane on the same call, just for the phone's touches and typing (step 3).
      var lane = thisPc.createDataChannel('input', { ordered: true });
      ch = lane;
      lane.onopen = function () { status({ kind: 'input', open: true }); };
      lane.onclose = function () { status({ kind: 'input', open: false }); };
      lane.onmessage = function (e) {
        if (typeof e.data !== 'string' || e.data.length > 16384) return; // oversized messages are dropped
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
      gov = forced === null ? { idx: 1, want: 1, count: 0 } : { idx: forced, want: forced, count: 0 };
      forcedApplied = false; ema = 0; lastBytes = 0; lastT = 0; ticks = 0;
      var offer = await thisPc.createOffer();
      await thisPc.setLocalDescription(offer);
      if (!(await sendSdp({}, thisPc.localDescription))) return;
      timer = setInterval(tick, 2000);
    }

    function closeCall(tellPhone) {
      if (timer) { clearInterval(timer); timer = null; }
      if (ch) { try { ch.close(); } catch (e) {} ch = null; }
      if (fch) { try { fch.close(); } catch (e) {} fch = null; }
      if (pch) { try { pch.close(); } catch (e) {} pch = null; }
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

    // The phone chose a quality: 'auto', 'low', 'med' or 'high'. Anything else is ignored.
    function setQuality(q) {
      if (q !== 'auto' && forcedIndex(q) === null) return;
      forced = forcedIndex(q);
      gov = forced === null ? { idx: 1, want: 1, count: 0 } : { idx: forced, want: forced, count: 0 };
      forcedApplied = true;
      applyTier();
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
      if (forced !== null && !forcedApplied) { forcedApplied = true; await applyTier(); }
      if (avail) {
        ema = ema ? ema * 0.6 + avail * 0.4 : avail;
        if (forced === null && ticks > 3) { // the first 6 seconds are a warm-up while the link measures itself
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


    // ---------- call B: the phone's screen on the laptop (see PHONE-SCREEN-PROTOCOL.md) ----------
    var MAX_SDP = 60000;
    function allowedB() { return !!peer && !!opts.isAuthorized && !!opts.isAuthorized(); }

    function closeB() {
      var had = !!pcB || !!bStream;
      if (bch) { try { bch.close(); } catch (e) {} bch = null; }
      if (bAudio) { try { bAudio.close(); } catch (e) {} bAudio = null; }
      if (pcB) { try { pcB.close(); } catch (e) {} pcB = null; }
      bStream = null;
      if (had) {
        try { if (opts.onPhoneScreen) opts.onPhoneScreen(null); } catch (e) {}
        status({ kind: 'phone-share', state: 'closed' });
      }
    }

    function onCtl(c) {
      trace('Phone said: ' + c + (allowedB() ? '' : ' (ignored: no approved phone)'));
      if (!allowedB()) return;
      if (c === 'share-denied') {
        status({ kind: 'phone-share', state: 'denied' });
        try { if (opts.onShareDenied) opts.onShareDenied(); } catch (e) {}
      } else if (c === 'share-stopped') {
        closeB();
        status({ kind: 'phone-share', state: 'stopped' });
      }
    }

    async function onSignalB(d) {
      if (!allowedB()) { if (d.sdp) trace('Phone screen call arrived but was ignored: no approved phone'); return; } // only a trusted phone may use call B
      if (d.sdp) {
        var o = d.sdp;
        trace('Phone screen offer arrived (' + (o && typeof o.sdp === 'string' ? o.sdp.length : '?') + ' characters, ' + (typeof d.mac === 'string' ? 'signed' : 'NOT signed') + ', phone trusted: ' + peerTrusted + ')');
        if (!o || o.type !== 'offer' || typeof o.sdp !== 'string' || o.sdp.length > MAX_SDP) { trace('Offer ignored: wrong type or too big'); return; }
        if (!(await acceptSdp(d))) {
          trace('Offer ignored: its signature did not match'); status({ kind: 'error', reason: 'The phone sent a screen call that was not signed, so UltraCast ignored it. Update the phone app.' }); return; }
        closeB();
        var thisB = new RTCPeerConnection({ iceServers: [] });
        pcB = thisB;
        thisB.onicecandidate = function (e) { if (e.candidate) sendWs({ type: 'signal', data: { call: 'b', candidate: e.candidate } }); };
        thisB.ontrack = function (e) {
          if (pcB !== thisB || e.track.kind !== 'video') return;
          trace('Phone picture arrived');
          bStream = (e.streams && e.streams[0]) || new MediaStream([e.track]);
          try { if (opts.onPhoneScreen) opts.onPhoneScreen(bStream); } catch (err) {}
          status({ kind: 'phone-share', state: 'live' });
        };
        thisB.ondatachannel = function (e) {
          if (pcB === thisB && e.channel.label === 'paudio' && !bAudio) {   // the phone's sound: small binary chunks
            var al = e.channel; bAudio = al; al.binaryType = 'arraybuffer';
            al.onclose = function () { if (bAudio === al) bAudio = null; };
            al.onmessage = function (ev) {
              if (!(ev.data instanceof ArrayBuffer) || ev.data.byteLength > 8192) return;
              if (opts.onPhoneAudio) { try { opts.onPhoneAudio(ev.data); } catch (err) {} }
            };
            return;
          }
          if (pcB !== thisB || e.channel.label !== 'pctl' || bch) return; // only the lanes we expect
          var lane = e.channel; bch = lane;
          lane.onopen = function () { trace('Control lane open'); status({ kind: 'pctl', open: true }); };
          lane.onclose = function () { if (bch === lane) bch = null; status({ kind: 'pctl', open: false }); };
          lane.onmessage = function (ev) {
            if (typeof ev.data !== 'string' || ev.data.length > 1024) return;
            var m; try { m = JSON.parse(ev.data); } catch (x) { return; }
            if (!m || typeof m !== 'object' || Array.isArray(m) || typeof m.t !== 'string') return;
            if (m.t === 'hello') {
              // keep only what we need, with sane limits
              var w = Number(m.w), h = Number(m.h);
              m = { t: 'hello', w: isFinite(w) && w > 0 && w < 20000 ? Math.round(w) : 0, h: isFinite(h) && h > 0 && h < 20000 ? Math.round(h) : 0, ctl: m.ctl === true, rot: m.rot === true, snd: m.snd === true };
            } else return;
            if (opts.onPctl) { try { opts.onPctl(m); } catch (err) {} }
          };
        };
        thisB.onconnectionstatechange = function () {
          if (pcB !== thisB) return;
          trace('Screen link: ' + thisB.connectionState);
          if (thisB.connectionState === 'failed' || thisB.connectionState === 'closed') closeB();
        };
        await thisB.setRemoteDescription(o);
        var ans = await thisB.createAnswer();
        await thisB.setLocalDescription(ans);
        var sent = await sendSdp({ call: 'b' }, thisB.localDescription);
        trace(sent ? 'Answer sent to the phone' : 'Answer NOT sent (could not sign)');
      } else if (d.candidate) {
        if (pcB) { try { await pcB.addIceCandidate(d.candidate); } catch (e) {} }
      }
    }

    // Ask the phone to share its screen. The phone's owner has to press Allow there first.
    function requestPhoneShare() {
      if (!allowedB()) { trace('Asked the phone to share, but no trusted, approved phone is connected'); return false; }
      trace('Asked the phone to share its screen');
      sendWs({ type: 'signal', data: { ctl: 'share-request' } });
      status({ kind: 'phone-share', state: 'requested' });
      return true;
    }
    function stopPhoneShare() {
      if (peer) sendWs({ type: 'signal', data: { ctl: 'share-stop' } });
      closeB();
      status({ kind: 'phone-share', state: 'stopped' });
    }
    // Sends one control message to the phone (tap, long, swipe, nav, text, key). Returns false if it could not be sent.
    function sendPctl(obj) {
      if (!allowedB() || !bch || bch.readyState !== 'open' || !obj || typeof obj !== 'object') return false;
      var txt = JSON.stringify(obj);
      if (txt.length > 1024) return false;
      bch.send(txt);
      return true;
    }

    async function startShare() {
      stream = await opts.getStream();
      var v = stream.getVideoTracks()[0];
      if (v) v.addEventListener('ended', stopShare);
      status({ kind: 'share', on: true, audio: stream.getAudioTracks().length > 0 });
      if (peer && !pch) await startCall(); // while the matching-number step is open, the real call waits
    }
    function stopShare() {
      if (stream) { stream.getTracks().forEach(function (t) { t.stop(); }); stream = null; }
      closeCall(true);
      status({ kind: 'share', on: false });
    }
    function close() { stopShare(); closeB(); if (ws) ws.close(); }

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

    // Sends one message on the pairing lane (only exists during the matching-number step).
    function sendPair(obj) { if (pch && pch.readyState === 'open') pch.send(JSON.stringify(obj)); }
    // Pairing is finished: drop the small call; if the screen is already being shared, start the real call.
    function endPair() { if (!pch) return; closeCall(false); if (stream && peer) startCall(); }

    function send(obj) { if (ch && ch.readyState === 'open') ch.send(JSON.stringify(obj)); }

    connect();
    return { startShare: startShare, stopShare: stopShare, close: close, send: send, fileSend: fileSend, sendPair: sendPair, endPair: endPair,
      requestPhoneShare: requestPhoneShare, stopPhoneShare: stopPhoneShare, sendPctl: sendPctl, setQuality: setQuality, setTrusted: setTrusted };
  }

  var api = { createHost: createHost, pickTier: pickTier, step: step, TIERS: TIERS, forcedIndex: forcedIndex };
  root.UltraHost = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
