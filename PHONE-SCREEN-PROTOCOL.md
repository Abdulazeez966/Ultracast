# Phone screen on the laptop ("call B") - contract between the laptop app and the Android app

Everything travels over the existing laptop front desk (server.js `signal` relay, unchanged) and WebRTC.
Call A (laptop screen to phone, lanes input/files/pair) is unchanged. Call B is a SECOND, independent call.

## Who offers
The PHONE offers call B (it is the one with a screen to share). The laptop answers.
Signal envelopes carry `call: 'b'`:
  `{ call: 'b', sdp: {type, sdp} }`   `{ call: 'b', candidate: {...} }`
Call A envelopes have no `call` field (as today). The laptop must keep two separate RTCPeerConnections.

## Control messages that travel on the signal relay (before/after the call), `ctl` field, both directions
  laptop -> phone  `{ ctl: 'share-request' }`   the laptop asks the phone to start sharing its screen
  laptop -> phone  `{ ctl: 'share-stop' }`       the laptop asks the phone to stop
  phone  -> laptop `{ ctl: 'share-denied' }`     the phone owner said no (or cannot right now)
  phone  -> laptop `{ ctl: 'share-stopped' }`    the phone stopped sharing (call B will close)
The phone only ever starts call B after its owner pressed Allow on the phone. The laptop never forces it.

## Lane "pctl" (created by the phone as an ordered data channel in call B; JSON text, each message <= 1024 chars)
phone -> laptop, sent right after the lane opens and again whenever something changes:
  `{ t: 'hello', w: <screen px>, h: <screen px>, ctl: <true if the phone can be controlled right now> }`
laptop -> phone (only when the laptop user is controlling; x,y are 0..1 of the phone picture, top-left origin):
  `{ t: 'tap',   x, y }`
  `{ t: 'long',  x, y }`                          long press (right-click on the laptop)
  `{ t: 'swipe', x1, y1, x2, y2, ms }`            ms 50..3000. Mouse drag and wheel scrolling both become swipes
  `{ t: 'nav',   k: 'back'|'home'|'recents'|'notifications' }`
  `{ t: 'text',  s: '<up to 200 chars>' }`        insert text into the focused field
  `{ t: 'key',   k: 'Backspace'|'Enter' }`
The phone ignores anything else, anything oversized, and everything while its accessibility control is off.
The phone picture itself is video only (no sound in this version; flagged as a known gap).

## Laptop-side rules
- Only an authorized (trusted) phone may use call B; ignore call-B signals otherwise.
- Closing call A, disconnecting the phone, or the phone leaving closes call B.
- The laptop sends control messages only while its own UI shows "controlling the phone".

## Added in 0.7.0 / 0.8.0 (messages on call A's `input` lane, JSON, up to 16384 chars)
  both      `{ t:'clip', s }`                      copied text (<= 6000 chars) to put on the other device's clipboard
  phone -> laptop `{ t:'power', a:'lock'|'sleep'|'restart'|'shutdown' }`, answered by `{ t:'power-result', a, ok, reason }`
  laptop -> phone `{ t:'power-ask', a:'lock'|'menu' }`, answered by `{ t:'power-answer', a, ok, note }`
  laptop -> phone `{ t:'rotate', m:'landscape'|'portrait'|'auto' }`, answered by `{ t:'rotate-result', ok, note }`
  pctl hello gains `rot` (true when the phone can be turned from the laptop).
## Signed call descriptions
For a trusted phone every SDP carries `mac` = HMAC-SHA256(secret, 'ultracast-sdp:' + role + ':' + type + ':' + sdp) hex, role 'host' (laptop) or 'phone', type 'offer' or 'answer'. Descriptions without a correct `mac` are ignored. Untrusted (new-device) pairing calls are unsigned; the 4-digit number protects them.

## Phone sound (0.7.1 / 0.8.1)
The phone adds a second lane to call B: `paudio`, unordered, maxRetransmits 0, binary. Each message: byte 0 = 1 (version), bytes 1-2 = counter (big endian, wraps), then raw sound: 16-bit little-endian stereo at 48000 Hz, 960 frames (20 ms) per message (at most 4800 frames, 8192 bytes in total). The laptop plays them with a short cushion. pctl `hello` gains `snd` (true when the phone is sending sound).

## Addendum: screen off (0.7.2)
Laptop to phone (input lane): `{t:'awake', m:'on'|'dark'|'wake'|'off'}` answered by `{t:'awake-result', m, ok, note}`.
Phone to laptop: `{t:'cover', on:bool}` answered by `{t:'cover-result', on, ok, reason}` (also sent when Ctrl+Alt+K removes the cover).
State notices: phone sends `{t:'phone-state', locked}`; laptop sends `{t:'laptop-state', locked}`.
