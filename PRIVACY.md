# UltraCast privacy notice

Draft written from how the app actually works (version laptop 0.9.1 / Android 0.9.7). This is not legal advice. Before any public release a lawyer should review it, and the Google Play data declaration must match it.

## The short version
UltraCast has no accounts, no cloud, no analytics and no advertising. Your phone and laptop talk directly to each other over your own Wi-Fi or hotspot. Nothing about you or your screen is sent to the developer or to any server.

## What goes between your devices
Your screen picture, the phone's sound (if you turn it on), taps and typing, copied text, and files you choose to send. It travels only between the two paired devices on your local network, encrypted by WebRTC. Nothing is recorded or saved by the app, except files you choose to receive (saved in the UltraCast folder in Downloads, or where you pick).

## What the app keeps on each device
- Your settings (theme, touch style, and similar).
- The list of devices you trusted, with a secret used to prove it is really that device. On the phone this list is encrypted. On the laptop (from 0.8.9) it is stored in your user profile folder and protected by Windows' own encryption for your Windows account, so another Windows user or a copied file cannot read it. Removing a device deletes its entry. If Windows encryption is not available, it is kept as a plain file in that folder.
- A short step log used for troubleshooting (phone: Settings > Advanced > Screen sharing log; laptop: Settings > Show phone-screen log). It is kept in memory only and is cleared when the app closes. It records steps and error names, never screen contents. It is written to a file only if you press "Save both as a file" on the laptop.

## Permissions the phone app asks for, and why
- Screen capture: to show your phone screen on the laptop. Android asks you every time.
- Accessibility: so the laptop can tap, swipe, type, lock and open the power menu on your phone. Off until you turn it on in Android settings.
- Microphone permission: only because Android requires it to capture the phone's own sound. The app does not record the microphone.
- Display over other apps: to turn the screen to landscape or portrait and to dim it.
- Notifications and battery: so the link keeps running in the background.
- Network: to talk to the laptop on your local network.

## What the laptop app does on your computer
It can show your screen to a paired phone, and, only after you approve each time (default), let the phone click and type. Ctrl+Alt+J stops it at once. It also keeps the laptop awake while a phone is connected and can draw a black cover over your screen; Ctrl+Alt+K removes the cover.

## Third parties
None. The font (Jost) is bundled inside the apps and are not loaded from the internet. It is published under the SIL Open Font License 1.1; the license text is included with the apps.

## Your control
Delete a trusted device in Devices (both apps). Uninstall the app to remove its saved data. Received files are ordinary files in your Downloads folder.

## Contact
Add the developer's contact details here before release. (Not written yet.)
