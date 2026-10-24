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
