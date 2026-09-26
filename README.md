# Phone Keyboard

Turn your phone into a wireless keyboard **and trackpad** for your laptop or desktop — **and**
turn your laptop keyboard into a remote for your phone.

| | **WiFi mode** (recommended, works today) | **Bluetooth mode** | **Laptop → phone** |
|---|---|---|---|
| What you install on the computer | Nothing — just Node.js, one command | Nothing | Just a browser (the `/laptop` page) |
| What you install on the phone | Nothing — any phone browser (installable as an app) | The Android app in `android/` (Android 9+) | The same Android app (WiFi Remote tab) |
| Needs | Same WiFi network | Bluetooth pairing (classic BT) | Same WiFi network |
| Keys, symbols, F-keys, arrows | ✅ | ✅ | ✅ |
| Mouse / trackpad | ✅ | ❌ | ✅ (tap/swipe/scroll on the phone) |
| Type long text / paste | ✅ (incl. emoji, any language) | ❌ | ✅ |
| Extra software on the computer | **None** — keys are injected with OS built-ins (PowerShell on Windows, osascript on macOS, xdotool on Linux) | **None** — the phone presents itself as a standard Bluetooth keyboard | **None** — the phone's own keyboard (IME) + accessibility service type and tap |

---

## 1. WiFi mode (phone browser → computer)

### On the computer

```bash
npm install
npm start
```

You will see a QR code, the PIN, and addresses like:

```
📱 Phone:  http://192.168.1.23:8030/
🖥️  Host page (QR + status): http://127.0.0.1:8030/host
🔑 PIN: 6151
```

### Connect the phone

- **Easy way:** open `http://127.0.0.1:8030/host` in the computer's browser. Point your
  phone camera at the QR code — it opens the keyboard page and connects automatically.
- **Manual way:** on the phone open `http://<computer-ip>:8030/` and type the PIN.

Then click into the window on the computer where you want to type, and type from the phone.

### Install it as an app

The phone page is a **PWA** — install it like a native app:

- **Android (Chrome):** menu → *Add to Home screen* / *Install app* (or tap the
  **⬇ Install** button in the app's top bar), then open it full-screen from the home screen.
- **iPhone (Safari):** Share → *Add to Home Screen*.

It keeps working offline (the keyboard layout is cached by the service worker); you still need
the server running on the computer to actually send keys.

### What the phone page gives you

- **Keys tab** — number row, QWERTY, symbols layer (`?123`), F-keys + shortcuts layer (`Ctrl+C/V`,
  `Alt+Tab`, …), arrow keys, `Esc`, `Tab`, `Del`, hold-to-repeat on `⌫`, arrows, space.
  Shift is one-shot (double-tap ⇧ for caps lock).
- **Mouse tab** — the screen becomes a trackpad: drag to move the cursor, tap to click,
  drag after moving to drag windows, two-finger drag scrolls; plus Left / Middle / Right buttons.
- **Text tab** — paste or type long text and it is typed on the computer. Unicode, emoji and
  other languages are handled automatically via clipboard paste.

### Notes per operating system

| OS | Mechanism | Requirements |
|---|---|---|
| **Windows** | PowerShell `SendKeys` + `mouse_event` (built in) | The window you type into must be **focused** and **not running as administrator** (same elevation as the terminal that runs `npm start`). |
| **macOS** | AppleScript System Events (built in) | Grant **Accessibility** permission to your terminal (System Settings → Privacy & Security → Accessibility). Mouse needs `brew install cliclick`. |
| **Linux** | `xdotool` | Needs an X server: `sudo apt install xdotool`. On Wayland run the terminal under XWayland or swap the driver for `ydotool`. |

Optional environment variables:

```bash
PORT=9000            # change the port
PIN=1234             # set a fixed PIN
KEYBOARD_DRIVER=mock # force the mock driver (logs keys, types nothing)
```

The PIN stops other devices on the same network from typing on your computer.
Clients are limited to 3. Type text is capped at 10,000 characters per message.

### Driver internals (why nothing extra is installed)

There are no native npm dependencies — only pure-JS `ws` and `qrcode`. Each OS driver sends
OS-native calls:

- `lib/drivers/windows.js` — one persistent `powershell.exe`; keys via
  `[System.Windows.Forms.SendKeys]::SendWait`, mouse via `user32!mouse_event`, unicode text
  via `Set-Clipboard` + `Ctrl+V`.
- `lib/drivers/macos.js` — `osascript` System Events `keystroke` / `key code`; mouse via
  `cliclick` when installed.
- `lib/drivers/linux.js` — `xdotool type` / `key` / `mousemove_relative`.
- `lib/drivers/mock.js` — logs every event (great for testing the UI without a desktop).

Keys are canonicalised in `lib/keymap.js` (US layout); every character the phone can send maps
to the correct key + Shift for the active OS.

---

## 2. Bluetooth mode (Android phone → computer)

The phone emulates a **standard Bluetooth keyboard**, so the computer needs **no software at all**.

### Build & install the app

1. Open the `android/` folder in **Android Studio** (it supplies the Gradle wrapper).
2. Let the sync finish, then press Run on your phone (or `Build → Build APK`).

> The Gradle wrapper jar is intentionally not committed; Android Studio generates it on first
> open. From the command line you can also run `gradle wrapper` then `./gradlew assembleDebug`.

### Connect

1. Turn on Bluetooth on the phone and on the computer.
2. Open the app → it registers a Bluetooth keyboard.
3. Tap **Scan** and tap your computer to pair it (accept the pairing dialog), **or** pair from the
   computer side: *Add Bluetooth device → Keyboard*, and pick the phone.
4. Once paired, tap your computer in the *Paired devices* list to connect.
5. Click a text field on the computer and type on the phone.

Notes:

- The computer must support Bluetooth keyboards (all laptops/desktops with Bluetooth do).
- If a connection drops repeatedly: forget the pairing on both sides, then pair again.
- The on-screen keyboard covers letters, digits, symbols, arrows, Tab, Esc, Del, Home/End/PgUp/PgDn
  and F1–F12 can be added via `HidUsage`.
- WiFi mode has the same *keyboard* UI as the Android app plus mouse and text modes — use it when
  Bluetooth pairing misbehaves.

---

## 3. Laptop → phone (reverse control)

Your laptop keyboard and trackpad control **your phone**: type into any app, tap/swipe/scroll,
and send Back/Home/Recents. The server already runs on the computer (from step 1), so both
pages share the same PIN.

### On the computer

Open the laptop page:

```
💻  Laptop page (type into your phone): http://127.0.0.1:8030/laptop
```

It shows in the top bar where input is going: **your phone** (when the app is connected) or
**this computer** (fallback — the laptop page then drives the local driver, e.g. a second
browser). The laptop page gives you:

- **Keys** — your physical keyboard works immediately (layout-aware, with Ctrl/Cmd/Alt combos,
  arrows, F-keys, hold-to-repeat) plus an on-screen keyboard.
- **Text** — paste anything; it is typed into the focused field on the phone.
- **Touch** — a miniature phone screen: tap to tap, drag to swipe, two fingers to scroll.
- The **☰** button sends phone navigation (Back, Home, Recents, notifications, quick settings).

### On the phone (Android)

1. Open the **Phone Keyboard** app → **WiFi Remote** tab.
2. Enter the computer's address (e.g. `192.168.1.23`) and the PIN shown by the server, tap **Connect**.
3. In **keyboard settings** (`Open keyboard settings`), enable and switch to **WiFi Remote keyboard**.
4. (Optional) In **accessibility settings** (`Open accessibility settings`) enable
   **WiFi Remote control** for Back/Home/Recents and Touch-mode gestures.
5. Tap into any text field on the phone — now type from the laptop page.

The app connects to the same `ws://<computer-ip>:<port>/ws` endpoint as the phone page and
identifies itself with `role: "receiver"`; the laptop page's input is forwarded to it. When no
phone is connected, laptop input falls back to the local driver instead. iOS can't inject keys
into other apps, so reverse control needs the Android app (or an ADB-based tool).

---

## Downloads site

While a host is running, `http://<host>:<port>/download` is a small site that packages the
app per OS, on the fly, with zero extra tooling:

- **Windows** — the **Wireless desktop app**: a real native app (Electron) with its own
  window and tray icon that runs the host in the background. The site serves an installer
  (`Wireless-Setup-<version>.exe`) and a portable no-install exe when they're built
  (`dist-electron/`, via `npm run app:win`), falling back to the standalone `Wireless.exe`.
- **Linux** — the **Wireless desktop app**: an AppImage where it can be built, otherwise
  the self-contained `Wireless-<version>.tar.gz` (unpack and run the `Wireless` binary —
  no install, no Node.js). Falls back to the in-memory server ZIP with a `start.sh`
  launcher (needs Node.js).
- **macOS** — the **Wireless desktop app** as two per-chip bundles, `Apple Silicon`
  (`arm64`) and `Intel` (`x64`); the site offers both explicitly since the browser can't
  tell the chips apart. Falls back to the server ZIP with a `Wireless.command` launcher.
- **Android** — if you've built the app (see below), the site serves the APK directly
  (`android/app/build/outputs/apk/**`); otherwise it offers the source as a ZIP with
  `BUILD.md`. Built APKs appear automatically — no site changes needed.
- **iPhone / iPad** — the PWA (installable from the phone's browser), no download required.

The bundles are built in memory by `lib/bundler.js` (a dependency-free ZIP writer) and
served from `/api/downloads` + `/download/<platform>`. Anything in `dist/` or
`dist-electron/` takes priority over the on-the-fly zips — the site always serves the
newest installer.

### The desktop app (Windows, Linux, macOS)

`npm run app` runs the desktop app in development; `npm run app:win` builds it with
`electron-builder` into `dist-electron/` (an NSIS installer + a portable exe). The same
`desktop/main.js` runs on every OS, so `electron-builder --linux` / `--mac` produce the
AppImage/tar.gz and the `.app` bundles for their platforms. The app embeds the Wireless
server, opens the `/desktop` dashboard in a native window (live PIN, QR, connection stats,
driver status) and keeps running in the system **tray** when the window is closed —
closing the window never disconnects your phone.

**Code signing (Windows).** `scripts/setup-windows-cert.ps1` creates a self-signed
code-signing certificate and exports it to `.freebuff/` (gitignored — never commit a
private key). Build a signed release by pointing `electron-builder` at it:

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-windows-cert.ps1
$env:CSC_LINK = "$PWD\.freebuff\wireless-code-sign.pfx"
$env:CSC_KEY_PASSWORD = 'wirelesspass'
npm run app:win
```

A self-signed signature gives the installer a stable, verifiable publisher identity, but
SmartScreen still warns until the certificate is trusted (or a CA-issued one is used).

**Auto-update.** The app uses `electron-updater`: it checks a few seconds after launch and
every 6 hours, downloads quietly, and installs on quit — a live host session is never
interrupted. The feed is the `generic` provider from `build.publish`, overridable at
runtime with `WIRELESS_UPDATE_URL`. Any host exposes that feed at `/downloads/`
(`latest.yml` + the installer from `dist-electron/`), so one machine can act as an update
mirror for the others.

**Build shortcuts.** `npm run app:linux` builds the Linux targets; `npm run app:win:signed`
builds the signed Windows installers (it wraps `scripts/build-win-signed.js` and retries
flake-prone toolchain downloads); `npm run android:release` runs
`scripts/build-apk-release.js`, which builds the signed release APK and copies it to
`dist/Wireless.apk`.

**Android release APK.** The debug/release split lives in `android/app/build.gradle`: a
release build signs with `android/keystore.properties` (create the keystore with
`scripts/setup-release-keystore.ps1`). `findApk()` prefers a release APK over a debug one,
so once a release APK exists the site serves the signed build automatically.

### Building real installers

`npm run build` (`scripts/build-installers.js`) writes everything into `dist/`:

- **Desktop binaries** — `@yao-pkg/pkg` bakes the server + dependencies + pages into a
  single native executable per platform (needs to fetch its base binaries from GitHub on
  first run). If GitHub is unreachable, the script **falls back to Node's built-in SEA
  (Single Executable Application)** on Windows: `esbuild` bundles the whole app and the
  blob is injected into a copy of `node.exe` → `dist/Wireless.exe`, a real standalone
  Windows executable. Run `npm run build -- --sea` to force the SEA path.
- **Android APK** — when a JDK 17+ and the Android SDK are available (`ANDROID_HOME` or
  `android/local.properties`), Gradle builds `dist/Wireless.apk`. The one-time toolchain
  setup: install Temurin 17, then
  `sdkmanager "platform-tools" "platforms;android-34" "build-tools;34.0.0"` (and accept
  licenses with `sdkmanager --licenses`).

---

## Development

```bash
npm test        # unit + protocol tests (19 tests, uses the mock driver)
```

- `npm start` then open `http://127.0.0.1:8030/host` — full UI on one machine.
- `KEYBOARD_DRIVER=mock npm start` runs without any real input injection.

## Troubleshooting

| Problem | Fix |
|---|---|
| Keys go nowhere / wrong window | Click the target window first — keys are injected into the **focused** window. |
| Windows: nothing types into admin apps | Run the terminal (and the app) with the **same elevation** as the target app. |
| macOS: keystrokes refused | Grant Accessibility permission to the terminal and restart it. |
| Phone can't reach the page | Same WiFi network (not guest/isolation mode); allow Node through the firewall (TCP port shown on startup). |
| Keys type wrong characters | The character table assumes a **US keyboard layout** on the computer. |
| Two phones fighting | Only one client sends at a time; max 3 clients, each needs the PIN. |
| Bluetooth pairs but doesn't connect | Forget the device on both sides, restart the phone app, pair again. |
| Laptop page types into this computer, not the phone | The phone app isn't connected as a receiver — check its WiFi Remote tab. |
| Laptop keys don't land on the phone | Make sure the **WiFi Remote keyboard** is the active keyboard and a text field is focused; check the app's status line. |
