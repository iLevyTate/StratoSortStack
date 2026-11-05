# Live Activity Panel — Design

**Date:** 2026-11-05 · **Repo:** StratoSort Stack · **Status:** approved for planning

## Goal

Let people see what the app is doing while it works: a floating, draggable, minimizable panel inside
the main window that shows a friendly **Activity** feed by default and the real pino log lines in a
**Raw** tab, in near real time.

## Non-goals

- No new log storage, rotation or log-file changes. The panel reads the same records the logger
  already writes.
- No remote/telemetry use. Everything stays in-process.
- No editing, re-running or acting on log entries from the panel.

## User-facing behavior

- **Open/close:** "Show live activity" switch in Settings → Diagnostics (next to the existing logs
  section, `DiagnosticsLogsSection`), and Ctrl/Cmd+Shift+L from anywhere in the app (no existing
  renderer shortcut or menu accelerator uses it). Both toggle the same setting.
- **Panel:** fixed-position card inside the main window, on a new layer token
  `--z-floating-panel: 300` in `src/renderer/styles.css` (above page content and overlays at 200,
  below tooltips 500, modal dialogs 600 and toasts 700); `test/ux/zIndexLayering.test.js` is
  extended to pin it. Drag by the title bar; it is kept fully inside the window (re-clamped when the
  window shrinks). Resize from the bottom-right corner (min 320×220, max 80% of the window).
- **Minimize:** collapses to a small pill ("Live activity"), with a pulsing dot while anything was
  logged in the last 3 s. Clicking the pill restores it. Close hides it (same as the switch off).
- **Tabs:**
  - **Activity** (default): one line per recognized event — time, icon, plain text (e.g. "Analyzing
    receipt-0412.jpg", "Vision model ready", "Filed → Financial", "Saved search index"). Warnings
    and errors from any subsystem always appear, as "Problem: <message>" with the context name.
  - **Raw:** every record — time, level badge (color by level), context tag, message, and the
    record's extra fields as a compact one-line JSON (expand on click).
- **Controls (both tabs):** pause/resume (paused: new entries are counted, not shown), auto-scroll
  that stops when the user scrolls up and resumes at the bottom, copy visible lines, clear. Raw also
  has a minimum-level filter (debug/info/warn/error) and a context filter.
- **Persistence:** the on/off switch is an app setting (`showLiveActivity`, default off), registered
  like other boolean settings: `src/shared/defaultSettings.js`, the allowlist in
  `src/shared/securityConfig.js`, `src/shared/settingsValidation.js` and
  `src/main/ipc/validationSchemas.js`. Position, size, minimized state and selected tab are
  per-machine UI state in `localStorage` (key `stratosort_live_activity_panel`), read/write wrapped
  in try/catch.
- **Privacy:** records are already sanitized by the logger (`sanitizeLogData`: folder paths →
  `[REDACTED_PATH]/<basename>`, sensitive keys redacted, document content never logged). When the
  existing "Redact paths" setting is on, the panel also hides file basenames (shown as "a file").

## Architecture

### Main process

1. **Logger hook** (`src/shared/logger.js`): an opt-in listener API — `addLiveRecordListener(fn)` /
   `removeLiveRecordListener(fn)` — called from `Logger._safeWrite` after the record is written
   (pino or the console fallback; a write that throws announces nothing), with the already-sanitized
   message and data, and only when `this.pino.isLevelEnabled(level)` (so the feed shows exactly what
   the log contains), as `{ time, level, context, msg, data }`. Zero cost when no listener is
   registered. Listener errors are swallowed (never break logging). Renderer messages the app
   already forwards into the main-process log appear too, with no extra work.
2. **`liveLogFeed`** (`src/main/services/liveLogFeed.js`):
   - Registers the logger listener only while ≥1 renderer is subscribed.
   - Ring buffer of the last 500 entries (kept only while subscribed; cleared on last unsubscribe).
   - Each entry gets `id` (monotonic), the raw fields, and `activity` from the classifier (or null).
   - Sends batches to subscribed webContents every 250 ms, at most 200 entries per batch (oldest
     dropped first beyond that, with a `dropped` count in the batch).
   - Unsubscribes automatically when a webContents is destroyed.
3. **`activityFromLogRecord`** (`src/main/services/liveLogActivity.js`): pure function. A table of
   rules keyed by `context` + message match → `{ kind, icon, text, file?, tone }`. Initial rules
   (exact strings confirmed against the code during implementation):
   - Smart-folder watcher: analyzing file / analysis complete
   - Image / document analysis success (with category) and new-folder suggestions
   - Vision runtime starting / ready / shutting down; vision batch entered / exited
   - Embedding model loading / unloaded; embedding queue batch flushed
   - Vector store persisted (which collections); storage full raised / cleared
   - Organize: file moved (from → folder), undo
   - Downloads watcher: new download / held for disk full
   - Search index built; startup knowledge repair summary
   - Any `warn`/`error` record → "Problem: …" (tone warn/error)
4. **IPC:**
   - Invoke `system:live-log:subscribe` → returns `{ entries: backlog }` and starts streaming to the
     sender; `system:live-log:unsubscribe`.
   - Push event `system:live-log:batch` → `{ entries, dropped }` (event-only channel).
   - Channels added to `src/shared/constants.js`, preload allowlist, Zod schemas
     (`validationSchemas.js`), event schema (`ipcEventSchemas.js`), so the existing verify scripts
     pass (`generate:channels:check`, `verify:ipc-handlers`, `verify:ipc-handler-schemas`,
     `verify:ipc-event-schemas`).

### Renderer

- **`useLiveLogFeed()`** hook: subscribes while the panel is open (not minimized-closed: a minimized
  panel stays subscribed so the pulse works), keeps up to 500 entries in component state, handles
  pause buffering, unsubscribes on unmount/close.
- **`LiveActivityPanel.jsx`** (`src/renderer/components/diagnostics/`): the floating card, pill,
  tabs, controls; rows virtualized with `react-window` (already a dependency).
- **`useDraggablePanel()`** hook: pointer-event drag + resize with clamping to the window, persisted
  geometry; keyboard: the title bar is focusable, arrow keys move by 16 px.
- Mounted once at the app root (`AppProviders`/`App.js`) behind the `showLiveActivity` setting.
- Settings → Diagnostics: switch row; global shortcut via the existing `useKeyboardShortcuts`.

## Error handling

- Feed/IPC failures never affect logging or the app: listener errors swallowed, `safeSend` failures
  ignored, a failed subscribe shows "Live activity unavailable" in the panel.
- If the window is destroyed, the feed drops that subscriber; no timers run without subscribers.

## Performance

- No listener, buffer or timer while nobody is subscribed.
- Batches every 250 ms, ≤200 entries; renderer keeps ≤500 rows, virtualized.
- Pause stops rendering new rows, not receiving (counts shown).

## Accessibility

- Panel is a labelled region; title bar is a button-like drag handle with aria-label; all controls
  are buttons with names; minimized pill is a button; respects reduced motion (no pulse animation).
- jsx-a11y and the axe e2e gate must stay clean.

## Testing

- `liveLogActivity`: table-driven tests for each rule, plus warn/error mapping and unknown records →
  null.
- `liveLogFeed`: no listener without subscribers; backlog on subscribe; batching cadence and caps;
  dropped count; auto-unsubscribe on destroyed webContents; listener removed on last unsubscribe.
- Logger hook: listener receives sanitized records (paths redacted), respects level, listener
  throwing does not break logging.
- IPC: schemas and channel verify scripts.
- Renderer: panel opens from the switch and the shortcut; drag clamps to window; resize min/max;
  minimize/restore and pulse; pause/resume; level/context filters; copy; Redact-paths hides file
  names; geometry persists and survives a localStorage exception.
