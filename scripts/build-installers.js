'use strict';

// Builds standalone installers into dist/:
//
//   Wireless.exe                Windows x64 (standalone — no Node.js needed)
//   wireless-linux-x64          Linux x64   (standalone)
//   Wireless-macOS-arm64.zip    macOS Apple Silicon (.app bundle)
//   Wireless-macOS-x64.zip      macOS Intel            (.app bundle)
//   Wireless.apk                Android (only when an Android SDK is available)
//
// The desktop binaries are produced by @yao-pkg/pkg: the whole server (code +
// deps + public assets) is baked into a single native executable, so users
// download one file and double-click it. The macOS files are then wrapped in
// a proper .app bundle and zipped. The APK is built with Gradle when a JDK +
// Android SDK are available (set ANDROID_HOME / ANDROID_SDK_ROOT, or provide
// android/local.properties).

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { buildZip } = require('../lib/bundler');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const VERSION = require(path.join(ROOT, 'package.json')).version;

const PKG_BIN = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'pkg.cmd' : 'pkg');

function sh(cmd, opts = {}) {
  console.log('  $ ' + cmd);
  execSync(cmd, { stdio: 'inherit', cwd: ROOT, ...opts });
}

function ensureDist() {
  fs.mkdirSync(DIST, { recursive: true });
}

function infoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>Wireless</string>
  <key>CFBundleDisplayName</key>
  <string>Wireless</string>
  <key>CFBundleIdentifier</key>
  <string>app.wireless.keyboard</string>
  <key>CFBundleVersion</key>
  <string>${VERSION}</string>
  <key>CFBundleShortVersionString</key>
  <string>${VERSION}</string>
  <key>CFBundleExecutable</key>
  <string>Wireless</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>NSHighResolutionCapable</key>
  <true/>
  <key>NSHumanReadableCopyright</key>
  <string>Wireless — every device controls every device</string>
</dict>
</plist>
`;
}

// Wrap a pkg-produced macOS binary in a double-clickable Wireless.app and zip it.
function wrapMacApp(binPath, outZip) {
  console.log('\nWrapping ' + path.basename(binPath) + ' into ' + outZip + ' ...');
  const exeName = 'Wireless';
  const zip = buildZip([
    { name: 'Wireless.app/Contents/Info.plist', data: infoPlist(), mode: 0o644 },
    {
      name: 'Wireless.app/Contents/MacOS/' + exeName,
      data: fs.readFileSync(binPath),
      mode: 0o755, // keeps the executable bit through unzip on macOS
    },
  ]);
  fs.writeFileSync(path.join(DIST, outZip), zip);
  fs.unlinkSync(binPath); // raw binary no longer needed
  console.log('  wrote ' + outZip + ' (' + (zip.length / 1024 / 1024).toFixed(1) + ' MB)');
}

function buildDesktop() {
  const targets = [
    ['node20-win-x64', 'Wireless.exe'],
    ['node20-linux-x64', 'wireless-linux-x64'],
    ['node20-macos-arm64', 'Wireless-macOS-arm64'],
    ['node20-macos-x64', 'Wireless-macOS-x64'],
  ];
  for (const [t, out] of targets) {
    console.log('\nBuilding ' + t + ' -> dist/' + out + ' ...');
    sh(`"${PKG_BIN}" . --targets ${t} --output "${path.join(DIST, out)}"`);
    const st = fs.statSync(path.join(DIST, out));
    console.log('  wrote ' + out + ' (' + (st.size / 1024 / 1024).toFixed(1) + ' MB)');
  }
  wrapMacApp(path.join(DIST, 'Wireless-macOS-arm64'), 'Wireless-macOS-arm64.zip');
  wrapMacApp(path.join(DIST, 'Wireless-macOS-x64'), 'Wireless-macOS-x64.zip');
}

// Fallback for when pkg cannot fetch its base binaries (e.g. GitHub is
// unreachable): build a real standalone Wireless.exe with Node's built-in
// Single Executable Applications. Everything (server + deps + public assets)
// is baked in, so the exe runs on any Windows machine without Node.js.
function buildSeaWindows() {
  const tmp = path.join(DIST, '.sea');
  fs.mkdirSync(tmp, { recursive: true });
  const esbuild = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild');

  console.log('\nBuilding Wireless.exe with Node SEA (no external downloads)...');

  // 1. Embed public/ assets as base64 (the exe has no filesystem beside it).
  const assets = {};
  const walk = (dir, prefix) => {
    for (const f of fs.readdirSync(dir)) {
      const abs = path.join(dir, f);
      const rel = prefix + '/' + f;
      if (fs.statSync(abs).isDirectory()) walk(abs, rel);
      else assets[rel] = fs.readFileSync(abs).toString('base64');
    }
  };
  walk(path.join(ROOT, 'public'), '');
  const entry = [
    'globalThis.WIRELESS_SEA = true;',
    'globalThis.WIRELESS_ASSETS = ' + JSON.stringify(assets) + ';',
    'require(' + JSON.stringify(path.join(ROOT, 'server.js')) + ');',
  ].join('\n');
  fs.writeFileSync(path.join(tmp, 'entry.js'), entry);

  // 2. Bundle server + deps (ws, qrcode) into one CJS file.
  sh(`"${esbuild}" "${path.join(tmp, 'entry.js')}" --bundle --platform=node --target=node20 --format=cjs --outfile="${path.join(tmp, 'bundle.js')}"`);

  // 3. Produce the SEA blob from the bundle.
  fs.writeFileSync(
    path.join(tmp, 'sea-config.json'),
    JSON.stringify({
      main: path.join(tmp, 'bundle.js'),
      output: path.join(tmp, 'sea-prep.blob'),
      disableExperimentalSEAWarning: true,
    })
  );
  sh(`node --experimental-sea-config "${path.join(tmp, 'sea-config.json')}"`);

  // 4. Copy node.exe and inject the blob.
  const nodeExe = process.execPath;
  const out = path.join(DIST, 'Wireless.exe');
  fs.copyFileSync(nodeExe, out);
  const postject = path.join(ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'postject.cmd' : 'postject');
  sh(
    `"${postject}" "${out}" NODE_SEA_BLOB "${path.join(tmp, 'sea-prep.blob')}" --sentinel-fuse NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2`
  );
  fs.rmSync(tmp, { recursive: true, force: true });
  const st = fs.statSync(out);
  console.log('  wrote Wireless.exe (' + (st.size / 1024 / 1024).toFixed(1) + ' MB)');
}

function findGradle() {
  // Prefer an explicit toolchain, then a wrapper, then PATH.
  if (process.env.WIRELESS_GRADLE && fs.existsSync(process.env.WIRELESS_GRADLE)) {
    return process.env.WIRELESS_GRADLE;
  }
  const wrapper = path.join(ROOT, 'android', process.platform === 'win32' ? 'gradlew.bat' : 'gradlew');
  if (fs.existsSync(wrapper)) return wrapper;
  const onPath = process.platform === 'win32' ? 'gradle.bat' : 'gradle';
  try {
    execSync(onPath + ' --version', { stdio: 'ignore' });
    return onPath;
  } catch {
    return null;
  }
}

function buildApk() {
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;
  const localProps = path.join(ROOT, 'android', 'local.properties');
  if (!sdk && !fs.existsSync(localProps)) {
    console.log('\n⚠️  No Android SDK found (set ANDROID_HOME or android/local.properties) — skipping APK.');
    return;
  }
  const gradle = findGradle();
  if (!gradle) {
    console.log('\n⚠️  No Gradle found (set WIRELESS_GRADLE or add gradlew) — skipping APK.');
    return;
  }
  console.log('\nBuilding Android APK ...');
  const env = { ...process.env };
  if (sdk) env.ANDROID_HOME = sdk;
  sh(`"${gradle}" -p "${path.join(ROOT, 'android')}" assembleDebug`, { env });
  const apkDir = path.join(ROOT, 'android', 'app', 'build', 'outputs', 'apk', 'debug');
  const apk = path.join(apkDir, 'app-debug.apk');
  if (fs.existsSync(apk)) {
    fs.copyFileSync(apk, path.join(DIST, 'Wireless.apk'));
    console.log('  wrote Wireless.apk (' + (fs.statSync(apk).size / 1024 / 1024).toFixed(1) + ' MB)');
  } else {
    console.log('  ⚠️  Gradle finished but no app-debug.apk was produced.');
  }
}

function main() {
  console.log('Wireless installer build (v' + VERSION + ')');
  ensureDist();
  if (process.argv.includes('--sea')) {
    buildSeaWindows();
  } else {
    try {
      buildDesktop();
    } catch (e) {
      console.warn('\n⚠️  pkg build failed (' + (e && e.message ? e.message.split('\n')[0] : e) + ')');
      if (process.platform === 'win32') buildSeaWindows();
      else console.warn('   Only Windows SEA fallback is supported — skipping desktop binaries.');
    }
  }
  buildApk();
  console.log('\nDone. Installers in dist/:');
  for (const f of fs.readdirSync(DIST)) {
    const st = fs.statSync(path.join(DIST, f));
    console.log('  ' + f.padEnd(30) + (st.size / 1024 / 1024).toFixed(1) + ' MB');
  }
}

main();