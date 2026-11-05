// @ts-check
/**
 * Near-duplicate count for the graph tab's insight badge.
 *
 * The count comes from a scan that compares every indexed vector with every
 * other one in the main process. It used to rerun on every change to the
 * indexed-file count — and during a batch that count moves every couple of
 * seconds — so the scan ran back to back for as long as the batch did.
 *
 * Now the first scan for an open graph tab still runs at once, but a rescan
 * waits until the file count has held still for RESCAN_SETTLE_MS, and never
 * starts sooner than RESCAN_MIN_GAP_MS after the previous one. A first scan
 * whose result was dropped because the count moved under it counts as a scan
 * here too, so a batch cannot set off one full scan per stats refresh.
 *
 * Sets the user chose to "Keep all" in the duplicate dialog are not counted.
 */
import { useEffect, useRef } from 'react';
import { loadDismissed, signatureForScannedGroup } from '../../organize/duplicateDismissals';

/**
 * The badge numbers for a scan result, leaving out the kept sets.
 * @param {any} result
 * @returns {{ groupCount: number, totalDuplicates: number }}
 */
function countUnkeptDuplicates(result) {
  const groups = Array.isArray(result?.groups) ? result.groups : [];
  const reported = Number.isFinite(result?.totalDuplicates) ? result.totalDuplicates : 0;
  const dismissed = loadDismissed();
  if (dismissed.size === 0) return { groupCount: groups.length, totalDuplicates: reported };
  let groupCount = 0;
  let keptMembers = 0;
  for (const group of groups) {
    if (dismissed.has(signatureForScannedGroup(group))) {
      const members = Array.isArray(group?.members) ? group.members.length : 0;
      keptMembers += Number.isFinite(group?.memberCount) ? group.memberCount : members;
    } else {
      groupCount += 1;
    }
  }
  return { groupCount, totalDuplicates: Math.max(0, reported - keptMembers) };
}

/** The file count must hold still this long before a rescan. */
export const RESCAN_SETTLE_MS = 5000;
/** At most one rescan per this window. */
export const RESCAN_MIN_GAP_MS = 30000;

/**
 * @param {{
 *   enabled: boolean,
 *   fileCount: number | null | undefined,
 *   isComputingClusters: boolean,
 *   setDuplicateSummary: (update: any) => void,
 *   lastDuplicateFileCountRef: { current: number | null }
 * }} args
 */
export function useDuplicateBadgeScan({
  enabled,
  fileCount,
  isComputingClusters,
  setDuplicateSummary,
  lastDuplicateFileCountRef
}) {
  /** When the last scan started; 0 means none yet. */
  const lastScanStartedAtRef = useRef(0);

  // Deferred until cluster loading completes to avoid saturating IPC during startup.
  useEffect(() => {
    let cancelled = false;
    if (!enabled) return undefined;
    if (isComputingClusters) return undefined;
    if (!fileCount || fileCount < 2) {
      lastDuplicateFileCountRef.current = null;
      setDuplicateSummary((/** @type {any} */ prev) => ({
        ...prev,
        loading: false,
        groupCount: 0,
        totalDuplicates: 0
      }));
      return undefined;
    }

    // Skip if file count hasn't changed since last scan
    if (lastDuplicateFileCountRef.current === fileCount) return undefined;

    const run = async () => {
      lastScanStartedAtRef.current = Date.now();
      setDuplicateSummary((/** @type {any} */ prev) => ({ ...prev, loading: true }));
      try {
        const result = await /** @type {any} */ (window).electronAPI?.embeddings?.findDuplicates?.({
          threshold: 0.9,
          maxResults: 20
        });
        if (cancelled) return;
        lastDuplicateFileCountRef.current = fileCount;
        if (result?.success) {
          setDuplicateSummary({ loading: false, ...countUnkeptDuplicates(result) });
          return;
        }
      } catch {
        // Non-critical insight card enrichment failure.
      }
      if (!cancelled) {
        setDuplicateSummary((/** @type {any} */ prev) => ({ ...prev, loading: false }));
      }
    };

    // Nothing shown yet for this tab and no scan started: answer straight
    // away. Once a scan has started (even one whose result was dropped
    // because the count moved), later changes take the settle path below.
    if (lastDuplicateFileCountRef.current === null && lastScanStartedAtRef.current === 0) {
      run();
      return () => {
        cancelled = true;
      };
    }

    // A rescan. Every change to the count re-runs this effect and clears the
    // pending timer, so the wait restarts until the count settles.
    const sinceLast = Date.now() - lastScanStartedAtRef.current;
    const wait = Math.max(RESCAN_SETTLE_MS, RESCAN_MIN_GAP_MS - sinceLast);
    const timer = setTimeout(run, wait);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [enabled, fileCount, isComputingClusters, setDuplicateSummary, lastDuplicateFileCountRef]);
}
