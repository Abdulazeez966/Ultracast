# UltraCast (Windows laptop app)

Cast and control between an Android phone and a Windows laptop over the phone's hotspot. No internet, accounts or cloud.

## Run
    npm install
    npm start          # the Electron laptop app
    npm run package    # builds dist/UltraCast/ (UltraCast.exe on Windows), a folder to zip and double-click
    npm test           # server, quality, input and file tests (no browser needed)

Join the laptop to your phone's hotspot, press "New code", open the address on the phone, then "Share my screen".

## What works so far
1. Pairing server with one-time code and network safety limits
2. Screen and sound sharing with quality that adapts to the network
3. Phone controls the laptop (touch, right-click, drag, scroll, pinch, typing). Stop with the bar or Ctrl+Alt+J
4. File transfer both ways with receive prompt, same-name prompt, 1 GB warning and progress

## Layout
- `server.js` pairing server and relay
- `main.js`, `preload.js`, `renderer/` Electron app
- `public/viewer.html` the phone page (until the Android app exists)
- `inject.js` Windows mouse and keyboard input, `filesafe.js` safe file saving
- `test*.js` tests; `test-video.js`, `test-control.js`, `test-files-e2e.js` and `smoke-*.js` need Playwright and are developer-only

## Step 5: laptop window, matching number, trusted devices

- Run `npm start`. Open **Devices > Add new device**, open the shown address on the phone, compare the 4-digit number on both screens, then press **Yes, they match** on the laptop only.
- A trusted phone comes back later by opening the laptop's steady address (shown under Devices). No code, no number. Remove it under Devices to end its trust.
- Tests: `npm test` (unit), `xvfb-run -a node smoke-pairing.js` (full app flow, Linux) and the other `smoke-*.js` / `test-*.js` files.
- Not yet verified on real hardware: everything in this step (see the plan doc).
