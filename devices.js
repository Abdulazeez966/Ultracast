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

/*
  `codec` is optional: { encrypt(text) -> Buffer, decrypt(Buffer) -> text }. The app passes Windows' own
  protection (Electron safeStorage, which uses the current Windows user's key), so the file is unreadable to other
  Windows users or to a copied file. Without a codec the list is plain JSON (as in 0.8.8 and earlier).
  An old plain file is read once and rewritten protected. If a protected file cannot be opened (for example it
  came from another Windows account), it is set aside as .unreadable and the list starts empty: phones just pair again.
*/
const okEntry = (d) => d && typeof d.id === 'string' && typeof d.secret === 'string' && typeof d.name === 'string';

function createStore(file, codec) {
  let list = [];
  let migrate = false;
  try {
    const text = fs.readFileSync(file, 'utf8');
    const raw = JSON.parse(text);
    if (Array.isArray(raw)) { list = raw.filter(okEntry); migrate = !!codec && list.length > 0; }
    else if (raw && raw.v === 2 && typeof raw.enc === 'string') {
      try {
        const inner = JSON.parse(codec.decrypt(Buffer.from(raw.enc, 'base64')));
        if (Array.isArray(inner)) list = inner.filter(okEntry);
      } catch (e) {
        try { fs.renameSync(file, file + '.unreadable'); } catch (e2) { /* ignore */ }
      }
    }
  } catch (e) { /* first run: empty */ }

  function save() {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let out = JSON.stringify(list);
      if (codec) {
        try { out = JSON.stringify({ v: 2, enc: Buffer.from(codec.encrypt(JSON.stringify(list))).toString('base64') }); } catch (e) { /* keep plain rather than lose the list */ }
      }
      fs.writeFileSync(file + '.tmp', out, { mode: 0o600 });
      fs.renameSync(file + '.tmp', file);
    } catch (e) { /* best effort */ }
  }
  if (migrate) save();
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
