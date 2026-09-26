'use strict';

/**
 * Assembles real macOS builds of the Wireless desktop app from the official
 * Electron darwin distributions — no macOS machine required.
 *
 *   node scripts/assemble-macos.js [arm64|x64|all]
 *
 * It takes a downloaded electron-v<version>-darwin-<arch>.zip, turns
 * Electron.app into Wireless.app (renaming the bundle + its main executable,
 * writing our Info.plist and a generated .icns), copies the Wireless app
 * (desktop/, lib/, public/, server.js + the production dependency closure)
 * into Contents/Resources/app, and zips the result into
 * dist/Wireless-macOS-<arch>.zip.
 *
 * The bundle is NOT code-signed (signing needs Apple tooling), so macOS
 * Gatekeeper will quarantine it on first run. The zip carries a
 * "Read me first.txt" with the two one-line fixes — see also README.md.
 *
 * Electron zips are looked up in, in order:
 *   $WIRELESS_ELECTRON_DARWIN_<ARCH>   (explicit path)
 *   /tmp/electron-darwin-<arch>.zip    (what .freebuff/launch.sh downloads)
 */

const { execSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const { buildZip } = require('../lib/bundler');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const TMP = os.tmpdir();
const VERSION = require(path.join(ROOT, 'package.json')).version;
const APP_ID = 'app.wireless.keyboard';

function zipPath(arch) {
  const env = process.env['WIRELESS_ELECTRON_DARWIN_' + arch.toUpperCase()];
  if (env && fs.existsSync(env)) return env;
  const guess = path.join(TMP, `electron-darwin-${arch}.zip`);
  if (fs.existsSync(guess)) return guess;
  return null;
}

/** Production dependency closure, same policy as the server zips. */
function prodDeps(roots) {
  const seen = new Set();
  const add = (name) => {
    if (seen.has(name)) return;
    seen.add(name);
    try {
      const pkg = require(path.join(ROOT, 'node_modules', name, 'package.json'));
      for (const d of Object.keys(pkg.dependencies || {})) add(d);
    } catch {
      /* not installed — skip */
    }
  };
  for (const r of roots) add(r);
  return [...seen];
}

/**
 * Read the symlink entries out of a ZIP (name -> target).
 *
 * Windows can't create symlinks without elevated privileges, so `unzip`
 * silently drops the ones inside Electron.app (the framework's
 * Versions/Current, Electron Framework, Resources, ...). We re-create them as
 * real symlink entries when we write our own zip, so the bundle macOS
 * receives is structurally identical to the official one.
 */
function readZipSymlinks(zipFile) {
  const buf = fs.readFileSync(zipFile);
  // End of central directory: scan back from the end (the comment is empty here).
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0 && i > buf.length - 66000; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('not a zip: ' + zipFile);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);

  const links = [];
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const extAttr = buf.readUInt32LE(p + 38);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const cmtLen = buf.readUInt16LE(p + 32);
    const localOff = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    if (((extAttr >>> 16) & 0xf000) === 0xa000) {
      // Local header -> entry data (the link target, usually store-only).
      const lnLen = buf.readUInt16LE(localOff + 26);
      const leLen = buf.readUInt16LE(localOff + 28);
      const method = buf.readUInt16LE(localOff + 8);
      const cSize = buf.readUInt32LE(localOff + 18);
      const start = localOff + 30 + lnLen + leLen;
      const raw = buf.subarray(start, start + cSize);
      const target = (method === 8 ? zlib.inflateRawSync(raw) : raw).toString('utf8');
      links.push({ name, target });
    }
    p += 46 + nameLen + extraLen + cmtLen;
  }
  return links;
}

function copyTree(from, to, skipDir) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (skipDir && skipDir(e.name)) continue;
    const src = path.join(from, e.name);
    const dst = path.join(to, e.name);
    if (e.isDirectory()) copyTree(src, dst, skipDir);
    else fs.copyFileSync(src, dst);
  }
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>Wireless</string>
  <key>CFBundleDisplayName</key><string>Wireless</string>
  <key>CFBundleIdentifier</key><string>${APP_ID}</string>
  <key>CFBundleExecutable</key><string>Wireless</string>
  <key>CFBundleIconFile</key><string>Wireless</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleVersion</key><string>${VERSION}</string>
  <key>CFBundleShortVersionString</key><string>${VERSION}</string>
  <key>CFBundleInfoDictionaryVersion</key><string>6.0</string>
  <key>LSMinimumSystemVersion</key><string>11.0</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.utilities</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSHumanReadableCopyright</key><string>Wireless — every device controls every device</string>
</dict>
</plist>
`;
}

/**
 * Build a minimal .icns: an 'icns' container of PNG-typed entries
 * (icp4 16, icp5 32, icp6 48, ic08 256, ic09 512). The 256 PNG comes out of
 * the .ico the icon generator writes; 512 from icon-512.png.
 */
function icns() {
  const sizes = [];
  const ico = path.join(ROOT, 'public', 'icon.ico');
  if (fs.existsSync(ico)) {
    const buf = fs.readFileSync(ico);
    const count = buf.readUInt16LE(4);
    const types = { 16: 'icp4', 32: 'icp5', 48: 'icp6', 256: 'ic08' };
    for (let i = 0; i < count; i++) {
      const off = 6 + i * 16;
      const w = buf.readUInt8(off) || 256;
      const len = buf.readUInt32LE(off + 8);
      const dataOff = buf.readUInt32LE(off + 12);
      if (types[w]) sizes.push({ type: types[w], data: buf.subarray(dataOff, dataOff + len) });
    }
  }
  const big = path.join(ROOT, 'public', 'icon-512.png');
  if (fs.existsSync(big)) sizes.push({ type: 'ic09', data: fs.readFileSync(big) });
  if (!sizes.length) return null;

  const parts = [];
  for (const s of sizes) {
    const head = Buffer.alloc(8);
    head.write(s.type, 0, 4, 'ascii');
    head.writeUInt32BE(s.data.length + 8, 4);
    parts.push(head, Buffer.from(s.data));
  }
  const body = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.write('icns', 0, 4, 'ascii');
  head.writeUInt32BE(body.length + 8, 4);
  return Buffer.concat([head, body]);
}

function readmeFirst() {
  return `Wireless for macOS — read me first
==================================

1. Drag "Wireless.app" into Applications, then open it.

2. macOS will refuse the first launch because the app is not signed with an
   Apple Developer certificate ("Wireless is damaged" / "cannot be opened").
   Fix it with either of these one-liners in Terminal:

     xattr -dr com.apple.quarantine /Applications/Wireless.app

   and, if it still refuses (Apple Silicon requires a valid signature):

     codesign --force --deep --sign - /Applications/Wireless.app

3. After that it opens normally: the dashboard shows the PIN, the QR code and
   the address your phone should open. Closing the window keeps it running in
   the menu bar so your phone keeps working.

Everything runs locally on your network — no account, no cloud.
`;
}

function assemble(arch) {
  const zip = zipPath(arch);
  if (!zip) {
    console.log(`• darwin ${arch}: no Electron zip found — skipping (set WIRELESS_ELECTRON_DARWIN_${arch.toUpperCase()})`);
    return null;
  }

  const work = fs.mkdtempSync(path.join(TMP, `wireless-${arch}-`));
  const extractDir = path.join(work, 'x');
  console.log(`\n${arch}: extracting ${path.basename(zip)} ...`);
  fs.mkdirSync(extractDir, { recursive: true });
  execSync(`unzip -q -o "${zip}" -d "${extractDir}"`, { stdio: 'inherit' });

  const electronApp = path.join(extractDir, 'Electron.app');
  if (!fs.existsSync(electronApp)) throw new Error('Electron.app missing from the archive');

  const app = path.join(work, 'Wireless.app');
  fs.renameSync(electronApp, app);

  // Symlinks dropped by `unzip` — recreated as real zip symlink entries below.
  const links = readZipSymlinks(zip);
  const linkByRel = new Map(
    links.map((l) => [l.name.replace(/^Electron\.app/, 'Wireless.app'), l.target])
  );
  console.log(`  ${links.length} symlink entries carried over`);

  // Rename the main executable and point the window title at our binary.
  const macosDir = path.join(app, 'Contents', 'MacOS');
  fs.renameSync(path.join(macosDir, 'Electron'), path.join(macosDir, 'Wireless'));

  fs.writeFileSync(path.join(app, 'Contents', 'Info.plist'), infoPlist());
  const icon = icns();
  if (icon) fs.writeFileSync(path.join(app, 'Contents', 'Resources', 'Wireless.icns'), icon);

  // Our app: exact source layout (relative paths keep working) + prod deps.
  const resApp = path.join(app, 'Contents', 'Resources', 'app');
  fs.mkdirSync(resApp, { recursive: true });
  for (const f of ['package.json', 'server.js', 'README.md']) {
    const src = path.join(ROOT, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(resApp, f));
  }
  for (const d of ['desktop', 'lib', 'public']) {
    copyTree(path.join(ROOT, d), path.join(resApp, d));
  }
  for (const name of prodDeps(['ws', 'qrcode', 'electron-updater'])) {
    const dir = path.join(ROOT, 'node_modules', name);
    if (fs.existsSync(dir)) copyTree(dir, path.join(resApp, 'node_modules', name));
  }
  fs.mkdirSync(DIST, { recursive: true });

  // Remove the pre-bundled default app so Electron loads ours.
  const defaultApp = path.join(app, 'Contents', 'Resources', 'default_app.asar');
  if (fs.existsSync(defaultApp)) fs.unlinkSync(defaultApp);

  // Zip the bundle, preserving the exec bits (buildZip stores unix modes).
  const entries = [];
  const emitted = new Set();
  (function walk(dir, prefix) {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, e.name);
      const rel = prefix + '/' + e.name;
      if (linkByRel.has(rel)) {
        // 0o120777 == symlink, which is how macOS extracts it back.
        entries.push({ name: rel, data: linkByRel.get(rel), mode: 0o120777 });
        emitted.add(rel);
        continue;
      }
      if (e.isDirectory()) {
        entries.push({ name: rel + '/', data: '', mode: 0o755 });
        emitted.add(rel + '/');
        walk(abs, rel);
      } else {
        const mode = /\/MacOS\//.test(rel) || /\.dylib$/.test(rel) ? 0o755 : 0o644;
        entries.push({ name: rel, data: fs.readFileSync(abs), mode });
        emitted.add(rel);
      }
    }
  })(app, 'Wireless.app');

  // Symlink paths that never landed on disk (unzip refused to create them)
  // still have to appear in the archive.
  let carried = 0;
  for (const [name, target] of linkByRel) {
    if (!emitted.has(name)) {
      entries.push({ name, data: target, mode: 0o120777 });
      carried++;
    }
  }
  console.log(`  re-created ${carried} symlink entries missing on disk`);
  entries.push({ name: 'Read me first.txt', data: readmeFirst(), mode: 0o644 });

  const outName = `Wireless-macOS-${arch}.zip`;
  const zipped = buildZip(entries);
  fs.writeFileSync(path.join(DIST, outName), zipped);
  fs.rmSync(work, { recursive: true, force: true });
  console.log(`  wrote dist/${outName} (${(zipped.length / 1024 / 1024).toFixed(1)} MB, ${entries.length} entries)`);
  return outName;
}

function main() {
  const want = (process.argv[2] || 'all').toLowerCase();
  const archs = want === 'all' ? ['arm64', 'x64'] : [want];
  const done = [];
  for (const a of archs) {
    try {
      const out = assemble(a);
      if (out) done.push(out);
    } catch (e) {
      console.error(`  ✗ ${a} failed: ${e.message}`);
    }
  }
  console.log('\nmacOS builds: ' + (done.length ? done.join(', ') : 'none'));
}

main();
