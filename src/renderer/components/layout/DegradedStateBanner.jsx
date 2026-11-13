import React, { useEffect, useState, useCallback, useRef } from 'react';
import { useAppDispatch, useAppSelector } from '../../store/hooks';
import { fetchDegradedState, dismissDegradedFlag } from '../../store/slices/systemSlice';
import { whisperIpc, systemIpc } from '../../services/ipc';
import { createLogger } from '../../../shared/logger';

const bannerLogger = createLogger('DegradedStateBanner');

/**
 * Microsoft's "Latest supported Visual C++ Redistributable downloads" page.
 * Must match VC_REDIST_DOWNLOAD_PAGE_URL in src/main/utils/vcRuntimeDetection.js
 * (pinned by test). The URL lives here rather than in the flag payload so the
 * renderer never opens a link the main process handed it; window.open routes
 * through createWindow's setWindowOpenHandler host allowlist.
 */
const VC_REDIST_DOWNLOAD_PAGE_URL =
  'https://learn.microsoft.com/en-us/cpp/windows/latest-supported-vc-redist';

const COPIED_FEEDBACK_MS = 2000;

/**
 * Text for a flag's "Copy details" button: the message plus the code and
 * the underlying system error, which the banner does not show but a bug
 * report needs. Only strings from `detail` are used.
 * @param {any} flag
 * @returns {string}
 */
function buildFlagCopyText(flag) {
  const lines = [String(flag?.message || ''), `Code: ${flag?.code || 'unknown'}`];
  const errno = flag?.detail?.errno;
  const error = flag?.detail?.error;
  if (typeof errno === 'string' && errno) lines.push(`System error: ${errno}`);
  if (typeof error === 'string' && error) lines.push(error);
  return lines.join('\n');
}

function openVcRedistDownloadPage() {
  window.open(VC_REDIST_DOWNLOAD_PAGE_URL, '_blank', 'noopener,noreferrer');
}

/**
 * Action codes the banner knows how to invoke. Each entry maps the
 * `flag.detail.action.code` (or `flag.detail.secondaryAction.code`) set by
 * the main-process subsystem to the concrete renderer function that executes
 * it. Adding a new actionable flag means: (a) raise it from the service with
 * `detail.action.code`, and (b) wire the executor here.
 *
 * An executor resolves to `{ success: false, error }` on failure (shown
 * inline as "Action failed"). It may also resolve to `{ notice }` (a status
 * line shown under the message) and `{ followUp: 'restart' }` (replace the
 * flag's buttons with "Restart StratoSort").
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
  },
  'ai.install-vc-runtime': async () => {
    // Raised by LlamaService when the native engine cannot load because the
    // Microsoft Visual C++ Redistributable is missing. Windows packages carry
    // Microsoft's signed installer; main verifies and runs it elevated (one
    // UAC prompt). Nothing is downloaded. The flag stays up until the app
    // restarts, because the engine only loads in a fresh process.
    const result = await systemIpc.installVcRuntime();
    if (result?.success) {
      return {
        followUp: 'restart',
        notice: result.needsRestart
          ? 'Installed. Windows needs a PC restart to finish; if local AI is still off after restarting StratoSort, restart your PC.'
          : 'Installed. Restart StratoSort to turn local AI on.'
      };
    }
    if (result?.reason === 'not-bundled') {
      // Dev build, or a package without the installer: same page as the
      // "Open download page" button, opened by this click.
      openVcRedistDownloadPage();
      return {
        notice:
          "This copy of StratoSort doesn't include the installer, so Microsoft's download page was opened. Install it, then restart StratoSort."
      };
    }
    if (result?.reason === 'already-installed') {
      // Main found the runtime present and did not run anything; the engine
      // only picks it up in a fresh process.
      return {
        followUp: 'restart',
        notice:
          'The Microsoft Visual C++ Redistributable is already installed. Restart StratoSort to turn local AI on.'
      };
    }
    if (result?.reason === 'signature-unreadable') {
      // PowerShell could not report a signature at all (blocked or limited
      // on managed PCs). Not evidence of a bad file, so no failure wording.
      return {
        notice:
          "StratoSort couldn't check the installer's signature on this PC. Use Open download page instead."
      };
    }
    if (result?.reason === 'install-in-progress') {
      return {
        notice:
          'Another installation is running on this PC. Wait for it to finish, then click Install now again.'
      };
    }
    if (result?.cancelled) {
      return {
        notice:
          'Installation was cancelled. Click Install now to try again (Windows asks for permission), or use Open download page.'
      };
    }
    const exitCode = typeof result?.exitCode === 'number' ? ` (exit code ${result.exitCode})` : '';
    return {
      success: false,
      error: `${result?.error || 'The installer did not finish'}${exitCode}. Try Open download page instead.`
    };
  },
  'ai.open-vc-redist-download': async () => {
    // Opens Microsoft's download page in the browser, only on this click;
    // nothing downloads in-app. The flag stays up: the engine needs an app
    // restart afterwards.
    openVcRedistDownloadPage();
  }
};

/**
 * Follow-up buttons that replace a flag's actions once an action asks for
 * them (`{ followUp }` from an executor).
 */
const FOLLOW_UP_ACTIONS = {
  restart: {
    label: 'Restart StratoSort',
    run: () => systemIpc.relaunchApp()
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
  // Code of the flag whose details were just copied (shows "Copied").
  const [copiedCode, setCopiedCode] = useState(null);
  const copiedTimerRef = useRef(null);

  useEffect(
    () => () => {
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
    },
    []
  );

  const copyFlagDetails = useCallback(async (flag) => {
    const clipboard = typeof navigator !== 'undefined' ? navigator.clipboard : undefined;
    if (!clipboard || typeof clipboard.writeText !== 'function') return;
    try {
      await clipboard.writeText(buildFlagCopyText(flag));
      setCopiedCode(flag.code);
      if (copiedTimerRef.current) clearTimeout(copiedTimerRef.current);
      copiedTimerRef.current = setTimeout(() => {
        copiedTimerRef.current = null;
        setCopiedCode(null);
      }, COPIED_FEEDBACK_MS);
    } catch (error) {
      bannerLogger.warn('Could not copy flag details', { code: flag?.code, error: error?.message });
    }
  }, []);

  const runAction = useCallback(
    async (flag, action = flag?.detail?.action) => {
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
      setActionState((prev) => ({
        ...prev,
        [flag.code]: { running: true, runningCode: action.code }
      }));
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
          if (result?.notice || result?.followUp) {
            next[flag.code] = {
              running: false,
              notice: result.notice,
              followUp: FOLLOW_UP_ACTIONS[result.followUp] ? result.followUp : undefined
            };
          } else {
            delete next[flag.code];
          }
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

  const runFollowUp = useCallback(async (flag, followUpKey) => {
    const followUp = FOLLOW_UP_ACTIONS[followUpKey];
    if (!followUp) return;
    setActionState((prev) => ({
      ...prev,
      [flag.code]: { ...prev[flag.code], running: true, error: undefined }
    }));
    try {
      // A successful relaunch quits this window; nothing to update after.
      await followUp.run();
    } catch (error) {
      bannerLogger.error('Banner follow-up failed', {
        followUp: followUpKey,
        message: error?.message
      });
      setActionState((prev) => ({
        ...prev,
        [flag.code]: {
          ...prev[flag.code],
          running: false,
          error: error?.message || 'Action failed'
        }
      }));
    }
  }, []);

  useEffect(() => {
    // Adaptive polling: start at base interval, exponentially back off when
    // results stay empty, snap back to base as soon as anything appears.
    // Nobody reads the banner while the window is hidden, so polling pauses
    // then and one fetch runs as soon as the window is shown again.
    let cancelled = false;
    let timeoutId = null;
    let consecutiveEmpty = 0;
    let inFlight = false;
    const isHidden = () => typeof document !== 'undefined' && document.hidden;

    const tick = async () => {
      if (cancelled) return;
      timeoutId = null;
      // Hidden: stop here; the visibility listener restarts the loop.
      if (isHidden()) return;
      inFlight = true;
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
      } finally {
        inFlight = false;
      }
      if (cancelled) return;
      const overshoot = Math.max(0, consecutiveEmpty - POLL_BACKOFF_AFTER_EMPTY);
      const nextDelay = Math.min(
        POLL_INTERVAL_MAX_MS,
        POLL_INTERVAL_BASE_MS * Math.pow(2, overshoot)
      );
      timeoutId = setTimeout(tick, nextDelay);
    };

    const onVisibilityChange = () => {
      // A fetch already under way schedules the next one itself.
      if (cancelled || isHidden() || inFlight) return;
      // Shown again: fetch now rather than wait out a backed-off timer.
      if (timeoutId) clearTimeout(timeoutId);
      tick();
    };

    tick();
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      cancelled = true;
      if (timeoutId) clearTimeout(timeoutId);
      document.removeEventListener('visibilitychange', onVisibilityChange);
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
        const secondaryAction = flag.detail?.secondaryAction;
        const hasSecondary = secondaryAction?.code && ACTION_EXECUTORS[secondaryAction.code];
        const flagActionState = actionState[flag.code];
        const running = !!flagActionState?.running;
        const followUpKey = flagActionState?.followUp;
        const followUp = followUpKey ? FOLLOW_UP_ACTIONS[followUpKey] : null;
        const actionButtonClass =
          'shrink-0 text-xs font-medium underline underline-offset-2 hover:opacity-80 disabled:opacity-50 disabled:cursor-not-allowed';
        return (
          <div
            key={flag.code}
            role="alert"
            aria-live={isError ? 'assertive' : 'polite'}
            className={`flex items-start gap-cozy px-4 py-2 text-sm border-l-4 ${bgClass}`}
          >
            <span className="font-medium">{isError ? 'Problem' : 'Warning'}:</span>
            <span className="flex-1 break-words">
              {flag.message}
              {flagActionState?.notice ? (
                <span className="block text-xs opacity-80 mt-1">{flagActionState.notice}</span>
              ) : null}
              {flagActionState?.error ? (
                <span className="block text-xs opacity-80 mt-1">
                  Action failed: {flagActionState.error}
                </span>
              ) : null}
            </span>
            {followUp ? (
              <button
                type="button"
                className={actionButtonClass}
                onClick={() => runFollowUp(flag, followUpKey)}
                disabled={running}
                aria-label={followUp.label}
              >
                {running ? 'Working…' : followUp.label}
              </button>
            ) : null}
            {!followUp && hasExecutor ? (
              <button
                type="button"
                className={actionButtonClass}
                onClick={() => runAction(flag)}
                disabled={running}
                aria-label={action.label}
              >
                {running && flagActionState?.runningCode !== secondaryAction?.code
                  ? 'Working…'
                  : action.label}
              </button>
            ) : null}
            {!followUp && hasSecondary ? (
              <button
                type="button"
                className={actionButtonClass}
                onClick={() => runAction(flag, secondaryAction)}
                disabled={running}
                aria-label={secondaryAction.label}
              >
                {running && flagActionState?.runningCode === secondaryAction.code
                  ? 'Working…'
                  : secondaryAction.label}
              </button>
            ) : null}
            <button
              type="button"
              className="shrink-0 text-xs underline underline-offset-2 hover:opacity-80"
              onClick={() => copyFlagDetails(flag)}
              aria-label={
                copiedCode === flag.code ? 'Copied' : `Copy details for "${flag.message}"`
              }
            >
              {copiedCode === flag.code ? 'Copied' : 'Copy details'}
            </button>
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
