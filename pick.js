'use strict';
// "Ask which screen to share each time": turns the list of screens and windows into two small questions.
// ask(message, labels) shows a box with one button per label and resolves to the index pressed (or -1 for cancel).
const MAX_SCREENS = 4, MAX_WINDOWS = 8;
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

async function chooseSource(sources, primaryId, ask) {
  const list = Array.isArray(sources) ? sources : [];
  const screens = list.filter((s) => typeof s.id === 'string' && s.id.startsWith('screen:')).slice(0, MAX_SCREENS);
  const windows = list.filter((s) => typeof s.id === 'string' && s.id.startsWith('window:') && clip(s.name, 60)).slice(0, MAX_WINDOWS);
  if (!screens.length && !windows.length) return null;
  const labels = screens.map((s, i) => 'Screen ' + (i + 1) + (String(s.display_id) === String(primaryId) ? ' (main)' : ''));
  if (windows.length) labels.push('A single window...');
  const first = await ask('What should be shared?', labels);
  if (first < 0 || first >= labels.length) return null;
  if (first < screens.length) return screens[first];
  const wl = windows.map((w) => clip(w.name, 48));
  const second = await ask('Which window?', wl);
  if (second < 0 || second >= wl.length) return null;
  return windows[second];
}
module.exports = { chooseSource };
