import React, { useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { List as VirtualizedList } from 'react-window';
import { UI_VIRTUALIZATION } from '../../../shared/constants';
import { getScrollBehavior } from '../../utils/motionPreferences';
import VirtualizedSearchResultRow from './VirtualizedSearchResultRow';

const SEARCH_RESULTS_ROW_HEIGHT =
  (UI_VIRTUALIZATION.SEARCH_RESULTS_ITEM_HEIGHT ?? 140) +
  (UI_VIRTUALIZATION.SEARCH_RESULTS_ITEM_GAP ?? 8);

/**
 * Virtualized search results list - prevents UI blocking with large result sets.
 * Uses react-window to render only visible rows.
 */
function VirtualizedSearchResults({
  results,
  selectedSearchId,
  bulkSelectedIds,
  focusedResultIndex,
  query,
  onSelect,
  onToggleBulk,
  onOpen,
  onReveal,
  onCopyPath,
  showGraphActions = true
}) {
  const containerRef = useRef(null);
  const listRef = useRef(null);
  const [height, setHeight] = useState(400);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry) {
        const h = entry.contentRect.height;
        setHeight(Math.max(200, h || 400));
      }
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (focusedResultIndex < 0) return;
    listRef.current?.scrollToRow?.({
      index: focusedResultIndex,
      align: 'smart',
      behavior: getScrollBehavior()
    });
  }, [focusedResultIndex]);

  const rowProps = useMemo(
    () => ({
      results,
      selectedSearchId,
      bulkSelectedIds,
      focusedResultIndex,
      query,
      onSelect,
      onToggleBulk,
      onOpen,
      onReveal,
      onCopyPath,
      showGraphActions
    }),
    [
      results,
      selectedSearchId,
      bulkSelectedIds,
      focusedResultIndex,
      query,
      onSelect,
      onToggleBulk,
      onOpen,
      onReveal,
      onCopyPath,
      showGraphActions
    ]
  );

  return (
    <div ref={containerRef} className="flex-1 min-h-0 flex flex-col overflow-x-visible">
      <VirtualizedList
        listRef={listRef}
        rowCount={results.length}
        rowHeight={SEARCH_RESULTS_ROW_HEIGHT}
        rowComponent={VirtualizedSearchResultRow}
        rowProps={rowProps}
        overscanCount={UI_VIRTUALIZATION.OVERSCAN_COUNT}
        defaultHeight={height}
        style={{ height: Math.max(height, 200), width: '100%' }}
        className="modern-scrollbar"
      />
    </div>
  );
}

VirtualizedSearchResults.propTypes = {
  results: PropTypes.array.isRequired,
  selectedSearchId: PropTypes.string,
  bulkSelectedIds: PropTypes.instanceOf(Set).isRequired,
  focusedResultIndex: PropTypes.number.isRequired,
  query: PropTypes.string.isRequired,
  onSelect: PropTypes.func.isRequired,
  onToggleBulk: PropTypes.func.isRequired,
  onOpen: PropTypes.func.isRequired,
  onReveal: PropTypes.func.isRequired,
  onCopyPath: PropTypes.func.isRequired,
  showGraphActions: PropTypes.bool
};

export default VirtualizedSearchResults;
