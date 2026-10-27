# Package Scripts — Canonical Reference

Every npm script in `package.json`, grouped by purpose. If you find yourself searching package.json
with Ctrl+F to figure out what to run, that's the signal to update this file instead.

## Daily development

| Script                | What it does                                                        | When to use                                   |
| --------------------- | ------------------------------------------------------------------- | --------------------------------------------- |
| `npm run dev`         | Clean, build main+renderer (dev mode), launch Electron with logging | First-thing-in-the-morning launch             |
| `npm run dev:fast`    | Launch without rebuilding (assumes a previous dev build exists)     | Iterating on main-process changes             |
| `npm run dev:cdp`     | `dev:fast` + `--remote-debugging-port=9222`                         | Driving the app over Chrome DevTools Protocol |
| `npm run dev:demo`    | `dev` with `STRATOSORT_REDACT_PATHS=1` (paths redacted in the UI)   | Screenshots / recordings                      |
| `npm start`           | Same as `dev` without the running-instance check and `clean` step   | Slightly faster restart                       |
| `npm run start:prod`  | Launch with `NODE_ENV=production` against existing build            | Smoke-testing a prod-style binary locally     |
| `npm run start:debug` | Launch existing dev build with `--inspect` (no rebuild)             | Attaching a Node inspector to main            |

## Build

| Script                                | What it does                                                                                                          | When to use                                               |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `npm run build`                       | Clean, build main (prod webpack), build renderer (prod), copy assets, sync installer license, verify splash CSP hash  | Pre-release; pre-commit if you touched build config       |
| `npm run build:dev`                   | Renderer dev build + copy assets                                                                                      | Hot reload backed off                                     |
| `npm run build:main`                  | Main+preload webpack (prod)                                                                                           | Touching anything in `src/main/` or `src/preload/`        |
| `npm run build:main:dev`              | Same, dev mode                                                                                                        | Same, when you want sourcemaps                            |
| `npm run build:analyze`               | `build` + webpack-bundle-analyzer report                                                                              | Investigating bundle bloat                                |
| `npm run clean`                       | `rimraf dist .webpack-cache`                                                                                          | When you suspect stale build cache                        |
| `npm run rebuild`                     | Rebuild native modules for current Electron ABI                                                                       | After upgrading Electron or `sharp`/`better-sqlite3`/etc. |
| `npm run restore:gpu`                 | Rename the node-llama-cpp GPU addons back from `.bak` (undoes the headless/no-GPU workaround in `DEBUGGING_GUIDE.md`) | After using the CPU-only workaround                       |
| `npm run generate:branding-if-source` | Regenerate branding assets (incl. `icon.icns` on macOS) when the source logo exists                                   | Run automatically by `dist:mac:*`                         |

## Tests

| Script                                       | What it does                                                                                     | When to use                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------ | --------------------------------------- |
| `npm test`                                   | Jest unit + integration (jsdom, with open-handles detection)                                     | Every PR                                |
| `npm run test:coverage`                      | Same with coverage report and threshold enforcement                                              | Before pushing                          |
| `npm run test:watch`                         | Jest in watch mode                                                                               | TDD loop                                |
| `npm run test:integration`                   | `test/integration/` only, `--runInBand`                                                          | When your change crosses processes      |
| `npm run test:stress`                        | Stress-suite Jest config                                                                         | Release; rarely otherwise               |
| `npm run test:all`                           | `test` + `test:stress`                                                                           | "Did I break something somewhere else?" |
| `npm run test:e2e`                           | Playwright (full UI flow)                                                                        | Manual smoke + release                  |
| `npm run test:e2e:headed` / `:debug` / `:ui` | Same, with browser visible / debugger / inspector                                                | Diagnosing flaky e2e                    |
| `npm run test:e2e:report`                    | Open the last Playwright report                                                                  | After an e2e run                        |
| `npm run test:e2e:live-llm`                  | Only the `@live-llm` Playwright specs (real models)                                              | Manual, with models installed           |
| `npm run test:soak`                          | 12-minute Playwright soak test                                                                   | Release pre-flight                      |
| `npm run test:critical-path`                 | Just the smoke-suite Jest specs                                                                  | When testing the gate's critical path   |
| `npm run test:critical-path:twice`           | Smoke suite on the previous release tag and on `HEAD` (temp git worktrees), then threshold check | Inside `preflight:release`              |

## Lint, format, typecheck

| Script                 | What it does                                         | When to use                                   |
| ---------------------- | ---------------------------------------------------- | --------------------------------------------- |
| `npm run lint`         | ESLint over the repo                                 | Pre-push                                      |
| `npm run lint:fix`     | ESLint with `--fix`                                  | After a refactor pass                         |
| `npm run typecheck`    | `tsc --noEmit`                                       | Pre-push (catches type errors in `.ts` files) |
| `npm run typecheck:js` | `tsc --noEmit -p tsconfig.checkjs.json`              | When you've added `@ts-check`-annotated JS    |
| `npm run knip`         | Knip report of unused files, exports and deps        | Dead-code cleanup                             |
| `npm run knip:files`   | Knip, unused files only                              | Part of `ci`                                  |
| `npm run format`       | Prettier write across src/, test/, scripts/, configs | Bulk-format                                   |
| `npm run format:check` | Prettier check (no write)                            | Pre-push; part of `ci`                        |

## Pre-merge / pre-release verification

| Script                            | What it does                                                                                                                                                                                                                                   | When to use                                                                                    |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `npm run ci`                      | format:check + lint + typecheck + typecheck:js + audit:production + audit:bundled + compliance:commercial:verify (+ inventory diff gate) + test:coverage + generate:channels:check + 12 `verify:*` scripts (marked below) + knip:files + build | Locally before push; mirrors the cloud CI `ci` job                                             |
| `npm run local:gate`              | `verify:installed-electron` + `ci` + `verify:native-modules`                                                                                                                                                                                   | One-shot local pre-push gate; cloud CI also runs `ci` + native-module verification on every PR |
| `npm run preflight:release`       | Requires a clean worktree. Native verify + `test:critical-path:twice` + `compliance:commercial:verify` + clean `release/build` + platform dist + packaged-artifact verify                                                                      | Before tagging a release                                                                       |
| `npm run preflight:release:quick` | Same, skipping the dist build and packaged-artifact checks (`--skip-dist`)                                                                                                                                                                     | Quick sanity before a series of release attempts                                               |

### Individual verify:\* scripts

Useful to run individually when you broke one and want a fast loop. The **In `ci`** column marks the
twelve that `npm run ci` runs; the rest run in `local:gate`, release preflight, release workflows,
or on demand.

| Script                         | What it verifies                                                                    | In `ci` |
| ------------------------------ | ----------------------------------------------------------------------------------- | ------- |
| `verify:ipc-handlers`          | 100% of IPC_CHANNELS have a registered handler                                      | yes     |
| `verify:ipc-handler-schemas`   | Every handler that accepts input has a Zod schema (small allowlist for zero-arg)    | yes     |
| `verify:ipc-contracts`         | Renderer/preload/main contract consistency                                          | yes     |
| `verify:ipc-enforcement`       | Concurrency-limited / enforcement channel sets are consistent                       | yes     |
| `verify:ipc-event-schemas`     | Every main→renderer push event that is sent has a payload schema                    | yes     |
| `verify:mcp-contracts`         | MCP server interface consistency                                                    | yes     |
| `verify:ai-provider-contracts` | AI provider interface consistency (BYOK contracts)                                  | yes     |
| `verify:analysis-routing`      | Analysis dispatch correctness                                                       | yes     |
| `verify:electron-fuses-config` | electron-builder.json declares the fuses and `asarUnpack` keeps app code in asar    | yes     |
| `verify:env-docs`              | All `STRATOSORT_*` env vars are documented in `docs/CONFIG.md`                      | yes     |
| `verify:checkjs-ratchet`       | `// @ts-check` coverage never drops; new files in covered dirs must opt in          | yes     |
| `verify:version-tag`           | `package.json` is not behind the latest `v*` tag (warns when ahead)                 | yes     |
| `verify:ipc-consumers`         | Every bridged `electronAPI` method is actually called from the renderer             | no      |
| `verify:installed-electron`    | The installed Electron matches the pinned version (`local:gate`, `predist:win`)     | no      |
| `verify:native-modules`        | Native modules load under the current Electron ABI (`local:gate`, preflight, CI)    | no      |
| `verify:build-assets`          | Build outputs have expected files                                                   | no      |
| `verify:packaged-artifacts`    | Packaged installers/zips have expected contents                                     | no      |
| `verify:packaged-linux`        | Linux variant of the above                                                          | no      |
| `verify:runtime-prereqs`       | Runtime binary prereqs (FFmpeg, etc.) are present where expected                    | no      |
| `verify:splash-csp`            | Splash screen CSP hash matches the hardcoded value (also run at the end of `build`) | no      |
| `verify:updater-metadata`      | electron-updater `latest*.yml` metadata is consistent                               | no      |

## Setup (runtime assets)

| Script                                      | What it does                                                         |
| ------------------------------------------- | -------------------------------------------------------------------- |
| `npm run setup:deps`                        | Download default AI models automatically                             |
| `npm run setup:models` / `:check`           | Download/verify GGUF models listed in `modelRegistry.js`             |
| `npm run setup:vision-runtime` / `:check`   | Download/verify `llama-server` vision runtime                        |
| `npm run setup:ffmpeg-runtime` / `:check`   | Download/verify bundled FFmpeg                                       |
| `npm run setup:whisper-model` / `:check`    | Download/verify Whisper model                                        |
| `npm run setup:tessdata-runtime` / `:check` | Download/verify bundled Tesseract language data                      |
| `npm run setup:mac-signing`                 | PowerShell helper for the [`MAC_SIGNING.md`](MAC_SIGNING.md) runbook |
| `npm run models:check` / `models:download`  | Aliases for `setup:models` variants                                  |

## Distribution (electron-builder)

| Script                              | Platform | Result                                                                                                         |
| ----------------------------------- | -------- | -------------------------------------------------------------------------------------------------------------- |
| `npm run package`                   | host     | Full build + runtime setup, then `electron-builder build` for the host's default targets into `release/build/` |
| `npm run dist`                      | host     | Default platform installer                                                                                     |
| `npm run dist:win`                  | Windows  | NSIS installer + portable (x64); `predist:win` checks the installed Electron first                             |
| `npm run dist:win:verify`           | Windows  | `verify:installed-electron` then the `dist:win` chain                                                          |
| `npm run dist:win:arm64`            | Windows  | NSIS installer (arm64, no bundled FFmpeg)                                                                      |
| `npm run dist:win:dual`             | Windows  | x64 + arm64 installers staged under `release/dual-windows/`; restores host-arch native modules                 |
| `npm run dist:mac`                  | macOS    | DMG, both arches (runs `:arm64` then `:x64`)                                                                   |
| `npm run dist:mac:arm64` / `:x64`   | macOS    | DMG (specific arch); regenerates branding (`icon.icns`) first                                                  |
| `npm run dist:linux`                | Linux    | AppImage + .deb                                                                                                |
| `npm run dist:linux:x64` / `:arm64` | Linux    | AppImage + .deb for a specific arch                                                                            |
| `npm run dist:all`                  | all      | Builds for all three (only works on macOS host with cross-compile)                                             |

## Compliance / license

| Script                                 | What it does                                                        |
| -------------------------------------- | ------------------------------------------------------------------- |
| `npm run audit:production`             | `npm audit --omit=dev` (security advisories)                        |
| `npm run audit:bundled`                | Full `npm audit`; fails on high/critical in bundled renderer deps   |
| `npm run licenses:production`          | Generate `docs/licenses-production.json` (gitignored) from the lock |
| `npm run compliance:commercial:build`  | Regenerate the commercial compliance inventory                      |
| `npm run compliance:commercial:verify` | Gate: fails on `high_risk` or `unknown` licenses                    |
| `npm run docs:env-audit`               | Find undocumented `STRATOSORT_*` env vars                           |

## Generators / one-offs

| Script                             | What it does                                                                                                    |
| ---------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `npm run generate:channels`        | Print the generated preload IPC channel block from `constants.js` to stdout (no write)                          |
| `npm run generate:channels:check`  | Check whether the generated file is up to date (CI uses this)                                                   |
| `npm run generate:channels:update` | Regenerate and write the preload IPC channel allowlist file in place                                            |
| `npm run generate:icons`           | Generate platform icon files from the source logo (`assets/icons/StratoSortStackLogo.svg`, legacy PNG fallback) |
| `npm run generate:nsis`            | Generate NSIS installer assets                                                                                  |
| `npm run generate:assets`          | `generate:icons` + `generate:nsis`                                                                              |
| `npm run audit:ipc-line-data`      | Regenerate (the previously-deleted) IPC line-by-line audit                                                      |
| `npm run inventory:ipc-main-sends` | List all main→renderer `webContents.send()` call sites                                                          |
| `npm run tour:record`              | Record the how-to-use product tour (paths redacted); `:library` / `:studio` record single topics                |
| `npm run tour:compose`             | Compose walkthrough media from a recorded tour; `:lessons` builds the lesson clips                              |

## Stability / benchmarking

| Script                                  | What it does                                                        |
| --------------------------------------- | ------------------------------------------------------------------- |
| `npm run stability:fixtures`            | Generate the synthetic-corpus test fixtures under `.tmp/stability/` |
| `npm run stability:smoke`               | Run the smoke suite (sanity test, fast)                             |
| `npm run stability:benchmark:fixtures`  | Benchmark against the synthetic corpus                              |
| `npm run stability:benchmark:e2e-batch` | E2E batch-analysis benchmark                                        |
| `npm run stability:compare`             | Compare two SHAs against the baseline ledger                        |
| `npm run stability:ledger`              | Generate / update the baseline ledger                               |
| `npm run stability:check-thresholds`    | Check release-threshold drift                                       |

## Diagnostics / monitoring

| Script                                | What it does                                                            |
| ------------------------------------- | ----------------------------------------------------------------------- |
| `npm run startup:check`               | Sanity check before launching the app                                   |
| `npm run diagnostics:real-models`     | Run the pipeline against real model files                               |
| `npm run measure:embeddings`          | Offline embedding-quality probe (doc↔folder cosine scores, no Electron) |
| `npm run monitor:batch`               | Live tail of batch-analysis progress                                    |
| `npm run monitor:batch:electron-node` | Same, running under Electron-as-Node                                    |

## Hooks / housekeeping

| Script                | What it does                                                           |
| --------------------- | ---------------------------------------------------------------------- |
| `npm run prepare`     | Husky install (run by `npm install`)                                   |
| `npm run postinstall` | Rebuild native modules for the current Electron ABI                    |
| `npm run upgrade`     | `npm-check-updates -u && npm install` (run with care; review the diff) |

---

## How to add a new script

1. Put it in `package.json` with a clear, hyphenated name. Prefix matters: `verify:*` for verifiers,
   `test:*` for test runners, `stability:*` for the benchmark suite, etc. A `verify:*` prefix does
   not wire it into CI by itself — see step 3.
2. Add a row in this file under the matching section.
3. If it should run in CI, append it to the `ci` script's chain.
4. If it creates files, add the output path to `.gitignore`.
