'use strict';

/**
 * Builds the Windows desktop installers (NSIS + portable exe) with
 * electron-builder, signed by the self-signed certificate in .freebuff/.
 *
 *   1. powershell -ExecutionPolicy Bypass -File scripts/setup-windows-cert.ps1
 *   2. node scripts/build-win-signed.js
 *
 * Set CSC_LINK / CSC_KEY_PASSWORD to override the default certificate (use a
 * CA-issued one for a public release). Without a certificate this script tells
 * you how to create one — the installers can also be built unsigned with
 * plain `npm run app:win`.
 *
 * Retries because the toolchain downloads (nsis, winCodeSign) can fail on a
 * flaky connection.
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
const defaultPfx = path.join(ROOT, '.freebuff', 'wireless-code-sign.pfx');

const pfx = process.env.CSC_LINK || (fs.existsSync(defaultPfx) ? defaultPfx : null);
if (!pfx) {
  console.error('No certificate found. Create one first:');
  console.error('  powershell -ExecutionPolicy Bypass -File scripts/setup-windows-cert.ps1');
  console.error('or set CSC_LINK / CSC_KEY_PASSWORD to an existing .pfx.');
  process.exit(1);
}

const env = {
  ...process.env,
  CSC_LINK: pfx,
  CSC_KEY_PASSWORD: process.env.CSC_KEY_PASSWORD || 'wirelesspass',
};

const sleep = (ms) => execSync(`node -e "setTimeout(() => {}, ${ms})"`);

for (let attempt = 0; attempt < 15; attempt++) {
  try {
    execSync(`node "${cli}" --win nsis portable`, { cwd: ROOT, stdio: 'inherit', timeout: 1200000, env });
    console.log('\nSigned Windows installers → dist-electron/');
    process.exit(0);
  } catch {
    console.log(`attempt ${attempt + 1} failed — retrying in 8s`);
    sleep(8000);
  }
}
process.exit(1);
