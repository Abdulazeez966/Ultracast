'use strict';
/*
  UltraCast file receiving: the safe part (step 4)

  Think of this as the receiving dock at a warehouse. Before anything is put on a shelf it is:
    - given a safe label (a file name can't sneak a trip to another folder, or use a name Windows reserves),
    - unpacked into a temporary box (name.ucpart) so a half-delivered file never looks like a finished one,
    - counted (if more arrives than was announced, the delivery is stopped),
    - and only when the count is exactly right is the box renamed to its real name.
*/
const fs = require('fs');
const path = require('path');

const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const RISKY = new Set(['exe', 'msi', 'bat', 'cmd', 'com', 'scr', 'ps1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'lnk', 'reg', 'jar', 'hta', 'dll']);

// Turns any name the phone sends into a plain, safe file name.
function sanitizeName(raw) {
  let n = String(raw).replace(/[\\/]+/g, '/').split('/').pop();   // drop any folder part
  n = n.replace(/[\u0000-\u001f\u007f<>:"|?*]/g, '_');            // characters Windows forbids
  n = n.replace(/^\s+/, '').replace(/[. ]+$/, '');                // no leading spaces, no trailing dots or spaces
  if (RESERVED.test(n.split('.')[0])) n = '_' + n;                // CON, NUL, COM1 ...
  if (n.length > 200) {
    const dot = n.lastIndexOf('.');
    const ext = dot > 0 && n.length - dot <= 20 ? n.slice(dot) : '';
    n = n.slice(0, 200 - ext.length) + ext;
  }
  if (!n || n === '.' || n === '..') n = 'file';
  return n;
}

function isRisky(name) {
  const dot = name.lastIndexOf('.');
  return dot > 0 && RISKY.has(name.slice(dot + 1).toLowerCase());
}

// "photo.jpg" -> "photo (2).jpg" when photo.jpg is already there.
function uniqueName(dir, name) {
  if (!fs.existsSync(path.join(dir, name))) return name;
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : '';
  for (let i = 2; i < 10000; i++) {
    const c = base + ' (' + i + ')' + ext;
    if (!fs.existsSync(path.join(dir, c))) return c;
  }
  return base + ' (' + Date.now() + ')' + ext;
}

// Opens the temporary box for one incoming file.
function openIncoming(dir, name, size, replace) {
  let final = path.join(dir, name);
  const temp = final + '.ucpart';
  const fd = fs.openSync(temp, 'w');
  let got = 0, open = true, error = '';

  function closeAndRemove() {
    if (open) { try { fs.closeSync(fd); } catch (e) {} open = false; }
    try { fs.unlinkSync(temp); } catch (e) {}
  }
  return {
    get error() { return error; },
    write(buf) {
      if (!open) return;
      if (got + buf.length > size) { error = 'More data arrived than was announced'; closeAndRemove(); return; }
      try { fs.writeSync(fd, buf, 0, buf.length); got += buf.length; }
      catch (e) { error = 'Could not write to disk: ' + e.message; closeAndRemove(); }
    },
    finish() {
      if (error) return { ok: false, reason: error };
      if (!open || got !== size) { closeAndRemove(); return { ok: false, reason: 'The file arrived incomplete' }; }
      try {
        fs.closeSync(fd); open = false;
        if (!replace && fs.existsSync(final)) final = path.join(dir, uniqueName(dir, name)); // someone made the name in the meantime
        fs.renameSync(temp, final);
        return { ok: true, path: final, size: got };
      } catch (e) { closeAndRemove(); return { ok: false, reason: 'Could not save: ' + e.message }; }
    },
    abort() { closeAndRemove(); },
  };
}

module.exports = { sanitizeName, isRisky, uniqueName, openIncoming };
