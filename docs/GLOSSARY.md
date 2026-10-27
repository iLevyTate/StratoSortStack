# Glossary

Short definitions for terms that show up in the codebase, in PR descriptions, and in other docs.
Keep this list factual and short. If a term needs more than three sentences, link out instead.

## Architecture

**Main process** — The Node.js side of an Electron app. Has full OS access. In StratoSort it owns
all AI services, the vector DB, file I/O, and the IPC server. Entry point:
`src/main/simple-main.js`.

**Renderer process** — A sandboxed Chromium page hosted by Electron. Runs the React 19 SPA. No
`require()` at runtime; no network for AI. Talks to main via IPC.

**Preload script** — A small bundle that runs in the renderer's process before the page loads, with
privileged APIs. The security boundary between renderer and main. In StratoSort, also the place
where IPC is validated, sanitized, rate-limited, and size-capped. File: `src/preload/preload.js`.
Bundled separately by `webpack.main.config.js`.

**Sandbox** — Electron browser-window flag that disables Node integration in the renderer.
StratoSort runs with `sandbox: true`, which is why preload cannot `require()` at runtime — its
bundle has to be self-contained.

**CSP (Content Security Policy)** — Header that restricts what the renderer can execute.
StratoSort's CSP forbids dynamic code evaluation (no `unsafe-eval`) and inline scripts other than
the hash-pinned splash script (`script-src 'self'` + hashes). Built in
`src/main/core/securityHeaders.js` and applied by `src/main/core/createWindow.js`.

**Electron fuses** — Compile-time flags that harden the packaged Electron binary (e.g.
"only-load-app-from-asar"). Declared in `electron-builder.json` and verified by
`npm run verify:electron-fuses-config`.

## IPC

**IPC (Inter-Process Communication)** — How renderer and main talk. Implemented via
`ipcRenderer.invoke()` (request/response) and `webContents.send()` (push event). All channel names
live in `src/shared/constants.js`.

**IPC channel** — A string identifier for one kind of message (e.g. `analysis:analyze-document`).
The preload allowlist is generated from `IPC_CHANNELS` by `npm run generate:channels`.

**Zod fallback validator** — In production, every IPC handler must have a Zod schema. For test
environments where Zod isn't loaded, a fallback validator in `src/main/ipc/validationSchemas.js`
does basic type/shape checks. In production builds, Zod is required.

**Rate limiter** — Preload-side throttle (default 200 req/s per channel) to prevent renderer bugs
from DOSing main. Implemented in `SecureIPCManager`.

**Concurrency-limited channel** — A small set of expensive IPC operations (heavy embedding ops,
batch analysis, AI provider test) that are serialized via a mutex in
`CONCURRENCY_LIMITED_CHANNELS` + `_concurrencyLocks` in the preload.

**Event-only channel** — A push event from main to renderer that has no invoke handler
(`EVENT_ONLY_CHANNELS`). Excluded from `ALL_SEND_CHANNELS`.

## Storage and recovery

**Atomic file op** — Write-to-temp + rename. `src/shared/atomicFileOperations.js`. The rename is
atomic on POSIX and (with retries for AV/indexer locks) on Windows.

**Journal** — A small file written before an atomic op begins. If the process crashes mid-write,
`recoverFromJournals()` at startup uses the journal to roll back.

**OramaVectorService** — In-process Orama vector DB plus BM25 full-text index. Persists to a sidecar
file under userData. Implements degradation events (`dimension-mismatch`, `embedding-blocked`).

**Embedding queue** — The persistent, retrying queue in `src/main/analysis/embeddingQueue/` that
batches vector upserts after analysis (separate stages for files and folders). The embeddings
themselves are computed by `ParallelEmbeddingService` (semaphore-limited, main process by default).
Backpressure is configurable via `STRATOSORT_ANALYSIS_EMBEDDING_QUEUE_WAIT` and
`STRATOSORT_ORGANIZE_EMBEDDING_QUEUE_WAIT` (see [`CONFIG.md`](CONFIG.md)).

**EmbeddingCache** — In-memory LRU cache (with TTL) keyed on text + model so the same content isn't
re-embedded within a session.

**ReRanker** — LLM prompt that scores each search candidate 0-10 against the query after hybrid
retrieval (not a cross-encoder). Used by Chat's Deep mode; off by default elsewhere.

## AI runtime

**node-llama-cpp** — In-process JS binding to llama.cpp for local LLM inference. Owns the GGUF model
files and the inference loop.

**GGUF** — The model file format used by llama.cpp. Quantized (Q4_K_M, etc.) for size/speed
tradeoffs.

**Whisper** — Audio transcription model. Bundled via `@fugood/whisper.node`. See `WhisperService`
and `pcmToArrayBuffer` helper for the 1.0.18+ binding contract.

**Vision / LLaVA** — Image-understanding model used by `VisionService`. Subprocess via
`llama-server` runtime under `assets/runtime/`.

**Degradation** — Graceful response to load/OOM. `DegradationManager` decides when to skip
embeddings, fall back to BM25, or pause batch analysis. `DegradedStateTracker` is the flag/state
store.

**MCP (Model Context Protocol)** — An emerging protocol for letting AI tools talk to external
servers. StratoSort has an experimental MCP server feature; see [`MCP_SERVER.md`](MCP_SERVER.md).

## State and persistence

**Smart folder** — A user-defined folder with embedding-based auto-routing rules. The
`SmartFoldersLLMService` decides which smart folder a new file belongs in.

**ServiceContainer** — The DI registry.
`const { container, ServiceIds } = require('./ServiceContainer')`, then
`container.resolve(ServiceIds.LLAMA_SERVICE)` returns the lazy-initialized service. See
[`DI_PATTERNS.md`](DI_PATTERNS.md) for the full pattern.

**persistenceMiddleware** — Redux middleware that debounces (1s + 5s max wait) renderer state writes
to localStorage. Stamps state with a schema version for migration on rehydration.

**ipcMiddleware** — Redux middleware that subscribes to main→renderer IPC events, validates them
against `src/shared/ipcEventSchemas.js` (invalid payloads are dropped) and dispatches them into the
store.

## Process / release

**Local gate** — `npm run local:gate`. Pre-push verification: `verify:installed-electron`, then the
full `ci` pipeline (format, lint, typecheck, audits, compliance, test:coverage, the IPC/MCP/
AI-provider/fuses/env-docs `verify:*` checks, build), then native-modules check. Cloud CI
(`.github/workflows/ci.yml`) also runs `ci` plus native-module verification on every PR and on
pushes to the main branches.

**Pre-flight** — `npm run preflight:release[:quick]`. Runs before tagging a release: native module
check, the critical-path baseline comparison, commercial compliance, then (full mode only) dist
build and packaged-artifact verify. See [`RELEASING.md`](RELEASING.md) § Pre-Flight Checks.

**Critical-path smoke** — `test:critical-path:twice`. Runs the critical-path smoke suite twice — on
the previous release tag and on `HEAD`, each in a temporary git worktree
(`scripts/stability/compare-baseline.js`) — then checks for failures and ≥50% latency regressions
(`scripts/stability/check-release-thresholds.js`).

## License / compliance

**LGPL FFmpeg** — StratoSort bundles FFmpeg under LGPL-3.0. Subprocess-only invocation, so the
relink-ability obligation does not apply. Attribution lives in `assets/runtime/ffmpeg/NOTICE.md`.

**Commercial compliance gate** — `npm run compliance:commercial:verify`. Fails on `high_risk` or
`unknown` dependency/model licenses unless explicitly waived in
`docs/commercial-compliance-waivers.json`. See
[`COMMERCIAL_COMPLIANCE.md`](COMMERCIAL_COMPLIANCE.md).

**THIRD_PARTY_NOTICES.md** — The legal attribution file shipped in the installer (electron-builder
`extraResources`) and surfaced in the in-app Legal Notices view. Do not move or rename without
updating `electron-builder.json` and `src/main/ipc/system.js`.
