# Changelog

<p align="center">
  <img src="https://img.shields.io/badge/format-Keep%20a%20Changelog-E05735?style=flat-square" alt="Keep a Changelog" />
  <img src="https://img.shields.io/badge/versioning-SemVer-3F4551?style=flat-square" alt="Semantic Versioning" />
</p>

All notable changes to StratoSort Stack will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [5.1.0] - 2026-10-31

Faster, more predictable Windows startup, a zip instead of the self-extracting portable exe, and
smaller downloads on every platform.

### Security

- `minimatch` 10 → 11.0.3 for GHSA-g3hv-75wg-m249 (denial of service via globparts amplification).
- Electron 41 → 45 (45.1.0). Electron 41 was outside upstream security support and affected by eight
  advisories, including GHSA-jr5w-w6x2-84p9 (HID/USB permission checks attributed to the wrong
  origin; SameSite cookies not applied to windows opened from links).

### Changed

- `better-sqlite3` 12 → 13. 12.x no longer compiles against Electron 45; 13.x ships N-API prebuilds,
  so it is no longer rebuilt per Electron version.
- macOS 13 (Ventura) is now the minimum supported macOS version (Electron 44 dropped macOS 12).
- **Windows:** the self-extracting portable exe (`StratoSortStack-5.0.0-win-x64.exe`), which
  unpacked the whole app into `%TEMP%` on every start, is replaced by
  `StratoSortStack-5.1.0-win-x64.zip`. Extract it once and run `StratoSort Stack.exe` from the
  extracted folder; like the portable exe, it does not update itself. The Setup installer is still
  the recommended download.
- The AI engine remembers the GPU backend that worked (`gpu-backend-cache.json` in the app's data
  folder) and tries it first on the next launch. An app update, a different GPU or graphics driver
  version, a change in the GPU runtimes node-llama-cpp finds (such as installing a CUDA toolkit), or
  14 days make it run the full backend search again. The optional embedding worker
  (`STRATOSORT_ENABLE_EMBEDDING_WORKER`) uses the same record and supported-backend filter.
- The Windows x64 build no longer ships node-llama-cpp's arm64 prebuilt (about 11 MB).
- Each build ships only its own SQLite (`better-sqlite3`) native binary instead of the ones for
  every platform: about 15 MB smaller on macOS, about 12 MB on Linux, and one 2 MB file less on
  Windows.
- On Windows and macOS the app no longer forces Chromium's `enable-gpu-rasterization` and
  `enable-zero-copy` switches, so Chromium's per-driver GPU blocklist applies. Linux keeps forcing
  them, as before.
- After three GPU process exits in one session, software rendering now stays on for up to 3 days
  (`.gpu-fallback` in the app's data folder) instead of switching back on the next launch, which
  made launches alternate between slow and fast on a failing driver. Delete the file while the app
  is closed to retry hardware acceleration sooner.

### Fixed

- Windows startup: the window is shown at most 4 s after it is created even when its first frame is
  late, and at once when the GPU process exits before then; the AI engine waits for the first paint
  (up to 3 s); GPU backends whose runtime libraries are missing are skipped instead of test-loaded;
  the GPU is probed once per launch; and checks of the Documents `Uncategorized` folder give up
  after 3 s.
- Starting the app while it is still shutting down (for example right after **Quit**) now opens it
  again once the shutdown has finished, instead of doing nothing.
- **Settings → Application → Check for updates** on a copy that cannot update itself (the extracted
  Windows zip, a Microsoft Store install, or a Linux build other than the AppImage) now explains why
  instead of reporting "Failed to check for updates". With auto-updates disabled it now says so
  instead of "Checking for updates…".

## [5.0.0] - 2026-10-26

First public release of StratoSort Stack: source published on GitHub under the PolyForm
Noncommercial License 1.0.0, with signed installers on GitHub Releases.

### Added

- Atlas map, timeline, knowledge stats card, Downloads triage trust pack, MCP server kit, and
  repository history visualization (PRs #375–#407).

### Changed

- **License:** StratoSort Stack is now released under the PolyForm Noncommercial License 1.0.0.
  Personal and other noncommercial use is free with every feature; commercial use needs a paid key
  (see [docs/COMMERCIAL.md](docs/COMMERCIAL.md)).
- **No trial, no feature gate:** the app runs the same with or without a license key. Settings →
  License only reports `free`, `licensed`, or `version_not_covered`; nothing is locked.
- **Product name:** StratoSort Core is now StratoSort Stack. Existing `StratoSort Core` user data is
  migrated on first launch (`src/main/core/userDataMigration.js`). Source and releases live at
  [iLevyTate/StratoSortStack](https://github.com/iLevyTate/StratoSortStack).
- **Auto-updates on by default:** installed (packaged) builds now check GitHub Releases for updates
  at startup and every 4 hours. Turn background checks off in Settings → Application → Background
  Update Checks, or disable the updater with `STRATOSORT_ENABLE_AUTO_UPDATES=false`. Development
  runs never check.

### Fixed

- July feature-burst follow-up: F-150..F-186 (typecheck, atomicMove destination lock, file-operation
  broadcasts, Atlas races, triage undo identity, overlay guards).
- Organize-phase undo no longer re-indexes restored files as already-organized.
- Smart Folder matching now uses description, keywords, and file-type rules.
- Auto-update: macOS and Windows arm64 clients now find their channel file (`latest-mac.yml` /
  `latest.yml` are merged across architectures instead of renamed per arch).
- Undo/redo: a failed or partial undo no longer updates the UI as if every file had moved.
- Organize: interrupted batches resumed at launch now get undo entries and search-index updates for
  every replayed move; resume runs under the batch lock; batch-lock TTL no longer overlaps rollback.
- Downloads watcher: error-driven restart works again, and organizing files out of Downloads no
  longer deletes their embeddings; disabling auto-organize mid-restart wins over the restart.
- MCP: rejected initialize requests no longer leak a server per attempt; disabling MCP while a
  client holds an SSE stream no longer hangs the toggle; token storage survives keyring changes.
- Analysis: timed-out PDF extractions release their buffers; corrupt DOCX runs OCR once instead of
  up to six times; oversized text files are refused even when the initial stat fails.
- Settings: the `ai` block is validated on save/import (provider base URL scheme, cloud consent) and
  repaired on read; DOS device-namespace paths can no longer bypass smart-folder containment; CSV
  export uses RFC 4180 quoting with formula neutralisation.
- Packaging: `.env` is ignored in packaged builds; only worker bundles are unpacked from the asar so
  integrity validation covers application code.

## [4.0.6] - 2026-06-17

### Fixed

- **Search result UI:** corrected confidence display, fixed layout overlap, and resolved text
  overflow in the search result cards.
- **Embeddings:** bound the conditional logger in the full-rebuild access-error path so the error
  branch logs correctly instead of throwing on an unbound reference.
- **Branding/assets:** regenerated the icon set from the updated logo SVG, fixed transparent logo
  corners, and refreshed installer art.

### Changed

- **Discover:** routed `AnalysisResultsList` confidence through the shared `normalizeConfidence`
  helper for consistent confidence handling across the discover and search views.

### Dependencies

- Bumped `csv-parse` 6.2.1 → 7.0.0, `js-yaml` → 4.2.0, and `tar` → 7.5.16 (clears audit advisories),
  plus minor-and-patch dependency group updates.
- Pinned `hono` → `^4.12.25` via `overrides` to clear a high-severity advisory in the transitive
  copy pulled by `@modelcontextprotocol/sdk` (path traversal in `serve-static` on Windows,
  GHSA-wwfh-h76j-fc44, plus related adapter/CORS/body-limit fixes).

## [4.0.5] - 2026-06-14

### Fixed

- **Windows code signing (Azure Trusted Signing):** rewired the release pipeline to a simplified
  credential scheme. The Microsoft Entra tenant and client IDs are now repository **Variables**
  (`AZURE_TENANT_ID`, `AZURE_CLIENT_ID`) and only the client secret remains a repository **Secret**
  (`AZURE_CLIENT_SECRET`). The four public signing-identity values (publisher, endpoint, certificate
  profile, signing account) are hardcoded in `scripts/configure-win-signing.js` instead of threaded
  through workflow env. The detect step trims the tenant/client IDs before exporting them, so a
  stray trailing newline in a pasted variable can no longer break Entra authentication
  (`AADSTS700016`). Signing remains native via electron-builder's `win.azureSignOptions`, keeping
  the updater `latest.yml` sha512/blockmap valid.

## [4.0.4] - 2026-06-12

Supersedes v4.0.3, whose release pipeline shipped a compromised Windows installer (dual-arch NSIS
whose arm64 half was cross-built without arm64 whisper natives) and failed to publish macOS/Linux
artifacts (sha512 metadata mismatch from cross-arch artifact collisions). v4.0.3 is marked as a
prerelease on GitHub.

### Fixed

- **Release packaging (all platforms):** `electron-builder.json` targets no longer pin `arch`
  arrays. Config-declared arch arrays are a standing build matrix that CLI `--x64`/`--arm64` flags
  do not filter, so every release leg silently built both arches. Arch is now driven exclusively by
  CLI flags; the redundant `electron-builder.{win-x64,linux-x64,linux-arm64}.json` configs are
  removed and `electron-builder.win-arm64.json` retains only its `artifactName` override.
- **Windows arm64 verify:** `verify-packaged-artifacts.js` no longer requires
  `@fugood/node-whisper-win32-arm64-cuda` — that variant was never published (no CUDA toolkit for
  Windows-on-Arm). Base + Vulkan remain required.
- **Linux release staging:** `mac-release.yml` stages arch-scoped artifact globs (deb `amd64` /
  AppImage `x86_64` for x64) so the x64 and arm64 legs can no longer collide in the flat
  publish-release merge — the root cause of the v4.0.3 sha512 mismatch.
- **Windows arm64 packaging:** `dist:win:arm64` passes an explicit `nsis` CLI target so the portable
  target is not built for arm64.

## [4.0.3] - 2026-06-09

Ship-ready release combining v4.0.2 CI fixes with the new SVG branding pipeline and Windows
packaging improvements.

### Added

- **Branding:** `StratoSortStackLogo.svg` as the master icon source;
  `npm run generate:branding-if-source` for CI/release regen (macOS ICNS verified on darwin).
- **Windows dual build:** `npm run dist:win:dual` plus single-arch
  `electron-builder.win-{x64,arm64}.json` configs.
- **Organize routing test:** Vendor fallback when category does not match a smart folder.

### Changed

- **Icons:** Regenerated ICO/PNG/BMP/DMG assets from the new disc logo; macOS packaging uses
  `icon.icns`.
- **CI:** macOS CI and all release workflows run branding generation before packaging.

### Fixed

- **Windows release CI:** Regenerate branding assets before build; per-arch updater metadata verify
  (`--arch=`).

## [4.0.2] - 2026-06-08

Unblocks GitHub Release publish for signed macOS builds plus Linux x64 and arm64 artifacts.

### Fixed

- **Linux CI metadata verify:** Per-matrix `verify-updater-metadata.js --arch=` checks so the arm64
  leg no longer demands x64 `latest-linux.yml` after the arm64 rename step.
- **Linux packaging:** Single-arch `electron-builder.linux-{x64,arm64}.json` configs so arm64 CI
  does not also emit x64 installers.

## [4.0.1] - 2026-06-08

Patch release to unblock the v4.0.0 GitHub Release publish step. Linux arm64 CI failed because the
vision runtime setup script did not download `llama-*-bin-ubuntu-arm64.tar.gz`; `publish-release`
requires all matrix legs to succeed.

### Fixed

- **Linux arm64 packaging:** Vision runtime setup and `VisionService` now resolve `ubuntu-arm64` /
  `ubuntu-vulkan-arm64` llama.cpp binaries; backend selector enables Vulkan on Linux arm64 where
  upstream ships the asset.
- **llama.cpp pin:** Default `STRATOSORT_LLAMA_CPP_TAG` bumped from `b7956` to `b9000` (first tag
  with upstream `ubuntu-arm64` assets).

## [4.0.0] - 2026-06-05

First **signed and notarized macOS** release. Developer ID Application signing and Apple
notarization run automatically in `mac-release.yml` when the five `MACOS_CSC_*` / `APPLE_*`
repository secrets are configured. See `docs/MAC_SIGNING.md` for the full runbook and
`verify-mac-signing.yml` for post-release Gatekeeper verification.

17 commits since v3.2.1. Highlights: MCP stateful HTTP transport, AI provider routing refactor,
Knowledge OS graph insights redesign, searchable settings, and Orama embedding stability fixes.

### Added

- **macOS distribution:** Developer ID signing + `notarytool` stapling in CI; standalone
  `verify-mac-signing.yml` workflow for Gatekeeper smoke tests on published DMGs.
- **MCP:** Stateful Streamable HTTP sessions with initialize-before-list probe client; contract
  verifier updated to match.
- **Search / Graph:** Cluster display labels, graph insight utilities, unified search modal UX
  refresh, and bridge ActionCards in the sidebar.
- **Settings:** Searchable settings panel with improved section navigation.
- **Postinstall:** Auto-download Whisper model during setup (`setup-whisper-model.js --auto`).

### Changed

- **AI providers:** Centralized routing helpers (`aiProviderRouting.js`), cloud provider ready-cache
  sync after key changes, and Settings configuration UX polish.
- **Diagnostics:** Whisper on-disk model presence and Llama initialized state surfaced in About.

### Fixed

- **Orama:** Guard null embedding spread in hash updates; persist category/date on embedding
  refresh.
- **Startup:** Remove splash synchronously when the window is still hidden; retry post-load health
  checks before logging false alarms.
- **Settings:** Accept custom chat persona IDs (`custom:…`) through IPC validation.
- **Search UI:** Sidebar accordion no longer clips ActionCard primary buttons.
- **Embeddings:** Log per-file rebuild failures; raise IPC errors cap to 50.

### Notes

- **macOS v4.0.0+** DMGs are signed with Developer ID Application and notarized. Older unsigned
  preview builds may still require right-click → Open; see `docs/INSTALL_GUIDE.md`.
- **Windows** installers are signed via Azure Trusted Signing when the `AZURE_*` secrets are
  provisioned (see `docs/RELEASING.md`); otherwise they fall back to unsigned ad-hoc builds and
  SmartScreen will warn on first run.
- See `git log v3.2.1..v4.0.0` for the full commit list.

## [3.2.1] - 2026-06-05

Patch release preparing the signed-macOS pipeline (signing runbook, verify workflow, dependency
audit fixes). macOS artifacts from this tag were built **unsigned** — use **v4.0.0** for the first
notarized Developer ID build.

## [3.2.0] - 2026-06-01

55 commits since v3.1.1. Highlights: smart-folder duplicate detector, graph panel improvements,
Whisper CUDA broadening, regression-lock rounds 1–3, packaging hardening, and a comprehensive
analysis-pipeline stability sweep.

### Added

- **Smart Folders:** Canonical-equivalent duplicate detector now runs at startup and surfaces
  pre-existing duplicates (e.g. `Logos` vs `Logos and Graphic Design`) with a one-click resolution
  flow (#264). Companion `FOLDER_NAME_EQUIVALENT` IPC error code mirrored client-side in
  `AddSmartFolderModal` (#261).
- **Smart Folders:** `analysis.suggestedNewFolder` surfaced in `ReadyFileItem` with an inline hint
  chip and optional "Create" button — closes the gap where files routed to "Uncategorized" without
  signal about the matched theme (#261).
- **Graph:** Collapsible panels, plain-language edge explanations, pinned tooltips, and styled React
  Flow controls (#220, #229).
- **Media:** File-size limits with adaptive concurrency tuning; large media files no longer starve
  the analysis pool (#247).
- **Whisper:** Variant loader + prerequisite matrix + binding-contract guards (#207). Broader CUDA
  DLL search and installed-CUDA-version detection (#265).
- **Legal / Support:** Dedicated documentation, clustering safeguards, and the semantic-pipeline
  reference doc (#232).
- **Documentation:** `docs/UI_WIRING_AUDIT.md` (post–v2.0.9 UI structure, IPC matrix); post-v2.0.9
  regression audit closeout doc (#263); cross-arch packaging caveat doc; developer-onboarding
  cleanup (#210).
- **Settings:** **Watch Smart Folders** and **Background Update Checks** toggles in application
  preferences (defaults unchanged).

### Fixed

- **Regression-locks round 3:** Abort signal now threaded into semantic folder matching so
  post-window-close embeddings can't corrupt the vector DB; `batchOrganizeHandler` returns
  `{ success: false, partialFailure: true, errorCode: PARTIAL_FAILURE }` from the outer-catch path
  so renderers can't render "organized" while N files remain in source (#261).
- **Analysis pipeline:** Naming idempotency (bare-year stripping, version-token preservation,
  double-date fix); embedding-override floor (`FOLDER_MATCH_UNMATCHED_CATEGORY_FLOOR = 0.75`) when
  the LLM's category isn't in the smart-folder set; theme preservation through
  `matchCategoryToFolderWithSuggestion` (#252). Phantom folder-vector hits dropped; naming
  instrumentation added (#246). Log when new-folder suggestions are surfaced (#267). Error-code
  mapping with underlying-cause preservation. Low-VRAM thrashing and dev-session audit gaps
  addressed (#268).
- **IPC hardening:** `fileOperationSchema` path validation centralised; enforcement sets shared
  across handlers (#266). Round-2 IPC audit fixes (collision parity, dryRun/strict schemas,
  `PATH_TOO_LONG` demote, TOCTOU retry on rename races) (#261).
- **Search & Chat:** Graph-blend weighting in semantic search; simple-mode setting honoured in chat;
  cloud→local provider fallback when external provider is unreachable (#261). Stray NUL byte removed
  from ChatPanel dedup key (#238). Persona picker surfaced in always-visible chat header (#222);
  custom personas included from settings with validated/sanitized IDs.
- **Settings & infra:** `autoConcurrency` schema migration; model resolver accepts documented union;
  watcher depth honours configured limit; restore-from-backup respects TTL (#261).
- **Llama / Whisper:** Explicit vision GPU layers on tight VRAM; CUDA Whisper backend enabled
  (#250). First-attempt context size adapts across hardware tiers; spurious "context creation
  failed" warnings suppressed on low-VRAM GPUs.
- **Vector:** Spurious folder-index repair churn from Orama similarity cutoff stopped.
- **Extractors:** `officeparser` v6+ AST read via `toText()` (#245).
- **Embeddings:** Full model context used for summaries; folder-match threshold tuned (#242).
- **UI wiring:** Post-v2.0.9 audit fixes for personas, settings toggles, docs (#233, #236). Nav
  pointer-events fix; skip-link and display-heading gradient cleanup (#225). Smart-folder
  close-on-success, shared name validation, per-file matcher, reanalyze scope copy (#224).
- **Media analysis:** Option propagation and degraded-state tracking (#201, #202, #203, #204).

### Changed

- **Packaging:** Hardened for all OS/arch targets; electron-builder verify config, asar fuses,
  cross-arch native rebuild guards (#240, #241). Electron pinned to **41.x** to stop the bump-revert
  cycle (ABI 137 / `node-abi` / `better-sqlite3` prebuilt gaps documented in
  `.github/dependabot.yml`) (#215).
- **Refactoring:** Ousterhout-style complexity reduction across IPC and search modal (#221).
  Silent-fallback observability with `swallow()` helper and lint-disable hygiene (#219).
- **Logging:** Expected-degraded paths downgraded to debug/info to cut noise (#230).
- **Code maintenance:** Real-bug sweep, dead-code removal, service-header normalisation (#211).
- **Organize:** `SmartOrganizer` documented as experimental / not mounted in the shipping
  `OrganizePhase`.
- **CI:** `STRATOSORT_ALLOW_DEV_CLEAN` documented; dead `enableTelemetry` schema removed (#251).
- **Dependencies:** Multiple minor/patch group bumps (#205, #208, #209, #213, #231, #235, #244,
  #257); `officeparser` to 7.1.0 (#235); `better-sqlite3` (#209); `minimatch` to 10.x (#213).

### Security

- **IPC:** `fileOperationSchema` path validation hardened — rejects UNC, all `<scheme>://` URIs, NUL
  bytes, relative paths through a shared validator (#266).
- **Electron:** Pinned to 41.x rather than rolling forward to 42 until the native-rebuild chain is
  unblocked (see `.github/dependabot.yml`) (#215).

### Notes

- Windows installers are **unsigned** ad-hoc builds; SmartScreen will warn on first run. macOS
  signing/notarization activates automatically when `MACOS_CSC_*` / `APPLE_*` secrets are set.
- See `git log v3.1.1..v3.2.0` for the full list of 55 commits.

## [3.1.1] - 2026-05-08

- **macOS distribution:** mac DMG/ZIP builds now bundle a self-hosted LGPL-3 FFmpeg binary
  (`STRATOSORT_FFMPEG_URL` wired into `mac-release.yml`, sourced from the `ffmpeg-lgpl-latest`
  GitHub release produced by `build-ffmpeg-lgpl.yml`). Replaces the GPL-3 `ffmpeg-static` npm
  dependency that was incompatible with closed-source distribution. Subprocess-only invocation; LGPL
  relink-ability obligation does not apply. Attribution at `assets/runtime/ffmpeg/NOTICE.md`.

## [2.0.8] - 2026-04-06

- **Release:** Published `v2.0.8` with refreshed Windows release artifacts and checksums.
- **CI / packaging:** Added Linux release workflow coverage and improved Linux packaging metadata
  handling in release preparation.
- **Compliance:** Added commercial compliance gates and reporting artifacts to strengthen
  release-time verification.
- **Installer / update hardening:** Included recent updater and installer path/registration fixes
  from the pre-release stabilization branch.

## [2.0.7] - 2026-03-30

- **Dependencies**: Production `npm audit` remediated (including `fast-xml-parser`, `tar`,
  `underscore`); `officeparser` pinned to patched `file-type` via npm `overrides`.
- **Crash reporting**: Removed `@sentry/electron`; main process uses local `electron-crashReporter`
  only (`uploadToServer: false`).
- **Build**: `officeparser` is a main-bundle external so ESM-only `file-type` resolves at runtime.
- **Pre-launch remediation**: Chat in-memory sessions use `LRUCache` (50 / 60m TTL) with eviction
  hook; PDF pipeline uses one 300s `AbortController` + raw extractors; `ProcessingStateService` lock
  chain has terminal `.catch()`; Orama sidecar startup spot-check; `EmbeddingQueue` mutex timeout no
  longer force-releases; IPC preload retries 3; `chunkText` word-boundary snapping; `SECURITY.md`
  and `docs/LICENSE_AUDIT.md` / `docs/ORAMA_VECTOR_SIDECAR.md`; CI runs `npm run audit:production`.

## [2.0.6] - 2026-03-12

### Added

- **Stability framework**: Smoke suite, telemetry, and release threshold checks for regression
  detection; `scripts/stability/run-smoke-suite.js`, `check-release-thresholds.js`, and baseline
  ledger.
- **clearReadyQueue IPC**: New handler and processing state method for embedding queue management.
- **GPU binary restore script**: `scripts/restore-gpu-binaries.js` to restore renamed GPU addons
  after cloud/headless workarounds.
- **Release preflight**: `scripts/release-preflight.js`, `verify-build-assets.js`, and
  `verify-ipc-contracts.js` for packaging and IPC validation.
- **textModelActivity**: Interactive LLM request tracking for UI state.
- **E2E walkthrough**: Comprehensive docs with 37 annotated figures, demo videos, and walkthrough
  content files.
- **.env.example**: Advanced AI tuning and persistence options documented.
- **Model download progress**: Enhanced tracking and UI updates during model installation.

### Changed

- **Electron**: Upgraded from 40.8.0 to 41.0.0.
- **Node.js**: Upgraded from 20.11.0 to 20.19.0 (required for chokidar, ESLint).
- **Path handling**: Replaced `path.basename` with `crossPlatformBasename` for consistent filename
  extraction across Windows/macOS/Linux.
- **Documentation**: Minimal Mistakes theme, notice blocks, GLightbox image zoom, refreshed
  INSTALL_GUIDE and CONFIG.md tables.
- **Release workflows**: Hardened validation, packaging gates, and artifact version alignment.

### Fixed

- **Analysis queue**: Increased limit from 500 to 1000 and centralized in `performanceConstants`;
  SmartFolderWatcher no longer skips files with "Analysis queue full" during bulk imports.
- **Race conditions and concurrency**: Resolved data loss, crash bugs, and deadlocks across
  analysis, persistence, and IPC layers.
- **Event loop and memory**: Fixed blocking, leaks, and UI jank; added queue limits and Orama
  eviction.
- **Extractor and OCR**: Restored regressions in document extraction and image analysis pipeline.
- **Path validation**: Hardened separator-sensitive validation and tests.
- **GPU detection**: Require confirmed CUDA detection on Windows; async exec/execFile for GPU
  detection.
- **Virtualized lists**: Restored react-window interactions in large lists.
- **Graph, privacy, analysis UX**: Restored graph rendering, privacy flows, and analysis phase
  stability.
- **Semantic persistence**: Hardened fallback selection and confidence tracking.
- **Schemas and hydration**: Fixed operationProgressSchema, concurrency limits, stale selectors, and
  timer leaks.
- **GraphTour**: "Don't show this again" now persists across sessions.
- **Batch organize**: Fallbacks to uncategorized when folder matching fails.
- **Accessibility**: Extract accessible label from mixed children in Button component.
- **Long Task violations**: Deferred setInterval handlers (heartbeat, stall check) in discover phase
  to avoid 50–275ms blocks in Chrome DevTools.

### Improved

- **Performance**: react-window virtualization for large lists; offload heavy regex parsing to
  worker_threads; throttle OPERATION_PROGRESS; export history via save dialog; chat/graph and
  inference queue fairness.
- **Settings and search**: Strengthened settings workflows and semantic search IPC.
- **Analysis caching**: Improved responsiveness and caching behavior.
- **Scrollbar styles**: Enhanced usability.
- **CI**: Jest heap increase (`NODE_OPTIONS=--max-old-space-size=4096`) to prevent OOM;
  `--forceExit` in npm scripts; coverage enforcement; artifact version fixes.

## [2.0.5] - 2026-02-26

_See [GitHub Release v2.0.5](https://github.com/iLevyTate/StratoSortStack/releases/tag/v2.0.5) for
release notes._

## [2.0.4] - 2026-02-23

### Fixed

- **E2E Stability**: Added Linux CI sandboxing bypass and resolved missing Range header clear bugs
  in vector DB tests.
- **Path Handling**: Updated file utilities to use `win32.basename` for consistent filename
  retrieval across platforms.
- **OCR fallback**: Gracefully handle missing `sharp` native module during PDF extraction.
- **UI glitches**: Resolved phase rendering issues and model setup wizard initial loading states.
- **Settings synchronization**: Synced config state across main/renderer boundaries; watchers now
  reliably observe valid settings.
- **Storage**: Healed legacy "Uncategorized" folder paths and resolved smart folder UI bugs.
- **Naming conventions**: Centralized naming logic and fixed casing bugs with non-ASCII characters.

### Improved

- **Verification**: Added scripts for verifying IPC handlers, native modules, packaged artifacts,
  and updater metadata.
- **Performance**: Cached parsed chat conversations (LRU) to avoid repeated JSON overhead.
- **Performance**: Optimized search graph node filtering and ELK parallel edge rendering.
- **Build**: Enhanced release preflight checks and enforced macOS/Windows code signing checks in CI.

## [2.0.2] - 2026-02-15

### Changed

- **Release pipeline run**: Prepared a patch release to trigger fresh Windows and macOS release
  workflows with the current packaging pipeline and artifact conventions.

## Release Checklist

See [docs/RELEASING.md](docs/RELEASING.md) for versioning, runtime staging, checksums, and release
notes.

## [2.0.1] - 2026-02-13

### Fixed

- **macOS startup stability**: Prevented app launch failure when `lz4-napi` native bindings are
  unavailable in packaged environments by adding a shared codec wrapper with graceful fallback.
- **Persistence startup path hardening**: Updated vector DB, analysis history, and embedding queue
  persistence modules to use safe LZ4 codec loading instead of hard-failing at module import time.

## [2.0.0] - 2026-02-09

### Changed (BREAKING)

- **In-Process AI Engine**: Replaced external Ollama server with **node-llama-cpp** for fully
  in-process LLM inference. All text, vision, and embedding models now run on-device via GGUF files
  with automatic GPU acceleration (Metal, CUDA, Vulkan) and CPU fallback. No external services
  required.
- **In-Process Vector Database**: Replaced external ChromaDB server with **Orama** for in-process
  vector storage and hybrid search. BM25 full-text and vector similarity are combined via Reciprocal
  Rank Fusion (RRF). Indexes persist atomically with LZ4 compression.
- **Electron 40+**: Upgraded from Electron 35 to Electron 40 with modern security defaults.
- **Zero External Dependencies**: The application is now fully self-contained. No Ollama, ChromaDB,
  or any other external server is needed. All processing happens on-device with zero data leaving
  the machine.

### Removed

- **Ollama Integration**: All Ollama client code, connection management, and configuration removed.
- **ChromaDB Integration**: All ChromaDB client code, server health checks, and configuration
  removed.
- **Deprecated Settings**: Legacy `ollamaUrl`, `chromadbUrl`, and related connection settings are
  ignored on upgrade (cleaned up by `SettingsMigrator`).

### Added

- **LlamaService**: Centralized in-process LLM inference service with model switching, memory
  management, and GPU/CPU backend selection.
- **LlamaResilience**: Circuit breaker, retry, and timeout guard for all AI inference calls.
- **ModelAccessCoordinator**: Coordinates concurrent model access to prevent conflicts during model
  switching.
- **Content Selector**: Intelligent document content selection for LLM analysis with token budget
  awareness.
- **Crash Reporting**: Local `electron-crashReporter` only (`crash-dumps/` under userData, no
  upload).
- **Test Coverage Enforcement**: 50% global thresholds (branches/functions/lines/statements)
  enforced in CI.

### Improved

- **Code Quality**: Consolidated 11 categories of duplicate, conflicting, and dead code:
  - Unified temp-file patterns into single canonical set in `performanceConstants.js`
  - Unified file-ID generators (`getSemanticFileId` delegates to `getCanonicalFileId`)
  - Disambiguated path normalization variants (`sanitizePathValue` vs `resolveFsPath`)
  - Replaced 15+ inline `setTimeout` delays with shared `delay()` utility
  - Centralized error classifiers (lifecycle delegates to `errorClassifier.js`)
  - Unified fallback analysis factories (`analysisUtils` delegates to `fallbackUtils`)
  - Replaced hardcoded RRF constant with `SEARCH.RRF_K` from `performanceConstants`
  - Replaced hardcoded retry counts with `RETRY.*` constants across 6 files
  - Consolidated duplicate `Semaphore` classes (single implementation in `RateLimiter.js`)
  - Removed dead no-op functions and commented-out code
  - Replaced ad-hoc `pLimit` with `Semaphore`-based concurrency limiter
- **Production Builds**: Console logs stripped from production bundles via Terser `drop_console`.
- **Security Documentation**: Updated known production gaps in `CLAUDE.md` to reflect resolved items
  (crash reporting, test coverage enforcement).

## [1.2.2] - 2026-01-29

### Improved

- **UI Consistency**: Standardized typography, spacing tokens, and button styles across renderer
  views.
- **Search & Graph UX**: Aligned metadata labels, banners, and empty states to shared Text/Heading
  components.

### Fixed

- **Organize UI**: Restored missing Button import in ReadyFileItem to prevent runtime crashes.

## [1.2.1] - 2026-01-27

### Added

- **Settings Backup & Restore**: Added backup service with import/export and restore UI.
- **User Data Migration**: Recover legacy settings/history/undo state before service startup.
- **Embedding Summaries**: Centralized embedding summary builder for richer semantic matching.

### Improved

- **Search & Chat**: Tuned hybrid retrieval, memory handling, and fallback responses.
- **Smart Folder Watcher**: Enhanced embedding metadata for better folder suggestions.
- **IPC & Validation**: Expanded schemas and hardened settings import validation.

### Fixed

- **Auto-Updater**: Listener cleanup and download progress reporting.
- **Settings Recovery**: Safer corruption recovery and backup integrity checks.

## [1.2.0] - 2026-01-26

### Added

- **UNC Path Support**: Enhanced support for network paths (UNC) in setup, analysis, and watchers.
- **Demo Mode**: Implemented demo mode with path redaction and UI updates.
- **Organization Workflow**: Revamped organization workflow UI.
- **Discovery Phase**: Enhanced discovery phase UI and performance.

### Improved

- **Modernized UI**: Major updates to core UI components, styling, application shell, and global
  components.
- **Settings**: Modernized settings and dependency panels.
- **Analysis**: Improved folder scanning and network path resilience.

## [1.1.0] - 2026-01-23

### Added

- **Smart Folder Watcher**: Automatically analyzes new and modified files in configured smart
  folders (F-1)
- **Undo History Navigation**: Jump to specific points in undo history (L-2)
- **Retry Mechanism**: "Retry Failed Files" button in Discover phase (M-3)
- **Conflict Detection**: Warning banner when multiple files target the same destination path (M-4)
- **AI Description Generation**: "Generate with AI" button for smart folders (C-1)
- **Enhanced Graph Visualization**:
  - **Color-Coded Nodes**: Files in the Knowledge Graph are now color-coded by category
    (Blue=Documents, Purple=Images, etc.) for instant visual recognition.
  - **"Relationship Analysis" Tooltips**: Hovering over connection lines now explains _why_ files
    are connected (e.g., "Both Images", "Same Subject", "Shared Tags").
  - **Improved Layout**: Switched to `BRANDES_KOEPF` algorithm for straighter, more organized graph
    structures with better handling of outliers.
  - **Robust Data Handling**: Graph nodes now robustly display metadata even if underlying search
    results are nested or incomplete.
- **UI Spacing Improvements**:
  - Implemented `spacious` (32px) layout density in Setup Phase for a cleaner, less cluttered look.
  - Standardized grid gaps and padding across main views.
- Comprehensive test coverage for IPC handlers (settings.js, suggestions.js)
- SECURITY.md with vulnerability disclosure policy
- This CHANGELOG.md file
- E2E tests for semantic search functionality
- E2E tests for smart folder creation and verification
- DevTools auto-open in separate window during development (`npm run dev`)
- Error boundary around AnalysisResultsList to prevent crashes from malformed file data
- `getErrorMessage()` utility for consistent error extraction
- Centralized UI timeout constants (WIDGET_AUTO_SHOW, EMBEDDING_CHECK, STUCK_ANALYSIS_CHECK)

### Fixed

- **Critical**: Smart Folder Watcher race condition where watcher was null during IPC registration
  (NEW-1)
- **Critical**: DownloadWatcher starting before services initialized (C-2)
- **High**: Confidence slider resetting to 75% due to state race conditions (NEW-5/12)
- **High**: Undo/Redo UI not updating despite filesystem changes (H-3)
- **High**: Smart folder path loading race condition showing "Documents" string (H-1)
- **Medium**: Embeddings showing "0" count due to missing auto-refresh (NEW-2/9)
- **Medium**: "File in use" errors during auto-organize (NEW-4)
- **Medium**: Settings debounce flushing on close (H-2)
- **Medium**: Modal backdrop blur/z-index conflicts (F-3, M-1)
- **Medium**: Image files missing keywords in analysis history (NEW-10)
- **Medium**: Watcher reporting high confidence for unrelated files (NEW-11)
- **Critical**: LLM cache contamination causing wrong filename suggestions across file types
  - Added type discriminators (`type: 'document'` / `type: 'image'`) to cache keys
  - Added filename and content length to cache keys for uniqueness
  - Enhanced cache hit logging for debugging
- **Critical**: Stale closure in bulk category change causing wrong files to be updated
  - Used refs to always get latest values at debounce execution time
- **Critical**: Race condition in undo/redo system allowing concurrent action execution
  - Added mutex lock to prevent overlapping operations
  - Exposed `isExecuting` state for UI feedback
- **Critical**: UI Persistence issue where KnowledgeOS would reopen with only the file search
  visible
  - Switched `WIDGET_AUTO_SHOWN_KEY` and `MODAL_OPEN_STATE` to `localStorage` for robust state
    persistence across restarts.
- **Build System**: Fixed stale cache issues in development causing "Cannot find module" errors by
  adding a pre-build `clean` step.
- Toast timer reset when parent component re-renders with new callback reference
  - Used ref for onClose callback to maintain timer stability
- ResizeObserver not attaching when container ref is null on first render
  - Switched to callback ref pattern for proper observation
- localStorage access crashes in private browsing mode
  - Wrapped all localStorage operations in try-catch
- Infinite loop potential in persistence middleware
  - Added re-entry guard to prevent recursive saves
- UndoStack listener cleanup on component remount
  - Added mounted state tracking to prevent setState on unmounted components
- Error handling in FloatingSearchContext useEffect
- ProcessingStateService timestamp updates on save
- ESLint warnings in test files
- Navigation selector in E2E tests to target phase navigation buttons specifically
- Unused `useCallback` import in SearchAutocomplete.jsx

### Improved

- **UI**: Replaced emojis with professional Lucide icons (UI-2)
- **UI**: Removed technical "File size limit" settings from UI (UI-1)
- **UI**: Temporarily removed confidence slider to prevent race conditions (NEW-12)
- Accessibility: Added `aria-live="polite"` to AnalysisProgress for screen readers
- Replaced hardcoded timeout values with centralized constants

## [1.0.0] - 2024-12-XX

### Added

#### Core Features

- **AI-Powered Document Organization**: Local LLM analysis using in-process models (llama, llava)
- **Semantic Search**: Vector-based file search using Orama embeddings
- **Smart Folders**: AI-suggested organization with pattern learning
- **Multi-modal Analysis**: Support for documents (PDF, Word, Excel), images, and code files
- **Batch Processing**: Organize multiple files simultaneously with progress tracking
- **Auto-Organization**: Watch folder monitoring (e.g., Downloads) for automatic sorting

#### User Interface

- Modern React UI with TailwindCSS styling
- Dark/Light/System theme support
- Floating search widget for quick file discovery
- Interactive graph visualization for file relationships
- Drag-and-drop file organization
- Keyboard shortcuts for common operations

#### Organization Intelligence

- Content-based file categorization
- Extension pattern matching
- User behavior learning from accepted suggestions
- Multiple organization strategies (by type, date, project, etc.)
- Confidence scoring for suggestions

#### Data Management

- Settings backup and restore functionality
- Settings import/export with validation
- Undo/redo system for file operations
- Analysis history caching for performance

#### Developer Experience

- Comprehensive test suite (76%+ coverage, 4800+ tests)
- ESLint and Prettier configuration
- CI/CD pipeline with GitHub Actions
- Extensive documentation

### Security

- Context isolation enabled for Electron renderer
- Input validation using Zod schemas
- Path sanitization to prevent traversal attacks
- Prototype pollution protection in settings import
- No external network requests (privacy-first design)

### Technical

- Electron 35+ with modern security defaults
- React 19 with Redux Toolkit for state management
- Webpack 5 build system with code splitting
- Jest and Playwright testing infrastructure
- Multi-platform builds (Windows, macOS, Linux)

---

## Version History Format

### Types of Changes

- **Added**: New features
- **Changed**: Changes to existing functionality
- **Deprecated**: Features that will be removed in future versions
- **Removed**: Features that have been removed
- **Fixed**: Bug fixes
- **Security**: Security-related changes

Note: versions before 5.0.0 were released from predecessor repositories whose tags are not part of
this repository's history, so they are listed without links.

[Unreleased]: https://github.com/iLevyTate/StratoSortStack/compare/v5.1.0...HEAD
[5.1.0]: https://github.com/iLevyTate/StratoSortStack/compare/v5.0.0...v5.1.0
[5.0.0]: https://github.com/iLevyTate/StratoSortStack/releases/tag/v5.0.0
