'use strict';
// Power actions on the laptop (lock / sleep / restart / shut down), asked for by the trusted phone.
// Safety: only four fixed actions exist, each maps to a fixed command (nothing from the phone is ever put
// into a command line), and the laptop's owner must press the action's button on a dialog (default = Cancel).
const { execFile } = require('child_process');

const ACTIONS = {
  lock:     { label: 'Lock the laptop',      cmd: 'rundll32.exe', args: ['user32.dll,LockWorkStation'], ask: false },
  sleep:    { label: 'Put the laptop to sleep', cmd: 'rundll32.exe', args: ['powrprof.dll,SetSuspendState', '0,1,0'], ask: true },
  restart:  { label: 'Restart the laptop',   cmd: 'shutdown.exe', args: ['/r', '/t', '5'], ask: true },
  shutdown: { label: 'Shut down the laptop', cmd: 'shutdown.exe', args: ['/s', '/t', '5'], ask: true },
};

function createPower(opts) {
  const o = opts || {};
  const platform = o.platform || process.platform;
  const exec = o.exec || ((cmd, args, cb) => execFile(cmd, args, { windowsHide: true }, (err) => cb(err)));
  const confirm = o.confirm || (async () => false);
  let busy = false;
  return {
    actions: () => Object.keys(ACTIONS),
    async run(action) {
      if (typeof action !== 'string' || !Object.prototype.hasOwnProperty.call(ACTIONS, action)) return { ok: false, reason: 'Unknown action' };
      if (platform !== 'win32') return { ok: false, reason: 'Power actions only work on Windows' };
      if (busy) return { ok: false, reason: 'Another power action is waiting' };
      busy = true;
      try {
        const a = ACTIONS[action];
        // Every action is confirmed on the laptop; lock is harmless so it only needs the phone's tap.
        if (a.ask && !(await confirm(action, a.label))) return { ok: false, reason: 'Cancelled on the laptop' };
        await new Promise((res, rej) => exec(a.cmd, a.args, (err) => (err ? rej(err) : res())));
        return { ok: true };
      } catch (e) {
        return { ok: false, reason: 'Could not do that: ' + (e && e.message ? e.message : e) };
      } finally { busy = false; }
    },
  };
}
module.exports = { createPower, ACTIONS };
