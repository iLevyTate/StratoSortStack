---
layout: single
title: 'Release Guide'
sidebar:
  nav: 'docs'
---

This guide covers release packaging for Windows, macOS, and Linux, plus how GitHub Actions publishes
artifacts.

## Pre-Flight Checks

Run these before creating a beta or release tag.

### Quick check (fast, native-runtime sanity)

```bash
npm run preflight:release:quick
```

Runs everything in the full pre-flight below **except** the dist build and packaged-artifact checks
(`--skip-dist`): native-module loading (`sharp`, `better-sqlite3`, `@napi-rs/canvas`, `lz4-napi`,
`node-llama-cpp`), the critical-path baseline comparison and commercial compliance. It also needs a
clean git worktree. Use it to catch native-binding breakage and regressions early.

### Full pre-flight (recommended before every tag)

```bash
npm run preflight:release
```

It requires a clean git worktree before it begins. On the current platform this runs:

1. Native module verification (`verify:native-modules`)
2. Critical-path baseline comparison (`test:critical-path:twice`, unless `--skip-critical`)
3. Commercial compliance verification (`compliance:commercial:verify`, unless `--skip-commercial`)
4. Clean `release/build`
5. Platform dist build (e.g. `dist:win` on Windows)
6. Packaged artifact verification (`verify:packaged-artifacts`)

### What `test:critical-path:twice` actually does

`scripts/stability/compare-baseline.js` checks out two temporary git worktrees under
`.tmp/stability-worktrees/` — the previous release tag (the baseline) and `HEAD` (the target) — and:

1. Runs the fixed smoke suite (`scripts/stability/run-smoke-suite.js`) on the baseline
2. Runs the same smoke suite on the target
3. Runs the threshold check (`scripts/stability/check-release-thresholds.js`), catching:
   - Required-journey failures
   - Baseline-pass to target-fail regressions
   - ≥50% latency regressions from baseline to target

If system-metrics exports are provided to the threshold script, it also enforces fallback-rate
guardrails for search and Uncategorized routing.

### Wizard regression checks

```bash
npx jest --config test/jest.config.js test/components/WelcomePhase.test.js test/components/ModelSetupWizard.test.js
npx jest --config test/jest.config.js test/components/PhaseRenderer.test.js test/phaseTransitions.test.js
```

### Pass criteria — do not tag until all are true

- Pre-flight command exits with code `0`
- Critical-path smoke suite passes on the candidate SHA with no regressions against the baseline tag
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
- Revisit this workaround after any Electron runtime upgrade (currently `^45.1.0` in `package.json`;
  see `.github/dependabot.yml` for the upgrade policy).

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
   cd <path-to-your-clone>
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

Replace `X.Y.Z` with the version from `package.json` after you bump it (for example `v5.0.0`).

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
- `StratoSortStack-*-win-x64.zip` (x64 only: the no-install copy, see
  [§ Windows zip](#windows-zip-no-install-build); never listed in `latest.yml`)
- `latest.yml` — one channel file listing both the x64 and `-arm64` installers. electron-updater
  requests exactly `latest.yml` on Windows for every arch, so the x64 and arm64 matrix legs stage
  `latest-x64.yml` / `latest-arm64.yml` as artifacts and the `publish-release` job merges them with
  `scripts/merge-updater-metadata.js` (x64 first — the updater serves the first `.exe` to clients
  whose arch appears in no filename) before `verify-updater-metadata` and upload. The staging names
  are never published.
- `*.blockmap`
- `checksums-windows-x64.sha256` / `checksums-windows-arm64.sha256` (per matrix arch; installers,
  the x64 zip and blockmaps)

macOS workflow publishes:

- `StratoSortStack-*.dmg`
- `StratoSortStack-*.zip`
- `latest-mac.yml` — one channel file listing the x64 and arm64 zips/dmgs (signed + notarized builds
  only; unsigned builds ship no updater metadata). electron-updater requests exactly
  `latest-mac.yml` on macOS, so the per-arch `latest-mac-<arch>.yml` staging artifacts are merged in
  `publish-release` the same way as Windows and are never published.
- `checksums-macos.sha256`

Linux workflow publishes:

- `StratoSortStack-*-linux-x86_64.AppImage` and `StratoSortStack-*-linux-arm64.AppImage`
- `StratoSortStack-*-linux-amd64.deb` and `StratoSortStack-*-linux-arm64.deb`
- `latest-linux.yml` (x64) and `latest-linux-arm64.yml` (when produced)
- `checksums-linux.sha256`

## Application auto-updates

Shipped installers check the public GitHub Releases feed for updates by default, so the repository
and its releases must stay public (private releases are not visible to `electron-updater` without
auth). `STRATOSORT_ENABLE_AUTO_UPDATES=false` disables the updater; optional
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
3. On a clean Windows VM: install v(N), then launch with `STRATOSORT_UPDATE_FEED_URL=<staging URL>`,
   `STRATOSORT_UPDATE_FEED_ALLOWED_HOSTS=<staging host>`.
4. Verify the full chain: update event → background download → "Update Ready" indicator → Apply →
   in-flight-op drain → relaunch **as v(N+1)**.
5. Negative checks: a copy extracted from the **zip** (no `Uninstall StratoSort Stack.exe` beside
   the exe) refuses with the zip reason; a **Microsoft Store** build (`process.windowsStore`)
   refuses with the Store reason; a wrong `ALLOWED_HOSTS` value blocks the feed.
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
3. **First launch** — App opens without an updater error notification; the startup update check
   against GitHub Releases succeeds (or reports "up to date").
4. **Settings → Application** — "Background Update Checks" is on and can be switched off (see
   [CONFIG.md](CONFIG.md) and [UPDATE_HOST.md](UPDATE_HOST.md)).
5. **Models** — Complete welcome / model setup; optional "Download Base Models" and confirm `.gguf`
   files appear under `%APPDATA%\StratoSort Stack\models` when downloads succeed.

### Packaged-integrity checks

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
- [ ] **First-launch timing of both downloaded artifacts.** On a clean Windows VM with Microsoft
      Defender real-time protection left on, download the installer and the `-win-x64.zip` from the
      release page (not from the build machine, so SmartScreen and the mark-of-the-web apply).
      Install and time the installer's first launch from double-click to first window. Extract the
      zip once to `C:\StratoSort` with Explorer's **Extract All** (confirm it finishes without "path
      too long" errors), then time its first and second start. Expect each first start to take up to
      a minute or two while Defender scans the new files and later starts to be fast; a second zip
      start as slow as the first is a regression. Also confirm the extracted copy's log shows the
      updater skipping with the zip reason. Record the numbers in the release notes.

Two more release-time runtime items pair with this pass, both verifiable only on a packaged build:

- the **updater live smoke** —
  [§ Updater live smoke](#updater-live-smoke-run-before-every-update-enabled-release), including the
  zip/Store negative checks, and
- the **license smoke** on a fresh `--user-data-dir`: with no key, Settings → License reports `free`
  and every feature works; after pasting a valid key it reports `licensed` with the licensee and
  update window; a key whose update window ended before this build reports `version_not_covered`.

### Windows zip (no-install build)

`StratoSortStack-<version>-win-x64.zip` is electron-builder's `zip` target (`win.target` in
`electron-builder.json`, named by the top-level `artifactName`). It archives the same `win-unpacked`
folder the installer is built from, with no wrapper folder, so the user extracts it once (to a short
path such as `C:\StratoSort`) and runs `StratoSort Stack.exe` from there; later starts reuse the
extracted files. It replaced the NSIS `portable` target after v5.0.0: that stub unpacked about 1.8
GB into `%TEMP%` on every launch and Defender rescanned it each time, which is why users saw a busy
cursor for a minute or more on every start.

- **x64 only.** The arm64 leg runs `electron-builder --win nsis --arm64`, which overrides
  `win.target`, so it ships the installer alone.
- **Never an update.** app-builder-lib writes Windows update info only for `nsis` (and opted-in
  `appx`) targets (`isSuitableWindowsTarget` in `out/publish/PublishManager.js`), and the zip target
  writes no blockmap. `scripts/verify-updater-metadata.js` fails if `latest.yml` lists anything but
  `.exe` installers.
- **Runtime guard.** `resources/app-update.yml` is still inside the zip, because electron-builder
  writes it once into the shared `win-unpacked` folder whenever an `nsis` target is in the build.
  `getUpdateTargetCapability()` in `src/main/core/autoUpdater.js` therefore treats a packaged
  Windows run without `Uninstall StratoSort Stack.exe` beside the exe (the NSIS installer writes it
  into the install folder) as unable to update in place, instead of letting electron-updater run the
  installer against a different folder.
- **Signing.** A zip carries no Authenticode signature. The release workflow verifies
  `win-unpacked\StratoSort Stack.exe`, the exe the zip is packed from, alongside the installer.
- **Path length.** The deepest file in the app (under
  `resources\app.asar.unpacked\node_modules\node-llama-cpp\dist\`) is about 175 characters below the
  app folder, an estimate from the current dependency tree. Explorer's built-in extractor stops at
  260 characters, which is why the install guide asks for a short folder.

`scripts/verify-packaged-artifacts.js --platform=win --arch=x64` fails when the zip is missing.

### Windows x64 payload size

The x64 app is about 1.8 GB on disk; arm64 is much smaller. Most of the difference is GPU prebuilts
that only exist for x64 (npm `unpackedSize`, version 3.22.2 of the node-llama-cpp packages and 1.1.3
of the whisper ones):

| Package                                                  | Size            | Role                                                                  |
| :------------------------------------------------------- | :-------------- | :-------------------------------------------------------------------- |
| `@node-llama-cpp/win-x64-cuda-ext`                       | 388 MB          | CUDA 12 build of `ggml-cuda.dll`, loaded from `fallback/` (see below) |
| `@node-llama-cpp/win-x64-cuda`                           | 183 MB          | Primary CUDA build, linked against the CUDA 13 runtime                |
| `@node-llama-cpp/win-x64-vulkan`                         | 74 MB           | Vulkan build (AMD, Intel, NVIDIA without CUDA)                        |
| `@node-llama-cpp/win-x64`                                | 33 MB           | CPU build                                                             |
| `@fugood/node-whisper-win32-x64-cuda` / `-vulkan` / base | 125 / 42 / 3 MB | Whisper transcription variants                                        |

arm64 ships `@node-llama-cpp/win-arm64` (11 MB) and the arm64 whisper base and Vulkan variants, no
CUDA, and no bundled FFmpeg.

**Why `win-x64-cuda-ext` stays.** node-llama-cpp 3.22.2 (`dist/bindings/Llama.js`) first loads the
primary `ggml-cuda.dll` and tries the `fallback/` folder of the ext package only when no GPU backend
loaded. The two DLLs need different CUDA libraries (from their PE import tables): the primary
imports `cublas64_13.dll` (CUDA 13 cuBLAS, runtime linked in), the fallback imports
`cudart64_12.dll` and `cublas64_12.dll`. So on an NVIDIA PC with a CUDA 12 toolkit the fallback is
the only way the text and embedding models run on CUDA; dropping the package would move those users
to Vulkan. The cudart DLLs the vision runtime stages (`cudart-llama-bin-win-cuda-12.4-x64.zip` by
default, or the 13.1 build when `STRATOSORT_CUDA_VERSION=13.1`, both from `VisionService`) do not
change this: `WhisperService` puts that folder on `PATH` only when it first loads for a
transcription, after the text and embedding engine has already chosen its backend, and
node-llama-cpp's startup CUDA check looks only on `PATH` and in the CUDA toolkit folders. CUDA 13
also needs a newer driver and no longer targets some older NVIDIA GPU generations that CUDA 12
supports (check NVIDIA's CUDA 13 release notes for the exact list before revisiting). Revisit only
if the app starts staging CUDA 13 libraries by default, before backend selection, and the
supported-GPU floor moves with it. `verify-packaged-artifacts.js` requires all four
`@node-llama-cpp/win-x64*` packages on x64.

**Build-only files excluded** (`files` in `electron-builder.json`). Each was checked against the
package code: nothing reads it unless it builds from source, and nothing builds from source inside
Electron.

| Pattern                                                                                           | Why it is unused at runtime                                                                                                                                                                                                                                           | Estimated saving                                        |
| :------------------------------------------------------------------------------------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------ |
| `node-llama-cpp/llama/gitRelease.bundle`                                                          | Read only by `utils/gitReleaseBundles.js`, which only the source download/clone path uses. `getLlama` defaults `build` to `"never"` when `process.versions.electron` is set and the app never overrides it, so `canBuild` is false and the clone path is unreachable. | 36 MB, 1 file                                           |
| `node-llama-cpp/llama/{addon,cmake,patches,profiles,toolchains,xpack}`, `llama/CMakeLists.txt`    | Inputs to `compileLlamaCpp` (cmake-js), behind the same `canBuild` gate.                                                                                                                                                                                              | 0.3 MB, 57 files                                        |
| `node-llama-cpp/templates`                                                                        | Used only by the `init` CLI command.                                                                                                                                                                                                                                  | 0.2 MB, 3 files                                         |
| `@fugood/whisper.node/{src,whisper.cpp}`, `CMakeLists.txt`                                        | C/C++ sources for building the addon. `lib/` only `require`s the prebuilt variant packages (or `build/Release`).                                                                                                                                                      | 5.4 MB, about 117 files                                 |
| `better-sqlite3/{deps,src}`                                                                       | SQLite amalgamation and addon sources for node-gyp. `lib/binding.js` loads `prebuilds/<platform>-<arch>.node` or `build/Release`.                                                                                                                                     | 10.4 MB, 33 files                                       |
| `better-sqlite3/prebuilds/` other than this build's own (`win.files`, `mac.files`, `linux.files`) | `getPrebuildPath()` loads only `<platform>-<arch>.node`, or `linuxmusl-<arch>.node` on musl Linux. Each platform's rule keeps `win32-${arch}`, `darwin-${arch}` or `linux-${arch}` plus `linuxmusl-${arch}`; electron-builder expands `${arch}` per packed arch.      | 15 MB, 7 files (Windows, macOS); 12 MB, 6 files (Linux) |

Together that is roughly 65 MB and 220 files less to write and scan on first launch (estimates from
the on-disk sizes in `node_modules`; the download shrinks less, by an estimated 40 to 50 MB, because
the installer compresses the source files well). Update the download size in
[INSTALL_GUIDE.md](INSTALL_GUIDE.md) after the next packaged build. `verify-packaged-artifacts.js`
checks that `llama/binariesGithubRelease.json` (read by node-llama-cpp on import) still ships and
that `llama/gitRelease.bundle` does not. `@node-llama-cpp/win-arm64` (11 MB) declares
`cpu: ["arm64", "x64"]`, so npm installs it on x64 runners too. `win.files` excludes the other
arch's llama prebuilts with `!**/node_modules/@node-llama-cpp/win-!(${arch}|${arch}-*)/**`:
electron-builder expands `${arch}` per packed arch, so the x64 build drops `win-arm64` and the arm64
build (which inherits `win.files` through `extends`) drops any `win-x64*` package.
`verify-packaged-artifacts.js` fails if a package for the other arch still holds files. It also
requires each build's own `better-sqlite3` prebuild (without it `lib/binding.js` falls back to
`build/Release`, which is not packaged, and SQLite cannot load) and fails if a prebuild for another
platform or arch was packaged.

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
