'use strict';

/**
 * Builds the signed Android release APK and copies it to dist/Wireless.apk.
 *
 * Needs a JDK 17 and the Android SDK. Configure them either via the
 * conventional environment variables:
 *
 *   JAVA_HOME     e.g. C:\Program Files\Eclipse Adoptium\jdk-17.0.20.1+1
 *   ANDROID_HOME  e.g. %LOCALAPPDATA%\Android\Sdk
 *
 * or by creating android/local.properties with `sdk.dir=<path>` (Android
 * Studio writes that file for you). The signing key comes from
 * android/keystore.properties — run scripts/setup-release-keystore.ps1 once to
 * create it.
 *
 *   node scripts/build-apk-release.js
 */

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const ANDROID = path.join(ROOT, 'android');

function fail(msg) {
  console.error('\n' + msg + '\n');
  process.exit(1);
}

const javaHome = process.env.JAVA_HOME;
const androidHome = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT;

if (!javaHome || !fs.existsSync(javaHome)) {
  fail('Set JAVA_HOME to a JDK 17+ installation (current: ' + (javaHome || 'unset') + ').');
}
if (!androidHome || !fs.existsSync(androidHome)) {
  fail('Set ANDROID_HOME (or ANDROID_SDK_ROOT) to your Android SDK (current: ' + (androidHome || 'unset') + ').');
}
if (!fs.existsSync(path.join(ANDROID, 'keystore.properties'))) {
  fail('Missing android/keystore.properties — run: powershell -ExecutionPolicy Bypass -File scripts/setup-release-keystore.ps1');
}

const gradlew = process.platform === 'win32' ? 'gradlew.bat' : './gradlew';
const env = { ...process.env, JAVA_HOME: javaHome, ANDROID_HOME: androidHome, ANDROID_SDK_ROOT: androidHome };

console.log('Building the signed release APK…');
execSync(`"${gradlew}" assembleRelease --console=plain`, { cwd: ANDROID, env, stdio: 'inherit' });

const built = path.join(ANDROID, 'app', 'build', 'outputs', 'apk', 'release', 'app-release.apk');
if (!fs.existsSync(built)) fail('Gradle finished but ' + built + ' is missing.');
fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
const dest = path.join(ROOT, 'dist', 'Wireless.apk');
fs.copyFileSync(built, dest);
console.log('\nSigned release APK → ' + dest);
