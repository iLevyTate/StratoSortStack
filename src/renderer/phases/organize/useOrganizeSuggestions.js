// @ts-check
/**
 * useOrganizeSuggestions: the suggestion engine's ranked destinations for the
 * files waiting in Organize (decision D1, 2026-09-29).
 *
 * Fetches `suggestions.getBatchSuggestions` in chunks, with text generation
 * and folder-improvement candidates off, so a batch of files ranks from
 * embeddings, learned placements and feedback memory in seconds rather than
 * one LLM call per file. Each path is fetched once per smart-folder set: a
 * later edit on the card does not refetch, so the ranking stays what the app
 * suggested before the user chose. Files the engine cannot place, and any
 * failed chunk, fall back to name matching in `resolveOrganizeDestination`.
 *
 * @module organize/useOrganizeSuggestions
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { createLogger } from '../../../shared/logger';
import { toCanonicalPath } from '../../utils/canonicalPath';
import { normalizeEngineEntry } from './organizeDestination';

const logger = createLogger('useOrganizeSuggestions');

export const SUGGESTION_CHUNK_SIZE = 25;

export const RANKING_OPTIONS = Object.freeze({
  includeStructureAnalysis: false,
  skipGeneration: true,
  skipImprovementCandidates: true
});

// Fields the engine never reads and that can be large (full text,
// transcripts). They would only inflate the IPC payload.
const HEAVY_ANALYSIS_KEYS = [
  'extractedText',
  'ocrText',
  'transcript',
  'transcriptSegments',
  'keyframes',
  'embedding',
  'chunks'
];

/**
 * @param {any} file
 * @returns {Record<string, any>} the analysisFileSchema shape the IPC accepts
 */
export function toSuggestionFile(file) {
  /** @type {Record<string, any>} */
  const analysis = { ...(file?.analysis || {}) };
  for (const key of HEAVY_ANALYSIS_KEYS) delete analysis[key];
  const name =
    file?.name ||
    String(file?.path || '')
      .split(/[\\/]/)
      .pop() ||
    '';
  const dot = name.lastIndexOf('.');
  return {
    path: file.path,
    name,
    extension: file?.extension || (dot > 0 ? name.slice(dot + 1) : undefined),
    ...(Number.isFinite(file?.size) ? { size: file.size } : {}),
    ...(typeof file?.type === 'string' ? { type: file.type } : {}),
    analysis
  };
}

/** @param {any[]} smartFolders */
function folderSignature(smartFolders) {
  return (Array.isArray(smartFolders) ? smartFolders : [])
    .map((f) => `${f?.id || ''}|${toCanonicalPath(f?.path) || ''}|${f?.name || ''}`)
    .sort()
    .join('\n');
}

/**
 * @param {any[]} files - files ready to organize (with analysis)
 * @param {any[]} smartFolders
 * @returns {{ suggestionsByPath: Map<string, import('./organizeDestination').EngineSuggestion>, isRanking: boolean }}
 */
export function useOrganizeSuggestions(files, smartFolders) {
  const [suggestionsByPath, setSuggestionsByPath] = useState(
    () => /** @type {Map<string, import('./organizeDestination').EngineSuggestion>} */ (new Map())
  );
  const [inFlight, setInFlight] = useState(0);
  const requestedRef = useRef(/** @type {Set<string>} */ (new Set()));
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const signature = useMemo(() => folderSignature(smartFolders), [smartFolders]);
  const hasFolders = signature.length > 0;

  // A different smart-folder set invalidates every ranking. Declared before
  // the fetch effect so the reset runs first on the same commit.
  useEffect(() => {
    generationRef.current += 1;
    requestedRef.current = new Set();
    // Returning the same empty map lets React skip the render on mount.
    setSuggestionsByPath((prev) => (prev.size === 0 ? prev : new Map()));
  }, [signature]);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      // Unmount: results still in flight must not touch state.
      mountedRef.current = false;
      generationRef.current += 1;
    };
  }, []);

  useEffect(() => {
    const api = window?.electronAPI?.suggestions?.getBatchSuggestions;
    if (typeof api !== 'function' || !hasFolders) return;
    const pending = (Array.isArray(files) ? files : []).filter((file) => {
      const key = toCanonicalPath(file?.path);
      return key && file?.analysis && !requestedRef.current.has(key);
    });
    if (pending.length === 0) return;

    // Mark before the first await so a re-render with the same files (every
    // Redux update produces a new array) does not queue them twice.
    for (const file of pending) requestedRef.current.add(toCanonicalPath(file.path));
    const generation = generationRef.current;
    const current = () => generation === generationRef.current;

    setInFlight((n) => n + 1);
    (async () => {
      try {
        for (let i = 0; i < pending.length; i += SUGGESTION_CHUNK_SIZE) {
          if (!current()) return;
          const chunk = pending.slice(i, i + SUGGESTION_CHUNK_SIZE);
          let response;
          try {
            response = await api(chunk.map(toSuggestionFile), RANKING_OPTIONS);
          } catch (error) {
            logger.debug('Ranking chunk failed; those files use name matching', {
              count: chunk.length,
              error: /** @type {any} */ (error)?.message
            });
            continue;
          }
          if (!current()) return;
          if (!response?.success || !Array.isArray(response.groups)) continue;

          /** @type {Map<string, import('./organizeDestination').EngineSuggestion>} */
          const updates = new Map();
          for (const group of response.groups) {
            for (const entry of Array.isArray(group?.files) ? group.files : []) {
              const key = toCanonicalPath(entry?.path);
              const normalized = normalizeEngineEntry(entry);
              if (key && normalized) updates.set(key, normalized);
            }
          }
          if (updates.size > 0) {
            setSuggestionsByPath((prev) => {
              const next = new Map(prev);
              updates.forEach((value, key) => next.set(key, value));
              return next;
            });
          }
        }
      } finally {
        if (mountedRef.current) setInFlight((n) => Math.max(0, n - 1));
      }
    })();
  }, [files, signature, hasFolders]);

  return { suggestionsByPath, isRanking: inFlight > 0 };
}
