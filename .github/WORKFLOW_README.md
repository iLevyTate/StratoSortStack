# GitHub Actions Configuration

## Overview

This repository is configured with automated dependency updates and release builds.

## Workflows

### 1. Dependabot Configuration (`.github/dependabot.yml`)

- **Automatically creates PRs** for dependency updates daily
- Groups minor and patch updates together
- Labels PRs with `dependencies` and `automerge`

### 2. Dependabot Auto-merge (`.github/workflows/dependabot-automerge.yml`)

- **Off unless the repo Variable `DEPENDABOT_AUTOMERGE` is `true`.**
- When on, enables GitHub auto-merge (squash) for patch and minor Dependabot updates; major updates
  wait for manual review.
- Auto-merge waits only for checks that branch protection marks **required**. With no required
  checks on `main` it merges immediately, before CI runs. Before setting the variable, add a branch
  protection rule or ruleset on `main` that requires the `CI` checks to pass.

**Optional Setup**: If your repository has branch protection requiring PR approval:

1. Create a Personal Access Token (PAT) with `repo` scope
2. Add it as a repository secret named `DEPENDABOT_PAT`
3. Uncomment the auto-approve step in the workflow

### 3. CI (`.github/workflows/ci.yml`)

- **Job (`ci`)**: on pull requests, `npm ci` then **`npm run ci`** on Ubuntu, Windows, and macOS
  (format, lint, typecheck, production audit, commercial compliance verify, `test:coverage`,
  `generate:channels:check`, the full `verify:*` suite, and `build` — see `package.json` for the
  exact step list).
- **Job (`e2e-smoke`)**: Playwright smoke specs on Ubuntu and Windows.
- **Stricter local gate** (includes Electron-linked native check): `npm run local:gate` (=
  `verify:installed-electron` + `npm run ci` + `verify:native-modules`).
- Triggered on pull requests and pushes to main/master/develop/RegressionFixes

### 4. Windows release (`.github/workflows/release.yml`)

- **Triggers on version tags** `v*.*.*` (and `workflow_dispatch` with an existing tag name for
  re-runs), matching `mac-release.yml`.
- Alternatively run `npm run dist:win` locally and upload artifacts to the GitHub Release (e.g.
  `gh release upload`).
- Optional signing via Azure Trusted Signing: repo **Variables** `AZURE_TENANT_ID`,
  `AZURE_CLIENT_ID` and repo **Secret** `AZURE_CLIENT_SECRET` (the signing-identity values —
  account, profile, endpoint, publisher — are hardcoded in `scripts/configure-win-signing.js`). When
  any of the three credentials is missing, the build falls back to unsigned ad-hoc artifacts.

### 5. macOS + Linux release (`.github/workflows/mac-release.yml`)

- **Triggers on version tags** `v*.*.*` (and `workflow_dispatch`). Produces macOS arm64 + x64
  DMG/ZIP and Linux x64 + arm64 AppImage/deb (the `build-linux` job is a
  `[ubuntu-latest, ubuntu-24.04-arm]` matrix); publishes to the tag’s GitHub Release with per-arch
  updater metadata.
- Windows installers for the same release: **Release (Windows)** (an x64 + arm64 matrix) runs on the
  same tag push automatically; build locally and attach only as a fallback.

### 6. Manual Dist Build (`.github/workflows/manual-dist.yml`)

- **Defaults**: macOS on, Windows off (Windows dist is expected locally via `npm run dist:win`).
- Uploads workflow artifacts; optional draft release when enabled.

## Build Outputs

### Windows

- **NSIS Installer (x64)**: `StratoSortStack-Setup-<version>.exe`
- **NSIS Installer (arm64)**: `StratoSortStack-Setup-<version>-arm64.exe` (built on the
  `windows-11-arm` runner; better-sqlite3 is compiled from source there. Ships **without** bundled
  FFmpeg — no win-arm64 LGPL build exists — and falls back to a system `ffmpeg` on `PATH`.)
- **No-install zip (x64)**: `StratoSortStack-<version>-win-x64.zip` (the `win-unpacked` folder,
  extracted once by the user; it does not auto-update and replaces the portable `.exe` shipped up to
  v5.0.0; see `docs/RELEASING.md` § Windows zip)
- **Checksums**: `checksums-windows-{x64,arm64}.sha256`
- **Updater metadata**: `latest.yml` (one file listing the x64 and arm64 installers, merged from the
  two legs; never the zip), `*.blockmap`

### macOS

- **DMG**: `StratoSortStack-<version>-mac-{arm64,x64}.dmg`
- **ZIP**: `StratoSortStack-<version>-mac-{arm64,x64}.zip`
- **Checksums**: `checksums-macos.sha256`
- **Updater metadata**: `latest-mac-arm64.yml`, `latest-mac-x64.yml`

### Linux (x64 + arm64, built on the tag release)

- **AppImage**: `StratoSortStack-<version>-linux-{x64,arm64}.AppImage`
- **DEB**: `StratoSortStack-<version>-linux-{amd64,arm64}.deb`
- **Checksums**: `checksums-linux.sha256`
- **Updater metadata**: `latest-linux.yml` (x64), `latest-linux-arm64.yml` (arm64)
- Bundles a real LGPL FFmpeg (BtbN `*-lgpl.tar.xz`, extracted via system `tar -xJf`). The arm64 leg
  runs on the native `ubuntu-24.04-arm` runner so better-sqlite3 builds for the correct ABI.

## Configuration Files

### `electron-builder.json`

- Configures build outputs and installer settings
- macOS/Linux (`mac-release.yml`) and Windows (`release.yml`) both publish on `v*.*.*` tag pushes
  via Actions; both also support `workflow_dispatch` against an existing tag. `electron-builder` CLI
  uses `--publish never` in npm scripts (uploads are handled by the workflows).
- Artifact naming follows `electron-builder.json` conventions for each target.

## Next Release References

Current release: see `gh release list` (this file intentionally does not pin a version — it has
drifted before). Before cutting the next tag, confirm these docs stay aligned:

1. `README.md` version badge and release links
2. `CHANGELOG.md` new version section + `[Unreleased]` compare base
3. `docs/RELEASING.md` checklist and artifact naming

## Required Secrets

### Built-in (no setup needed)

- `GITHUB_TOKEN`: Automatically provided by GitHub Actions

### Optional

- `DEPENDABOT_PAT`: Personal Access Token for auto-approving PRs (only if branch protection requires
  reviews)
- Windows Azure Trusted Signing: repo **Variables** `AZURE_TENANT_ID`, `AZURE_CLIENT_ID` plus repo
  **Secret** `AZURE_CLIENT_SECRET`. Enables Authenticode signing for Windows release artifacts (the
  service principal must hold the _Trusted Signing Certificate Profile Signer_ role on the
  `stratosort-signing` account; signing-identity values are hardcoded in
  `scripts/configure-win-signing.js`)
- `MACOS_CSC_LINK`, `MACOS_CSC_KEY_PASSWORD`, `APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`,
  `APPLE_TEAM_ID`: Enable macOS signing + notarization

macOS tag releases can publish unsigned artifacts when Apple secrets are absent. **Release
(Windows)** also runs on tag pushes; use its workflow dispatch (or **Manual Dist Build**) for
re-runs or a draft release from selected platforms.

## Testing Locally

### Build Windows installer:

```bash
npm run dist:win
```

### Build without packaging (faster):

```bash
npx electron-builder --win --dir
```

Output location: `release/build/`

## Troubleshooting

### Dependabot PRs not auto-merging

1. Check if branch protection requires reviews
2. If yes, add `DEPENDABOT_PAT` secret
3. Ensure required status checks are passing

### Release not publishing

1. **macOS**: tag must match `v*.*.*`; check **Release (macOS)** in Actions.
2. **Windows**: also tag-triggered (`v*.*.*`); check **Release (Windows)** in Actions, or re-run it
   manually with the tag name.
3. Verify `GITHUB_TOKEN` is available (automatic in Actions).

### Build errors

1. Run `npm ci` to ensure clean dependencies
2. Run `npm run build` before electron-builder
3. Check `release/build/` for partial outputs
