---
layout: single
title: 'Release Guide'
sidebar:
  nav: 'docs'
header:
  overlay_color: '#000'
  overlay_filter: '0.5'
  overlay_image: /assets/e2e-screenshots/35_organize_phase_stable.webp
  caption: 'Release Process'
---

# Releasing StratoSort Stack

This guide covers release packaging for Windows, macOS, and Linux, plus how GitHub Actions publishes
artifacts.

## Pre-Flight Checks

Run these before creating a beta or release tag.

### Quick check (fast, native-runtime sanity)

```bash
npm run preflight:release:quick
```

Verifies Electron-runtime loading for `sharp`, `better-sqlite3`, `@napi-rs/canvas`, `lz4-napi`, and
`node-llama-cpp`. Use this to catch native-binding breakage early.

### Full pre-flight (recommended before every tag)

```bash
npm run preflight:release
```

It requires a clean git worktree before it begins. On the current platform this runs:

1. Native module verification (`verify:native-modules`)
2. Commercial compliance verification (`compliance:commercial:verify`, unless `--skip-commercial`)
3. Critical-path smoke suite twice on the same SHA (`test:critical-path:twice`)
4. Clean `release/build`
5. Platform dist build (e.g. `dist:win` on Windows)
6. Packaged artifact verification (`verify:packaged-artifacts`)

### What `test:critical-path:twice` actually does

1. Fixed smoke suite pass #1 (`scripts/stability/run-smoke-suite.js`)
2. Fixed smoke suite pass #2 on the same commit
3. Threshold check (`scripts/stability/check-release-thresholds.js`) catching:
   - Required-journey failures
   - Baseline-pass to target-fail regressions
   - ≥50% latency drift between pass #1 and pass #2

If system-metrics exports are provided to the threshold script, it also enforces fallback-rate
guardrails for search and Uncategorized routing.

### Wizard regression checks

```bash
npx jest --config test/jest.config.js test/components/WelcomePhase.test.js test/components/ModelSetupWizard.test.js
npx jest --config test/jest.config.js test/components/PhaseRenderer.test.js test/phaseTransitions.test.js
```

### Pass criteria — do not tag until all are true

- Pre-flight command exits with code `0`
- Critical-path smoke suite passes twice on the same candidate SHA
- Wizard/phase regression suites pass
- Dist artifacts are generated under `release/build`
- No unexpected warnings/errors in command output
- Fallback telemetry is reviewed when available (search fallback rate, Uncategorized routing rate)

### CI workflows that enforce these checks

- `.github/workflows/ci.yml` (full CI gate)
- `.github/workflows/release.yml` (Windows packaging/publish)
- `.github/workflows/mac-release.yml` (macOS + Linux packaging/publish)
- `.github/workflows/manual-dist.yml` (manual packaging builds)

## Release Checklist

1. **Update release metadata**
   - Bump `version` in `package.json`
   - Move release notes from `CHANGELOG.md` **[Unreleased]** to the new version section
2. **Run quality gates**
   - `npm run ci`
3. **Smoke-test installers**
   - Windows: run `npm run dist:win`, install `StratoSortStack-Setup-*.exe`
   - macOS: on a macOS host, run `npm run dist:mac:arm64`, open `StratoSortStack-*.dmg`
   - Linux: on a Linux host, run `npm run dist:linux`, launch the AppImage or install the `.deb`
   - Confirm the installed app actually launches after install, not just that packaging succeeded
4. **Verify first-run experience**
   - AI setup confirms bundled OCR runtime availability
   - Base-model download works from the app UI
5. **Disposable profile (temp demo, Windows)** — optional, for demos or screen recordings without
   touching your real `$env:APPDATA\StratoSort Stack` data. See
   [Exact walkthrough: temp demo profile (Windows)](#exact-walkthrough-temp-demo-profile-windows)
   below.
6. **Confirm release branding inputs**
   - Either keep `assets/icons/StratoSortStackLogo.svg` (or legacy `assets/stratosort-logo.png`) in
     the repo so workflows can regenerate icons/installer graphics
   - Or commit the generated files under `assets/icons/` and `assets/installer/`
7. **Confirm docs**
   - Ensure `docs/INSTALL_GUIDE.md` matches current installer names and OS prompts
   - Ensure release references are updated for the upcoming tag:
     - `README.md` version badge
     - `CHANGELOG.md` compare links (`[Unreleased]` and new version anchor)
     - `.github/WORKFLOW_README.md` artifact names/checksum filenames

## Older macOS startup workaround

Packaged macOS builds intentionally skip Electron's single-instance lock on macOS `13.x` and older
to avoid a launch-time Electron crash seen on older Intel macOS systems.

Tradeoff:

- Affected macOS versions may allow duplicate app launches instead of focusing an existing instance.
- This is preferred over a crash-on-launch failure for supported release artifacts.

Release guidance:

- When smoke-testing macOS releases, confirm the packaged app launches on the oldest macOS version
  you still support.
- Revisit this workaround after any Electron runtime upgrade, especially when moving beyond Electron
  `41.7.1` (the currently pinned line).

## Disposable profile (Windows demo)

Use a throwaway `--user-data-dir` when you need first-run–style behavior for a demo or recording,
without changing your normal profile under `$env:APPDATA\StratoSort Stack` (same folder as
`%APPDATA%\StratoSort Stack` in Explorer).

### Exact walkthrough: temp demo profile (Windows)

Use **Windows PowerShell** (not Command Prompt). The `&` operator is required to run an executable
whose path contains spaces.

1. **Quit StratoSort** completely (including the system tray if it stays open).

2. **Create an empty folder** for the disposable profile (adjust the path if you prefer):

   ```powershell
   New-Item -ItemType Directory -Force -Path C:\temp\stratosort-demo-profile
   ```

3. **Launch the app** with `--user-data-dir` pointing at that folder. Use **one** of these:

   **A — Packaged app** (change the `.exe` path if your install location differs):

   ```powershell
   & "C:\Program Files\StratoSort Stack\StratoSort Stack.exe" --user-data-dir=C:\temp\stratosort-demo-profile
   ```

   **B — From the repo** (after a normal dev build, from the repo root):

   ```powershell
   cd c:\Users\benja\Documents\GitHub\StratoSortStack
   npx cross-env NODE_ENV=development electron . --enable-logging --user-data-dir=C:\temp\stratosort-demo-profile
   ```

4. **Confirm you’re on the temp profile** — open `C:\temp\stratosort-demo-profile` in Explorer.
   After the UI loads, you should see new files (for example `settings.json`, logs, and later models
   if you download models). Your usual profile folder (`$env:APPDATA\StratoSort Stack`) should stay
   unchanged for this run.

5. **Record your demo** — you should get first-run–style behavior. Allow time if large models
   download into this profile’s `models` folder.

6. **Quit the app** when done.

7. **Optional: delete the temp profile**

   ```powershell
   Remove-Item -Recurse -Force C:\temp\stratosort-demo-profile
   ```

   Your real profile under `$env:APPDATA\StratoSort Stack` was not used for that session.

**Tip:** If something feels stuck or locked, use a new folder name (for example
`stratosort-demo-profile-2`) for the next take.

## Tag-Triggered Releases (Recommended)

Push a semver tag:

```bash
git tag vX.Y.Z
git push origin vX.Y.Z
```

For the next release (current tag series includes `v4.0.0`), replace `X.Y.Z` with the version from
`package.json` after you bump it.

This triggers:

- `mac-release.yml` (macOS + Linux)
- `release.yml` (Windows)

Both also support `workflow_dispatch` against an existing tag for re-runs (e.g. after adding signing
secrets or fixing a transient build failure).

Release workflows are packaging/publish workflows, not full CI replacements. Run `npm run ci` before
tagging, then use the release workflows to build and upload artifacts.

## Published Artifacts

Windows workflow publishes:

- `StratoSortStack-Setup-*.exe`
- `StratoSortStack-*-win-*.exe` (portable)
- `latest.yml` — one channel file listing both the x64 and `-arm64` installers. electron-updater
  requests exactly `latest.yml` on Windows for every arch, so the x64 and arm64 matrix legs stage
  `latest-x64.yml` / `latest-arm64.yml` as artifacts and the `publish-release` job merges them with
  `scripts/merge-updater-metadata.js` (x64 first — the updater serves the first `.exe` to clients
  whose arch appears in no filename) before `verify-updater-metadata` and upload. The staging names
  are never published.
- `*.blockmap`
- `checksums-windows-x64.sha256` / `checksums-windows-arm64.sha256` (per matrix arch; installers and
  blockmaps only)

macOS workflow publishes:

- `StratoSortStack-*.dmg`
- `StratoSortStack-*.zip`
- `latest-mac.yml` — one channel file listing the x64 and arm64 zips/dmgs (signed + notarized builds
  only; unsigned builds ship no updater metadata). electron-updater requests exactly
  `latest-mac.yml` on macOS, so the per-arch `latest-mac-<arch>.yml` staging artifacts are merged in
  `publish-release` the same way as Windows and are never published.
- `checksums-macos.sha256`

Linux workflow publishes:

- `StratoSortStack-*-linux-x64.AppImage`
- `StratoSortStack-*-linux-x64.deb`
- `latest-linux.yml` (when produced)
- `checksums-linux.sha256` if you generate/upload it separately

## Application auto-updates (temporary)

Shipped installers default to **automatic updates disabled** until a public update base URL is
configured (private GitHub releases are not visible to `electron-updater` without auth). Operators
can set `STRATOSORT_ENABLE_AUTO_UPDATES=true` to smoke-test the updater; optional
`STRATOSORT_UPDATE_FEED_URL` points at a **generic** HTTPS directory with `latest.yml`. See
[CONFIG.md](CONFIG.md#application-auto-updates-electron-updater) and
[UPDATE_HOST.md](UPDATE_HOST.md).

### Updater live smoke (run before every update-enabled release)

The renderer/main wiring is oracled in unit + e2e suites (`UpdateIndicator.test.js`,
`autoUpdater.test.js`), but only a real installed build proves the end-to-end chain. Once per
update-enabled release:

1. Build TWO versions: the release candidate v(N) and a throwaway v(N+1) (bump `package.json`
   version, rebuild). Both signed.
2. Stage v(N+1)'s `latest.yml` + installer + `.blockmap` in an HTTPS directory with a valid
   certificate (Cloudflare R2 / any static host). `scripts/verify-updater-metadata.js` must pass on
   the staged files.
3. On a clean Windows VM: install v(N), then launch with `STRATOSORT_ENABLE_AUTO_UPDATES=true`,
   `STRATOSORT_UPDATE_FEED_URL=<staging URL>`,
   `STRATOSORT_UPDATE_FEED_ALLOWED_HOSTS=<staging host>`.
4. Verify the full chain: update event → background download → "Update Ready" indicator → Apply →
   in-flight-op drain → relaunch **as v(N+1)**.
5. Negative checks: the **portable** build refuses with the portable reason; a **Microsoft Store**
   build (`process.windowsStore`) refuses with the Store reason; a wrong `ALLOWED_HOSTS` value
   blocks the feed.
6. Uninstall/reinstall v(N) to confirm the rollback story.

## Post-Install Smoke (Windows NSIS)

Use this after `npm run dist:win` or an official CI-built `StratoSortStack-Setup-*.exe` to confirm
the **install and first-run** path matches [INSTALL_GUIDE.md](INSTALL_GUIDE.md).

### Preconditions

- Quit StratoSort completely (tray included).
- Prefer a clean profile: new Windows user, VM, or disposable folder with `--user-data-dir` (see the
  disposable profile section above).

### Automated checks (developer machine)

From the repo root after a Windows dist build:

```powershell
node scripts/verify-updater-metadata.js --platform=win --build-root=release/build
npm test -- test/autoUpdater.test.js --runInBand --no-coverage
```

### Manual steps

1. **Install** — Run `release\build\StratoSortStack-Setup-<version>.exe` (or your tagged artifact).
2. **Profile path** — Confirm app data lives under `%APPDATA%\StratoSort Stack` (not the legacy
   lowercase `stratosort-core` path that older postinstall scripts derived from the npm package
   name).
3. **First launch** — App opens without an updater error notification (auto-updates are off by
   default unless `STRATOSORT_ENABLE_AUTO_UPDATES=true`).
4. **Settings → Application** — "Software updates" reflects disabled mode until you enable updates
   and host a feed (see [CONFIG.md](CONFIG.md) and [UPDATE_HOST.md](UPDATE_HOST.md)).
5. **Models** — Complete welcome / model setup; optional "Download Base Models" and confirm `.gguf`
   files appear under `%APPDATA%\StratoSort Stack\models` when downloads succeed.

### Packaged-integrity checks (SW-40)

Run these once per release on a packaged build. Every path below exists **only** when packaged:
`main`, `preload` and the renderer live inside the integrity-validated `app.asar`, while seven
worker entry bundles are unpacked beside it (`asarUnpack` in `electron-builder.json`). A worker that
resolves fine in `npm run dev` can still fail to load from `app.asar.unpacked/dist/` — that is
exactly how the settings-import worker broke in #441 — so development runs prove nothing here.

- [ ] **Renderer loads from inside the asar.** `getRendererIndexPath()` prefers
      `app.asar/dist/index.html`; the unpacked renderer is a legacy fallback only. Confirm the
      window loads the in-asar copy (a packaged run that silently falls back means `asarUnpack`
      widened again).
- [ ] **OCR on an image** — exercises the unpacked `ocrWorker` bundle plus `tesseract.js-core`.
- [ ] **An embedding batch** — exercises `embeddingWorker` and the `EmbeddingQueue` retry path.
- [ ] **An Atlas UMAP projection** — exercises `umapProjectionWorker`.
- [ ] **Log export** (Settings → Diagnostics) — exercises `logExportWorker`.
- [ ] **A settings import** — exercises `settingsImportParserWorker` (the #441 regression surface).
- [ ] **Analyze a document and an image** — exercises `textExtractionWorker` and
      `imagePreprocessWorker`.
- [ ] **Tamper test.** Edit one byte inside `app.asar`, then launch: the app **must refuse to
      start**. A successful launch means asar integrity is not being enforced.
- [ ] **Fuses on the built binary.** `npx @electron/fuses read --app <path to the app>` and compare
      against `electronFuses` in `electron-builder.json`. (`npm run verify:electron-fuses-config`
      checks the _config_ in CI, including that no `asarUnpack` pattern unpacks `dist/main.js`; it
      cannot check the shipped bits.)

Two more release-time runtime items pair with this pass, both verifiable only on a packaged build:

- the **updater live smoke** —
  [§ Updater live smoke](#updater-live-smoke-run-before-every-update-enabled-release), including the
  portable/Store negative checks, and
- the **license smoke** on a fresh `--user-data-dir` (see [`LAUNCH_RUNBOOK.md`](LAUNCH_RUNBOOK.md)
  Phase 3).

### Portable build

`StratoSortStack-*-win-x64.exe` does **not** use the same auto-update path as the NSIS installer; see
[INSTALL_GUIDE.md](INSTALL_GUIDE.md) for portable vs full-installer behavior.

## Signing And Notarization Requirements

Tag-triggered release workflows support both official signed releases and unsigned ad-hoc artifacts.
If the required signing/notarization secrets are missing, the workflows continue in unsigned mode.
As of **v4.0.0**, macOS releases are signed and notarized when all five Apple secrets below are set.

Required credentials:

- Windows (Azure Trusted Signing): repository **Variables** `AZURE_TENANT_ID`, `AZURE_CLIENT_ID`
  (identifiers, not secret) and repository **Secret** `AZURE_CLIENT_SECRET` (the only true
  credential).
- macOS: `MACOS_CSC_LINK`, `MACOS_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  `APPLE_TEAM_ID`

Windows signing uses Azure Trusted Signing (account `stratosort-signing`, certificate profile
`stratosortcore-public-trust-cert`, endpoint `https://eus.codesigning.azure.net/`, publisher
`Kennedy Applied Sciences, Inc.`). Those four signing-identity values are public and stable, so they
are hardcoded in `scripts/configure-win-signing.js`. The workflow injects `win.azureSignOptions`
into the per-arch electron-builder config at build time via that script — the block is intentionally
absent from the committed configs so local and fork builds stay unsigned without Azure credentials.
Credential sources:

- `AZURE_TENANT_ID` / `AZURE_CLIENT_ID` (repo **Variables**) + `AZURE_CLIENT_SECRET` (repo
  **Secret**): a Microsoft Entra app registration (service principal) granted the **Trusted Signing
  Certificate Profile Signer** role on the signing account. The tenant/client IDs are plain
  identifiers; only the client secret authenticates. Paste with no trailing newline — the detect
  step in `release.yml` trims the variables, but a clean paste avoids surprises.

For the end-to-end Windows runbook that produces the five macOS secrets from a Windows 11 host
without any Mac hardware (OpenSSL CSR + cert request + `.p12` assembly + GitHub Secrets paste), see
[`MAC_SIGNING.md`](./MAC_SIGNING.md). The runbook is wrapped by `npm run setup:mac-signing`
(PowerShell helper at `scripts/setup-mac-signing.ps1`).

Unsigned macOS artifacts will not be notarized and may trigger Gatekeeper warnings on first launch.
For one-off rebuilds or draft releases, you can still use the manual dist workflow or local dist
commands instead of the tag-triggered workflows.

Recommended operator practice for ad-hoc unsigned builds:

1. Ensure `checksums-*.sha256` files are uploaded with each build.
2. Verify install flows manually on clean Windows/macOS test machines.

## Manual Dist Workflow

Use `.github/workflows/manual-dist.yml` (`workflow_dispatch`) when you need:

- Windows-only or macOS-only rebuilds
- A draft release with combined artifacts
- Ad-hoc release testing without tagging

## Local Dist Commands

```powershell
npm ci
npm run dist:win
```

```bash
# Run on macOS only
npm run dist:mac:arm64
```

Windows cannot produce macOS DMG/ZIP artifacts locally. Build macOS distributions on a macOS host or
via the `mac-release.yml` / `manual-dist.yml` GitHub Actions workflows, which run on `macos-latest`.

All artifacts are written to `release/build/`.

## Local Checksum Commands

Windows checksum file:

```powershell
Get-ChildItem release/build -File |
  Where-Object { $_.Name -match '^StratoSortStack-.*\.(exe|blockmap)$|^latest\.yml$' } |
  ForEach-Object {
    $hash = (Get-FileHash $_.FullName -Algorithm SHA256).Hash
    "$hash *$($_.Name)"
  } | Out-File release/build/checksums-windows-x64.sha256 -Encoding ASCII
# (CI generates per-arch files: checksums-windows-x64.sha256 / checksums-windows-arm64.sha256)
```

macOS checksum file:

```bash
cd release/build
shasum -a 256 StratoSortStack-*.dmg StratoSortStack-*.zip > checksums-macos.sha256
```

## Notes on AI Packaging

- The AI stack (node-llama-cpp + Orama) runs in-process.
- AI models are **not** bundled in installers; users download them in-app.
- OCR runtime support is bundled/fallback-ready via packaged runtime assets.
