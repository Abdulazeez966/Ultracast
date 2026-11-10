'use strict';
// Glue between the laptop window and the video link (host-rtc.js). Pages: Home, Devices, Control, Settings.
(async function () {
  var $ = function (id) { return document.getElementById(id); };
  var info = await window.ultracast.info();
  var sharing = false, expiresAt = 0;
  var wantShare = false;                       // the owner chose to share the screen (kept across a dropped link)
  var lastDrop = { id: null, at: 0 };          // which trusted phone's link just dropped, and when
  var peer = { present: false, trusted: false, name: '', deviceId: null };
  var authorized = false;          // the phone is trusted and may use the control page
  var sheetOpen = false, confirming = false;
  var ring = UltraRing.create($('ring'));
  var host;

  // ---------- small helpers ----------
  function toast(text) {
    var t = $('toast'); t.textContent = text; t.hidden = false;
    clearTimeout(toast.t); toast.t = setTimeout(function () { t.hidden = true; }, 3500);
  }
  function mk(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  function showView(name) {
    ['home', 'devices', 'control', 'settings', 'screen'].forEach(function (v) { $('v-' + v).hidden = v !== name; });
    document.body.classList.toggle('screenmode', name === 'screen');
    if (name !== 'screen' && typeof leaveScreenPage === 'function') leaveScreenPage();
    document.querySelectorAll('.nav').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-view') === name || (name === 'screen' && b.getAttribute('data-view') === 'control')); });
    if (name === 'control') ring.start(); else ring.stop();
    if (name === 'devices') refreshDevices();
  }
  document.querySelectorAll('.nav').forEach(function (b) { b.addEventListener('click', function () { showView(b.getAttribute('data-view')); }); });

  // ---------- theme ----------
  var mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  var themeChoice = 'dark';
  function applyTheme() {
    var t = themeChoice === 'system' ? (mq && mq.matches ? 'dark' : 'light') : themeChoice;
    document.documentElement.setAttribute('data-theme', t);
  }
  if (mq && mq.addEventListener) mq.addEventListener('change', applyTheme);

  // ---------- the Add new device sheet ----------
  function stepState(id, st, tag) {
    var el = $(id); el.className = 'step' + (st ? ' ' + st : '');
    el.querySelector('.tag').textContent = tag || '';
  }
  function setDigits(code) {
    var box = $('sas'); box.innerHTML = '';
    String(code || '----').split('').forEach(function (c) { box.appendChild(mk('span', '', c)); });
  }
  async function refreshSteps() {
    var addrs = []; try { addrs = await window.ultracast.addresses(); } catch (e) {}
    stepState('st-hotspot', addrs.length ? 'done' : 'now', addrs.length ? '' : 'Join your phone\'s hotspot');
    stepState('st-ready', 'done');
  }
  // The pairing code (QR): where this laptop is, and nothing secret. The phone still has to be confirmed by the matching number.
  async function renderQr() {
    var img = $('qr'); img.hidden = true;
    try {
      var info = await window.ultracast.info(); var addrs = await window.ultracast.addresses();
      var hosts = addrs.map(function (a) { try { return new URL(a.url).hostname; } catch (e) { return ''; } }).filter(Boolean);
      if (!hosts.length || !info || typeof qrcode !== 'function') return;
      var text = 'ultracast://pair?a=' + hosts.join(',') + '&p=' + info.port + '&n=' + encodeURIComponent(info.name || 'Laptop');
      var q = qrcode(0, 'M'); q.addData(text); q.make();
      img.src = q.createDataURL(5, 2); img.hidden = false;
    } catch (e) { img.hidden = true; }
  }
  async function openSheet(phoneAlreadyHere) {
    sheetOpen = true; confirming = false;
    $('modal').hidden = false;
    $('st-code-body').hidden = true; $('st-phone-help').hidden = false;
    stepState('st-phone', 'now', 'Waiting'); stepState('st-code', ''); stepState('st-secure', '');
    $('st-phone-text').textContent = 'Waiting for your phone';
    $('sas-yes').disabled = false; $('sas-no').disabled = false;
    await refreshSteps();
    renderQr();
    if (phoneAlreadyHere !== true) await newCode();   // a new code would disconnect a phone that is already here
  }
  function closeSheet(disconnectPhone) {
    sheetOpen = false; $('modal').hidden = true;
    if (disconnectPhone && peer.present && !authorized) window.ultracast.disconnect();
  }
  function showCode(code) {
    $('st-phone-help').hidden = true; $('st-code-body').hidden = false;
    stepState('st-phone', 'done', peer.name || ''); $('st-phone-text').textContent = 'Phone found: ' + (peer.name || 'Phone');
    stepState('st-code', 'now', 'Compare');
    setDigits(code);
  }
  $('add-device').addEventListener('click', function () { openSheet(); });
  $('home-start').addEventListener('click', function () { showView('devices'); });
  $('m-close').addEventListener('click', function () { closeSheet(true); });
  $('sas-no').addEventListener('click', function () {
    if (confirming) return;
    try { host.sendPair({ t: 'rejected' }); } catch (e) {}
    setTimeout(function () { window.ultracast.disconnect(); }, 150);
    closeSheet(false); toast('Not added. If the numbers did not match, someone may be in between. Try again.');
  });
  $('sas-yes').addEventListener('click', async function () {
    if (confirming) return;
    confirming = true; $('sas-yes').disabled = true; $('sas-no').disabled = true;
    stepState('st-code', 'done'); stepState('st-secure', 'now', 'Working');
    var rec = null; try { rec = await window.ultracast.trustDevice(peer.name); } catch (e) {}
    if (!rec) { stepState('st-secure', 'now', 'Failed'); toast('Could not add this phone.'); window.ultracast.disconnect(); closeSheet(false); return; }
    authorized = true; updateShare();
    host.setTrusted(true);   // from now on both sides sign their call descriptions with the new key
    host.sendPair({ t: 'trusted', id: rec.id, secret: rec.secret });
    clearTimeout(openSheet.t);
    openSheet.t = setTimeout(function () {   // the phone never confirmed it saved the key
      if (!sheetOpen) return;
      window.ultracast.removeDevice(rec.id); authorized = false; window.ultracast.disconnect();
      closeSheet(false); toast('The phone did not finish. Nothing was added.');
    }, 6000);
    peer.deviceId = rec.id; peer.name = rec.name;
  });

  // ---------- messages from the phone on the pairing lane ----------
  function onPair(m) {
    if (m.t === 'stored' && authorized && sheetOpen) {
      clearTimeout(openSheet.t);
      stepState('st-secure', 'done');
      host.endPair();
      setTimeout(function () { closeSheet(false); enterControl(); refreshDevices(); toast('Added to Devices'); }, 500);
    }
  }

  // ---------- control page ----------
  function updateShare() { $('share').disabled = !(peer.present && authorized); if (typeof ph !== 'undefined' && ph && phStage) phoneRefresh(); }
  function enterControl() {
    updateShare();
    $('ctl-name').textContent = peer.name || 'Phone';
    $('ctl-sub').textContent = 'Connected over your hotspot';
    showView('control');
  }
  function leaveControl() { ring.set({ mbps: 0, active: false }); }
  $('ctl-back').hidden = true;   // Control is a page of its own now, reached from the menu on the left
  $('disconnect').addEventListener('click', function () { window.ultracast.disconnect(); });
  $('share').addEventListener('click', async function () {
    $('err').textContent = '';
    wantShare = !sharing;
    try { if (sharing) host.stopShare(); else await host.startShare(); }
    catch (e) { $('err').textContent = 'Could not share the screen: ' + (e && e.message ? e.message : e); }
  });
  function resetStats() {
    ring.set({ mbps: 0, active: false });
    $('speed').textContent = '--'; $('quality').textContent = 'Not sharing';
    ['i-delay', 'i-pic', 'i-sound'].forEach(function (i) { $(i).textContent = '-'; });
  }

  async function onInput(m) {
    if (m.t === 'req') {
      var ok = false;
      if (sharing && authorized) { try { ok = await window.ultracast.controlRequest(); } catch (e) {} }
      host.send({ t: ok ? 'grant' : 'deny' });
    } else if (m.t === 'rel') {
      window.ultracast.controlRelease();
    } else if (m.t === 'quality') {
      if (authorized && typeof m.q === 'string') host.setQuality(m.q);   // the phone's Video quality setting
    } else if (m.t === 'clip') {
      if (authorized && clip.on && typeof m.s === 'string' && m.s.length <= 6000) {
        clip.last = m.s;
        var wrote = false; try { wrote = await window.ultracast.clipWrite(m.s); } catch (e) {}
        if (wrote) toast('Copied from the phone. Paste it here.');
      }
    } else if (m.t === 'power-answer') {
      toast(m.ok ? 'The phone is doing it.' : (m.note || 'The phone said no.'));
    } else if (m.t === 'awake-result') {
      toast(m.ok ? 'Done.' : (m.note || 'The phone could not do that.'));
    } else if (m.t === 'rotate-result') {
      toast(m.ok ? 'Phone screen turned.' : (m.note || 'The phone could not turn.'));
    } else if (m.t === 'cover') {
      var cr = { ok: false, reason: 'Not allowed' };
      if (authorized && typeof m.on === 'boolean') { try { cr = await window.ultracast.cover(m.on); } catch (e) {} }
      host.send({ t: 'cover-result', on: !!m.on && !!cr.ok, ok: !!cr.ok, reason: cr.reason || '' });
    } else if (m.t === 'phone-state') {
      phoneLocked(!!m.locked);
    } else if (m.t === 'power') {
      var r = { ok: false, reason: 'Not allowed' };
      if (authorized && typeof m.a === 'string') { try { r = await window.ultracast.power(m.a); } catch (e) {} }
      host.send({ t: 'power-result', a: m.a, ok: !!r.ok, reason: r.reason || '' });
    } else {
      window.ultracast.input(m); // the caretaker only acts on it while control is granted
    }
  }

  var tx = UltraTransfer.create({
    prefix: 'L',
    send: function (d) { return host.fileSend(d); },
    api: {
      offer: function (n, sz) { return window.ultracast.fileOffer(n, sz); },
      chunk: function (b) { window.ultracast.fileChunk(b); },
      end: function () { return window.ultracast.fileEnd(); },
      abort: function () { window.ultracast.fileAbort(); }
    },
    confirmLarge: function (name, size) { return confirm('"' + name + '" is ' + (size / 1073741824).toFixed(1) + ' GB. Send it anyway?'); },
    onChange: renderFiles
  });

  var traceLines = [];
  function ucTrace(t) { var d = new Date(); traceLines.push(d.toTimeString().slice(0, 8) + '.' + String(d.getMilliseconds()).padStart(3, '0') + '  ' + t); if (traceLines.length > 200) traceLines.shift(); }
  host = UltraHost.createHost({
    onInput: onInput,
    onFile: function (d) { if (authorized) tx.onMessage(d); },
    onPair: onPair,
    isAuthorized: function () { return authorized; },
    signSdp: function (t, s) { return window.ultracast.sdpSign(t, s); },
    verifySdp: function (t, s, m) { return window.ultracast.sdpVerify(t, s, m); },
    onPhoneAudio: function (b) { phoneSound(b); },
    trace: function (t) { ucTrace(t); },
    onPhoneScreen: function (st) { phoneScreen(st); },
    onPctl: function (m) { phoneHello(m); },
    wsUrl: 'ws://127.0.0.1:' + info.port + '/ws',
    hostKey: info.hostKey,
    getStream: function () {
      // The caretaker (main.js) decides which screen this gives us: the main one, with sound on Windows.
      return navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 60 }, audio: true });
    },
    onStatus: function (s) {
      if (s.kind === 'server') {
        $('srvdot').className = s.up ? 'dot on' : 'dot';
        $('srvtxt').textContent = s.up ? 'Running on port ' + info.port : 'Server stopped';
        refreshSteps();
      } else if (s.kind === 'peer') {
        var prevPeer = peer;
        peer = { present: !!s.present, trusted: !!s.trusted, name: s.name || '', deviceId: s.deviceId || null };
        $('nav-control').disabled = !s.present;
        $('home-dot').className = s.present ? 'dot on' : 'dot';
        $('home-status').textContent = s.present ? (peer.name || 'A phone') + ' is connected' : 'No phone connected';
        if (!s.present) {
          authorized = false; confirming = false; phoneReset(); setDirection('in');
          window.ultracast.controlRelease(); resetStats(); leaveControl();
          if (prevPeer.present && prevPeer.deviceId && prevPeer.trusted) lastDrop = { id: prevPeer.deviceId, at: Date.now() };
          if (!$('v-control').hidden || !$('v-screen').hidden) { showView('devices'); toast('The phone\'s link dropped. If the phone is still on this hotspot it joins again by itself.'); }
          if (sheetOpen) closeSheet(false);
          refreshDevices();
        } else if (s.trusted) {
          authorized = true; enterControl(); refreshDevices();
          // The same phone is back within three minutes and the screen was being shared: share it again without a tap.
          if (wantShare && lastDrop.id && lastDrop.id === peer.deviceId && Date.now() - lastDrop.at < 180000) {
            lastDrop = { id: null, at: 0 };
            toast('Phone reconnected. Sharing your screen again...');
            setTimeout(function () { if (peer.present && authorized && !sharing) host.startShare().catch(function () { toast('Press Share my screen to start again.'); }); }, 1500);
          }
        } else {
          authorized = false;
          if (!sheetOpen) openSheet(true);      // a new phone used the code: show the matching-number step
          $('st-phone-text').textContent = 'Phone found: ' + (peer.name || 'Phone');
          stepState('st-phone', 'done'); stepState('st-code', 'now', 'Getting the number');
        }
      } else if (s.kind === 'sas') {
        if (sheetOpen && !authorized) showCode(s.code);
      } else if (s.kind === 'share') {
        sharing = s.on;
        $('share').textContent = s.on ? 'Stop sharing' : 'Share my screen';
        $('share').className = s.on ? '' : 'primary';
        if (!s.on) { window.ultracast.controlRelease(); resetStats(); }
        else { $('i-sound').textContent = s.audio ? 'On' : 'Off'; }
      } else if (s.kind === 'files') {
        $('sendfiles').disabled = !s.open;
        if (!s.open) tx.linkDown();
      } else if (s.kind === 'link') {
        if (!s.pair) $('share').disabled = !peer.present || !authorized;
      } else if (s.kind === 'stats') {
        $('speed').textContent = s.mbps.toFixed(1);
        $('quality').textContent = s.tier || 'Auto';
        $('i-delay').textContent = s.rttMs != null ? Math.round(s.rttMs) + ' ms' : '-';
        $('i-pic').textContent = s.width ? s.width + ' x ' + s.height + (s.fps ? ' at ' + Math.round(s.fps) + ' fps' : '') : '-';
        ring.set({ mbps: s.mbps, active: true });
      } else if (s.kind === 'phone-share') {
        phoneState(s.state);
      } else if (s.kind === 'error') {
        $('err').textContent = 'Problem: ' + s.reason;
      }
      updateShare();
    }
  });
  $('share').disabled = true;

  // ---------- this laptop controls the phone (call B) ----------
  var ph = { stream: null, hello: null, state: 'idle', timer: null };
  var phVideo = $('ph-video'), phStage = $('ph-stage');
  var pin = UltraPhoneCtl.create({
    send: function (m) { host.sendPctl(m); },
    enabled: function () { return authorized && !!ph.stream && !!ph.hello && ph.hello.ctl === true; },
    rect: function () {
      var b = phStage.getBoundingClientRect();
      return UltraPhoneCtl.pictureRect(b.width, b.height, phVideo.videoWidth, phVideo.videoHeight);
    }
  });
  function setDirection(d) {
    var out = d === 'out';
    $('dir-in').className = out ? '' : 'on'; $('dir-out').className = out ? 'on' : '';
    $('panel-in').hidden = out; $('panel-out').hidden = !out; $('sess-card').hidden = out;
    if (out) phoneRefresh();
  }
  $('dir-in').addEventListener('click', function () { setDirection('in'); });
  $('dir-out').addEventListener('click', function () { setDirection('out'); });
  $('home-start-out').addEventListener('click', function () {
    if (authorized) { enterControl(); setDirection('out'); } else { showView('devices'); toast('Add or open a phone first, then choose "This laptop controls the phone".'); }
  });
  function phoneRefresh() {
    var live = !!ph.stream, can = live && ph.hello && ph.hello.ctl === true;
    var text;
    if (ph.state === 'requested' && !live) text = 'Waiting for the phone owner to allow it on the phone...';
    else if (ph.state === 'denied') text = 'The phone said no. Press "Ask phone to share" to try again.';
    else if (ph.state === 'stopped' || ph.state === 'closed') text = 'The phone stopped sharing. Press "Ask phone to share" to start again.';
    else if (ph.state === 'timeout') text = 'No answer. Sharing the phone screen needs the UltraCast Android app on the phone.';
    else if (live && !ph.hello) text = 'Connecting to the phone...';
    else if (can) text = 'Controlling ' + (peer.name || 'the phone') + '. Click = tap, hold = long press, drag = swipe, scroll wheel = scroll.';
    else if (live) text = 'Viewing only. Turn on UltraCast accessibility control on the phone to control it from here.';
    else text = 'Ask the phone to share its screen. The phone owner is asked first.';
    $('ph-status').textContent = text;
    $('ph-dot').className = live ? 'dot on' : 'dot';
    phStage.className = 'phstage' + (live ? ' live' : '') + (can ? ' ctl' : '');
    $('ph-hint').textContent = ph.state === 'requested' ? 'Waiting for the phone...' : 'Nothing shared yet';
    $('ph-start').disabled = !authorized || live || ph.state === 'requested';
    $('ph-stop').disabled = !live && ph.state !== 'requested';
    $('ph-open').disabled = !live;
    document.querySelectorAll('#sv-menu [data-act]').forEach(function (b) {
      var a = b.getAttribute('data-act');
      if (a === 'back' || a === 'home' || a === 'recents' || a === 'notifications') b.disabled = !can;
      else if (a === 'rot-land' || a === 'rot-port' || a === 'rot-auto') b.disabled = !(peer.present && authorized) || (ph.hello && ph.hello.rot === false);
      else if (a === 'snd') b.disabled = !(ph.hello && ph.hello.snd);
      else if (a === 'aw-on' || a === 'aw-dark' || a === 'aw-wake' || a === 'aw-off') b.disabled = !(peer.present && authorized);
      else if (a === 'lock' || a === 'power' || a === 'clip') b.disabled = !(peer.present && authorized);
    });
    $('ph-lock').disabled = $('ph-power').disabled = !(peer.present && authorized);
  }
  function phoneState(st) {
    if (st === 'requested') { ph.state = 'requested'; clearTimeout(ph.timer); ph.timer = setTimeout(function () { if (ph.state === 'requested' && !ph.stream) { ph.state = 'timeout'; phoneRefresh(); } }, 60000); }
    else { clearTimeout(ph.timer); if (st === 'closed' && !peer.present) ph.state = 'idle'; else if (st === 'live') ph.state = 'live'; else if (st === 'denied' || st === 'stopped' || st === 'closed') ph.state = st; }
    phoneRefresh();
  }
  function phoneScreen(st) {
    ph.stream = st; if (!st) { ph.hello = null; sndStop(); }
    phVideo.srcObject = st || null;
    if (st) { var p = phVideo.play(); if (p && p.catch) p.catch(function () {}); }
    phoneRefresh();
    if (st && authorized) { setDirection('out'); showView('screen'); }
    else if (!st && !$('v-screen').hidden) { showView('control'); setDirection('out'); }
  }
  function phoneHello(m) { if (m && m.t === 'hello') { ph.hello = m; phoneRefresh(); } }
  function phoneReset() { sndStop(); phoneLocked(false); if (!$('v-screen').hidden) showView('devices'); clearTimeout(ph.timer); pin.cancel(); ph.stream = null; ph.hello = null; ph.state = 'idle'; phVideo.srcObject = null; phoneRefresh(); }
  $('ph-start').addEventListener('click', function () { if (!host.requestPhoneShare()) toast('Connect a trusted phone first.'); });
  $('ph-stop').addEventListener('click', function () { host.stopPhoneShare(); });
  $('ph-open').addEventListener('click', function () { showView('screen'); });
  $('ph-lock').addEventListener('click', function () { phonePower('lock'); });
  $('ph-power').addEventListener('click', function () { phonePower('menu'); });
  function phonePower(a) { if (!(peer.present && authorized)) return; host.send({ t: 'power-ask', a: a }); toast('Asked the phone. Confirm on the phone.'); }
  function phoneLocked(on) { $('ph-locked').hidden = !on; }
  function sendAwake(m) { if (peer.present && authorized) host.send({ t: 'awake', m: m }); }
  function sendRotate(m) { if (peer.present && authorized) host.send({ t: 'rotate', m: m }); }
  function sendClipNow() {
    window.ultracast.clipRead().then(function (t) {
      if (!t) { toast('Nothing to send. Copy some text first (and check that copy and paste is On in Settings).'); return; }
      clip.last = t; toast(clipSend(t) ? 'Clipboard sent to the phone.' : 'That text is too long.');
    });
  }

  // ----- the phone's screen page: menu, full screen, floating -----
  // ----- this phone's sound -----
  var snd = { player: null, on: true };
  function phoneSound(buf) {
    if (!snd.player) { try { snd.player = UltraPcm.create(); snd.player.setOn(snd.on); } catch (e) { return; } }
    snd.player.resume(); snd.player.push(buf);
  }
  function sndStop() { if (snd.player) { snd.player.close(); snd.player = null; } }
  function sndLabel() { $('sv-snd').textContent = 'Phone sound: ' + (snd.on ? 'on' : 'off'); }
  var menuEl = $('sv-menu'), burger = $('sv-burger');
  var isFull = false, isFloat = false;
  function menuOpen(on) { menuEl.hidden = !on; burger.setAttribute('aria-expanded', on ? 'true' : 'false'); if (on) { var f = menuEl.querySelector('button:not(:disabled)'); if (f) f.focus(); } }
  burger.addEventListener('click', function () { menuOpen(menuEl.hidden); });
  document.addEventListener('mousedown', function (e) { if (!menuEl.hidden && !menuEl.contains(e.target) && e.target !== burger && !burger.contains(e.target)) menuOpen(false); });
  function setFull(on) { isFull = on; window.ultracast.fullscreen(on); $('sv-full').textContent = on ? 'Exit full screen' : 'Full screen'; }
  async function setFloat(on) {
    var asp = phVideo.videoWidth > 0 ? phVideo.videoWidth / phVideo.videoHeight : 0.5;
    isFloat = await window.ultracast.float(on, asp);
    $('sv-float').textContent = isFloat ? 'Dock back' : 'Float on top';
  }
  menuEl.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('button[data-act]'); if (!b || b.disabled) return;
    var a = b.getAttribute('data-act'); menuOpen(false);
    if (a === 'back' || a === 'home' || a === 'recents' || a === 'notifications') pin.nav(a);
    else if (a === 'aw-on') sendAwake('on'); else if (a === 'aw-dark') sendAwake('dark'); else if (a === 'aw-wake') sendAwake('wake'); else if (a === 'aw-off') sendAwake('off');
    else if (a === 'rot-land') sendRotate('landscape'); else if (a === 'rot-port') sendRotate('portrait'); else if (a === 'rot-auto') sendRotate('auto');
    else if (a === 'lock') phonePower('lock'); else if (a === 'power') phonePower('menu');
    else if (a === 'clip') sendClipNow();
    else if (a === 'snd') { snd.on = !snd.on; if (snd.player) snd.player.setOn(snd.on); sndLabel(); }
    else if (a === 'full') setFull(!isFull);
    else if (a === 'float') setFloat(!isFloat);
    else if (a === 'stop') { host.stopPhoneShare(); showView('control'); }
    else if (a === 'close') showView('control');
  });
  document.addEventListener('keydown', function (e) {
    if ($('v-screen').hidden) return;
    if (e.key === 'Escape') { if (!menuEl.hidden) menuOpen(false); else if (isFull) setFull(false); }
  });
  function leaveScreenPage() { menuOpen(false); if (isFull) setFull(false); if (isFloat) setFloat(false); }
  window.ultracast.onEvent(function (e) { if (e.type === 'fullscreen') { isFull = e.on; $('sv-full').textContent = e.on ? 'Exit full screen' : 'Full screen'; } });
  phStage.addEventListener('mousedown', function (e) { if (e.button !== 0) return; phStage.focus(); var b = phStage.getBoundingClientRect(); pin.mouseDown(e.clientX - b.left, e.clientY - b.top, performance.now()); e.preventDefault(); });
  document.addEventListener('mousemove', function (e) { var b = phStage.getBoundingClientRect(); pin.mouseMove(e.clientX - b.left, e.clientY - b.top); });
  document.addEventListener('mouseup', function (e) { if (e.button !== 0) return; var b = phStage.getBoundingClientRect(); pin.mouseUp(e.clientX - b.left, e.clientY - b.top, performance.now()); });
  phStage.addEventListener('wheel', function (e) { var b = phStage.getBoundingClientRect(); pin.wheel(e.clientX - b.left, e.clientY - b.top, e.deltaX, e.deltaY); e.preventDefault(); }, { passive: false });
  phStage.addEventListener('contextmenu', function (e) { e.preventDefault(); });
  phStage.addEventListener('keydown', function (e) { if (pin.key(e)) e.preventDefault(); });
  phStage.addEventListener('paste', function (e) { var t = e.clipboardData && e.clipboardData.getData('text'); if (t) pin.typeText(t); e.preventDefault(); });
  phStage.addEventListener('blur', function () { pin.cancel(); });
  phoneRefresh();

  // ---------- one-time address while adding a device ----------
  function renderPairing(p) {
    expiresAt = p.expiresAt;
    var box = $('urls'); box.innerHTML = '';
    if (!p.urls.length) { box.appendChild(mk('p', 'warn', 'No hotspot found yet. Join your phone\'s hotspot, then press New code.')); return; }
    p.urls.forEach(function (u) { box.appendChild(addressRow(u.url, 'Copy')); });
  }
  function addressRow(url, label) {
    var row = mk('div', 'urlrow'); row.appendChild(mk('code', '', url));
    var btn = mk('button', 'small', label); btn.type = 'button';
    btn.addEventListener('click', function () {
      try { navigator.clipboard.writeText(url); btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = label; }, 1500); }
      catch (e) { btn.textContent = 'Select and copy'; }
    });
    row.appendChild(btn); return row;
  }
  async function newCode() { $('alert').textContent = ''; renderPairing(await window.ultracast.newPairing()); }
  $('newcode').addEventListener('click', newCode);
  setInterval(function () {
    var s = Math.max(0, Math.round((expiresAt - Date.now()) / 1000));
    $('left').textContent = Math.floor(s / 60) + ':' + (s % 60 < 10 ? '0' : '') + (s % 60);
  }, 500);
  window.ultracast.onEvent(function (e) {
    if (e.type === 'bad-token') $('alert').textContent = 'Someone tried a wrong code (' + e.tries + ' of 5).';
    if (e.type === 'paired') $('alert').textContent = '';
  });

  // ---------- Devices page ----------
  function ago(ts) {
    if (!ts) return 'Never connected';
    var d = Math.round((Date.now() - ts) / 60000);
    if (d < 1) return 'Just now'; if (d < 60) return d + ' min ago';
    var h = Math.round(d / 60); if (h < 24) return h + ' h ago';
    return Math.round(h / 24) + ' days ago';
  }
  async function refreshDevices() {
    var list = []; try { list = await window.ultracast.devices(); } catch (e) {}
    var box = $('dev-list'); box.innerHTML = '';
    if (!list.length) box.appendChild(mk('p', 'muted', 'No trusted phones yet. Press "Add new device".'));
    list.forEach(function (d) {
      var here = peer.present && peer.deviceId === d.id && authorized;
      var row = mk('div', 'devrow' + (here ? ' near' : ''));
      var ico = mk('div', 'ico', '☎'); row.appendChild(ico);
      var mid = mk('div', 'grow'); mid.appendChild(mk('div', 'nm', d.name));
      mid.appendChild(mk('div', 'when', here ? 'Connected now' : 'Last seen ' + ago(d.lastSeen)));
      row.appendChild(mid);
      if (here) { var o = mk('button', 'primary', 'Open'); o.type = 'button'; o.addEventListener('click', enterControl); row.appendChild(o); }
      var rm = mk('button', 'danger small', 'Remove'); rm.type = 'button';
      rm.addEventListener('click', async function () {
        if (rm.getAttribute('data-sure') !== '1') { rm.setAttribute('data-sure', '1'); rm.textContent = 'Click again to remove'; setTimeout(function () { rm.removeAttribute('data-sure'); rm.textContent = 'Remove'; }, 3000); return; }
        await window.ultracast.removeDevice(d.id);
        if (here) window.ultracast.disconnect();
        toast(d.name + ' removed'); refreshDevices();
      });
      row.appendChild(rm); box.appendChild(row);
    });
    var ab = $('addr-list'); ab.innerHTML = '';
    var addrs = []; try { addrs = await window.ultracast.addresses(); } catch (e) {}
    if (!addrs.length) ab.appendChild(mk('p', 'warn', 'No hotspot found. Join your phone\'s hotspot first.'));
    addrs.forEach(function (a) { ab.appendChild(addressRow(a.url, 'Copy')); });
  }

  // ---------- files ----------
  function fmt(n) { return n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function renderFiles(list) {
    ['xlist', 'hist'].forEach(function (id) {
      var box = $(id); box.innerHTML = '';
      list.slice(0, 8).forEach(function (e) {
        var row = mk('div', 'xrow ' + e.state), top = mk('div', 'xtop');
        top.appendChild(mk('span', 'xname', (e.dir === 'in' ? 'From phone: ' : 'To phone: ') + e.name + ' (' + fmt(e.size) + ')'));
        var live = e.state === 'sending' || e.state === 'receiving' || e.state === 'asking';
        top.appendChild(mk('span', 'xnote', live ? (e.state === 'asking' ? 'Waiting...' : Math.round(e.size ? e.done / e.size * 100 : 100) + '%') : (e.note || e.state) + (e.path ? ' to ' + e.path : '')));
        row.appendChild(top);
        var bar = mk('div', 'bar'), fill = document.createElement('i');
        fill.style.width = (e.size ? Math.min(100, e.done / e.size * 100) : (e.state === 'done' ? 100 : 0)) + '%'; bar.appendChild(fill); row.appendChild(bar);
        if (live && id === 'xlist') { var c = mk('button', 'small', 'Cancel'); c.type = 'button'; c.addEventListener('click', function () { tx.cancel(e.id); }); row.appendChild(c); }
        box.appendChild(row);
      });
    });
  }
  $('sendfiles').addEventListener('click', function () { $('picker').click(); });
  $('picker').addEventListener('change', function () { if ($('picker').files.length) tx.sendFiles($('picker').files); $('picker').value = ''; });
  ['dragenter', 'dragover'].forEach(function (n) { document.addEventListener(n, function (e) { e.preventDefault(); document.body.classList.add('dragging'); }); });
  ['dragleave', 'drop'].forEach(function (n) { document.addEventListener(n, function (e) { e.preventDefault(); document.body.classList.remove('dragging'); }); });
  document.addEventListener('drop', function (e) {
    var files = [], skipped = 0;
    var items = e.dataTransfer && e.dataTransfer.items;
    var fl = e.dataTransfer ? e.dataTransfer.files : [];
    for (var i = 0; i < fl.length; i++) {
      var ent = items && items[i] && items[i].webkitGetAsEntry ? items[i].webkitGetAsEntry() : null;
      if (ent && ent.isDirectory) skipped++; else files.push(fl[i]);
    }
    if ($('sendfiles').disabled) { $('err').textContent = 'Connect a phone and share your screen first, then drop files.'; return; }
    $('err').textContent = skipped ? 'Folders were skipped: UltraCast sends files only.' : '';
    if (files.length) tx.sendFiles(files);
  });

  // ---------- copy on one device, paste on the other ----------
  var clip = { on: true, last: '', primed: false };
  function clipSend(t) {
    var m = { t: 'clip', s: t };
    if (JSON.stringify(m).length > 15000) return false;
    host.send(m); return true;
  }
  setInterval(async function () {
    if (!authorized || !clip.on) { clip.primed = false; return; }
    var t = ''; try { t = await window.ultracast.clipRead(); } catch (e) {}
    if (!clip.primed) { clip.primed = true; clip.last = t || ''; return; }   // what was already copied before connecting stays private
    if (t && t !== clip.last) { clip.last = t; clipSend(t); }
  }, 800);

  // ---------- control state and settings ----------
  window.ultracast.onControlStarted && window.ultracast.onControlStarted(function () { $('ctl-card').hidden = false; });
  window.ultracast.onCoverChanged(function (d) { if (d && d.why === 'hotkey') toast('Black cover removed.'); host.send({ t: 'cover-result', on: !!(d && d.on), ok: true, reason: '' }); });
  window.ultracast.onLocked(function (on) { host.send({ t: 'laptop-state', locked: on }); });
  window.ultracast.onControlEnded(function () { $('ctl-card').hidden = true; host.send({ t: 'revoked' }); });
  window.ultracast.onEvent(function (e) { if (e.type === 'unpaired') $('ctl-card').hidden = true; });
  window.ultracast.getSettings().then(function (st) {
    if (!st) return;
    $('keepawake').value = st.keepAwake; $('sharewhat').value = st.shareWhat; $('clipsync').value = st.clipSync; clip.on = st.clipSync === 'on';
    $('ctlmode').value = st.controlMode; $('recv').value = st.receiveMode; $('save').value = st.saveMode; $('theme').value = st.theme;
    themeChoice = st.theme; applyTheme();
  });
  // ---------- self-check ----------
  var diagLines = [];
  function diagShow() {
    var box = $('diag-out'); box.innerHTML = '';
    diagLines.forEach(function (d) {
      var k = d.kind === 'OK' ? 'ok' : d.kind === 'FAILED' ? 'fail' : 'note';
      var row = mk('div', 'diag ' + k); row.appendChild(mk('b', '', d.kind)); row.appendChild(mk('span', '', d.text)); box.appendChild(row);
    });
  }
  function webrtcLoopback() {
    // Two calls inside this window: a moving picture goes from one to the other. Proves video works on this laptop (codecs, graphics).
    return new Promise(function (resolve) {
      var done = false, pc1 = new RTCPeerConnection(), pc2 = new RTCPeerConnection();
      function end(k, t) { if (done) return; done = true; try { pc1.close(); pc2.close(); } catch (e) {} resolve({ kind: k, text: t }); }
      try {
        var c = document.createElement('canvas'); c.width = 320; c.height = 180; var g = c.getContext('2d'); var n = 0;
        var timer = setInterval(function () { g.fillStyle = 'hsl(' + (n * 20 % 360) + ',80%,50%)'; g.fillRect(0, 0, 320, 180); n++; }, 40);
        var stream = c.captureStream(25); stream.getTracks().forEach(function (t) { pc1.addTrack(t, stream); });
        pc1.onicecandidate = function (e) { if (e.candidate) pc2.addIceCandidate(e.candidate); };
        pc2.onicecandidate = function (e) { if (e.candidate) pc1.addIceCandidate(e.candidate); };
        var v = document.createElement('video'); v.muted = true; v.autoplay = true;
        pc2.ontrack = function (e) { v.srcObject = e.streams[0]; };
        var check = setInterval(function () { if (v.videoWidth > 0) { clearInterval(check); clearInterval(timer); end('OK', 'Video calls work on this laptop (a test picture travelled between two calls at ' + v.videoWidth + ' x ' + v.videoHeight + ')'); } }, 200);
        setTimeout(function () { clearInterval(check); clearInterval(timer); end('FAILED', 'A test video call did not deliver a picture in 8 seconds. Video will not work on this laptop. Update the graphics driver and try again.'); }, 8000);
        pc1.createOffer().then(function (o) { return pc1.setLocalDescription(o).then(function () { return pc2.setRemoteDescription(o); }); })
          .then(function () { return pc2.createAnswer(); }).then(function (a) { return pc2.setLocalDescription(a).then(function () { return pc1.setRemoteDescription(a); }); })
          .catch(function (e) { end('FAILED', 'Video call set-up failed: ' + (e && e.message ? e.message : e)); });
      } catch (e) { end('FAILED', 'Video call test: ' + (e && e.message ? e.message : e)); }
    });
  }
  $('diag-run').addEventListener('click', async function () {
    $('diag-run').disabled = true; diagLines = [{ kind: 'NOTE', text: 'Checking...' }]; diagShow();
    var res = []; try { res = await window.ultracast.diag(); } catch (e) { res = [{ kind: 'FAILED', text: 'The check could not run: ' + e }]; }
    var fonts = await Promise.all([document.fonts.load('16px Jost'), document.fonts.load('500 40px Barlow')]).then(function (a) { return a[0].length && a[1].length; }).catch(function () { return false; });
    res.push({ kind: fonts ? 'OK' : 'FAILED', text: 'Fonts (Jost, Barlow) ' + (fonts ? 'loaded' : 'did not load') });
    res.push(await webrtcLoopback());
    diagLines = res; diagShow(); $('diag-run').disabled = false;
  });
  $('diag-cover').addEventListener('click', async function () {
    $('diag-cover').disabled = true; toast('The screen goes black for about a second. Press Ctrl+Alt+K if it stays black.');
    var r; try { r = await window.ultracast.diagCover(); } catch (e) { r = { kind: 'FAILED', text: 'The cover test could not run: ' + e }; }
    diagLines = diagLines.filter(function (d) { return !/black cover/i.test(d.text); }); diagLines.push(r); diagShow(); $('diag-cover').disabled = false;
  });
  function logText() { return 'UltraCast laptop: phone-screen log\n' + (traceLines.length ? traceLines.join('\n') : 'Nothing yet. Press Start on the Control page, then open this again.'); }
  function reportText() { return 'UltraCast laptop self-check\n' + (diagLines.length ? diagLines.map(function (d) { return d.kind + '  ' + d.text; }).join('\n') : 'Not run yet.'); }
  async function copyOut(t, ok) {
    var done = false; try { done = await window.ultracast.diagCopy(t); } catch (e) {}
    if (!done) { try { await navigator.clipboard.writeText(t); done = true; } catch (e) {} }
    toast(done ? ok : 'Could not copy. Use "Save both as a file" instead.');
  }
  $('diag-log').addEventListener('click', function () {
    var v = $('diag-logview'); v.hidden = false; v.textContent = logText();
  });
  $('diag-save').addEventListener('click', async function () {
    var f = ''; try { f = await window.ultracast.diagSave(reportText() + '\n\n' + logText()); } catch (e) {}
    toast(f ? 'Saved to ' + f : 'Could not save the file.');
  });
  $('diag-copy').addEventListener('click', function () { copyOut(reportText(), 'Copied the self-check.'); });
  $('clipsync').addEventListener('change', function () { clip.on = $('clipsync').value === 'on'; window.ultracast.setSettings({ clipSync: $('clipsync').value }); });
  $('recv').addEventListener('change', function () { window.ultracast.setSettings({ receiveMode: $('recv').value }); });
  $('save').addEventListener('change', function () { window.ultracast.setSettings({ saveMode: $('save').value }); });
  $('ctlmode').addEventListener('change', function () { window.ultracast.setSettings({ controlMode: $('ctlmode').value }); });
  $('theme').addEventListener('change', function () { themeChoice = $('theme').value; applyTheme(); window.ultracast.setSettings({ theme: themeChoice }); });

  refreshSteps();
  refreshDevices();
  window.__uc = { get authorized() { return authorized; }, get sound() { return snd.player ? snd.player.stats() : null; } }; // read-only handle for the automated tests
})();
