// @ts-check
/**
 * useSampleRun: the "try a few files first" step before a large batch.
 *
 * Wraps the analysis run's analyzeFiles. A plain call (files the user just
 * added, or the Analyze button for files waiting in the queue) with
 * SAMPLE_OFFER_MIN_FILES or more files, while the current Smart Folder
 * definitions have not been tried on a sample, opens the offer instead of
 * starting the run. Runs the analysis started itself (queued, resumed,
 * retried, reanalyzed) are never held.
 *
 * Stages: 'offer' (sample or skip), 'running' (the sample is analyzing),
 * 'review' (where each sample file would go; continue or edit folders).
 * Skipping, or reaching the review, records the definitions hash in
 * ui.smartFolderSampleHash (persisted), so the offer returns only after a
 * folder's name, description or path changes.
 *
 * @module discover/useSampleRun
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useStore } from 'react-redux';
import { PHASES } from '../../../shared/constants';
import { createLogger } from '../../../shared/logger';
import { getFolderDefinitionsHash } from '../../../shared/smartFolderDefinitions';
import { setSmartFolderSampleHash } from '../../store/slices/uiSlice';
import { toCanonicalPath } from '../../utils/canonicalPath';
import {
  countFoldersWithHints,
  pickSampleFiles,
  rankSampleFiles,
  shouldOfferSample,
  uniqueFiles
} from './sampleRun';

const logger = createLogger('useSampleRun');

/**
 * @typedef {Object} SampleSession
 * @property {number} id
 * @property {'offer'|'running'|'review'} stage
 * @property {any[]} files - every file of the batch, the sample included
 * @property {any[]} picked - the sample files
 * @property {string} hash - the folder definitions the sample tries
 * @property {number} hintCount - folders with a description hint
 * @property {import('./sampleRun').SampleRow[]} rows - filled in at 'review'
 */

/** @typedef {{ started: boolean, reason?: string }} RunStart */

/**
 * @param {{
 *   analyzeFiles: (files: any[], runOptions?: any) => Promise<RunStart>|RunStart,
 *   cancelAnalysis?: () => void,
 *   advancePhase?: (phase: string) => void
 * }} params
 */
export function useSampleRun({ analyzeFiles, cancelAnalysis, advancePhase }) {
  const store = useStore();
  const [session, setSessionState] = useState(/** @type {SampleSession|null} */ (null));
  const sessionRef = useRef(/** @type {SampleSession|null} */ (null));
  const nextIdRef = useRef(0);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const setSession = useCallback((/** @type {SampleSession|null} */ next) => {
    sessionRef.current = next;
    if (mountedRef.current) setSessionState(next);
  }, []);

  const readState = useCallback(() => /** @type {any} */ (store?.getState?.()) || {}, [store]);

  const markReviewed = useCallback(
    (/** @type {string} */ hash) => {
      if (!hash || typeof store?.dispatch !== 'function') return;
      store.dispatch(setSmartFolderSampleHash(hash));
    },
    [store]
  );

  const gatedAnalyzeFiles = useCallback(
    async (/** @type {any[]} */ files, /** @type {any} */ runOptions) => {
      if (runOptions && (runOptions.origin || runOptions.bypassCache)) {
        return analyzeFiles(files, runOptions);
      }
      const current = sessionRef.current;
      if (current) {
        // The sample dialog is open: these files join the batch it holds.
        setSession({ ...current, files: uniqueFiles([...current.files, ...(files || [])]) });
        return { started: false, reason: 'sample-offered' };
      }
      const state = readState();
      const smartFolders = state.files?.smartFolders;
      const offer = shouldOfferSample({
        files,
        smartFolders,
        reviewedHash: state.ui?.smartFolderSampleHash,
        isAnalyzing: Boolean(state.analysis?.isAnalyzing)
      });
      if (!offer) return analyzeFiles(files, runOptions);

      const batch = uniqueFiles(files);
      nextIdRef.current += 1;
      setSession({
        id: nextIdRef.current,
        stage: 'offer',
        files: batch,
        picked: pickSampleFiles(batch),
        hash: getFolderDefinitionsHash(smartFolders),
        hintCount: countFoldersWithHints(smartFolders),
        rows: []
      });
      return { started: false, reason: 'sample-offered' };
    },
    [analyzeFiles, readState, setSession]
  );

  /** Analyze the whole batch now; the offer stays away for these folders. */
  const skipSample = useCallback(async () => {
    const current = sessionRef.current;
    if (!current || current.stage !== 'offer') return { started: false, reason: 'no-offer' };
    markReviewed(current.hash);
    setSession(null);
    return analyzeFiles(current.files);
  }, [analyzeFiles, markReviewed, setSession]);

  /** Analyze the sample, then show where each file would go. */
  const startSample = useCallback(async () => {
    const current = sessionRef.current;
    if (!current || current.stage !== 'offer') return;
    const running = { ...current, stage: /** @type {const} */ ('running') };
    setSession(running);
    const isCurrent = () => sessionRef.current?.id === running.id;

    let result;
    try {
      result = await analyzeFiles(running.picked, { origin: 'sample' });
    } catch (error) {
      logger.warn('Sample run failed to start', { error: /** @type {any} */ (error)?.message });
      result = { started: false, reason: 'error' };
    }
    if (!isCurrent()) return;
    if (!result?.started) {
      // Another run held the analysis (the sample waits in its queue):
      // nothing to review here, and the rest stays in the queue.
      setSession(null);
      return;
    }

    const state = readState();
    const results = Array.isArray(state.analysis?.results) ? state.analysis.results : [];
    const byPath = new Map(results.map((/** @type {any} */ r) => [toCanonicalPath(r?.path), r]));
    const sampleFiles = running.picked.map((file) => {
      const done = byPath.get(toCanonicalPath(file?.path));
      return done ? { ...file, ...done } : file;
    });
    const rows = await rankSampleFiles({
      files: sampleFiles,
      smartFolders: Array.isArray(state.files?.smartFolders) ? state.files.smartFolders : [],
      getBatchSuggestions: /** @type {any} */ (window)?.electronAPI?.suggestions
        ?.getBatchSuggestions
    });
    if (!isCurrent()) return;
    markReviewed(running.hash);
    setSession({ ...running, stage: 'review', rows });
  }, [analyzeFiles, markReviewed, readState, setSession]);

  /** After the review: analyze the files the sample did not cover. */
  const continueWithRest = useCallback(async () => {
    const current = sessionRef.current;
    if (!current || current.stage !== 'review') return { started: false, reason: 'no-review' };
    setSession(null);
    const sampled = new Set(current.picked.map((file) => toCanonicalPath(file?.path)));
    const rest = current.files.filter((file) => !sampled.has(toCanonicalPath(file?.path)));
    if (rest.length === 0) return { started: false, reason: 'empty' };
    return analyzeFiles(rest);
  }, [analyzeFiles, setSession]);

  /** After the review: go to Setup. The rest stays in the queue, unanalyzed. */
  const editFolders = useCallback(() => {
    setSession(null);
    advancePhase?.(PHASES?.SETUP ?? 'setup');
  }, [advancePhase, setSession]);

  /** Stop the sample while it runs. Every file stays in the queue. */
  const stopSample = useCallback(() => {
    if (sessionRef.current?.stage !== 'running') return;
    setSession(null);
    cancelAnalysis?.();
  }, [cancelAnalysis, setSession]);

  /** Close the dialog. A running sample is stopped with stopSample instead. */
  const dismiss = useCallback(() => {
    if (sessionRef.current?.stage === 'running') return;
    setSession(null);
  }, [setSession]);

  return {
    session,
    analyzeFiles: gatedAnalyzeFiles,
    startSample,
    skipSample,
    continueWithRest,
    editFolders,
    stopSample,
    dismiss
  };
}
