'use strict';

// Builds downloadable bundles of the app entirely in memory, with zero
// dependencies: a minimal ZIP writer (deflate via node's zlib) plus a
// per-platform packaging step. The desktop "app" is the Node server itself,
// so each bundle is the server code + its deps + a double-clickable start
// script for that OS. A built APK (android/app/build/outputs) is also
// detected and can be served directly.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const PKGED = !!process.pkg; // true when running inside a pkg-built executable

/* ------------------------------------------------------------------ */
/* Minimal ZIP writer                                                  */
/* ------------------------------------------------------------------ */

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

function dosDateTime(d) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const date =
    ((((d.getFullYear() - 1980) & 0x7f) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

/**
 * Build a ZIP file from entries: [{ name, data, mode }].
 * mode is a unix permission value (0o755 for executables) — stored in the
 * central directory so *nix extractors restore the exec bit.
 */
function buildZip(entries) {
  const { time, date } = dosDateTime(new Date());
  const chunks = [];
  const central = [];
  let offset = 0;

  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8');
    const data = Buffer.isBuffer(e.data) ? e.data : Buffer.from(String(e.data), 'utf8');
    const crc = crc32(data);
    const comp = zlib.deflateRawSync(data, { level: 9 });

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // local file header signature
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // method: deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // extra length
    chunks.push(local, name, comp);

    const mode = e.mode || 0o644;
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); // central directory header signature
    c.writeUInt16LE((3 << 8) | 20, 4); // version made by: unix
    c.writeUInt16LE(20, 6);
    c.writeUInt16LE(0, 8);
    c.writeUInt16LE(8, 10);
    c.writeUInt16LE(time, 12);
    c.writeUInt16LE(date, 14);
    c.writeUInt32LE(crc, 16);
    c.writeUInt32LE(comp.length, 20);
    c.writeUInt32LE(data.length, 24);
    c.writeUInt16LE(name.length, 28);
    c.writeUInt16LE(0, 30); // extra
    c.writeUInt16LE(0, 32); // comment
    c.writeUInt16LE(0, 34); // disk number
    c.writeUInt16LE(0, 36); // internal attrs
    c.writeUInt32LE((mode & 0xffff) << 16, 38); // external attrs (unix mode)
    c.writeUInt32LE(offset, 42);
    central.push(c, name);

    offset += local.length + name.length + comp.length;
  }

  const cdSize = central.reduce((n, b) => n + b.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0); // end of central directory signature
  eocd.writeUInt16LE(0, 4); // disk number
  eocd.writeUInt16LE(0, 6); // disk with central directory
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20); // comment length

  return Buffer.concat([...chunks, ...central, eocd]);
}

/* ------------------------------------------------------------------ */
/* File collection                                                     */
/* ------------------------------------------------------------------ */

// Recursively collect files under dir as { name, data, mode } entries with
// forward-slash paths. skip(name, parentRel) may veto items.
function walk(dir, rel, out, skip) {
  let items;
  try {
    items = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const it of items) {
    if (skip && skip(it.name, rel)) continue;
    const abs = path.join(dir, it.name);
    const name = rel ? rel + '/' + it.name : it.name;
    if (it.isDirectory()) {
      walk(abs, name, out, skip);
    } else {
      try {
        out.push({ name, data: fs.readFileSync(abs), mode: 0o644 });
      } catch {
        /* unreadable — skip */
      }
    }
  }
}

const START_SH = `#!/bin/sh
cd "$(dirname "$0")"
if ! command -v node >/dev/null 2>&1; then
  echo
  echo "Node.js is required. Install it from https://nodejs.org then run this again."
  echo
  read -p "Press Enter to exit..." _
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "First run: installing dependencies..."
  npm install --no-audit --no-fund || {
    echo "npm install failed. Check your internet connection and try again."
    read -p "Press Enter to exit..." _
    exit 1
  }
fi
exec node server.js
`;

const START_BAT = `@echo off
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo  Node.js is required. Install it from https://nodejs.org
  echo  then run this file again.
  echo.
  pause
  exit /b 1
)
if not exist node_modules (
  echo First run: installing dependencies...
  call npm install --no-audit --no-fund
  if errorlevel 1 (
    echo npm install failed. Check your internet connection and try again.
    pause
    exit /b 1
  )
)
node server.js
pause
`;

const ANDROID_BUILD_MD = `# Building the Wireless Android app

1. Open the \`android/\` folder in Android Studio (latest stable).
2. Let Gradle sync finish, then press Run on a connected phone or emulator,
   or choose Build > Build Bundle(s)/APK(s) > Build APK(s).
3. The APK lands in \`android/app/build/outputs/apk/debug/app-debug.apk\`.

The app has two modes:
- Bluetooth HID keyboard (phone types into the computer over classic Bluetooth)
- WiFi Remote (the laptop page of the server types into this phone)

Serve this folder from the app's download site and the APK becomes available
automatically on the Downloads page.
`;

const PLATFORMS = {
  windows: {
    id: 'windows',
    label: 'Windows',
    icon: '🪟',
    filename: 'wireless-windows.zip',
    script: 'start.bat',
    scriptText: START_BAT,
  },
  linux: {
    id: 'linux',
    label: 'Linux',
    icon: '🐧',
    filename: 'wireless-linux.zip',
    script: 'start.sh',
    scriptText: START_SH,
    exec: true,
  },
  macos: {
    id: 'macos',
    label: 'macOS',
    icon: '🍎',
    filename: 'wireless-macos.zip',
    script: 'Wireless.command',
    scriptText: START_SH,
    exec: true,
  },
  'android-source': {
    id: 'android-source',
    label: 'Android app (source)',
    icon: '🤖',
    filename: 'wireless-android-source.zip',
  },
};

// Server bundle: code + deps + start script. Only the production dependency
// closure (ws + qrcode + their deps) is bundled — never the dev toolchain
// (electron, etc.), which can be gigabytes. Pure-JS deps are safe to bundle
// across OSes and make the zip run without an npm install step.
function serverEntries(platform) {
  const out = [];
  for (const f of ['server.js', 'package.json', 'README.md']) {
    try {
      out.push({ name: f, data: fs.readFileSync(path.join(ROOT, f)), mode: 0o644 });
    } catch {
      /* missing file — skip */
    }
  }
  walk(path.join(ROOT, 'lib'), 'lib', out);
  walk(path.join(ROOT, 'public'), 'public', out);

  // Walk only the runtime deps (recursively, so nested installs are covered).
  const prod = new Set();
  function add(name) {
    if (prod.has(name)) return;
    prod.add(name);
    try {
      const pkg = require(path.join(ROOT, 'node_modules', name, 'package.json'));
      for (const d of Object.keys(pkg.dependencies || {})) add(d);
    } catch {
      /* not installed — skip */
    }
  }
  add('ws');
  add('qrcode');
  for (const name of prod) {
    const dir = path.join(ROOT, 'node_modules', name);
    if (fs.existsSync(dir)) {
      walk(dir, 'node_modules/' + name, out, (child) => child === '.bin');
    }
  }

  out.push({ name: platform.script, data: platform.scriptText, mode: platform.exec ? 0o755 : 0o644 });
  return out;
}

function androidSourceEntries() {
  const out = [];
  walk(path.join(ROOT, 'android'), 'android', out, (name) =>
    name === 'build' || name === '.gradle' || name === '.idea' || name === 'local.properties'
  );
  out.push({ name: 'BUILD.md', data: ANDROID_BUILD_MD, mode: 0o644 });
  return out;
}

/* ------------------------------------------------------------------ */
/* Public API                                                          */
/* ------------------------------------------------------------------ */

function humanSize(n) {
  if (n < 1024) return n + ' B';
  const units = ['KB', 'MB', 'GB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return v.toFixed(1) + ' ' + units[i];
}

// Find the most complete built APK, if any.
function findApk() {
  const base = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk');
  if (!fs.existsSync(base)) return null;
  const found = [];
  (function scan(dir, depth) {
    if (depth > 4) return;
    let items;
    try {
      items = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const it of items) {
      const abs = path.join(dir, it.name);
      if (it.isDirectory()) scan(abs, depth + 1);
      else if (it.name.endsWith('.apk')) {
        try {
          found.push({ filename: it.name, abs, size: fs.statSync(abs).size });
        } catch {
          /* skip */
        }
      }
    }
  })(base, 0);
  if (!found.length) return null;
  // Prefer a release build (signed, shippable) over a debug one; within the
  // same kind, take the largest.
  const rank = (f) => (/[\\/]release[\\/]/.test(f.abs) ? 1 : 0);
  found.sort((a, b) => rank(b) - rank(a) || b.size - a.size);
  return found[0];
}

const cache = new Map();

// Build (and cache) one platform bundle. Returns { data, info } or null.
// Inside a pkg-built executable the source + node_modules aren't on disk
// (they're baked into the binary), so zips can't be built there.
function buildPlatform(id) {
  if (cache.has(id)) return cache.get(id);
  const p = PLATFORMS[id];
  if (!p || PKGED) return null;
  const data = id === 'android-source' ? buildZip(androidSourceEntries()) : buildZip(serverEntries(p));
  const info = { ...p, size: data.length, human: humanSize(data.length) };
  cache.set(id, { data, info });
  return cache.get(id);
}

// Metadata for every platform (builds all bundles once, for the sizes).
function listDownloads() {
  return Object.keys(PLATFORMS).map((id) => buildPlatform(id).info);
}

// Installers produced by `npm run build` (scripts/build-installers.js) into
// dist/ and the Electron desktop app (npm run app:win) into dist-electron/.
// Returns { windows, windowsPortable, linux, macos: { arm64, x64 } } — each
// value is { filename, abs, size, human } or null when not built.
function findInstallers() {
  const get = (abs, filename) => {
    try {
      const st = fs.statSync(abs);
      if (st.isFile()) {
        return { filename, abs, size: st.size, human: humanSize(st.size) };
      }
    } catch {
      /* not built */
    }
    return null;
  };
  const distFile = (name) => get(path.join(DIST, name), name);

  // The Electron desktop app (dist-electron/): a real desktop app with a
  // native window + tray, for all three OS families. Windows uses the NSIS
  // installer (preferred) + portable exe; Linux uses the AppImage (preferred)
  // + tar.gz; macOS ships as per-arch .app zips assembled into dist/.
  const electronDir = path.join(ROOT, 'dist-electron');
  let entries = [];
  if (fs.existsSync(electronDir)) {
    try {
      entries = fs.readdirSync(electronDir).filter((n) => !/^win-unpacked$|^linux-unpacked$|^mac/.test(n));
    } catch {
      /* ignore */
    }
  }
  entries.sort(); // alphabetical — versioned artifacts sort sensibly
  const newest = (re) => {
    for (let i = entries.length - 1; i >= 0; i--) if (re.test(entries[i])) return entries[i];
    return null;
  };
  const electronFile = (re) => {
    const name = newest(re);
    return name ? get(path.join(electronDir, name), name) : null;
  };

  const windowsInstaller = electronFile(/setup.*\.exe$/i);
  const windowsPortable = electronFile(/portable.*\.exe$/i);
  const linuxAppImage = electronFile(/\.AppImage$/i);
  const linuxArchive = electronFile(/\.tar\.gz$/i);

  return {
    windows: windowsInstaller || distFile('Wireless.exe'),
    windowsPortable,
    // Linux prefers the double-clickable AppImage; the tar.gz is the
    // always-buildable fallback (AppImage creation needs symlink support,
    // which is unavailable when cross-building on Windows).
    linux: linuxAppImage || linuxArchive || distFile('wireless-linux-x64'),
    linuxArchive,
    linuxAppImage,
    macos: {
      arm64: distFile('Wireless-macOS-arm64.zip'),
      x64: distFile('Wireless-macOS-x64.zip'),
    },
    // electron-builder's update feed (used by the in-app auto-updater).
    updateFeed: get(path.join(electronDir, 'latest.yml'), 'latest.yml'),
  };
}

module.exports = { PLATFORMS, listDownloads, buildPlatform, findApk, findInstallers, buildZip, humanSize };