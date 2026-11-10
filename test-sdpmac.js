'use strict';
// The signature on call descriptions: the laptop (server.js), the web phone page (renderer/sas.js) and the rules around it.
const assert = require('assert');
const crypto = require('crypto');
const { sdpMacFor } = require('./server');
const Sas = require('./renderer/sas');
const secret = crypto.randomBytes(32).toString('hex');
const sdp = 'v=0\r\na=fingerprint:sha-256 AA:BB\r\nm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\n';
const m = sdpMacFor(secret, 'host', 'offer', sdp);
assert.strictEqual(m.length, 64);
assert.strictEqual(m, Sas.sdpMac(secret, 'host', 'offer', sdp), 'laptop and web phone page compute the same signature');
assert.notStrictEqual(m, sdpMacFor(secret, 'phone', 'offer', sdp), 'the two directions never share a signature');
assert.notStrictEqual(m, sdpMacFor(secret, 'host', 'answer', sdp), 'offer and answer differ');
assert.notStrictEqual(m, sdpMacFor(secret, 'host', 'offer', sdp.replace('AA:BB', 'AA:BC')), 'one changed fingerprint changes it');
assert.notStrictEqual(m, sdpMacFor(crypto.randomBytes(32).toString('hex'), 'host', 'offer', sdp), 'another key changes it');
console.log('sdpmac: all checks passed');
