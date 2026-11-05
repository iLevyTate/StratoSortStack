# Live Activity Panel Implementation Plan

<!-- prettier-ignore-start -->

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:** A floating, draggable, minimizable panel inside the main window that streams what the app
is doing in near real time: a plain-language **Activity** tab by default and the sanitized pino
records in a **Raw** tab, toggled by the `showLiveActivity` setting (Settings → Diagnostics) and
Ctrl/Cmd+Shift+L.

**Architecture:** The shared logger gains an opt-in listener hook that sees each record after
sanitization and only at enabled levels. A main-process `liveLogFeed` service registers that
listener only while a renderer is subscribed, keeps a 500-entry ring buffer, classifies each record
with the pure `activityFromLogRecord` table, and pushes batches (every 250 ms, ≤200 entries, with a
`dropped` count) through `safeSend` on the event-only channel `system:live-log:batch`. Two invoke
channels (`system:live-log:subscribe` / `:unsubscribe`) are handled in `src/main/ipc/system.js`. In
the renderer, `useLiveLogFeed` owns the subscription and buffering, `useDraggablePanel` owns
geometry (pointer drag, corner resize, keyboard, clamping), and `LiveActivityPanel.jsx` renders the
card/pill with virtualized rows. App.js mounts the panel lazily when the setting is on.

**Tech Stack:** Electron 41 main/preload/renderer, pino logger (`src/shared/logger.js`), Zod event
schemas, React 19 + Redux Toolkit, react-window 2 (`List`), lucide-react, Tailwind CSS 4 tokens,
Jest 30 + @testing-library/react (jsdom).

---

## Conventions for every task

- Run single test files with:
  `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 <file>`
- Run checks with `fnm exec --using=24.22.1 -- npm.cmd run <script>`.
- `npm run generate:channels` only PRINTS the generated block; the script that WRITES
  `src/preload/preload.js` is `generate:channels:update` (and `generate:channels:check` verifies).
- Every new `.js` under `src/` starts with `// @ts-check` on line 1 and annotates every parameter
  (JSDoc) so `typecheck:js` (noImplicitAny) passes. `.jsx` files carry no directive.
- Git hooks are ON (lint-staged runs `eslint --fix` + `prettier --write` on staged files). The hook
  needs Node on PATH; if `git commit` cannot find it, run the commit as
  `fnm exec --using=24.22.1 -- git commit -m "..."`. Never pass `--no-verify`. No attribution lines.
- Never use `git stash` to park work (long-lived user stashes exist).
- Snippets after "replace:" / "with:" are exact text, indentation included. The plan body sits
  inside `prettier-ignore` markers so formatting never dedents them; apply them verbatim.
- Test files must end in `.test.js` (jest `testMatch` does not pick up `.test.jsx`).
- `test/test-setup.js` globally mocks `../src/shared/logger` with `test/mocks/logger.js`; tests of
  the real logger call `jest.unmock('../src/shared/logger')`.

## File structure

Created:

| File                                                            | Responsibility                                                                                                                           |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/main/services/liveLogActivity.js`                          | Pure classifier: one sanitized log record → `{ kind, icon, text, file?, tone }` or `null` (rule table keyed by context + message).      |
| `src/main/services/liveLogFeed.js`                              | Subscriber registry, logger listener lifecycle, 500-entry ring buffer, 250 ms batching (≤200 + `dropped`), auto-unsubscribe, `safeSend`. |
| `src/renderer/store/thunks/liveActivityThunks.js`               | `setShowLiveActivity(enabled)` / `toggleShowLiveActivity()`: optimistic Redux update + partial `settings.save`, rollback on failure.     |
| `src/renderer/hooks/useDraggablePanel.js`                       | Panel geometry: pointer drag, bottom-right resize, arrow-key move / Shift+arrow resize, clamping to the window, commit callback.        |
| `src/renderer/hooks/useLiveLogFeed.js`                          | Renderer subscription: backlog + batches (dedupe by id), 500-entry cap, pause buffering with count, dropped total, recent-activity flag. |
| `src/renderer/components/diagnostics/liveActivityPanelState.js` | Per-machine panel UI state in `localStorage` (`stratosort_live_activity_panel`), every read/write in try/catch.                          |
| `src/renderer/components/diagnostics/liveActivityFormat.js`     | Pure view helpers: level ranks/filters, time format, redaction of file names ("a file"), copy-line format.                              |
| `src/renderer/components/diagnostics/LiveActivityPanel.jsx`     | The floating card + minimized pill, tabs, controls, virtualized rows, details box, a11y labels.                                         |
| `test/logger.liveRecordListener.test.js`                        | Logger hook: sanitized record, level gate, throwing listener, removal, zero cost without listeners.                                    |
| `test/main/services/liveLogActivity.test.js`                    | Table-driven classifier tests for every rule + problem mapping + unknown → null.                                                       |
| `test/main/services/liveLogFeed.test.js`                        | Feed lifecycle, backlog, cadence, caps, dropped, destroyed webContents, feedback-loop guard, singleton.                                |
| `test/liveLogChannels.test.js`                                  | Channel constants, event-only membership, receive allowlist, generated preload block, verify-script list.                              |
| `test/ipcEventSchemas.liveLog.test.js`                          | `system:live-log:batch` payload schema.                                                                                                 |
| `test/systemIpc.liveLog.test.js`                                | Subscribe/unsubscribe invoke handlers in `system.js`.                                                                                   |
| `test/ipcServices.liveLog.test.js`                              | Renderer `systemIpc` live-log methods.                                                                                                  |
| `test/settings.showLiveActivity.test.js`                        | Setting registered in defaults, allowlist, validation rules and the `settings:save` Zod schema.                                         |
| `test/liveActivityThunks.test.js`                               | Thunk optimistic update, partial save, rollback, toggle.                                                                                |
| `test/components/liveActivityPanelState.test.js`                | Storage load/save, defaults, garbage input, storage exceptions.                                                                        |
| `test/components/liveActivityFormat.test.js`                    | View helpers incl. redaction cases.                                                                                                     |
| `test/hooks/useDraggablePanel.test.js`                          | Clamp math, drag, resize min/max, keyboard, window shrink, unmount mid-drag.                                                            |
| `test/hooks/useLiveLogFeed.test.js`                             | Subscription, early batches, dedupe, caps, pause/resume, clear, dropped, unmount, unavailable, pulse timer.                             |
| `test/components/LiveActivityPanel.test.js`                     | Panel behavior end to end with a mocked feed hook.                                                                                      |
| `test/components/DiagnosticsLogsSection.liveActivity.test.js`   | The Settings → Diagnostics "Show live activity" switch.                                                                                 |

Modified:

| File                                                          | Change                                                                                                            |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| `src/shared/logger.js`                                        | `addLiveRecordListener` / `removeLiveRecordListener`, `Logger#_emitLiveRecord`, call from `_safeWrite`, exports.  |
| `test/mocks/logger.js`                                        | Add the two listener functions as `jest.fn()` so code requiring them under the global mock works.                |
| `src/shared/constants.js`                                     | `IPC_CHANNELS.SYSTEM.LIVE_LOG_SUBSCRIBE / LIVE_LOG_UNSUBSCRIBE / LIVE_LOG_BATCH`.                                |
| `src/shared/ipcEnforcement.js`                                | `'SYSTEM.LIVE_LOG_BATCH'` in `EVENT_ONLY_CHANNEL_REFS`.                                                           |
| `src/shared/securityConfig.js`                                | Batch channel in `ALLOWED_RECEIVE_CHANNELS`; `'showLiveActivity'` in `allowedKeys`.                              |
| `scripts/verify-ipc-handlers.js`                              | `'SYSTEM.LIVE_LOG_BATCH'` in `KNOWN_EVENT_ONLY_CHANNELS`.                                                         |
| `src/preload/preload.js`                                      | Regenerated channel block; `system.subscribeLiveLog / unsubscribeLiveLog / onLiveLogBatch` bridges.              |
| `test/ipcEnforcement.test.js`                                 | Event-only count pin 8 → 9.                                                                                       |
| `src/shared/ipcEventSchemas.js`                               | `liveLogBatchSchema` + `EVENT_SCHEMAS` entry.                                                                     |
| `src/main/ipc/system.js`                                      | Subscribe/unsubscribe handlers (sender-targeted).                                                                 |
| `test/preload.coverage.test.js`                               | Live-log bridge test.                                                                                             |
| `src/renderer/services/ipc/systemIpc.js`                      | `subscribeLiveLog`, `unsubscribeLiveLog`, `onLiveLogBatch`.                                                       |
| `src/shared/defaultSettings.js`                               | `showLiveActivity: false`.                                                                                        |
| `src/shared/settingsValidation.js`                            | `showLiveActivity` boolean rule.                                                                                  |
| `src/main/ipc/validationSchemas.js`                           | `showLiveActivity: z.boolean().nullish()` in `settingsSchema`.                                                    |
| `src/renderer/styles.css`                                     | `--z-floating-panel: 300` + `@utility z-floating-panel`.                                                          |
| `test/ux/zIndexLayering.test.js`                              | Pin the new layer and include it in the utility scan.                                                            |
| `src/renderer/App.js`                                         | Lazy-mount `LiveActivityPanel` behind `ui.settings.showLiveActivity`.                                             |
| `test/components/App.viewMode.test.js`                        | Mount/unmount tests for the panel.                                                                                |
| `src/renderer/components/settings/DiagnosticsLogsSection.jsx` | "Show live activity" switch row (via SettingsPanel's local settings updater).                                    |
| `src/renderer/components/SettingsPanel.jsx`                   | Pass `settings` / `setSettings` to `DiagnosticsLogsSection` (~line 1789).                                         |
| `src/renderer/hooks/useKeyboardShortcuts.js`                  | Ctrl/Cmd+Shift+L → `toggleShowLiveActivity()`.                                                                     |
| `test/useKeyboardShortcuts.test.js`                           | Shortcut tests.                                                                                                   |
| `docs/USER_GUIDE.md`, `docs/DEBUGGING_GUIDE.md`, `CHANGELOG.md` | Short user/dev entries; `[Unreleased]` → Added.                                                                |
| `scripts/verify-checkjs-ratchet.js`                           | `GLOBAL_DIRECTIVE_FLOOR` 475 → 482 (7 new `.js` files under `src/`).                                              |

### Deviations from the spec (decided while grounding in the code)

1. **Entries carry `dataText` (a ≤4000-char JSON string), not the raw `data` object.** The feed
   stringifies the already-sanitized data once in main. This keeps the Zod event schema cheap and
   bounded, avoids the preload sanitizer's depth fallback on deep objects, and gives the Raw tab its
   "compact one-line JSON" directly. Expanding a Raw row shows the full message + `dataText` in a
   read-only details box under the list (fixed row heights keep virtualization simple).
2. **"Filed → Financial" only shows a folder when the log line still has one.** The logger
   redacts absolute paths to `[REDACTED_PATH]\name.ext`, so the destination folder of a move is
   usually gone by the time the feed sees it; the Activity line then reads "Filed name.ext".
3. **Undo:** `UndoRedoService` logs no info line on a successful undo; the Activity rule uses
   `[UndoRedoService] Restoring file from backup` ("Undo: restoring name.ext"), and undo failures
   surface through the generic warn/error "Problem:" rule. No new log lines are added (non-goal).
4. **Downloads:** there is no "new download detected" info log; the Activity rules use the real
   lines: auto-organized, renamed-on-conflict, left in place, held for disk full, disk room again.
5. **The Settings switch lives in the Diagnostics section, which SettingsPanel shows in Advanced
   mode only.** The shortcut works in every mode.
6. **Feedback-loop guard (not in spec):** `safeSend` logs on failure; the feed ignores records
   produced synchronously while it is delivering a batch so a failing send cannot feed itself.

---

## Task 1: Logger live-record listener hook

**Files:**

- Modify: `src/shared/logger.js` (before `class Logger {` ~line 662; inside `_safeWrite` ~line 897;
  new method after `_safeWrite` ~line 920; `module.exports` ~line 1245)
- Modify: `test/mocks/logger.js`
- Test: `test/logger.liveRecordListener.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `test/logger.liveRecordListener.test.js`:

```js
/**
 * Live Activity hook on the shared logger: opt-in listeners receive each
 * record after sanitization, only at enabled levels, and can never break the
 * log write they observe.
 */

// test-setup.js mocks the logger globally; this suite exercises the real one.
jest.unmock('../src/shared/logger');

jest.mock('pino', () => {
  const instance = {
    error: jest.fn(),
    warn: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    trace: jest.fn(),
    fatal: jest.fn(),
    isLevelEnabled: jest.fn((level) => level !== 'debug' && level !== 'trace'),
    child: jest.fn(function child() {
      return this;
    })
  };
  const pinoMock = jest.fn(() => instance);
  pinoMock.transport = jest.fn(() => ({}));
  pinoMock.destination = jest.fn(() => ({ write: jest.fn(), end: jest.fn() }));
  pinoMock.multistream = jest.fn(() => ({ write: jest.fn(), end: jest.fn() }));
  pinoMock.stdTimeFunctions = { isoTime: () => '' };
  pinoMock.__instance = instance;
  return pinoMock;
});

const pino = require('pino');
const {
  createLogger,
  addLiveRecordListener,
  removeLiveRecordListener
} = require('../src/shared/logger');

describe('logger live record listeners', () => {
  const instance = pino.__instance;
  let registered;

  beforeEach(() => {
    registered = [];
    jest.clearAllMocks();
    instance.isLevelEnabled.mockImplementation((level) => level !== 'debug' && level !== 'trace');
  });

  afterEach(() => {
    for (const fn of registered) removeLiveRecordListener(fn);
  });

  function listen(fn = jest.fn()) {
    registered.push(fn);
    addLiveRecordListener(fn);
    return fn;
  }

  test('a listener receives the sanitized record with context and timestamp', () => {
    const listener = listen();
    const log = createLogger('LiveTest');

    log.info('Saved C:\\Users\\bob\\Documents\\tax.pdf', {
      filePath: '/home/bob/private/doc.txt',
      apiKey: 'sk-secret'
    });

    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener.mock.calls[0][0]).toEqual({
      time: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
      level: 'info',
      context: 'LiveTest',
      msg: 'Saved [REDACTED_PATH]\\tax.pdf',
      data: { filePath: '[REDACTED_PATH]/doc.txt', apiKey: '[REDACTED]' }
    });
  });

  test('records below the enabled level are not delivered', () => {
    const listener = listen();
    const log = createLogger('LiveTest');

    log.debug('quiet detail');
    expect(listener).not.toHaveBeenCalled();

    log.warn('loud problem');
    expect(listener).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'warn', msg: 'loud problem', context: 'LiveTest' })
    );
  });

  test('a throwing listener never breaks logging and does not starve other listeners', () => {
    listen(
      jest.fn(() => {
        throw new Error('boom');
      })
    );
    const second = listen();
    const log = createLogger('LiveTest');

    expect(() => log.error('still written')).not.toThrow();
    expect(instance.error).toHaveBeenCalled();
    expect(second).toHaveBeenCalledWith(
      expect.objectContaining({ level: 'error', msg: 'still written' })
    );
  });

  test('removed listeners stop receiving records', () => {
    const listener = listen();
    const log = createLogger('LiveTest');
    removeLiveRecordListener(listener);

    log.info('after removal');

    expect(listener).not.toHaveBeenCalled();
  });

  test('with no listener the logger does not even probe the level (zero cost)', () => {
    const log = createLogger('LiveTest');

    log.info('nobody listening');

    expect(instance.isLevelEnabled).not.toHaveBeenCalled();
    expect(instance.info).toHaveBeenCalled();
  });

  test('non-function listeners are ignored', () => {
    addLiveRecordListener(null);
    addLiveRecordListener('not a function');
    const log = createLogger('LiveTest');

    expect(() => log.info('fine')).not.toThrow();
    expect(instance.isLevelEnabled).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/logger.liveRecordListener.test.js`

Expected: FAIL — `addLiveRecordListener is not a function` (TypeError in `listen`).

- [ ] **Step 3: Implement the hook**

In `src/shared/logger.js`, insert this block immediately above `class Logger {`:

```js
/**
 * One sanitized log record as the Live Activity feed sees it.
 * @typedef {{ time: string, level: string, context: string, msg: string, data?: any }} LiveLogRecord
 */

/**
 * Opt-in observers of every record this process writes. Only the main
 * process registers here (src/main/services/liveLogFeed.js, while a window
 * is subscribed to the Live Activity panel). Empty by default, so logging
 * pays nothing for the feature until someone listens.
 * @type {Set<(record: LiveLogRecord) => void>}
 */
const _liveRecordListeners = new Set();

/** @param {(record: LiveLogRecord) => void} listener */
function addLiveRecordListener(listener) {
  if (typeof listener === 'function') _liveRecordListeners.add(listener);
}

/** @param {(record: LiveLogRecord) => void} listener */
function removeLiveRecordListener(listener) {
  _liveRecordListeners.delete(listener);
}

```

In `_safeWrite`, replace:

```js
    try {
      sanitized = data ? sanitizeLogData(data) : undefined;
    } catch {
      // Keep object shape: pino treats a string first arg as the message.
      sanitized = { data: '[UNSERIALIZABLE_LOG_DATA]' };
    }
    try {
      const _pino = /** @type {any} */ (this.pino);
```

with:

```js
    try {
      sanitized = data ? sanitizeLogData(data) : undefined;
    } catch {
      // Keep object shape: pino treats a string first arg as the message.
      sanitized = { data: '[UNSERIALIZABLE_LOG_DATA]' };
    }
    if (_liveRecordListeners.size > 0) {
      this._emitLiveRecord(level, sanitizedMessage, sanitized);
    }
    try {
      const _pino = /** @type {any} */ (this.pino);
```

Then, directly below the closing brace of `_safeWrite` (immediately above the
`  /** @param {any} message @param {...any} args */` comment that precedes
`  error(message, ...args) {`), add:

```js
  /**
   * Hand one sanitized record to the live listeners, only at levels this
   * logger would write. Never throws: a broken listener must not break the
   * log call it is observing.
   * @param {string} level
   * @param {any} message
   * @param {any} data
   */
  _emitLiveRecord(level, message, data) {
    try {
      const _pino = /** @type {any} */ (this.pino);
      if (_pino && typeof _pino.isLevelEnabled === 'function' && !_pino.isLevelEnabled(level)) {
        return;
      }
      /** @type {LiveLogRecord} */
      const record = {
        time: new Date().toISOString(),
        level,
        context: this.context || '',
        msg: typeof message === 'string' ? message : String(message),
        data
      };
      for (const listener of _liveRecordListeners) {
        try {
          listener(record);
        } catch {
          // A listener failure never reaches the caller of the log method.
        }
      }
    } catch {
      // The live feed is best-effort; logging continues regardless.
    }
  }

```

In `module.exports`, replace:

```js
  sanitizeLogData,
  stripLogControlChars,
```

with:

```js
  sanitizeLogData,
  stripLogControlChars,
  addLiveRecordListener,
  removeLiveRecordListener,
```

In `test/mocks/logger.js`, replace:

```js
module.exports = {
  logger,
  createLogger: jest.fn(() => logger),
  createLoggerMock
};
```

with:

```js
module.exports = {
  logger,
  createLogger: jest.fn(() => logger),
  createLoggerMock,
  // Live Activity hook (src/shared/logger.js); main-process code requires
  // these when it starts streaming log records.
  addLiveRecordListener: jest.fn(),
  removeLiveRecordListener: jest.fn()
};
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/logger.liveRecordListener.test.js test/logger.test.js test/logger.rotation.test.js`

Expected: PASS (all three suites).

- [ ] **Step 5: Commit**

```bash
git add src/shared/logger.js test/mocks/logger.js test/logger.liveRecordListener.test.js
git commit -m "feat(logger): opt-in live record listeners for the Live Activity feed"
```

---

## Task 2: Activity classifier (`activityFromLogRecord`)

**Files:**

- Create: `src/main/services/liveLogActivity.js`
- Test: `test/main/services/liveLogActivity.test.js` (create)

The rule table below is grounded in the real log calls (message strings as they look AFTER
`normalizeLogCall` + `sanitizeLogData`, i.e. absolute paths become `[REDACTED_PATH]\name`):

| Rule id                         | Logger context                | Message match (source)                                                                                         | Activity text                                                      |
| ------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| `watcher-analyzing`             | `SmartFolderWatcher`          | `[SMART-FOLDER-WATCHER] Analyzing file: <path>` (SmartFolderWatcher.js:2451)                                   | `Analyzing <file>`                                                 |
| `watcher-queued`                | `SmartFolderWatcher`          | `[SMART-FOLDER-WATCHER] Queued for analysis:` + `{ filePath }` (:1300)                                         | `Queued <file> for analysis`                                       |
| `watcher-complete`              | `SmartFolderWatcher`          | `[SMART-FOLDER-WATCHER] Analysis complete: <path>` (:2791)                                                     | `Analyzed <file>`                                                  |
| `document-analyzing`            | `DocumentAnalysis`            | `Analyzing document file` + `{ path }` (documentAnalysis.js:297)                                               | `Analyzing <file>`                                                 |
| `image-analyzing`               | `ImageAnalysis`               | `Analyzing image file` + `{ path }` (imageAnalysis.js:1283)                                                    | `Analyzing <file>`                                                 |
| `document-analyzed`             | `DocumentAnalysis`            | `[AI-ANALYSIS-SUCCESS] Document analyzed` + `{ fileName, category }` (:965)                                    | `Analyzed <file> → <category>`                                     |
| `image-analyzed`                | `ImageAnalysis`               | `[AI-ANALYSIS-SUCCESS] Image analyzed` + `{ fileName, category }` (:2214)                                      | `Analyzed <file> → <category>`                                     |
| `image-folder-suggestion`       | `ImageAnalysis`               | `[ImageAnalysis] Surfaced new-folder suggestion` + `{ fileName, suggestedNewFolder }` (:2191)                  | `Suggested a new folder "<f>" for <file>`                          |
| `document-folder-suggestion`    | any (logger is passed in)     | `[DocumentLLM] Surfaced new-folder suggestion` (modelAnalysisResult.js:139)                                    | `Suggested a new folder "<f>" for <file>`                          |
| `matcher-folder-suggestion`     | `SemanticFolderMatcher`       | `[FolderMatcher] Surfacing unmatched LLM category as new-folder suggestion` (semanticFolderMatcher.js:646)     | `Suggested a new folder "<f>"`                                     |
| `folder-fallback`               | `FolderMatchingService`       | `[FolderMatching] No match across …; using fallback` + `{ rawCategory, fallbackFolder }` (:1934)               | `No folder matched "<raw>"; using <fallback>`                      |
| `vision-starting`               | `VisionService`               | `[VisionService] Starting vision runtime` (:1623)                                                              | `Starting vision model`                                            |
| `vision-ready`                  | `VisionService`               | `[VisionService] Vision runtime ready` + `{ gpuActive }` (:1788)                                               | `Vision model ready` / `… (GPU)`                                   |
| `vision-stopping`               | `VisionService`               | `[VisionService] Shutting down vision runtime` (:2117)                                                         | `Stopping vision model`                                            |
| `vision-batch-entered`          | `LlamaService`                | `[LlamaService] Entered vision batch mode` (:3951)                                                             | `Vision batch started`                                             |
| `vision-batch-exited`           | `LlamaService`                | `[LlamaService] Exited vision batch mode` (:3992)                                                              | `Vision batch finished`                                            |
| `model-loading`                 | `LlamaService`                | `[LlamaService] Loading <type> model: <name>` (:2573)                                                          | `Loading <type> model`                                             |
| `model-loaded`                  | `ModelMemoryManager`          | `[Memory] Model loaded` + `{ type }` (ModelMemoryManager.js:411)                                               | `<Type> model loaded`                                              |
| `model-unloading`               | `ModelMemoryManager`          | `[Memory] Unloading model` + `{ type }` (:458)                                                                 | `Unloading <type> model`                                           |
| `embedding-unloaded-for-vision` | `LlamaService`                | `[LlamaService] Unloaded the CPU embedding model from the vision batch` (:4080)                                | `Embedding model unloaded for the vision batch`                    |
| `embeddings-flushed`            | `EmbeddingQueue`              | `[EmbeddingQueue] Successfully flushed batch` + `{ success, failed }` (EmbeddingQueueCore.js:915)              | `Saved N search embeddings[, M failed]`                            |
| `index-saved`                   | `OramaVectorService`          | `[OramaVectorService] Persisted databases` + `{ collections }` (debug level, :2509)                            | `Saved search index (<collections>)`                               |
| `storage-full`                  | `DegradedStateTracker`        | `[DegradedState] flag raised` with `code: 'storage.full'` (:118)                                               | `Disk is full; saving is paused`                                   |
| `degraded-raised`               | `DegradedStateTracker`        | `[DegradedState] flag raised` (any other code)                                                                 | `Problem: <flag message>`                                          |
| `storage-cleared`               | `DegradedStateTracker`        | `[DegradedState] flag cleared` with `code: 'storage.full'` (:166)                                              | `Disk has room again; saving resumed`                              |
| `organize-batch-start`          | any (handler logger injected) | `[FILE-OPS] Starting batch operation <id> with <n> files` (batchOrganizeHandler.js:528)                       | `Organizing N files`                                               |
| `organize-move`                 | any                           | `[FILE-OPS] Move completed` + `{ source, destination }` (:848, dev builds only)                                | `Filed <file>[ → <folder>]`                                        |
| `organize-paused`               | any                           | `[FILE-OPS] Batch paused by user` (:1064)                                                                      | `Organizing paused`                                                |
| `auto-organize-file`            | `AutoOrganize-FileProcessor`  | `[AutoOrganize] Auto-organizing new file` + `{ file, destination }` (fileProcessor.js:373)                     | `Filing <file>[ → <folder>]`                                       |
| `auto-organize-held`            | `AutoOrganize-FileProcessor`  | `[AutoOrganize] Holding file for review (not moved)` + `{ file, suggestedFolder }` (:415)                      | `Holding <file> for review (suggested: <f>)`                       |
| `auto-organize-complete`        | `AutoOrganizeService`         | `[AutoOrganize] Organization complete` + `{ organized, needsReview, failed }` (AutoOrganizeServiceCore.js:305) | `Organize finished: N filed, M to review[, K failed]`              |
| `undo-restore`                  | `UndoRedoService`             | `[UndoRedoService] Restoring file from backup` + `{ to }` (:1452)                                              | `Undo: restoring <file>`                                           |
| `download-organized`            | `DownloadWatcher`             | `[DOWNLOAD-WATCHER] Auto-organized with <n>% confidence: <src> => <dest>` (:1168)                              | `Filed download <file>[ → <folder>]`                               |
| `download-renamed`              | `DownloadWatcher`             | `[DOWNLOAD-WATCHER] Moved (fallback, renamed due to conflict) <src> => <dest>` (:1561)                         | `Filed download <file> (renamed)`                                  |
| `download-left`                 | `DownloadWatcher`             | `[DOWNLOAD-WATCHER] File not auto-organized (low confidence or disabled)` (:1228)                              | `Left a download in place (low confidence or auto-organize off)`   |
| `download-held`                 | `DownloadWatcher`             | `[DOWNLOAD-WATCHER] Disk full; holding new download` + `{ filePath }` (warn, :669)                             | `Holding download <file> until the disk has room`                  |
| `download-resumed`              | `DownloadWatcher`             | `[DOWNLOAD-WATCHER] Disk has room again; processing held downloads` (:704)                                     | `Disk has room again; processing held downloads`                   |
| `search-building`               | `SearchService`               | `[SearchService] Building BM25 index...` (:364)                                                                | `Building search index`                                            |
| `search-built`                  | `SearchService`               | `[SearchService] BM25 index built with <n> documents` (:542)                                                   | `Search index built (N documents)`                                 |
| `knowledge-repair`              | `KnowledgeRepair`             | `Startup knowledge repair complete` + summary (knowledgeRepair.js:595)                                         | `Knowledge repair: R restored, E embedded, P passages[, F failed]` |
| (fallback)                      | any                           | any `warn` / `error` / `fatal` record not claimed above                                                        | `Problem: <message without leading [TAG]>`                         |

- [ ] **Step 1: Write the failing test**

Create `test/main/services/liveLogActivity.test.js`:

```js
/**
 * Table-driven tests for the Live Activity classifier. Every message below is
 * the real log line as it reaches the logger listener: after util.format and
 * sanitizeLogData, so absolute paths look like `[REDACTED_PATH]\name.ext`.
 */
const {
  activityFromLogRecord,
  ACTIVITY_RULE_IDS
} = require('../../../src/main/services/liveLogActivity');

const CASES = [
  {
    rule: 'watcher-analyzing',
    record: {
      level: 'info',
      context: 'SmartFolderWatcher',
      msg: '[SMART-FOLDER-WATCHER] Analyzing file: [REDACTED_PATH]\\receipt-0412.jpg',
      data: { applyNaming: true, isContentUpdate: false }
    },
    expected: {
      kind: 'analyze',
      icon: 'analyze',
      tone: 'info',
      text: 'Analyzing receipt-0412.jpg',
      file: 'receipt-0412.jpg'
    }
  },
  {
    rule: 'watcher-queued',
    record: {
      level: 'info',
      context: 'SmartFolderWatcher',
      msg: '[SMART-FOLDER-WATCHER] Queued for analysis:',
      data: { filePath: '[REDACTED_PATH]\\invoice.pdf', eventType: 'add' }
    },
    expected: {
      kind: 'analyze',
      icon: 'analyze',
      tone: 'info',
      text: 'Queued invoice.pdf for analysis',
      file: 'invoice.pdf'
    }
  },
  {
    rule: 'watcher-complete',
    record: {
      level: 'info',
      context: 'SmartFolderWatcher',
      msg: '[SMART-FOLDER-WATCHER] Analysis complete: [REDACTED_PATH]/notes.txt'
    },
    expected: {
      kind: 'analyzed',
      icon: 'check',
      tone: 'success',
      text: 'Analyzed notes.txt',
      file: 'notes.txt'
    }
  },
  {
    rule: 'document-analyzing',
    record: {
      level: 'info',
      context: 'DocumentAnalysis',
      msg: 'Analyzing document file',
      data: { path: '[REDACTED_PATH]\\lease.docx' }
    },
    expected: {
      kind: 'analyze',
      icon: 'analyze',
      tone: 'info',
      text: 'Analyzing lease.docx',
      file: 'lease.docx'
    }
  },
  {
    rule: 'image-analyzing',
    record: {
      level: 'info',
      context: 'ImageAnalysis',
      msg: 'Analyzing image file',
      data: { path: '[REDACTED_PATH]/IMG_2041.HEIC' }
    },
    expected: {
      kind: 'analyze',
      icon: 'analyze',
      tone: 'info',
      text: 'Analyzing IMG_2041.HEIC',
      file: 'IMG_2041.HEIC'
    }
  },
  {
    rule: 'document-analyzed',
    record: {
      level: 'info',
      context: 'DocumentAnalysis',
      msg: '[AI-ANALYSIS-SUCCESS] Document analyzed',
      data: { fileName: 'lease.docx', category: 'Housing', confidence: 0.9 }
    },
    expected: {
      kind: 'analyzed',
      icon: 'check',
      tone: 'success',
      text: 'Analyzed lease.docx → Housing',
      file: 'lease.docx'
    }
  },
  {
    rule: 'image-analyzed',
    record: {
      level: 'info',
      context: 'ImageAnalysis',
      msg: '[AI-ANALYSIS-SUCCESS] Image analyzed',
      data: { fileName: 'receipt-0412.jpg', category: 'Financial', confidence: 0.82 }
    },
    expected: {
      kind: 'analyzed',
      icon: 'check',
      tone: 'success',
      text: 'Analyzed receipt-0412.jpg → Financial',
      file: 'receipt-0412.jpg'
    }
  },
  {
    rule: 'image-folder-suggestion',
    record: {
      level: 'info',
      context: 'ImageAnalysis',
      msg: '[ImageAnalysis] Surfaced new-folder suggestion',
      data: { fileName: 'IMG_2041.HEIC', rawLlmCategory: 'Pets', suggestedNewFolder: 'Pets' }
    },
    expected: {
      kind: 'folder-suggestion',
      icon: 'sparkles',
      tone: 'info',
      text: 'Suggested a new folder "Pets" for IMG_2041.HEIC',
      file: 'IMG_2041.HEIC'
    }
  },
  {
    rule: 'document-folder-suggestion',
    record: {
      level: 'info',
      context: 'DocumentLLM',
      msg: '[DocumentLLM] Surfaced new-folder suggestion',
      data: { fileName: 'lease.docx', rawLlmCategory: 'Housing', suggestedNewFolder: 'Housing' }
    },
    expected: {
      kind: 'folder-suggestion',
      icon: 'sparkles',
      tone: 'info',
      text: 'Suggested a new folder "Housing" for lease.docx',
      file: 'lease.docx'
    }
  },
  {
    rule: 'matcher-folder-suggestion',
    record: {
      level: 'info',
      context: 'SemanticFolderMatcher',
      msg: '[FolderMatcher] Surfacing unmatched LLM category as new-folder suggestion',
      data: { type: 'document', suggestedNewFolder: 'Recipes', topEmbeddingScore: 0.31 }
    },
    expected: {
      kind: 'folder-suggestion',
      icon: 'sparkles',
      tone: 'info',
      text: 'Suggested a new folder "Recipes"'
    }
  },
  {
    rule: 'folder-fallback',
    record: {
      level: 'info',
      context: 'FolderMatchingService',
      msg: '[FolderMatching] No match across exact/canonical/levenshtein/prefix/token/description; using fallback',
      data: { rawCategory: 'Gadgets', fallbackFolder: 'Uncategorized', availableFolders: ['Work'] }
    },
    expected: {
      kind: 'folder-fallback',
      icon: 'folder',
      tone: 'info',
      text: 'No folder matched "Gadgets"; using Uncategorized'
    }
  },
  {
    rule: 'vision-starting',
    record: {
      level: 'info',
      context: 'VisionService',
      msg: '[VisionService] Starting vision runtime',
      data: { port: 8080 }
    },
    expected: { kind: 'vision', icon: 'eye', tone: 'info', text: 'Starting vision model' }
  },
  {
    rule: 'vision-ready',
    record: {
      level: 'info',
      context: 'VisionService',
      msg: '[VisionService] Vision runtime ready',
      data: { port: 8080, backend: 'cuda', gpuActive: true }
    },
    expected: { kind: 'vision', icon: 'eye', tone: 'success', text: 'Vision model ready (GPU)' }
  },
  {
    rule: 'vision-ready',
    record: {
      level: 'info',
      context: 'VisionService',
      msg: '[VisionService] Vision runtime ready',
      data: { port: 8080, backend: 'cpu', gpuActive: false }
    },
    expected: { kind: 'vision', icon: 'eye', tone: 'success', text: 'Vision model ready' }
  },
  {
    rule: 'vision-stopping',
    record: {
      level: 'info',
      context: 'VisionService',
      msg: '[VisionService] Shutting down vision runtime'
    },
    expected: { kind: 'vision', icon: 'eye', tone: 'info', text: 'Stopping vision model' }
  },
  {
    rule: 'vision-batch-entered',
    record: {
      level: 'info',
      context: 'LlamaService',
      msg: '[LlamaService] Entered vision batch mode',
      data: { refs: 1 }
    },
    expected: { kind: 'vision', icon: 'eye', tone: 'info', text: 'Vision batch started' }
  },
  {
    rule: 'vision-batch-exited',
    record: {
      level: 'info',
      context: 'LlamaService',
      msg: '[LlamaService] Exited vision batch mode'
    },
    expected: { kind: 'vision', icon: 'eye', tone: 'success', text: 'Vision batch finished' }
  },
  {
    rule: 'model-loading',
    record: {
      level: 'info',
      context: 'LlamaService',
      msg: '[LlamaService] Loading embedding model: nomic-embed-text-v1.5.Q8_0.gguf'
    },
    expected: { kind: 'model', icon: 'cpu', tone: 'info', text: 'Loading embedding model' }
  },
  {
    rule: 'model-loaded',
    record: {
      level: 'info',
      context: 'ModelMemoryManager',
      msg: '[Memory] Model loaded',
      data: { type: 'text', currentUsageMB: 4100 }
    },
    expected: { kind: 'model', icon: 'cpu', tone: 'success', text: 'Text model loaded' }
  },
  {
    rule: 'model-unloading',
    record: {
      level: 'info',
      context: 'ModelMemoryManager',
      msg: '[Memory] Unloading model',
      data: { type: 'embedding' }
    },
    expected: { kind: 'model', icon: 'cpu', tone: 'info', text: 'Unloading embedding model' }
  },
  {
    rule: 'embedding-unloaded-for-vision',
    record: {
      level: 'info',
      context: 'LlamaService',
      msg: '[LlamaService] Unloaded the CPU embedding model from the vision batch'
    },
    expected: {
      kind: 'model',
      icon: 'cpu',
      tone: 'info',
      text: 'Embedding model unloaded for the vision batch'
    }
  },
  {
    rule: 'embeddings-flushed',
    record: {
      level: 'info',
      context: 'EmbeddingQueue',
      msg: '[EmbeddingQueue] Successfully flushed batch',
      data: { success: 12, failed: 0, processed: 12, remaining: 0, duration: '420ms' }
    },
    expected: {
      kind: 'embeddings',
      icon: 'database',
      tone: 'success',
      text: 'Saved 12 search embeddings'
    }
  },
  {
    rule: 'embeddings-flushed',
    record: {
      level: 'info',
      context: 'EmbeddingQueue',
      msg: '[EmbeddingQueue] Successfully flushed batch',
      data: { success: 1, failed: 2, processed: 3, remaining: 0, duration: '90ms' }
    },
    expected: {
      kind: 'embeddings',
      icon: 'database',
      tone: 'warn',
      text: 'Saved 1 search embedding, 2 failed'
    }
  },
  {
    rule: 'index-saved',
    record: {
      level: 'debug',
      context: 'OramaVectorService',
      msg: '[OramaVectorService] Persisted databases',
      data: { collections: ['files', 'chunks'], full: false, durationMs: 18 }
    },
    expected: {
      kind: 'index-saved',
      icon: 'save',
      tone: 'success',
      text: 'Saved search index (files, chunks)'
    }
  },
  {
    rule: 'storage-full',
    record: {
      level: 'warn',
      context: 'DegradedStateTracker',
      msg: '[DegradedState] flag raised',
      data: {
        code: 'storage.full',
        subsystem: 'storage',
        severity: 'error',
        message: 'Your disk is full.'
      }
    },
    expected: {
      kind: 'storage',
      icon: 'hard-drive',
      tone: 'error',
      text: 'Disk is full; saving is paused'
    }
  },
  {
    rule: 'degraded-raised',
    record: {
      level: 'warn',
      context: 'DegradedStateTracker',
      msg: '[DegradedState] flag raised',
      data: {
        code: 'system.metrics-collection-failed',
        subsystem: 'metrics',
        severity: 'warning',
        message: "System health metrics couldn't be collected."
      }
    },
    expected: {
      kind: 'problem',
      icon: 'alert',
      tone: 'warn',
      text: "Problem: System health metrics couldn't be collected."
    }
  },
  {
    rule: 'storage-cleared',
    record: {
      level: 'info',
      context: 'DegradedStateTracker',
      msg: '[DegradedState] flag cleared',
      data: { code: 'storage.full' }
    },
    expected: {
      kind: 'storage',
      icon: 'hard-drive',
      tone: 'success',
      text: 'Disk has room again; saving resumed'
    }
  },
  {
    rule: 'organize-batch-start',
    record: {
      level: 'info',
      context: 'IPC:Files:BatchOrganize',
      msg: '[FILE-OPS] Starting batch operation batch_1730800000_ab12 with 14 files',
      data: { batchId: 'batch_1730800000_ab12', totalOperations: 14 }
    },
    expected: { kind: 'organize', icon: 'folder', tone: 'info', text: 'Organizing 14 files' }
  },
  {
    rule: 'organize-move',
    record: {
      level: 'info',
      context: 'IPC:Files:BatchOrganize',
      msg: '[FILE-OPS] Move completed',
      data: {
        batchId: 'b1',
        index: 0,
        source: '[REDACTED_PATH]\\receipt-0412.jpg',
        destination: '[REDACTED_PATH]\\receipt-0412.jpg'
      }
    },
    expected: {
      kind: 'organize',
      icon: 'folder',
      tone: 'success',
      text: 'Filed receipt-0412.jpg',
      file: 'receipt-0412.jpg'
    }
  },
  {
    rule: 'organize-move',
    record: {
      level: 'info',
      context: 'IPC:Files:BatchOrganize',
      msg: '[FILE-OPS] Move completed',
      data: { source: 'receipt-0412.jpg', destination: 'Financial\\receipt-0412.jpg' }
    },
    expected: {
      kind: 'organize',
      icon: 'folder',
      tone: 'success',
      text: 'Filed receipt-0412.jpg → Financial',
      file: 'receipt-0412.jpg'
    }
  },
  {
    rule: 'organize-paused',
    record: {
      level: 'info',
      context: 'IPC:Files:BatchOrganize',
      msg: '[FILE-OPS] Batch paused by user',
      data: { batchId: 'b1', completed: 3 }
    },
    expected: { kind: 'organize', icon: 'folder', tone: 'info', text: 'Organizing paused' }
  },
  {
    rule: 'auto-organize-file',
    record: {
      level: 'info',
      context: 'AutoOrganize-FileProcessor',
      msg: '[AutoOrganize] Auto-organizing new file',
      data: {
        file: '[REDACTED_PATH]\\scan.pdf',
        destination: '[REDACTED_PATH]\\scan.pdf',
        confidence: 0.91
      }
    },
    expected: {
      kind: 'organize',
      icon: 'folder',
      tone: 'info',
      text: 'Filing scan.pdf',
      file: 'scan.pdf'
    }
  },
  {
    rule: 'auto-organize-held',
    record: {
      level: 'info',
      context: 'AutoOrganize-FileProcessor',
      msg: '[AutoOrganize] Holding file for review (not moved)',
      data: {
        file: '[REDACTED_PATH]/photo.png',
        confidence: 0.4,
        threshold: 0.75,
        suggestedFolder: 'Photos'
      }
    },
    expected: {
      kind: 'organize',
      icon: 'folder',
      tone: 'info',
      text: 'Holding photo.png for review (suggested: Photos)',
      file: 'photo.png'
    }
  },
  {
    rule: 'auto-organize-complete',
    record: {
      level: 'info',
      context: 'AutoOrganizeService',
      msg: '[AutoOrganize] Organization complete',
      data: { organized: 5, needsReview: 2, failed: 0 }
    },
    expected: {
      kind: 'organize',
      icon: 'folder',
      tone: 'success',
      text: 'Organize finished: 5 filed, 2 to review'
    }
  },
  {
    rule: 'undo-restore',
    record: {
      level: 'info',
      context: 'UndoRedoService',
      msg: '[UndoRedoService] Restoring file from backup',
      data: { from: '[REDACTED_PATH]\\backup-1.pdf', to: '[REDACTED_PATH]\\contract.pdf' }
    },
    expected: {
      kind: 'undo',
      icon: 'undo',
      tone: 'info',
      text: 'Undo: restoring contract.pdf',
      file: 'contract.pdf'
    }
  },
  {
    rule: 'download-organized',
    record: {
      level: 'info',
      context: 'DownloadWatcher',
      msg: '[DOWNLOAD-WATCHER] Auto-organized with 87% confidence: [REDACTED_PATH]\\statement.pdf => [REDACTED_PATH]\\statement.pdf'
    },
    expected: {
      kind: 'download',
      icon: 'download',
      tone: 'success',
      text: 'Filed download statement.pdf',
      file: 'statement.pdf'
    }
  },
  {
    rule: 'download-renamed',
    record: {
      level: 'info',
      context: 'DownloadWatcher',
      msg: '[DOWNLOAD-WATCHER] Moved (fallback, renamed due to conflict) [REDACTED_PATH]\\setup.exe => [REDACTED_PATH]\\setup (1).exe'
    },
    expected: {
      kind: 'download',
      icon: 'download',
      tone: 'success',
      text: 'Filed download setup.exe (renamed)',
      file: 'setup.exe'
    }
  },
  {
    rule: 'download-left',
    record: {
      level: 'info',
      context: 'DownloadWatcher',
      msg: '[DOWNLOAD-WATCHER] File not auto-organized (low confidence or disabled)'
    },
    expected: {
      kind: 'download',
      icon: 'download',
      tone: 'info',
      text: 'Left a download in place (low confidence or auto-organize off)'
    }
  },
  {
    rule: 'download-held',
    record: {
      level: 'warn',
      context: 'DownloadWatcher',
      msg: '[DOWNLOAD-WATCHER] Disk full; holding new download',
      data: { filePath: '[REDACTED_PATH]\\movie.mkv', held: 1 }
    },
    expected: {
      kind: 'storage',
      icon: 'hard-drive',
      tone: 'warn',
      text: 'Holding download movie.mkv until the disk has room',
      file: 'movie.mkv'
    }
  },
  {
    rule: 'download-resumed',
    record: {
      level: 'info',
      context: 'DownloadWatcher',
      msg: '[DOWNLOAD-WATCHER] Disk has room again; processing held downloads',
      data: { held: 2 }
    },
    expected: {
      kind: 'storage',
      icon: 'download',
      tone: 'success',
      text: 'Disk has room again; processing held downloads'
    }
  },
  {
    rule: 'search-building',
    record: {
      level: 'info',
      context: 'SearchService',
      msg: '[SearchService] Building BM25 index...'
    },
    expected: { kind: 'search-index', icon: 'search', tone: 'info', text: 'Building search index' }
  },
  {
    rule: 'search-built',
    record: {
      level: 'info',
      context: 'SearchService',
      msg: '[SearchService] BM25 index built with 281 documents'
    },
    expected: {
      kind: 'search-index',
      icon: 'search',
      tone: 'success',
      text: 'Search index built (281 documents)'
    }
  },
  {
    rule: 'knowledge-repair',
    record: {
      level: 'info',
      context: 'KnowledgeRepair',
      msg: 'Startup knowledge repair complete',
      data: { restored: 3, embedded: 7, passages: 2, failed: 0, deferred: 0 }
    },
    expected: {
      kind: 'knowledge-repair',
      icon: 'wrench',
      tone: 'success',
      text: 'Knowledge repair: 3 restored, 7 embedded, 2 passages'
    }
  }
];

describe('activityFromLogRecord', () => {
  test.each(CASES)('$rule → "$expected.text"', ({ record, expected }) => {
    expect(activityFromLogRecord(record)).toEqual(expected);
  });

  test('the table covers every rule id', () => {
    expect(new Set(CASES.map((c) => c.rule))).toEqual(new Set(ACTIVITY_RULE_IDS));
  });

  test('a known message from the wrong logger context is not trusted', () => {
    expect(
      activityFromLogRecord({
        level: 'info',
        context: 'SomethingElse',
        msg: '[SMART-FOLDER-WATCHER] Analyzing file: [REDACTED_PATH]\\x.pdf'
      })
    ).toBeNull();
  });

  test('a file field without a usable name reads "a file"', () => {
    expect(
      activityFromLogRecord({
        level: 'info',
        context: 'SmartFolderWatcher',
        msg: '[SMART-FOLDER-WATCHER] Queued for analysis:',
        data: { filePath: '[REDACTED_PATH]' }
      })
    ).toEqual({ kind: 'analyze', icon: 'analyze', tone: 'info', text: 'Queued a file for analysis' });
  });

  test('any unmatched warning becomes a Problem line without its [TAG]', () => {
    expect(
      activityFromLogRecord({
        level: 'warn',
        context: 'DownloadWatcher',
        msg: '[DOWNLOAD-WATCHER] Cannot access file:',
        data: { code: 'EBUSY' }
      })
    ).toEqual({
      kind: 'problem',
      icon: 'alert',
      tone: 'warn',
      text: 'Problem: Cannot access file:'
    });
  });

  test('unmatched errors and fatals become error-toned Problem lines', () => {
    expect(
      activityFromLogRecord({
        level: 'error',
        context: 'OramaVectorService',
        msg: '[OramaVectorService] Persist failed: ENOSPC'
      })
    ).toEqual({
      kind: 'problem',
      icon: 'alert',
      tone: 'error',
      text: 'Problem: Persist failed: ENOSPC'
    });
    expect(
      activityFromLogRecord({ level: 'fatal', context: 'App', msg: 'Renderer crashed' })
    ).toEqual({ kind: 'problem', icon: 'alert', tone: 'error', text: 'Problem: Renderer crashed' });
  });

  test('a cleared flag other than storage.full is not an activity', () => {
    expect(
      activityFromLogRecord({
        level: 'info',
        context: 'DegradedStateTracker',
        msg: '[DegradedState] flag cleared',
        data: { code: 'system.metrics-collection-failed' }
      })
    ).toBeNull();
  });

  test('unknown info and debug records are not activities', () => {
    expect(
      activityFromLogRecord({
        level: 'info',
        context: 'LlamaService',
        msg: '[LlamaService] Model configuration updated'
      })
    ).toBeNull();
    expect(activityFromLogRecord({ level: 'debug', context: 'X', msg: 'detail' })).toBeNull();
  });

  test('malformed input returns null instead of throwing', () => {
    expect(activityFromLogRecord(null)).toBeNull();
    expect(activityFromLogRecord({ level: 'info' })).toBeNull();
    expect(
      activityFromLogRecord({
        level: 'info',
        context: 'OramaVectorService',
        msg: '[OramaVectorService] Persisted databases',
        data: { collections: 'not-an-array' }
      })
    ).toEqual({ kind: 'index-saved', icon: 'save', tone: 'success', text: 'Saved search index' });
  });

  test('very long text is clipped to 300 characters', () => {
    const result = activityFromLogRecord({ level: 'error', context: 'X', msg: 'y'.repeat(1000) });
    expect(result.text).toHaveLength(300);
    expect(result.text.endsWith('…')).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/main/services/liveLogActivity.test.js`

Expected: FAIL — `Cannot find module '../../../src/main/services/liveLogActivity'`.

- [ ] **Step 3: Implement the classifier**

Create `src/main/services/liveLogActivity.js`:

```js
// @ts-check
/**
 * Live Activity classifier: turns one sanitized logger record into a
 * plain-language Activity line, or null when the record is not an event the
 * panel recognizes.
 *
 * Pure and synchronous. It runs inside the logger's live-record listener
 * path (src/main/services/liveLogFeed.js), so it must never log, throw, or
 * touch I/O.
 *
 * Each rule names the logger context(s) it trusts (null = any context; used
 * where the caller injects its own logger) and the message the source module
 * writes. Messages arrive AFTER sanitizeLogData, so absolute paths look like
 * `[REDACTED_PATH]\name.ext`; file names are taken from the last path
 * segment. When a rule's builder returns null the next rule is tried; any
 * warn/error/fatal record nothing claimed becomes a "Problem:" line.
 */

/**
 * @typedef {'info' | 'success' | 'warn' | 'error'} ActivityTone
 * @typedef {{ kind: string, icon: string, text: string, file?: string, tone: ActivityTone }} LiveActivity
 * @typedef {{ level: string, context?: string, msg: string, data?: any }} ActivityInput
 * @typedef {(input: ActivityInput, match: RegExpMatchArray) => (LiveActivity | null)} ActivityBuilder
 * @typedef {{ id: string, contexts: string[] | null, pattern: RegExp, build: ActivityBuilder }} ActivityRule
 */

const MAX_TEXT_CHARS = 300;
const MAX_FILE_CHARS = 120;
const REDACTED_PATH = '[REDACTED_PATH]';
const PROBLEM_LEVELS = new Set(['warn', 'error', 'fatal']);

/** @param {string} value */
function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** @param {string} prefix */
function prefixPattern(prefix) {
  return new RegExp(`^${escapeRegExp(prefix)}(.*)$`);
}

/**
 * Last path segment of a (possibly redacted) path, or undefined.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function baseName(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim().replace(/[\\/]+$/, '');
  if (!trimmed) return undefined;
  const parts = trimmed.split(/[\\/]/);
  const last = (parts[parts.length - 1] || '').trim();
  if (!last || last === REDACTED_PATH || last === 'N/A') return undefined;
  return last.length > MAX_FILE_CHARS ? `${last.slice(0, MAX_FILE_CHARS - 1)}…` : last;
}

/**
 * Name of the folder that holds the file, when the path still carries it.
 * @param {unknown} value
 * @returns {string | undefined}
 */
function parentFolderName(value) {
  if (typeof value !== 'string') return undefined;
  const parts = value
    .trim()
    .replace(/[\\/]+$/, '')
    .split(/[\\/]/)
    .filter(Boolean);
  if (parts.length < 2) return undefined;
  const parent = parts[parts.length - 2].trim();
  if (!parent || parent === REDACTED_PATH) return undefined;
  return parent;
}

/**
 * @param {unknown} value
 * @returns {string | undefined}
 */
function text(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/** @param {unknown} value */
function count(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * @param {number} n
 * @param {string} noun
 */
function plural(n, noun) {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** @param {string} value */
function capitalize(value) {
  return value ? value.charAt(0).toUpperCase() + value.slice(1) : value;
}

/** @param {string | undefined} file */
function orAFile(file) {
  return file || 'a file';
}

/**
 * @param {string} kind
 * @param {string} icon
 * @param {ActivityTone} tone
 * @param {string} line
 * @param {string} [file]
 * @returns {LiveActivity}
 */
function activity(kind, icon, tone, line, file) {
  /** @type {LiveActivity} */
  const result = {
    kind,
    icon,
    tone,
    text: line.length > MAX_TEXT_CHARS ? `${line.slice(0, MAX_TEXT_CHARS - 1)}…` : line
  };
  if (file) result.file = file;
  return result;
}

/** @param {string} msg */
function stripLeadingTag(msg) {
  return msg.replace(/^\[[^\]]+\]\s*/, '').trim() || msg;
}

/**
 * @param {string} id
 * @param {string[] | null} contexts
 * @param {string} prefix
 * @param {ActivityBuilder} build
 * @returns {ActivityRule}
 */
function prefixRule(id, contexts, prefix, build) {
  return { id, contexts, pattern: prefixPattern(prefix), build };
}

/**
 * @param {string} id
 * @param {string[] | null} contexts
 * @param {RegExp} pattern
 * @param {ActivityBuilder} build
 * @returns {ActivityRule}
 */
function patternRule(id, contexts, pattern, build) {
  return { id, contexts, pattern, build };
}

/** @type {ActivityBuilder} */
const analyzedWithCategory = (input) => {
  const file = baseName(input.data?.fileName);
  const category = text(input.data?.category);
  return activity(
    'analyzed',
    'check',
    'success',
    category ? `Analyzed ${orAFile(file)} → ${category}` : `Analyzed ${orAFile(file)}`,
    file
  );
};

/** @type {ActivityBuilder} */
const folderSuggestion = (input) => {
  const folder = text(input.data?.suggestedNewFolder);
  if (!folder) return null;
  const file = baseName(input.data?.fileName);
  return activity(
    'folder-suggestion',
    'sparkles',
    'info',
    file ? `Suggested a new folder "${folder}" for ${file}` : `Suggested a new folder "${folder}"`,
    file
  );
};

/** @param {unknown} path */
const analyzingFromPath = (path) => {
  const file = baseName(path);
  return activity('analyze', 'analyze', 'info', `Analyzing ${orAFile(file)}`, file);
};

const WATCHER = ['SmartFolderWatcher'];
const IMAGE = ['ImageAnalysis'];
const DOCUMENT = ['DocumentAnalysis'];
const VISION = ['VisionService'];
const LLAMA = ['LlamaService'];
const MEMORY = ['ModelMemoryManager'];
const DEGRADED = ['DegradedStateTracker'];
const FILE_PROCESSOR = ['AutoOrganize-FileProcessor'];
const DOWNLOADS = ['DownloadWatcher'];
const SEARCH = ['SearchService'];
const ANY = null;

/** @type {ActivityRule[]} */
const RULES = [
  prefixRule('watcher-analyzing', WATCHER, '[SMART-FOLDER-WATCHER] Analyzing file:', (_i, m) =>
    analyzingFromPath(m[1])
  ),
  prefixRule('watcher-queued', WATCHER, '[SMART-FOLDER-WATCHER] Queued for analysis:', (input) => {
    const file = baseName(input.data?.filePath);
    return activity('analyze', 'analyze', 'info', `Queued ${orAFile(file)} for analysis`, file);
  }),
  prefixRule('watcher-complete', WATCHER, '[SMART-FOLDER-WATCHER] Analysis complete:', (_i, m) => {
    const file = baseName(m[1]);
    return activity('analyzed', 'check', 'success', `Analyzed ${orAFile(file)}`, file);
  }),
  prefixRule('document-analyzing', DOCUMENT, 'Analyzing document file', (input) =>
    analyzingFromPath(input.data?.path)
  ),
  prefixRule('image-analyzing', IMAGE, 'Analyzing image file', (input) =>
    analyzingFromPath(input.data?.path)
  ),
  prefixRule(
    'document-analyzed',
    DOCUMENT,
    '[AI-ANALYSIS-SUCCESS] Document analyzed',
    analyzedWithCategory
  ),
  prefixRule('image-analyzed', IMAGE, '[AI-ANALYSIS-SUCCESS] Image analyzed', analyzedWithCategory),
  prefixRule(
    'image-folder-suggestion',
    IMAGE,
    '[ImageAnalysis] Surfaced new-folder suggestion',
    folderSuggestion
  ),
  prefixRule(
    'document-folder-suggestion',
    ANY,
    '[DocumentLLM] Surfaced new-folder suggestion',
    folderSuggestion
  ),
  prefixRule(
    'matcher-folder-suggestion',
    ['SemanticFolderMatcher'],
    '[FolderMatcher] Surfacing unmatched LLM category as new-folder suggestion',
    folderSuggestion
  ),
  prefixRule(
    'folder-fallback',
    ['FolderMatchingService'],
    '[FolderMatching] No match across',
    (input) => {
      const raw = text(input.data?.rawCategory);
      const fallback = text(input.data?.fallbackFolder);
      if (!fallback) return null;
      return activity(
        'folder-fallback',
        'folder',
        'info',
        raw ? `No folder matched "${raw}"; using ${fallback}` : `No folder matched; using ${fallback}`
      );
    }
  ),
  prefixRule('vision-starting', VISION, '[VisionService] Starting vision runtime', () =>
    activity('vision', 'eye', 'info', 'Starting vision model')
  ),
  prefixRule('vision-ready', VISION, '[VisionService] Vision runtime ready', (input) =>
    activity(
      'vision',
      'eye',
      'success',
      input.data?.gpuActive === true ? 'Vision model ready (GPU)' : 'Vision model ready'
    )
  ),
  prefixRule('vision-stopping', VISION, '[VisionService] Shutting down vision runtime', () =>
    activity('vision', 'eye', 'info', 'Stopping vision model')
  ),
  prefixRule('vision-batch-entered', LLAMA, '[LlamaService] Entered vision batch mode', () =>
    activity('vision', 'eye', 'info', 'Vision batch started')
  ),
  prefixRule('vision-batch-exited', LLAMA, '[LlamaService] Exited vision batch mode', () =>
    activity('vision', 'eye', 'success', 'Vision batch finished')
  ),
  patternRule('model-loading', LLAMA, /^\[LlamaService\] Loading (\w+) model:/, (_i, m) =>
    activity('model', 'cpu', 'info', `Loading ${m[1]} model`)
  ),
  prefixRule('model-loaded', MEMORY, '[Memory] Model loaded', (input) => {
    const type = text(input.data?.type);
    return activity(
      'model',
      'cpu',
      'success',
      type ? `${capitalize(type)} model loaded` : 'Model loaded'
    );
  }),
  prefixRule('model-unloading', MEMORY, '[Memory] Unloading model', (input) => {
    const type = text(input.data?.type);
    return activity('model', 'cpu', 'info', type ? `Unloading ${type} model` : 'Unloading a model');
  }),
  prefixRule(
    'embedding-unloaded-for-vision',
    LLAMA,
    '[LlamaService] Unloaded the CPU embedding model from the vision batch',
    () => activity('model', 'cpu', 'info', 'Embedding model unloaded for the vision batch')
  ),
  prefixRule(
    'embeddings-flushed',
    ['EmbeddingQueue'],
    '[EmbeddingQueue] Successfully flushed batch',
    (input) => {
      const saved = count(input.data?.success);
      const failed = count(input.data?.failed);
      return failed > 0
        ? activity(
            'embeddings',
            'database',
            'warn',
            `Saved ${plural(saved, 'search embedding')}, ${failed} failed`
          )
        : activity(
            'embeddings',
            'database',
            'success',
            `Saved ${plural(saved, 'search embedding')}`
          );
    }
  ),
  prefixRule(
    'index-saved',
    ['OramaVectorService'],
    '[OramaVectorService] Persisted databases',
    (input) => {
      const raw = input.data?.collections;
      const collections = Array.isArray(raw)
        ? raw.filter((/** @type {unknown} */ name) => typeof name === 'string')
        : [];
      return activity(
        'index-saved',
        'save',
        'success',
        collections.length > 0
          ? `Saved search index (${collections.join(', ')})`
          : 'Saved search index'
      );
    }
  ),
  prefixRule('storage-full', DEGRADED, '[DegradedState] flag raised', (input) =>
    input.data?.code === 'storage.full'
      ? activity('storage', 'hard-drive', 'error', 'Disk is full; saving is paused')
      : null
  ),
  prefixRule('degraded-raised', DEGRADED, '[DegradedState] flag raised', (input) => {
    const message =
      text(input.data?.message) ||
      text(input.data?.code) ||
      'A part of the app is not working normally';
    return activity(
      'problem',
      'alert',
      input.data?.severity === 'error' ? 'error' : 'warn',
      `Problem: ${message}`
    );
  }),
  prefixRule('storage-cleared', DEGRADED, '[DegradedState] flag cleared', (input) =>
    input.data?.code === 'storage.full'
      ? activity('storage', 'hard-drive', 'success', 'Disk has room again; saving resumed')
      : null
  ),
  patternRule(
    'organize-batch-start',
    ANY,
    /^\[FILE-OPS\] Starting batch operation \S+ with (\d+) files?/,
    (_i, m) => activity('organize', 'folder', 'info', `Organizing ${plural(Number(m[1]), 'file')}`)
  ),
  prefixRule('organize-move', ANY, '[FILE-OPS] Move completed', (input) => {
    const file = baseName(input.data?.source) || baseName(input.data?.destination);
    const folder = parentFolderName(input.data?.destination);
    return activity(
      'organize',
      'folder',
      'success',
      folder ? `Filed ${orAFile(file)} → ${folder}` : `Filed ${orAFile(file)}`,
      file
    );
  }),
  prefixRule('organize-paused', ANY, '[FILE-OPS] Batch paused by user', () =>
    activity('organize', 'folder', 'info', 'Organizing paused')
  ),
  prefixRule(
    'auto-organize-file',
    FILE_PROCESSOR,
    '[AutoOrganize] Auto-organizing new file',
    (input) => {
      const file = baseName(input.data?.file);
      const folder = parentFolderName(input.data?.destination);
      return activity(
        'organize',
        'folder',
        'info',
        folder ? `Filing ${orAFile(file)} → ${folder}` : `Filing ${orAFile(file)}`,
        file
      );
    }
  ),
  prefixRule(
    'auto-organize-held',
    FILE_PROCESSOR,
    '[AutoOrganize] Holding file for review (not moved)',
    (input) => {
      const file = baseName(input.data?.file);
      const folder = text(input.data?.suggestedFolder);
      return activity(
        'organize',
        'folder',
        'info',
        folder
          ? `Holding ${orAFile(file)} for review (suggested: ${folder})`
          : `Holding ${orAFile(file)} for review`,
        file
      );
    }
  ),
  prefixRule(
    'auto-organize-complete',
    ['AutoOrganizeService'],
    '[AutoOrganize] Organization complete',
    (input) => {
      const organized = count(input.data?.organized);
      const review = count(input.data?.needsReview);
      const failed = count(input.data?.failed);
      const line = `Organize finished: ${organized} filed, ${review} to review${
        failed > 0 ? `, ${failed} failed` : ''
      }`;
      return activity('organize', 'folder', failed > 0 ? 'warn' : 'success', line);
    }
  ),
  prefixRule(
    'undo-restore',
    ['UndoRedoService'],
    '[UndoRedoService] Restoring file from backup',
    (input) => {
      const file = baseName(input.data?.to);
      return activity('undo', 'undo', 'info', `Undo: restoring ${orAFile(file)}`, file);
    }
  ),
  patternRule(
    'download-organized',
    DOWNLOADS,
    /^\[DOWNLOAD-WATCHER\] Auto-organized with \S+% confidence: (.*?) => (.*)$/,
    (_i, m) => {
      const file = baseName(m[1]);
      const folder = parentFolderName(m[2]);
      return activity(
        'download',
        'download',
        'success',
        folder ? `Filed download ${orAFile(file)} → ${folder}` : `Filed download ${orAFile(file)}`,
        file
      );
    }
  ),
  patternRule(
    'download-renamed',
    DOWNLOADS,
    /^\[DOWNLOAD-WATCHER\] Moved \(fallback, renamed due to conflict\) (.*?) => (.*)$/,
    (_i, m) => {
      const file = baseName(m[1]);
      return activity(
        'download',
        'download',
        'success',
        `Filed download ${orAFile(file)} (renamed)`,
        file
      );
    }
  ),
  prefixRule(
    'download-left',
    DOWNLOADS,
    '[DOWNLOAD-WATCHER] File not auto-organized (low confidence or disabled)',
    () =>
      activity(
        'download',
        'download',
        'info',
        'Left a download in place (low confidence or auto-organize off)'
      )
  ),
  prefixRule(
    'download-held',
    DOWNLOADS,
    '[DOWNLOAD-WATCHER] Disk full; holding new download',
    (input) => {
      const file = baseName(input.data?.filePath);
      return activity(
        'storage',
        'hard-drive',
        'warn',
        `Holding download ${orAFile(file)} until the disk has room`,
        file
      );
    }
  ),
  prefixRule(
    'download-resumed',
    DOWNLOADS,
    '[DOWNLOAD-WATCHER] Disk has room again; processing held downloads',
    () =>
      activity('storage', 'download', 'success', 'Disk has room again; processing held downloads')
  ),
  prefixRule('search-building', SEARCH, '[SearchService] Building BM25 index...', () =>
    activity('search-index', 'search', 'info', 'Building search index')
  ),
  patternRule(
    'search-built',
    SEARCH,
    /^\[SearchService\] BM25 index built with (\d+) documents/,
    (_i, m) =>
      activity(
        'search-index',
        'search',
        'success',
        `Search index built (${plural(Number(m[1]), 'document')})`
      )
  ),
  prefixRule(
    'knowledge-repair',
    ['KnowledgeRepair'],
    'Startup knowledge repair complete',
    (input) => {
      const restored = count(input.data?.restored);
      const embedded = count(input.data?.embedded);
      const passages = count(input.data?.passages);
      const failed = count(input.data?.failed);
      const line = `Knowledge repair: ${restored} restored, ${embedded} embedded, ${passages} passages${
        failed > 0 ? `, ${failed} failed` : ''
      }`;
      return activity('knowledge-repair', 'wrench', failed > 0 ? 'warn' : 'success', line);
    }
  )
];

/**
 * @param {ActivityInput | null | undefined} record
 * @returns {LiveActivity | null}
 */
function activityFromLogRecord(record) {
  if (!record || typeof record.msg !== 'string') return null;
  const context = typeof record.context === 'string' ? record.context : '';
  for (const rule of RULES) {
    if (rule.contexts && !rule.contexts.includes(context)) continue;
    // Non-global patterns: String#match returns the same groups as RegExp exec.
    const match = record.msg.match(rule.pattern);
    if (!match) continue;
    /** @type {LiveActivity | null} */
    let result = null;
    try {
      result = rule.build(record, match);
    } catch {
      result = null;
    }
    if (result) return result;
  }
  if (PROBLEM_LEVELS.has(record.level)) {
    return activity(
      'problem',
      'alert',
      record.level === 'warn' ? 'warn' : 'error',
      `Problem: ${stripLeadingTag(record.msg)}`
    );
  }
  return null;
}

const ACTIVITY_RULE_IDS = RULES.map((rule) => rule.id);

module.exports = { activityFromLogRecord, ACTIVITY_RULE_IDS };
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/main/services/liveLogActivity.test.js`

Expected: PASS (all table rows + edge cases).

- [ ] **Step 5: Commit**

```bash
git add src/main/services/liveLogActivity.js test/main/services/liveLogActivity.test.js
git commit -m "feat(live-activity): classify sanitized log records into activity lines"
```

---

## Task 3: `liveLogFeed` service (ring buffer, batching, subscribers)

**Files:**

- Create: `src/main/services/liveLogFeed.js`
- Test: `test/main/services/liveLogFeed.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `test/main/services/liveLogFeed.test.js`:

```js
/**
 * liveLogFeed: the main-process side of the Live Activity panel. It listens
 * to the logger only while a window is subscribed, keeps a bounded backlog,
 * and pushes small batches on a 250 ms cadence.
 */
const { EventEmitter } = require('events');
const {
  createLiveLogFeed,
  getLiveLogFeed,
  RING_CAPACITY,
  FLUSH_INTERVAL_MS,
  MAX_BATCH_ENTRIES,
  MAX_MSG_CHARS
} = require('../../../src/main/services/liveLogFeed');

function makeRegistry() {
  const listeners = new Set();
  return {
    listeners,
    addListener: jest.fn((fn) => listeners.add(fn)),
    removeListener: jest.fn((fn) => listeners.delete(fn)),
    emit(record) {
      for (const fn of [...listeners]) fn(record);
    }
  };
}

function makeWebContents() {
  const wc = new EventEmitter();
  wc.destroyed = false;
  wc.send = jest.fn();
  wc.isDestroyed = () => wc.destroyed;
  return wc;
}

function record(n, overrides = {}) {
  return {
    time: '2026-11-05T09:00:00.000Z',
    level: 'info',
    context: 'Test',
    msg: `message ${n}`,
    data: undefined,
    ...overrides
  };
}

function makeFeed(overrides = {}) {
  const registry = makeRegistry();
  const send = jest.fn();
  const classify = jest.fn(() => null);
  const feed = createLiveLogFeed({
    addListener: registry.addListener,
    removeListener: registry.removeListener,
    classify,
    send,
    ...overrides
  });
  return { feed, registry, send, classify };
}

const IDLE = { subscribers: 0, listening: false, buffered: 0, pending: 0, timerActive: false };

describe('liveLogFeed', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('registers no logger listener and no timer while nobody is subscribed', () => {
    const { feed, registry } = makeFeed();
    expect(registry.addListener).not.toHaveBeenCalled();
    expect(feed.getStats()).toEqual(IDLE);
  });

  test('the first subscriber registers the listener once and gets an empty backlog', () => {
    const { feed, registry } = makeFeed();
    const wc = makeWebContents();

    expect(feed.subscribe(wc)).toEqual({ entries: [] });
    expect(feed.subscribe(wc)).toEqual({ entries: [] });

    expect(registry.addListener).toHaveBeenCalledTimes(1);
    expect(feed.getStats()).toEqual({ ...IDLE, subscribers: 1, listening: true });
  });

  test('a subscriber without a send method is refused', () => {
    const { feed, registry } = makeFeed();
    expect(feed.subscribe(null)).toEqual({ entries: [] });
    expect(feed.subscribe({})).toEqual({ entries: [] });
    expect(registry.addListener).not.toHaveBeenCalled();
  });

  test('a later subscriber receives the backlog with ids and classified activity', () => {
    const classify = jest.fn((r) =>
      r.msg === 'message 2' ? { kind: 'k', icon: 'i', tone: 'info', text: 'two' } : null
    );
    const { feed, registry } = makeFeed({ classify });
    feed.subscribe(makeWebContents());

    registry.emit(record(1, { data: { count: 3 } }));
    registry.emit(record(2));

    expect(feed.subscribe(makeWebContents()).entries).toEqual([
      {
        id: 1,
        time: '2026-11-05T09:00:00.000Z',
        level: 'info',
        context: 'Test',
        msg: 'message 1',
        dataText: '{"count":3}',
        activity: null
      },
      {
        id: 2,
        time: '2026-11-05T09:00:00.000Z',
        level: 'info',
        context: 'Test',
        msg: 'message 2',
        dataText: '',
        activity: { kind: 'k', icon: 'i', tone: 'info', text: 'two' }
      }
    ]);
  });

  test('sends one batch per 250 ms window to every subscriber, then idles', () => {
    const { feed, registry, send } = makeFeed();
    const a = makeWebContents();
    const b = makeWebContents();
    feed.subscribe(a);
    feed.subscribe(b);

    registry.emit(record(1));
    registry.emit(record(2));
    registry.emit(record(3));

    jest.advanceTimersByTime(FLUSH_INTERVAL_MS - 1);
    expect(send).not.toHaveBeenCalled();

    jest.advanceTimersByTime(1);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0][0]).toBe(a);
    expect(send.mock.calls[1][0]).toBe(b);
    const payload = send.mock.calls[0][1];
    expect(payload.dropped).toBe(0);
    expect(payload.entries.map((e) => e.id)).toEqual([1, 2, 3]);

    jest.advanceTimersByTime(FLUSH_INTERVAL_MS * 4);
    expect(send).toHaveBeenCalledTimes(2);
    expect(feed.getStats().timerActive).toBe(false);
  });

  test('caps a batch at 200 entries, dropping the oldest and counting them', () => {
    const { feed, registry, send } = makeFeed();
    feed.subscribe(makeWebContents());

    for (let i = 1; i <= MAX_BATCH_ENTRIES + 50; i += 1) registry.emit(record(i));
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);

    const payload = send.mock.calls[0][1];
    expect(payload.entries).toHaveLength(MAX_BATCH_ENTRIES);
    expect(payload.entries[0].id).toBe(51);
    expect(payload.entries[MAX_BATCH_ENTRIES - 1].id).toBe(250);
    expect(payload.dropped).toBe(50);
  });

  test('keeps only the last 500 entries for the backlog', () => {
    const { feed, registry } = makeFeed();
    feed.subscribe(makeWebContents());

    for (let i = 1; i <= RING_CAPACITY + 100; i += 1) {
      registry.emit(record(i));
      if (i % 100 === 0) jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
    }

    const { entries } = feed.subscribe(makeWebContents());
    expect(entries).toHaveLength(RING_CAPACITY);
    expect(entries[0].id).toBe(101);
    expect(entries[RING_CAPACITY - 1].id).toBe(RING_CAPACITY + 100);
  });

  test('drops a subscriber when its webContents is destroyed', () => {
    const { feed, registry, send } = makeFeed();
    const wc = makeWebContents();
    feed.subscribe(wc);
    registry.emit(record(1));

    wc.destroyed = true;
    wc.emit('destroyed');

    expect(feed.getStats()).toEqual(IDLE);
    expect(registry.removeListener).toHaveBeenCalledTimes(1);
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);
    expect(send).not.toHaveBeenCalled();
  });

  test('removes the listener and clears buffers only on the last unsubscribe', () => {
    const { feed, registry } = makeFeed();
    const a = makeWebContents();
    const b = makeWebContents();
    feed.subscribe(a);
    feed.subscribe(b);
    registry.emit(record(1));

    feed.unsubscribe(a);
    expect(registry.removeListener).not.toHaveBeenCalled();
    expect(feed.getStats().listening).toBe(true);

    feed.unsubscribe(b);
    expect(registry.removeListener).toHaveBeenCalledTimes(1);
    expect(feed.getStats()).toEqual(IDLE);
    expect(b.listenerCount('destroyed')).toBe(0);

    expect(feed.subscribe(makeWebContents()).entries).toEqual([]);
  });

  test('unsubscribing an unknown webContents is a no-op', () => {
    const { feed, registry } = makeFeed();
    feed.subscribe(makeWebContents());
    feed.unsubscribe(makeWebContents());
    feed.unsubscribe(null);
    expect(registry.removeListener).not.toHaveBeenCalled();
  });

  test('ignores records logged while a batch is being delivered (no feedback loop)', () => {
    const registry = makeRegistry();
    const send = jest.fn(() => registry.emit(record(99, { level: 'warn', msg: 'send failed' })));
    const feed = createLiveLogFeed({
      addListener: registry.addListener,
      removeListener: registry.removeListener,
      classify: () => null,
      send
    });
    feed.subscribe(makeWebContents());

    registry.emit(record(1));
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);

    expect(send).toHaveBeenCalledTimes(1);
    expect(feed.getStats().pending).toBe(0);
    expect(feed.getStats().buffered).toBe(1);
    expect(feed.getStats().timerActive).toBe(false);
  });

  test('a failing send never throws and still reaches the other subscribers', () => {
    const send = jest.fn((wc) => {
      if (wc.tag === 'bad') throw new Error('send failed');
    });
    const { feed, registry } = makeFeed({ send });
    const bad = makeWebContents();
    bad.tag = 'bad';
    const good = makeWebContents();
    feed.subscribe(bad);
    feed.subscribe(good);

    registry.emit(record(1));
    expect(() => jest.advanceTimersByTime(FLUSH_INTERVAL_MS)).not.toThrow();

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[1][0]).toBe(good);
  });

  test('a webContents found destroyed at flush time is skipped and dropped', () => {
    const { feed, registry, send } = makeFeed();
    const gone = makeWebContents();
    const alive = makeWebContents();
    feed.subscribe(gone);
    feed.subscribe(alive);
    registry.emit(record(1));

    gone.destroyed = true;
    jest.advanceTimersByTime(FLUSH_INTERVAL_MS);

    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0][0]).toBe(alive);
    expect(feed.getStats().subscribers).toBe(1);
  });

  test('normalizes entries: unknown level, long message, unserializable data, throwing classifier', () => {
    const { feed, registry } = makeFeed({
      classify: () => {
        throw new Error('bad rule');
      }
    });
    feed.subscribe(makeWebContents());
    const circular = {};
    circular.self = circular;

    registry.emit(
      record(1, { level: 'verbose', msg: 'x'.repeat(MAX_MSG_CHARS + 10), data: circular })
    );

    const [entry] = feed.subscribe(makeWebContents()).entries;
    expect(entry.level).toBe('info');
    expect(entry.msg).toHaveLength(MAX_MSG_CHARS);
    expect(entry.msg.endsWith('…')).toBe(true);
    expect(entry.dataText).toBe('[unserializable]');
    expect(entry.activity).toBeNull();
  });

  test('uses the real activity classifier by default', () => {
    const registry = makeRegistry();
    const feed = createLiveLogFeed({
      addListener: registry.addListener,
      removeListener: registry.removeListener,
      send: jest.fn()
    });
    feed.subscribe(makeWebContents());

    registry.emit(
      record(1, {
        context: 'SearchService',
        msg: '[SearchService] BM25 index built with 12 documents'
      })
    );

    const [entry] = feed.subscribe(makeWebContents()).entries;
    expect(entry.activity).toEqual({
      kind: 'search-index',
      icon: 'search',
      tone: 'success',
      text: 'Search index built (12 documents)'
    });
  });

  test('getLiveLogFeed is a singleton wired to the shared logger listener API', () => {
    // Under test-setup.js the logger module is test/mocks/logger.js, whose
    // addLiveRecordListener / removeLiveRecordListener are jest.fn() (Task 1).
    const loggerModule = require('../../../src/shared/logger');
    const feed = getLiveLogFeed();
    expect(getLiveLogFeed()).toBe(feed);

    const wc = makeWebContents();
    feed.subscribe(wc);
    expect(loggerModule.addLiveRecordListener).toHaveBeenCalledWith(expect.any(Function));

    feed.unsubscribe(wc);
    expect(loggerModule.removeLiveRecordListener).toHaveBeenCalledWith(
      loggerModule.addLiveRecordListener.mock.calls[0][0]
    );
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/main/services/liveLogFeed.test.js`

Expected: FAIL — `Cannot find module '../../../src/main/services/liveLogFeed'`.

- [ ] **Step 3: Implement the feed**

Create `src/main/services/liveLogFeed.js`:

```js
// @ts-check
/**
 * Live log feed: streams the logger's sanitized records to subscribed
 * renderer windows for the Live Activity panel.
 *
 * - The logger listener is registered only while at least one window is
 *   subscribed; with no subscriber there is no listener, buffer or timer.
 * - A ring buffer keeps the last RING_CAPACITY entries as the backlog a new
 *   subscriber receives. It is cleared on the last unsubscribe.
 * - Entries are pushed in batches every FLUSH_INTERVAL_MS, at most
 *   MAX_BATCH_ENTRIES per batch (oldest dropped first, counted in `dropped`).
 * - A destroyed webContents unsubscribes itself.
 * - Records produced synchronously while a batch is being delivered (e.g.
 *   safeSend's own failure logs) are ignored, so a failing send cannot feed
 *   itself.
 * - Nothing here logs: this code runs inside the logger's listener path.
 */
const { IPC_CHANNELS } = require('../../shared/constants');
const { activityFromLogRecord } = require('./liveLogActivity');

const RING_CAPACITY = 500;
const FLUSH_INTERVAL_MS = 250;
const MAX_BATCH_ENTRIES = 200;
const MAX_MSG_CHARS = 2000;
const MAX_DATA_TEXT_CHARS = 4000;
const MAX_CONTEXT_CHARS = 120;
const LEVELS = new Set(['trace', 'debug', 'info', 'warn', 'error', 'fatal']);

/**
 * @typedef {import('../../shared/logger').LiveLogRecord} LiveLogRecord
 * @typedef {import('./liveLogActivity').LiveActivity} LiveActivity
 * @typedef {{ id: number, time: string, level: string, context: string, msg: string, dataText: string, activity: LiveActivity | null }} LiveLogEntry
 * @typedef {{ entries: LiveLogEntry[], dropped: number }} LiveLogBatch
 * @typedef {(record: LiveLogRecord) => void} RecordListener
 * @typedef {object} LiveLogFeedDeps
 * @property {(listener: RecordListener) => void} [addListener]
 * @property {(listener: RecordListener) => void} [removeListener]
 * @property {(record: LiveLogRecord) => (LiveActivity | null)} [classify]
 * @property {(webContents: any, payload: LiveLogBatch) => unknown} [send]
 */

/**
 * @param {string} value
 * @param {number} max
 */
function truncate(value, max) {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** @param {unknown} data */
function stringifyData(data) {
  if (data === undefined || data === null) return '';
  try {
    const serialized = JSON.stringify(data);
    return typeof serialized === 'string' ? truncate(serialized, MAX_DATA_TEXT_CHARS) : '';
  } catch {
    return '[unserializable]';
  }
}

/**
 * @param {any} webContents
 * @param {LiveLogBatch} payload
 */
function defaultSend(webContents, payload) {
  // Lazy: ipcWrappers pulls in the IPC stack; only needed once a batch ships.
  const { safeSend } = require('../ipc/ipcWrappers');
  return safeSend(webContents, IPC_CHANNELS.SYSTEM.LIVE_LOG_BATCH, payload);
}

/**
 * @param {LiveLogFeedDeps} [deps]
 */
function createLiveLogFeed(deps = {}) {
  const addListener = typeof deps.addListener === 'function' ? deps.addListener : () => {};
  const removeListener =
    typeof deps.removeListener === 'function' ? deps.removeListener : () => {};
  const classify = typeof deps.classify === 'function' ? deps.classify : activityFromLogRecord;
  const send = typeof deps.send === 'function' ? deps.send : defaultSend;

  /** @type {Map<any, () => void>} */
  const subscribers = new Map();
  /** @type {LiveLogEntry[]} */
  let ring = [];
  /** @type {LiveLogEntry[]} */
  let pending = [];
  let dropped = 0;
  let seq = 0;
  let listening = false;
  let delivering = false;
  /** @type {any} */
  let timer = null;

  /**
   * @param {LiveLogRecord} record
   * @returns {LiveLogEntry}
   */
  function toEntry(record) {
    const level = LEVELS.has(record.level) ? record.level : 'info';
    const msg = truncate(
      typeof record.msg === 'string' ? record.msg : String(record.msg ?? ''),
      MAX_MSG_CHARS
    );
    const context = truncate(
      typeof record.context === 'string' ? record.context : '',
      MAX_CONTEXT_CHARS
    );
    /** @type {LiveActivity | null} */
    let activity = null;
    try {
      activity = classify({ ...record, level, msg, context }) || null;
    } catch {
      activity = null;
    }
    return {
      id: ++seq,
      time: typeof record.time === 'string' ? record.time : new Date().toISOString(),
      level,
      context,
      msg,
      dataText: stringifyData(record.data),
      activity
    };
  }

  /** @type {RecordListener} */
  function onRecord(record) {
    if (delivering || subscribers.size === 0 || !record) return;
    const entry = toEntry(record);
    ring.push(entry);
    if (ring.length > RING_CAPACITY) ring.shift();
    pending.push(entry);
    if (pending.length > MAX_BATCH_ENTRIES) {
      pending.shift();
      dropped += 1;
    }
    if (!timer) {
      timer = setTimeout(flush, FLUSH_INTERVAL_MS);
      if (timer && typeof timer.unref === 'function') timer.unref();
    }
  }

  function flush() {
    timer = null;
    if (pending.length === 0 && dropped === 0) return;
    /** @type {LiveLogBatch} */
    const payload = { entries: pending, dropped };
    pending = [];
    dropped = 0;
    delivering = true;
    try {
      for (const webContents of [...subscribers.keys()]) {
        if (typeof webContents.isDestroyed === 'function' && webContents.isDestroyed()) {
          unsubscribe(webContents);
          continue;
        }
        try {
          send(webContents, payload);
        } catch {
          // A failed send never affects logging or the other subscribers.
        }
      }
    } finally {
      delivering = false;
    }
  }

  /**
   * @param {any} webContents
   * @returns {{ entries: LiveLogEntry[] }}
   */
  function subscribe(webContents) {
    if (!webContents || typeof webContents.send !== 'function') return { entries: [] };
    if (!subscribers.has(webContents)) {
      const onDestroyed = () => unsubscribe(webContents);
      subscribers.set(webContents, onDestroyed);
      if (typeof webContents.once === 'function') webContents.once('destroyed', onDestroyed);
    }
    if (!listening) {
      addListener(onRecord);
      listening = true;
    }
    return { entries: ring.slice() };
  }

  /** @param {any} webContents */
  function unsubscribe(webContents) {
    const onDestroyed = subscribers.get(webContents);
    if (!onDestroyed) return;
    subscribers.delete(webContents);
    if (typeof webContents.removeListener === 'function') {
      try {
        webContents.removeListener('destroyed', onDestroyed);
      } catch {
        // A webContents mid-teardown may refuse; the subscriber is gone either way.
      }
    }
    if (subscribers.size === 0) {
      if (listening) {
        removeListener(onRecord);
        listening = false;
      }
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      ring = [];
      pending = [];
      dropped = 0;
    }
  }

  function getStats() {
    return {
      subscribers: subscribers.size,
      listening,
      buffered: ring.length,
      pending: pending.length,
      timerActive: timer !== null
    };
  }

  return { subscribe, unsubscribe, flush, getStats };
}

/** @type {ReturnType<typeof createLiveLogFeed> | null} */
let instance = null;

/** The process-wide feed, wired to the shared logger's listener API. */
function getLiveLogFeed() {
  if (!instance) {
    const loggerModule = require('../../shared/logger');
    instance = createLiveLogFeed({
      addListener: loggerModule.addLiveRecordListener,
      removeListener: loggerModule.removeLiveRecordListener
    });
  }
  return instance;
}

module.exports = {
  createLiveLogFeed,
  getLiveLogFeed,
  RING_CAPACITY,
  FLUSH_INTERVAL_MS,
  MAX_BATCH_ENTRIES,
  MAX_MSG_CHARS,
  MAX_DATA_TEXT_CHARS
};
```

Note: `IPC_CHANNELS.SYSTEM.LIVE_LOG_BATCH` is added in Task 4. Until then `defaultSend` is never
called by these tests (they inject `send`), so this task's suite passes on its own.

- [ ] **Step 4: Run the test and confirm it passes**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/main/services/liveLogFeed.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/services/liveLogFeed.js test/main/services/liveLogFeed.test.js
git commit -m "feat(live-activity): main-process log feed with backlog and batched delivery"
```

---

## Task 4: IPC channels, event-only membership, preload channel block

**Files:**

- Modify: `src/shared/constants.js` (`IPC_CHANNELS.SYSTEM`, ~lines 138–156)
- Modify: `src/shared/ipcEnforcement.js` (`EVENT_ONLY_CHANNEL_REFS`, ~lines 51–60)
- Modify: `scripts/verify-ipc-handlers.js` (`KNOWN_EVENT_ONLY_CHANNELS`, ~lines 40–60)
- Modify: `src/preload/preload.js` (generated `IPC_CHANNELS` block, via script)
- Modify: `test/ipcEnforcement.test.js` (count pin, ~line 125)
- Test: `test/liveLogChannels.test.js` (create)

- [ ] **Step 1: Write the failing tests**

Create `test/liveLogChannels.test.js`:

```js
/**
 * Live Activity IPC channel wiring: two invoke channels (subscribe /
 * unsubscribe) and one push-only batch channel, registered everywhere the
 * IPC verify scripts and the preload allowlists look. (The receive-allowlist
 * assertion is added in Task 7, together with the preload safeOn bridge,
 * because securityConfig.test.js requires every allowed receive channel to
 * have a preload consumer.)
 */
const fs = jest.requireActual('fs');
const path = require('path');
const { IPC_CHANNELS } = require('../src/shared/constants');
const { EVENT_ONLY_CHANNELS } = require('../src/shared/ipcEnforcement');

describe('live log IPC channels', () => {
  test('are defined in the SYSTEM group', () => {
    expect(IPC_CHANNELS.SYSTEM.LIVE_LOG_SUBSCRIBE).toBe('system:live-log:subscribe');
    expect(IPC_CHANNELS.SYSTEM.LIVE_LOG_UNSUBSCRIBE).toBe('system:live-log:unsubscribe');
    expect(IPC_CHANNELS.SYSTEM.LIVE_LOG_BATCH).toBe('system:live-log:batch');
  });

  test('the batch channel is push-only; the invoke channels are not', () => {
    expect(EVENT_ONLY_CHANNELS.has('system:live-log:batch')).toBe(true);
    expect(EVENT_ONLY_CHANNELS.has('system:live-log:subscribe')).toBe(false);
    expect(EVENT_ONLY_CHANNELS.has('system:live-log:unsubscribe')).toBe(false);
  });

  test('the generated preload channel block carries all three channels', () => {
    const preload = fs.readFileSync(path.join(__dirname, '../src/preload/preload.js'), 'utf8');
    expect(preload).toContain("LIVE_LOG_SUBSCRIBE: 'system:live-log:subscribe'");
    expect(preload).toContain("LIVE_LOG_UNSUBSCRIBE: 'system:live-log:unsubscribe'");
    expect(preload).toContain("LIVE_LOG_BATCH: 'system:live-log:batch'");
  });

  test('verify-ipc-handlers knows the batch channel has no invoke handler', () => {
    const script = fs.readFileSync(
      path.join(__dirname, '../scripts/verify-ipc-handlers.js'),
      'utf8'
    );
    expect(script).toContain("'SYSTEM.LIVE_LOG_BATCH'");
  });
});
```

In `test/ipcEnforcement.test.js`, replace:

```js
    test('EVENT_ONLY_CHANNELS has 8 entries', () => {
      expect(ipcEnforcement.EVENT_ONLY_CHANNELS.size).toBe(8);
    });
```

with:

```js
    // Grew to 9 with SYSTEM.LIVE_LOG_BATCH (Live Activity panel push channel).
    test('EVENT_ONLY_CHANNELS has 9 entries', () => {
      expect(ipcEnforcement.EVENT_ONLY_CHANNELS.size).toBe(9);
    });
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/liveLogChannels.test.js test/ipcEnforcement.test.js`

Expected: FAIL — `LIVE_LOG_SUBSCRIBE` is `undefined`, and `EVENT_ONLY_CHANNELS has 9 entries`
receives `8`.

- [ ] **Step 3: Implement the channel wiring**

In `src/shared/constants.js`, replace:

```js
    GET_LEGAL_NOTICES: 'system:get-legal-notices',
    OPEN_LEGAL_DOCUMENT: 'system:open-legal-document'
  },
  WINDOW: {
```

with:

```js
    GET_LEGAL_NOTICES: 'system:get-legal-notices',
    OPEN_LEGAL_DOCUMENT: 'system:open-legal-document',
    // Live Activity panel: a window subscribes to stream sanitized log
    // entries; main pushes them in batches on LIVE_LOG_BATCH (event-only).
    LIVE_LOG_SUBSCRIBE: 'system:live-log:subscribe',
    LIVE_LOG_UNSUBSCRIBE: 'system:live-log:unsubscribe',
    LIVE_LOG_BATCH: 'system:live-log:batch'
  },
  WINDOW: {
```

In `src/shared/ipcEnforcement.js`, replace:

```js
  'DOWNLOADS.TRIAGE_SCAN_PROGRESS',
  'DOWNLOADS.TRIAGE_SESSION_INVALIDATED'
];
```

with:

```js
  'DOWNLOADS.TRIAGE_SCAN_PROGRESS',
  'DOWNLOADS.TRIAGE_SESSION_INVALIDATED',
  // Live Activity panel log batches (main → subscribed window).
  'SYSTEM.LIVE_LOG_BATCH'
];
```

In `scripts/verify-ipc-handlers.js`, replace:

```js
  'DOWNLOADS.TRIAGE_SCAN_PROGRESS',
  'DOWNLOADS.TRIAGE_SESSION_INVALIDATED',
  // Fire-and-forget listener registered in simple-main.js via ipcMain.on() (not in src/main/ipc/)
```

with:

```js
  'DOWNLOADS.TRIAGE_SCAN_PROGRESS',
  'DOWNLOADS.TRIAGE_SESSION_INVALIDATED',
  // Live Activity panel log batches, pushed by src/main/services/liveLogFeed.js
  // via safeSend to windows that invoked SYSTEM.LIVE_LOG_SUBSCRIBE.
  'SYSTEM.LIVE_LOG_BATCH',
  // Fire-and-forget listener registered in simple-main.js via ipcMain.on() (not in src/main/ipc/)
```

Regenerate the preload channel block (rewrites `src/preload/preload.js` between the
`// === START GENERATED IPC_CHANNELS ===` and `// === END GENERATED IPC_CHANNELS ===` markers):

Run: `fnm exec --using=24.22.1 -- npm.cmd run generate:channels:update`

Then confirm the block is in sync:

Run: `fnm exec --using=24.22.1 -- npm.cmd run generate:channels:check`

Expected: exit 0.

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/liveLogChannels.test.js test/ipcEnforcement.test.js test/securityConfig.test.js test/preload.contract.test.js`

Expected: PASS. (Do NOT run `verify:ipc-handlers` yet: `LIVE_LOG_SUBSCRIBE` / `UNSUBSCRIBE` get
their handlers in Task 6.)

- [ ] **Step 5: Commit**

```bash
git add src/shared/constants.js src/shared/ipcEnforcement.js scripts/verify-ipc-handlers.js src/preload/preload.js test/ipcEnforcement.test.js test/liveLogChannels.test.js
git commit -m "feat(ipc): live log subscribe/unsubscribe channels and event-only batch channel"
```

---

## Task 5: Event schema for `system:live-log:batch`

**Files:**

- Modify: `src/shared/ipcEventSchemas.js` (schemas IIFE just before its `return {` ~line 468; the
  returned list ~line 494; `EVENT_SCHEMAS` ~line 531)
- Test: `test/ipcEventSchemas.liveLog.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `test/ipcEventSchemas.liveLog.test.js`:

```js
/**
 * Payload schema for the Live Activity batch push. safeSend validates every
 * push against it (strict by default), so it must accept what liveLogFeed
 * produces and bound everything else.
 */
const { IPC_CHANNELS } = require('../src/shared/constants');
const { validateEventPayload, hasEventSchema } = require('../src/shared/ipcEventSchemas');

const CHANNEL = IPC_CHANNELS.SYSTEM.LIVE_LOG_BATCH;

function entry(overrides = {}) {
  return {
    id: 1,
    time: '2026-11-05T09:00:00.000Z',
    level: 'info',
    context: 'SearchService',
    msg: '[SearchService] BM25 index built with 12 documents',
    dataText: '',
    activity: {
      kind: 'search-index',
      icon: 'search',
      tone: 'success',
      text: 'Search index built (12 documents)'
    },
    ...overrides
  };
}

describe('system:live-log:batch event schema', () => {
  test('is registered so safeSend validates every batch', () => {
    expect(hasEventSchema(CHANNEL)).toBe(true);
  });

  test('accepts entries with and without activity', () => {
    const result = validateEventPayload(CHANNEL, {
      entries: [
        entry(),
        entry({ id: 2, activity: null, dataText: '{"a":1}' }),
        entry({
          id: 3,
          activity: {
            kind: 'analyze',
            icon: 'analyze',
            tone: 'info',
            text: 'Analyzing a.pdf',
            file: 'a.pdf'
          }
        })
      ],
      dropped: 0
    });
    expect(result.valid).toBe(true);
  });

  test('accepts an empty batch that only reports dropped entries', () => {
    expect(validateEventPayload(CHANNEL, { entries: [], dropped: 12 }).valid).toBe(true);
  });

  test('rejects more than 200 entries in one batch', () => {
    const entries = Array.from({ length: 201 }, (_, i) => entry({ id: i + 1 }));
    expect(validateEventPayload(CHANNEL, { entries, dropped: 0 }).valid).toBe(false);
  });

  test('rejects an unknown level', () => {
    expect(
      validateEventPayload(CHANNEL, { entries: [entry({ level: 'verbose' })], dropped: 0 }).valid
    ).toBe(false);
  });

  test('rejects an unknown activity tone', () => {
    const bad = entry({ activity: { kind: 'x', icon: 'y', tone: 'loud', text: 'z' } });
    expect(validateEventPayload(CHANNEL, { entries: [bad], dropped: 0 }).valid).toBe(false);
  });

  test('rejects a negative dropped count', () => {
    expect(validateEventPayload(CHANNEL, { entries: [], dropped: -1 }).valid).toBe(false);
  });

  test('rejects a message longer than 2000 characters', () => {
    expect(
      validateEventPayload(CHANNEL, { entries: [entry({ msg: 'x'.repeat(2001) })], dropped: 0 })
        .valid
    ).toBe(false);
  });

  test('rejects dataText longer than 4000 characters', () => {
    expect(
      validateEventPayload(CHANNEL, {
        entries: [entry({ dataText: 'x'.repeat(4001) })],
        dropped: 0
      }).valid
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/ipcEventSchemas.liveLog.test.js`

Expected: FAIL — `is registered so safeSend validates every batch` receives `false`.

- [ ] **Step 3: Add the schema**

In `src/shared/ipcEventSchemas.js`, replace:

```js
        .passthrough();

      return {
        operationProgressSchema,
```

with:

```js
        .passthrough();

      /**
       * Live Activity panel batch (src/main/services/liveLogFeed.js).
       * Bounds mirror the feed's own caps: 200 entries per batch, message
       * 2000 chars, data text 4000 chars, context 120 chars.
       */
      const liveLogActivitySchema = z.object({
        kind: z.string().max(64),
        icon: z.string().max(32),
        text: z.string().max(500),
        file: z.string().max(260).optional(),
        tone: z.enum(['info', 'success', 'warn', 'error'])
      });

      const liveLogEntrySchema = z.object({
        id: z.number().int().nonnegative(),
        time: z.string().max(40),
        level: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']),
        context: z.string().max(120),
        msg: z.string().max(2000),
        dataText: z.string().max(4000),
        activity: liveLogActivitySchema.nullable()
      });

      const liveLogBatchSchema = z.object({
        entries: z.array(liveLogEntrySchema).max(200),
        dropped: z.number().int().nonnegative()
      });

      return {
        operationProgressSchema,
```

Replace:

```js
        mcpStatusChangedSchema,
        aiProviderStatusChangedSchema
      };
```

with:

```js
        mcpStatusChangedSchema,
        aiProviderStatusChangedSchema,
        liveLogBatchSchema
      };
```

Replace:

```js
      ...(IPC_CHANNELS.AI_PROVIDER?.STATUS_CHANGED
        ? {
            [IPC_CHANNELS.AI_PROVIDER.STATUS_CHANGED]: schemas.aiProviderStatusChangedSchema
          }
        : {})
    }
  : {};
```

with:

```js
      ...(IPC_CHANNELS.AI_PROVIDER?.STATUS_CHANGED
        ? {
            [IPC_CHANNELS.AI_PROVIDER.STATUS_CHANGED]: schemas.aiProviderStatusChangedSchema
          }
        : {}),
      ...(IPC_CHANNELS.SYSTEM?.LIVE_LOG_BATCH
        ? { [IPC_CHANNELS.SYSTEM.LIVE_LOG_BATCH]: schemas.liveLogBatchSchema }
        : {})
    }
  : {};
```

- [ ] **Step 4: Run the tests and the event-schema verifier**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/ipcEventSchemas.liveLog.test.js test/ipcEventSchemas.test.js`

Expected: PASS.

Run: `fnm exec --using=24.22.1 -- npm.cmd run verify:ipc-event-schemas`

Expected: exit 0 (the `safeSend(webContents, IPC_CHANNELS.SYSTEM.LIVE_LOG_BATCH, payload)` call in
`liveLogFeed.js` now resolves to a channel with a schema).

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipcEventSchemas.js test/ipcEventSchemas.liveLog.test.js
git commit -m "feat(ipc): event schema for live log batches"
```

---

## Task 6: Subscribe/unsubscribe handlers in `system.js`

**Files:**

- Modify: `src/main/ipc/system.js` (insert before the `IPC_CHANNELS.SYSTEM.APPLY_UPDATE` handler,
  ~line 429)
- Test: `test/systemIpc.liveLog.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `test/systemIpc.liveLog.test.js`:

```js
/**
 * Live Activity invoke handlers: subscribe streams to the calling window and
 * returns the backlog; unsubscribe stops it. Both target event.sender.
 */
jest.mock('../src/main/ipc/ipcWrappers', () => ({
  createHandler: jest.fn(({ handler }) => handler),
  createErrorResponse: jest.fn((error) => ({
    success: false,
    error: error.message || String(error)
  })),
  canceledResponse: jest.fn(() => ({ success: false, canceled: true })),
  safeHandle: (ipcMain, channel, handler) => {
    ipcMain.handle(channel, handler);
  }
}));

jest.mock('../src/main/services/DegradedStateTracker', () => ({
  getInstance: () => ({ raise: jest.fn(), clear: jest.fn(), list: jest.fn(() => []) })
}));

jest.mock('../src/main/core/autoUpdater', () => ({
  quitAndInstall: jest.fn(),
  checkForUpdates: jest.fn()
}));

jest.mock('../src/shared/config/index', () => ({
  dump: jest.fn().mockReturnValue({ config: {}, metadata: {} }),
  validate: jest.fn().mockReturnValue({ valid: true, errors: [], warnings: [] }),
  get: jest.fn()
}));

const mockFeed = { subscribe: jest.fn(), unsubscribe: jest.fn() };
jest.mock('../src/main/services/liveLogFeed', () => ({
  getLiveLogFeed: () => mockFeed
}));

describe('system live log handlers', () => {
  const { IPC_CHANNELS } = require('../src/shared/constants');
  let handlers;
  let mockIpcMain;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    handlers = {};
    mockIpcMain = {
      handle: jest.fn((channel, handler) => {
        handlers[channel] = handler;
      })
    };
    const registerSystemIpc = require('../src/main/ipc/system');
    registerSystemIpc({
      ipcMain: mockIpcMain,
      IPC_CHANNELS,
      logger: { info: jest.fn(), debug: jest.fn(), warn: jest.fn(), error: jest.fn() },
      systemAnalytics: { collectMetrics: jest.fn() },
      getServiceIntegration: () => ({})
    });
  });

  test('registers subscribe and unsubscribe, but no handler for the push-only batch channel', () => {
    expect(handlers[IPC_CHANNELS.SYSTEM.LIVE_LOG_SUBSCRIBE]).toEqual(expect.any(Function));
    expect(handlers[IPC_CHANNELS.SYSTEM.LIVE_LOG_UNSUBSCRIBE]).toEqual(expect.any(Function));
    expect(handlers[IPC_CHANNELS.SYSTEM.LIVE_LOG_BATCH]).toBeUndefined();
  });

  test('subscribe streams to the sender and returns the backlog', async () => {
    const sender = { id: 7, send: jest.fn() };
    mockFeed.subscribe.mockReturnValue({ entries: [{ id: 1 }, { id: 2 }] });

    const result = await handlers[IPC_CHANNELS.SYSTEM.LIVE_LOG_SUBSCRIBE]({ sender });

    expect(mockFeed.subscribe).toHaveBeenCalledWith(sender);
    expect(result).toEqual({ success: true, entries: [{ id: 1 }, { id: 2 }] });
  });

  test('a failing subscribe returns an error response instead of throwing', async () => {
    mockFeed.subscribe.mockImplementation(() => {
      throw new Error('feed unavailable');
    });

    const result = await handlers[IPC_CHANNELS.SYSTEM.LIVE_LOG_SUBSCRIBE]({ sender: {} });

    expect(result).toEqual({ success: false, error: 'feed unavailable' });
  });

  test('unsubscribe stops streaming to the sender', async () => {
    const sender = { id: 7, send: jest.fn() };

    const result = await handlers[IPC_CHANNELS.SYSTEM.LIVE_LOG_UNSUBSCRIBE]({ sender });

    expect(mockFeed.unsubscribe).toHaveBeenCalledWith(sender);
    expect(result).toEqual({ success: true });
  });

  test('a failing unsubscribe returns an error response instead of throwing', async () => {
    mockFeed.unsubscribe.mockImplementation(() => {
      throw new Error('already gone');
    });

    const result = await handlers[IPC_CHANNELS.SYSTEM.LIVE_LOG_UNSUBSCRIBE]({ sender: {} });

    expect(result).toEqual({ success: false, error: 'already gone' });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/systemIpc.liveLog.test.js`

Expected: FAIL — the first test receives `undefined` for the subscribe handler.

- [ ] **Step 3: Add the handlers**

In `src/main/ipc/system.js`, replace:

```js
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SYSTEM.APPLY_UPDATE,
```

with:

```js
  // Live Activity panel. The feed streams to the calling window
  // (event.sender) until it unsubscribes or its webContents is destroyed.
  // Lazy require keeps the feed (and its logger listener) out of startup.
  safeHandle(
    ipcMain,
    IPC_CHANNELS.SYSTEM.LIVE_LOG_SUBSCRIBE,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      handler: async (/** @type {any} */ event) => {
        try {
          const { getLiveLogFeed } = require('../services/liveLogFeed');
          const { entries } = getLiveLogFeed().subscribe(event?.sender);
          return { success: true, entries };
        } catch (error) {
          return createErrorResponse(error);
        }
      }
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SYSTEM.LIVE_LOG_UNSUBSCRIBE,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      handler: async (/** @type {any} */ event) => {
        try {
          const { getLiveLogFeed } = require('../services/liveLogFeed');
          getLiveLogFeed().unsubscribe(event?.sender);
          return { success: true };
        } catch (error) {
          return createErrorResponse(error);
        }
      }
    })
  );

  safeHandle(
    ipcMain,
    IPC_CHANNELS.SYSTEM.APPLY_UPDATE,
```

- [ ] **Step 4: Run the tests and the handler verifiers**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/systemIpc.liveLog.test.js test/systemIpc.test.js`

Expected: PASS.

Run: `fnm exec --using=24.22.1 -- npm.cmd run verify:ipc-handlers`

Expected: exit 0 (subscribe/unsubscribe found in `system.js`; the batch channel is listed as
event-only).

Run: `fnm exec --using=24.22.1 -- npm.cmd run verify:ipc-handler-schemas`

Expected: exit 0 (both handlers carry `schemas?.ipcVoidPayload`, the same non-vacuous schema
`GET_DEGRADED_STATE` uses).

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/system.js test/systemIpc.liveLog.test.js
git commit -m "feat(ipc): system live log subscribe/unsubscribe handlers"
```

---

## Task 7: Preload bridges, receive allowlist and renderer `systemIpc` methods

**Files:**

- Modify: `src/preload/preload.js` (`system:` namespace, after `dismissDegradedFlag`, ~line 2148)
- Modify: `src/shared/securityConfig.js` (`ALLOWED_RECEIVE_CHANNELS`, ~lines 329–362)
- Modify: `src/renderer/services/ipc/systemIpc.js` (after `dismissDegradedFlag`)
- Modify: `test/preload.coverage.test.js` (new test before `test('trace bridges'`)
- Modify: `test/liveLogChannels.test.js` (receive-allowlist assertion)
- Test: `test/ipcServices.liveLog.test.js` (create)

- [ ] **Step 1: Write the failing tests**

In `test/preload.coverage.test.js`, replace:

```js
    test('trace bridges', () => {
```

with:

```js
    test('live log bridges (Live Activity panel)', async () => {
      await electronAPI.system.subscribeLiveLog();
      expect(mockInvoke).toHaveBeenCalledWith('system:live-log:subscribe', IPC_META_ENVELOPE);
      await electronAPI.system.unsubscribeLiveLog();
      expect(mockInvoke).toHaveBeenCalledWith('system:live-log:unsubscribe', IPC_META_ENVELOPE);
      const off = electronAPI.system.onLiveLogBatch(jest.fn());
      expect(typeof off).toBe('function');
      expect(mockOn).toHaveBeenCalledWith('system:live-log:batch', expect.any(Function));
    });

    test('trace bridges', () => {
```

In `test/liveLogChannels.test.js`, replace:

```js
  test('verify-ipc-handlers knows the batch channel has no invoke handler', () => {
```

with:

```js
  test('the renderer may receive the batch channel', () => {
    const { ALLOWED_RECEIVE_CHANNELS } = require('../src/shared/securityConfig');
    expect(ALLOWED_RECEIVE_CHANNELS).toContain('system:live-log:batch');
  });

  test('verify-ipc-handlers knows the batch channel has no invoke handler', () => {
```

Create `test/ipcServices.liveLog.test.js`:

```js
/**
 * Renderer service layer for the Live Activity feed (systemIpc).
 */
jest.mock('../src/renderer/services/ipc/electronApi', () => ({
  requireElectronAPI: jest.fn()
}));

const { requireElectronAPI } = require('../src/renderer/services/ipc/electronApi');
const { systemIpc } = require('../src/renderer/services/ipc/systemIpc');

describe('systemIpc live log methods', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('subscribeLiveLog returns the backlog entries', async () => {
    requireElectronAPI.mockReturnValue({
      system: {
        subscribeLiveLog: jest.fn().mockResolvedValue({ success: true, entries: [{ id: 1 }] })
      }
    });
    await expect(systemIpc.subscribeLiveLog()).resolves.toEqual({ entries: [{ id: 1 }] });
  });

  test('subscribeLiveLog tolerates a response without entries', async () => {
    requireElectronAPI.mockReturnValue({
      system: { subscribeLiveLog: jest.fn().mockResolvedValue({ success: true }) }
    });
    await expect(systemIpc.subscribeLiveLog()).resolves.toEqual({ entries: [] });
  });

  test('subscribeLiveLog throws on an error response', async () => {
    requireElectronAPI.mockReturnValue({
      system: {
        subscribeLiveLog: jest
          .fn()
          .mockResolvedValue({ success: false, error: 'handler missing' })
      }
    });
    await expect(systemIpc.subscribeLiveLog()).rejects.toThrow('handler missing');
  });

  test('subscribeLiveLog throws when the bridge is missing', async () => {
    requireElectronAPI.mockReturnValue({ system: {} });
    await expect(systemIpc.subscribeLiveLog()).rejects.toThrow(
      'Live activity is unavailable in this build'
    );
  });

  test('unsubscribeLiveLog calls the bridge, and is a no-op without it', async () => {
    const unsubscribeLiveLog = jest.fn().mockResolvedValue({ success: true });
    requireElectronAPI.mockReturnValue({ system: { unsubscribeLiveLog } });
    await expect(systemIpc.unsubscribeLiveLog()).resolves.toBeUndefined();
    expect(unsubscribeLiveLog).toHaveBeenCalledTimes(1);

    requireElectronAPI.mockReturnValue({ system: {} });
    await expect(systemIpc.unsubscribeLiveLog()).resolves.toBeUndefined();
  });

  test('onLiveLogBatch forwards the callback and returns the cleanup', () => {
    const cleanup = jest.fn();
    const onLiveLogBatch = jest.fn(() => cleanup);
    requireElectronAPI.mockReturnValue({ system: { onLiveLogBatch } });
    const callback = jest.fn();

    const off = systemIpc.onLiveLogBatch(callback);

    expect(onLiveLogBatch).toHaveBeenCalledWith(callback);
    off();
    expect(cleanup).toHaveBeenCalledTimes(1);
  });

  test('onLiveLogBatch returns a no-op cleanup without the bridge', () => {
    requireElectronAPI.mockReturnValue({ system: {} });
    const off = systemIpc.onLiveLogBatch(jest.fn());
    expect(() => off()).not.toThrow();
  });
});
```

- [ ] **Step 2: Run them and confirm they fail**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/ipcServices.liveLog.test.js test/preload.coverage.test.js test/liveLogChannels.test.js`

Expected: FAIL — `systemIpc.subscribeLiveLog is not a function`,
`electronAPI.system.subscribeLiveLog is not a function`, and the receive-allowlist test does not
find `system:live-log:batch`.

- [ ] **Step 3: Implement the bridges**

In `src/preload/preload.js`, replace:

```js
    dismissDegradedFlag: (/** @type {any} */ code) =>
      secureIPC.safeInvoke(IPC_CHANNELS.SYSTEM.DISMISS_DEGRADED_FLAG, { code }),
```

with:

```js
    dismissDegradedFlag: (/** @type {any} */ code) =>
      secureIPC.safeInvoke(IPC_CHANNELS.SYSTEM.DISMISS_DEGRADED_FLAG, { code }),
    // Live Activity panel: start/stop streaming sanitized log entries to this
    // window; batches arrive on onLiveLogBatch.
    subscribeLiveLog: () => secureIPC.safeInvoke(IPC_CHANNELS.SYSTEM.LIVE_LOG_SUBSCRIBE),
    unsubscribeLiveLog: () => secureIPC.safeInvoke(IPC_CHANNELS.SYSTEM.LIVE_LOG_UNSUBSCRIBE),
    onLiveLogBatch: (/** @type {any} */ callback) =>
      secureIPC.safeOn(IPC_CHANNELS.SYSTEM.LIVE_LOG_BATCH, callback),
```

In `src/shared/securityConfig.js`, replace:

```js
  IPC_CHANNELS.AI_PROVIDER?.STATUS_CHANGED,
  IPC_CHANNELS.MCP?.STATUS_CHANGED
].filter(Boolean);
```

with:

```js
  IPC_CHANNELS.AI_PROVIDER?.STATUS_CHANGED,
  IPC_CHANNELS.MCP?.STATUS_CHANGED,
  // Live Activity panel log batches (main → subscribed window).
  IPC_CHANNELS.SYSTEM?.LIVE_LOG_BATCH
].filter(Boolean);
```

In `src/renderer/services/ipc/systemIpc.js`, replace:

```js
    return api.dismissDegradedFlag(code);
  },
  async getMetrics() {
```

with:

```js
    return api.dismissDegradedFlag(code);
  },
  /** @returns {Promise<{ entries: any[] }>} */
  async subscribeLiveLog() {
    const api = requireElectronAPI().system;
    if (typeof api.subscribeLiveLog !== 'function') {
      throw new Error('Live activity is unavailable in this build');
    }
    const result = await api.subscribeLiveLog();
    if (result && typeof result === 'object' && result.success === false) {
      throw new Error(result.error || 'Failed to start live activity');
    }
    return { entries: Array.isArray(result?.entries) ? result.entries : [] };
  },
  /** @returns {Promise<void>} */
  async unsubscribeLiveLog() {
    const api = requireElectronAPI().system;
    if (typeof api.unsubscribeLiveLog !== 'function') return;
    await api.unsubscribeLiveLog();
  },
  /**
   * @param {(payload: any) => void} callback
   * @returns {() => void}
   */
  onLiveLogBatch(callback) {
    const api = requireElectronAPI().system;
    if (typeof api.onLiveLogBatch !== 'function') return () => {};
    const off = api.onLiveLogBatch(callback);
    return typeof off === 'function' ? off : () => {};
  },
  async getMetrics() {
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/ipcServices.liveLog.test.js test/preload.coverage.test.js test/liveLogChannels.test.js test/ipcServices.test.js test/securityConfig.test.js`

Expected: PASS. securityConfig.test.js checks both directions: the new
`safeOn(IPC_CHANNELS.SYSTEM.LIVE_LOG_BATCH, callback)` is in `ALLOWED_RECEIVE_CHANNELS`, and the new
allowlist entry has that preload consumer. (That is why the allowlist entry lands in this task and
not in Task 4.)

- [ ] **Step 5: Commit**

```bash
git add src/preload/preload.js src/shared/securityConfig.js src/renderer/services/ipc/systemIpc.js test/preload.coverage.test.js test/liveLogChannels.test.js test/ipcServices.liveLog.test.js
git commit -m "feat(preload): live log bridges and renderer systemIpc methods"
```

---

## Task 8: Register the `showLiveActivity` setting

**Files:**

- Modify: `src/shared/defaultSettings.js` (~line 161)
- Modify: `src/shared/securityConfig.js` (`allowedKeys`, ~line 264)
- Modify: `src/shared/settingsValidation.js` (~line 475)
- Modify: `src/main/ipc/validationSchemas.js` (`settingsSchema`, ~line 688)
- Test: `test/settings.showLiveActivity.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `test/settings.showLiveActivity.test.js`:

```js
/**
 * showLiveActivity: the on/off switch for the Live Activity panel, registered
 * on all four settings surfaces like other boolean settings
 * (test/settings-keyset-parity.test.js explains why all four must agree).
 */
const { DEFAULT_SETTINGS } = require('../src/shared/defaultSettings');
const { VALIDATION_RULES, validateSettings } = require('../src/shared/settingsValidation');
const { SETTINGS_VALIDATION } = require('../src/shared/securityConfig');
const { settingsSchema } = require('../src/main/ipc/validationSchemas');

describe('showLiveActivity setting', () => {
  test('defaults to off', () => {
    expect(DEFAULT_SETTINGS.showLiveActivity).toBe(false);
  });

  test('is on the settings import allowlist', () => {
    expect(new Set(SETTINGS_VALIDATION.allowedKeys).has('showLiveActivity')).toBe(true);
  });

  test('validates as an optional boolean', () => {
    expect(VALIDATION_RULES.showLiveActivity).toEqual({ type: 'boolean', required: false });
    expect(validateSettings({ showLiveActivity: true }).valid).toBe(true);
    expect(validateSettings({ showLiveActivity: false }).valid).toBe(true);
    expect(validateSettings({ showLiveActivity: 'yes' }).valid).toBe(false);
  });

  test('the settings:save schema accepts booleans and rejects strings', () => {
    expect(settingsSchema.safeParse({ showLiveActivity: true }).success).toBe(true);
    expect(settingsSchema.safeParse({ showLiveActivity: null }).success).toBe(true);
    expect(settingsSchema.safeParse({ showLiveActivity: 'yes' }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/settings.showLiveActivity.test.js`

Expected: FAIL — `defaults to off` receives `undefined`.

- [ ] **Step 3: Register the setting**

In `src/shared/defaultSettings.js`, replace:

```js
  captionVideoKeyframes: false,
  // Advanced-mode values parked
```

with:

```js
  captionVideoKeyframes: false,
  // Floating Live Activity panel (Settings → Diagnostics, Ctrl/Cmd+Shift+L).
  // Off by default: nothing is streamed from the logger while it is closed.
  showLiveActivity: false,
  // Advanced-mode values parked
```

In `src/shared/securityConfig.js`, replace:

```js
    'captionVideoKeyframes',
    // Advanced-mode values parked while Simple mode is on (internal-only)
```

with:

```js
    'captionVideoKeyframes',
    // Live Activity panel on/off (Settings → Diagnostics)
    'showLiveActivity',
    // Advanced-mode values parked while Simple mode is on (internal-only)
```

In `src/shared/settingsValidation.js`, replace:

```js
  captionVideoKeyframes: {
    type: 'boolean',
    required: false
  },
```

with:

```js
  captionVideoKeyframes: {
    type: 'boolean',
    required: false
  },
  // Live Activity panel on/off (Settings → Diagnostics, Ctrl/Cmd+Shift+L).
  showLiveActivity: {
    type: 'boolean',
    required: false
  },
```

In `src/main/ipc/validationSchemas.js`, replace:

```js
      captionVideoKeyframes: z.boolean().nullish(),
```

with:

```js
      captionVideoKeyframes: z.boolean().nullish(),
      // Live Activity panel on/off (Settings → Diagnostics)
      showLiveActivity: z.boolean().nullish(),
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/settings.showLiveActivity.test.js test/settings-keyset-parity.test.js test/settingsValidation.test.js test/defaultSettings.test.js test/securityConfig.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/shared/defaultSettings.js src/shared/securityConfig.js src/shared/settingsValidation.js src/main/ipc/validationSchemas.js test/settings.showLiveActivity.test.js
git commit -m "feat(settings): register showLiveActivity (default off)"
```

---

## Task 9: `--z-floating-panel` layer token and utility

**Files:**

- Modify: `src/renderer/styles.css` (Z-Index tokens ~lines 99–112; `@utility` block ~lines 2051–2062)
- Modify: `test/ux/zIndexLayering.test.js`

- [ ] **Step 1: Write the failing test**

In `test/ux/zIndexLayering.test.js`, replace:

```js
  test('page tooltips stay below modal scrims', () => {
    expect(token('--z-tooltip')).toBeLessThan(token('--z-modal'));
  });
```

with:

```js
  test('page tooltips stay below modal scrims', () => {
    expect(token('--z-tooltip')).toBeLessThan(token('--z-modal'));
  });

  test('the live activity panel floats above page overlays, below tooltips, modals and toasts', () => {
    expect(token('--z-floating-panel')).toBe(300);
    expect(token('--z-floating-panel')).toBeGreaterThan(token('--z-overlay'));
    expect(token('--z-floating-panel')).toBeLessThan(token('--z-tooltip'));
    expect(token('--z-floating-panel')).toBeLessThan(token('--z-modal'));
    expect(token('--z-floating-panel')).toBeLessThan(token('--z-toast'));
  });

  test('the floating-panel layer has its @utility class', () => {
    expect(css).toMatch(/@utility z-floating-panel\s*\{\s*z-index:\s*var\(--z-floating-panel\)/);
  });
```

and replace:

```js
      /className[^\n]*?\bz-(modal-consent|modal|toast|header|overlay|tooltip|skip-link)\b/;
```

with:

```js
      /className[^\n]*?\bz-(modal-consent|modal|toast|header|overlay|tooltip|skip-link|floating-panel)\b/;
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/ux/zIndexLayering.test.js`

Expected: FAIL — the `--z-floating-panel` token match is `null`.

- [ ] **Step 3: Add the token and utility**

In `src/renderer/styles.css`, replace:

```css
  --z-overlay: 200;
  /* Page tooltips sit below modal scrims (an open dialog should mask them). */
```

with:

```css
  --z-overlay: 200;
  /* Live Activity panel: floats above page content and overlays, below
     tooltips, modal dialogs and toasts. Guarded by test/ux/zIndexLayering. */
  --z-floating-panel: 300;
  /* Page tooltips sit below modal scrims (an open dialog should mask them). */
```

and replace:

```css
@utility z-overlay {
  z-index: var(--z-overlay);
}
```

with:

```css
@utility z-overlay {
  z-index: var(--z-overlay);
}
@utility z-floating-panel {
  z-index: var(--z-floating-panel);
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/ux/zIndexLayering.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/styles.css test/ux/zIndexLayering.test.js
git commit -m "feat(ui): floating-panel z-index layer for the Live Activity panel"
```

---

## Task 10: `setShowLiveActivity` / `toggleShowLiveActivity` thunks

**Files:**

- Create: `src/renderer/store/thunks/liveActivityThunks.js`
- Test: `test/liveActivityThunks.test.js` (create)

Why a thunk: the panel's Close button and the global shortcut must flip the setting from anywhere.
`settings:save` merges partial objects in `SettingsService.save`, so only the one key is sent. The
store is updated first so the panel reacts immediately; an open SettingsPanel adopts the new value
through its existing "Redux settings changed" effect (SettingsPanel.jsx ~line 673).

- [ ] **Step 1: Write the failing test**

Create `test/liveActivityThunks.test.js`:

```js
/**
 * Live Activity on/off thunks: optimistic store update, single-key save,
 * rollback when the save fails, and a toggle that reads the current value.
 */
jest.mock('../src/renderer/services/ipc', () => ({
  settingsIpc: { save: jest.fn() }
}));

jest.mock('../src/renderer/store/slices/uiSlice', () => ({
  updateSettings: jest.fn((payload) => ({ type: 'ui/updateSettings', payload }))
}));

const { settingsIpc } = require('../src/renderer/services/ipc');
const {
  setShowLiveActivity,
  toggleShowLiveActivity
} = require('../src/renderer/store/thunks/liveActivityThunks');

function makeStore(showLiveActivity) {
  const state = { ui: { settings: { showLiveActivity } } };
  const actions = [];
  const getState = () => state;
  const dispatch = jest.fn((action) => {
    if (typeof action === 'function') return action(dispatch, getState);
    actions.push(action);
    return action;
  });
  return { dispatch, actions };
}

describe('live activity thunks', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('turning on updates the store first, then saves only that key', async () => {
    settingsIpc.save.mockResolvedValue({ success: true, settings: { showLiveActivity: true } });
    const store = makeStore(false);

    await expect(store.dispatch(setShowLiveActivity(true))).resolves.toBe(true);

    expect(store.actions).toEqual([
      { type: 'ui/updateSettings', payload: { showLiveActivity: true } }
    ]);
    expect(settingsIpc.save).toHaveBeenCalledWith({ showLiveActivity: true });
  });

  test('a rejected save puts the previous value back', async () => {
    settingsIpc.save.mockResolvedValue({ success: false, error: 'Invalid settings provided' });
    const store = makeStore(false);

    await expect(store.dispatch(setShowLiveActivity(true))).resolves.toBe(false);

    expect(store.actions).toEqual([
      { type: 'ui/updateSettings', payload: { showLiveActivity: true } },
      { type: 'ui/updateSettings', payload: { showLiveActivity: false } }
    ]);
  });

  test('a thrown save puts the previous value back', async () => {
    settingsIpc.save.mockRejectedValue(new Error('IPC timeout'));
    const store = makeStore(true);

    await expect(store.dispatch(setShowLiveActivity(false))).resolves.toBe(false);

    expect(store.actions).toEqual([
      { type: 'ui/updateSettings', payload: { showLiveActivity: false } },
      { type: 'ui/updateSettings', payload: { showLiveActivity: true } }
    ]);
  });

  test('toggle flips the current value', async () => {
    settingsIpc.save.mockResolvedValue({ success: true });
    const store = makeStore(true);

    await store.dispatch(toggleShowLiveActivity());

    expect(settingsIpc.save).toHaveBeenCalledWith({ showLiveActivity: false });
  });

  test('toggle treats a missing value as off', async () => {
    settingsIpc.save.mockResolvedValue({ success: true });
    const store = makeStore(undefined);

    await store.dispatch(toggleShowLiveActivity());

    expect(settingsIpc.save).toHaveBeenCalledWith({ showLiveActivity: true });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/liveActivityThunks.test.js`

Expected: FAIL — `Cannot find module '../src/renderer/store/thunks/liveActivityThunks'`.

- [ ] **Step 3: Implement the thunks**

Create `src/renderer/store/thunks/liveActivityThunks.js`:

```js
// @ts-check
/**
 * Live Activity panel on/off from anywhere in the app (the panel's Close
 * button and Ctrl/Cmd+Shift+L). The Settings → Diagnostics switch goes
 * through SettingsPanel's own local-state auto-save instead.
 *
 * The store is updated first so the panel opens or closes immediately; only
 * the one key is saved (settings:save merges partial objects). If the save
 * fails the previous value is put back. An open SettingsPanel adopts the new
 * value from the store like any other external settings change.
 */
import { updateSettings } from '../slices/uiSlice';
import { settingsIpc } from '../../services/ipc';
import { logger } from '../../../shared/logger';

/**
 * @param {boolean} enabled
 * @returns {(dispatch: any, getState: () => any) => Promise<boolean>}
 */
export const setShowLiveActivity = (enabled) => async (dispatch, getState) => {
  const next = enabled === true;
  const previous = getState()?.ui?.settings?.showLiveActivity === true;
  dispatch(updateSettings({ showLiveActivity: next }));
  try {
    const result = await settingsIpc.save({ showLiveActivity: next });
    if (result && typeof result === 'object' && result.success === false) {
      throw new Error(result.error || 'Settings save was rejected');
    }
    return true;
  } catch (error) {
    dispatch(updateSettings({ showLiveActivity: previous }));
    logger.warn('[LiveActivity] Could not save the live activity setting', {
      error: /** @type {any} */ (error)?.message
    });
    return false;
  }
};

/** @returns {(dispatch: any, getState: () => any) => Promise<boolean>} */
export const toggleShowLiveActivity = () => (dispatch, getState) =>
  dispatch(setShowLiveActivity(getState()?.ui?.settings?.showLiveActivity !== true));
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/liveActivityThunks.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/store/thunks/liveActivityThunks.js test/liveActivityThunks.test.js
git commit -m "feat(live-activity): thunks to turn the panel on and off from anywhere"
```

---

## Task 11: Panel UI state in `localStorage`

**Files:**

- Create: `src/renderer/components/diagnostics/liveActivityPanelState.js`
- Test: `test/components/liveActivityPanelState.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `test/components/liveActivityPanelState.test.js`:

```js
/**
 * Per-machine UI state of the Live Activity panel. Storage can be blocked or
 * full; the panel must still open with sensible defaults.
 */
import {
  LIVE_ACTIVITY_PANEL_STORAGE_KEY,
  defaultPanelState,
  loadPanelState,
  savePanelState
} from '../../src/renderer/components/diagnostics/liveActivityPanelState';

const VIEWPORT = { width: 1200, height: 900 };

describe('liveActivityPanelState', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('uses the documented storage key', () => {
    expect(LIVE_ACTIVITY_PANEL_STORAGE_KEY).toBe('stratosort_live_activity_panel');
  });

  test('defaults to the bottom-right corner, expanded, on the Activity tab', () => {
    expect(defaultPanelState(VIEWPORT)).toEqual({
      x: 764,
      y: 564,
      width: 420,
      height: 320,
      minimized: false,
      tab: 'activity'
    });
  });

  test('the default position never goes negative in a tiny window', () => {
    const state = defaultPanelState({ width: 300, height: 200 });
    expect(state.x).toBe(0);
    expect(state.y).toBe(0);
  });

  test('loads the defaults when nothing is stored', () => {
    expect(loadPanelState(VIEWPORT)).toEqual(defaultPanelState(VIEWPORT));
  });

  test('round-trips a saved state', () => {
    const state = { x: 10, y: 20, width: 500, height: 400, minimized: true, tab: 'raw' };
    savePanelState(state);
    expect(loadPanelState(VIEWPORT)).toEqual(state);
  });

  test('saves only the known fields', () => {
    savePanelState({
      x: 1,
      y: 2,
      width: 330,
      height: 230,
      minimized: false,
      tab: 'activity',
      extra: 'nope'
    });
    const stored = JSON.parse(window.localStorage.getItem(LIVE_ACTIVITY_PANEL_STORAGE_KEY));
    expect(Object.keys(stored).sort()).toEqual(
      ['height', 'minimized', 'tab', 'width', 'x', 'y'].sort()
    );
  });

  test('falls back field by field on garbage values', () => {
    window.localStorage.setItem(
      LIVE_ACTIVITY_PANEL_STORAGE_KEY,
      JSON.stringify({ x: 'a', y: 5, width: null, tab: 'other', minimized: 'yes' })
    );
    expect(loadPanelState(VIEWPORT)).toEqual({
      x: 764,
      y: 5,
      width: 420,
      height: 320,
      minimized: false,
      tab: 'activity'
    });
  });

  test('ignores stored text that is not JSON', () => {
    window.localStorage.setItem(LIVE_ACTIVITY_PANEL_STORAGE_KEY, 'not json');
    expect(loadPanelState(VIEWPORT)).toEqual(defaultPanelState(VIEWPORT));
  });

  test('survives storage that throws on read and on write', () => {
    jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });

    expect(loadPanelState(VIEWPORT)).toEqual(defaultPanelState(VIEWPORT));
    expect(() => savePanelState(defaultPanelState(VIEWPORT))).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/components/liveActivityPanelState.test.js`

Expected: FAIL — `Cannot find module '../../src/renderer/components/diagnostics/liveActivityPanelState'`.

- [ ] **Step 3: Implement the storage helpers**

Create `src/renderer/components/diagnostics/liveActivityPanelState.js`:

```js
// @ts-check
/**
 * Per-machine UI state of the Live Activity panel: position, size, minimized
 * and the selected tab. Lives in localStorage; every read and write is
 * guarded so blocked, full or corrupt storage never breaks the panel (it
 * just opens with the defaults and keeps its layout for this session).
 */

export const LIVE_ACTIVITY_PANEL_STORAGE_KEY = 'stratosort_live_activity_panel';
export const DEFAULT_PANEL_WIDTH = 420;
export const DEFAULT_PANEL_HEIGHT = 320;
const EDGE_GAP = 16;

/**
 * @typedef {'activity' | 'raw'} LiveActivityTab
 * @typedef {{ x: number, y: number, width: number, height: number, minimized: boolean, tab: LiveActivityTab }} LiveActivityPanelState
 */

/**
 * @param {{ width: number, height: number }} viewport
 * @returns {LiveActivityPanelState}
 */
export function defaultPanelState(viewport) {
  return {
    x: Math.max(0, viewport.width - DEFAULT_PANEL_WIDTH - EDGE_GAP),
    y: Math.max(0, viewport.height - DEFAULT_PANEL_HEIGHT - EDGE_GAP),
    width: DEFAULT_PANEL_WIDTH,
    height: DEFAULT_PANEL_HEIGHT,
    minimized: false,
    tab: 'activity'
  };
}

/** @param {unknown} value */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @param {{ width: number, height: number }} viewport
 * @returns {LiveActivityPanelState}
 */
export function loadPanelState(viewport) {
  const fallback = defaultPanelState(viewport);
  try {
    const raw = window.localStorage.getItem(LIVE_ACTIVITY_PANEL_STORAGE_KEY);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return fallback;
    return {
      x: isFiniteNumber(parsed.x) ? parsed.x : fallback.x,
      y: isFiniteNumber(parsed.y) ? parsed.y : fallback.y,
      width: isFiniteNumber(parsed.width) ? parsed.width : fallback.width,
      height: isFiniteNumber(parsed.height) ? parsed.height : fallback.height,
      minimized: parsed.minimized === true,
      tab: parsed.tab === 'raw' ? 'raw' : 'activity'
    };
  } catch {
    return fallback;
  }
}

/** @param {LiveActivityPanelState} state */
export function savePanelState(state) {
  try {
    window.localStorage.setItem(
      LIVE_ACTIVITY_PANEL_STORAGE_KEY,
      JSON.stringify({
        x: state.x,
        y: state.y,
        width: state.width,
        height: state.height,
        minimized: state.minimized === true,
        tab: state.tab === 'raw' ? 'raw' : 'activity'
      })
    );
  } catch {
    // Storage unavailable or full: the layout holds for this session only.
  }
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/components/liveActivityPanelState.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/diagnostics/liveActivityPanelState.js test/components/liveActivityPanelState.test.js
git commit -m "feat(live-activity): persist panel layout per machine with guarded storage"
```

---

## Task 12: Pure view helpers (`liveActivityFormat.js`)

**Files:**

- Create: `src/renderer/components/diagnostics/liveActivityFormat.js`
- Test: `test/components/liveActivityFormat.test.js` (create)

The `LiveLogEntry` / `LiveActivity` typedefs are imported from `src/renderer/hooks/useLiveLogFeed.js`
(Task 14). JSDoc `import()` types do not affect Jest; `typecheck:js` is run after Task 14.

- [ ] **Step 1: Write the failing test**

Create `test/components/liveActivityFormat.test.js`:

```js
/**
 * View helpers for the Live Activity panel: level filtering, time format,
 * file-name redaction ("Redact paths" on) and the copy-line format.
 */
import {
  LEVEL_FILTER_OPTIONS,
  REDACTED_FILE_LABEL,
  activityEntries,
  filterRawEntries,
  formatCopyLine,
  formatEntryTime,
  levelRank,
  listContexts,
  redactActivityText,
  redactRawText
} from '../../src/renderer/components/diagnostics/liveActivityFormat';

const TIME = new Date(2026, 10, 5, 9, 4, 7).toISOString();

function entry(id, overrides = {}) {
  return {
    id,
    time: TIME,
    level: 'info',
    context: 'Test',
    msg: `message ${id}`,
    dataText: '',
    activity: null,
    ...overrides
  };
}

const ANALYZING = {
  kind: 'analyze',
  icon: 'analyze',
  tone: 'info',
  text: 'Analyzing receipt-0412.jpg',
  file: 'receipt-0412.jpg'
};

describe('liveActivityFormat', () => {
  test('offers debug, info, warn and error as minimum levels', () => {
    expect(LEVEL_FILTER_OPTIONS).toEqual(['debug', 'info', 'warn', 'error']);
  });

  test('ranks levels and treats unknown levels as info', () => {
    expect(levelRank('trace')).toBeLessThan(levelRank('debug'));
    expect(levelRank('debug')).toBeLessThan(levelRank('info'));
    expect(levelRank('info')).toBeLessThan(levelRank('warn'));
    expect(levelRank('warn')).toBeLessThan(levelRank('error'));
    expect(levelRank('error')).toBeLessThan(levelRank('fatal'));
    expect(levelRank('nonsense')).toBe(levelRank('info'));
  });

  test('formats entry times as local HH:MM:SS', () => {
    expect(formatEntryTime(TIME)).toBe('09:04:07');
    expect(formatEntryTime('not a date')).toBe('--:--:--');
  });

  describe('filters', () => {
    const entries = [
      entry(1, { level: 'debug', context: 'OramaVectorService' }),
      entry(2, { level: 'info', context: 'SmartFolderWatcher', activity: ANALYZING }),
      entry(3, { level: 'warn', context: 'DownloadWatcher' }),
      entry(4, { level: 'error', context: 'SmartFolderWatcher' }),
      entry(5, { level: 'trace', context: '' })
    ];

    test('activityEntries keeps only recognized events', () => {
      expect(activityEntries(entries).map((e) => e.id)).toEqual([2]);
    });

    test('filterRawEntries applies the minimum level', () => {
      expect(filterRawEntries(entries, 'debug', 'all').map((e) => e.id)).toEqual([1, 2, 3, 4]);
      expect(filterRawEntries(entries, 'warn', 'all').map((e) => e.id)).toEqual([3, 4]);
    });

    test('filterRawEntries applies the context filter', () => {
      expect(filterRawEntries(entries, 'debug', 'SmartFolderWatcher').map((e) => e.id)).toEqual([
        2, 4
      ]);
    });

    test('listContexts returns the distinct, non-empty contexts sorted', () => {
      expect(listContexts(entries)).toEqual([
        'DownloadWatcher',
        'OramaVectorService',
        'SmartFolderWatcher'
      ]);
    });
  });

  describe('redaction', () => {
    test('activity text hides the file name only when redaction is on', () => {
      expect(redactActivityText(ANALYZING, false)).toBe('Analyzing receipt-0412.jpg');
      expect(redactActivityText(ANALYZING, true)).toBe(`Analyzing ${REDACTED_FILE_LABEL}`);
      expect(
        redactActivityText({ kind: 'vision', icon: 'eye', tone: 'info', text: 'Vision batch started' }, true)
      ).toBe('Vision batch started');
    });

    test('raw text keeps everything when redaction is off', () => {
      const text = '[SMART-FOLDER-WATCHER] Analyzing file: [REDACTED_PATH]\\receipt.jpg';
      expect(redactRawText(text, false)).toBe(text);
      expect(redactRawText('', true)).toBe('');
    });

    test.each([
      [
        '[SMART-FOLDER-WATCHER] Analyzing file: [REDACTED_PATH]\\receipt 0412.jpg',
        '[SMART-FOLDER-WATCHER] Analyzing file: [REDACTED_PATH]'
      ],
      [
        '[DOWNLOAD-WATCHER] Auto-organized with 87% confidence: [REDACTED_PATH]\\a b.pdf => [REDACTED_PATH]\\a b.pdf',
        '[DOWNLOAD-WATCHER] Auto-organized with 87% confidence: [REDACTED_PATH] => [REDACTED_PATH]'
      ],
      [
        '[FILE-OPS] Deleted file: [REDACTED_PATH]/old.log (120 bytes)',
        '[FILE-OPS] Deleted file: [REDACTED_PATH] (120 bytes)'
      ],
      ['{"filePath":"[REDACTED_PATH]\\\\tax.pdf","held":1}', '{"filePath":"a file","held":1}'],
      [
        '{"fileName":"receipt.jpg","category":"Financial"}',
        '{"fileName":"a file","category":"Financial"}'
      ]
    ])('raw redaction: %s', (input, expected) => {
      expect(redactRawText(input, true)).toBe(expected);
    });
  });

  describe('copy lines', () => {
    test('activity lines are time + text, redacted when asked', () => {
      const e = entry(1, { activity: ANALYZING });
      expect(formatCopyLine(e, 'activity', false)).toBe('09:04:07 Analyzing receipt-0412.jpg');
      expect(formatCopyLine(e, 'activity', true)).toBe('09:04:07 Analyzing a file');
    });

    test('problem lines carry the context name', () => {
      const e = entry(1, {
        level: 'warn',
        context: 'DownloadWatcher',
        activity: { kind: 'problem', icon: 'alert', tone: 'warn', text: 'Problem: Cannot access file:' }
      });
      expect(formatCopyLine(e, 'activity', false)).toBe(
        '09:04:07 Problem: Cannot access file: [DownloadWatcher]'
      );
    });

    test('raw lines are time, padded level, context, message and data', () => {
      const e = entry(1, {
        level: 'warn',
        context: 'DownloadWatcher',
        msg: '[DOWNLOAD-WATCHER] Cannot access file:',
        dataText: '{"filePath":"[REDACTED_PATH]\\\\tax.pdf"}'
      });
      expect(formatCopyLine(e, 'raw', false)).toBe(
        '09:04:07 WARN  [DownloadWatcher] [DOWNLOAD-WATCHER] Cannot access file: {"filePath":"[REDACTED_PATH]\\\\tax.pdf"}'
      );
      expect(formatCopyLine(e, 'raw', true)).toBe(
        '09:04:07 WARN  [DownloadWatcher] [DOWNLOAD-WATCHER] Cannot access file: {"filePath":"a file"}'
      );
    });

    test('raw lines without a context say App and omit empty data', () => {
      expect(formatCopyLine(entry(1, { context: '' }), 'raw', false)).toBe(
        '09:04:07 INFO  [App] message 1'
      );
    });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/components/liveActivityFormat.test.js`

Expected: FAIL — `Cannot find module '../../src/renderer/components/diagnostics/liveActivityFormat'`.

- [ ] **Step 3: Implement the helpers**

Create `src/renderer/components/diagnostics/liveActivityFormat.js`:

```js
// @ts-check
/**
 * Pure view helpers for the Live Activity panel: level filtering, time
 * formatting, file-name redaction and the copy format. No React, no I/O.
 *
 * Records are already sanitized by the logger (absolute paths become
 * `[REDACTED_PATH]\name.ext`). With the "Redact paths" setting on, the panel
 * also hides those remaining file names ("a file").
 */

/**
 * @typedef {import('../../hooks/useLiveLogFeed').LiveLogEntry} LiveLogEntry
 * @typedef {import('../../hooks/useLiveLogFeed').LiveActivity} LiveActivity
 * @typedef {'activity' | 'raw'} LiveActivityTab
 */

/** Minimum-level choices offered by the Raw tab. */
export const LEVEL_FILTER_OPTIONS = ['debug', 'info', 'warn', 'error'];

export const REDACTED_FILE_LABEL = 'a file';

/** @type {Record<string, number>} */
const LEVEL_RANK = { trace: 10, debug: 20, info: 30, warn: 40, error: 50, fatal: 60 };

// The name left after a redacted path. Stops at quotes and common
// punctuation, and before " => ", " (" or " [" so the rest of the line stays.
const REDACTED_PATH_TAIL = /\[REDACTED_PATH\][\\/](?:(?! => | \(| \[)[^"',;)}\]\r\n])+/g;

// JSON fields in dataText that hold a file name or a path.
const FILE_FIELD_VALUE =
  /("(?:fileName|file|filePath|path|source|destination|from|to|originalPath|backupPath)"\s*:\s*")((?:[^"\\]|\\.)*)(")/g;

/** @param {string} level */
export function levelRank(level) {
  return LEVEL_RANK[level] ?? LEVEL_RANK.info;
}

/**
 * @param {string} iso
 * @returns {string}
 */
export function formatEntryTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return [date.getHours(), date.getMinutes(), date.getSeconds()]
    .map((part) => String(part).padStart(2, '0'))
    .join(':');
}

/**
 * @param {LiveLogEntry[]} entries
 * @returns {LiveLogEntry[]}
 */
export function activityEntries(entries) {
  return entries.filter((entry) => Boolean(entry.activity));
}

/**
 * @param {LiveLogEntry[]} entries
 * @param {string} minLevel
 * @param {string} context - a context name, or 'all'
 * @returns {LiveLogEntry[]}
 */
export function filterRawEntries(entries, minLevel, context) {
  const min = levelRank(minLevel);
  return entries.filter(
    (entry) => levelRank(entry.level) >= min && (context === 'all' || entry.context === context)
  );
}

/**
 * @param {LiveLogEntry[]} entries
 * @returns {string[]}
 */
export function listContexts(entries) {
  return [...new Set(entries.map((entry) => entry.context).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
}

/**
 * @param {LiveActivity} activity
 * @param {boolean} redact
 * @returns {string}
 */
export function redactActivityText(activity, redact) {
  if (!redact || !activity.file) return activity.text;
  return activity.text.split(activity.file).join(REDACTED_FILE_LABEL);
}

/**
 * @param {string} text
 * @param {boolean} redact
 * @returns {string}
 */
export function redactRawText(text, redact) {
  if (!redact || !text) return text;
  return text
    .replace(REDACTED_PATH_TAIL, '[REDACTED_PATH]')
    .replace(FILE_FIELD_VALUE, `$1${REDACTED_FILE_LABEL}$3`);
}

/**
 * One line of "Copy visible lines" output, as shown on screen.
 * @param {LiveLogEntry} entry
 * @param {LiveActivityTab} tab
 * @param {boolean} redact
 * @returns {string}
 */
export function formatCopyLine(entry, tab, redact) {
  const time = formatEntryTime(entry.time);
  if (tab === 'activity' && entry.activity) {
    const line = `${time} ${redactActivityText(entry.activity, redact)}`;
    return entry.activity.kind === 'problem' && entry.context ? `${line} [${entry.context}]` : line;
  }
  const msg = redactRawText(entry.msg, redact);
  const data = redactRawText(entry.dataText, redact);
  return `${time} ${entry.level.toUpperCase().padEnd(5)} [${entry.context || 'App'}] ${msg}${
    data ? ` ${data}` : ''
  }`;
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/components/liveActivityFormat.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/diagnostics/liveActivityFormat.js test/components/liveActivityFormat.test.js
git commit -m "feat(live-activity): view helpers for filters, redaction and copy lines"
```

---

## Task 13: `useDraggablePanel` hook

**Files:**

- Create: `src/renderer/hooks/useDraggablePanel.js`
- Test: `test/hooks/useDraggablePanel.test.js` (create)

The hook attaches `pointermove` / `pointerup` / `pointercancel` to `window` for the duration of a
drag. jsdom may lack `PointerEvent`, so the tests call the returned `onPointerDown` handlers
directly and dispatch `MouseEvent`s named `pointermove` / `pointerup` (they carry `clientX/Y`).

- [ ] **Step 1: Write the failing test**

Create `test/hooks/useDraggablePanel.test.js`:

```js
/**
 * Geometry for the Live Activity panel: drag by the title bar, resize from
 * the bottom-right corner, arrow keys, and always fully inside the window.
 */
import { renderHook, act } from '@testing-library/react';
import {
  KEYBOARD_STEP_PX,
  PANEL_LIMITS,
  clampGeometry,
  useDraggablePanel
} from '../../src/renderer/hooks/useDraggablePanel';

function setViewport(width, height) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    writable: true,
    value: height
  });
}

function pointer(type, x, y) {
  window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y }));
}

function press(key, shiftKey = false) {
  return { key, shiftKey, preventDefault: jest.fn() };
}

function startAt(x, y, button = 0) {
  return { button, clientX: x, clientY: y, preventDefault: jest.fn() };
}

describe('clampGeometry', () => {
  const viewport = { width: 1000, height: 800 };

  test('documents the limits from the spec', () => {
    expect(PANEL_LIMITS).toEqual({ minWidth: 320, minHeight: 220, maxFraction: 0.8 });
    expect(KEYBOARD_STEP_PX).toBe(16);
  });

  test('keeps an in-bounds geometry unchanged', () => {
    expect(clampGeometry({ x: 10, y: 20, width: 400, height: 300 }, viewport)).toEqual({
      x: 10,
      y: 20,
      width: 400,
      height: 300
    });
  });

  test('enforces the minimum size', () => {
    expect(clampGeometry({ x: 0, y: 0, width: 100, height: 50 }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 320,
      height: 220
    });
  });

  test('caps the size at 80% of the window', () => {
    expect(clampGeometry({ x: 0, y: 0, width: 2000, height: 2000 }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 640
    });
  });

  test('keeps the panel fully inside the window', () => {
    expect(clampGeometry({ x: 900, y: 700, width: 400, height: 300 }, viewport)).toEqual({
      x: 600,
      y: 500,
      width: 400,
      height: 300
    });
    expect(clampGeometry({ x: -50, y: -10, width: 400, height: 300 }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 400,
      height: 300
    });
  });

  test('falls back to safe values for non-numeric input', () => {
    expect(clampGeometry({ x: NaN, y: undefined, width: 'a', height: null }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 320,
      height: 220
    });
  });
});

describe('useDraggablePanel', () => {
  beforeEach(() => {
    setViewport(1000, 800);
  });

  test('clamps the initial geometry to the window', () => {
    setViewport(800, 600);
    const { result } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 700, y: 500, width: 400, height: 300 } })
    );
    expect(result.current.geometry).toEqual({ x: 400, y: 300, width: 400, height: 300 });
  });

  test('dragging the title bar moves the panel, clamps it, and commits on release', () => {
    const onCommit = jest.fn();
    const { result } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 100, y: 100, width: 400, height: 300 }, onCommit })
    );

    act(() => result.current.dragHandleProps.onPointerDown(startAt(150, 110)));
    act(() => pointer('pointermove', 200, 160));
    expect(result.current.geometry).toEqual({ x: 150, y: 150, width: 400, height: 300 });

    act(() => pointer('pointermove', 5000, 5000));
    expect(result.current.geometry).toEqual({ x: 600, y: 500, width: 400, height: 300 });
    expect(onCommit).not.toHaveBeenCalled();

    act(() => pointer('pointerup', 5000, 5000));
    expect(onCommit).toHaveBeenCalledWith({ x: 600, y: 500, width: 400, height: 300 });

    act(() => pointer('pointermove', 0, 0));
    expect(result.current.geometry.x).toBe(600);
  });

  test('ignores non-primary buttons', () => {
    const { result } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 100, y: 100, width: 400, height: 300 } })
    );
    act(() => result.current.dragHandleProps.onPointerDown(startAt(150, 110, 2)));
    act(() => pointer('pointermove', 400, 400));
    expect(result.current.geometry).toEqual({ x: 100, y: 100, width: 400, height: 300 });
  });

  test('corner resize respects the minimum and maximum size', () => {
    const onCommit = jest.fn();
    const { result } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 100, y: 100, width: 400, height: 300 }, onCommit })
    );

    act(() => result.current.resizeHandleProps.onPointerDown(startAt(500, 400)));
    act(() => pointer('pointermove', 100, 100));
    expect(result.current.geometry).toEqual({ x: 100, y: 100, width: 320, height: 220 });

    act(() => pointer('pointermove', 5000, 5000));
    expect(result.current.geometry).toEqual({ x: 100, y: 100, width: 800, height: 640 });

    act(() => pointer('pointerup', 5000, 5000));
    expect(onCommit).toHaveBeenLastCalledWith({ x: 100, y: 100, width: 800, height: 640 });
  });

  test('arrow keys move by 16 px and Shift+arrow keys resize; each commits', () => {
    const onCommit = jest.fn();
    const { result } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 100, y: 100, width: 400, height: 300 }, onCommit })
    );

    act(() => result.current.dragHandleProps.onKeyDown(press('ArrowRight')));
    act(() => result.current.dragHandleProps.onKeyDown(press('ArrowDown')));
    act(() => result.current.dragHandleProps.onKeyDown(press('ArrowLeft', true)));
    act(() => result.current.dragHandleProps.onKeyDown(press('ArrowUp', true)));

    expect(result.current.geometry).toEqual({ x: 116, y: 116, width: 384, height: 284 });
    expect(onCommit).toHaveBeenCalledTimes(4);

    const other = press('Enter');
    act(() => result.current.dragHandleProps.onKeyDown(other));
    expect(other.preventDefault).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(4);
  });

  test('re-clamps when the window shrinks', () => {
    const { result } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 600, y: 500, width: 400, height: 300 } })
    );
    setViewport(700, 500);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current.geometry).toEqual({ x: 300, y: 200, width: 400, height: 300 });
  });

  test('unmounting mid-drag removes the window listeners without committing', () => {
    const onCommit = jest.fn();
    const { result, unmount } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 100, y: 100, width: 400, height: 300 }, onCommit })
    );
    act(() => result.current.dragHandleProps.onPointerDown(startAt(150, 110)));
    unmount();

    expect(() => pointer('pointermove', 300, 300)).not.toThrow();
    expect(() => pointer('pointerup', 300, 300)).not.toThrow();
    expect(onCommit).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/hooks/useDraggablePanel.test.js`

Expected: FAIL — `Cannot find module '../../src/renderer/hooks/useDraggablePanel'`.

- [ ] **Step 3: Implement the hook**

Create `src/renderer/hooks/useDraggablePanel.js`:

```js
// @ts-check
/**
 * Geometry for a floating panel: drag by a handle, resize from the
 * bottom-right corner, move with the arrow keys (Shift+arrows resize), and
 * always keep the whole panel inside the window, including when the window
 * shrinks. `onCommit` receives the geometry when a drag, resize or key move
 * ends, for persistence.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} PanelGeometry
 * @typedef {{ minWidth: number, minHeight: number, maxFraction: number }} PanelLimits
 * @typedef {{ width: number, height: number }} Viewport
 * @typedef {{ button?: number, clientX: number, clientY: number, preventDefault?: () => void }} PointerStart
 * @typedef {{ key: string, shiftKey?: boolean, preventDefault: () => void }} KeyInput
 */

export const PANEL_LIMITS = Object.freeze({ minWidth: 320, minHeight: 220, maxFraction: 0.8 });
export const KEYBOARD_STEP_PX = 16;

/** @type {Record<string, [number, number]>} */
const ARROW_DELTAS = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1]
};

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** @returns {Viewport} */
export function getViewport() {
  if (typeof window === 'undefined') return { width: 1024, height: 768 };
  return { width: window.innerWidth || 1024, height: window.innerHeight || 768 };
}

/**
 * Size between the minimum and `maxFraction` of the window; position so the
 * whole panel is visible.
 * @param {PanelGeometry} geometry
 * @param {Viewport} viewport
 * @param {PanelLimits} [limits]
 * @returns {PanelGeometry}
 */
export function clampGeometry(geometry, viewport, limits = PANEL_LIMITS) {
  const maxWidth = Math.max(limits.minWidth, Math.floor(viewport.width * limits.maxFraction));
  const maxHeight = Math.max(limits.minHeight, Math.floor(viewport.height * limits.maxFraction));
  const width = clampNumber(
    Math.round(toNumber(geometry.width, limits.minWidth)),
    limits.minWidth,
    maxWidth
  );
  const height = clampNumber(
    Math.round(toNumber(geometry.height, limits.minHeight)),
    limits.minHeight,
    maxHeight
  );
  const x = clampNumber(Math.round(toNumber(geometry.x, 0)), 0, viewport.width - width);
  const y = clampNumber(Math.round(toNumber(geometry.y, 0)), 0, viewport.height - height);
  return { x, y, width, height };
}

/**
 * @param {{ initialGeometry: PanelGeometry, onCommit?: (geometry: PanelGeometry) => void, limits?: PanelLimits }} options
 */
export function useDraggablePanel({ initialGeometry, onCommit, limits = PANEL_LIMITS }) {
  const [geometry, setGeometry] = useState(() =>
    clampGeometry(initialGeometry, getViewport(), limits)
  );
  const geometryRef = useRef(geometry);
  const onCommitRef = useRef(onCommit);
  const stopSessionRef = useRef(/** @type {(() => void) | null} */ (null));

  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  const apply = useCallback(
    (/** @type {PanelGeometry} */ next) => {
      const clamped = clampGeometry(next, getViewport(), limits);
      geometryRef.current = clamped;
      setGeometry(clamped);
      return clamped;
    },
    [limits]
  );

  const commit = useCallback(() => {
    onCommitRef.current?.(geometryRef.current);
  }, []);

  const startSession = useCallback(
    (/** @type {PointerStart} */ event, /** @type {'move' | 'resize'} */ mode) => {
      if (typeof event.button === 'number' && event.button !== 0) return;
      event.preventDefault?.();
      stopSessionRef.current?.();
      const origin = { px: event.clientX, py: event.clientY, geometry: geometryRef.current };

      /** @param {MouseEvent} moveEvent */
      const onMove = (moveEvent) => {
        const dx = moveEvent.clientX - origin.px;
        const dy = moveEvent.clientY - origin.py;
        const start = origin.geometry;
        if (mode === 'move') {
          apply({ ...start, x: start.x + dx, y: start.y + dy });
          return;
        }
        const viewport = getViewport();
        apply({
          ...start,
          width: Math.min(start.width + dx, viewport.width - start.x),
          height: Math.min(start.height + dy, viewport.height - start.y)
        });
      };

      const detach = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
        stopSessionRef.current = null;
      };

      function onEnd() {
        detach();
        commit();
      }

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
      stopSessionRef.current = detach;
    },
    [apply, commit]
  );

  const onKeyDown = useCallback(
    (/** @type {KeyInput} */ event) => {
      const delta = ARROW_DELTAS[event.key];
      if (!delta) return;
      event.preventDefault();
      const current = geometryRef.current;
      const [dx, dy] = delta;
      if (event.shiftKey) {
        apply({
          ...current,
          width: current.width + dx * KEYBOARD_STEP_PX,
          height: current.height + dy * KEYBOARD_STEP_PX
        });
      } else {
        apply({
          ...current,
          x: current.x + dx * KEYBOARD_STEP_PX,
          y: current.y + dy * KEYBOARD_STEP_PX
        });
      }
      commit();
    },
    [apply, commit]
  );

  // Re-clamp when the window shrinks (or grows past an earlier clamp).
  useEffect(() => {
    const onResize = () => {
      apply(geometryRef.current);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [apply]);

  // An unmount mid-drag drops the window listeners without committing.
  useEffect(
    () => () => {
      stopSessionRef.current?.();
    },
    []
  );

  return {
    geometry,
    dragHandleProps: {
      onPointerDown: (/** @type {PointerStart} */ event) => startSession(event, 'move'),
      onKeyDown
    },
    resizeHandleProps: {
      onPointerDown: (/** @type {PointerStart} */ event) => startSession(event, 'resize')
    }
  };
}
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/hooks/useDraggablePanel.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/hooks/useDraggablePanel.js test/hooks/useDraggablePanel.test.js
git commit -m "feat(live-activity): draggable, resizable, keyboard-movable panel geometry hook"
```

---

## Task 14: `useLiveLogFeed` hook

**Files:**

- Create: `src/renderer/hooks/useLiveLogFeed.js`
- Test: `test/hooks/useLiveLogFeed.test.js` (create)

- [ ] **Step 1: Write the failing test**

Create `test/hooks/useLiveLogFeed.test.js`:

```js
/**
 * Renderer side of the Live Activity feed: subscribe while enabled, merge the
 * backlog and pushed batches by id, cap at 500, hold entries while paused,
 * and unsubscribe on unmount.
 */
import { renderHook, act } from '@testing-library/react';

const mockSubscribe = jest.fn();
const mockUnsubscribe = jest.fn();
const mockOff = jest.fn();
let mockBatchListener = null;

jest.mock('../../src/renderer/services/ipc', () => ({
  systemIpc: {
    subscribeLiveLog: (...args) => mockSubscribe(...args),
    unsubscribeLiveLog: (...args) => mockUnsubscribe(...args),
    onLiveLogBatch: (callback) => {
      mockBatchListener = callback;
      return mockOff;
    }
  }
}));

import {
  MAX_RENDERER_ENTRIES,
  RECENT_ACTIVITY_MS,
  capEntries,
  selectFreshEntries,
  useLiveLogFeed
} from '../../src/renderer/hooks/useLiveLogFeed';

function entry(id, overrides = {}) {
  return {
    id,
    time: '2026-11-05T09:00:00.000Z',
    level: 'info',
    context: 'Test',
    msg: `message ${id}`,
    dataText: '',
    activity: null,
    ...overrides
  };
}

function range(from, to) {
  return Array.from({ length: to - from + 1 }, (_, i) => entry(from + i));
}

function ids(list) {
  return list.map((e) => e.id);
}

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function settle() {
  await act(async () => {});
}

describe('selectFreshEntries / capEntries', () => {
  test('keeps only entries newer than the last seen id', () => {
    expect(selectFreshEntries([entry(1), entry(2), entry(3)], 1)).toEqual({
      fresh: [entry(2), entry(3)],
      lastSeenId: 3
    });
  });

  test('ignores non-arrays and malformed entries', () => {
    expect(selectFreshEntries(undefined, 5)).toEqual({ fresh: [], lastSeenId: 5 });
    expect(selectFreshEntries([null, { id: 'x' }, entry(6)], 5)).toEqual({
      fresh: [entry(6)],
      lastSeenId: 6
    });
  });

  test('capEntries keeps the newest entries', () => {
    expect(ids(capEntries(range(1, 10), 3))).toEqual([8, 9, 10]);
    expect(MAX_RENDERER_ENTRIES).toBe(500);
  });
});

describe('useLiveLogFeed', () => {
  beforeEach(() => {
    jest.useFakeTimers();
    mockSubscribe.mockReset();
    mockUnsubscribe.mockReset();
    mockUnsubscribe.mockResolvedValue(undefined);
    mockOff.mockReset();
    mockBatchListener = null;
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('subscribes on mount and shows the backlog', async () => {
    mockSubscribe.mockResolvedValue({ entries: [entry(1), entry(2)] });
    const { result } = renderHook(() => useLiveLogFeed());

    expect(result.current.status).toBe('connecting');
    await settle();

    expect(mockSubscribe).toHaveBeenCalledTimes(1);
    expect(result.current.status).toBe('live');
    expect(ids(result.current.entries)).toEqual([1, 2]);
  });

  test('keeps a batch that arrives before the backlog, after the backlog', async () => {
    const pending = deferred();
    mockSubscribe.mockReturnValue(pending.promise);
    const { result } = renderHook(() => useLiveLogFeed());

    act(() => mockBatchListener({ entries: [entry(3)], dropped: 0 }));
    await act(async () => {
      pending.resolve({ entries: [entry(1), entry(2)] });
    });

    expect(ids(result.current.entries)).toEqual([1, 2, 3]);
  });

  test('appends batches, ignores ids already seen, and adds up dropped counts', async () => {
    mockSubscribe.mockResolvedValue({ entries: [entry(1)] });
    const { result } = renderHook(() => useLiveLogFeed());
    await settle();

    act(() => mockBatchListener({ entries: [entry(1), entry(2), entry(3)], dropped: 4 }));
    expect(ids(result.current.entries)).toEqual([1, 2, 3]);
    expect(result.current.dropped).toBe(4);

    act(() => mockBatchListener({ entries: [entry(4)], dropped: 1 }));
    expect(ids(result.current.entries)).toEqual([1, 2, 3, 4]);
    expect(result.current.dropped).toBe(5);
  });

  test('keeps at most 500 entries', async () => {
    mockSubscribe.mockResolvedValue({ entries: range(1, 300) });
    const { result } = renderHook(() => useLiveLogFeed());
    await settle();

    act(() => mockBatchListener({ entries: range(301, 700), dropped: 0 }));

    expect(result.current.entries).toHaveLength(MAX_RENDERER_ENTRIES);
    expect(result.current.entries[0].id).toBe(201);
  });

  test('while paused, new entries are counted instead of shown; resume shows them', async () => {
    mockSubscribe.mockResolvedValue({ entries: [entry(1)] });
    const { result } = renderHook(() => useLiveLogFeed());
    await settle();

    act(() => result.current.pause());
    expect(result.current.paused).toBe(true);

    act(() => mockBatchListener({ entries: [entry(2), entry(3)], dropped: 0 }));
    expect(ids(result.current.entries)).toEqual([1]);
    expect(result.current.pausedCount).toBe(2);

    act(() => result.current.resume());
    expect(result.current.paused).toBe(false);
    expect(result.current.pausedCount).toBe(0);
    expect(ids(result.current.entries)).toEqual([1, 2, 3]);
  });

  test('clear empties the list and old entries do not come back', async () => {
    mockSubscribe.mockResolvedValue({ entries: [entry(1)] });
    const { result } = renderHook(() => useLiveLogFeed());
    await settle();

    act(() => mockBatchListener({ entries: [entry(2)], dropped: 3 }));
    act(() => result.current.clear());
    expect(result.current.entries).toEqual([]);
    expect(result.current.dropped).toBe(0);

    act(() => mockBatchListener({ entries: [entry(2), entry(3)], dropped: 0 }));
    expect(ids(result.current.entries)).toEqual([3]);
  });

  test('unsubscribes and removes the batch listener on unmount', async () => {
    mockSubscribe.mockResolvedValue({ entries: [] });
    const { unmount } = renderHook(() => useLiveLogFeed());
    await settle();

    unmount();

    expect(mockOff).toHaveBeenCalledTimes(1);
    expect(mockUnsubscribe).toHaveBeenCalledTimes(1);
  });

  test('does nothing while disabled', () => {
    const { result } = renderHook(() => useLiveLogFeed({ enabled: false }));
    expect(mockSubscribe).not.toHaveBeenCalled();
    expect(result.current.status).toBe('idle');
  });

  test('reports unavailable when the subscribe call fails', async () => {
    mockSubscribe.mockRejectedValue(new Error('No handler registered'));
    const { result } = renderHook(() => useLiveLogFeed());
    await settle();
    expect(result.current.status).toBe('unavailable');
  });

  test('recentlyActive stays on for 3 s after the last new entry', async () => {
    mockSubscribe.mockResolvedValue({ entries: [entry(1)] });
    const { result } = renderHook(() => useLiveLogFeed());
    await settle();
    expect(result.current.recentlyActive).toBe(true);

    act(() => jest.advanceTimersByTime(RECENT_ACTIVITY_MS - 1));
    expect(result.current.recentlyActive).toBe(true);

    act(() => mockBatchListener({ entries: [entry(2)], dropped: 0 }));
    act(() => jest.advanceTimersByTime(RECENT_ACTIVITY_MS - 1));
    expect(result.current.recentlyActive).toBe(true);

    act(() => jest.advanceTimersByTime(1));
    expect(result.current.recentlyActive).toBe(false);
  });

  test('an empty backlog does not light the activity dot', async () => {
    mockSubscribe.mockResolvedValue({ entries: [] });
    const { result } = renderHook(() => useLiveLogFeed());
    await settle();
    expect(result.current.recentlyActive).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/hooks/useLiveLogFeed.test.js`

Expected: FAIL — `Cannot find module '../../src/renderer/hooks/useLiveLogFeed'`.

- [ ] **Step 3: Implement the hook**

Create `src/renderer/hooks/useLiveLogFeed.js`:

```js
// @ts-check
/**
 * Renderer side of the Live Activity feed (src/main/services/liveLogFeed.js).
 *
 * Subscribes while `enabled` (the panel stays subscribed when minimized so
 * its activity dot keeps working), merges the backlog and pushed batches by
 * entry id, keeps at most MAX_RENDERER_ENTRIES, and while paused holds new
 * entries aside (counted, not shown) until resume. Unsubscribes on unmount.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { systemIpc } from '../services/ipc';

/**
 * Mirrors LiveActivity / LiveLogEntry in src/main/services/liveLogFeed.js.
 * @typedef {{ kind: string, icon: string, text: string, file?: string, tone: 'info' | 'success' | 'warn' | 'error' }} LiveActivity
 * @typedef {{ id: number, time: string, level: string, context: string, msg: string, dataText: string, activity: LiveActivity | null }} LiveLogEntry
 * @typedef {'idle' | 'connecting' | 'live' | 'unavailable'} LiveFeedStatus
 */

export const MAX_RENDERER_ENTRIES = 500;
export const RECENT_ACTIVITY_MS = 3000;

/**
 * Entries with an id above `lastSeenId`, in arrival order.
 * @param {unknown} incoming
 * @param {number} lastSeenId
 * @returns {{ fresh: LiveLogEntry[], lastSeenId: number }}
 */
export function selectFreshEntries(incoming, lastSeenId) {
  /** @type {LiveLogEntry[]} */
  const fresh = [];
  let seen = lastSeenId;
  if (!Array.isArray(incoming)) return { fresh, lastSeenId: seen };
  for (const candidate of incoming) {
    if (
      candidate &&
      typeof candidate === 'object' &&
      typeof candidate.id === 'number' &&
      candidate.id > seen
    ) {
      fresh.push(/** @type {LiveLogEntry} */ (candidate));
      seen = candidate.id;
    }
  }
  return { fresh, lastSeenId: seen };
}

/**
 * @param {LiveLogEntry[]} list
 * @param {number} [max]
 * @returns {LiveLogEntry[]}
 */
export function capEntries(list, max = MAX_RENDERER_ENTRIES) {
  return list.length > max ? list.slice(list.length - max) : list;
}

/**
 * @param {{ enabled?: boolean }} [options]
 */
export function useLiveLogFeed({ enabled = true } = {}) {
  const [entries, setEntries] = useState(/** @type {LiveLogEntry[]} */ ([]));
  const [status, setStatus] = useState(
    /** @type {LiveFeedStatus} */ (enabled ? 'connecting' : 'idle')
  );
  const [paused, setPaused] = useState(false);
  const [pausedCount, setPausedCount] = useState(0);
  const [dropped, setDropped] = useState(0);
  const [recentlyActive, setRecentlyActive] = useState(false);

  const pausedRef = useRef(false);
  const lastSeenIdRef = useRef(-1);
  const heldRef = useRef(/** @type {LiveLogEntry[]} */ ([]));
  const activityTimerRef = useRef(/** @type {ReturnType<typeof setTimeout> | null} */ (null));

  const markActive = useCallback(() => {
    setRecentlyActive(true);
    if (activityTimerRef.current) clearTimeout(activityTimerRef.current);
    activityTimerRef.current = setTimeout(() => {
      activityTimerRef.current = null;
      setRecentlyActive(false);
    }, RECENT_ACTIVITY_MS);
  }, []);

  const receive = useCallback(
    (/** @type {unknown} */ incoming, /** @type {unknown} */ droppedCount) => {
      if (typeof droppedCount === 'number' && droppedCount > 0) {
        const skipped = droppedCount;
        setDropped((total) => total + skipped);
      }
      const { fresh, lastSeenId } = selectFreshEntries(incoming, lastSeenIdRef.current);
      if (fresh.length === 0) return;
      lastSeenIdRef.current = lastSeenId;
      markActive();
      if (pausedRef.current) {
        heldRef.current = capEntries(heldRef.current.concat(fresh));
        setPausedCount((count) => count + fresh.length);
        return;
      }
      setEntries((list) => capEntries(list.concat(fresh)));
    },
    [markActive]
  );

  const pause = useCallback(() => {
    pausedRef.current = true;
    setPaused(true);
  }, []);

  const resume = useCallback(() => {
    pausedRef.current = false;
    setPaused(false);
    const held = heldRef.current;
    heldRef.current = [];
    setPausedCount(0);
    if (held.length > 0) setEntries((list) => capEntries(list.concat(held)));
  }, []);

  const clear = useCallback(() => {
    heldRef.current = [];
    setEntries([]);
    setPausedCount(0);
    setDropped(0);
  }, []);

  useEffect(() => {
    if (!enabled) {
      setStatus('idle');
      return undefined;
    }
    let cancelled = false;
    let ready = false;
    /** @type {Array<{ entries: unknown, dropped: unknown }>} */
    const early = [];
    setStatus('connecting');

    /** @type {() => void} */
    let off = () => {};
    try {
      off = systemIpc.onLiveLogBatch((/** @type {any} */ payload) => {
        if (cancelled) return;
        if (!ready) {
          early.push({ entries: payload?.entries, dropped: payload?.dropped });
          return;
        }
        receive(payload?.entries, payload?.dropped);
      });
    } catch {
      setStatus('unavailable');
      return () => {
        cancelled = true;
      };
    }

    const start = async () => {
      try {
        const { entries: backlog } = await systemIpc.subscribeLiveLog();
        if (cancelled) return;
        receive(backlog, 0);
        ready = true;
        for (const batch of early.splice(0)) receive(batch.entries, batch.dropped);
        setStatus('live');
      } catch {
        if (!cancelled) setStatus('unavailable');
      }
    };
    start();

    return () => {
      cancelled = true;
      off();
      systemIpc.unsubscribeLiveLog().catch(() => {});
    };
  }, [enabled, receive]);

  useEffect(
    () => () => {
      if (activityTimerRef.current) clearTimeout(activityTimerRef.current);
    },
    []
  );

  return {
    entries,
    status,
    paused,
    pausedCount,
    dropped,
    recentlyActive,
    pause,
    resume,
    clear
  };
}
```

- [ ] **Step 4: Run the tests and the JS type check**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/hooks/useLiveLogFeed.test.js test/components/liveActivityFormat.test.js`

Expected: PASS.

Run: `fnm exec --using=24.22.1 -- npm.cmd run typecheck:js`

Expected: exit 0 (all new `.js` files so far, including the `import()` typedefs used by
`liveActivityFormat.js`, type-check under noImplicitAny).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/hooks/useLiveLogFeed.js test/hooks/useLiveLogFeed.test.js
git commit -m "feat(live-activity): renderer feed hook with pause, caps and activity pulse"
```

---

## Task 15: `LiveActivityPanel` component

**Files:**

- Create: `src/renderer/components/diagnostics/LiveActivityPanel.jsx`
- Test: `test/components/LiveActivityPanel.test.js` (create)

The test mocks `useLiveLogFeed` (its own behavior is covered in Task 14), the Redux hooks, the
selector and the thunk, and replaces react-window's `List` with a plain list that renders every row
(the pattern used by `test/components/DuplicateResolutionModal.test.js`). `useDraggablePanel`, the
storage helpers and the format helpers run for real. Moving/resizing is exercised through the
keyboard path (jsdom has no layout); pointer drag is covered in Task 13.

- [ ] **Step 1: Write the failing test**

Create `test/components/LiveActivityPanel.test.js`:

```js
/**
 * @jest-environment jsdom
 *
 * The floating Live Activity panel: tabs, filters, controls, redaction,
 * minimize/close, and layout persistence (including when storage throws).
 */
import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

const mockDispatch = jest.fn();
const mockPause = jest.fn();
const mockResume = jest.fn();
const mockClear = jest.fn();
let mockState;
let mockFeed;

jest.mock('react-window', () => ({
  List: ({
    rowCount,
    rowComponent: RowComponent,
    rowProps,
    style,
    listRef: _listRef,
    rowHeight: _rowHeight,
    overscanCount: _overscanCount,
    ...rest
  }) => (
    <div data-testid="virtual-list" style={style} {...rest}>
      {Array.from({ length: rowCount }).map((_, index) => (
        <RowComponent
          key={index}
          index={index}
          style={{}}
          ariaAttributes={{
            role: 'listitem',
            'aria-posinset': index + 1,
            'aria-setsize': rowCount
          }}
          {...rowProps}
        />
      ))}
    </div>
  )
}));

jest.mock('../../src/renderer/store/hooks', () => ({
  useAppDispatch: () => mockDispatch,
  useAppSelector: (selector) => selector(mockState)
}));

jest.mock('../../src/renderer/store/selectors', () => ({
  selectRedactPaths: (state) => state.redactPaths
}));

jest.mock('../../src/renderer/store/thunks/liveActivityThunks', () => ({
  setShowLiveActivity: jest.fn((enabled) => ({
    type: 'test/setShowLiveActivity',
    payload: enabled
  }))
}));

jest.mock('../../src/renderer/hooks/useLiveLogFeed', () => ({
  useLiveLogFeed: () => mockFeed
}));

import LiveActivityPanel from '../../src/renderer/components/diagnostics/LiveActivityPanel';

const STORAGE_KEY = 'stratosort_live_activity_panel';

function entry(id, overrides = {}) {
  return {
    id,
    time: new Date(2026, 10, 5, 9, 0, id).toISOString(),
    level: 'info',
    context: 'SmartFolderWatcher',
    msg: `message ${id}`,
    dataText: '',
    activity: null,
    ...overrides
  };
}

const ENTRIES = [
  entry(1, {
    msg: '[SMART-FOLDER-WATCHER] Analyzing file: [REDACTED_PATH]\\receipt-0412.jpg',
    activity: {
      kind: 'analyze',
      icon: 'analyze',
      tone: 'info',
      text: 'Analyzing receipt-0412.jpg',
      file: 'receipt-0412.jpg'
    }
  }),
  entry(2, {
    level: 'debug',
    context: 'OramaVectorService',
    msg: '[OramaVectorService] Persisted databases',
    dataText: '{"collections":["files"]}',
    activity: { kind: 'index-saved', icon: 'save', tone: 'success', text: 'Saved search index (files)' }
  }),
  entry(3, {
    level: 'warn',
    context: 'DownloadWatcher',
    msg: '[DOWNLOAD-WATCHER] Cannot access file:',
    dataText: '{"filePath":"[REDACTED_PATH]\\\\tax.pdf"}',
    activity: { kind: 'problem', icon: 'alert', tone: 'warn', text: 'Problem: Cannot access file:' }
  }),
  entry(4, { context: 'LlamaService', msg: '[LlamaService] Model configuration updated' })
];

function makeFeed(overrides = {}) {
  return {
    entries: ENTRIES,
    status: 'live',
    paused: false,
    pausedCount: 0,
    dropped: 0,
    recentlyActive: false,
    pause: mockPause,
    resume: mockResume,
    clear: mockClear,
    ...overrides
  };
}

function setViewport(width, height) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    writable: true,
    value: height
  });
}

function seedState(state = {}) {
  window.localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      x: 100,
      y: 100,
      width: 400,
      height: 300,
      minimized: false,
      tab: 'activity',
      ...state
    })
  );
}

function storedState() {
  return JSON.parse(window.localStorage.getItem(STORAGE_KEY));
}

function region() {
  return screen.queryByRole('region', { name: 'Live activity' });
}

function dragHandle() {
  return screen.getByRole('button', { name: /Move live activity panel/ });
}

describe('LiveActivityPanel', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    window.localStorage.clear();
    setViewport(1200, 900);
    mockState = { redactPaths: false };
    mockFeed = makeFeed();
  });

  describe('Activity tab', () => {
    test('is the default and shows recognized events in plain words', () => {
      render(<LiveActivityPanel />);

      expect(region()).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'Activity' })).toHaveAttribute(
        'aria-selected',
        'true'
      );
      expect(screen.getByText('Analyzing receipt-0412.jpg')).toBeInTheDocument();
      expect(screen.getByText('Saved search index (files)')).toBeInTheDocument();
      expect(
        screen.queryByText('[LlamaService] Model configuration updated')
      ).not.toBeInTheDocument();
    });

    test('problems show the context they came from', () => {
      render(<LiveActivityPanel />);
      expect(screen.getByText('Problem: Cannot access file:')).toBeInTheDocument();
      expect(screen.getByText('DownloadWatcher')).toBeInTheDocument();
    });

    test('says it is waiting when nothing has happened yet', () => {
      mockFeed = makeFeed({ entries: [] });
      render(<LiveActivityPanel />);
      expect(screen.getByText('Waiting for activity…')).toBeInTheDocument();
    });
  });

  describe('Raw tab', () => {
    test('lists every record and filters by minimum level and context', () => {
      render(<LiveActivityPanel />);
      fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));

      expect(screen.getByText('[LlamaService] Model configuration updated')).toBeInTheDocument();
      expect(screen.getByText('[OramaVectorService] Persisted databases')).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Minimum level'), { target: { value: 'warn' } });
      expect(
        screen.queryByText('[LlamaService] Model configuration updated')
      ).not.toBeInTheDocument();
      expect(screen.getByText('[DOWNLOAD-WATCHER] Cannot access file:')).toBeInTheDocument();

      fireEvent.change(screen.getByLabelText('Minimum level'), { target: { value: 'debug' } });
      fireEvent.change(screen.getByLabelText('Context'), {
        target: { value: 'OramaVectorService' }
      });
      expect(screen.getByText('[OramaVectorService] Persisted databases')).toBeInTheDocument();
      expect(screen.queryByText('[DOWNLOAD-WATCHER] Cannot access file:')).not.toBeInTheDocument();
    });

    test('remembers the selected tab', () => {
      render(<LiveActivityPanel />);
      fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
      expect(storedState().tab).toBe('raw');
    });

    test('clicking a row shows its full details; clicking again hides them', () => {
      render(<LiveActivityPanel />);
      fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));

      fireEvent.click(screen.getByRole('button', { name: /Cannot access file/ }));
      expect(screen.getByLabelText('Selected log line details')).toHaveValue(
        '[DOWNLOAD-WATCHER] Cannot access file:\n{"filePath":"[REDACTED_PATH]\\\\tax.pdf"}'
      );

      fireEvent.click(screen.getByRole('button', { name: /Cannot access file/ }));
      expect(screen.queryByLabelText('Selected log line details')).not.toBeInTheDocument();
    });
  });

  test('Redact paths hides file names in both tabs', () => {
    mockState = { redactPaths: true };
    render(<LiveActivityPanel />);

    expect(screen.getByText('Analyzing a file')).toBeInTheDocument();
    expect(screen.queryByText(/receipt-0412/)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('tab', { name: 'Raw' }));
    expect(
      screen.getByText('[SMART-FOLDER-WATCHER] Analyzing file: [REDACTED_PATH]')
    ).toBeInTheDocument();
    expect(screen.getByText('{"filePath":"a file"}')).toBeInTheDocument();
    expect(screen.queryByText(/tax\.pdf/)).not.toBeInTheDocument();
  });

  describe('controls', () => {
    test('pause asks the feed to hold new entries', () => {
      render(<LiveActivityPanel />);
      fireEvent.click(screen.getByRole('button', { name: 'Pause live activity' }));
      expect(mockPause).toHaveBeenCalledTimes(1);
    });

    test('while paused it shows how many new entries are waiting, and resumes', () => {
      mockFeed = makeFeed({ paused: true, pausedCount: 3 });
      render(<LiveActivityPanel />);
      expect(screen.getByText('3 new')).toBeInTheDocument();
      fireEvent.click(screen.getByRole('button', { name: 'Resume live activity' }));
      expect(mockResume).toHaveBeenCalledTimes(1);
    });

    test('clear empties the feed', () => {
      render(<LiveActivityPanel />);
      fireEvent.click(screen.getByRole('button', { name: 'Clear live activity' }));
      expect(mockClear).toHaveBeenCalledTimes(1);
    });

    test('copy puts the visible lines on the clipboard', async () => {
      const writeText = jest.fn().mockResolvedValue(undefined);
      Object.defineProperty(window.navigator, 'clipboard', {
        configurable: true,
        value: { writeText }
      });
      try {
        render(<LiveActivityPanel />);
        fireEvent.click(screen.getByRole('button', { name: 'Copy visible lines' }));

        await waitFor(() =>
          expect(writeText).toHaveBeenCalledWith(
            [
              '09:00:01 Analyzing receipt-0412.jpg',
              '09:00:02 Saved search index (files)',
              '09:00:03 Problem: Cannot access file: [DownloadWatcher]'
            ].join('\n')
          )
        );
        expect(await screen.findByText('Copied 3 lines')).toBeInTheDocument();
      } finally {
        delete window.navigator.clipboard;
      }
    });

    test('scrolling up stops auto-scroll until "Jump to latest"', () => {
      render(<LiveActivityPanel />);
      const list = screen.getByTestId('virtual-list');
      Object.defineProperty(list, 'scrollHeight', { configurable: true, value: 1000 });
      Object.defineProperty(list, 'clientHeight', { configurable: true, value: 200 });

      fireEvent.scroll(list);
      fireEvent.click(screen.getByRole('button', { name: 'Jump to latest' }));

      expect(screen.queryByRole('button', { name: 'Jump to latest' })).not.toBeInTheDocument();
    });

    test('reports entries skipped during a burst', () => {
      mockFeed = makeFeed({ dropped: 7 });
      render(<LiveActivityPanel />);
      expect(screen.getByText('7 skipped (too fast)')).toBeInTheDocument();
    });

    test('says when live activity is unavailable', () => {
      mockFeed = makeFeed({ status: 'unavailable', entries: [] });
      render(<LiveActivityPanel />);
      expect(screen.getByText('Live activity unavailable')).toBeInTheDocument();
    });
  });

  describe('minimize, restore and close', () => {
    test('minimizes to a pill with a pulsing dot while active, and restores', () => {
      mockFeed = makeFeed({ recentlyActive: true });
      render(<LiveActivityPanel />);

      fireEvent.click(screen.getByRole('button', { name: 'Minimize live activity panel' }));
      expect(region()).not.toBeInTheDocument();
      const dot = screen.getByTestId('live-activity-pulse');
      expect(dot).toHaveAttribute('data-active', 'true');
      expect(dot.className).toContain('motion-safe:animate-pulse');
      expect(storedState().minimized).toBe(true);

      fireEvent.click(screen.getByRole('button', { name: 'Restore live activity panel' }));
      expect(region()).toBeInTheDocument();
      expect(storedState().minimized).toBe(false);
    });

    test('the dot does not pulse when nothing happened in the last 3 s', () => {
      render(<LiveActivityPanel />);
      const dot = screen.getByTestId('live-activity-pulse');
      expect(dot).toHaveAttribute('data-active', 'false');
      expect(dot.className).not.toContain('animate-pulse');
    });

    test('opens minimized when it was left minimized', () => {
      seedState({ minimized: true });
      render(<LiveActivityPanel />);
      expect(screen.getByRole('button', { name: 'Restore live activity panel' })).toBeInTheDocument();
      expect(region()).not.toBeInTheDocument();
    });

    test('close turns the setting off', () => {
      render(<LiveActivityPanel />);
      fireEvent.click(screen.getByRole('button', { name: 'Close live activity panel' }));
      expect(mockDispatch).toHaveBeenCalledWith({
        type: 'test/setShowLiveActivity',
        payload: false
      });
    });
  });

  describe('position and size', () => {
    test('restores the saved geometry and persists keyboard moves', () => {
      seedState({ x: 100, y: 100, width: 400, height: 300 });
      render(<LiveActivityPanel />);
      expect(region()).toHaveStyle({ left: '100px', top: '100px', width: '400px', height: '300px' });

      fireEvent.keyDown(dragHandle(), { key: 'ArrowRight' });

      expect(region()).toHaveStyle({ left: '116px' });
      expect(storedState()).toEqual({
        x: 116,
        y: 100,
        width: 400,
        height: 300,
        minimized: false,
        tab: 'activity'
      });
    });

    test('stays inside the window and never shrinks below the minimum size', () => {
      seedState({ x: 780, y: 100, width: 400, height: 300 });
      render(<LiveActivityPanel />);

      fireEvent.keyDown(dragHandle(), { key: 'ArrowRight' });
      fireEvent.keyDown(dragHandle(), { key: 'ArrowRight' });
      expect(storedState().x).toBe(800);

      for (let i = 0; i < 6; i += 1) {
        fireEvent.keyDown(dragHandle(), { key: 'ArrowLeft', shiftKey: true });
      }
      expect(storedState().width).toBe(320);
    });

    test('a saved position outside a smaller window is pulled back in', () => {
      seedState({ x: 5000, y: 5000, width: 400, height: 300 });
      render(<LiveActivityPanel />);
      expect(region()).toHaveStyle({ left: '800px', top: '600px' });
    });

    test('works when localStorage throws', () => {
      const getSpy = jest.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
        throw new Error('blocked');
      });
      const setSpy = jest.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new Error('quota');
      });
      try {
        render(<LiveActivityPanel />);
        expect(region()).toHaveStyle({ left: '764px', top: '564px' });

        expect(() => fireEvent.keyDown(dragHandle(), { key: 'ArrowRight' })).not.toThrow();
        expect(region()).toHaveStyle({ left: '780px' });

        fireEvent.click(screen.getByRole('button', { name: 'Minimize live activity panel' }));
        expect(
          screen.getByRole('button', { name: 'Restore live activity panel' })
        ).toBeInTheDocument();
      } finally {
        getSpy.mockRestore();
        setSpy.mockRestore();
      }
    });
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/components/LiveActivityPanel.test.js`

Expected: FAIL — `Cannot find module '../../src/renderer/components/diagnostics/LiveActivityPanel'`.

- [ ] **Step 3: Implement the component**

Create `src/renderer/components/diagnostics/LiveActivityPanel.jsx`:

```jsx
import React, { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { List } from 'react-window';
import {
  Activity,
  AlertTriangle,
  ArrowDownToLine,
  CheckCircle2,
  Copy,
  Cpu,
  Database,
  Download,
  Eye,
  FileSearch,
  FolderInput,
  HardDrive,
  Minus,
  Pause,
  Play,
  Save,
  Search,
  Sparkles,
  Trash2,
  Undo2,
  Wrench,
  X
} from 'lucide-react';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { selectRedactPaths } from '../../store/selectors';
import { setShowLiveActivity } from '../../store/thunks/liveActivityThunks';
import { useLiveLogFeed } from '../../hooks/useLiveLogFeed';
import { getViewport, useDraggablePanel } from '../../hooks/useDraggablePanel';
import { loadPanelState, savePanelState } from './liveActivityPanelState';
import {
  LEVEL_FILTER_OPTIONS,
  activityEntries,
  filterRawEntries,
  formatCopyLine,
  formatEntryTime,
  listContexts,
  redactActivityText,
  redactRawText
} from './liveActivityFormat';

/**
 * Live Activity panel: a floating, draggable, minimizable card showing what
 * the app is doing (Activity tab) and the sanitized log lines (Raw tab).
 * Mounted by App.js while the `showLiveActivity` setting is on; layout is
 * per-machine UI state in localStorage (liveActivityPanelState.js).
 */

const ROW_HEIGHT = 28;
// Header (40) + toolbar (36) + status line (24).
const CHROME_HEIGHT = 100;
const DETAILS_HEIGHT = 88;

const ACTIVITY_ICONS = {
  analyze: FileSearch,
  check: CheckCircle2,
  sparkles: Sparkles,
  folder: FolderInput,
  eye: Eye,
  cpu: Cpu,
  database: Database,
  save: Save,
  'hard-drive': HardDrive,
  alert: AlertTriangle,
  undo: Undo2,
  download: Download,
  search: Search,
  wrench: Wrench
};

const TONE_CLASS = {
  info: 'text-system-gray-400',
  success: 'text-stratosort-success',
  warn: 'text-stratosort-warning',
  error: 'text-stratosort-danger'
};

const LEVEL_BADGE_CLASS = {
  trace: 'bg-system-gray-700 text-system-gray-300',
  debug: 'bg-system-gray-700 text-system-gray-300',
  info: 'bg-stratosort-blue/20 text-stratosort-blue',
  warn: 'bg-stratosort-warning/20 text-stratosort-warning',
  error: 'bg-stratosort-danger/20 text-stratosort-danger',
  fatal: 'bg-stratosort-danger/20 text-stratosort-danger'
};

const TABS = [
  ['activity', 'Activity'],
  ['raw', 'Raw']
];

function PulseDot({ active }) {
  return (
    <span
      aria-hidden="true"
      data-testid="live-activity-pulse"
      data-active={active ? 'true' : 'false'}
      className={`inline-block h-2 w-2 flex-shrink-0 rounded-full ${
        active ? 'bg-stratosort-success motion-safe:animate-pulse' : 'bg-system-gray-500'
      }`}
    />
  );
}

PulseDot.propTypes = {
  active: PropTypes.bool.isRequired
};

function IconButton({ label, onClick, children }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      className="inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-system-gray-300 hover:bg-white/10 focus:outline-none focus-visible:ring-2 focus-visible:ring-stratosort-blue"
    >
      {children}
    </button>
  );
}

IconButton.propTypes = {
  label: PropTypes.string.isRequired,
  onClick: PropTypes.func.isRequired,
  children: PropTypes.node.isRequired
};

function ActivityRow({ index, style, ariaAttributes, rows, redact }) {
  const entry = rows[index];
  if (!entry || !entry.activity) return <div style={style} {...ariaAttributes} />;
  const Icon = ACTIVITY_ICONS[entry.activity.icon] || Activity;
  const text = redactActivityText(entry.activity, redact);
  return (
    <div style={style} {...ariaAttributes} className="flex items-center gap-2 px-3 text-xs">
      <span className="flex-shrink-0 font-mono tabular-nums text-system-gray-500">
        {formatEntryTime(entry.time)}
      </span>
      <Icon
        aria-hidden="true"
        className={`h-3.5 w-3.5 flex-shrink-0 ${TONE_CLASS[entry.activity.tone] || TONE_CLASS.info}`}
      />
      <span className="min-w-0 truncate text-system-gray-200" title={text}>
        {text}
      </span>
      {entry.activity.kind === 'problem' && entry.context ? (
        <span className="ml-auto flex-shrink-0 font-mono text-system-gray-500">
          {entry.context}
        </span>
      ) : null}
    </div>
  );
}

ActivityRow.propTypes = {
  index: PropTypes.number.isRequired,
  style: PropTypes.object.isRequired,
  ariaAttributes: PropTypes.object,
  rows: PropTypes.array.isRequired,
  redact: PropTypes.bool.isRequired
};

function RawRow({ index, style, ariaAttributes, rows, redact, selectedId, onSelect }) {
  const entry = rows[index];
  if (!entry) return <div style={style} {...ariaAttributes} />;
  const msg = redactRawText(entry.msg, redact);
  const dataText = redactRawText(entry.dataText, redact);
  const selected = selectedId === entry.id;
  return (
    <div style={style} {...ariaAttributes}>
      <button
        type="button"
        aria-pressed={selected}
        onClick={() => onSelect(entry.id)}
        className={`flex h-full w-full items-center gap-2 px-3 text-left font-mono text-xs hover:bg-white/5 focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-stratosort-blue ${
          selected ? 'bg-white/10' : ''
        }`}
      >
        <span className="flex-shrink-0 tabular-nums text-system-gray-500">
          {formatEntryTime(entry.time)}
        </span>
        <span
          className={`flex-shrink-0 rounded px-1 uppercase ${
            LEVEL_BADGE_CLASS[entry.level] || LEVEL_BADGE_CLASS.info
          }`}
        >
          {entry.level}
        </span>
        <span className="flex-shrink-0 text-stratosort-blue">{entry.context || 'App'}</span>
        <span className="min-w-0 truncate text-system-gray-200">{msg}</span>
        {dataText ? (
          <span className="min-w-0 flex-1 truncate text-system-gray-500">{dataText}</span>
        ) : null}
      </button>
    </div>
  );
}

RawRow.propTypes = {
  index: PropTypes.number.isRequired,
  style: PropTypes.object.isRequired,
  ariaAttributes: PropTypes.object,
  rows: PropTypes.array.isRequired,
  redact: PropTypes.bool.isRequired,
  selectedId: PropTypes.number,
  onSelect: PropTypes.func.isRequired
};

function LiveActivityPanel() {
  const dispatch = useAppDispatch();
  const redactPaths = useAppSelector(selectRedactPaths) === true;
  const feed = useLiveLogFeed({ enabled: true });
  const idBase = useId();
  const listRef = useRef(null);

  const [panelState, setPanelState] = useState(() => loadPanelState(getViewport()));
  const panelStateRef = useRef(panelState);
  const persist = useCallback((patch) => {
    const next = { ...panelStateRef.current, ...patch };
    panelStateRef.current = next;
    setPanelState(next);
    savePanelState(next);
  }, []);

  const { geometry, dragHandleProps, resizeHandleProps } = useDraggablePanel({
    initialGeometry: {
      x: panelState.x,
      y: panelState.y,
      width: panelState.width,
      height: panelState.height
    },
    onCommit: persist
  });

  const [minLevel, setMinLevel] = useState('debug');
  const [contextFilter, setContextFilter] = useState('all');
  const [selectedId, setSelectedId] = useState(null);
  const [autoScroll, setAutoScroll] = useState(true);
  const [copyStatus, setCopyStatus] = useState('');

  const { tab, minimized } = panelState;

  const visible = useMemo(
    () =>
      tab === 'raw'
        ? filterRawEntries(feed.entries, minLevel, contextFilter)
        : activityEntries(feed.entries),
    [feed.entries, tab, minLevel, contextFilter]
  );

  const contextOptions = useMemo(() => {
    const contexts = listContexts(feed.entries);
    return contextFilter !== 'all' && !contexts.includes(contextFilter)
      ? [...contexts, contextFilter]
      : contexts;
  }, [feed.entries, contextFilter]);

  const selectedEntry =
    tab === 'raw' && selectedId !== null
      ? visible.find((candidate) => candidate.id === selectedId) || null
      : null;

  useEffect(() => {
    if (!autoScroll || minimized || visible.length === 0) return;
    listRef.current?.scrollToRow?.({ index: visible.length - 1, align: 'end' });
  }, [autoScroll, minimized, visible.length, tab]);

  const handleScroll = useCallback((event) => {
    const element = event.currentTarget;
    if (!element) return;
    const distanceFromBottom = element.scrollHeight - element.scrollTop - element.clientHeight;
    setAutoScroll(distanceFromBottom <= ROW_HEIGHT / 2);
  }, []);

  const jumpToLatest = useCallback(() => {
    setAutoScroll(true);
    if (visible.length > 0) {
      listRef.current?.scrollToRow?.({ index: visible.length - 1, align: 'end' });
    }
  }, [visible.length]);

  const handleSelect = useCallback((id) => {
    setSelectedId((current) => (current === id ? null : id));
  }, []);

  const handleTab = useCallback(
    (next) => {
      setSelectedId(null);
      setAutoScroll(true);
      persist({ tab: next });
    },
    [persist]
  );

  const handleMinimize = useCallback(() => persist({ minimized: true }), [persist]);
  const handleRestore = useCallback(() => persist({ minimized: false }), [persist]);

  const handleClose = useCallback(() => {
    dispatch(setShowLiveActivity(false));
  }, [dispatch]);

  const handleClear = useCallback(() => {
    feed.clear();
    setSelectedId(null);
    setAutoScroll(true);
    setCopyStatus('');
  }, [feed]);

  const handleCopy = useCallback(async () => {
    const text = visible.map((candidate) => formatCopyLine(candidate, tab, redactPaths)).join('\n');
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard || typeof clipboard.writeText !== 'function') {
      setCopyStatus('Copy is unavailable');
      return;
    }
    try {
      await clipboard.writeText(text);
      setCopyStatus(`Copied ${visible.length} ${visible.length === 1 ? 'line' : 'lines'}`);
    } catch {
      setCopyStatus('Copy failed');
    }
  }, [visible, tab, redactPaths]);

  const rowProps = useMemo(
    () =>
      tab === 'raw'
        ? { rows: visible, redact: redactPaths, selectedId, onSelect: handleSelect }
        : { rows: visible, redact: redactPaths },
    [tab, visible, redactPaths, selectedId, handleSelect]
  );

  if (minimized) {
    return (
      <button
        type="button"
        aria-label="Restore live activity panel"
        onClick={handleRestore}
        className="fixed bottom-4 right-4 z-floating-panel inline-flex items-center gap-2 rounded-full border border-border-soft bg-surface-primary px-3 py-1.5 text-xs font-medium text-system-gray-100 shadow-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-stratosort-blue"
      >
        <PulseDot active={feed.recentlyActive} />
        Live activity
      </button>
    );
  }

  const listHeight = Math.max(
    ROW_HEIGHT * 2,
    geometry.height - CHROME_HEIGHT - (selectedEntry ? DETAILS_HEIGHT : 0)
  );

  let statusText = `${visible.length} shown`;
  if (copyStatus) statusText = copyStatus;
  else if (feed.status === 'connecting') statusText = 'Connecting…';
  else if (feed.status === 'unavailable') statusText = 'Not connected';
  else if (feed.paused) statusText = 'Paused';

  return (
    <section
      aria-label="Live activity"
      className="fixed z-floating-panel flex flex-col overflow-hidden rounded-xl border border-border-soft bg-surface-primary shadow-lg"
      style={{
        left: geometry.x,
        top: geometry.y,
        width: geometry.width,
        height: geometry.height
      }}
    >
      <div className="flex h-10 flex-shrink-0 items-center gap-2 border-b border-border-soft pl-3 pr-1">
        <div
          role="button"
          tabIndex={0}
          aria-label="Move live activity panel. Arrow keys move it; Shift plus arrow keys resize it."
          {...dragHandleProps}
          className="flex min-w-0 flex-1 cursor-move select-none items-center gap-2 rounded focus:outline-none focus-visible:ring-2 focus-visible:ring-stratosort-blue"
          style={{ touchAction: 'none' }}
        >
          <PulseDot active={feed.recentlyActive} />
          <span className="truncate text-sm font-medium text-system-gray-100">Live activity</span>
        </div>
        <IconButton label="Minimize live activity panel" onClick={handleMinimize}>
          <Minus aria-hidden="true" className="h-4 w-4" />
        </IconButton>
        <IconButton label="Close live activity panel" onClick={handleClose}>
          <X aria-hidden="true" className="h-4 w-4" />
        </IconButton>
      </div>

      <div className="flex h-9 flex-shrink-0 items-center gap-1 border-b border-border-soft px-2">
        <div role="tablist" aria-label="Live activity view" className="flex gap-1">
          {TABS.map(([value, label]) => (
            <button
              key={value}
              type="button"
              role="tab"
              id={`${idBase}-tab-${value}`}
              aria-selected={tab === value}
              aria-controls={`${idBase}-panel`}
              onClick={() => handleTab(value)}
              className={`rounded-md px-2 py-1 text-xs font-medium focus:outline-none focus-visible:ring-2 focus-visible:ring-stratosort-blue ${
                tab === value
                  ? 'bg-stratosort-blue/20 text-stratosort-blue'
                  : 'text-system-gray-400 hover:bg-white/5'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {tab === 'raw' ? (
          <>
            <select
              aria-label="Minimum level"
              title="Minimum level"
              value={minLevel}
              onChange={(event) => setMinLevel(event.target.value)}
              className="h-7 rounded-md border border-border-soft bg-transparent px-1 text-xs text-system-gray-200"
            >
              {LEVEL_FILTER_OPTIONS.map((level) => (
                <option key={level} value={level}>
                  {level}
                </option>
              ))}
            </select>
            <select
              aria-label="Context"
              title="Context"
              value={contextFilter}
              onChange={(event) => setContextFilter(event.target.value)}
              className="h-7 max-w-[8rem] truncate rounded-md border border-border-soft bg-transparent px-1 text-xs text-system-gray-200"
            >
              <option value="all">All contexts</option>
              {contextOptions.map((context) => (
                <option key={context} value={context}>
                  {context}
                </option>
              ))}
            </select>
          </>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          {feed.paused && feed.pausedCount > 0 ? (
            <span className="text-xs text-stratosort-warning">{feed.pausedCount} new</span>
          ) : null}
          <IconButton
            label={feed.paused ? 'Resume live activity' : 'Pause live activity'}
            onClick={feed.paused ? feed.resume : feed.pause}
          >
            {feed.paused ? (
              <Play aria-hidden="true" className="h-3.5 w-3.5" />
            ) : (
              <Pause aria-hidden="true" className="h-3.5 w-3.5" />
            )}
          </IconButton>
          <IconButton label="Copy visible lines" onClick={handleCopy}>
            <Copy aria-hidden="true" className="h-3.5 w-3.5" />
          </IconButton>
          <IconButton label="Clear live activity" onClick={handleClear}>
            <Trash2 aria-hidden="true" className="h-3.5 w-3.5" />
          </IconButton>
        </div>
      </div>

      <div
        role="tabpanel"
        id={`${idBase}-panel`}
        aria-labelledby={`${idBase}-tab-${tab}`}
        className="flex min-h-0 flex-1 flex-col"
      >
        {feed.status === 'unavailable' ? (
          <p className="p-4 text-sm text-stratosort-danger">Live activity unavailable</p>
        ) : visible.length === 0 ? (
          <p className="p-4 text-sm text-system-gray-500">
            {tab === 'raw' ? 'No log lines match these filters.' : 'Waiting for activity…'}
          </p>
        ) : (
          <List
            listRef={listRef}
            rowCount={visible.length}
            rowHeight={ROW_HEIGHT}
            rowComponent={tab === 'raw' ? RawRow : ActivityRow}
            rowProps={rowProps}
            overscanCount={8}
            onScroll={handleScroll}
            tabIndex={0}
            aria-label={tab === 'raw' ? 'Raw log lines' : 'Activity entries'}
            className="scrollbar-thin"
            style={{ height: listHeight, width: '100%' }}
          />
        )}
        {selectedEntry ? (
          <div
            className="flex-shrink-0 border-t border-border-soft p-2"
            style={{ height: DETAILS_HEIGHT }}
          >
            <textarea
              readOnly
              aria-label="Selected log line details"
              value={[
                redactRawText(selectedEntry.msg, redactPaths),
                redactRawText(selectedEntry.dataText, redactPaths)
              ]
                .filter(Boolean)
                .join('\n')}
              className="h-full w-full resize-none rounded bg-transparent font-mono text-xs text-system-gray-300 focus:outline-none focus-visible:ring-2 focus-visible:ring-stratosort-blue"
            />
          </div>
        ) : null}
      </div>

      <div className="flex h-6 flex-shrink-0 items-center gap-2 border-t border-border-soft px-3 text-xs text-system-gray-500">
        <span role="status">{statusText}</span>
        {feed.dropped > 0 ? <span>{feed.dropped} skipped (too fast)</span> : null}
        {!autoScroll && visible.length > 0 ? (
          <button
            type="button"
            onClick={jumpToLatest}
            className="ml-auto inline-flex items-center gap-1 text-stratosort-blue hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-stratosort-blue"
          >
            <ArrowDownToLine aria-hidden="true" className="h-3 w-3" />
            Jump to latest
          </button>
        ) : null}
      </div>

      <div
        aria-hidden="true"
        data-testid="live-activity-resize"
        {...resizeHandleProps}
        className="absolute bottom-0 right-0 h-3 w-3 cursor-se-resize"
        style={{ touchAction: 'none' }}
      />
    </section>
  );
}

export default LiveActivityPanel;
```

- [ ] **Step 4: Run the test and lint the new component**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/components/LiveActivityPanel.test.js`

Expected: PASS.

Run: `fnm exec --using=24.22.1 -- npx.cmd eslint src/renderer/components/diagnostics src/renderer/hooks/useDraggablePanel.js src/renderer/hooks/useLiveLogFeed.js`

Expected: exit 0 with no jsx-a11y errors (warnings from `react-hooks/exhaustive-deps` are
acceptable only if none are reported; fix any that appear before committing).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/diagnostics/LiveActivityPanel.jsx test/components/LiveActivityPanel.test.js
git commit -m "feat(live-activity): floating Live Activity panel with Activity and Raw tabs"
```

---

## Task 16: Mount the panel at the app root behind the setting

**Files:**

- Modify: `src/renderer/App.js` (lazy imports ~line 34; selectors ~line 56; render tree ~line 168)
- Modify: `test/components/App.viewMode.test.js` (mock + `setupState` + new describe at the end)

- [ ] **Step 1: Write the failing test**

In `test/components/App.viewMode.test.js`, replace:

```js
import App from '../../src/renderer/App';
```

with:

```js
jest.mock('../../src/renderer/components/diagnostics/LiveActivityPanel', () => ({
  __esModule: true,
  default: () => <div data-testid="live-activity-panel" />
}));

import App from '../../src/renderer/App';
```

Replace:

```js
function setupState({
  currentPhase = 'discover',
  viewMode = 'phased',
  smartFolders = [],
  selectedTheme = 'primary',
  showSettings = false
} = {}) {
  mockState = {
    ui: { currentPhase, viewMode, selectedTheme, showSettings },
    files: { smartFolders }
  };
}
```

with:

```js
function setupState({
  currentPhase = 'discover',
  viewMode = 'phased',
  smartFolders = [],
  selectedTheme = 'primary',
  showSettings = false,
  settings = null
} = {}) {
  mockState = {
    ui: { currentPhase, viewMode, selectedTheme, showSettings, settings },
    files: { smartFolders }
  };
}
```

Append at the end of the file:

```js
describe('App live activity panel', () => {
  beforeEach(() => {
    mockDispatch.mockClear();
    setupState();
  });

  test('is not mounted before settings load', async () => {
    render(<App />);
    expect(await screen.findByTestId('phase-renderer')).toBeInTheDocument();
    expect(screen.queryByTestId('live-activity-panel')).not.toBeInTheDocument();
  });

  test('is not mounted while showLiveActivity is off', async () => {
    setupState({ settings: { showLiveActivity: false } });
    render(<App />);
    expect(await screen.findByTestId('phase-renderer')).toBeInTheDocument();
    expect(screen.queryByTestId('live-activity-panel')).not.toBeInTheDocument();
  });

  test('mounts when showLiveActivity is on, on either surface', async () => {
    setupState({ settings: { showLiveActivity: true } });
    const { unmount } = render(<App />);
    expect(await screen.findByTestId('live-activity-panel')).toBeInTheDocument();
    unmount();

    setupState({
      viewMode: 'dashboard',
      smartFolders: [{ id: 'sf-1' }],
      settings: { showLiveActivity: true }
    });
    render(<App />);
    expect(await screen.findByTestId('dashboard-view')).toBeInTheDocument();
    expect(await screen.findByTestId('live-activity-panel')).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/components/App.viewMode.test.js`

Expected: FAIL — `mounts when showLiveActivity is on…` times out on
`findByTestId('live-activity-panel')`.

- [ ] **Step 3: Mount the panel**

In `src/renderer/App.js`, replace:

```js
const DashboardView = lazy(() => import('./components/dashboard/DashboardView'));
```

with:

```js
const DashboardView = lazy(() => import('./components/dashboard/DashboardView'));
// Live Activity panel: lazy so its code (virtualized rows, icons) only loads
// once someone turns it on (Settings → Diagnostics or Ctrl/Cmd+Shift+L).
const LiveActivityPanel = lazy(() => import('./components/diagnostics/LiveActivityPanel'));
```

Replace:

```js
  const showSettings = useAppSelector((/** @type {any} */ state) => state.ui.showSettings);
```

with:

```js
  const showSettings = useAppSelector((/** @type {any} */ state) => state.ui.showSettings);
  const showLiveActivity = useAppSelector(
    (/** @type {any} */ state) => state.ui.settings?.showLiveActivity === true
  );
```

Replace:

```jsx
      <ErrorBoundary contextName="TooltipManager" fallback={noopFallback}>
        <TooltipManager />
      </ErrorBoundary>
    </>
```

with:

```jsx
      <ErrorBoundary contextName="TooltipManager" fallback={noopFallback}>
        <TooltipManager />
      </ErrorBoundary>

      {showLiveActivity && (
        <ErrorBoundary contextName="LiveActivityPanel" fallback={noopFallback}>
          <Suspense fallback={null}>
            <LiveActivityPanel />
          </Suspense>
        </ErrorBoundary>
      )}
    </>
```

- [ ] **Step 4: Run the test and confirm it passes**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/components/App.viewMode.test.js`

Expected: PASS (existing view-mode and theme tests still pass; the panel is absent by default).

- [ ] **Step 5: Commit**

```bash
git add src/renderer/App.js test/components/App.viewMode.test.js
git commit -m "feat(live-activity): mount the panel at the app root when the setting is on"
```

---

## Task 17: "Show live activity" switch in Settings → Diagnostics

**Files:**

- Modify: `src/renderer/components/settings/DiagnosticsLogsSection.jsx`
- Modify: `src/renderer/components/SettingsPanel.jsx` (~line 1789)
- Test: `test/components/DiagnosticsLogsSection.liveActivity.test.js` (create)

The switch goes through SettingsPanel's local `settings` / `applySettingsUpdate` (the same path
every other Settings switch uses, e.g. `captionVideoKeyframes` in ProcessingLimitsSection), so its
whole-object auto-save never overwrites the toggle. Auto-save dispatches `updateSettings`, which
mounts the panel through App.js.

- [ ] **Step 1: Write the failing test**

Create `test/components/DiagnosticsLogsSection.liveActivity.test.js`:

```js
/**
 * @jest-environment jsdom
 *
 * Settings → Diagnostics: the "Show live activity" switch updates the
 * SettingsPanel's local settings like every other switch.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../src/renderer/services/ipc', () => ({
  getElectronAPI: () => ({ settings: {}, system: {} }),
  settingsIpc: { openLogsFolder: jest.fn() },
  systemIpc: { exportLogs: jest.fn() }
}));

jest.mock('../../src/renderer/components/ui/Button', () => ({
  __esModule: true,
  default: ({ children, isLoading: _isLoading, ...props }) => (
    <button {...props}>{children}</button>
  )
}));

import DiagnosticsLogsSection from '../../src/renderer/components/settings/DiagnosticsLogsSection';

describe('DiagnosticsLogsSection — Show live activity', () => {
  test('is off by default and turning it on updates showLiveActivity', () => {
    const setSettings = jest.fn();
    render(
      <DiagnosticsLogsSection settings={{ showLiveActivity: false }} setSettings={setSettings} />
    );

    const toggle = screen.getByRole('switch', { name: 'Show live activity' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');

    fireEvent.click(toggle);

    expect(setSettings).toHaveBeenCalledTimes(1);
    const updater = setSettings.mock.calls[0][0];
    expect(updater({ showLiveActivity: false, autoUpdateCheck: true })).toEqual({
      showLiveActivity: true,
      autoUpdateCheck: true
    });
  });

  test('shows on when the setting is on, and turns it off', () => {
    const setSettings = jest.fn();
    render(
      <DiagnosticsLogsSection settings={{ showLiveActivity: true }} setSettings={setSettings} />
    );

    const toggle = screen.getByRole('switch', { name: 'Show live activity' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');

    fireEvent.click(toggle);
    expect(setSettings.mock.calls[0][0]({ showLiveActivity: true })).toEqual({
      showLiveActivity: false
    });
  });

  test('mentions the keyboard shortcut', () => {
    render(<DiagnosticsLogsSection settings={{}} setSettings={jest.fn()} />);
    expect(screen.getByText(/Ctrl\+Shift\+L/)).toBeInTheDocument();
  });

  test('renders off and does not throw without settings props', () => {
    render(<DiagnosticsLogsSection />);
    const toggle = screen.getByRole('switch', { name: 'Show live activity' });
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(() => fireEvent.click(toggle)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/components/DiagnosticsLogsSection.liveActivity.test.js`

Expected: FAIL — `Unable to find an accessible element with the role "switch" and name "Show live activity"`.

- [ ] **Step 3: Add the switch row and pass the settings props**

In `src/renderer/components/settings/DiagnosticsLogsSection.jsx`, replace:

```jsx
import Button from '../ui/Button';
```

with:

```jsx
import Button from '../ui/Button';
import Switch from '../ui/Switch';
```

Replace:

```jsx
/**
 * Diagnostics logs section (open/export logs for troubleshooting).
 */
function DiagnosticsLogsSection({ addNotification }) {
```

with:

```jsx
/**
 * Diagnostics logs section (open/export logs for troubleshooting) and the
 * "Show live activity" switch for the floating Live Activity panel.
 */
function DiagnosticsLogsSection({ addNotification, settings, setSettings }) {
```

Replace:

```jsx
  const canExportLogs = typeof electronApi?.system?.exportLogs === 'function';
```

with:

```jsx
  const canExportLogs = typeof electronApi?.system?.exportLogs === 'function';
  const showLiveActivity = settings?.showLiveActivity === true;

  const handleLiveActivityToggle = React.useCallback(
    (checked) => {
      setSettings?.((prev) => ({ ...prev, showLiveActivity: checked === true }));
    },
    [setSettings]
  );
```

Replace:

```jsx
        {isExportingLogs && exportStatus && (
          <div className="w-full mt-2 text-sm text-system-gray-600">{exportStatus}</div>
        )}
      </SettingRow>
    </SettingsCard>
```

with:

```jsx
        {isExportingLogs && exportStatus && (
          <div className="w-full mt-2 text-sm text-system-gray-600">{exportStatus}</div>
        )}
      </SettingRow>

      <SettingRow
        label="Show live activity"
        description="A small floating panel shows what the app is doing as it happens, with the raw log lines one tab away. Shortcut: Ctrl+Shift+L (Cmd+Shift+L on Mac)."
      >
        <Switch
          checked={showLiveActivity}
          onChange={handleLiveActivityToggle}
          aria-label="Show live activity"
        />
      </SettingRow>
    </SettingsCard>
```

Replace:

```jsx
DiagnosticsLogsSection.propTypes = {
  addNotification: PropTypes.func
};
```

with:

```jsx
DiagnosticsLogsSection.propTypes = {
  addNotification: PropTypes.func,
  settings: PropTypes.object,
  setSettings: PropTypes.func
};
```

In `src/renderer/components/SettingsPanel.jsx`, replace:

```jsx
                      <DiagnosticsLogsSection addNotification={addNotification} />
```

with:

```jsx
                      <DiagnosticsLogsSection
                        addNotification={addNotification}
                        settings={settings}
                        setSettings={applySettingsUpdate}
                      />
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/components/DiagnosticsLogsSection.liveActivity.test.js test/components/SettingsPanel.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/settings/DiagnosticsLogsSection.jsx src/renderer/components/SettingsPanel.jsx test/components/DiagnosticsLogsSection.liveActivity.test.js
git commit -m "feat(settings): Show live activity switch in Diagnostics"
```

---

## Task 18: Ctrl/Cmd+Shift+L shortcut

**Files:**

- Modify: `src/renderer/hooks/useKeyboardShortcuts.js` (imports; callbacks ~line 72; `actions`
  ~line 79; `handleKeyDown` after the settings shortcut ~line 104)
- Modify: `test/useKeyboardShortcuts.test.js`

The shortcut sits right after Ctrl+, so it works from anywhere: inside text fields and while an
overlay or Settings is open (it only flips a setting; it does not mutate files or navigate).

- [ ] **Step 1: Write the failing test**

In `test/useKeyboardShortcuts.test.js`, replace:

```js
// Import after mocks
import { useKeyboardShortcuts } from '../src/renderer/hooks/useKeyboardShortcuts';
import { hasActiveOverlay } from '../src/renderer/utils/overlayStack';
```

with:

```js
jest.mock('../src/renderer/store/thunks/liveActivityThunks', () => ({
  toggleShowLiveActivity: jest.fn(() => ({ type: 'test/toggleShowLiveActivity' }))
}));

// Import after mocks
import { useKeyboardShortcuts } from '../src/renderer/hooks/useKeyboardShortcuts';
import { hasActiveOverlay } from '../src/renderer/utils/overlayStack';
import { toggleShowLiveActivity } from '../src/renderer/store/thunks/liveActivityThunks';
```

Replace:

```js
  describe('Ctrl+, (Settings)', () => {
    test('opens settings when settings are closed', () => {
```

with:

```js
  describe('Ctrl/Cmd+Shift+L (Live activity)', () => {
    test('Ctrl+Shift+L toggles the live activity panel', () => {
      renderShortcuts();
      const event = fireKey('L', { ctrl: true, shift: true });
      expect(event.preventDefault).toHaveBeenCalled();
      expect(toggleShowLiveActivity).toHaveBeenCalledTimes(1);
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'test/toggleShowLiveActivity' });
    });

    test('Cmd+Shift+L works on macOS', () => {
      renderShortcuts();
      fireKey('l', { meta: true, shift: true });
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'test/toggleShowLiveActivity' });
    });

    test('works while an overlay is open', () => {
      hasActiveOverlay.mockReturnValue(true);
      renderShortcuts();
      fireKey('L', { ctrl: true, shift: true });
      expect(mockDispatch).toHaveBeenCalledWith({ type: 'test/toggleShowLiveActivity' });
    });

    test('Ctrl+L without Shift does nothing', () => {
      renderShortcuts();
      const event = fireKey('l', { ctrl: true });
      expect(event.preventDefault).not.toHaveBeenCalled();
      expect(toggleShowLiveActivity).not.toHaveBeenCalled();
    });

    test('Ctrl+Alt+Shift+L does nothing', () => {
      renderShortcuts();
      fireKey('L', { ctrl: true, shift: true, alt: true });
      expect(toggleShowLiveActivity).not.toHaveBeenCalled();
    });
  });

  describe('Ctrl+, (Settings)', () => {
    test('opens settings when settings are closed', () => {
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/useKeyboardShortcuts.test.js`

Expected: FAIL — `Ctrl+Shift+L toggles the live activity panel`: `toggleShowLiveActivity` was
called 0 times.

- [ ] **Step 3: Add the shortcut**

In `src/renderer/hooks/useKeyboardShortcuts.js`, replace:

```js
import { dispatchAcked } from '../utils/dispatchAcked';
```

with:

```js
import { dispatchAcked } from '../utils/dispatchAcked';
import { toggleShowLiveActivity } from '../store/thunks/liveActivityThunks';
```

Replace:

```js
  const handleLeaveDashboard = useCallback(() => {
    dispatch(setViewMode('phased'));
    dispatch(setCameFromDashboard(true));
  }, [dispatch]);

  const actions = useMemo(
    () => ({
      openSettings: handleOpenSettings,
      requestCloseSettings,
      advancePhase: handleAdvancePhase,
      leaveDashboard: handleLeaveDashboard
    }),
    [handleOpenSettings, requestCloseSettings, handleAdvancePhase, handleLeaveDashboard]
  );
```

with:

```js
  const handleLeaveDashboard = useCallback(() => {
    dispatch(setViewMode('phased'));
    dispatch(setCameFromDashboard(true));
  }, [dispatch]);

  const handleToggleLiveActivity = useCallback(() => {
    dispatch(/** @type {any} */ (toggleShowLiveActivity()));
  }, [dispatch]);

  const actions = useMemo(
    () => ({
      openSettings: handleOpenSettings,
      requestCloseSettings,
      advancePhase: handleAdvancePhase,
      leaveDashboard: handleLeaveDashboard,
      toggleLiveActivity: handleToggleLiveActivity
    }),
    [
      handleOpenSettings,
      requestCloseSettings,
      handleAdvancePhase,
      handleLeaveDashboard,
      handleToggleLiveActivity
    ]
  );
```

Replace:

```js
          actions.openSettings();
        }
        return;
      }

      if (isEditableTarget(event.target)) {
        return;
      }
```

with:

```js
          actions.openSettings();
        }
        return;
      }

      // Ctrl/Cmd+Shift+L: show or hide the Live Activity panel. Works from
      // anywhere (text fields, open overlays) — it only flips a setting.
      const liveActivityShortcut =
        (event.ctrlKey || event.metaKey) &&
        event.shiftKey &&
        !event.altKey &&
        (event.code === 'KeyL' || String(event.key || '').toLowerCase() === 'l');
      if (liveActivityShortcut) {
        event.preventDefault();
        actions.toggleLiveActivity();
        return;
      }

      if (isEditableTarget(event.target)) {
        return;
      }
```

- [ ] **Step 4: Run the tests and confirm they pass**

Run: `fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/useKeyboardShortcuts.test.js test/keyboard-shortcuts.test.js`

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/hooks/useKeyboardShortcuts.js test/useKeyboardShortcuts.test.js
git commit -m "feat(live-activity): Ctrl/Cmd+Shift+L toggles the Live Activity panel"
```

---

## Task 19: Docs and changelog

**Files:**

- Modify: `docs/USER_GUIDE.md` ("### Need to see logs", ~line 277)
- Modify: `docs/DEBUGGING_GUIDE.md` (new section before "## Tests", ~line 446)
- Modify: `CHANGELOG.md` (`[Unreleased]` → `### Added`, after the "Automatic file fingerprints"
  bullet, ~line 74)

No test: Markdown is outside `format:check`; lint-staged runs `prettier --write` (proseWrap always,
width 100) on commit.

- [ ] **Step 1: User guide**

In `docs/USER_GUIDE.md`, replace:

```md
- Open **Settings -> Diagnostics** (Advanced) and use **Open Folder** or **Export Logs**.
- Use **Open Folder** to browse logs or **Export Logs** to create a shareable file.
```

with:

```md
- Open **Settings -> Diagnostics** (Advanced) and use **Open Folder** or **Export Logs**.
- Use **Open Folder** to browse logs or **Export Logs** to create a shareable file.
- To watch what the app is doing as it happens, turn on **Settings -> Diagnostics -> Show live
  activity** or press **Ctrl+Shift+L** (**Cmd+Shift+L** on Mac). A small panel floats over the app:
  **Activity** lists events in plain words ("Analyzing receipt.jpg", "Vision model ready") and
  **Raw** shows the log lines themselves, with level and context filters. Drag it by its title,
  resize it from the bottom-right corner, minimize it to a pill, pause, copy or clear it. It shows
  the same redacted lines the log file holds; with **Redact paths** on it also hides file names.
```

- [ ] **Step 2: Debugging guide**

In `docs/DEBUGGING_GUIDE.md`, replace:

```md
## Tests

### Test passes standalone but fails in the full suite
```

with:

```md
## Live activity panel

### Watching log lines without opening the log file

Turn on **Settings → Diagnostics → Show live activity** (Advanced mode) or press Ctrl/Cmd+Shift+L.
The **Raw** tab shows every record the main-process logger writes at the current level, already
sanitized (debug lines only appear when the level is debug, as in `npm run dev`). The **Activity**
tab is a plain-language view built by `src/main/services/liveLogActivity.js`. When a source log
message changes, update its rule there and its row in `test/main/services/liveLogActivity.test.js`,
or the event only shows in **Raw**.

### The panel says "Live activity unavailable"

**Cause.** The `system:live-log:subscribe` invoke failed: a preload built before the bridge existed,
or the handler in `src/main/ipc/system.js` was not registered.

**Fix.** Run `npm run generate:channels:check` and `npm run verify:ipc-handlers`, then restart
`npm run dev` so preload and main are rebuilt together.

### "N skipped (too fast)"

The feed sends at most 200 entries every 250 ms. During a burst the oldest entries of that window
are left out of the panel (never out of the log file). Use **Open folder** for the full log.

## Tests

### Test passes standalone but fails in the full suite
```

- [ ] **Step 3: Changelog**

In `CHANGELOG.md`, replace:

```md
  work without running Settings → **Reindex file hashes**. That action is now only a backfill for
  files indexed by an older version.

### Changed
```

with:

```md
  work without running Settings → **Reindex file hashes**. That action is now only a backfill for
  files indexed by an older version.
- **Live activity panel.** Settings → Diagnostics → **Show live activity** (or Ctrl/Cmd+Shift+L)
  opens a small floating panel that shows what the app is doing as it happens: an **Activity** tab
  in plain words and a **Raw** tab with the log lines (level and context filters). Drag it, resize
  it, minimize it to a pill, pause, copy or clear it. It shows the same redacted records the log
  file gets, and with **Redact paths** on it also hides file names. Off by default; nothing is
  collected while it is closed.

### Changed
```

- [ ] **Step 4: Check the Markdown wraps**

Run: `fnm exec --using=24.22.1 -- npx.cmd prettier --check docs/USER_GUIDE.md docs/DEBUGGING_GUIDE.md CHANGELOG.md`

Expected: exit 0. If it reports a file, run the same command with `--write` and re-read the diff.

- [ ] **Step 5: Commit**

```bash
git add docs/USER_GUIDE.md docs/DEBUGGING_GUIDE.md CHANGELOG.md
git commit -m "docs: live activity panel in the user guide, debugging guide and changelog"
```

---

## Task 20: Ratchet floor bump and final verification

**Files:**

- Modify: `scripts/verify-checkjs-ratchet.js` (line 46)

Seven new `.js` files under `src/` carry `// @ts-check`: `src/main/services/liveLogActivity.js`,
`src/main/services/liveLogFeed.js`, `src/renderer/store/thunks/liveActivityThunks.js`,
`src/renderer/hooks/useDraggablePanel.js`, `src/renderer/hooks/useLiveLogFeed.js`,
`src/renderer/components/diagnostics/liveActivityPanelState.js`,
`src/renderer/components/diagnostics/liveActivityFormat.js`. 475 + 7 = 482.

- [ ] **Step 1: Confirm the ratchet reports the new count**

Run: `fnm exec --using=24.22.1 -- npm.cmd run verify:checkjs-ratchet`

Expected: `482/482 src .js files opted in (floor 475)` and an `INFO: floor can ratchet up to 482`.

- [ ] **Step 2: Bump the floor**

In `scripts/verify-checkjs-ratchet.js`, replace:

```js
const GLOBAL_DIRECTIVE_FLOOR = 475;
```

with:

```js
const GLOBAL_DIRECTIVE_FLOOR = 482;
```

Run: `fnm exec --using=24.22.1 -- npm.cmd run verify:checkjs-ratchet`

Expected: `482/482 src .js files opted in (floor 482), 0 failures.`

- [ ] **Step 3: Run every feature test together**

Run:
`fnm exec --using=24.22.1 -- npx.cmd jest -c test/jest.config.js --coverage=false --maxWorkers=2 test/logger.liveRecordListener.test.js test/logger.test.js test/main/services/liveLogActivity.test.js test/main/services/liveLogFeed.test.js test/liveLogChannels.test.js test/ipcEnforcement.test.js test/ipcEventSchemas.liveLog.test.js test/ipcEventSchemas.test.js test/systemIpc.liveLog.test.js test/systemIpc.test.js test/ipcServices.liveLog.test.js test/ipcServices.test.js test/preload.coverage.test.js test/preload.contract.test.js test/securityConfig.test.js test/settings.showLiveActivity.test.js test/settings-keyset-parity.test.js test/ux/zIndexLayering.test.js test/liveActivityThunks.test.js test/components/liveActivityPanelState.test.js test/components/liveActivityFormat.test.js test/hooks/useDraggablePanel.test.js test/hooks/useLiveLogFeed.test.js test/components/LiveActivityPanel.test.js test/components/App.viewMode.test.js test/components/DiagnosticsLogsSection.liveActivity.test.js test/components/SettingsPanel.test.js test/useKeyboardShortcuts.test.js`

Expected: all suites PASS.

- [ ] **Step 4: Run the static checks one at a time (each must exit 0)**

```bash
fnm exec --using=24.22.1 -- npm.cmd run format:check
fnm exec --using=24.22.1 -- npm.cmd run lint
fnm exec --using=24.22.1 -- npm.cmd run typecheck
fnm exec --using=24.22.1 -- npm.cmd run typecheck:js
fnm exec --using=24.22.1 -- npm.cmd run verify:checkjs-ratchet
fnm exec --using=24.22.1 -- npm.cmd run generate:channels:check
fnm exec --using=24.22.1 -- npm.cmd run verify:ipc-handlers
fnm exec --using=24.22.1 -- npm.cmd run verify:ipc-handler-schemas
fnm exec --using=24.22.1 -- npm.cmd run verify:ipc-event-schemas
fnm exec --using=24.22.1 -- npm.cmd run verify:ipc-enforcement
fnm exec --using=24.22.1 -- npm.cmd run verify:ipc-contracts
fnm exec --using=24.22.1 -- npm.cmd run verify:env-docs
fnm exec --using=24.22.1 -- npm.cmd run knip:files
```

Expected: every command exits 0. `lint` must show no jsx-a11y errors for
`src/renderer/components/diagnostics/LiveActivityPanel.jsx`. `knip:files` must not list any new
file as unused (each is reachable: classifier → feed → `system.js`; hooks/helpers/thunk → panel →
App.js lazy import; thunk → `useKeyboardShortcuts`).

- [ ] **Step 5: Optional manual smoke (only if memory allows `npm run dev`)**

1. `fnm exec --using=24.22.1 -- npm.cmd run dev`.
2. Press Ctrl+Shift+L: the panel appears bottom-right; Activity fills while analyzing a file.
3. Drag it, resize it, minimize it (pill pulses while logging), restore, switch to Raw, filter to
   `warn`, copy, clear, close. Reopen from Settings → Diagnostics (Advanced): layout and tab are
   remembered.
4. Turn on **Redact paths**: file names show as "a file".

- [ ] **Step 6: Commit**

```bash
git add scripts/verify-checkjs-ratchet.js
git commit -m "chore(checkjs): raise the directive floor to 482 for the live activity files"
```

---

## Spec coverage map

| Spec section                                              | Task(s)          |
| --------------------------------------------------------- | ---------------- |
| Open/close: Settings switch + Ctrl/Cmd+Shift+L, same setting | 10, 17, 18     |
| Panel layer `--z-floating-panel: 300` + layering test     | 9, 15            |
| Drag by title bar, clamped (incl. window shrink)          | 13, 15           |
| Resize bottom-right, min 320×220, max 80%                 | 13, 15           |
| Minimize to pill, pulse within 3 s, restore, close        | 14, 15           |
| Activity tab (time, icon, plain text, problems w/ context) | 2, 12, 15       |
| Raw tab (level badge, context, message, one-line JSON, expand) | 3, 12, 15   |
| Pause/resume with count, auto-scroll + scroll-up detection, copy, clear | 14, 15 |
| Raw level + context filters                               | 12, 15           |
| `showLiveActivity` setting on four surfaces               | 8                |
| Geometry/minimized/tab in localStorage with try/catch     | 11, 15           |
| Privacy: sanitized records; Redact paths hides basenames  | 1, 12, 15        |
| Logger hook (sanitized, level-gated, errors swallowed)    | 1                |
| `liveLogFeed` (listener only while subscribed, ring 500, 250 ms, ≤200 + dropped, auto-unsubscribe) | 3 |
| `activityFromLogRecord` rule table                        | 2                |
| IPC channels, preload, Zod, event schema, verify scripts  | 4, 5, 6, 7       |
| `useLiveLogFeed`, `useDraggablePanel`, panel, mount       | 13, 14, 15, 16   |
| Error handling ("Live activity unavailable", failures swallowed) | 1, 3, 6, 14, 15 |
| Performance (no listener/timer idle; caps; virtualization) | 1, 3, 14, 15    |
| Accessibility (labelled region, named controls, reduced motion) | 15       |
| Docs + changelog + ratchet                                | 19, 20           |

<!-- prettier-ignore-end -->
