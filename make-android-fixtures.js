'use strict';
// Makes test vectors from the laptop's own code, so the Android app's Kotlin can prove it computes identical answers.
// Run: node make-android-fixtures.js ../ultracast-android/tools/core-test/fixtures.json
const fs = require('fs'), crypto = require('crypto');
const Sas = require('./renderer/sas.js');
const { proofFor, hostProofFor, sdpMacFor } = require('./server.js');
const fp = () => Array.from(crypto.randomBytes(32)).map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(':');
const sdp = (f, extra) => 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' + (extra || '') + 'a=fingerprint:sha-256 ' + f + '\r\na=setup:actpass\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
const cases = [];
for (let i = 0; i < 25; i++) {
  const a = fp(), b = fp();
  const local = sdp(a), remote = sdp(b, i % 3 === 0 ? 'a=fingerprint:sha-384 ' + fp() + '\r\n' : '');
  cases.push({ local, remote, sas: Sas.sas(local, remote), sasSwapped: Sas.sas(remote, local) });
}
const lowered = sdp(fp().toLowerCase());
cases.push({ local: lowered, remote: sdp(fp()), sas: Sas.sas(lowered, sdp(fp())) , skip: true });
const hm = [['k', 'hello'], ['a'.repeat(64), 'ultracast-proof:abc'], ['x'.repeat(100), 'long key test'], ['secret-€', 'unicode ✓ message']].map(([k, m]) => ({ key: k, msg: m, hex: Sas.hmacHex(k, m) }));
const secrets = [crypto.randomBytes(32).toString('hex'), crypto.randomBytes(32).toString('hex')];
const proofs = secrets.map((s) => { const n = crypto.randomBytes(16).toString('hex'), c = crypto.randomBytes(16).toString('hex'); return { secret: s, nonce: n, proof: proofFor(s, n), cnonce: c, hostProof: hostProofFor(s, c) }; });
const sdpMacs = secrets.flatMap((sec) => ['host', 'phone'].flatMap((role) => ['offer', 'answer'].map((type) => { const sdpText = sdp(fp(), 'a=group:BUNDLE 0\r\n'); return { secret: sec, role, type, sdp: sdpText, mac: sdpMacFor(sec, role, type, sdpText) }; })));
fs.writeFileSync(process.argv[2], JSON.stringify({ sas: cases.filter((c) => !c.skip), hmac: hm, proofs, sdpMacs, sha256: { in: 'abc', hex: Sas.hex(Sas.sha256('abc')) } }, null, 1));
console.log('fixtures written');
