import React, { useEffect, useState } from 'react';
import PropTypes from 'prop-types';
import { Text } from '../ui/Typography';

const DEFAULT_INTERVAL_MS = 10000;

/**
 * One line under the smart-folder list that says what the watcher is doing
 * (F-204 / K-20). The watcher status API existed with no renderer consumer,
 * so "add a folder" produced one toast and then silence: nothing said
 * "indexing 240 files" or "this folder is not being watched".
 *
 * Renders nothing when there are no folders, when the bridge is unavailable,
 * or when the call fails — it must never be the thing that breaks Setup.
 */
function WatcherStatusLine({ folderCount, intervalMs = DEFAULT_INTERVAL_MS }) {
  const [status, setStatus] = useState(null);

  useEffect(() => {
    if (!folderCount) {
      setStatus(null);
      return undefined;
    }
    let cancelled = false;
    let timer = null;

    const poll = async () => {
      const api = typeof window !== 'undefined' ? window.electronAPI?.smartFolders : null;
      if (!api || typeof api.watcherStatus !== 'function') {
        if (!cancelled) setStatus(null);
        return;
      }
      try {
        const res = await api.watcherStatus();
        if (cancelled) return;
        setStatus(res?.success && res.status ? res.status : null);
      } catch {
        if (!cancelled) setStatus(null);
      }
    };

    poll();
    timer = setInterval(poll, Math.max(1000, intervalMs));
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [folderCount, intervalMs]);

  if (!folderCount || !status || status.available === false) return null;

  let message;
  let tone = 'text-system-gray-500';
  if (!status.isRunning) {
    message = status.isStarting
      ? 'Starting folder watching…'
      : 'These folders are not being watched — files added later are analyzed only on the next scan. Turn on "Watch smart folders" in Settings → Auto-organize.';
    tone = 'text-stratosort-warning';
  } else {
    const watched = Number(status.watchedCount) || 0;
    const inFlight = (Number(status.queueLength) || 0) + (Number(status.processingCount) || 0);
    const folders = `Watching ${watched} folder${watched === 1 ? '' : 's'}`;
    message =
      inFlight > 0
        ? `${folders} · ${inFlight} file${inFlight === 1 ? '' : 's'} being analyzed`
        : `${folders} · index up to date`;
  }

  return (
    <Text as="span" variant="tiny" className={tone} data-testid="watcher-status" role="status">
      {message}
    </Text>
  );
}

WatcherStatusLine.propTypes = {
  folderCount: PropTypes.number.isRequired,
  intervalMs: PropTypes.number
};
WatcherStatusLine.displayName = 'WatcherStatusLine';

export default WatcherStatusLine;
