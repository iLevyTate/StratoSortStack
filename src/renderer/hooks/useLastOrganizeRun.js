// @ts-check
import { useCallback, useEffect, useState } from 'react';
import { useAppDispatch, useAppSelector } from '../store/hooks';
import { selectLastOrganizeRun } from '../store/selectors';
import { setLastOrganizeRun as setLastOrganizeRunAction } from '../store/slices/filesSlice';
import { summaryTimeLeft } from '../utils/organizeRunSummary';

/**
 * The summary of the last organize run, for the screens that show it.
 *
 * A run that left files unmoved keeps its summary until it is dismissed or the
 * next run starts. A run that moved everything keeps it for
 * CLEAN_RUN_SUMMARY_MS from the moment it finished, on whichever screen is
 * open; a screen opened after that does not show it.
 *
 * `finishedWhileOpen` is true when the run finished after this screen opened.
 * A summary that was already there (from an earlier visit, or restored at
 * launch) is not news, so a screen does not announce it as an alert.
 *
 * @returns {{
 *   lastOrganizeRun: import('../utils/organizeRunSummary').OrganizeRunSummary | null,
 *   finishedWhileOpen: boolean,
 *   setLastOrganizeRun: (summary: any) => void,
 *   dismissLastOrganizeRun: () => void
 * }}
 */
export function useLastOrganizeRun() {
  const dispatch = useAppDispatch();
  const stored = useAppSelector(selectLastOrganizeRun);

  // A summary that finished before this screen opened is judged against the
  // time it opened; one that finishes later always has time left, and the
  // timer below clears it.
  const [openedAt] = useState(() => Date.now());
  const lastOrganizeRun = summaryTimeLeft(stored, openedAt) > 0 ? stored : null;
  const finishedAt = lastOrganizeRun?.finishedAt ?? null;
  const finishedWhileOpen = finishedAt !== null && finishedAt >= openedAt;

  useEffect(() => {
    if (!stored) return undefined;
    const timeLeft = summaryTimeLeft(stored, Date.now());
    if (timeLeft === Infinity) return undefined;
    const id = setTimeout(() => dispatch(setLastOrganizeRunAction(null)), timeLeft);
    return () => clearTimeout(id);
  }, [stored, dispatch]);

  const setLastOrganizeRun = useCallback(
    (/** @type {any} */ summary) => dispatch(setLastOrganizeRunAction(summary)),
    [dispatch]
  );
  const dismissLastOrganizeRun = useCallback(
    () => dispatch(setLastOrganizeRunAction(null)),
    [dispatch]
  );

  return { lastOrganizeRun, finishedWhileOpen, setLastOrganizeRun, dismissLastOrganizeRun };
}
