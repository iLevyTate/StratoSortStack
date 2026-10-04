// @ts-check
import { useCallback, useEffect, useRef, useState } from 'react';

const PAGE_SIZE = 500;

/**
 * Timeline tab state: lazily loads the first page when the tab activates,
 * appends pages via loadMore. Lean items only (analysis-history:get-timeline).
 * @param {{isOpen: boolean, activeTab: string}} params
 * @returns {{
 *   items: Array<any>,
 *   total: number,
 *   hasMore: boolean,
 *   isLoading: boolean,
 *   error: string,
 *   loadMore: () => Promise<void>,
 *   refresh: () => void
 * }}
 */
export function useTimelineTab({ isOpen, activeTab }) {
  const [items, setItems] = useState(/** @type {Array<any>} */ ([]));
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [reloadToken, setReloadToken] = useState(0);
  const loadedRef = useRef(false);
  // Backend offset consumed so far. Distinct from items.length: dedupe can
  // drop rows from a page, and deriving the next offset from the deduped
  // length would refetch the same (fully duplicate) page forever.
  const offsetRef = useRef(0);
  // Generation token: refresh() (fired per file-operation-complete during
  // bulk moves) invalidates any in-flight load. Without it a stale loadMore
  // response landed AFTER the reset, appending pre-move rows the refresh
  // existed to purge and double-counting offsetRef so the next page silently
  // skipped unfetched rows.
  const loadGenRef = useRef(0);

  const fetchPage = useCallback(
    /** @returns {Promise<{items: Array<any>, total: number, hasMore: boolean}>} */
    async (/** @type {number} */ offset) => {
      const api = window?.electronAPI?.analysisHistory?.getTimeline;
      if (typeof api !== 'function') {
        throw new Error('Timeline API unavailable');
      }
      const page = await api({ limit: PAGE_SIZE, offset });
      return page && Array.isArray(page.items) ? page : { items: [], total: 0, hasMore: false };
    },
    []
  );

  // A closed modal invalidates the loaded page: analyses and organizes happen
  // while it is closed, and the file-operation refresh listener is only
  // attached while it is open. Reset so the next open refetches instead of
  // serving the first-load snapshot for the rest of the session.
  useEffect(() => {
    if (!isOpen) loadedRef.current = false;
  }, [isOpen]);

  useEffect(() => {
    if (!isOpen || activeTab !== 'timeline' || loadedRef.current) return;
    loadedRef.current = true;
    const gen = ++loadGenRef.current;
    setIsLoading(true);
    setError('');
    (async () => {
      try {
        const page = await fetchPage(0);
        if (gen !== loadGenRef.current) return;
        offsetRef.current = page.items.length;
        setItems(page.items);
        setTotal(page.total);
        setHasMore(Boolean(page.hasMore));
      } catch (err) {
        if (gen !== loadGenRef.current) return;
        setError((err instanceof Error ? err.message : null) || 'Failed to load timeline');
        loadedRef.current = false;
      } finally {
        if (gen === loadGenRef.current) setIsLoading(false);
      }
    })();
  }, [isOpen, activeTab, fetchPage, reloadToken]);

  const loadMore = useCallback(async () => {
    if (isLoading || !hasMore) return;
    const gen = loadGenRef.current;
    setIsLoading(true);
    try {
      const page = await fetchPage(offsetRef.current);
      // A refresh() (or newer load) superseded this request while it was in
      // flight — its rows and offset bump belong to the discarded snapshot.
      if (gen !== loadGenRef.current) return;
      offsetRef.current += page.items.length;
      // Offset pages come from a live re-sorted snapshot: entries recorded
      // between fetches shift the boundary, so an item can reappear on the
      // next page. Drop ids we already have rather than rendering dupes.
      setItems((prev) => {
        const seen = new Set(prev.map((it) => it?.id));
        return [...prev, ...page.items.filter((it) => !seen.has(it?.id))];
      });
      setTotal(page.total);
      setHasMore(Boolean(page.hasMore));
      setError('');
    } catch (err) {
      if (gen !== loadGenRef.current) return;
      setError((err instanceof Error ? err.message : null) || 'Failed to load more');
    } finally {
      if (gen === loadGenRef.current) setIsLoading(false);
    }
  }, [fetchPage, hasMore, isLoading]);

  const refresh = useCallback(() => {
    loadGenRef.current += 1;
    loadedRef.current = false;
    offsetRef.current = 0;
    setItems([]);
    setTotal(0);
    setHasMore(false);
    // Superseded in-flight loads skip their own setIsLoading(false); reset it
    // here so a refresh with no follow-up load (tab closed) can't strand the
    // spinner.
    setIsLoading(false);
    setError('');
    setReloadToken((t) => t + 1);
  }, []);

  return { items, total, hasMore, isLoading, error, loadMore, refresh };
}
