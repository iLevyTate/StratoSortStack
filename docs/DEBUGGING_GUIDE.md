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

### First window takes a long time on Windows

**Symptom.** After double-clicking `StratoSort Stack.exe` or the Start Menu shortcut the busy cursor
spins, Task Manager shows several `StratoSort Stack.exe` entries, and no window appears for a long
time (reports range from tens of seconds to more than a minute).

**Three different causes produce this.**

1. **Windows Security scanning newly written files.** The first start after installing, reinstalling
   or extracting the zip (`StratoSortStack-X.X.X-win-x64.zip`) is slower because Windows Security
   scans the app's files (about 1.8 GB) once. Expect that first start to take up to a minute or two
   with real-time protection on; later starts reuse the scan verdicts and are expected to take a few
   seconds. A second start that is as slow as the first is not this cause. Nothing in the app's own
   log covers this phase because the app process has not started yet. Builds up to v5.0.0 also
   shipped a self-extracting portable exe (`StratoSortStack-X.X.X-win-x64.exe`) that unpacked the
   whole app into a randomly named folder under `%TEMP%` on every start and paid this cost on every
   launch. Later releases replace it with the zip, which is extracted once; anyone still running
   that exe should move to the installer or the zip (see [`INSTALL_GUIDE.md`](INSTALL_GUIDE.md)). A
   zip copy started from inside Explorer's compressed-folder view does not start at all, because
   Explorer extracts only that one exe to a temporary folder.
2. **In-app startup (installer and zip alike).** Once `StratoSort Stack.exe` is running, the window
   is created hidden and shown on `ready-to-show`, or force-shown after
   `TIMEOUTS.WINDOW_SHOW_FALLBACK` (4 s) when that event is late, or straight away when the GPU
   process exits before the first show. Before the window is created, each check or creation of the
   `Uncategorized` folder in Documents gives up after `TIMEOUTS.DEFAULT_FOLDER_PROBE` (3 s) and
   startup continues without it; old-log and crash-dump cleanup waits until after the first paint.
   Heavyweight AI bring-up (node-llama-cpp import, GPU probing, backend selection) waits for the
   first paint (`src/main/core/firstPaintGate.js`, capped at `TIMEOUTS.FIRST_PAINT_GATE`, 3 s) and
   then runs behind the splash screen. A long hidden phase on the current build therefore points at
   the main thread being blocked (slow disk, antivirus, a hung GPU process) rather than at the AI
   engine, and the log tells the two apart.
3. **A previous instance still shutting down.** A launch that arrives while the previous instance is
   shutting down (for example right after Quit from the tray) exits on the single-instance lock
   before it can write a log. The instance that is shutting down records the request and starts the
   app again once its own shutdown has finished, so the window appears only after that. Expect an
   idle app to finish shutting down within a few seconds; with analysis running or a large search
   index to save, expect up to about a minute. When a downloaded update is installed on that quit,
   the update takes priority and the app does not start again by itself; start it by hand once the
   installer has finished.

**Triage from the log (no developer tools needed).** Each launch that gets as far as starting the
app writes one JSON-lines file. Every line carries `time` (UTC), `level` and `msg`, plus the extra
fields named below. Lines logged before the log file opens (for example the single-instance lock
result and the GPU fallback decision at module load) are not in the file.

1. Note the wall-clock time of the double-click. Press Windows key + R, type
   `%APPDATA%\StratoSort Stack\logs`, press Enter, switch to Details view and sort by Date modified.
   Open the newest `stratosort-YYYY-MM-DDTHH-MM-SS-mmmZ.log` in Notepad. The timestamp in the file
   name is UTC and is taken when the app process opens its log, so the gap between the double-click
   and that timestamp (gap A) is everything that happened before the app could log: Windows Security
   scanning the exe and its files, SmartScreen, and, when the app relaunched itself after a
   shutdown, the rest of that shutdown. A launch that produced no new file at all means the process
   quit before it could log: normally a second instance that handed over to one already running
   (which brings its window forward), or one that arrived during a shutdown (cause 3, which should
   then produce a new file once the shutdown ends).
2. Search (Ctrl+F) for these messages in order and note the `time` of each, or "not found":
   1. `[LOGGING] File logging enabled` with `logFilePath` and `uptimeS`. `uptimeS` is how many
      seconds the process had already been alive when it opened the log (module load,
      single-instance lock, app ready). The file name is stamped at that same moment, so this time
      is already part of gap A; a value above a few seconds means most of gap A was spent inside the
      app process rather than in antivirus scanning before it.
   2. `[perf]` with `name` `startup:main:time-to-app-ready` and `durationMs` (the same phase in
      milliseconds, counted from the moment the main bundle was evaluated).
   3. `[STORAGE] Documents folder resolved for Uncategorized` with `documentsPath` (once per launch;
      where the app expects the `Uncategorized` folder), then `[STARTUP] Loaded custom folders:`. On
      a first launch `[STARTUP] No saved custom folders found, creating Uncategorized fallback`
      comes between the two.
   4. `[STARTUP] Creating window before heavyweight service startup` with `uptimeS`, followed by
      `[perf]` with `name` `startup:main:time-to-first-window`.
   5. `[AppProtocol] served` with `asset` (`index.html`, then `styles.css`) and `ms`. Both files are
      tiny and are served on the main-process thread.
   6. `[WINDOW] did-finish-load fired`.
   7. `StratoSort window ready and focused` with `uptimeS`. This is the moment the window is on
      screen through the normal path.
   8. `[WINDOW] GPU status after first show` with `shownVia` (`ready-to-show` or `fallback`),
      `featureStatus` and `devices`.
   9. `[STARTUP] First-paint gate released` with `reason` (`shown`, `did-finish-load`, `timeout` or
      `no-window`) and `uptimeS`. Heavyweight startup, and the old-log and crash-dump cleanup, begin
      right after this line.
   10. `[STARTUP] Phase 1: Starting AI services...`, then `[LlamaService] Initializing...`, then
       `[LlamaService] System GPU detected` with `type` and `name`.
   11. `[LlamaService] Llama backend candidates ordered by cached selection` with `cachedBackend`,
       `candidates`, `prioritized` and `changed`, present only when `gpu-backend-cache.json` holds a
       record that matches this machine (see gap D). Then
       `[LlamaService] Llama backend candidates filtered by node-llama-cpp support` with
       `supported`, `candidates`, `filtered` and `changed`.
   12. `[LlamaService] Llama backend init failed` with `backend`, `durationMs` and `error` (count
       these; each one is a failed attempt), then `[LlamaService] Llama backend selected` (with
       `requested` and `actual`) or `[LlamaService] Falling back to CPU backend`, both with
       `durationMs` and an `attempted` list that carries `durationMs` for every candidate tried.
       `[LlamaService] Cleared cached Llama backend after it failed` with `backend` follows a failed
       attempt of the remembered backend, and
       `[LlamaService] Saved Llama backend selection for the next launch` with `backend` and
       `previous` follows a selection that differs from the saved record.
   13. `[STARTUP] Coordinated startup completed successfully`, or
       `[STARTUP] Coordinated startup failed:` followed by
       `[STARTUP] Continuing startup in degraded mode`.

   Also search for these warning and error lines, which are normally absent:

   - `[WINDOW] ready-to-show not received within budget; showing window anyway` (warn, with
     `budgetMs` and `uptimeS`): the renderer had not painted within about 4 s and the window was
     force-shown as an empty themed frame. The time from here to `[WINDOW] did-finish-load fired` is
     how long it stayed blank.
   - `[WINDOW] Window creation timeout, releasing mutex` followed by
     `[WINDOW] Force-showing window after creation timeout` (both warn): the window was still hidden
     after 60 s.
   - `[STORAGE] Uncategorized folder check is slow; keeping the saved path`,
     `[STORAGE] Recreating the Uncategorized folder is slow; keeping the saved path` and
     `[STORAGE] Creating the Uncategorized folder is slow; continuing without it` (warn, with `path`
     and `timeoutMs`): one operation on the Documents folder took longer than 3 s and startup went
     on without waiting for it. Ask whether Documents is redirected to OneDrive or a network share.
     The folder path is kept either way, the operation usually finishes in the background, and
     organizing creates a missing folder on the first move into it.
   - `[STORAGE] Could not create the Uncategorized folder` (warn, with `path`, `code` and `error`):
     Documents refused the folder. A `code` of `EACCES` or `EPERM` usually means Windows Security's
     Controlled folder access. The folder keeps its Documents path, files that match no smart folder
     cannot be moved there until it can be created, and the app shows a warning naming the folder.
     Every launch tries again and logs this line again while it still fails.
   - `[GPU] Process exited` (error; count them) and `[GPU] Repeated GPU failures detected` (two
     variants, warn and error): the graphics driver or GPU process is failing.
     `[GPU] GPU process exited before the window was shown; showing it now` (warn, with `reason` and
     `uptimeS`) means the window was shown early because of such an exit; expect it to stay blank
     until the renderer paints.
   - A file named `.gpu-fallback` in `%APPDATA%\StratoSort Stack` is written after the third GPU
     process exit in one session, each exit within an hour of the one before (an hour with no exit
     restarts the count). While it is less than 3 days old (counted from when it was last written),
     every launch renders in software: drawing is slower but avoids the failing driver, and the AI
     engine is not affected. A software-rendered session never deletes the file. Once it is older
     than that, launches use hardware acceleration again, and the first one whose window is visible
     30 s after it was created, with no GPU process exit in that time, deletes it; three more such
     exits write it again and restart the 3 days. To retry hardware acceleration sooner, quit the
     app and delete the file. Earlier builds deleted it at the next launch, so a failing driver
     produced alternating slow and fast launches. When the file exists, one of these lines appears
     about 30 s after `[STARTUP] Creating window before heavyweight service startup`:
     `[GPU] Software rendering fallback still active` (info, with `flagAgeH` and
     `retryHardwareInH`), `[GPU] Keeping the GPU fallback flag: the GPU process exited this session`
     (warn, with `gpuExitsThisSession`),
     `[GPU] Keeping the GPU fallback flag until a run with a visible window` (info), or
     `[GPU] Hardware acceleration ran stably; GPU fallback flag cleared` (info).
   - `[LlamaService] Llama backend attempt exceeded slow threshold` (warn, with `backend`,
     `durationMs` and `thresholdMs`): one backend attempt took longer than 10 s.
   - `[LlamaService] [node-llama-cpp]` (warn): node-llama-cpp's own console output, forwarded into
     the log while a backend is being tried. A line containing
     `is not compatible with the current system` and `falling back to using` means a prebuilt GPU
     binary was rejected on this PC.

   In PowerShell this does all of step 2 at once (one line; paste it as is):

   ```powershell
   $log = Get-ChildItem "$env:APPDATA\StratoSort Stack\logs\stratosort-*.log" | Sort-Object LastWriteTime -Descending | Select-Object -First 1; Select-String -Path $log.FullName -Pattern 'File logging enabled','\[perf\]','Loaded custom folders','Uncategorized','Creating window before heavyweight','AppProtocol\] served','did-finish-load fired','ready-to-show not received','Window creation timeout','Force-showing window','window ready and focused','GPU status after first show','First-paint gate released','Phase 1: Starting AI services','LlamaService\] Initializing','System GPU detected','Llama backend','node-llama-cpp','\[GPU\]','Coordinated startup','degraded mode','SHUTDOWN\] Relaunch','Not relaunching','Cleanup completed in','SECOND-INSTANCE\] Launch arrived' | ForEach-Object { try { $o = $_.Line | ConvertFrom-Json; $extra = foreach ($k in 'uptimeS','reason','asset','ms','name','durationMs','backend','requested','actual','cachedBackend','previous','changed','shownVia','budgetMs','documentsPath','path','timeoutMs','code','flagAgeH','gpuExitsThisSession','waitedMs') { if ($null -ne $o.$k) { '{0}={1}' -f $k, $o.$k } }; '{0}  {1,-5} {2}  {3}' -f $o.time, $o.level, $o.msg, ($extra -join ' ') } catch { $_.Line } }
   ```

   To run it on the launch before (for example the one that was shutting down when the slow launch
   was clicked), change `-First 1` to `-Skip 1 -First 1`.

3. What the gaps mean:
   - **Gap A** (double-click to the file-name time): everything that happened before the app could
     log. `uptimeS` on `[LOGGING] File logging enabled` is the in-process share of it, so gap A
     minus `uptimeS` is what happened before the app process existed: Windows Security scanning the
     exe and its files, SmartScreen, or the end of a previous instance's shutdown. Expect it to be
     large on the installed build or a freshly extracted zip only on the first launch after
     installing or extracting, or while SmartScreen checks the file, and a few seconds otherwise.
     When the log of the launch before has `[SHUTDOWN] Relaunching after shutdown` (with `reason`
     and `waitedMs`) near its end, the click arrived during that shutdown and gap A includes the
     rest of it; the same file then also has
     `[SHUTDOWN] Relaunch requested; the app will start again after shutdown` and
     `[SECOND-INSTANCE] Launch arrived during shutdown; relaunching after exit` at the time of the
     click, and `[SHUTDOWN] Cleanup completed in` gives the cleanup time.
     `[SHUTDOWN] Not relaunching: a downloaded update installs on this quit` (warn) in its place
     means the update installer ran instead and the app had to be started by hand.
   - **Gap B** (`[LOGGING] File logging enabled` to
     `[STARTUP] Creating window before heavyweight service startup`): pre-window housekeeping
     (crash-journal recovery, loading the folder list, checking or creating
     `Documents\Uncategorized`, settings). Expect well under 5 s. Each `Uncategorized` folder
     operation is capped at 3 s, so a slow Documents folder shows up as one of the `[STORAGE]`
     slow-folder warnings above rather than as a long gap. The difference between the two `[perf]`
     `durationMs` values (`time-to-first-window` minus `time-to-app-ready`) is this phase in
     milliseconds, counted from app ready instead of from the first log line.
   - **Gap C** (`[STARTUP] Creating window before heavyweight service startup` to
     `StratoSort window ready and focused`, or to the `ready-to-show not received within budget`
     warning): the hidden-window phase, and the one that matters most. On the current build it is
     expected to stay well under the 4 s fallback. `[AppProtocol] served` with `ms` in the thousands
     for `index.html` or `styles.css` means the main thread was starved; something synchronous was
     running and the renderer was not the problem. `featureStatus` values containing `software` on
     `[WINDOW] GPU status after first show`, or any `[GPU] Process exited` line, point at the
     graphics driver. Any `[LlamaService]` line whose time falls inside gap C means AI bring-up ran
     before the first paint, which the first-paint gate is meant to prevent; report it together with
     the `reason` on `[STARTUP] First-paint gate released`.
   - **Gap D** (`[LlamaService] Initializing...` to `[LlamaService] Llama backend selected` or
     `[LlamaService] Falling back to CPU backend`): AI bring-up, which is the GPU backend ladder.
     Each `[LlamaService] Llama backend init failed` line is one candidate that was test-loaded and
     rejected, and its `durationMs` is what it cost; the `attempted` list on the final line repeats
     those numbers for every candidate. Expect a handful of seconds. A failure with `backend` `cuda`
     and an `error` naming `NoBinaryFoundError`, or a forwarded `[node-llama-cpp]` line saying
     `is not compatible with the current system`, means a CUDA binary was tried that this PC cannot
     run. This phase happens behind the visible splash, so it lengthens the time until the app is
     usable, not the time until the window appears.

     The app remembers the GPU backend the ladder settled on in
     `%APPDATA%\StratoSort Stack\gpu-backend-cache.json` and tries that backend first on later
     launches, so on a machine whose setup has not changed expect no
     `[LlamaService] Llama backend init failed` lines once the record exists. On Windows
     node-llama-cpp still test-loads the chosen binary in a child process, so the record saves the
     cost of candidates that fail, not of the one that works. The record is not used on the very
     first launch (there is none yet), after an app update, when the detected GPU name, type or
     driver version changes, when the GPU backends node-llama-cpp finds runtimes for change (for
     example after a CUDA toolkit is installed), or once it is 14 days old; the full ladder then
     runs and a GPU result is saved again. While `STRATOSORT_LLM_GPU_BACKEND`,
     `STRATOSORT_FORCE_SOFTWARE_GPU`, `ELECTRON_FORCE_SOFTWARE` or `--safe-mode` chooses the
     backend, the record is neither read nor changed. A CPU result is never saved. Deleting the file
     while the app is closed makes the next launch run the full ladder. Why a record was not used is
     logged as `[LlamaBackendCache] Ignoring cached backend record` with `reason` (`missing`,
     `unreadable`, `corrupt`, `invalid`, `fingerprint-mismatch`, `supported-backends-changed` or
     `expired`) at debug level, which packaged builds do not write by default.
4. **Several `StratoSort Stack.exe` processes are normal.** In Task Manager, Details tab, add the
   Command line column (right-click a column header, Select columns). During a launch expect: one
   `StratoSort Stack.exe` without `--type`, one with `--type=gpu-process`, one `--type=renderer`,
   one or two `--type=utility`, one `--type=crashpad-handler`, and for the first few seconds of AI
   bring-up short-lived `StratoSort Stack.exe` rows with `--type=utility` (node-llama-cpp testing a
   GPU binary in a child process) alongside `powershell.exe`, `wmic.exe` or `nvidia-smi.exe` (GPU
   detection; their console windows are hidden). Five to eight entries is the expected picture.
   Worth reporting: a `StratoSortStack-X.X.X-win-x64.exe` row (the self-extracting portable from
   v5.0.0 or earlier, still unpacking), a `StratoSort Stack.exe` without `--type` that was already
   there before the click (a previous instance still shutting down; see cause 3), or
   `Antimalware Service Executable` holding most of the CPU or disk.
5. **Control runs.** If the installed app is slow every time, close it, wait a minute, and launch it
   from PowerShell twice, once with each variable. Both settings last only for that PowerShell
   window, and both make the app ignore `gpu-backend-cache.json` for that run. Compare the time
   until the window appears and the time until the splash finishes.

   ```powershell
   $env:STRATOSORT_FORCE_SOFTWARE_GPU = '1'; & "$env:LOCALAPPDATA\Programs\StratoSort Stack\StratoSort Stack.exe"
   ```

   ```powershell
   $env:STRATOSORT_LLM_GPU_BACKEND = 'cpu'; & "$env:LOCALAPPDATA\Programs\StratoSort Stack\StratoSort Stack.exe"
   ```

   The first variable turns on software rendering and also runs the AI engine on the CPU; the second
   runs only the AI engine on the CPU. If the first run shows the window clearly sooner than the
   second, it is the graphics driver; see [GPU Configuration](CONFIG.md#gpu-configuration) in
   `CONFIG.md`. If both runs finish the splash much sooner than a normal launch, it is the AI GPU
   backend ladder; the `STRATOSORT_LLM_GPU_BACKEND` row in
   [CONFIG.md](CONFIG.md#llamacpp-binary-management-security-sensitive) lists the accepted values
   (an explicit value also bypasses node-llama-cpp's supported-backend filter). The probe that
   node-llama-cpp runs when its GPU addons load is described under
   [Electron quits at startup in a headless VM or container](#electron-quits-at-startup-in-a-headless-vm-or-container-no-gpu-driver)
   later in this guide. For a copy extracted from the zip, replace the path with the
   `StratoSort Stack.exe` in the folder it was extracted to.

6. **What to send.** Zip the whole `logs` folder (right-click, Send to, Compressed folder) and
   attach it with: which file you launched (installer shortcut, a folder extracted from the zip and
   its path, or an old portable exe) and whether you re-ran the installer or re-extracted the zip
   before timing, the gap A to D numbers, the Task Manager observations, your graphics card name
   (Task Manager, Performance, GPU) and whether the system drive is an HDD or an SSD.

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
