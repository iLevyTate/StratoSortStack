# StratoSort Core - Project Intelligence

## What This Is

StratoSort Core is a privacy-first, local AI-powered document organizer built on Electron 41. It
uses **node-llama-cpp** for in-process LLM inference and **Orama** for vector search. All processing
happens on-device with no required external services - no data leaves the machine.

## Tech Stack

- **Runtime:** Electron 41 (main + renderer + preload processes), Node.js 20.19+
- **Frontend:** React 19 + Redux Toolkit + Tailwind CSS 4 + Framer Motion
- **AI Backend:** node-llama-cpp (in-process LLM) + Orama (in-process vectors) + Tesseract.js (OCR)
- **Build:** Webpack 5 (3 configs: main, preload, renderer) + Babel 8
- **Package:** electron-builder 26 (NSIS/Portable on Windows, DMG on macOS, AppImage on Linux)
- **Test:** Jest 30 + Playwright 1.61
- **Lint:** ESLint 10 (FlatConfig) + Prettier 3

## Architecture

### Process Model

- **Main process** (`src/main/simple-main.js`): Window management, 30+ services, IPC server,
  LlamaService/OramaVectorService orchestration
- **Preload** (`src/preload/preload.js`): Secure IPC bridge with rate limiting (200 req/s), input
  sanitization, path validation, timeout handling
- **Renderer** (`src/renderer/`): React SPA with Redux state, no direct Node.js access

### Key Directories

```
src/main/services/       # 30+ backend services (LlamaService, OramaVectorService, SearchService, etc.)
src/main/analysis/       # Document/image analysis pipeline + embedding queue
src/main/core/           # Electron lifecycle, window creation, auto-updater, IPC registry
src/main/ipc/            # IPC handler registrations
src/renderer/components/ # React components organized by feature (discover/, organize/, search/, settings/, setup/)
src/renderer/store/      # Redux slices, middleware (persistence, IPC), thunks, selectors
src/shared/              # Cross-process utilities (logger, security, config schemas, constants)
test/                    # 400+ test files (unit, integration, e2e, perf, stress)
scripts/                 # 65 scripts/*.js files, most wired into npm (see package.json)
```

### Data Flow

- File analysis: User selects files -> Validation -> Document extraction -> LLM analysis -> Vector
  DB storage -> UI display
- Organization: AI suggestions -> User confirmation -> Atomic file move with undo/redo
- Search: Query -> Vector search + full-text (Orama BM25) -> Re-ranking -> Results

## Development Commands

```bash
npm run dev              # Full dev environment with HMR
npm run build            # Production build (all 3 webpack configs)
npm test                 # Jest unit/integration tests
npm run test:coverage    # Tests with coverage report
npm run test:e2e         # Playwright E2E tests
npm run lint             # ESLint check
npm run format:check     # Prettier check
npm run ci               # format:check + lint + typecheck + audit:production + compliance:commercial:verify + test:coverage + verify:ipc-contracts + build, plus the full verify:* suite (channels, ipc handlers/schemas/enforcement, mcp + ai-provider contracts, analysis routing, electron fuses, env docs, version tag) — package.json is the authoritative list
npm run local:gate       # verify:installed-electron + ci + verify:native-modules (one-shot pre-push convenience). GitHub Actions `CI` is configured for Windows + Ubuntu + macOS when Actions are enabled for the repo. Cloud CI has been off at the org/repo setting at times — `dependabot.yml` notes local gate as the only guaranteed gate. The e2e-smoke job is restricted to Windows + Ubuntu.
npm run dist:win         # Build Windows installer
```

**Embedding worker and queue waits** (`STRATOSORT_ENABLE_EMBEDDING_WORKER`,
`STRATOSORT_ANALYSIS_EMBEDDING_QUEUE_WAIT`, `STRATOSORT_ORGANIZE_EMBEDDING_QUEUE_WAIT`): see
[`docs/CONFIG.md`](docs/CONFIG.md#embeddings-and-embedding-queue-environment) (the table and the
operational notes below it).

**Cross-arch packaging clobbers dev `node_modules`.** Running `npm run dist:win:arm64` (or any
`@electron/rebuild --arch=<other>`) from your x64 dev checkout overwrites
`node_modules/<pkg>/build/Release/*.node` in-place — there is no per-arch shadow tree. The modules
listed in `scripts/native-modules.js` with `requiresElectronRebuild: true` (currently
`node-llama-cpp`, `better-sqlite3`) will then fail to load in `npm run dev` with Windows error 193
("not a valid Win32 application") and the `EmbeddingQueue` will spin in 5 s retry. Recovery:
`npm run rebuild` (defaults to host arch) followed by `npm run verify:native-modules`. To check the
binary's arch without running it, read the PE Machine field at offset `*(uint32*)[0x3C] + 4` —
`0x8664` = x64, `0xAA64` = arm64. Prefer running arm64 packaging on CI or in a separate worktree so
it doesn't clobber the dev tree.

## Conventions

- **Design philosophy** (deep modules, anti-pass-through, generality, hard constraints) is
  documented in `docs/PHILOSOPHY.md`. Reference it in reviews and before non-trivial PRs.
- **IPC channels** are defined in `src/shared/constants.js` and validated in preload. Run
  `npm run generate:channels:check` to verify channel consistency.
- **Services** follow dependency injection patterns documented in `docs/DI_PATTERNS.md`.
- **Error handling** uses custom error types in `src/main/errors/` with a centralized error
  classifier.
- **File operations** use atomic writes via `src/shared/atomicFileOperations.js` (write-to-temp then
  rename).
- **State persistence** uses debounced localStorage writes (1s debounce, 5s max wait) with
  quota-exceeded fallbacks.
- **Logging** uses structured logger from `src/shared/logger.js` with correlation IDs and JSONL
  format.
- **Security config** is centralized in `src/shared/securityConfig.js` (path limits, dangerous
  paths, rate limits, allowlisted settings).
- **JSDoc checkjs lane** — `.js` files opt into `noImplicitAny` typecheck by putting `// @ts-check`
  on line 1. `npm run typecheck:js` verifies opted-in files; `npm run verify:checkjs-ratchet` (in
  `ci`) enforces a monotonic floor and blocks new .js under `COVERED_DIRS` (`src/shared`,
  `src/preload`, `src/main/{ipc,services,analysis,errors,utils,workers,transports,core}`,
  `src/renderer/{services,hooks,phases,store,utils,components}` today (every `.js` under `src/` is
  now opted in — 464/464 as of 2026-10-03; `GLOBAL_DIRECTIVE_FLOOR` trails at 449, so the floor is
  due a bump) — see `scripts/verify-checkjs-ratchet.js` for the authoritative list) from landing
  without the directive. When adding a file to a covered dir: put `// @ts-check` on line 1 and fix
  the errors before commit. When opting in a new file elsewhere: bump `GLOBAL_DIRECTIVE_FLOOR` in
  `scripts/verify-checkjs-ratchet.js` to the new count.

## Known Production Gaps

These are tracked gaps that the project slash commands help address:

1. **Accessibility: manual AT pass outstanding** — structured WCAG 2.1 AA audit completed
   2026-07-02: jsx-a11y at `error` severity with a zero backlog, axe e2e gate across 8 screens +
   dark/light themes with `critical+serious` hard-fail. The graph-canvas keyboard path closed
   2026-07-03 (U-T14: React Flow node focus + selection toolbars, pinned by oracles). Remaining for
   a formal AA claim: a manual screen-reader pass (NVDA) only.
2. **Electron pinned to 41.x — a STALE pin, not a blocked one** (re-verified 2026-10-03). The
   original blocker is gone: `node-abi@4.35.0` carries ABI entries through electron 45, and the
   better-sqlite3 "prebuilts unavailable" condition is obsolete (upstream stopped publishing release
   prebuilts entirely, and we rebuild it from source anyway). Meanwhile latest electron is
   **44.5.1** — three majors ahead — which puts 41.x outside upstream security support, so the bump
   is a security item, not a dependency chore. `.github/dependabot.yml` holds the canonical
   rationale with the corrected ABI table, the revised unblock signal and the verification recipe;
   the earlier "ABI 136/137" figures there were wrong. **Still do not bump electron's major
   casually** — run the recipe in a separate worktree first (a rebuild overwrites `*.node` in
   place).
3. **SW-40 packaged verification outstanding** — `asarUnpack` was narrowed from `dist/**/*` to the
   seven worker entry bundles so main/preload/renderer stay inside the integrity-validated asar
   (`verify:electron-fuses-config` now fails if a pattern unpacks `dist/main.js` again), and
   `workerPools.resolveWorkerPath` prefers `app.asar.unpacked/dist/` when packaged, and
   `getRendererIndexPath` prefers `app.asar/dist/index.html` (unpacked renderer is a legacy fallback
   only). Before the next release a packaged build (`dist:win`) must be smoke-tested. **The
   checklist now lives where a release actually runs it:**
   [`docs/RELEASING.md` § Packaged-integrity checks (SW-40)](docs/RELEASING.md) — keep that the
   single source and do not re-fork it here. Status as of 2026-10-03: **not done.** The packaging
   change landed 2026-09-20; the newest packaged build on any dev machine is v4.0.6 (2026-07-06),
   and the last GitHub release is v4.0.6 (2026-06-17), so nothing has exercised these paths.

### Resolved Gaps

- ~~No Windows code signing~~ - `release.yml` signs via **Azure Trusted Signing** (account
  `stratosort-signing`, certificate profile `stratosortcore-public-trust-cert`, endpoint
  `https://eus.codesigning.azure.net/`, publisher `Kennedy Applied Sciences, Inc.` — these four
  signing-identity values are hardcoded in `scripts/configure-win-signing.js`) when the auth
  credentials are present: repo **Variables** `AZURE_TENANT_ID` + `AZURE_CLIENT_ID` and repo
  **Secret** `AZURE_CLIENT_SECRET`. Otherwise it falls back to unsigned ad-hoc builds.
  `win.azureSignOptions` is injected at build time by `scripts/configure-win-signing.js` and is
  intentionally absent from committed electron-builder configs (its presence would force Azure
  signing for local/fork builds). Credential setup: `docs/RELEASING.md` (Signing And Notarization
  Requirements).
- ~~macOS LGPL FFmpeg release not yet published~~ - `build-ffmpeg-lgpl.yml` was dispatched and the
  `ffmpeg-lgpl-latest` release now carries `ffmpeg-mac-{x64,arm64}.zip`;
  `scripts/setup-ffmpeg-runtime.js` (darwin branch) auto-resolves them and `dist:mac:*` runs
  `setup:ffmpeg-runtime`. Re-dispatch the workflow on FFmpeg version bumps — it now also attaches
  the exact source tarball (`ffmpeg-<version>-source.tar.xz`, LGPL §6 offer). Linux x64/arm64 bundle
  BtbN's `master-latest-{linux64,linuxarm64}-lgpl.tar.xz`. Windows arm64 still ships without bundled
  FFmpeg (no upstream LGPL win-arm64 build; `PATH` fallback applies).
- ~~No macOS code signing / notarization~~ - `mac-release.yml` signs with Developer ID Application
  and notarizes via `notarytool` + stapler when `MACOS_CSC_*` and `APPLE_*` repository secrets are
  set. First signed release: **v4.0.0**. Runbook: `docs/MAC_SIGNING.md`; post-release verification:
  `.github/workflows/verify-mac-signing.yml`.
- ~~Sandbox disabled~~ - Sandbox enabled (`sandbox: true` in `src/main/core/createWindow.js`);
  preload is webpack-bundled, no runtime `require()`.
- ~~CSP allows 'unsafe-eval'~~ - CSP uses `script-src 'self'` with no `unsafe-eval`
  (`src/main/core/createWindow.js`).
- ~~No state schema versioning~~ - Migration framework implemented in
  `src/renderer/store/migrations.js` (`CURRENT_STATE_VERSION = 4`) with version stamping in
  `persistenceMiddleware.js`.
- ~~No crash reporting~~ - Local `electron-crashReporter` in `src/main/simple-main.js` writes to
  `crash-dumps/` under userData with `uploadToServer: false` (no third-party crash telemetry).
- ~~Test coverage unknown~~ - Ratcheted global thresholds (branches 52 / functions 62 / lines 63 /
  statements 62, with tighter per-dir floors) enforced in `test/jest.config.js`. Current suite/test
  counts are the output of [`.github/workflows/ci.yml`](.github/workflows/ci.yml) — treat CI logs as
  source of truth rather than inline numbers here.
- ~~Coverage not enforced in CI~~ - CI now runs `npm run test:coverage` (enforces thresholds).
  Cross-platform matrix (Windows, macOS, Linux). Coverage artifacts uploaded.
- ~~Single-platform CI~~ - CI runs on `windows-latest`, `ubuntu-latest`, and `macos-latest`.
- ~~No IPC handler coverage check~~ - `npm run verify:ipc-handlers` statically verifies 100% of
  `IPC_CHANNELS` have registered handlers. `npm run ci` (run by every CI job) transitively invokes
  `npm run verify:ipc-contracts` — there is no standalone `ipc-contract-check` job.
- ~~No IPC payload schema validation~~ - Zod schemas added to every input-accepting handler. A small
  allowlist (`SCHEMA_OPTIONAL_CHANNELS` in `scripts/verify-ipc-handler-schemas.js`, today limited to
  zero-arg `WINDOW.*` chrome controls) is exempt pending a `z.void()` migration.
- ~~No transaction journaling~~ - `atomicFileOperations.js` now writes journal files before
  executing operations. `recoverFromJournals()` at startup rolls back incomplete transactions.
- ~~No remote logging~~ - **Intentional:** privacy-first product; logs and crash dumps stay under
  `userData` with `uploadToServer: false`. Not a shipping blocker.
- ~~Electron fuses unset~~ - `electron-builder.json` declares `electronFuses`; CI runs
  `npm run verify:electron-fuses-config`. Verify bits on a built binary with
  `npx @electron/fuses read --app <path>`.
- ~~IPC invoke without sender checks~~ - `ipcRegistry` wraps handlers with `ipcSenderValidator`
  (defense in depth). Bypass is explicit via `setTestBypass(true)` / `setDevPermissive(isDev)` in
  `ipcSenderValidator.js`, not `NODE_ENV=test`, and is ignored when packaged.
- ~~Floating promises in renderer unlinted~~ - ESLint `promise/catch-or-return` and
  `promise/always-return` apply to `src/renderer/**/*` at warn level (ratchet to error over time).

### License & Distribution Audit Trail (2026-05-04)

These are _recorded_ changes that move the project's distribution posture, called out so future
contributors and reviewers can find the intent without `git blame`-archaeology.

- **Project license: Proprietary internal-use → PolyForm Noncommercial 1.0.0 (2026-09-14).**
  Personal/noncommercial use is free; commercial use requires a paid signed key. `package.json`
  `"license": "PolyForm-Noncommercial-1.0.0"`. Runtime: no trial and no feature gate (both removed
  2026-09-29 for the public release). `LicenseService` only reports `free`, `licensed` or
  `version_not_covered` for Settings → License; nothing reads it to decide whether work may run.
  `classifyProjectLicense` treats PolyForm Noncommercial as `allowed` because commercial rights are
  sold separately. Third-party dependency obligations (LGPL FFmpeg attribution, etc.) are unchanged.
- **FFmpeg distribution: GPL-3 `ffmpeg-static` (npm) → LGPL-3 bundled binary.** The viral GPL clause
  is incompatible with closed-source distribution. Replaced by a multi-source resolver in
  `MediaTranscoder.resolveFfmpegPath()` (env override → bundled → PATH) plus the runtime setup
  script. Subprocess-only invocation, so the LGPL relink-ability obligation does not apply;
  attribution lives in `assets/runtime/ffmpeg/NOTICE.md`.
- **`X-XSS-Protection` response header retained.** Modern browsers (Chrome 78+) ignore it; kept for
  security-scanner score (Mozilla Observatory et al.) and as defense-in-depth. See comment in
  `src/main/core/createWindow.js` near the header set.
- **`STRATOSORT_*` documentation ratchet.** `scripts/audit-env-vars.js` pattern coverage extended
  (catches `env.X`, `envVar: 'X'`, `resolveCpuPoolThreads('X')`); a new `scripts/verify-env-docs.js`
  guard fails CI on undocumented vars. Run `npm run verify:env-docs` locally before pushing.
- **Renderer libraries live in `devDependencies` but still ship.** `react`, `react-dom`,
  `react-redux`, `react-window`, `prop-types`, `@xyflow/react`, `elkjs`, `embedding-atlas`,
  `framer-motion`, `lucide-react` are `devDependencies` so electron-builder does not copy their
  `node_modules` into the installer — webpack bundles them into the renderer chunk
  (`webpack.config.js` renderer `externals: {}`). Because the lockfile marks them `dev: true`,
  `npm audit --omit=dev` and a naive dev-skip would drop them from every gate.
  `BUNDLED_RENDERER_DEPS` in `scripts/compliance/commercial-compliance-lib.js` lists them; their
  transitive lockfile closure is flagged `bundledRenderer` in `docs/commercial-use-inventory.json`,
  gated by `compliance:commercial:verify`, included in `licenses:production`, and CVE-scanned by
  `npm run audit:bundled` (in `ci`). `ci` also runs `git diff --exit-code` on the inventory right
  after the verify step, so a stale committed inventory fails CI — regenerate and commit it. Add a
  renderer library there when moving it to `devDependencies`; a stale entry fails the gate.

<!-- Removed "Cursor Rules & Commands" table — the referenced .cursor/rules/*.mdc
files do not exist in the repo. The natural-language invocations the table
promised would silently no-op. If/when those rule files are written, restore
the table from git history. -->
