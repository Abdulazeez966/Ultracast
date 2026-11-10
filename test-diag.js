'use strict';
const d = require('./diag'); let bad = 0;
const t = (n, c) => { console.log((c ? '  ok   ' : '  FAIL ') + n); if (!c) bad = 1; };
const dark = Buffer.alloc(4 * 1000, 0), bright = Buffer.alloc(4 * 1000, 200);
t('luminance of black is ~0', d.lum(dark) < 1);
t('luminance of bright is high', d.lum(bright) > 150);
t('exports the checks', typeof d.runChecks === 'function' && typeof d.coverCaptureTest === 'function');
process.exit(bad);
