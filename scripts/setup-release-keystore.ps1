# Generates the Android release signing keystore (android/wireless-release.keystore)
# and android/keystore.properties. Both files are gitignored — run this once per
# machine, or roll your own and point keystore.properties at it.
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts/setup-release-keystore.ps1
$ErrorActionPreference = 'Stop'

$root = Split-Path -Parent $PSScriptRoot
$keytool = "$root\toolchain\jdk\bin\keytool.exe"
if (-not (Test-Path $keytool)) {
  # Fall back to any JDK on PATH (or JAVA_HOME)
  $keytool = Join-Path $env:JAVA_HOME 'bin\keytool.exe'
  if (-not (Test-Path $keytool)) { $keytool = 'keytool' }
}

$storeFile = "$root\android\wireless-release.keystore"
$pass = 'wirelesspass'

& $keytool -genkeypair -v `
  -keystore $storeFile `
  -alias wireless `
  -keyalg RSA -keysize 2048 -validity 10000 `
  -storepass $pass -keypass $pass `
  -dname 'CN=Wireless, OU=Wireless, O=Wireless, C=US' |
  Out-Host

@"
storeFile=wireless-release.keystore
storePassword=$pass
keyAlias=wireless
keyPassword=$pass
"@ | Set-Content -Path "$root\android\keystore.properties" -Encoding Ascii

Write-Host ''
Write-Host "Keystore written to android/wireless-release.keystore"
Write-Host 'Tip: keep these files private and back them up — a lost keystore'
Write-Host 'means you can never update a published app under the same signature.'