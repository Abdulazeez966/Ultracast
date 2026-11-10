'use strict';
// Guards against "Cannot find module './x'" in the installed app: every local file the app loads must be listed
// in the installer's file list (package.json "build.files") and in make-exe.js.
const fs = require('fs'); const path = require('path'); const assert = require('assert');
const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
const listed = new Set(pkg.build.files);
const exeSrc = fs.readFileSync(path.join(__dirname, 'make-exe.js'), 'utf8');
const seen = new Set(); const todo = ['main.js', 'preload.js', 'banner-preload.js'];
while (todo.length) {
  const f = todo.pop(); if (seen.has(f)) continue; seen.add(f);
  assert.ok(listed.has(f), f + ' is missing from package.json build.files');
  assert.ok(exeSrc.includes("'" + f + "'"), f + ' is missing from make-exe.js');
  const src = fs.readFileSync(path.join(__dirname, f), 'utf8');
  for (const m of src.matchAll(/require\('\.\/([\w-]+)(\.js)?'\)/g)) todo.push(m[1] + '.js');
}
console.log('package: all ' + seen.size + ' loaded files are in the installer (' + [...seen].join(', ') + ')');
