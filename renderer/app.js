'use strict';
// Glue between the laptop window and the video link (host-rtc.js). Pages: Home, Devices, Control, Settings.
(async function () {
  var $ = function (id) { return document.getElementById(id); };
  var info = await window.ultracast.info();
  var sharing = false, expiresAt = 0;
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
    ['home', 'devices', 'control', 'settings'].forEach(function (v) { $('v-' + v).hidden = v !== name; });
    document.querySelectorAll('.nav').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-view') === name || (name === 'control' && b.getAttribute('data-view') === 'devices')); });
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
  async function openSheet(phoneAlreadyHere) {
    sheetOpen = true; confirming = false;
    $('modal').hidden = false;
    $('st-code-body').hidden = true; $('st-phone-help').hidden = false;
    stepState('st-phone', 'now', 'Waiting'); stepState('st-code', ''); stepState('st-secure', '');
    $('st-phone-text').textContent = 'Waiting for your phone';
    $('sas-yes').disabled = false; $('sas-no').disabled = false;
    await refreshSteps();
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
  function updateShare() { $('share').disabled = !(peer.present && authorized); }
  function enterControl() {
    updateShare();
    $('ctl-name').textContent = peer.name || 'Phone';
    $('ctl-sub').textContent = 'Connected over your hotspot';
    showView('control');
  }
  function leaveControl() { ring.set({ mbps: 0, active: false }); }
  $('ctl-back').addEventListener('click', function () { showView('devices'); });
  $('disconnect').addEventListener('click', function () { window.ultracast.disconnect(); });
  $('share').addEventListener('click', async function () {
    $('err').textContent = '';
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

  host = UltraHost.createHost({
    onInput: onInput,
    onFile: function (d) { if (authorized) tx.onMessage(d); },
    onPair: onPair,
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
        peer = { present: !!s.present, trusted: !!s.trusted, name: s.name || '', deviceId: s.deviceId || null };
        $('home-dot').className = s.present ? 'dot on' : 'dot';
        $('home-status').textContent = s.present ? (peer.name || 'A phone') + ' is connected' : 'No phone connected';
        if (!s.present) {
          authorized = false; confirming = false;
          window.ultracast.controlRelease(); resetStats(); leaveControl();
          if (!$('v-control').hidden) { showView('devices'); toast('The phone disconnected.'); }
          if (sheetOpen) closeSheet(false);
          refreshDevices();
        } else if (s.trusted) {
          authorized = true; enterControl(); refreshDevices();
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
      } else if (s.kind === 'error') {
        $('err').textContent = 'Problem: ' + s.reason;
      }
      updateShare();
    }
  });
  $('share').disabled = true;

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

  // ---------- control state and settings ----------
  window.ultracast.onControlStarted && window.ultracast.onControlStarted(function () { $('ctl-card').hidden = false; });
  window.ultracast.onControlEnded(function () { $('ctl-card').hidden = true; host.send({ t: 'revoked' }); });
  window.ultracast.onEvent(function (e) { if (e.type === 'unpaired') $('ctl-card').hidden = true; });
  window.ultracast.getSettings().then(function (st) {
    if (!st) return;
    $('ctlmode').value = st.controlMode; $('recv').value = st.receiveMode; $('save').value = st.saveMode; $('theme').value = st.theme;
    themeChoice = st.theme; applyTheme();
  });
  $('recv').addEventListener('change', function () { window.ultracast.setSettings({ receiveMode: $('recv').value }); });
  $('save').addEventListener('change', function () { window.ultracast.setSettings({ saveMode: $('save').value }); });
  $('ctlmode').addEventListener('change', function () { window.ultracast.setSettings({ controlMode: $('ctlmode').value }); });
  $('theme').addEventListener('change', function () { themeChoice = $('theme').value; applyTheme(); window.ultracast.setSettings({ theme: themeChoice }); });

  refreshSteps();
  refreshDevices();
  window.__uc = { get authorized() { return authorized; } }; // read-only handle for the automated tests
})();
