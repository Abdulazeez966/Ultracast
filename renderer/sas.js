/*
  UltraCast short-number check and device proofs (step 5), shared by the laptop window and the phone page.

  Two jobs, both needing a "fingerprint machine" (SHA-256). A phone page opened over plain http:// is not
  allowed to use the browser's built-in one, so a small copy is included here.

  1. The matching number (called SAS below). When a phone is added, both sides look at the two secret
     "fingerprints" of the private call they just made (one per side), sort them, mix them, and turn the
     result into four digits. If the laptop shows 4827, the phone must show 4827 too. If someone sneaked
     into the middle and swapped the fingerprints, the two numbers would differ.
  2. The proof. A trusted phone does not send its secret again. The laptop sends a random challenge and the
     phone answers with a keyed fingerprint (HMAC) of it, which only someone holding the secret can make.
*/
(function (root) {
  'use strict';

  var K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da, 0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
  ]);

  function utf8(s) { return typeof s === 'string' ? new TextEncoder().encode(s) : s; }
  function rotr(x, n) { return (x >>> n) | (x << (32 - n)); }

  // SHA-256 of a string or bytes -> Uint8Array(32)
  function sha256(input) {
    var data = utf8(input), len = data.length;
    var padded = new Uint8Array(((len + 9 + 63) >> 6) << 6);
    padded.set(data); padded[len] = 0x80;
    var dv = new DataView(padded.buffer);
    dv.setUint32(padded.length - 8, Math.floor(len / 0x20000000), false);
    dv.setUint32(padded.length - 4, (len << 3) >>> 0, false);
    var H = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
    var w = new Uint32Array(64);
    for (var off = 0; off < padded.length; off += 64) {
      for (var i = 0; i < 16; i++) w[i] = dv.getUint32(off + i * 4, false);
      for (i = 16; i < 64; i++) {
        var s0 = rotr(w[i - 15], 7) ^ rotr(w[i - 15], 18) ^ (w[i - 15] >>> 3);
        var s1 = rotr(w[i - 2], 17) ^ rotr(w[i - 2], 19) ^ (w[i - 2] >>> 10);
        w[i] = (w[i - 16] + s0 + w[i - 7] + s1) | 0;
      }
      var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
      for (i = 0; i < 64; i++) {
        var S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
        var ch = (e & f) ^ (~e & g);
        var t1 = (h + S1 + ch + K[i] + w[i]) | 0;
        var S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
        var maj = (a & b) ^ (a & c) ^ (b & c);
        var t2 = (S0 + maj) | 0;
        h = g; g = f; f = e; e = (d + t1) | 0; d = c; c = b; b = a; a = (t1 + t2) | 0;
      }
      H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
      H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
    }
    var out = new Uint8Array(32), ov = new DataView(out.buffer);
    for (i = 0; i < 8; i++) ov.setUint32(i * 4, H[i], false);
    return out;
  }

  function hex(bytes) { var s = ''; for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16); return s; }

  // HMAC-SHA256(key, message) as lower-case hex. Key and message are strings (UTF-8).
  function hmacHex(key, message) {
    var k = utf8(key);
    if (k.length > 64) k = sha256(k);
    var ipad = new Uint8Array(64), opad = new Uint8Array(64);
    for (var i = 0; i < 64; i++) { var kb = i < k.length ? k[i] : 0; ipad[i] = kb ^ 0x36; opad[i] = kb ^ 0x5c; }
    var m = utf8(message);
    var inner = new Uint8Array(64 + m.length); inner.set(ipad); inner.set(m, 64);
    var ih = sha256(inner);
    var outer = new Uint8Array(96); outer.set(opad); outer.set(ih, 64);
    return hex(sha256(outer));
  }

  // The fingerprint lines of a call description, e.g. "a=fingerprint:sha-256 AB:CD:..."
  function fingerprints(sdp) {
    var out = [], re = /^a=fingerprint:(\S+)\s+(\S+)/gim, m;
    while ((m = re.exec(String(sdp || '')))) out.push((m[1] + ' ' + m[2]).toUpperCase());
    return out;
  }

  // Four digits both sides can compute from the two descriptions of the same call.
  function sas(localSdp, remoteSdp) {
    var all = fingerprints(localSdp).concat(fingerprints(remoteSdp));
    var uniq = all.filter(function (v, i) { return all.indexOf(v) === i; }).sort();
    if (!uniq.length) return null;
    var h = sha256('ultracast-sas:' + uniq.join('|'));
    var n = ((h[0] << 24) | (h[1] << 16) | (h[2] << 8) | h[3]) >>> 0;
    return String(n % 10000).padStart(4, '0');
  }

  var api = { sha256: sha256, hex: hex, hmacHex: hmacHex, fingerprints: fingerprints, sas: sas };
  root.UltraSas = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
