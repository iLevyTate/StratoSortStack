#requires -Version 5.1
<#
.SYNOPSIS
  Provision macOS code-signing credentials from Windows 11.

.DESCRIPTION
  Generates the OpenSSL artifacts needed for the five GitHub repo secrets
  consumed by .github/workflows/mac-release.yml:
    MACOS_CSC_LINK              (base64 of DeveloperID.p12)
    MACOS_CSC_KEY_PASSWORD      (chosen here interactively)
    APPLE_ID                    (collected from you)
    APPLE_APP_SPECIFIC_PASSWORD (created at appleid.apple.com --manual step)
    APPLE_TEAM_ID               (looked up at developer.apple.com --manual step)

  See docs/MAC_SIGNING.md for the full runbook, including the two web-only
  steps this script cannot automate (Apple Developer ID cert request and
  Apple ID app-specific password creation).

.PARAMETER OutputDir
  Directory to write generated artifacts. Defaults to ./signing-output (which
  is git-ignored). Must be writable.

.EXAMPLE
  npm run setup:mac-signing

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File scripts/setup-mac-signing.ps1

.NOTES
  Performs no network calls. All secret material stays under $OutputDir.
  After pasting the five secrets into GitHub, delete $OutputDir (or move it to
  encrypted storage) to limit exfiltration risk.
#>

[CmdletBinding()]
param(
  [string]$OutputDir = "signing-output"
)

$ErrorActionPreference = "Stop"

function Write-Section {
  param([string]$Text)
  Write-Host ""
  Write-Host ("=" * 72) -ForegroundColor Cyan
  Write-Host $Text -ForegroundColor Cyan
  Write-Host ("=" * 72) -ForegroundColor Cyan
}

function Write-Step {
  param([string]$Text)
  Write-Host ""
  Write-Host "-> $Text" -ForegroundColor Green
}

function Write-Warn {
  param([string]$Text)
  Write-Host "!! $Text" -ForegroundColor Yellow
}

function Confirm-Overwrite {
  param([string]$Path)
  if (-not (Test-Path -LiteralPath $Path)) { return $true }
  $resp = Read-Host "  $Path exists. Overwrite? [y/N]"
  return ($resp -match '^[Yy]')
}

function Read-Required {
  param(
    [string]$Prompt,
    [string]$Default = ""
  )
  while ($true) {
    $promptText = if ($Default) { "$Prompt [$Default]" } else { $Prompt }
    $value = Read-Host $promptText
    if (-not $value -and $Default) { return $Default }
    if ($value) { return $value }
    Write-Warn "Value is required."
  }
}

function ConvertFrom-SecureStringPlain {
  param([System.Security.SecureString]$Secure)
  $bstr = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try {
    return [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($bstr)
  }
  finally {
    [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr)
  }
}

# ---------------------------------------------------------------------------
# 0. Preflight
# ---------------------------------------------------------------------------
Write-Section "StratoSort --macOS signing credential setup"
Write-Host "This script produces the artifacts needed for the five GitHub secrets"
Write-Host "consumed by .github/workflows/mac-release.yml. It performs no network"
Write-Host "calls; all material stays under '$OutputDir/'."
Write-Host ""
Write-Host "Reference: docs/MAC_SIGNING.md"

$openssl = Get-Command openssl -ErrorAction SilentlyContinue
if (-not $openssl) {
  Write-Warn "OpenSSL not found on PATH."
  Write-Host ""
  Write-Host "Install on Windows 11 with:" -ForegroundColor Yellow
  Write-Host "    winget install ShiningLight.OpenSSL.Light"
  Write-Host ""
  Write-Host "Or use Git for Windows's bundled OpenSSL:"
  Write-Host "    Add `"C:\Program Files\Git\usr\bin`" to your PATH"
  exit 1
}
Write-Step "OpenSSL found: $($openssl.Source)"
& $openssl.Source version | Write-Host

# ---------------------------------------------------------------------------
# 1. Collect identity inputs
# ---------------------------------------------------------------------------
Write-Section "Phase 1: Identity"
Write-Host "These values must match your Apple Developer Program enrollment."
Write-Host "  - Email: the Apple ID enrolled in the Developer Program"
Write-Host "  - Legal name: matches what Apple has on file (Individual: your"
Write-Host "    personal legal name; Organization: the company legal name)"
Write-Host "  - Country: ISO 3166-1 alpha-2 code (US, GB, DE, ...)"
Write-Host "  - Team ID: 10-char uppercase from developer.apple.com ->"
Write-Host "    Membership details"

$email     = Read-Required "Apple ID email"
$legalName = Read-Required "Legal name (CN)"
$country   = Read-Required "Country code" "US"
while ($true) {
  $teamId = Read-Required "Team ID (10-char uppercase alphanumeric)"
  if ($teamId -match '^[A-Z0-9]{10}$') { break }
  Write-Warn "Team ID must be exactly 10 uppercase letters/digits."
}

# ---------------------------------------------------------------------------
# 2. Output directory
# ---------------------------------------------------------------------------
Write-Section "Phase 2: Output directory"
$resolvedOut = Join-Path -Path (Get-Location) -ChildPath $OutputDir
if (-not (Test-Path -LiteralPath $resolvedOut)) {
  New-Item -ItemType Directory -Path $resolvedOut | Out-Null
  Write-Step "Created $resolvedOut"
} else {
  Write-Step "Using existing $resolvedOut"
}

$keyPath = Join-Path $resolvedOut "DeveloperID.key"
$csrPath = Join-Path $resolvedOut "DeveloperID.certSigningRequest"
$cerPath = Join-Path $resolvedOut "developerID_application.cer"
$pemPath = Join-Path $resolvedOut "DeveloperID.pem"
$intCerPath = Join-Path $resolvedOut "DeveloperIDG2CA.cer"
$intPemPath = Join-Path $resolvedOut "DeveloperIDG2CA.pem"
$p12Path = Join-Path $resolvedOut "DeveloperID.p12"
$b64Path = Join-Path $resolvedOut "DeveloperID.p12.b64"

# ---------------------------------------------------------------------------
# 3. Generate private key + CSR
# ---------------------------------------------------------------------------
Write-Section "Phase 3: Generate private key + CSR"

if (-not (Confirm-Overwrite $keyPath)) {
  Write-Step "Reusing existing key at $keyPath"
} else {
  Write-Step "Generating RSA 2048 private key..."
  & $openssl.Source genrsa -out $keyPath 2048
  if ($LASTEXITCODE -ne 0) { throw "openssl genrsa failed (exit $LASTEXITCODE)" }
}

if (-not (Confirm-Overwrite $csrPath)) {
  Write-Step "Reusing existing CSR at $csrPath"
} else {
  $subj = "/emailAddress=$email/CN=$legalName/C=$country"
  Write-Step "Generating CSR with subject: $subj"
  & $openssl.Source req -new -key $keyPath -out $csrPath -subj $subj
  if ($LASTEXITCODE -ne 0) { throw "openssl req failed (exit $LASTEXITCODE)" }
}

# ---------------------------------------------------------------------------
# 4. Pause for Apple web step
# ---------------------------------------------------------------------------
Write-Section "Phase 4: Request the Developer ID Application certificate"
Write-Host "Open in your browser:" -ForegroundColor Yellow
Write-Host "    https://developer.apple.com/account/resources/certificates/list"
Write-Host ""
Write-Host "Steps:"
Write-Host "  1. Click the '+' button"
Write-Host "  2. Select 'Developer ID' -> 'Developer ID Application'"
Write-Host "     (NOT 'Mac Development', NOT 'Developer ID Installer')"
Write-Host "  3. Click Continue"
Write-Host "  4. Upload this CSR:"
Write-Host "       $csrPath"
Write-Host "  5. Click Continue, then Download"
Write-Host "  6. Save the downloaded .cer file as:"
Write-Host "       $cerPath"
Write-Host ""
Write-Host "(Optional but recommended) Also download the Apple intermediate"
Write-Host "certificate to enable offline chain validation:"
Write-Host "  - URL: https://www.apple.com/certificateauthority/"
Write-Host "  - Find 'Developer ID - G2' and save as:"
Write-Host "       $intCerPath"
Write-Host ""
Read-Host "Press Enter once $cerPath exists on disk"

if (-not (Test-Path -LiteralPath $cerPath)) {
  throw "Expected certificate not found at: $cerPath"
}
Write-Step "Found $cerPath"
$haveIntermediate = Test-Path -LiteralPath $intCerPath
if ($haveIntermediate) {
  Write-Step "Found intermediate cert at $intCerPath --chain will be bundled."
} else {
  Write-Warn "Intermediate cert not present at $intCerPath --proceeding without it."
  Write-Warn "Signed builds will still work; offline chain validation may fall back to a network lookup."
}

# ---------------------------------------------------------------------------
# 5. Convert + assemble .p12
# ---------------------------------------------------------------------------
Write-Section "Phase 5: Assemble the .p12"

Write-Step "Converting Apple .cer (DER) -> PEM..."
& $openssl.Source x509 -in $cerPath -inform DER -out $pemPath -outform PEM
if ($LASTEXITCODE -ne 0) { throw "openssl x509 conversion failed (exit $LASTEXITCODE)" }

if ($haveIntermediate) {
  Write-Step "Converting intermediate .cer (DER) -> PEM..."
  & $openssl.Source x509 -in $intCerPath -inform DER -out $intPemPath -outform PEM
  if ($LASTEXITCODE -ne 0) { throw "openssl x509 conversion failed (exit $LASTEXITCODE)" }
}

Write-Host ""
Write-Host "Choose a strong password for the .p12. This becomes the" -ForegroundColor Yellow
Write-Host "MACOS_CSC_KEY_PASSWORD GitHub secret. RECORD IT IN A PASSWORD" -ForegroundColor Yellow
Write-Host "MANAGER BEFORE CONTINUING --OpenSSL does not display it again." -ForegroundColor Yellow
Write-Host ""

while ($true) {
  $pwd1 = Read-Host "  .p12 password" -AsSecureString
  $pwd2 = Read-Host "  confirm" -AsSecureString
  $plain1 = ConvertFrom-SecureStringPlain $pwd1
  $plain2 = ConvertFrom-SecureStringPlain $pwd2
  if ($plain1.Length -lt 12) {
    Write-Warn "Use at least 12 characters."
  } elseif ($plain1 -cne $plain2) {
    Write-Warn "Passwords do not match."
  } else {
    break
  }
}

$identityName = "Developer ID Application: $legalName ($teamId)"
Write-Step "Building .p12 with identity name: $identityName"

# OpenSSL reads the export password from env when we pass `-passout env:NAME`.
# Putting it in the process env briefly is the least-bad option: arguments are
# visible in process listings, files leave residue, stdin pipes are awkward
# under PowerShell's argument quoting.
$env:STRATOSORT_P12_PASS = $plain1
try {
  $opensslArgs = @(
    "pkcs12", "-export",
    "-inkey", $keyPath,
    "-in", $pemPath,
    "-name", $identityName,
    "-out", $p12Path,
    "-passout", "env:STRATOSORT_P12_PASS"
  )
  if ($haveIntermediate) {
    $opensslArgs += @("-certfile", $intPemPath)
  }
  & $openssl.Source @opensslArgs
  if ($LASTEXITCODE -ne 0) { throw "openssl pkcs12 -export failed (exit $LASTEXITCODE)" }
}
finally {
  Remove-Item Env:STRATOSORT_P12_PASS -ErrorAction SilentlyContinue
  $plain1 = $null
  $plain2 = $null
  [GC]::Collect()
}

Write-Step "Produced $p12Path"

# ---------------------------------------------------------------------------
# 6. Base64-encode .p12 for the GitHub secret
# ---------------------------------------------------------------------------
Write-Section "Phase 6: Base64-encode .p12 for MACOS_CSC_LINK"

$bytes = [System.IO.File]::ReadAllBytes($p12Path)
$b64 = [System.Convert]::ToBase64String($bytes)
# -NoNewline so GitHub does not store a trailing \n that breaks base64 decoders
Set-Content -LiteralPath $b64Path -Value $b64 -NoNewline -Encoding ASCII
Write-Step "Wrote $b64Path ($($b64.Length) chars)"

# ---------------------------------------------------------------------------
# 7. Summary
# ---------------------------------------------------------------------------
Write-Section "Next steps"
Write-Host ""
Write-Host "1. Create an app-specific password" -ForegroundColor Yellow
Write-Host "     URL: https://appleid.apple.com"
Write-Host "     -> Sign-In and Security -> App-Specific Passwords -> '+'"
Write-Host "     Label: 'StratoSort GitHub Actions'"
Write-Host "     Copy the xxxx-xxxx-xxxx-xxxx token NOW (shown once)."
Write-Host ""
Write-Host "2. Open GitHub repo secrets:" -ForegroundColor Yellow
Write-Host "     https://github.com/iLevyTate/StratoSortStack/settings/secrets/actions"
Write-Host ""
Write-Host "3. Add the five secrets:" -ForegroundColor Yellow
Write-Host ""
Write-Host "   MACOS_CSC_LINK"
Write-Host "     Source: paste the entire contents of"
Write-Host "             $b64Path"
Write-Host ""
Write-Host "   MACOS_CSC_KEY_PASSWORD"
Write-Host "     Source: the password you just chose"
Write-Host ""
Write-Host "   APPLE_ID"
Write-Host "     Value:  $email"
Write-Host ""
Write-Host "   APPLE_APP_SPECIFIC_PASSWORD"
Write-Host "     Source: the xxxx-xxxx-xxxx-xxxx token from step 1"
Write-Host ""
Write-Host "   APPLE_TEAM_ID"
Write-Host "     Value:  $teamId"
Write-Host ""
Write-Host "4. Tag a release:" -ForegroundColor Yellow
Write-Host "     git tag v<x.y.z>    (use the version from package.json)"
Write-Host "     git push origin v<x.y.z>"
Write-Host ""
Write-Host "5. Watch the workflow run:" -ForegroundColor Yellow
Write-Host "     https://github.com/iLevyTate/StratoSortStack/actions/workflows/mac-release.yml"
Write-Host ""
Write-Host "6. CLEANUP (do this once secrets are saved in GitHub):" -ForegroundColor Yellow
Write-Host "     Remove-Item -Recurse -Force '$resolvedOut'"
Write-Host "     OR move '$resolvedOut' to encrypted storage (1Password, BitLocker, etc.)"
Write-Host ""
Write-Host "See docs/MAC_SIGNING.md for verification commands and troubleshooting."
Write-Host ""
