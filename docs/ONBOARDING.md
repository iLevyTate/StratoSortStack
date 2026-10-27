# Onboarding — Clone to First PR

Target reader: a mid/senior JS/Electron contributor sitting down with a clean clone for the first
time. Goal: be productive within one day. Estimated read time: **30 minutes**.

If you are looking for **product** docs (what the app does for end users), start with
[`USER_GUIDE.md`](USER_GUIDE.md). This document is for engineers.

---

## 1. The 30-second mental model

StratoSort Stack is an Electron 41 desktop app that organizes your local files using **in-process
AI**. Privacy is the product: by default, nothing leaves the machine.

- **No default external API.** The LLM (`node-llama-cpp`), the vector DB (`@orama/orama`), and OCR
  (`tesseract.js`) all run inside the Electron main process. Optional, opt-in BYOK cloud providers
  can handle document/media text analysis, chat and organization suggestions
  (`src/shared/aiProviderRouting.js`); embeddings, search and image pixels always stay local.
- **Three processes, one box.** Main (Node + AI services), preload (security boundary), renderer
  (React 19 SPA). They talk via Electron IPC.
- **Sandboxed renderer + strict CSP.** No `unsafe-eval`, no runtime `require()` in the renderer.
  Preload is webpack-bundled.
- **Every IPC handler is Zod-validated.** The preload sanitizes and rate-limits before main ever
  sees a message.
- **File operations are atomic and journaled.** Crash recovery rolls back partial writes on startup.

If those bullets feel unsurprising, you can probably skim the rest. If any felt new, slow down on
the matching section below — those are the project's load-bearing invariants.

---

## 2. The five files to read first

In this order:

1. **`src/main/simple-main.js`** — App lifecycle, service initialization order, window creation,
   crash reporter. Teaches you when each piece comes alive.

2. **`src/shared/constants.js`** — Single source of truth for every IPC channel. If you want to know
   what cross-process surface area exists at all, this file is the answer. The preload generates its
   allowlist from here (`npm run generate:channels`).

3. **`src/preload/preload.js`** — The security boundary. Validates, sanitizes, rate-limits,
   size-checks. Read this to understand why preload is webpack-bundled (sandbox forbids runtime
   `require`).

4. **`src/main/ipc/analysis.js`** — One concrete handler. Demonstrates the `createHandler()`
   wrapper, Zod schema, service resolution, error wrapping. Once you understand one IPC handler, you
   understand all 140+.

5. **`src/renderer/store/index.js`** — Redux setup, middleware (ipc + persistence), state migration.
   The renderer's whole state model lives one or two hops from here.

---

## 3. Trace one IPC call end-to-end

The example: a user clicks "Analyze" on a file in the Discover phase.

1. **Renderer call.** The Discover phase's `useAnalysis` hook
   (`src/renderer/phases/discover/useAnalysis.js`) normally sends files through
   `window.electronAPI.analysis.batch(...)`; this trace follows the simpler single-file path,
   `window.electronAPI.analysis.document(filePath)`, which goes through the same layers.

2. **Preload intercepts.** `src/preload/preload.js` wraps that as
   `ipcRenderer.invoke('analysis:analyze-document', filePath)`. Before the message leaves, the
   preload:
   - Checks channel is in the allowlist (generated from `IPC_CHANNELS`)
   - Validates the path is a string, not a traversal, not a `<scheme>://` URI, no NUL bytes
   - Rate-limits per channel (200 req/s default)
   - Caps payload size (5MB strings, 10k array items)

3. **Main handler.** `src/main/ipc/analysis.js` builds the handler with `createHandler()` from
   `src/main/ipc/ipcWrappers.js` and registers it with `safeHandle(ipcMain, channel, handler)`,
   which goes through the IPC registry (`src/main/core/ipcRegistry.js`) rather than calling
   `ipcMain.handle` directly. Along the way:
   - The registry validates the sender (`ipcSenderValidator` — defense in depth)
   - `createHandler()` applies the Zod schema (`src/main/ipc/validationSchemas.js`); invalid input
     returns `{ success: false, error: { code, message, details } }` without running the handler
   - Thrown errors are logged and re-thrown (the renderer's `invoke` rejects); handlers that want a
     structured failure return `createErrorResponse(...)` instead. See
     [`ERROR_HANDLING_GUIDE.md`](ERROR_HANDLING_GUIDE.md).

4. **Service call.** Handler resolves a service via the `ServiceContainer` singleton registry in
   `src/main/services/ServiceContainer.js` and invokes the work. For analyze-document, that means
   `LlamaService` for inference, `OramaVectorService` for embeddings, document extractors for text.

5. **Response back.** The result serializes through IPC (Date → ISO string). Preload re-checks
   size/depth. The hook dispatches analysis-slice actions (e.g. `setAnalysisResults`) to update
   Redux. The debounced `persistenceMiddleware` writes to localStorage 1 second later.

If anything in that chain feels mysterious, that file is your next read.

---

## 4. Service inventory (`src/main/services/`)

56 top-level service files (plus subdirectories such as `analysisHistory/`, `startup/`,
`vectorDb/`). Grouped by purpose:

**LLM / inference**

- `LlamaService.js` — node-llama-cpp wrapper, model lifecycle, streaming
- `ModelManager.js` / `ModelMemoryManager.js` — model download/swap, VRAM/RAM accounting
- `LlamaResilience.js` — degradation on OOM/load failure
- `GPUMonitor.js` — GPU utilization watch
- `VisionService.js`, `WhisperService.js`, `WhisperModelInstaller.js` — image + audio AI
- `ChatService.js`, `ChatHistoryStore.js` — streaming chat with RAG

**Embeddings / search**

- `OramaVectorService.js` — Orama vector DB (in-process)
- `ParallelEmbeddingService.js`, `EmbeddingCache.js` — semaphore-limited embedding (main process by
  default) with an in-memory LRU cache
- `ReRankerService.js` — optional LLM re-ranking of search candidates (off by default)
- `ClusteringService.js`, `RelationshipIndexService.js` — similarity graph
- `SearchService.js`, `QueryProcessor.js` — semantic + BM25 search

**Analysis / processing**

- `BatchAnalysisService.js`, `AnalysisCacheService.js` — concurrent multi-file analysis with cache
- `SmartFoldersLLMService.js`, `SmartFolderWatcher.js`, `FolderMatchingService.js` — auto-route to
  folders
- `MediaTranscoder.js` — ffmpeg subprocess wrapper

**File / OS**

- `FilePathCoordinator.js`, `FileAccessPolicy.js` — path safety and access enforcement
- `TrashService.js`, `UndoRedoService.js` — safe deletion + atomic op replay
- `DownloadWatcher.js` — monitor downloads folder

**System / health**

- `SettingsService.js`, `SettingsBackupService.js` — config persistence
- `DegradationManager.js`, `DegradedStateTracker.js` — graceful degradation under load
- `ProcessingStateService.js` — in-flight operation tracking for crash recovery
- `PerformanceService.js`, `PerformanceMetrics.js` — profiling hooks
- `ServiceContainer.js`, `ServiceIntegration.js` — DI registry (read `docs/DI_PATTERNS.md`)

When you need to add behavior, the rule of thumb is: **services hold logic, IPC handlers
orchestrate**. Don't put business logic in `src/main/ipc/*.js`.

---

## 5. Renderer architecture (`src/renderer/`)

- **Entry:** `index.js` → `App.js` → `components/PhaseRenderer.jsx` (the phase router: WELCOME →
  SETUP → DISCOVER → ORGANIZE → COMPLETE; search is a modal / Knowledge OS surface, not a phase).
- **State:** Redux Toolkit. Slices live in `store/slices/` (ui, files, analysis, system, mcpServer,
  aiProvider, license). Middleware: `ipcMiddleware` subscribes to main→renderer events, validates
  them against `src/shared/ipcEventSchemas.js` and dispatches them into the store;
  `persistenceMiddleware` debounces writes to localStorage (1s debounce, 5s max wait).
- **Components by feature:**
  `components/{discover,organize,search,settings,setup,triage,layout,ui}`. Tailwind 4 + Framer
  Motion + Lucide.
- **Hooks:** shared hooks in `hooks/` (e.g. `useKeyboardShortcuts`, `useSettingsSubscription`,
  `useGraphState`); phase logic in `phases/` (e.g. `phases/discover/useAnalysis.js`,
  `phases/organize/useOrganization.js`).
- **State migration:** `store/migrations.js` runs at hydration. Schema version is stamped by
  `persistenceMiddleware`. When you change slice shape, bump `CURRENT_STATE_VERSION` and add a
  migrator.

---

## 6. Testing topology (`test/`)

| Location                               | Runner                 | When                                            | Command                    |
| -------------------------------------- | ---------------------- | ----------------------------------------------- | -------------------------- |
| `test/unit/` and root `test/*.test.js` | Jest 30 (jsdom)        | every PR                                        | `npm test`                 |
| `test/integration/`                    | Jest, `--runInBand`    | every PR                                        | `npm run test:integration` |
| `test/e2e/`                            | Playwright             | smoke subset in CI; full suite manual + release | `npm run test:e2e`         |
| `test/stress/`                         | Jest (separate config) | release                                         | `npm run test:stress`      |

Coverage thresholds (global, ratcheted in `test/jest.config.js`): branches 52 / functions 62 / lines
63 / statements 62, with tighter per-directory floors. Run a single test:

```bash
npm test -- test/unit/pathHandling.test.js
npm test -- --testNamePattern="analyze-document"
```

The pre-merge gate is `npm run local:gate` (full CI + native module verify). See
[`PACKAGE_SCRIPTS.md`](PACKAGE_SCRIPTS.md) for everything in detail.

---

## 7. Things that will surprise a senior dev

Each of these has bitten somebody and is in the codebase because of a real incident.

1. **Sandbox is `true`; preload is webpack-bundled.** You cannot `require()` at runtime from preload
   or renderer. Add new preload code to the bundle entry, not as a dynamic import.

2. **CSP forbids dynamic code evaluation.** `eval` and dynamic function constructors are not
   permitted: `script-src` is `'self'` plus fixed hashes for the inline splash script, with no
   `unsafe-eval` (built in `src/main/core/securityHeaders.js`).

3. **Every input-accepting IPC handler must have a Zod schema.** A static check
   (`npm run verify:ipc-handler-schemas`) enforces this with a small allowlist for zero-arg
   window-chrome channels. If you add a handler, write the schema first.

4. **Atomic file ops are journaled.** `src/shared/atomicFileOperations.js` writes a journal, does
   the work, removes the journal. Startup runs `recoverFromJournals()` to roll back anything that
   crashed mid-write. Never use plain `fs.writeFile()` for settings, analysis cache, or anything
   you'd be sad to lose.

5. **Electron fuses are checked in CI.** `npm run verify:electron-fuses-config` statically checks
   that `electron-builder.json` declares the fuses and that no `asarUnpack` pattern pulls the main,
   preload or renderer bundles out of the integrity-validated `app.asar`. It cannot check the bits
   of a built binary — use `npx @electron/fuses read --app <path>` for that.

6. **Rate limits + payload size caps.** 200 req/s per channel, 5MB string limit, 10k array items,
   5,000 object keys, 32-deep object trees. Large payloads through IPC will be rejected. Chunk it.

7. **Services are singletons, but resolve them inside handlers, not at module load.**
   `container.resolve(ServiceIds.LLAMA_SERVICE)` (from
   `const { container, ServiceIds } = require('../services/ServiceContainer')`) belongs inside the
   handler function, not at the top of the file. Top-level resolution races initialization order.

8. **Privacy-first means no remote logging.** Logs and crash dumps stay under userData with
   `uploadToServer: false`. Don't add Sentry, Datadog, or anything that calls out — it's a product
   invariant, not a missing feature.

---

## 8. Your first PR

1. **Pick something small.** A typo in a comment, a missing test for an edge case, an obviously
   stale doc line. Don't start with a service-layer refactor.

2. **Branch convention:** `<kind>/<short-description>-<YYYY-MM-DD>` (e.g.
   `fix/preload-rate-limit-2026-05-13`). See recent `main` log for examples.

3. **Before pushing:** `npm run local:gate`. This runs format, lint, typecheck, compliance checks,
   full test suite with coverage, every `verify:*`, and a production build. If it passes, your PR
   will pass CI.

4. **PR template:** `.github/pull_request_template.md` is auto-applied. Fill the summary and test
   plan. Reviews are turnaround-driven; expect rapid feedback if the PR is small.

5. **Don't merge your own PR.** Wait for review and CI green.

---

## 9. Where to go next

- **Architecture details:** [`ARCHITECTURE.md`](ARCHITECTURE.md)
- **IPC contracts:** [`IPC_CONTRACTS.md`](IPC_CONTRACTS.md)
- **DI patterns:** [`DI_PATTERNS.md`](DI_PATTERNS.md)
- **Coding standards:** [`CODE_QUALITY_STANDARDS.md`](CODE_QUALITY_STANDARDS.md)
- **Error handling:** [`ERROR_HANDLING_GUIDE.md`](ERROR_HANDLING_GUIDE.md)
- **Testing:** [`TESTING.md`](TESTING.md)
- **Glossary:** [`GLOSSARY.md`](GLOSSARY.md) — for any term in this doc you didn't recognize
- **All npm scripts:** [`PACKAGE_SCRIPTS.md`](PACKAGE_SCRIPTS.md)
- **Debugging local failures:** [`DEBUGGING_GUIDE.md`](DEBUGGING_GUIDE.md)
- **Release process:** [`RELEASING.md`](RELEASING.md)
