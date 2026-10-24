'use strict';
/*
  Builds a ready-to-run copy of UltraCast: a folder you can zip, move, and start by double-clicking UltraCast.exe.
  Run it ON the computer you want the app for (after "npm install"):   npm run package
  Result: dist/UltraCast/   (UltraCast.exe on Windows)

  How it works, in house terms: Electron is the ready-made house (dist folder). We copy the house,
  move our own furniture (the app files) into its "resources/app" room, and rename the front door to UltraCast.
*/
const fs = require('fs');
const path = require('path');

const root = __dirname;
const electronDist = path.join(root, 'node_modules', 'electron', 'dist');
const out = path.join(root, 'dist', 'UltraCast');

if (!fs.existsSync(electronDist)) { console.error('Electron is not installed. Run: npm install'); process.exit(1); }
console.log('Copying Electron...');
fs.rmSync(out, { recursive: true, force: true });
fs.cpSync(electronDist, out, { recursive: true });

const app = path.join(out, 'resources', 'app');
fs.mkdirSync(app, { recursive: true });
console.log('Adding UltraCast...');
['main.js', 'preload.js', 'banner-preload.js', 'inject.js', 'filesafe.js', 'server.js'].forEach((f) => fs.copyFileSync(path.join(root, f), path.join(app, f)));
['renderer', 'public'].forEach((d) => fs.cpSync(path.join(root, d), path.join(app, d), { recursive: true }));

const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
delete pkg.devDependencies; delete pkg.scripts;
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(pkg, null, 2));

// Only the two packages the app needs at run time (plus koffi's per-computer file).
fs.mkdirSync(path.join(app, 'node_modules'), { recursive: true });
['ws', 'koffi', '@koromix'].forEach((m) => {
  const from = path.join(root, 'node_modules', m);
  if (fs.existsSync(from)) fs.cpSync(from, path.join(app, 'node_modules', m), { recursive: true });
});

fs.rmSync(path.join(out, 'resources', 'default_app.asar'), { force: true });
const exe = process.platform === 'win32' ? 'electron.exe' : process.platform === 'darwin' ? null : 'electron';
if (exe && fs.existsSync(path.join(out, exe))) fs.renameSync(path.join(out, exe), path.join(out, process.platform === 'win32' ? 'UltraCast.exe' : 'UltraCast'));
console.log('Done: ' + out);
