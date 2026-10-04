---
layout: single
title: 'Configuration Reference'
sidebar:
  nav: 'docs'
toc: true
toc_label: 'Contents'
toc_icon: 'sliders-h'
header:
  overlay_color: '#000'
  overlay_filter: '0.5'
  overlay_image: /assets/e2e-screenshots/19_settings_ai_config_engine.webp
  caption: 'Configuration Reference'
---

# Configuration Reference

This document lists all environment variables and configuration options available in StratoSort
Core.

## Model & OCR Setup

The AI stack runs in-process (node-llama-cpp + Orama). You only need models and OCR:

### Setup Commands

```bash
npm run setup:deps          # Download models (best-effort)
npm run setup:models        # Download GGUF models
npm run setup:models:check  # Verify models
```

### Setup Script Flags (Advanced)

These variables affect setup scripts and `postinstall` behavior:

| Variable              | Default | Description                                                   |
| :-------------------- | :------ | :------------------------------------------------------------ |
| `SKIP_APP_DEPS`       | `0`     | Skip `postinstall` native rebuild and all setup scripts       |
| `SKIP_RUNTIME_VERIFY` | `0`     | Skip the post-install `verify:runtime-prereqs` matrix display |

### Default AI Models

StratoSort Core uses the **Base (Small & Fast)** profile by default (configurable in Settings → AI
Configuration). A **Better Quality** profile with larger models is available during setup.

| Role          | Default (Base)                      | Better Quality                                     |
| :------------ | :---------------------------------- | :------------------------------------------------- |
| **Text**      | `Llama-3.2-3B-Instruct-Q4_K_M.gguf` | `Qwen2.5-7B-Instruct-Q4_K_M.gguf` (128K context)   |
| **Vision**    | `llava-v1.6-mistral-7b-Q4_K_M.gguf` | `llava-v1.6-mistral-7b-Q4_K_M.gguf`                |
| **Embedding** | `all-MiniLM-L6-v2-Q4_K_M.gguf`      | `nomic-embed-text-v1.5-Q8_0.gguf` (768 dimensions) |

To change defaults before install, edit `src/shared/aiModelConfig.js` or set env vars:
`STRATOSORT_TEXT_MODEL`, `STRATOSORT_VISION_MODEL`, `STRATOSORT_EMBEDDING_MODEL`. See
`src/shared/modelRegistry.js` for the full catalog.

### Installing Additional Models from Settings

Users can add new models via **Settings → Local AI Engine**:

- **Download Base Models** — One-click download of the three default models (text, vision,
  embedding)
- **Model Management → Add Model** — Install any model from the registry by typing its exact
  filename (e.g. `Qwen2.5-7B-Instruct-Q4_K_M.gguf`, `all-MiniLM-L6-v2-Q4_K_M.gguf`)
- **Default AI Models** — Select which installed model to use for text, vision, and embeddings

All installable models must be in `modelRegistry.js`; the catalog lists download URLs and metadata.

### Fastest Models with Best Performance

Based on node-llama-cpp docs and llama.cpp ecosystem:

| Category      | Fastest options                                                       | Best quality-speed balance                                  |
| :------------ | :-------------------------------------------------------------------- | :---------------------------------------------------------- |
| **Text**      | `Llama-3.2-3B-Instruct-Q4_K_M` (default), `Phi-3-mini-4k-instruct-q4` | `Qwen2.5-7B-Instruct-Q4_K_M` (Better Quality, 128K context) |
| **Vision**    | `llava-v1.6-mistral-7b-Q4_K_M` (default; benefits from a GPU)         | `llava-v1.6-mistral-7b-Q4_K_M`                              |
| **Embedding** | `all-MiniLM-L6-v2-Q4_K_M.gguf` (default, ~21MB, 384 dim)              | `nomic-embed-text-v1.5-Q8_0.gguf` (Better Quality, 768 dim) |

**Quantization:** Per node-llama-cpp, `Q4_K_M` offers the best balance between compression and
quality; `Q5_K_M` is a close second. `Q8_0` is higher quality but slower; smaller models (3B, Phi-3)
are faster than 7B on limited hardware.

**Embedding dimensions:** Changing embedding models changes vector dimensions (e.g. 384 for
All-MiniLM vs 768 for Nomic). The index must be rebuilt when switching; the UI prompts for this.

## Environment Variables

### OCR (Tesseract)

| Variable                       | Default  | Description                                                                                                                       |
| :----------------------------- | :------- | :-------------------------------------------------------------------------------------------------------------------------------- |
| `TESSERACT_PATH`               | -        | Override path to the Tesseract binary (skips auto-install logic)                                                                  |
| `TESSDATA_PREFIX`              | Auto-set | Path to tessdata directory; auto-set for embedded runtime                                                                         |
| `STRATOSORT_LOCAL_OCR_WORKERS` | auto     | Override Tesseract.js worker pool size for local OCR fallback. Accepts a positive integer; non-numeric values use the auto value. |
| `AI_OCR_TIMEOUT`               | `60000`  | Timeout (ms) for AI-powered OCR operations.                                                                                       |

### Performance Tuning

| Variable                                    | Default | Description                                                                                                                                                                      |
| :------------------------------------------ | :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MAX_IMAGE_CACHE`                           | `300`   | Maximum cached image analyses (50-1000)                                                                                                                                          |
| `AUTO_ORGANIZE_BATCH_SIZE`                  | `10`    | Files processed per auto-organize batch (1-100)                                                                                                                                  |
| `STRATOSORT_INFERENCE_CONCURRENCY`          | auto    | Override the inference slot count used by `ModelAccessCoordinator`. Accepts a positive integer; non-numeric / non-positive values fall back to the platform-aware auto value.    |
| `STRATOSORT_ORAMA_COMPRESS`                 | `true`  | When `false`, disables gzip compression of persisted Orama indexes (faster writes, larger on-disk footprint). Used for debugging corruption suspected to be compression-related. |
| `STRATOSORT_ORAMA_BATCH_UPSERT_CONCURRENCY` | auto    | Override concurrent batch-upsert workers in `OramaVectorService`. Non-numeric values fall back to the service default.                                                           |

### Embeddings and embedding queue (environment)

These flags tune where embeddings run and whether the pipeline **blocks** when the in-process
embedding queue is saturated. Defaults favor throughput; enable waits only when debugging queue
overload.

| Variable                                     | Default | Description                                                                                                                                                                                                                                                                               |
| :------------------------------------------- | :------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRATOSORT_ENABLE_EMBEDDING_WORKER`         | off     | When `true`, runs embeddings in a separate `embeddingWorker` thread (extra VRAM / `maxThreads: 1`). Omit or `false` for main-process embeds.                                                                                                                                              |
| `STRATOSORT_ANALYSIS_EMBEDDING_QUEUE_WAIT`   | off     | When `true`, analysis paths call `waitForAnalysisQueueCapacity` before enqueueing embeddings.                                                                                                                                                                                             |
| `STRATOSORT_ORGANIZE_EMBEDDING_QUEUE_WAIT`   | off     | When `true`, organize / embedding sync waits on `waitForOrganizeQueueCapacity` before enqueueing.                                                                                                                                                                                         |
| `STRATOSORT_PRUNE_PHANTOM_FOLDER_EMBEDDINGS` | on      | When `true`/unset, `FolderMatchingService.batchUpsertFolders` calls `pruneStaleFolders` to delete vector-DB folder embeddings not in the current smart-folder set (e.g. "Images"/"Documents" left over from a removed default taxonomy). Set to `false` or `0` to disable the prune step. |
| `STRATOSORT_ATLAS_FIT_TIMEOUT_MS`            | 180000  | Max time (ms) the `AtlasProjectionService` UMAP worker may spend on a full projection fit before the worker is recycled and the fit fails over to the in-process fallback. Raise for very large corpora on slow hardware.                                                                 |

#### Embedding worker (Piscina) vs main process

By default `STRATOSORT_ENABLE_EMBEDDING_WORKER` is unset and treated as off: embeddings run through
`LlamaService` in the main process, so `ParallelEmbeddingService` can use the recommended
concurrency and VRAM is accounted for by the model memory manager.

Setting `STRATOSORT_ENABLE_EMBEDDING_WORKER=true` starts a separate `embeddingWorker` thread that
loads its own `node-llama-cpp` stack. That pool runs with `maxThreads: 1`, which caps parallel
embedding throughput, and it can hold a second copy of the embedding model in VRAM that the
main-process memory manager does not see. Enable it only for isolation experiments or debugging.

The two queue waits are off by default for the same throughput reason.
`STRATOSORT_ANALYSIS_EMBEDDING_QUEUE_WAIT=true` restores the per-file `waitForAnalysisQueueCapacity`
call in the folder and image enqueue paths (the batch orchestrator still applies the primary
backpressure). `STRATOSORT_ORGANIZE_EMBEDDING_QUEUE_WAIT=true` restores the
`waitForOrganizeQueueCapacity` wait before organize-queue enqueue.

### Processing Limits (Settings > Performance)

These settings are configurable via **Settings > Performance > Processing limits**:

| Setting                 | Default | Description                                                                                                                                                                                                                                                                  |
| :---------------------- | :------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoConcurrency`       | `true`  | Hardware-aware concurrency. When on, the effective analysis concurrency is chosen automatically from detected GPU VRAM, CPU threads, and RAM, and `maxConcurrentAnalysis` is ignored. Turn off to pin a manual value. Existing installs adopt this automatically on upgrade. |
| `maxConcurrentAnalysis` | 1       | Manual concurrency override (1–8 effective). Only applied when `autoConcurrency` is off. Higher values need more VRAM/RAM and can slow analysis or crash on limited hardware.                                                                                                |
| `maxImageFileSize`      | 100 MB  | Maximum size for image analysis.                                                                                                                                                                                                                                             |
| `maxDocumentFileSize`   | 200 MB  | Maximum size for document extraction.                                                                                                                                                                                                                                        |
| `maxTextFileSize`       | 50 MB   | Text files over this limit are analyzed from their first 50 MB.                                                                                                                                                                                                              |
| `captionVideoKeyframes` | `false` | Describe extracted video keyframes with the vision model during media analysis (slow on CPU).                                                                                                                                                                                |

### Startup & Health Checks

| Variable                     | Default | Description                                                                                                                                                                                                                                                                                                                                          |
| :--------------------------- | :------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SERVICE_CHECK_TIMEOUT`      | (unset) | Validated at preflight (must be 100–60000ms when set) but not yet applied to the hardcoded health-check timeouts. Reserved for future wiring.                                                                                                                                                                                                        |
| `STRATOSORT_STRICT_FILE_OPS` | off     | When `true`, the file-operation IPC handlers (single move, copy and delete, and batch organize) accept only sources and destinations under the app data directory or a watched Smart Folder root. Symlink, traversal and system-directory checks apply whether or not this is set. Use to harden non-default install profiles or run security tests. |

### GPU Configuration

| Variable                                   | Default | Description                                                                                                                                   |
| :----------------------------------------- | :------ | :-------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRATOSORT_FORCE_SOFTWARE_GPU`            | `0`     | Set to `1` to force software rendering                                                                                                        |
| `ELECTRON_FORCE_SOFTWARE`                  | `0`     | Alternative software rendering flag                                                                                                           |
| `ANGLE_BACKEND`                            | `d3d11` | ANGLE backend for GPU rendering (Windows)                                                                                                     |
| `STRATOSORT_GL_IMPLEMENTATION`             | -       | Override OpenGL implementation                                                                                                                |
| `STRATOSORT_IGNORE_GPU_BLOCKLIST`          | `0`     | Ignore Electron GPU blocklist (advanced)                                                                                                      |
| `STRATOSORT_DISABLE_BACKGROUND_THROTTLING` | `0`     | Set `1` to disable Chromium background-page throttling so analysis keeps running at full speed when the window is hidden. Increases idle CPU. |

### Feature Flags

| Variable                   | Default  | Description                                                                                                         |
| :------------------------- | :------- | :------------------------------------------------------------------------------------------------------------------ |
| `STRATOSORT_DEBUG`         | `0`      | Enable debug mode with verbose logging                                                                              |
| `STRATOSORT_REDACT_PATHS`  | `0`      | Redact file/folder paths in the UI (demo-safe)                                                                      |
| `STRATOSORT_TOUR_HEADED`   | `0`      | Show the Electron window while `npm run tour:record` captures the product tour (`scripts/record-product-tour.js`)   |
| `STRATOSORT_GRAPH_ENABLED` | `1` / on | Master toggle for Knowledge Graph / advanced graph UI (`src/shared/featureFlags.js`; set `0` or `false` to disable) |

Other `STRATOSORT_GRAPH_*` names may appear in older docs; they are **not** read by the codebase.
Graph behavior besides this master toggle is controlled in-app (experience mode and settings).

### Environment variable inventory (maintainers)

Run `npm run docs:env-audit` to list `STRATOSORT_*` names referenced in `src/` (static scan). Use it
when updating this document or `.env.example`; it does not prove a variable is user-facing.

### Application auto-updates (electron-updater)

Automatic in-app updates are **off by default** until you host a public update feed (or enable
updates for internal testing). This avoids failed checks against a private GitHub repo. See
[UPDATE_HOST.md](UPDATE_HOST.md) for the full Phase B checklist.

| Variable                               | Default | Description                                                                                                                                                                                                                                                                                                                      |
| :------------------------------------- | :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRATOSORT_ENABLE_AUTO_UPDATES`       | off     | Set to `true` to enable startup and manual update checks in **packaged** production builds.                                                                                                                                                                                                                                      |
| `STRATOSORT_UPDATE_FEED_URL`           | -       | Optional HTTPS **base URL** of a **generic** feed (directory containing `latest.yml` and referenced `.exe` / `.blockmap` files). Overrides the packaged GitHub provider when set.                                                                                                                                                |
| `STRATOSORT_UPDATE_FEED_ALLOWED_HOSTS` | -       | Comma-separated hostname allowlist for `STRATOSORT_UPDATE_FEED_URL`. **Required in packaged builds** when a custom feed is configured — prevents arbitrary update endpoints from being injected at runtime. Example: `updates.example.com,backup-updates.example.com`.                                                           |
| `STRATOSORT_BUILD_SHA`                 | -       | Optional commit SHA injected at build time. When set, the value is surfaced in the in-app About dialog and prefilled into bug reports so support can correlate a user's running build with a specific commit. Typically wired in CI (e.g. `cross-env STRATOSORT_BUILD_SHA=$GITHUB_SHA`).                                         |
| `STRATOSORT_LICENSE_SIGNING_KEY`       | -       | **Vendor-side only — never set on user machines or in CI.** Path to the Ed25519 **private** key PEM used by `scripts/license/sign-license.js` to mint offline-verifiable license keys at purchase-fulfillment time. The app itself only embeds the public half (`src/shared/licensePublicKey.js`) and never reads this variable. |

### Logging

| Variable                  | Default | Description                                                                                                                                                                                                                                                               |
| :------------------------ | :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STRATOSORT_CONSOLE_LOGS` | `0`     | Enable console logging in production (`1` to enable)                                                                                                                                                                                                                      |
| `STRATOSORT_MAX_LOG_MB`   | `100`   | Size threshold (megabytes) at which the active session log rolls over to `stratosort-<timestamp>-N.log`. The rotation poll runs every 15s. ENOSPC / EDQUOT / EROFS / EACCES / EPERM on the file stream raises a user-visible degraded flag and stops further file writes. |

### File watching

| Variable                   | Default | Description                                                                                                                                                                                                                                                                                                     |
| :------------------------- | :------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRATOSORT_WATCHER_DEPTH` | `10`    | Maximum subdirectory recursion depth used by `SmartFolderWatcher` for both chokidar live-watch and the manual `_scanDirectory` rescan path. Accepted range `0-32`; out-of-range or non-numeric values fall back to the default. Raise only for unusually deep trees — higher values multiply watch-handle cost. |

### Development

| Variable                             | Default           | Description                                                                                                                                                                                                                                                                                                                                                   |
| :----------------------------------- | :---------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `NODE_ENV`                           | `production`      | Set to `development` for dev mode features                                                                                                                                                                                                                                                                                                                    |
| `FORCE_DEV_TOOLS`                    | unset             | Set to enable Chromium DevTools even when not in the usual unpackaged-dev path. Dev-only.                                                                                                                                                                                                                                                                     |
| `USE_DEV_SERVER`                     | unset             | Set to load the renderer from the webpack-dev-server instead of `dist/index.html`. Dev-only.                                                                                                                                                                                                                                                                  |
| `DEV_SERVER_PORT`                    | (webpack default) | Override the webpack-dev-server port when `USE_DEV_SERVER` is set.                                                                                                                                                                                                                                                                                            |
| `LLAMA_ARG_LOG_VERBOSITY`            | `2`               | Passed through to the vision `llama-server` child via `buildLlamaChildEnv`. Higher values increase llama.cpp log noise.                                                                                                                                                                                                                                       |
| `REACT_DEVTOOLS`                     | `false`           | Set to `true` to enable React DevTools in dev                                                                                                                                                                                                                                                                                                                 |
| `STRATOSORT_SCAN_STRUCTURE_DELAY_MS` | -                 | Dev-only delay for folder scan IPC (ms)                                                                                                                                                                                                                                                                                                                       |
| `STRATOSORT_E2E_USER_DATA`           | -                 | Override Electron `userData` directory for Playwright E2E isolation. Set only during automated tests.                                                                                                                                                                                                                                                         |
| `STRATOSORT_E2E`                     | -                 | Set to `1` by the Playwright E2E harness to mark end-to-end test mode. Enables the DevTools _capability_ on app windows (unpackaged builds only; does not auto-open them) so the window-state DevTools spec can exercise open/close. Not for production use.                                                                                                  |
| `STRATOSORT_DISABLE_PISCINA`         | `false`           | Set `true` to disable the Piscina worker pools (fall back to inline execution). For debugging hangs / native crashes in workers; significant throughput regression.                                                                                                                                                                                           |
| `STRATOSORT_FORCE_LAUNCH`            | `0`               | Set `1` to bypass the single-instance lock check. **Intended for debugging only** — concurrent instances can corrupt the Orama / SQLite databases. It cannot bypass the user-data lock file (`.stratosort.userdata.lock`); a lock left by an unclean exit is reclaimed five minutes after its last heartbeat.                                                 |
| `STRATOSORT_USERDATA`                | -                 | Override path used by `scripts/monitor-batch-progress.js` to locate `analysis-history.json`. Useful when inspecting a packaged build's userData from the host shell.                                                                                                                                                                                          |
| `STRATOSORT_ALLOW_DEV_CLEAN`         | `0`               | Set `1` to let `npm run dev`'s clean step delete `dist/` and `.webpack-cache` even while another StratoSort instance is running. Escape hatch for wedged userData locks — ordinarily the running app holds the lock and the dev script aborts to prevent ripping `dist/preload.js` out from under the live renderer. See `scripts/check-running-instance.js`. |

### Runtime Configuration

| Variable                 | Default | Description                                                                     |
| :----------------------- | :------ | :------------------------------------------------------------------------------ |
| `STRATOSORT_RUNTIME_DIR` | -       | Override bundled runtime root (deprecated; only used for embedded OCR binaries) |

The AI stack runs fully in-process. No external runtime staging is required.

## Performance Constants

All timing and tuning constants are centralized in `src/shared/performanceConstants.js`. These are
organized into categories:

### TIMEOUTS (milliseconds)

| Constant             | Value     | Description                                  |
| :------------------- | :-------- | :------------------------------------------- |
| `DEBOUNCE_INPUT`     | 300       | Input debounce delay                         |
| `AI_ANALYSIS_SHORT`  | 30,000    | Short AI analysis timeout                    |
| `AI_ANALYSIS_MEDIUM` | 60,000    | Medium AI analysis timeout                   |
| `AI_ANALYSIS_LONG`   | 300,000   | Long AI analysis timeout (5 min; CPU vision) |
| `AI_ANALYSIS_BATCH`  | 1,800,000 | Batch analysis timeout (30 min)              |
| `ANALYSIS_LOCK`      | 300,000   | Max lock duration before force release       |
| `GLOBAL_ANALYSIS`    | 600,000   | Max total analysis time (10 min)             |

### RETRY Configuration

| Constant              | Value      | Description                    |
| :-------------------- | :--------- | :----------------------------- |
| `MAX_ATTEMPTS_LOW`    | 2          | Low-priority retry attempts    |
| `MAX_ATTEMPTS_MEDIUM` | 3          | Medium-priority retry attempts |
| `MAX_ATTEMPTS_HIGH`   | 5          | High-priority retry attempts   |
| `FILE_OPERATION`      | 3 attempts | File operation retry config    |
| `AI_ANALYSIS`         | 2 attempts | AI analysis retry config       |

### CACHE Limits

| Constant              | Value | Description               |
| :-------------------- | :---- | :------------------------ |
| `MAX_FILE_CACHE`      | 500   | Maximum cached files      |
| `MAX_IMAGE_CACHE`     | 300   | Maximum cached images     |
| `MAX_EMBEDDING_CACHE` | 1000  | Maximum cached embeddings |
| `MAX_ANALYSIS_CACHE`  | 200   | Maximum cached analyses   |

### BATCH Processing

| Constant                  | Value | Description                      |
| :------------------------ | :---- | :------------------------------- |
| `MAX_CONCURRENT_FILES`    | 5     | Max files processed concurrently |
| `MAX_CONCURRENT_ANALYSIS` | 3     | Max concurrent AI analyses       |
| `EMBEDDING_BATCH_SIZE`    | 50    | Embeddings per batch             |
| `EMBEDDING_PARALLEL_SIZE` | 10    | Parallel embedding operations    |

### THRESHOLDS

| Constant                           | Value | Description                   |
| :--------------------------------- | :---- | :---------------------------- |
| `CONFIDENCE_LOW`                   | 0.3   | Low confidence threshold      |
| `CONFIDENCE_MEDIUM`                | 0.6   | Medium confidence threshold   |
| `CONFIDENCE_HIGH`                  | 0.8   | High confidence threshold     |
| `DEFAULT_CONFIDENCE_PERCENT`       | 70    | Default document confidence   |
| `DEFAULT_IMAGE_CONFIDENCE_PERCENT` | 75    | Default image confidence      |
| `FOLDER_MATCH_CONFIDENCE`          | 0.55  | Min score for folder matching |

### FILE_SIZE_LIMITS (`src/shared/constants.js`)

| Constant                 | Value  | Description                    |
| :----------------------- | :----- | :----------------------------- |
| `MAX_TEXT_FILE_SIZE`     | 50 MB  | Maximum text/code file size    |
| `MAX_IMAGE_FILE_SIZE`    | 100 MB | Maximum image file size        |
| `MAX_DOCUMENT_FILE_SIZE` | 200 MB | Maximum document file size     |
| `MAX_AUDIO_FILE_SIZE`    | 1 GB   | Maximum audio file (selection) |
| `MAX_VIDEO_FILE_SIZE`    | 2 GB   | Maximum video file (selection) |

### CONCURRENCY

| Constant          | Value | Description                       |
| :---------------- | :---- | :-------------------------------- |
| `MIN_WORKERS`     | 1     | Minimum analysis workers          |
| `DEFAULT_WORKERS` | 1     | Default analysis workers          |
| `MAX_WORKERS`     | 8     | Maximum analysis workers          |
| `FOLDER_SCAN`     | 50    | Concurrent folder scan operations |

## Configuration Files

### User Settings

User settings are persisted in the application's data directory:

- **Windows**: `%APPDATA%\StratoSort Core\settings.json`
- **macOS**: `~/Library/Application Support/StratoSort Core/settings.json`
- **Linux**: `~/.config/StratoSort Core/settings.json`

The file holds only the settings the user has changed, plus `settingsSchemaVersion`,
`experienceMode` and `autoConcurrency`, whose presence carries meaning on load. Anything equal to a
current default, or to a default an earlier build shipped (`SUPERSEDED_DEFAULTS` in
`src/shared/defaultSettings.js`), is dropped on save and ignored on load, so a default that changes
in a later release reaches every install that never touched that setting. A hand-edited value that
happens to equal the current default is treated as "not set" and will follow future defaults.

### Configuration Schema

Configuration validation is defined in `src/shared/config/configSchema.js`. The schema ensures type
safety and provides default values for all settings.

## Modifying Configuration

### Via Environment Variables

Set environment variables before launching the application:

```bash
# Linux/macOS
export MAX_IMAGE_CACHE=500
./stratosort

# Windows (PowerShell)
$env:MAX_IMAGE_CACHE = "500"
.\stratosort.exe
```

### Via Settings UI

Most user-facing settings can be configured through the Settings phase in the application UI.

## Troubleshooting

### GPU Issues

If experiencing rendering problems:

```bash
export STRATOSORT_FORCE_SOFTWARE_GPU=1
```

### Model Download Issues

If AI analysis fails due to missing models:

```bash
npm run setup:models
npm run setup:models:check
```

### Vector DB Issues

The Orama index is stored locally and rebuilt on demand. If results look stale, re-run analysis or
trigger a rebuild from the app UI.

## Advanced / Internal Environment Variables

These variables tune internal behavior and are intentionally undocumented in the main settings UI.
They are listed here for support engineers and contributors who need to debug edge cases.

### llama.cpp binary management (security-sensitive)

| Variable                             | Default         | Purpose                                                                                                                                                               |
| :----------------------------------- | :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRATOSORT_LLAMA_CPP_TAG`           | `b9000`         | Pinned llama.cpp release tag downloaded on first run                                                                                                                  |
| `STRATOSORT_LLAMA_CPP_URL`           | (auto)          | **Override the binary download URL.** Pair with `STRATOSORT_LLAMA_CPP_SHA256` to keep integrity checking — overriding without a matching SHA256 disables verification |
| `STRATOSORT_LLAMA_CPP_SHA256`        | (auto)          | Expected SHA-256 of the downloaded binary; mismatches abort with a clear error                                                                                        |
| `STRATOSORT_LLAMA_CPP_ALLOWED_HOSTS` | github releases | Comma-separated allowlist of hosts that may serve the binary download                                                                                                 |
| `STRATOSORT_CUDA_VERSION`            | (auto)          | Force a specific CUDA release variant for GPU builds                                                                                                                  |
| `STRATOSORT_LLM_GPU_BACKEND`         | (auto-detected) | `cuda`, `metal`, `vulkan`, or `cpu` — overrides backend autoselection                                                                                                 |
| `STRATOSORT_LLAMA_SERVER_PATH`       | (bundled)       | Absolute path to the llama-server binary; bypasses the bundled download                                                                                               |

### Storage and persistence

| Variable                             | Default           | Purpose                                                                                                                                                                         |
| :----------------------------------- | :---------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STRATOSORT_PERSISTENCE_BACKEND`     | `sqlite`          | Global backend default for on-disk stores (analysis history, embedding queue). `sqlite` uses better-sqlite3; any other value (e.g. `json`) selects the legacy JSON-file backend |
| `STRATOSORT_EMBEDDINGQUEUE_BACKEND`  | (inherits global) | Per-store override for the embedding queue; `sqlite` vs any other value (JSON-file backend). Takes precedence over `STRATOSORT_PERSISTENCE_BACKEND`                             |
| `STRATOSORT_ANALYSISHISTORY_BACKEND` | (inherits global) | Per-store override for analysis history; `sqlite` vs any other value (JSON-file backend). Takes precedence over `STRATOSORT_PERSISTENCE_BACKEND`                                |
| `STRATOSORT_SQLITE_COMPRESS`         | `0`               | Compress SQLite payloads on write (read transparently)                                                                                                                          |
| `STRATOSORT_USE_OFFICIAL_PDFJS`      | `0`               | Use the official pdf.js distribution instead of the bundled extractor                                                                                                           |

### Worker pool tuning

| Variable                                    | Default | Purpose                                   |
| :------------------------------------------ | :------ | :---------------------------------------- |
| `STRATOSORT_IMAGE_WORKER_THREADS`           | (auto)  | Override image-worker pool size           |
| `STRATOSORT_OCR_WORKER_THREADS`             | (auto)  | Override OCR worker pool size             |
| `STRATOSORT_TEXT_EXTRACTION_WORKER_THREADS` | (auto)  | Override text-extraction worker pool size |

### LLM behavior tuning

| Variable                                 | Default           | Purpose                                                   |
| :--------------------------------------- | :---------------- | :-------------------------------------------------------- |
| `STRATOSORT_VISION_BATCH_SIZE`           | (model-dependent) | Vision inference batch size                               |
| `STRATOSORT_VISION_UBATCH_SIZE`          | (model-dependent) | Vision inference micro-batch size                         |
| `STRATOSORT_VISION_KEEPALIVE_MS`         | `60000`           | llama.cpp server idle keepalive (`VISION_IDLE_KEEPALIVE`) |
| `STRATOSORT_IMAGE_PREFLIGHT_TTL_MS`      | `15000`           | Image preflight cache TTL                                 |
| `STRATOSORT_JSON_REPAIR_TIMEOUT_MS`      | `15000`           | LLM JSON repair timeout                                   |
| `STRATOSORT_PROSE_EXTRACTION_TIMEOUT_MS` | `15000`           | Prose extraction timeout                                  |

### Vision runtime packaging

`scripts/setup-vision-runtime.js` stages the platform-specific vision binary during
`npm run package` / `npm run dist*`. These overrides only matter when cross-packaging from a
different host architecture.

| Variable                             | Default        | Purpose                                                |
| :----------------------------------- | :------------- | :----------------------------------------------------- |
| `STRATOSORT_VISION_RUNTIME_PLATFORM` | host OS        | Override target platform (`win32`, `darwin`, `linux`). |
| `STRATOSORT_VISION_RUNTIME_ARCH`     | `process.arch` | Override target arch (`x64`, `arm64`).                 |

### Media transcoding (FFmpeg)

`MediaTranscoder` invokes a bundled LGPL-3 FFmpeg binary via subprocess for audio/video
preprocessing (Whisper PCM, video keyframes). The binary is staged by
`scripts/setup-ffmpeg-runtime.js` during `npm run dist*`, into `assets/runtime/ffmpeg/`. Current
platform matrix (see the script header for details): **Windows** (BtbN `win64-lgpl`), **macOS** x64

- arm64 (StratoSort self-hosted `ffmpeg-mac-{x64,arm64}.zip` from `build-ffmpeg-lgpl.yml`), and
  **Linux** x64 + arm64 (BtbN `master-latest-{linux64,linuxarm64}-lgpl.tar.xz`). Windows arm64 ships
  without a bundled FFmpeg (no upstream LGPL build) and relies on the PATH fallback.

| Variable                             | Default        | Purpose                                                                                                                                                                                                                                                                                                                                                          |
| :----------------------------------- | :------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRATOSORT_FFMPEG_PATH`             | (bundled)      | Absolute path to a system-managed `ffmpeg` binary. Overrides the bundled lookup. Useful for tests and operators who maintain their own ffmpeg. Must exist on disk.                                                                                                                                                                                               |
| `STRATOSORT_FFMPEG_TAG`              | (per-platform) | Release tag pulled by `setup:ffmpeg-runtime`. Windows/Linux pull a BtbN/FFmpeg-Builds tag; macOS resolves the StratoSort self-hosted tag (`ffmpeg-lgpl-latest`). Pin for reproducibility.                                                                                                                                                                        |
| `STRATOSORT_FFMPEG_URL`              | (auto)         | Override the download URL entirely. Hostname is allowlist-validated; arbitrary URLs are rejected.                                                                                                                                                                                                                                                                |
| `STRATOSORT_FFMPEG_RUNTIME_PLATFORM` | host OS        | Override target platform (`win32`, `darwin`, `linux`) when packaging cross-platform.                                                                                                                                                                                                                                                                             |
| `STRATOSORT_FFMPEG_RUNTIME_ARCH`     | `process.arch` | Override target arch (`x64`, `arm64`).                                                                                                                                                                                                                                                                                                                           |
| `SKIP_FFMPEG_RUNTIME`                | `false`        | Skip the download step in CI / fast-dev workflows. The runtime resolver falls back to PATH, so any system-installed `ffmpeg` is used at runtime.                                                                                                                                                                                                                 |
| `STRATOSORT_USE_REAL_WHISPER`        | `false`        | Read by `scripts/run-real-media.js` only. When set to `1`, the standalone harness swaps its stub Whisper for the production `WhisperService` so it loads the real GGML model and produces actual transcripts. Off by default so the harness keeps loading in environments without the native binding. Has no effect on the running app, just on the dev harness. |

### OCR language data (Tesseract traineddata)

`tesseractJsPaths.js` resolves the OCR language model with a three-tier precedence: a bundled
`assets/runtime/tessdata/<lang>.traineddata[.gz]` (staged by `scripts/setup-tessdata-runtime.js`
during `npm run dist*`, same `runtime/**` extraResources glob as FFmpeg) → a previously downloaded
copy under `userData/tessdata-cache` → tesseract.js's own CDN default (`cdn.jsdelivr.net`), which is
warned once per process. Bundling keeps OCR fully offline; without it, the first OCR fetches the
model from jsdelivr and caches it.

| Variable                      | Default | Purpose                                                                                                                                                   |
| :---------------------------- | :------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `STRATOSORT_TESSDATA_URL`     | (auto)  | Override the download URL entirely. Hostname is allowlist-validated (`cdn.jsdelivr.net`); non-HTTPS, credentialed, or off-allowlist hosts are rejected.   |
| `STRATOSORT_TESSDATA_VARIANT` | `4.0.0` | `@tesseract.js-data/<lang>/<variant>/` directory segment — the model quality variant tesseract.js itself would fetch. Pin for reproducibility.            |
| `STRATOSORT_TESSDATA_SHA256`  | (unset) | Pin the expected sha256 of the downloaded model. Verified when set (mismatch aborts); a loud warning is emitted when absent.                              |
| `SKIP_TESSDATA_RUNTIME`       | `false` | Skip the download step in CI / fast-dev workflows. The runtime resolver falls back to the userData cache, then the tesseract.js CDN default on first OCR. |

### Whisper variant resolution (audio/video transcription)

`WhisperService` loads `@fugood/whisper.node` via a per-platform/per-GPU variant package. The loader
walks an ordered candidate list (best-first) and uses the first one whose `require()` succeeds:

| GPU detected           | Platform     | Candidate order                            |
| :--------------------- | :----------- | :----------------------------------------- |
| NVIDIA (`cuda`)        | win32, linux | `cuda` → `vulkan` → `default` (CPU)        |
| AMD / Intel (`vulkan`) | win32, linux | `vulkan` → `default`                       |
| Any                    | darwin       | `default` (Metal acceleration is built in) |
| None / unknown         | any          | `default` (CPU)                            |

The CUDA variant requires the CUDA runtime DLLs (`cudart64_*.dll` etc.) on `PATH`. Many users have
the toolkit installed but not configured for Node's process environment — the `cuda` candidate
`require()`s fine on disk but fails to dlopen with `ERR_DLOPEN_FAILED`. In that case the loader
falls through to `vulkan`, which always works for NVIDIA users because the Vulkan loader ships with
the GPU driver. **No user-visible failure**: GPU acceleration still engages; the variant label just
flips from `cuda` to `vulkan`.

The resolved variant is surfaced two ways:

- **Settings → About → "Media (Whisper)"** shows e.g. `vulkan on cuda · ggml-base.en.bin`. The two
  fields are independent: `cuda` is the detector's vendor label, `vulkan` is the variant that
  actually loaded. A mismatch like that is the headline sign that CUDA runtime DLLs aren't on PATH.
- The `system:get-runtime-info` IPC response includes a `mediaStack.whisper.resolvedVariant` field
  consumed by the bug-report URL builder, so support tickets surface this without an extra round
  trip.

The variant chain logic is in `WhisperService.loadNativeWhisperModule` (the binding's own loader
uses ESM `import()`, which throws `ERR_UNKNOWN_FILE_EXTENSION` on `.node` files in our sandboxed
Electron environment — that's the reason for the custom loader). Test coverage in
`test/WhisperService.loader.test.js` exercises the full fallback chain with virtual mocks so CI
catches a regression even on runners that don't have GPU variant packages installed.

### Stability test harness (`scripts/stability/`)

Knobs for the worktree-based stability/comparison harness used during release prep. Internal to the
stability workflow; safe to ignore in normal development.

| Variable                                     | Default | Purpose                                                                                                        |
| :------------------------------------------- | :------ | :------------------------------------------------------------------------------------------------------------- |
| `STRATOSORT_STABILITY_SKIP_WORKTREE_INSTALL` | `0`     | Set `1` to skip `npm install` in the comparison worktree (you already linked or copied node_modules manually). |
| `STRATOSORT_STABILITY_FULL_WORKTREE_INSTALL` | `0`     | Set `1` to run `npm ci` in the comparison worktree instead of the lighter default install path.                |

### MCP server

The MCP server lets external [Model Context Protocol](https://modelcontextprotocol.io/) clients
(Claude Desktop, Cursor, Zed, etc.) search and chat with the documents StratoSort has analyzed. It
is **off by default** and must be explicitly enabled in Settings → MCP Server. See
[MCP_SERVER.md](MCP_SERVER.md) for the full user-facing guide and tool reference.

| Variable              | Default | Purpose                                                                                                                                                                         |
| :-------------------- | :------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STRATOSORT_MCP_PORT` | `53827` | Initial bind port. If taken, binds an OS-assigned ephemeral port (`listen(0)`) and reports the actual port. Loopback (`127.0.0.1`) only — non-loopback binds are not supported. |

The bearer token is generated locally on first enable and stored under `userData/mcp-token`,
encrypted via `safeStorage` when the OS keystore is available (DPAPI on Windows, Keychain on macOS,
libsecret on Linux). There is no env var to override it; rotate from Settings if it leaks.

### AI providers (multi-provider routing)

StratoSort can optionally route document analysis, chat, and organization suggestions to a cloud
provider (Anthropic Claude, OpenAI, or any OpenAI-compatible endpoint including Ollama / LM Studio /
vLLM). It is **off by default** and configured entirely through Settings → AI Provider. See
[AI_PROVIDERS.md](AI_PROVIDERS.md) for the full guide.

There are no environment variables for AI provider configuration — API keys are stored encrypted via
`safeStorage` and the per-feature/per-folder routing config is persisted in `userData`. Embeddings
always run locally regardless of any cloud routing.
