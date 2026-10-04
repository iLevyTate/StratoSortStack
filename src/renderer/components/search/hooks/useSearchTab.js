// @ts-check
/**
 * Search-tab state + logic for the Unified Search modal (§I Phase 3).
 *
 * Owns the query (+ debounce), search execution (hybrid embeddings search
 * with timeout, request-id stale-guard, and validated responses), result
 * selection, bulk-selection ids, view mode, and the derived memos
 * (grouped results, id→index map, status label). `searchResults` is
 * consumed OUTSIDE the tab too — chat context and convert-to-graph — so
 * the hook returns it for the modal to share.
 *
 * Extracted verbatim from UnifiedSearchModal — behavior parity is pinned
 * by the existing modal suites.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createLogger } from '../../../../shared/logger';
import { TIMEOUTS } from '../../../../shared/performanceConstants';
import { getFileCategory } from '../../ui/FileIcon';
import { addToRecentSearches } from '../SearchAutocomplete';
import { normalizeSearchWarnings } from '../utils/searchWarnings';
import {
  getErrorMessage,
  validateSearchResponse,
  getMetadataPath,
  getMetadataName
} from '../utils';

const logger = createLogger('useSearchTab');

const ENABLE_SEARCH_TRACE_LOGS = process.env.NODE_ENV === 'development';

/**
 * @param {{
 *   isOpen: boolean,
 *   activeTab: string,
 *   defaultTopK: number,
 *   error: string,
 *   setError: (v: string) => void
 * }} props
 */
export function useSearchTab({ isOpen, activeTab, defaultTopK, error, setError }) {
  const [query, setQuery] = useState('');
  const [debouncedQuery, setDebouncedQuery] = useState('');
  const [searchResults, setSearchResults] = useState([]);
  const [selectedSearchId, setSelectedSearchId] = useState(null);
  const [isSearching, setIsSearching] = useState(false);
  const [queryMeta, setQueryMeta] = useState(null); // Stores spell corrections and synonyms info
  const [searchMeta, setSearchMeta] = useState(null); // Stores search mode and fallback info
  const [bulkSelectedIds, setBulkSelectedIds] = useState(new Set());
  const [searchRefreshTrigger, setSearchRefreshTrigger] = useState(0);
  const [focusedResultIndex, setFocusedResultIndex] = useState(-1);
  const [viewMode, setViewMode] = useState('all'); // 'all' or 'grouped'

  const lastSearchRef = useRef(0);
  const searchRequestCounterRef = useRef(0);

  // Re-run the current query (used when files move/delete underneath the
  // open modal — wired to useSearchModalStats' onFileOperation).
  const triggerSearchRefresh = useCallback(() => {
    setSearchRefreshTrigger((prev) => prev + 1);
  }, []);

  // ============================================================================
  // Debounce query
  // ============================================================================

  useEffect(() => {
    const handle = setTimeout(() => setDebouncedQuery(query.trim()), TIMEOUTS.DEBOUNCE_INPUT);
    return () => clearTimeout(handle);
  }, [query]);

  const searchResultsById = useMemo(
    () => new Map(searchResults.map((r) => [r?.id, r])),
    [searchResults]
  );

  const selectedSearchResult = useMemo(
    () => (selectedSearchId ? (searchResultsById.get(selectedSearchId) ?? null) : null),
    [searchResultsById, selectedSearchId]
  );
  const selectedSearchResultPath = useMemo(
    () => getMetadataPath(selectedSearchResult, selectedSearchResult?.id) || '',
    [selectedSearchResult]
  );
  const selectedSearchResultName = useMemo(
    () =>
      selectedSearchResult
        ? getMetadataName(
            selectedSearchResult,
            selectedSearchResultPath,
            selectedSearchResult?.id
          ) || 'File'
        : 'File',
    [selectedSearchResult, selectedSearchResultPath]
  );

  useEffect(() => {
    if (activeTab !== 'search') return undefined;
    let cancelled = false;

    const run = async () => {
      if (!isOpen) return;
      const q = debouncedQuery;
      if (!q || q.length < 2) {
        setSearchResults([]);
        setSelectedSearchId(null);
        setQueryMeta(null);
        setSearchMeta(null);
        setBulkSelectedIds(new Set());
        setError('');
        return;
      }

      const requestId = (searchRequestCounterRef.current += 1);
      lastSearchRef.current = requestId;
      setIsSearching(true);
      setError('');

      try {
        if (ENABLE_SEARCH_TRACE_LOGS) {
          logger.info('[KnowledgeOS] Search started', {
            queryLength: q.length,
            topK: defaultTopK,
            mode: 'hybrid'
          });
        }

        const searchPromise = window.electronAPI?.embeddings?.search?.(q, {
          topK: defaultTopK,
          mode: 'hybrid',
          correctSpelling: true,
          expandSynonyms: true
        });

        if (!searchPromise || typeof searchPromise.then !== 'function') {
          throw new Error('Search API is not available. Check that embeddings are initialized.');
        }

        let searchTimeoutId;
        let response;
        try {
          response = await Promise.race([
            searchPromise,
            new Promise((_, reject) => {
              searchTimeoutId = setTimeout(
                () =>
                  reject(
                    new Error(
                      'Search timed out. The index may still be loading — please try again.'
                    )
                  ),
                TIMEOUTS.SEMANTIC_QUERY
              );
            })
          ]);
        } finally {
          clearTimeout(searchTimeoutId);
        }
        if (cancelled) return;
        if (lastSearchRef.current !== requestId) return;

        const validation = validateSearchResponse(response, 'Search');
        if (!validation.valid) {
          setSearchResults([]);
          setSelectedSearchId(null);
          setBulkSelectedIds(new Set());
          setQueryMeta(null);
          setSearchMeta(null);
          setError(getErrorMessage({ message: validation.error }, 'Search'));
          return;
        }

        const next = validation.results;
        setSearchResults(next);
        setSelectedSearchId(next[0]?.id || null);
        setBulkSelectedIds(new Set()); // Clear bulk selection on new results
        // Add to recent searches when search completes (type-to-search flow)
        if (q && q.trim().length >= 2) addToRecentSearches(q.trim());
        // Store query processing metadata for "Did you mean?" feedback
        setQueryMeta(response.queryMeta || null);
        // Store search mode metadata (fallback detection)
        setSearchMeta({
          mode: response.mode || 'hybrid',
          fallback: response.meta?.fallback || false,
          fallbackReason: response.meta?.fallbackReason || null,
          originalMode: response.meta?.originalMode || null,
          warnings: normalizeSearchWarnings(response.meta?.warnings)
        });

        if (ENABLE_SEARCH_TRACE_LOGS) {
          logger.info('[KnowledgeOS] Search completed', {
            resultCount: next.length,
            mode: response.mode || 'hybrid',
            fallback: Boolean(response.meta?.fallback),
            fallbackReason: response.meta?.fallbackReason || null
          });
        }
      } catch (e) {
        if (cancelled) return;
        if (lastSearchRef.current !== requestId) return;
        logger.warn('[KnowledgeOS] Search failed', { error: e?.message || e });
        setSearchResults([]);
        setSelectedSearchId(null);
        setBulkSelectedIds(new Set());
        setQueryMeta(null);
        setSearchMeta(null);
        setError(getErrorMessage(e, 'Search'));
      } finally {
        // Only reset if this request is still the latest.
        // Avoid clearing the loading state for newer in-flight requests.
        if (lastSearchRef.current === requestId) {
          setIsSearching(false);
        }
      }
    };

    run();
    return () => {
      cancelled = true;
    };
    // searchRefreshTrigger triggers re-search when files are moved/deleted
    // eslint-disable-next-line react-hooks/exhaustive-deps -- setError is a stable setState-backed callback
  }, [debouncedQuery, isOpen, defaultTopK, activeTab, searchRefreshTrigger]);

  const searchStatusLabel = useMemo(() => {
    if (isSearching) return 'Searching...';
    if (error) return 'Search error';
    if (!debouncedQuery || debouncedQuery.length < 2) return 'Type to search';
    return `${searchResults.length} result${searchResults.length === 1 ? '' : 's'}`;
  }, [isSearching, error, debouncedQuery, searchResults.length]);

  // Group results by file type category
  const groupedResults = useMemo(() => {
    if (!searchResults.length) return /** @type {Record<string, any[]>} */ ({});
    /** @type {Record<string, any[]>} */
    const groups = {};
    searchResults.forEach((result) => {
      const name = result?.metadata?.name || result?.id || '';
      const category = getFileCategory(name);
      if (!groups[category]) {
        groups[category] = [];
      }
      groups[category].push(result);
    });
    // Sort categories by count (most results first)
    const sortedCategories = Object.keys(groups).sort(
      (a, b) => groups[b].length - groups[a].length
    );
    /** @type {Record<string, any[]>} */
    const sortedGroups = {};
    sortedCategories.forEach((cat) => {
      sortedGroups[cat] = groups[cat];
    });
    return sortedGroups;
  }, [searchResults]);

  // Pre-compute ID-to-index map for O(1) lookup in grouped view
  const resultIdToIndex = useMemo(() => {
    const map = new Map();
    searchResults.forEach((r, i) => map.set(r.id, i));
    return map;
  }, [searchResults]);

  // Reset to a clean slate for a fresh open (called from the modal's
  // open-reset effect so the reset ordering stays exactly as before).
  const resetSearchState = useCallback(() => {
    setQuery('');
    setDebouncedQuery('');
    setSearchResults([]);
    setSelectedSearchId(null);
    setIsSearching(false);
    setQueryMeta(null);
    setSearchMeta(null);
    setBulkSelectedIds(new Set());
  }, []);

  return {
    query,
    setQuery,
    debouncedQuery,
    setDebouncedQuery,
    searchResults,
    setSearchResults,
    selectedSearchId,
    setSelectedSearchId,
    isSearching,
    queryMeta,
    searchMeta,
    bulkSelectedIds,
    setBulkSelectedIds,
    focusedResultIndex,
    setFocusedResultIndex,
    viewMode,
    setViewMode,
    searchResultsById,
    selectedSearchResult,
    selectedSearchResultPath,
    selectedSearchResultName,
    searchStatusLabel,
    groupedResults,
    resultIdToIndex,
    triggerSearchRefresh,
    resetSearchState
  };
}
