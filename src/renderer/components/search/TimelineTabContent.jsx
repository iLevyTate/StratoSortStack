/**
 * Timeline tab content for the Unified Search modal.
 *
 * Pure presentation — state arrives via the useTimelineTab hook surface plus
 * onOpenFile. Renders a virtualized list of year/month/undated headers and
 * item rows built by buildTimelineRows().
 */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import { List as VirtualizedList } from 'react-window';
import { buildTimelineRows, formatTimelineDay } from '../../utils/timelineRows';
import { Button } from '../ui';
import { UI_VIRTUALIZATION } from '../../../shared/constants';

const ROW_HEIGHT_HEADER = 32;
const ROW_HEIGHT_ITEM = 56;

/**
 * @param {number} index
 * @param {Array<any>} rows
 * @returns {number}
 */
function getRowHeight(index, rows) {
  const row = rows[index];
  if (!row) return ROW_HEIGHT_ITEM;
  return row.type === 'item' ? ROW_HEIGHT_ITEM : ROW_HEIGHT_HEADER;
}

/**
 * @param {{
 *   index: number,
 *   style: React.CSSProperties,
 *   rows: Array<any>,
 *   onOpenFile: (filePath: string) => void
 * }} props
 */
function TimelineRow({ index, style, rows, onOpenFile }) {
  const row = rows[index];
  if (!row) return null;

  if (row.type === 'year') {
    return (
      <div
        style={style}
        className="flex items-center px-3 font-semibold text-system-gray-700 uppercase tracking-wider text-micro select-none"
        aria-hidden="true"
      >
        {row.label}
      </div>
    );
  }

  if (row.type === 'month' || row.type === 'undated') {
    return (
      <div
        style={style}
        className="flex items-center px-4 text-micro text-system-gray-400 select-none"
        aria-hidden="true"
      >
        {row.label}
      </div>
    );
  }

  // type === 'item'
  const { item } = row;
  // Local calendar day for analyzed-at timestamps, verbatim day for
  // date-only content dates (keeps the row consistent with its month header).
  const dateDisplay = item.effectiveDate ? formatTimelineDay(item.effectiveDate) : null;
  const isAnalyzedDate = item.dateSource === 'analyzed';
  const dateLabel = dateDisplay ? (isAnalyzedDate ? `~${dateDisplay}` : dateDisplay) : '';
  const dateTitle = isAnalyzedDate
    ? 'Date the file was analyzed (no content date found)'
    : undefined;
  const categoryLabel = item.category || item.mediaKind || null;

  return (
    <div style={style} className="px-3 flex items-stretch">
      <button
        type="button"
        className="flex-1 flex items-center gap-compact text-left rounded-lg px-2 hover:bg-system-gray-100 focus-visible:ring-2 focus-visible:ring-stratosort-accent/50 focus:outline-none transition-colors min-w-0"
        onClick={() => item.filePath && onOpenFile(item.filePath)}
      >
        {categoryLabel && (
          <span className="shrink-0 text-micro text-system-gray-400 uppercase tracking-wide w-12 truncate">
            {categoryLabel}
          </span>
        )}
        <span className="flex-1 min-w-0 flex flex-col gap-compact py-1">
          <span className="truncate text-sm font-medium text-system-gray-800 leading-tight">
            {item.fileName}
          </span>
          {item.subject && (
            <span className="truncate text-micro text-system-gray-400 leading-none">
              {item.subject}
            </span>
          )}
        </span>
        {dateLabel && (
          <span
            className="shrink-0 text-micro text-system-gray-400 tabular-nums ml-auto pl-2"
            title={dateTitle}
          >
            {dateLabel}
          </span>
        )}
      </button>
    </div>
  );
}

TimelineRow.propTypes = {
  index: PropTypes.number.isRequired,
  style: PropTypes.object.isRequired,
  rows: PropTypes.array.isRequired,
  onOpenFile: PropTypes.func.isRequired
};

export default function TimelineTabContent({
  items,
  total,
  hasMore,
  isLoading,
  error,
  loadMore,
  onOpenFile
}) {
  const containerRef = useRef(null);
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

  const rows = useMemo(() => buildTimelineRows(items), [items]);

  const rowHeight = useCallback((index) => getRowHeight(index, rows), [rows]);

  const rowProps = useMemo(() => ({ rows, onOpenFile }), [rows, onOpenFile]);

  const isEmpty = !isLoading && !error && items.length === 0;

  return (
    <div className="flex flex-col flex-1 min-h-0 gap-compact">
      {error && (
        <div role="alert" className="text-micro text-stratosort-danger px-3 py-2">
          {error}
        </div>
      )}

      {isLoading && items.length === 0 && (
        <div role="status" className="text-micro text-system-gray-400 px-3 py-2">
          Loading&hellip;
        </div>
      )}

      {isEmpty && (
        <div className="flex-1 flex items-center justify-center">
          <span className="text-micro text-system-gray-400 text-center px-4">
            No analyzed files yet &mdash; analyze files to build your timeline.
          </span>
        </div>
      )}

      {rows.length > 0 && (
        <div ref={containerRef} className="flex-1 min-h-0 flex flex-col overflow-x-visible">
          <VirtualizedList
            rowCount={rows.length}
            rowHeight={rowHeight}
            rowComponent={TimelineRow}
            rowProps={rowProps}
            overscanCount={UI_VIRTUALIZATION.OVERSCAN_COUNT}
            defaultHeight={height}
            style={{ height: Math.max(height, 200), width: '100%' }}
            className="modern-scrollbar"
          />
        </div>
      )}

      {hasMore && (
        <div className="px-3 py-2 flex justify-center">
          <Button
            variant="ghost"
            size="sm"
            onClick={loadMore}
            disabled={isLoading}
            aria-label={`Load more timeline items (showing ${items.length} of ${total})`}
          >
            {isLoading ? 'Loading…' : `Load more (shown ${items.length} of ${total})`}
          </Button>
        </div>
      )}
    </div>
  );
}

TimelineTabContent.propTypes = {
  items: PropTypes.array.isRequired,
  total: PropTypes.number.isRequired,
  hasMore: PropTypes.bool.isRequired,
  isLoading: PropTypes.bool.isRequired,
  error: PropTypes.string.isRequired,
  loadMore: PropTypes.func.isRequired,
  onOpenFile: PropTypes.func.isRequired
};
