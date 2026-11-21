'use strict';
const path = require('path'), fs = require('fs'), os = require('os');
const { _electron } = require(process.env.PLAYWRIGHT_PATH || 'playwright');
(async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'uc-home-'));
  const app = await _electron.launch({ executablePath: path.join(__dirname, 'node_modules/electron/dist/electron'), args: ['--no-sandbox', '--disable-gpu', '.'], cwd: __dirname, env: { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, '.config') } });
  const win = await app.firstWindow(); await win.waitForLoadState('domcontentloaded');
  const ok = await win.evaluate(() => window.ultracast.devtools());
  await new Promise((r) => setTimeout(r, 1500)); const open = await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().some((w) => w.webContents.isDevToolsOpened()));
  console.log('ok=' + ok + ' open=' + open); console.log((ok && open ? '  ok   ' : '  FAIL ') + 'Developer tools button opens DevTools');
  await app.close(); process.exit(ok && open ? 0 : 1);
})().catch((e) => { console.error(e); process.exit(1); });
