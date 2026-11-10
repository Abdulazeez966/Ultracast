'use strict';
// Plays this phone's sound on the laptop. The phone sends small chunks of raw sound (48000 samples a second, stereo,
// 16 bits) over a lane that never waits for lost pieces; this plays them back-to-back with a short cushion so tiny
// delays in the network do not crackle. (Contract: PHONE-SCREEN-PROTOCOL.md, lane "paudio".)
(function (root) {
  var RATE = 48000, HEADER = 3, MAX_FRAMES = 4800;
  var CUSHION = 0.08;     // seconds of sound kept queued ahead of now
  var MAX_AHEAD = 0.5;    // if more than this is queued, start over (we fell behind)

  function create(opts) {
    var o = opts || {};
    var ac = o.context || new (root.AudioContext || root.webkitAudioContext)({ latencyHint: 'interactive' });
    var gain = ac.createGain();
    gain.gain.value = 1;
    gain.connect(ac.destination);
    var next = 0, pushed = 0, dropped = 0, lastSeq = -1, lost = 0, closed = false;

    function push(buf) {
      if (closed || !buf || typeof buf.byteLength !== 'number') { dropped++; return false; }
      var n = buf.byteLength;
      if (n <= HEADER || (n - HEADER) % 4 !== 0 || (n - HEADER) / 4 > MAX_FRAMES) { dropped++; return false; }
      var v = new DataView(buf);
      if (v.getUint8(0) !== 1) { dropped++; return false; }                     // unknown version
      var seq = v.getUint16(1, false);
      if (lastSeq >= 0) lost += (seq - lastSeq - 1 + 65536) % 65536;
      lastSeq = seq;
      var frames = (n - HEADER) / 4;
      var ab = ac.createBuffer(2, frames, RATE);
      var l = ab.getChannelData(0), r = ab.getChannelData(1);
      for (var i = 0; i < frames; i++) {
        l[i] = v.getInt16(HEADER + i * 4, true) / 32768;
        r[i] = v.getInt16(HEADER + i * 4 + 2, true) / 32768;
      }
      var src = ac.createBufferSource();
      src.buffer = ab;
      src.connect(gain);
      var now = ac.currentTime;
      if (next < now + 0.01 || next - now > MAX_AHEAD) next = now + CUSHION;
      src.start(next);
      next += frames / RATE;
      pushed++;
      return true;
    }
    function setOn(on) { gain.gain.value = on ? 1 : 0; }
    function resume() { try { if (ac.state === 'suspended' && ac.resume) ac.resume(); } catch (e) {} }
    function close() { closed = true; try { if (ac.close) ac.close(); } catch (e) {} }
    return { push: push, setOn: setOn, resume: resume, close: close, stats: function () { return { pushed: pushed, dropped: dropped, lost: lost }; } };
  }
  var api = { create: create, RATE: RATE, HEADER: HEADER };
  root.UltraPcm = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
