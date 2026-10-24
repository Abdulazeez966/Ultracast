'use strict';
// Glue between the app window and the video link (host-rtc.js).
(async function () {
  var $ = function (id) { return document.getElementById(id); };
  var info = await window.ultracast.info();
  var sharing = false;
  var expiresAt = 0;

  function tick(id, on) { $(id).className = on ? 'ok' : ''; $(id).firstElementChild.className = on ? 'dot on' : 'dot'; }

  var host;
  async function onInput(m) {
    if (m.t === 'req') {
      var ok = false;
      if (sharing) { try { ok = await window.ultracast.controlRequest(); } catch (e) {} }
      tick('c-ctrl', ok);
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
    onFile: function (d) { tx.onMessage(d); },
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
      } else if (s.kind === 'peer') {
        tick('c-peer', s.present);
        if (!s.present) { tick('c-link', false); window.ultracast.controlRelease(); }
      } else if (s.kind === 'share') {
        sharing = s.on;
        $('share').textContent = s.on ? 'Stop sharing' : 'Share my screen';
        $('share').className = s.on ? '' : 'primary';
        tick('c-share', s.on);
        tick('c-audio', s.on && s.audio);
        if (!s.on) { window.ultracast.controlRelease(); tick('c-link', false); $('mbps').textContent = '0.0'; $('tier').textContent = '-'; }
      } else if (s.kind === 'files') {
        $('sendfiles').disabled = !s.open;
        if (!s.open) tx.linkDown();
      } else if (s.kind === 'link') {
        tick('c-link', s.state === 'connected');
      } else if (s.kind === 'stats') {
        $('mbps').textContent = s.mbps.toFixed(1);
        $('tier').textContent = s.tier;
        $('avail').textContent = s.availMbps ? s.availMbps.toFixed(1) + ' Mbps' : '-';
        $('rtt').textContent = s.rttMs != null ? Math.round(s.rttMs) + ' ms' : '-';
        $('pic').textContent = s.width ? s.width + ' x ' + s.height : '-';
        $('fps').textContent = s.fps ? Math.round(s.fps) + ' fps' : '-';
      } else if (s.kind === 'error') {
        $('err').textContent = 'Problem: ' + s.reason;
      }
    }
  });

  $('share').addEventListener('click', async function () {
    $('err').textContent = '';
    try {
      if (sharing) host.stopShare(); else await host.startShare();
    } catch (e) {
      $('err').textContent = 'Could not share the screen: ' + (e && e.message ? e.message : e);
    }
  });

  // ---- pairing address ----
  function renderPairing(p) {
    expiresAt = p.expiresAt;
    var box = $('urls');
    box.innerHTML = '';
    if (!p.urls.length) {
      var m = document.createElement('p');
      m.className = 'warn';
      m.textContent = 'No hotspot found yet. Join your phone\'s hotspot, then press New code.';
      box.appendChild(m);
      return;
    }
    p.urls.forEach(function (u) {
      var row = document.createElement('div'); row.className = 'url';
      var code = document.createElement('code'); code.textContent = u.url;
      var btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'Copy';
      btn.addEventListener('click', function () {
        try { navigator.clipboard.writeText(u.url); btn.textContent = 'Copied'; setTimeout(function () { btn.textContent = 'Copy'; }, 1500); }
        catch (e) { btn.textContent = 'Select and copy'; }
      });
      row.appendChild(code); row.appendChild(btn); box.appendChild(row);
    });
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

  // ---- files ----
  function fmt(n) { return n >= 1073741824 ? (n / 1073741824).toFixed(2) + ' GB' : n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB' : Math.max(1, Math.round(n / 1024)) + ' KB'; }
  function renderFiles(list) {
    var box = $('xlist'); box.innerHTML = '';
    list.slice(0, 8).forEach(function (e) {
      var row = document.createElement('div'); row.className = 'xrow ' + e.state;
      var top = document.createElement('div'); top.className = 'xtop';
      var nm = document.createElement('span'); nm.className = 'xname'; nm.textContent = (e.dir === 'in' ? 'From phone: ' : 'To phone: ') + e.name + ' (' + fmt(e.size) + ')';
      var st = document.createElement('span'); st.className = 'xnote';
      var live = e.state === 'sending' || e.state === 'receiving' || e.state === 'asking';
      st.textContent = live ? (e.state === 'asking' ? 'Waiting...' : Math.round(e.size ? e.done / e.size * 100 : 100) + '%') : (e.note || e.state) + (e.path ? ' to ' + e.path : '');
      top.appendChild(nm); top.appendChild(st); row.appendChild(top);
      var bar = document.createElement('div'); bar.className = 'bar'; var fill = document.createElement('i');
      fill.style.width = (e.size ? Math.min(100, e.done / e.size * 100) : (e.state === 'done' ? 100 : 0)) + '%'; bar.appendChild(fill); row.appendChild(bar);
      if (live) { var c = document.createElement('button'); c.type = 'button'; c.className = 'small'; c.textContent = 'Cancel'; c.addEventListener('click', function () { tx.cancel(e.id); }); row.appendChild(c); }
      box.appendChild(row);
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
    if ($('sendfiles').disabled) { $('err').textContent = 'Share your screen to a paired phone first, then drop files.'; return; }
    $('err').textContent = skipped ? 'Folders were skipped: UltraCast sends files only.' : '';
    if (files.length) tx.sendFiles(files);
  });

  // ---- control state and setting ----
  window.ultracast.onControlEnded(function () { tick('c-ctrl', false); host.send({ t: 'revoked' }); });
  window.ultracast.onEvent(function (e) { if (e.type === 'unpaired') tick('c-ctrl', false); });
  window.ultracast.getSettings().then(function (st) {
    $('auto').checked = !!st && st.controlMode === 'auto';
    if (st) { $('recv').value = st.receiveMode; $('save').value = st.saveMode; }
  });
  $('recv').addEventListener('change', function () { window.ultracast.setSettings({ receiveMode: $('recv').value }); });
  $('save').addEventListener('change', function () { window.ultracast.setSettings({ saveMode: $('save').value }); });
  $('auto').addEventListener('change', function () {
    window.ultracast.setSettings({ controlMode: $('auto').checked ? 'auto' : 'ask' });
  });

  newCode();
})();
