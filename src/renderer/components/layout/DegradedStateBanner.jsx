import React, { useEffect, useState, useCallback } from 'react';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { fetchDegradedState, dismissDegradedFlag } from '../../store/slices/systemSlice';
import { whisperIpc } from '../../services/ipc';
import { createLogger } from '../../../shared/logger';

const bannerLogger = createLogger('DegradedStateBanner');

/**
 * Action codes the banner knows how to invoke. Each entry maps the
 * `flag.detail.action.code` set by the main-process subsystem to the
 * concrete renderer function that executes it. Adding a new actionable
 * flag means: (a) raise it from the service with `detail.action.code`,
 * and (b) wire the executor here.
 */
const ACTION_EXECUTORS = {
  'whisper.install-model': async () => {
    // installVad: false because VAD is opt-in (only loaded when the
    // service is configured to enable VAD; downloading it preemptively
    // wastes disk for the majority of users).
    return whisperIpc.installModel({ installVad: false });
  },
  'embeddings.full-rebuild': async () => {
    // Raised by OramaVectorService when an embedding model change wipes the
    // vector index; the FULL_REBUILD handler clears the flag on success.
    const fullRebuild = window?.electronAPI?.embeddings?.fullRebuild;
    if (typeof fullRebuild !== 'function') {
      throw new Error('Embeddings rebuild API is unavailable');
    }
    return fullRebuild();
  }
};

// Idle polling cadence escalates the longer we go without seeing any flags.
// Most users never trigger a degraded-state event, so the original flat 30s
// interval generated 120+ no-op IPCs/hour. Backoff caps at 5 min so users
// still see new flags promptly when something actually goes wrong.
const POLL_INTERVAL_BASE_MS = 30_000;
const POLL_INTERVAL_MAX_MS = 5 * 60_000;
// Number of consecutive empty polls before we start backing off
const POLL_BACKOFF_AFTER_EMPTY = 5;

// Renderer-local state-migration signals set by `src/renderer/store/migrations.js`
// before React mounts. Each flag is set with a structured detail payload
// (e.g. `{ rawVersion, currentVersion }`) describing why state was discarded.
// Without this surfacing, a user who downgrades the app or installs over
// corrupt persisted state would see their workspace silently reset to the
// welcome phase with no explanation. See migrations.js:118-127 for the setter.
const MIGRATION_FLAG_DEFINITIONS = [
  {
    windowKey: '__STRATOSORT_STATE_FUTURE_VERSION__',
    code: 'state-migration.future-version',
    severity: 'warning',
    message:
      'Your saved workspace state was created by a newer version of StratoSort and could not be loaded by this build. Recent selections, file states, and analysis results were reset. Reinstall the newer version to recover them.'
  },
  {
    windowKey: '__STRATOSORT_STATE_INVALID_VERSION__',
    code: 'state-migration.invalid-version',
    severity: 'error',
    message:
      "Your saved workspace state had an invalid version tag and couldn't be loaded safely. Recent selections, file states, and analysis results were reset. Smart folders and settings should still be intact."
  },
  {
    windowKey: '__STRATOSORT_STATE_MIGRATION_GAP__',
    code: 'state-migration.gap',
    severity: 'error',
    message:
      "Your saved workspace state needs an upgrade step that this build is missing — it couldn't be loaded safely. Recent selections, file states, and analysis results were reset. Smart folders and settings should still be intact."
  },
  {
    windowKey: '__STRATOSORT_STATE_SHAPE_RECOVERED__',
    code: 'state-migration.shape-recovered',
    severity: 'warning',
    message:
      'Some saved workspace data was malformed and had to be reset to defaults during state migration. If you notice missing settings or smart folders, this is why.'
  },
  {
    windowKey: '__STRATOSORT_STATE_RESTORED_FROM_BACKUP__',
    code: 'state-migration.restored-from-backup',
    severity: 'warning',
    message:
      'Your saved workspace state was corrupted and has been restored from the most recent backup. Changes made in your last session may be missing.'
  }
];

/**
 * Read the migration flags from `window` once. Returns the array of synthetic
 * flag entries that look like the main-process flags the banner already
 * renders. Reading is one-shot at component mount because migrations only run
 * during boot.
 */
function readMigrationFlagsFromWindow() {
  if (typeof window === 'undefined') return [];
  const now = Date.now();
  return MIGRATION_FLAG_DEFINITIONS.filter((def) => Boolean(window[def.windowKey])).map((def) => {
    const detail = window[def.windowKey];
    return {
      code: def.code,
      subsystem: 'state-migration',
      severity: def.severity,
      message: def.message,
      detail: typeof detail === 'object' ? detail : undefined,
      raisedAt: now,
      lastSeenAt: now,
      count: 1,
      dismissed: false,
      // Marker so the dismiss handler knows to clear the window flag
      // rather than dispatching the IPC dismiss action (which would
      // 404 — these codes don't exist in the main-process tracker).
      _migrationFlagWindowKey: def.windowKey
    };
  });
}

/**
 * Renders a dismissible banner when one or more main-process subsystems have
 * raised a degraded-state flag (e.g. vector DB persistence corrupt, journaling
 * init failed). Polls via IPC; subsystems can also push via the event bridge in
 * future iterations.
 *
 * Severity maps:
 *   error   -> red/destructive; prominent call-to-action required
 *   warning -> amber; informational, dismissible without action
 *
 * Also surfaces renderer-local state-migration signals (see
 * MIGRATION_FLAG_DEFINITIONS above) so the user gets an explanation when
 * persisted state is discarded — previously these signals were set on
 * `window.__STRATOSORT_STATE_*__` but no UI consumed them.
 */
function DegradedStateBanner() {
  const dispatch = useAppDispatch();
  const flags = useAppSelector((state) => state.system.degradedFlags);
  // Renderer-local load failures that previously sat unread in Redux: smart
  // folders or settings failing to load left the user with empty lists and
  // default settings with no explanation. Surfaced here as synthetic flags;
  // they clear automatically when the next successful load resets the error.
  const smartFoldersError = useAppSelector((state) => state.files.smartFoldersError);
  const settingsError = useAppSelector((state) => state.ui.settingsError);
  const [dismissedLocalCodes, setDismissedLocalCodes] = useState(() => new Set());
  const [migrationFlags, setMigrationFlags] = useState(() => readMigrationFlagsFromWindow());
  // Per-flag action state — keyed by flag.code so a slow whisper install
  // doesn't disable buttons on unrelated flags. Each entry tracks the
  // in-flight state and the most recent error message (rendered inline
  // so a failed install doesn't silently leave the user wondering).
  const [actionState, setActionState] = useState({});

  const runAction = useCallback(
    async (flag) => {
      const action = flag?.detail?.action;
      if (!action?.code) return;
      const executor = ACTION_EXECUTORS[action.code];
      if (!executor) {
        bannerLogger.warn('No executor wired for action code', { code: action.code });
        return;
      }
      // Soft confirm via window.confirm rather than a modal — the
      // banner is intentionally minimal and a full modal would be
      // disproportionate for a single-button action. The confirm
      // string comes from the flag's action payload so each
      // subsystem can phrase its own prompt.
      if (action.confirm && !window.confirm(action.confirm)) return;
      setActionState((prev) => ({ ...prev, [flag.code]: { running: true } }));
      try {
        const result = await executor();
        if (result && result.success === false) {
          throw new Error(result.error || 'Action failed');
        }
        // On success the main-process handler clears the degraded flag
        // (see ipc/whisper.js INSTALL_MODEL handler). Refresh from the
        // tracker so the banner removes itself without a polling delay.
        dispatch(fetchDegradedState());
        setActionState((prev) => {
          const next = { ...prev };
          delete next[flag.code];
          return next;
        });
      } catch (error) {
        bannerLogger.error('Banner action failed', {
          code: action.code,
          message: error?.message
        });
        setActionState((prev) => ({
          ...prev,
          [flag.code]: { running: false, error: error?.message || 'Action failed' }
        }));
      }
    },
    [dispatch]
  );

  useEffect(() => {
    // Adaptive polling: start at base interval, exponentially back off when
    // results stay empty, snap back to base as soon as anything appears.
    let cancelled = false;
    let timeoutId = null;
    let consecutiveEmpty = 0;

    const tick = async () => {
      if (cancelled) return;
      try {
        const dispatched = dispatch(fetchDegradedState());
        const result = dispatched?.unwrap ? await dispatched.unwrap() : await dispatched;
        if (cancelled) return;
        const hasFlags = Array.isArray(result) && result.length > 0;
        consecutiveEmpty = hasFlags ? 0 : consecutiveEmpty + 1;
      } catch {
        // Slice records the error; treat as empty for backoff purposes.
        if (cancelled) return;
        consecutiveEmpty += 1;
      }
      if (cancelled) return;
      const overshoot = Math.max(0, consecutiveEmpty - POLL_BACKOFF_AFTER_EMPTY);
      const nextDelay = Math.min(
        POLL_INTERVAL_MAX_MS,
        POLL_INTERVAL_BASE_MS * Math.pow(2, overshoot)
      );
      timeoutId = setTimeout(tick, nextDelay);
    };

    tick();
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
    };
  }, [dispatch]);

  // Migration flag dismissal is local-only: clear the window flag (so a
  // hot-reload doesn't resurrect the banner) and drop the entry from local
  // state. We cannot route through the main-process `dismissDegradedFlag`
  // because these codes don't exist in `DegradedStateTracker`.
  const dismissMigrationFlag = useCallback((code) => {
    setMigrationFlags((current) => {
      const target = current.find((flag) => flag.code === code);
      if (target?._migrationFlagWindowKey && typeof window !== 'undefined') {
        try {
          delete window[target._migrationFlagWindowKey];
        } catch {
          // Older Electron builds that froze window globals can't delete; the
          // banner still hides via local state below, just less idempotently.
        }
      }
      return current.filter((flag) => flag.code !== code);
    });
  }, []);

  const now = Date.now();
  const rendererFlags = [
    smartFoldersError && {
      code: 'renderer.smart-folders-load',
      subsystem: 'smart-folders',
      severity: 'error',
      message: `Smart folders could not be loaded — organization suggestions may be incomplete. (${smartFoldersError})`,
      raisedAt: now,
      lastSeenAt: now,
      count: 1,
      dismissed: dismissedLocalCodes.has('renderer.smart-folders-load'),
      _localFlag: true
    },
    settingsError && {
      code: 'renderer.settings-load',
      subsystem: 'settings',
      severity: 'warning',
      message: `Settings could not be loaded — defaults are in effect. (${settingsError})`,
      raisedAt: now,
      lastSeenAt: now,
      count: 1,
      dismissed: dismissedLocalCodes.has('renderer.settings-load'),
      _localFlag: true
    }
  ].filter(Boolean);

  const active = [...(flags || []), ...migrationFlags, ...rendererFlags].filter(
    (flag) => flag && !flag.dismissed
  );
  if (active.length === 0) return null;

  return (
    <div
      role="region"
      aria-label="System health"
      className="flex flex-col gap-1 border-b border-system-gray-200"
    >
      {active.map((flag) => {
        const isError = flag.severity === 'error';
        const bgClass = isError
          ? 'bg-system-red-50 text-system-red-900 border-system-red-200'
          : 'bg-system-yellow-50 text-system-yellow-900 border-system-yellow-200';
        const action = flag.detail?.action;
        const hasExecutor = action?.code && ACTION_EXECUTORS[action.code];
        const flagActionState = actionState[flag.code];
        return (
          <div
            key={flag.code}
            role="alert"
            aria-live={isError ? 'assertive' : 'polite'}
            className={`flex items-start gap-cozy px-4 py-2 text-sm border-l-4 ${bgClass}`}
          >
            <span className="font-medium">{isError ? 'Degraded mode' : 'Warning'}:</span>
            <span className="flex-1 break-words">
              {flag.message}
              {flagActionState?.error ? (
                <span className="block text-xs opacity-80 mt-1">
                  Action failed: {flagActionState.error}
                </span>
              ) : null}
            </span>
            {hasExecutor ? (
              <button
                type="button"
                className="shrink-0 text-xs font-medium underline underline-offset-2 hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={() => runAction(flag)}
                disabled={!!flagActionState?.running}
                aria-label={action.label}
              >
                {flagActionState?.running ? 'Working…' : action.label}
              </button>
            ) : null}
            <button
              type="button"
              className="shrink-0 text-xs underline underline-offset-2 hover:opacity-80"
              onClick={async () => {
                if (flag._migrationFlagWindowKey) {
                  // Renderer-local migration flag: clear window global and
                  // drop from local state. Don't dispatch the IPC action
                  // because the main-process tracker doesn't know this code.
                  dismissMigrationFlag(flag.code);
                } else if (flag._localFlag) {
                  // Renderer-local Redux error flag: dismiss locally; the
                  // main-process tracker doesn't know this code either.
                  setDismissedLocalCodes((prev) => new Set(prev).add(flag.code));
                } else {
                  try {
                    await dispatch(dismissDegradedFlag(flag.code)).unwrap();
                  } catch (error) {
                    // Surface the failure inline (same control as runAction)
                    // so the dismiss is not a silent no-op when IPC rejects.
                    setActionState((prev) => ({
                      ...prev,
                      [flag.code]: {
                        running: false,
                        error: error?.message || error || 'Failed to dismiss'
                      }
                    }));
                  }
                }
              }}
              aria-label={`Dismiss "${flag.message}"`}
            >
              Dismiss
            </button>
          </div>
        );
      })}
    </div>
  );
}

export default DegradedStateBanner;
