# Debugging Guide — Local Dev Failure Modes

A symptom → cause → fix index for things that go wrong while running StratoSort Stack locally. If
you hit something that isn't listed here, add it after you've solved it.

## Build / install

### `npm install` postinstall fails with "Could not detect abi for version X.Y.Z and runtime electron"

**Cause.** Electron was bumped to a version `node-abi` hasn't published support for yet. The
postinstall script (`scripts/postinstall.js`) tries to rebuild native modules via
`@electron/rebuild` and bails.

**Fix.** Either:

- Check whether `node-abi` has a newer release (`npm view node-abi versions --json | tail`). If yes,
  bump it: `npm install --save-dev node-abi@latest`.
- Or roll Electron back to the last working version in `package.json`.

Note: `npm install` itself still completes — the dep tree is populated. You can use most scripts
(lint, format, tests using mocks) before native rebuild succeeds.

### `node_modules/.bin/prettier: not found` on commit

**Cause.** `node_modules/` wasn't installed (e.g. after a fresh clone or after `npm run clean` nuked
a parent dir).

**Fix.** `npm install --no-audit --no-fund`. Don't `--no-verify` the commit; the hook is catching a
real problem (your dev env is missing dependencies).

### Webpack HMR doesn't pick up changes in preload

**Cause.** Preload is built by `webpack.main.config.js`, not the renderer config. Renderer HMR
doesn't watch it.

**Fix.** Run `npm run build:main:dev` whenever you change preload, then reload the app window. Or
use `npm run dev` (does both builds + electron) from scratch.

### "Cannot find module" in renderer or preload at runtime

**Cause.** Sandbox is enabled. Runtime `require()` is forbidden. The module needs to be in the
webpack bundle.

**Fix.** Don't lazy-require. Add the dep to the relevant webpack entry. If it really has to be
loaded conditionally, move the conditional inside the bundled code, not at the `require` site.

## App startup

### App window flashes and closes; nothing in stderr

**Cause.** Likely a CSP violation or a renderer-process exception during early bootstrap.

**Fix.** Run `npm run start:debug` and attach Chrome DevTools to the main process
(`chrome://inspect`). Or add `--enable-logging` (already in the `dev` script) and check
`%APPDATA%\StratoSort Stack\logs\` on Windows,
`~/Library/Application Support/StratoSort Stack/logs/` on macOS, or
`~/.config/StratoSort Stack/logs/` on Linux.

### "Cannot detect Electron fuses" verifier failure

**Cause.** `electron-builder.json` is missing one of the required fuses, OR the packaged binary's
actual fuse bits don't match the declaration.

**Fix.** Run `npm run verify:electron-fuses-config` for the config-side complaint, or
`npx @electron/fuses read --app <path-to-built-binary>` for the binary side.

### Crash-on-launch on older macOS (Intel)

**Known issue.** Packaged macOS builds intentionally skip Electron's single-instance lock on macOS
13.x and older to avoid a launch-time crash. Documented in [`RELEASING.md`](RELEASING.md) § "Older
macOS startup workaround". Tradeoff: duplicate launches allowed instead of focus-existing.

## IPC / preload

### "Unauthorized IPC channel: X" in renderer

**Cause.** You added a channel to `src/shared/constants.js` but didn't regenerate the preload's
allowlist.

**Fix.** `npm run generate:channels:update`. Commit the regenerated file. CI's
`generate:channels:check` will fail otherwise.

### IPC handler validation error: "schema not found for channel"

**Cause.** New input-accepting handler without a Zod schema.

**Fix.** Add a schema to `src/main/ipc/validationSchemas.js`. Re-run
`npm run verify:ipc-handler-schemas` until it's silent. Zero-arg window-chrome channels can go in
`SCHEMA_OPTIONAL_CHANNELS` instead, but only if they really take no input.

### Rate limit hit during a stress test

**Cause.** Default 200 req/s per channel. Stress tests trip this.

**Fix.** Don't disable the limiter. Either chunk the work, or call from a single batch endpoint that
does the loop inside main. If you genuinely need a higher limit, the cap is
`PERF_LIMITS.MAX_IPC_REQUESTS_PER_SECOND` (200) in `src/shared/performanceConstants.js`, enforced by
`src/preload/ipcRateLimiter.js`.

### Payload size error: response > 5MB

**Cause.** Returning a huge object (e.g. all embeddings) from one IPC call.

**Fix.** Page or stream. For embeddings specifically, return a handle/cursor and let the renderer
pull pages, or use a push event for streaming chunks (see `chatStreamChunkSchema` in
`src/shared/ipcEventSchemas.js`).

## AI / inference

### "GPU OOM" or degraded-state badge appears

**Cause.** `ModelMemoryManager` detected VRAM exhaustion. `DegradationManager` paused GPU-heavy ops
and downgraded to CPU-only.

**Fix.** Close other GPU consumers. Or restart the app to clear the degraded flag (also dismissible
via the system menu — that path uses the concurrency-limited `system:dismiss-degraded-flag`
channel).

### Whisper transcription fails with binding errors

**Cause.** `@fugood/whisper.node` 1.0.18+ requires an ArrayBuffer (not Buffer) for PCM input.

**Fix.** Use `pcmToArrayBuffer(pcm)` in `WhisperService` rather than passing a Buffer directly. The
helper avoids Buffer-pool aliasing by slicing into a fresh ArrayBuffer.

### "dimension-mismatch" event from OramaVectorService

**Cause.** Embedding model changed but the persisted vector DB is from a previous model with a
different embedding dimension.

**Fix.** Rebuild the vectors with the current model: Settings → AI Configuration (Advanced mode) →
Embeddings maintenance → **Rebuild all embeddings** (keeps analysis; re-embeds everything). As a
last resort, quit the app and delete the vector DB directory (`userData/vector-db/` by default,
including its `*.sidecar.json` files), then rebuild.

### Embedding queue stalls

**Cause.** Embeddings normally run in the main process (the default). Common stall causes: the
embedding model failed to load, or the queue is under backpressure. The optional
`STRATOSORT_ENABLE_EMBEDDING_WORKER=true` worker mode (off by default) can also stall if its worker
thread crashes.

**Fix.** Check the env knobs in [`CONFIG.md`](CONFIG.md#embeddings-and-embedding-queue-environment).
`STRATOSORT_ANALYSIS_EMBEDDING_QUEUE_WAIT` and `STRATOSORT_ORGANIZE_EMBEDDING_QUEUE_WAIT` are
boolean strings (default off); set them to `true` only to restore the old per-file/saturated-queue
waits.

### Electron quits at startup in a headless VM or container (no GPU driver)

**Cause.** `node-llama-cpp` ships prebuilt Vulkan and CUDA addons that probe the GPU driver when
they load. In a VM or container without GPU drivers that probe crashes the child process, and
`ErrorHandler` treats the crash as critical and calls `app.quit()`.

**Fix.** Rename the GPU-specific addons so `node-llama-cpp` falls back to its CPU-only binary, then
launch with software rendering:

```bash
mv node_modules/@node-llama-cpp/linux-x64-vulkan/bins/linux-x64-vulkan/llama-addon.node \
   node_modules/@node-llama-cpp/linux-x64-vulkan/bins/linux-x64-vulkan/llama-addon.node.bak
mv node_modules/@node-llama-cpp/linux-x64-cuda/bins/linux-x64-cuda/llama-addon.node \
   node_modules/@node-llama-cpp/linux-x64-cuda/bins/linux-x64-cuda/llama-addon.node.bak
NODE_ENV=development STRATOSORT_FORCE_SOFTWARE_GPU=1 \
  electron . --enable-logging --no-sandbox --disable-gpu
```

Inference then runs on the CPU-only `@node-llama-cpp/linux-x64` addon (slow but functional).
`node scripts/restore-gpu-binaries.js` puts the GPU addons back. Two related notes for such hosts:
large text models (the default 3B model included) can hit `SIGILL` inside Electron's runtime on some
virtualized CPUs, so prefer a model under roughly 500 MB there; and models must sit in the userData
models directory (`~/.config/StratoSort Stack/models/` on Linux, with the space), which is where
`LlamaService` looks, not the lowercase legacy path.

## Tests

### Test passes standalone but fails in the full suite

**Known case.** `test/unit/pathHandling.test.js` is flaky in the full suite (pre-existing
test-ordering issue). If it's a different test, you've likely got shared-state pollution.

**Fix.** Look for module-level mutation, singleton initialization, or stubs that don't get cleaned
in `afterEach`. Reset the module registry between tests if you must (`jest.resetModules()`), but
treat it as a code smell to investigate.

### `console.warn` / `console.error` showing in test output

**Cause.** The filter that mutes these in tests lives in `test/test-globals.js`, not
`test-setup.js`. If your test config doesn't include test-globals, warnings leak.

**Fix.** Check the Jest project config you're running. The main `test/jest.config.js` includes
globals; the perf/stress/integration configs may not.

### Jest hangs after a test passes

**Cause.** Open handle (unclosed timer, listener, server, db).

**Fix.** `npm test` already passes `--detectOpenHandles`. Read the output; it points at the culprit.
Add cleanup in `afterEach` or `afterAll`.

## Tooling

### Husky pre-commit hook fails on something obviously unrelated

**Cause.** Lint-staged runs prettier + eslint on staged files. If you `git add` a file that fails
one of them, the hook reverts your stash and fails the commit.

**Fix.** Check the actual error in the output. Run `npm run format` and `npm run lint:fix` to
auto-fix what's auto-fixable, then re-stage and re-commit. Don't use `--no-verify`.

### `git status` shows files you don't recognize after `npm test`

**Cause.** Tests wrote to a path that isn't gitignored.

**Fix.** Either gitignore the path (if it's truly temp) or fix the test to clean up. Don't commit
the noise.

## When all else fails

1. Check the issue isn't already in `CHANGELOG.md` "Unreleased" as a known broken thing.
2. Check `CLAUDE.md` "Resolved Gaps" — if your symptom matches a fixed gap, you might be on an old
   branch.
3. `git log --oneline -20` to see what landed recently.
4. Open an issue with logs from `%APPDATA%\StratoSort Stack\logs\` (Windows),
   `~/Library/Application Support/StratoSort Stack/logs/` (macOS) or
   `~/.config/StratoSort Stack/logs/` (Linux).
