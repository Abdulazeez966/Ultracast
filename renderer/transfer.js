/*
  UltraCast file transfer engine (step 4), used by BOTH the laptop window and the phone page.

  Picture a pair of loading docks on either side of a bridge (the "files" lane of the video call).
  Sending a file goes like this:
    1. Sender: "I'd like to send holiday.mp4, 40 MB."             (offer)
    2. Receiver's dock manager decides: "Yes, put it on dock 2."   (accept)  or "No thanks." (reject)
    3. Sender: carries the file over in small crates of 16 KB, waiting whenever the bridge is full.
    4. Sender: "That's the last crate."                           (end)
    5. Receiver: counts the crates, closes the box, "All received." (done)
  Either side may shout "Stop!" (cancel) at any time. One file travels each way at a time.

  The engine only knows the steps. What "accept" means (a pop-up, a folder, a download) is supplied by
  whoever uses it, so the laptop and the phone share this one file.
*/
(function (root) {
  'use strict';
  var CHUNK = 16 * 1024;          // one crate
  var SLICE = 256 * 1024;         // how much is read from the file at once
  var BIG = 1024 * 1024 * 1024;   // above this the sender is asked "really?"
  function noop() {}

  function create(o) {
    var prefix = o.prefix || 'X', list = [], inc = null, out = null, seq = 0, queue = [], busy = false, lastPaint = 0;

    function paint(force) {
      var t = Date.now();
      if (!force && t - lastPaint < 120) return;
      lastPaint = t;
      try { o.onChange(list.slice()); } catch (e) {}
    }
    function sendJ(obj) { return o.send(JSON.stringify(obj)); }
    function entry(id, dir, name, size) {
      var e = { id: id, dir: dir, name: name, size: size, done: 0, state: 'asking', note: '', path: '' };
      list.unshift(e); if (list.length > 30) list.pop();
      return e;
    }
    function finish(e, state, note) { e.state = state; e.note = note || ''; paint(true); }

    // ---------- receiving ----------
    function chunk(d) {
      if (!inc || !inc.open || !d || typeof d.byteLength !== 'number') return;
      if (inc.got + d.byteLength > inc.size) { abortIn('More data arrived than was announced', true); return; }
      inc.got += d.byteLength; inc.e.done = inc.got;
      o.api.chunk(d);
      paint();
    }
    function abortIn(reason, tell) {
      if (!inc) return;
      var mine = inc; inc = null;
      try { o.api.abort(); } catch (e) {}
      finish(mine.e, 'failed', reason);
      if (tell) sendJ({ t: 'cancel', id: mine.id }).catch(noop);
    }
    async function offer(m) {
      var ok = typeof m.id === 'string' && m.id.length <= 40 && typeof m.name === 'string' && m.name.length <= 1024 &&
               typeof m.size === 'number' && isFinite(m.size) && Math.floor(m.size) === m.size && m.size >= 0 && m.size <= 9e15;
      if (!ok) return;
      if (inc) { sendJ({ t: 'reject', id: m.id, reason: 'The other device is busy with another file' }).catch(noop); return; }
      var e = entry(m.id, 'in', m.name, m.size);
      var mine = inc = { id: m.id, size: m.size, got: 0, open: false, e: e };
      paint(true);
      var res;
      try { res = await o.api.offer(m.name, m.size); } catch (err) { res = { ok: false, reason: 'Could not start receiving' }; }
      if (inc !== mine) { if (res && res.ok) { try { o.api.abort(); } catch (x) {} } return; } // cancelled while the question was open
      if (!res || !res.ok) {
        inc = null;
        var why = (res && res.reason) || 'Declined';
        finish(e, 'rejected', why);
        sendJ({ t: 'reject', id: m.id, reason: why }).catch(noop);
        return;
      }
      mine.open = true; e.name = res.name || e.name; e.state = 'receiving'; paint(true);
      sendJ({ t: 'accept', id: m.id }).catch(noop);
    }
    async function end(m) {
      if (!inc || inc.id !== m.id) return;
      var mine = inc; inc = null;
      var e = mine.e;
      if (mine.got !== mine.size) {
        try { o.api.abort(); } catch (x) {}
        finish(e, 'failed', 'The file arrived incomplete');
        sendJ({ t: 'done', id: m.id, ok: false }).catch(noop);
        return;
      }
      var r;
      try { r = await o.api.end(); } catch (err) { r = { ok: false, reason: 'Could not save the file' }; }
      var good = !!(r && r.ok);
      e.done = e.size; e.path = (r && r.path) || '';
      finish(e, good ? 'done' : 'failed', good ? 'Saved' : ((r && r.reason) || 'Failed'));
      sendJ({ t: 'done', id: m.id, ok: good }).catch(noop);
    }
    function theyCancelled(m) {
      if (inc && inc.id === m.id) {
        var mine = inc; inc = null;
        try { o.api.abort(); } catch (e) {}
        finish(mine.e, 'cancelled', 'Cancelled by the other device');
      } else if (out && out.id === m.id) {
        out.cancelled = true;
        if (out.res) { var r = out.res; out.res = null; r({ t: 'cancel' }); }
      }
    }

    function onMessage(d) {
      if (typeof d !== 'string') { chunk(d); return; }
      var m; try { m = JSON.parse(d); } catch (e) { return; }
      if (!m || typeof m !== 'object') return;
      if (m.t === 'offer') offer(m);
      else if (m.t === 'end') end(m);
      else if (m.t === 'cancel') theyCancelled(m);
      else if (out && m.id === out.id && out.res && (m.t === 'accept' || m.t === 'reject' || m.t === 'done')) {
        var r = out.res; out.res = null; r(m);
      }
    }

    // ---------- sending ----------
    function sendFiles(files) {
      Array.prototype.forEach.call(files, function (f) { queue.push(f); });
      pump();
    }
    async function pump() {
      if (busy) return;
      busy = true;
      try { while (queue.length) await sendOne(queue.shift()); } finally { busy = false; }
    }
    async function sendOne(f) {
      var e = entry(prefix + (++seq) + Date.now().toString(36), 'out', f.name, f.size);
      if (f.size > BIG && !(o.confirmLarge && o.confirmLarge(f.name, f.size))) { finish(e, 'cancelled', 'Not sent'); return; }
      var me = { id: e.id, cancelled: false, res: null };
      out = me;
      function wait(ms) {
        return new Promise(function (r) {
          me.res = r;
          setTimeout(function () { if (me.res === r) { me.res = null; r(null); } }, ms);
        });
      }
      try {
        var w = wait(120000); // generous: the other person may take a while to press Accept
        await sendJ({ t: 'offer', id: e.id, name: f.name, size: f.size });
        var a = await w;
        if (me.cancelled || (a && a.t === 'cancel')) { finish(e, 'cancelled', 'Cancelled'); return; }
        if (!a) { finish(e, 'failed', 'No answer from the other device'); return; }
        if (a.t === 'reject') { finish(e, 'rejected', a.reason || 'Declined'); return; }
        e.state = 'sending'; paint(true);
        for (var off = 0; off < f.size && !me.cancelled; off += SLICE) {
          var buf = await f.slice(off, Math.min(off + SLICE, f.size)).arrayBuffer();
          for (var p = 0; p < buf.byteLength && !me.cancelled; p += CHUNK) {
            var n = Math.min(CHUNK, buf.byteLength - p);
            await o.send(new Uint8Array(buf, p, n));   // waits here whenever the bridge is full
            e.done = off + p + n; paint();
          }
        }
        if (me.cancelled) { finish(e, 'cancelled', 'Cancelled'); return; }
        var w2 = wait(60000);
        await sendJ({ t: 'end', id: e.id });
        var d = await w2;
        if (d && d.t === 'done' && d.ok) { e.done = f.size; finish(e, 'done', 'Sent'); }
        else if (d && d.t === 'cancel') finish(e, 'cancelled', 'Cancelled');
        else if (d && d.t === 'done') finish(e, 'failed', 'The other device could not save it');
        else finish(e, 'failed', 'The other device did not confirm');
      } catch (err) {
        finish(e, me.cancelled ? 'cancelled' : 'failed', me.cancelled ? 'Cancelled' : 'The link was lost');
      } finally { if (out === me) out = null; }
    }

    function cancel(id) {
      if (out && out.id === id) {
        out.cancelled = true;
        sendJ({ t: 'cancel', id: id }).catch(noop);
        if (out.res) { var r = out.res; out.res = null; r({ t: 'cancel' }); }
      } else if (inc && inc.id === id) {
        var mine = inc; inc = null;
        try { o.api.abort(); } catch (e) {}
        finish(mine.e, 'cancelled', 'Cancelled');
        sendJ({ t: 'cancel', id: id }).catch(noop);
      }
    }

    // The bridge fell down: stop everything cleanly.
    function linkDown() {
      queue = [];
      if (inc) abortIn('The link was lost', false);
      if (out) { out.cancelled = true; if (out.res) { var r = out.res; out.res = null; r(null); } }
    }

    return { onMessage: onMessage, sendFiles: sendFiles, cancel: cancel, linkDown: linkDown };
  }

  var api = { create: create, CHUNK: CHUNK, BIG: BIG };
  root.UltraTransfer = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
