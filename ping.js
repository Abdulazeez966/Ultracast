'use strict';
/*
  UltraCast "who is there?" answer (step 6)

  The phone app finds the laptop by knocking on the doors of the hotspot network and asking
  "are you UltraCast?" (GET /ping). The laptop answers with a tiny note: its name, a public name tag,
  whether it is adding new phones right now, and which door to use.
  The note carries NO secrets: no codes, no keys, nothing a stranger could use to get in.
*/
const MAX_NAME = 40;

function note(info) {
  return JSON.stringify({
    a: 'ultracast', v: 1,
    port: info.port,
    name: String(info.name || 'Laptop').replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, MAX_NAME) || 'Laptop',
    open: !!info.open,   // true while "Add new device" is open on the laptop
    hid: /^[0-9a-f]{16}$/.test(String(info.hid || '')) ? info.hid : '',   // this laptop's public name tag, so a phone can tell laptops apart (not a secret)
  });
}

module.exports = { note };
