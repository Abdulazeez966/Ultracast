'use strict';
const assert = require('assert');
const { create } = require('./renderer/pcmplayer');
function fakeCtx() {
  const c = { currentTime: 10, state: 'running', starts: [], buffers: [], destination: {}, closed: false };
  c.createGain = () => ({ gain: { value: 1 }, connect() {} });
  c.createBuffer = (ch, n, rate) => { const b = { ch, n, rate, d: [new Float32Array(n), new Float32Array(n)], getChannelData(i) { return this.d[i]; } }; c.buffers.push(b); return b; };
  c.createBufferSource = () => ({ connect() {}, start(t) { c.starts.push(t); }, set buffer(b) { this.b = b; } });
  c.close = () => { c.closed = true; };
  return c;
}
const chunk = (seq, frames, l, r) => { const b = new ArrayBuffer(3 + frames * 4), v = new DataView(b); v.setUint8(0, 1); v.setUint16(1, seq, false); for (let i = 0; i < frames; i++) { v.setInt16(3 + i * 4, l, true); v.setInt16(5 + i * 4, r, true); } return b; };
const ctx = fakeCtx(); const p = create({ context: ctx });
assert.ok(p.push(chunk(0, 960, 16384, -16384)), 'good chunk plays');
assert.ok(Math.abs(ctx.buffers[0].d[0][5] - 0.5) < 1e-4 && Math.abs(ctx.buffers[0].d[1][5] + 0.5) < 1e-4, 'left and right are decoded');
assert.ok(Math.abs(ctx.starts[0] - 10.08) < 1e-9, 'first chunk waits for the cushion');
assert.ok(p.push(chunk(1, 960, 0, 0)));
assert.ok(Math.abs(ctx.starts[1] - (10.08 + 0.02)) < 1e-9, 'next chunk follows right after (20 ms)');
p.push(chunk(4, 960, 0, 0));
assert.strictEqual(p.stats().lost, 2, 'missing chunks are counted');
ctx.currentTime = 50; p.push(chunk(5, 960, 0, 0));
assert.ok(Math.abs(ctx.starts[3] - 50.08) < 1e-9, 'after a long pause it restarts with the cushion');
for (let i = 0; i < 40; i++) p.push(chunk(6 + i, 960, 0, 0));
assert.ok(ctx.starts[ctx.starts.length - 1] - 50 < 1.2, 'a big burst never queues seconds ahead');
const before = p.stats().pushed;
for (const bad of [null, 5, new ArrayBuffer(3), new ArrayBuffer(6), new ArrayBuffer(3 + 4 * 5000), (() => { const b = chunk(0, 10, 0, 0); new DataView(b).setUint8(0, 9); return b; })()]) assert.strictEqual(p.push(bad), false);
assert.strictEqual(p.stats().pushed, before); assert.strictEqual(p.stats().dropped, 6);
p.close(); assert.ok(ctx.closed); assert.strictEqual(p.push(chunk(0, 10, 0, 0)), false);
console.log('pcmplayer: all checks passed');
