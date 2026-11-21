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

## Making a Windows installer (like VLC or VS Code)

On the Windows laptop, in this folder: `npm install` then `npm run installer`.
Result: `dist-installer/UltraCast-Setup-0.5.0.exe` - double-click it to install (Start menu and desktop shortcut, uninstaller in Windows Settings).
Needs internet once, to fetch the installer tools. Windows SmartScreen will say "unknown publisher" because the installer is not code-signed (signing costs money); choose More info, then Run anyway.
Not yet verified on Windows.

## Phone screen on the laptop (laptop controls the phone) - laptop side

Protocol: `PHONE-SCREEN-PROTOCOL.md`. On the Control page choose "This laptop controls the phone", then "Ask phone to share".
Needs the UltraCast Android app; tested here with a fake phone page.
- Fast tests: `npm test` (includes `test-phonectl.js`, the mouse/keyboard to phone-message mapping).
- Full-app tests (Linux, need a virtual screen): `xvfb-run -a -s "-screen 0 1280x800x24" node smoke-phone.js` (also smoke-pairing.js, smoke-control.js, smoke-files.js, smoke-electron.js), and `node test-video.js`, `test-control.js`, `test-files-e2e.js`.

## Version 0.7.0 (2026-10-28) - the final build
- The phone's screen has its own page with a black square menu (3 cyan lines, top right): Back/Home/Recents/Notifications, turn the phone landscape/portrait/auto, Lock phone / phone power menu, send clipboard, Full screen (Esc leaves it), Float on top (small always-on-top window, keeps mouse control), stop.
- Power from the phone: Lock, Sleep, Restart, Shut down. Only trusted phones; Sleep/Restart/Shut down show a Cancel-by-default box on the laptop first.
- Copy and paste both ways (text, up to 6000 characters), switch in Settings. Text copied before the phone connected is not sent.
- Settings: "When sharing this laptop's screen" can ask which screen or window each time.
- Security: call descriptions are signed with the shared key in both directions (`sdpMacFor` in server.js); unsigned descriptions from a trusted phone are ignored. Needs Android app 0.8.0 (the web phone page is updated too).
- Tests: `npm test` now also runs test-power.js, test-pick.js, test-sdpmac.js; smoke-phone.js checks the new page, menu, full window and floating mode.

## Version 0.7.1 (2026-10-28)
- Plays this phone's sound (lane `paudio`, see PHONE-SCREEN-PROTOCOL.md). Menu on the phone-screen page: Phone sound on/off. Tests: test-pcmplayer.js, smoke-phone.js.

## 0.7.2: screens that go dark
- **Stay awake**: while a trusted phone is connected the laptop and its screen stay awake (Settings > "Keep this laptop awake"). Closing the lid or pressing the power button still sleeps Windows.
- **Hide laptop screen (black cover)**: from the phone menu, a black click-through window covers every display. Screen capture skips it, so the phone still sees and controls the real screen. Only while the phone has control. **Ctrl+Alt+K always removes it**; it also goes away when control ends or the phone leaves.
- **Phone screen dark options** in the laptop's menu: keep on / black out (lowest brightness, still working) / wake / let sleep.
- **Locks**: the laptop tells the phone when Windows locks ("laptop is locked"); the laptop shows "phone is locked" and you may tap its PIN through the mirror if Android shows it. No PIN or password is ever stored or typed for you, and nothing tries to get past the Windows lock.
- Not verified on real hardware: that Windows really leaves the cover out of capture.

## 0.7.3: fonts
Jost (Futura-style) for words and numbers (numbers use its tabular figures so digits do not jitter). Barlow was dropped in 0.8.9 because it is a grotesk and the font guide bans those.

## 0.7.4
Fixed: the installed app crashed at start with "Cannot find module ./power". power.js and pick.js were missing from the installer file list. A new test (test-package.js) now checks that every file the app loads is in the installer.

## 0.8.0: staying connected, and easier to use
- **Disconnects fixed**: the laptop no longer slows its window down when it is hidden or covered, waits about 45 seconds (three missed beats) before dropping a quiet phone, and lets the same trusted phone back in at once instead of refusing it as "busy". If sharing was on when the link dropped, it starts again by itself when the same phone returns within 3 minutes.
- **Control** is its own page in the left menu (switched on while a phone is connected).
- **Pairing code (QR)** under Add new device: it says only where this laptop is; the matching number is still required.
- The phone's web page uses the same fonts.

## 0.8.1 - self-check

Settings > **Run self-check** tests this laptop step by step (listening port and hotspot address, whether the phone can reach it, Windows Firewall, screen capture, hotkeys Ctrl+Alt+J/K, keep-awake, clipboard, tap/type component, folders, fonts, and a video-call loopback) and says what is wrong in plain words. **Test the black cover** flashes the cover for about a second and checks that screen capture still sees the real screen. **Copy report** puts the result on the clipboard to paste into the chat. Read-only; runs only fixed commands. Not yet run on real Windows.

## 0.8.2
Self-check: the clipboard test now retries (Windows can hold the clipboard briefly) and explains a real failure; the Firewall line reads "Domain ON, Private ON, Public ON".

## 0.8.3
Settings > **Copy phone-screen log**: every step of "this laptop looks at the phone" (request sent, what the phone answered, offer arrived and whether its signature matched, answer sent, picture arrived, link state). Use it together with the phone app's Settings > Advanced > Screen sharing log.

## 0.8.4
Settings: **Show phone-screen log** shows the log on screen (so it can be screenshotted), **Save both as a file** writes the self-check and the log to Downloads/UltraCast/ultracast-log.txt, and the copy buttons now copy through the app's main side (the window's own clipboard was not always allowed).

## 0.8.5
Clipboard fix. In this Electron version the clipboard functions return Promises. The code did not wait for them, so (1) laptop-to-phone copy sent nothing and (2) the self-check wrote the text "[object Promise]" into the laptop clipboard. All clipboard calls now wait. Phone-to-laptop copy was not affected.

## 0.8.6
Settings > **Developer tools** opens the window's DevTools (Console, Elements, Network) in its own window, for learning and finding errors.

## 0.8.7
Colors: the dark theme's navy is now neutral gray (background #121315, surface #1C1E21, raised #26282C, border #4A4E55, text #E9EAEC, muted #A1A5AD). The cyan accent and its glow are unchanged and stay on the active element only. Buttons and drop-downs get a stronger edge (--bd2) so they are easy to find. The light theme is unchanged. The phone web page, the always-on-top banner and the phone-screen menu use the same grays.

## 0.8.8 (design guides applied)
- Security (guide security-and-attacks.md, attack #19): the front desk now refuses WebSocket connections that come from another website (wrong Origin) or from a made-up host name (DNS rebinding). The Android app, the phone page and the laptop window still work. New test-origin.js.
- Glow only on active things (guide avoid-ai-look.md, color.md): primary buttons and the logo no longer glow. Active nav item, live card and live dot still do.
- Reduced motion (guide motion.md): the app follows the Windows "show animations" setting; the connection ring is drawn still and all transitions stop.
- Privacy and licenses (guide legal-and-trust.md): PRIVACY.md, a Privacy card in Settings, and the Jost OFL license text next to the font files.

## 0.8.9
- Barlow removed (it is a grotesk; the font guide bans those). Jost now does numbers too, with tabular figures.
- Motion (guide motion.md): the left menu highlight slides to the item you pick, the menu grows from its button, toasts pop in. All under 0.25 s, all off when Windows "show animations" is off.
- The trusted-phone list is now protected with Windows' own encryption (safeStorage). An old plain list is converted on first start. If it can't be opened (another Windows account) it is set aside and the phones simply pair again.

## 0.9.0
- New app icon (concept A, the ring): window and taskbar icon, installer and uninstaller icon (build/icon.ico), and the same ring as the logo in the side bar. Note: the app .exe itself keeps the default icon because signAndEditExecutable is off in package.json; the installer, shortcuts' window and the app window use the ring. Not built on Windows here.

## 0.9.1
- Light mode: the slight blue tint is gone; backgrounds, borders and text are now neutral gray (accent stays teal). The side-bar logo follows the accent colour in light mode.
- Pairing "No, they don't match": the four digits shake with a red edge for about 0.4 s, then the sheet closes (motion.md: motion as meaning). Skipped when animations are off.
- Removing a trusted phone: the row fades and the gap closes smoothly instead of the list jumping.
- Design guides were not changed (Rheo's instruction); glow stays only on what is live.
