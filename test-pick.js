'use strict';
const assert = require('assert');
const { chooseSource } = require('./pick');
(async () => {
  const src = [{ id: 'screen:1:0', display_id: '1', name: 'Screen 1' }, { id: 'screen:2:0', display_id: '2', name: 'Screen 2' }, { id: 'window:9:0', name: 'Notes' }, { id: 'window:8:0', name: 'Browser' }];
  const seen = [];
  const mk = (...answers) => async (m, l) => { seen.push([m, l]); return answers.shift(); };
  assert.strictEqual((await chooseSource(src, '2', mk(1))).id, 'screen:2:0');
  assert.deepStrictEqual(seen[0][1], ['Screen 1', 'Screen 2 (main)', 'A single window...']);
  assert.strictEqual((await chooseSource(src, '1', mk(2, 1))).id, 'window:8:0');
  assert.strictEqual(await chooseSource(src, '1', mk(-1)), null);
  assert.strictEqual(await chooseSource(src, '1', mk(2, -1)), null);
  assert.strictEqual(await chooseSource(src, '1', mk(99)), null);
  assert.strictEqual(await chooseSource([], '1', mk(0)), null);
  assert.strictEqual(await chooseSource(null, '1', mk(0)), null);
  // only screens: no window question
  assert.strictEqual((await chooseSource([src[0]], '1', mk(0))).id, 'screen:1:0');
  console.log('pick: all checks passed');
})().catch((e) => { console.error(e); process.exit(1); });
