# Creates a self-signed code-signing certificate for the Wireless Windows app
# and exports it as a password-protected PFX. Self-signed means SmartScreen
# still warns once (there is no CA backing it), but the installer and exe carry
# a stable, verifiable publisher identity instead of being unsigned.
#
#   powershell -ExecutionPolicy Bypass -File scripts/setup-windows-cert.ps1
#
# Then build a signed release:
#   $env:CSC_LINK = "<repo>\.freebuff\wireless-code-sign.pfx"
#   $env:CSC_KEY_PASSWORD = "wirelesspass"
#   npm run app:win
#
# The PFX is gitignored (.freebuff/*.pfx) — never commit a private key.

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
$outDir = Join-Path $repo '.freebuff'
$pfx = Join-Path $outDir 'wireless-code-sign.pfx'
$password = 'wirelesspass'

if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }

$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject 'CN=Wireless' `
  -FriendlyName 'Wireless code signing' `
  -CertStoreLocation Cert:\CurrentUser\My `
  -KeyExportPolicy Exportable `
  -KeyAlgorithm RSA `
  -KeyLength 2048 `
  -NotAfter (Get-Date).AddYears(5)

$secure = ConvertTo-SecureString -String $password -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $secure | Out-Null

Write-Host ''
Write-Host 'Certificate created and exported.'
Write-Host ('  Subject   : ' + $cert.Subject)
Write-Host ('  Thumbprint: ' + $cert.Thumbprint)
Write-Host ('  PFX       : ' + $pfx)
Write-Host ''
Write-Host 'Build a signed installer with:'
Write-Host ('  $env:CSC_LINK = "' + $pfx + '"')
Write-Host ('  $env:CSC_KEY_PASSWORD = "' + $password + '"')
Write-Host '  npm run app:win'
