'use strict';
/*
  UltraCast trusted devices (step 5)

  A small address book kept in one file in the app's own data folder. For every phone you said "yes, they match"
  to, it keeps: a made-up id, a name, and a long secret. The secret is what lets that phone come back later
  without a new code. It never leaves this computer except once, to the phone itself, through the private call.
*/
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function createStore(file) {
  let list = [];
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Array.isArray(raw)) list = raw.filter((d) => d && typeof d.id === 'string' && typeof d.secret === 'string' && typeof d.name === 'string');
  } catch (e) { /* first run: empty */ }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file + '.tmp', JSON.stringify(list), { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    } catch (e) { /* best effort */ }
  }
  const clean = (n) => String(n || '').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, 40) || 'Phone';

  return {
    // Public view: never includes the secret.
    list: () => list.map((d) => ({ id: d.id, name: d.name, addedAt: d.addedAt, lastSeen: d.lastSeen || null })),
    add(name) {
      const d = { id: crypto.randomBytes(8).toString('hex'), secret: crypto.randomBytes(32).toString('hex'), name: clean(name), addedAt: Date.now(), lastSeen: Date.now() };
      list.push(d); save();
      return { id: d.id, secret: d.secret, name: d.name };
    },
    remove(id) { const n = list.length; list = list.filter((d) => d.id !== id); if (list.length !== n) save(); return list.length !== n; },
    rename(id, name) { const d = list.find((x) => x.id === id); if (!d) return false; d.name = clean(name); save(); return true; },
    touch(id) { const d = list.find((x) => x.id === id); if (d) { d.lastSeen = Date.now(); save(); } },
    lookup: (id) => { const d = list.find((x) => x.id === id); return d ? d.secret : null; },
    name: (id) => { const d = list.find((x) => x.id === id); return d ? d.name : null; },
  };
}

module.exports = { createStore };
