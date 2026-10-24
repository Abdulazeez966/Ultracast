'use strict';
// Checks the quality rules: when the picture should get sharper or softer.
const assert = require('assert');
const { pickTier, step, TIERS } = require('./renderer/host-rtc.js');

let passed = 0;
function check(name, fn) {
  try { fn(); passed++; console.log('  ok   ' + name); }
  catch (e) { console.log('  FAIL ' + name + '\n       ' + e.message); process.exitCode = 1; }
}
const name = (i) => TIERS[i].name;

console.log('Testing the quality rules');

check('picks the right rung for each amount of bandwidth', () => {
  assert.strictEqual(name(pickTier(20e6)), 'Excellent');
  assert.strictEqual(name(pickTier(6e6)), 'Excellent');
  assert.strictEqual(name(pickTier(4e6)), 'Good');
  assert.strictEqual(name(pickTier(2e6)), 'Fair');
  assert.strictEqual(name(pickTier(1e6)), 'Weak');
  assert.strictEqual(name(pickTier(1e5)), 'Poor');
  assert.strictEqual(name(pickTier(0)), 'Poor');
});

check('rungs get softer as they go down', () => {
  for (let i = 1; i < TIERS.length; i++) {
    assert.ok(TIERS[i].bitrate < TIERS[i - 1].bitrate);
    assert.ok(TIERS[i].scale >= TIERS[i - 1].scale);
    assert.ok(TIERS[i].fps <= TIERS[i - 1].fps);
  }
});

check('stays put while the link is steady', () => {
  let s = { idx: 1, want: 1, count: 0 };
  for (let i = 0; i < 10; i++) s = step(s, 4e6);
  assert.strictEqual(s.idx, 1);
});

check('drops after 2 bad readings in a row, straight to the right rung', () => {
  let s = { idx: 1, want: 1, count: 0 };
  s = step(s, 1e6); assert.strictEqual(s.idx, 1);
  s = step(s, 1e6); assert.strictEqual(name(s.idx), 'Weak');
});

check('one bad reading alone does not change anything', () => {
  let s = { idx: 1, want: 1, count: 0 };
  s = step(s, 1e5); s = step(s, 4e6); s = step(s, 4e6);
  assert.strictEqual(s.idx, 1);
});

check('climbs slowly: 4 good readings, one rung at a time', () => {
  let s = { idx: 4, want: 4, count: 0 };
  for (let i = 0; i < 3; i++) { s = step(s, 20e6); assert.strictEqual(s.idx, 4); }
  s = step(s, 20e6); assert.strictEqual(s.idx, 3);
  for (let i = 0; i < 4; i++) s = step(s, 20e6);
  assert.strictEqual(s.idx, 2);
});

console.log('\n' + passed + ' checks passed' + (process.exitCode ? ', some failed' : ''));
