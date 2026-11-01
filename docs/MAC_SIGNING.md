# macOS Code Signing — Windows 11 Runbook

End-to-end walkthrough for producing the five GitHub repo secrets that
`.github/workflows/mac-release.yml` needs to ship **signed + notarized** macOS DMGs. You will not
touch Mac hardware at any point.

The workflow does the actual signing and notarization on Apple's `macos-latest` (arm64) and
`macos-15-intel` (x64) runners — your job is to provision the credentials it consumes. After the
one-time setup below, every `git tag v*.*.*` produces signed/notarized DMGs automatically.

For the runbook helper script, see `scripts/setup-mac-signing.ps1` (or run
`npm run setup:mac-signing`). The script automates the OpenSSL + base64 plumbing but cannot perform
the two web-only steps (Apple cert request, app-specific password creation), so this doc remains the
source of truth.

## Prerequisites

- **Active Apple Developer Program enrollment** (Individual or Organization). Verify at
  <https://developer.apple.com/account> → **Membership details**. The page must show an active
  membership and a 10-character Team ID.
- **OpenSSL on `PATH`.** Recommended install on Windows 11:
  ```powershell
  winget install ShiningLight.OpenSSL.Light
  ```
  Alternatively, Git for Windows ships `openssl.exe` at `C:\Program Files\Git\usr\bin\openssl.exe`.
  Confirm with:
  ```powershell
  openssl version
  ```
- **GitHub repo admin access** (you need to add Actions secrets).

## Phase 1: Generate private key + CSR on Windows

Apple's cert request flow accepts the standard PKCS#10 CSR PEM that any OpenSSL toolchain produces —
it is not Keychain-specific.

```powershell
# Work from a temp directory you control
mkdir signing-output
cd signing-output

# 1a. 2048-bit RSA private key (Apple requires RSA 2048)
openssl genrsa -out DeveloperID.key 2048

# 1b. CSR — email and CN must match what you'll display in cert requests
openssl req -new -key DeveloperID.key `
  -out DeveloperID.certSigningRequest `
  -subj "/emailAddress=YOU@EXAMPLE.COM/CN=Your Legal Name/C=US"
```

**Critical:** `CN=Your Legal Name` should match the legal name on your Apple Developer Program
enrollment (Individual: your personal legal name; Organization: the company legal name). It becomes
part of the cert's Common Name and appears in Gatekeeper's "Developer ID Application: <Name>"
string.

## Phase 2: Request the Developer ID Application certificate

1. Open <https://developer.apple.com/account/resources/certificates/list>.
2. Click the **`+`** button.
3. Select **Developer ID** → **Developer ID Application**.
   - **Not** "Mac Development" (only signs for the developer's own machine).
   - **Not** "Developer ID Installer" (only signs `.pkg` installers).
   - **Not** "Mac Installer Distribution" (Mac App Store only).
4. Click **Continue**.
5. **Upload** `signing-output/DeveloperID.certSigningRequest` (Choose File → select).
6. Click **Continue**.
7. Click **Download** → saves `developerID_application.cer` (DER-encoded). Move it to
   `signing-output/developerID_application.cer`.

**(Optional but recommended)** Download the Apple intermediate certificate so the chain validates
without a network round-trip during signing:

1. Open <https://www.apple.com/certificateauthority/>.
2. Download **Developer ID - G2 (Expiring 09/17/2031)** as `DeveloperIDG2CA.cer`.
3. Save to `signing-output/DeveloperIDG2CA.cer`.

## Phase 3: Assemble the `.p12`

The `.p12` (PKCS#12) bundles the private key + Apple-signed cert + chain into one password-protected
file that electron-builder consumes via the `MACOS_CSC_LINK` secret.

```powershell
# 3a. Convert Apple's DER .cer to PEM
openssl x509 -in developerID_application.cer -inform DER `
  -out DeveloperID.pem -outform PEM

# 3b. (If you downloaded the intermediate) convert it too
openssl x509 -in DeveloperIDG2CA.cer -inform DER `
  -out DeveloperIDG2CA.pem -outform PEM

# 3c. Bundle into .p12. Pick a strong password when prompted — this becomes
#     MACOS_CSC_KEY_PASSWORD. Record it in a password manager BEFORE
#     pressing Enter; OpenSSL does not display it again.
openssl pkcs12 -export `
  -inkey DeveloperID.key `
  -in DeveloperID.pem `
  -certfile DeveloperIDG2CA.pem `
  -name "Developer ID Application: Your Name (TEAMID)" `
  -out DeveloperID.p12
```

If you skipped the intermediate, omit the `-certfile DeveloperIDG2CA.pem` line. The `-name` value is
the human-readable identity label — replace `Your Name` with the same legal name as the CN, and
`TEAMID` with your 10-character Team ID (see Phase 5).

OpenSSL 3.x defaults to AES-256/SHA-256 PKCS#12, which electron-builder and `security import` both
accept. If a downstream consumer ever errors with "MAC verify failure," re-export with `-legacy`.

## Phase 4: Create the app-specific password (notarization auth)

`xcrun notarytool` authenticates to Apple's Notary service with either an App Store Connect API key
(`.p8`) or an Apple ID + app-specific password. The existing `mac-release.yml` uses the latter,
which is simpler to provision.

1. Open <https://appleid.apple.com>.
2. Sign in with the Apple ID enrolled in the Developer Program.
3. Navigate to **Sign-In and Security** → **App-Specific Passwords**.
4. Click **`+`** (or **Generate an app-specific password**).
5. Label it `StratoSort GitHub Actions`.
6. Apple displays the token as `xxxx-xxxx-xxxx-xxxx`. **Copy it immediately** — it is shown once and
   never again.
7. Save it in your password manager.

## Phase 5: Find your Team ID

1. Open <https://developer.apple.com/account>.
2. Click **Membership details** in the left sidebar.
3. The **Team ID** row shows a 10-character uppercase alphanumeric string (e.g., `A1B2C3D4E5`).

You can also see the same Team ID inside the `Developer ID Application: <Name> (<TEAMID>)` identity
label.

## Phase 6: Add the five GitHub repo secrets

1. Open <https://github.com/iLevyTate/StratoSortStack/settings/secrets/actions>.
2. For each row below, click **New repository secret**, paste **Name** and **Value**, click **Add
   secret**.

| Secret name                   | Value source                                                                                                                   |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `MACOS_CSC_LINK`              | `base64 -w0 DeveloperID.p12` output (or `[Convert]::ToBase64String([IO.File]::ReadAllBytes("DeveloperID.p12"))` in PowerShell) |
| `MACOS_CSC_KEY_PASSWORD`      | The strong password you chose in Phase 3                                                                                       |
| `APPLE_ID`                    | The Apple ID email used at <https://appleid.apple.com>                                                                         |
| `APPLE_APP_SPECIFIC_PASSWORD` | The `xxxx-xxxx-xxxx-xxxx` token from Phase 4                                                                                   |
| `APPLE_TEAM_ID`               | The 10-character Team ID from Phase 5                                                                                          |

PowerShell command for the base64 encoding (no trailing newline):

```powershell
[Convert]::ToBase64String([IO.File]::ReadAllBytes("DeveloperID.p12")) `
  | Set-Content DeveloperID.p12.b64 -NoNewline
```

Then paste the contents of `DeveloperID.p12.b64` as the `MACOS_CSC_LINK` value.

## Phase 7: Tag a release

```powershell
# Confirm package.json version matches the tag you're about to push
# (mac-release.yml enforces this — version mismatch fails the workflow).
git status                           # clean working tree
git tag v4.0.0                       # use the current package.json version
git push origin v4.0.0
```

`.github/workflows/mac-release.yml` fires:

1. **`Detect mac release mode`** prints `::notice::Using signed + notarized mac release mode.` (If
   you see `::warning::macOS signing/notarization secrets are not configured`, one of the five
   secrets is missing or misnamed — go back to Phase 6.)
2. **`Build signed Mac app and DMG`** runs (the `if: signed == 'true'` branch). After codesigning,
   electron-builder's `afterSign` hook (`scripts/notarize-mac-app.js`) notarizes and staples the
   `.app` before the DMG and ZIP are built, trying up to three times 30 s and 60 s apart.
   electron-builder's own notarization is off (`mac.notarize: false`) because it makes one attempt,
   and a dropped connection to Apple failed the macOS x64 job for both 5.1.0 and 5.1.1.
3. **`Verify app signature`** runs `codesign --verify --deep --strict` on each `.app` bundle.
4. **`Notarize and staple artifacts`** uploads to Apple via `xcrun notarytool submit --wait`, then
   `xcrun stapler staple` attaches the ticket to each DMG. Each call is retried up to three times.
   First submission from a new Team ID typically takes 5–15 minutes; subsequent ones complete in 2–5
   minutes.
5. **`publish-release`** merges the per-arch `latest-mac-<arch>.yml` staging files into a single
   `latest-mac.yml` (the only name electron-updater requests on macOS) and uploads it with the DMG +
   ZIP files to the GitHub Release page. The per-arch staging files are never published.

If the workflow fails, see **Troubleshooting** below.

## Phase 8: Smoke-test the released DMG

`mac-release.yml` validates signature structure and stapling during build, but the end-user
Gatekeeper check (`spctl --assess`) only runs after the DMG is mounted on a real Mac. You have two
options.

### Option A (recommended, no Mac required): run `verify-mac-signing.yml`

A dedicated workflow downloads the published DMG, mounts it on a GHA macOS runner, and runs the full
end-user verification — `codesign --verify`, `spctl --assess`, and `xcrun stapler validate` — for
both arm64 and x64. It fails the workflow if Gatekeeper would reject the app on a user's Mac.

Trigger via the GitHub web UI:

1. Open <https://github.com/iLevyTate/StratoSortStack/actions/workflows/verify-mac-signing.yml>
2. Click **Run workflow**.
3. Enter the tag you want to verify (e.g. `v4.0.0`).
4. Click **Run workflow**.

Or trigger via the `gh` CLI from Windows:

```powershell
gh workflow run verify-mac-signing.yml -f tag_name=v4.0.0
gh run watch
```

A successful run prints `Gatekeeper accepts the app with source=Notarized Developer ID` for both
arch legs, and the Summary tab shows the four checks that passed. A failure means the released DMG
would be rejected on end-user Macs — see Troubleshooting below.

Cost: roughly 5 minutes per arch on `macos-latest` / `macos-15-intel` (~$0.50–$1.00 per verification
run after free quota at June 2026 pricing).

### Option B: borrow a real Mac

If you happen to have access to a Mac, the same checks run from a terminal:

```bash
# 1. Download the signed DMG from the GitHub Release page
# 2. Mount the DMG, drag StratoSort Stack.app to /Applications

# 3. Verify the signature chain
codesign --verify --deep --strict --verbose=4 "/Applications/StratoSort Stack.app"
# Expect: "satisfies its Designated Requirement" with no errors

# 4. Verify Gatekeeper acceptance (the user-facing check)
spctl --assess --type exec --verbose=4 "/Applications/StratoSort Stack.app"
# Expect: "accepted" and "source=Notarized Developer ID"

# 5. Verify the stapled ticket on the DMG itself
xcrun stapler validate StratoSortStack-4.0.0-mac-arm64.dmg
# Expect: "The validate action worked!"

# 6. Open the app. Gatekeeper should NOT show "developer cannot be verified"
#    or "macOS cannot verify that this app is free from malware."
```

## Renewal

- **Developer ID Application certificate** — valid 5 years. Calendar a reminder 90 days before
  expiry. To renew: re-run Phases 1–3 (new key + CSR + cert + `.p12`), update `MACOS_CSC_LINK` and
  `MACOS_CSC_KEY_PASSWORD`. The old cert keeps working until its expiry, so there is no rush window.
- **App-specific password** — does not expire on its own, but is **revoked** any time you reset the
  Apple ID password. After any password reset, re-run Phase 4 and update
  `APPLE_APP_SPECIFIC_PASSWORD`.
- **Team ID and Apple ID** — do not change in normal operation.

## Compromise rotation

If the `.p12` file, `MACOS_CSC_KEY_PASSWORD`, or `APPLE_APP_SPECIFIC_PASSWORD` is exposed — pasted
into chat, committed accidentally, stored on a compromised machine — treat the cert as burned. **The
"no rush window" guidance above applies only to scheduled renewals.** For compromise:

1. **Do not revoke the old cert first.** Generate the new cert, ship a release with it, verify via
   `verify-mac-signing.yml` BEFORE revoking. The old cert is your rollback path until the new one is
   proven on real Mac runners.
2. Re-run Phases 1–3 to generate a NEW key, NEW CSR, NEW cert (Apple permits multiple Developer ID
   Application certs per team), and NEW `.p12` with a NEW high-entropy passphrase. Do not reuse any
   material. Generate the passphrase via a password manager — never type it.
3. Update `MACOS_CSC_LINK` and `MACOS_CSC_KEY_PASSWORD` GitHub secrets via the GitHub UI or
   `gh secret set` in a local terminal. **Never paste secrets into any chat/AI session** — anything
   entered into a chat transcript is persisted by telemetry/logging layers and must be treated as
   exfiltrated.
4. Re-fire the most recent release tag:
   ```powershell
   gh workflow run mac-release.yml -f tag_name=v<latest>
   ```
   The workflow's `--clobber` upload replaces the existing assets at the same URLs without changing
   the version number, so electron-updater's auto-update semantics are preserved.
5. Run
   ```powershell
   gh workflow run verify-mac-signing.yml -f tag_name=v<latest>
   ```
   The summary's `codesign -dv` output must show an `Authority=Developer ID Application: ...` line
   with a SHA1 that **differs** from the compromised cert's SHA1. Both arch legs (arm64, x64) must
   pass.
6. **Only after step 5 passes both arch legs**, revoke the compromised cert at
   <https://developer.apple.com/account/resources/certificates/list> → click into the cert (verify
   SHA1 first — the portal does not prevent revoking the wrong cert) → **Revoke**.
7. Audit any tags built between the exposure and step 4. Re-fire `mac-release.yml` for each so their
   published assets are signed with the new cert.
8. Destroy the old `.p12` locally (signed by a revoked cert, useless) and delete any backups. Save
   the new `.p12` + passphrase to a password manager as an encrypted attachment + secure note.

Binaries already distributed under the old cert continue to validate on end-user Macs — their
stapled notarization tickets short-circuit the online revocation check. Revocation blocks _new_
signing, not previously-shipped binaries.

## Cleanup (do this immediately after Phase 6)

The `signing-output/` directory holds your unencrypted private key, the unencrypted `.cer`, and the
`.p12`'s base64 representation. After all five secrets are saved in GitHub:

```powershell
# Option 1: delete entirely (recreate from Apple if needed)
Remove-Item -Recurse -Force signing-output

# Option 2: move to encrypted storage (1Password / Bitwarden attachments,
# BitLocker-encrypted external drive)
Move-Item signing-output "C:\Path\To\Encrypted\StratoSort-Signing-Backup"
```

`signing-output/` is excluded by `.gitignore`, but a local copy is still an exfiltration risk on a
compromised dev machine.

## Troubleshooting

### `errSecInternalComponent` during signing

The `.p12` identity name does not match the cert's actual Common Name. Re-run Phase 3's
`openssl pkcs12 -export` with the correct `Developer ID Application: <CN from cert> (<TEAMID>)`.

### Notarization status `Invalid`

Run
`xcrun notarytool log <submission-id> --apple-id "$APPLE_ID" --password "$APPLE_APP_SPECIFIC_PASSWORD" --team-id "$APPLE_TEAM_ID"`
on a Mac (or borrow one) to see Apple's detailed JSON report. Common causes:

- Hardened runtime not enabled (the workflow sets this, so this should not happen — check that you
  didn't accidentally edit `electron-builder.json`).
- Missing entitlements for native modules (`assets/entitlements.mac.plist` already has `allow-jit`,
  `allow-unsigned-executable-memory`, `disable-library-validation` — do not remove these).
- A nested binary that was not re-signed after a build-time modification.

### Gatekeeper "developer cannot be verified" on a downloaded DMG

Either notarization did not complete or stapling ran on the wrong artifact. Check the workflow logs
for the **`Notarize and staple artifacts`** step. If stapling succeeded but Gatekeeper still
rejects, the user may be running macOS in a network-restricted environment (Apple's notarization
check falls back to an online lookup if the staple is unreadable; the staple makes it work offline).

### First-submission delay > 30 minutes

Apple historically queued first submissions from new Team IDs for hours. As of 2026, typical first
submissions complete in 5–15 minutes. If you see

> 30 min, do not retry — Apple rate-limits retry storms. Wait, then check status with
> `notarytool history`. Submissions almost never silently fail.

### `mac-release.yml` builds unsigned even with secrets set

The workflow checks for **all five** secrets being non-empty. A blank or whitespace-only value in
any one secret causes the `signed=false` branch. Re-paste each secret carefully, ensuring no
leading/trailing whitespace.

Also check the **`STRATOSORT_FORCE_UNSIGNED_MAC`** repository variable
(<https://github.com/iLevyTate/StratoSortStack/settings/variables/actions>). If set to `true`, the
workflow ignores the signing secrets and builds unsigned. Set to `false` or delete the variable.

### Want to ship an unsigned interim build temporarily

Set the `STRATOSORT_FORCE_UNSIGNED_MAC` repository variable to `true` (Repository **variables**, not
secrets — same UI, sibling tab). Reset to `false` or delete to re-enable signed builds. Useful when
the cert is mid-renewal or notarization credentials are stale.

## Reference

- Apple —
  [Create a Certificate Signing Request](https://developer.apple.com/help/account/certificates/create-a-certificate-signing-request/)
- Apple —
  [Customizing the notarization workflow](https://developer.apple.com/documentation/security/customizing-the-notarization-workflow)
- Apple —
  [Locate your Team ID](https://developer.apple.com/help/account/manage-your-team/locate-your-team-id/)
- Apple — [Apple PKI intermediate certs](https://www.apple.com/certificateauthority/)
- electron-builder —
  [MacConfiguration](https://www.electron.build/electron-builder.Interface.MacConfiguration.html)
- `@electron/notarize` — <https://github.com/electron/notarize>
- StratoSort release workflow —
  [`.github/workflows/mac-release.yml`](https://github.com/iLevyTate/StratoSortStack/blob/main/.github/workflows/mac-release.yml)
- StratoSort release process — [`RELEASING.md`](./RELEASING.md)
