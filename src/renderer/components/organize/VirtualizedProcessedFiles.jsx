import React, { memo, useMemo } from 'react';
import PropTypes from 'prop-types';
import { useSelector } from 'react-redux';
import { List } from 'react-window';
import { StatusBadge } from '../ui';
import { Text } from '../ui/Typography';
import { UI_VIRTUALIZATION } from '../../../shared/constants';
import { selectRedactPaths } from '../../store/selectors';
import { formatDisplayFileName } from '../../utils/pathDisplay';

const ITEM_HEIGHT = UI_VIRTUALIZATION.PROCESSED_FILES_ITEM_HEIGHT;
const VIRTUALIZATION_THRESHOLD = UI_VIRTUALIZATION.THRESHOLD;

/**
 * Calculate optimal list height based on file count and viewport
 * Adapts to data volume for proportional space usage
 */
const getListHeight = (itemCount, viewportHeight) => {
  // Processed files: show up to 8 without scroll, 40vh max
  const targetItems = Math.min(itemCount, 8);
  const contentHeight = targetItems * ITEM_HEIGHT;
  const maxHeight = Math.round(viewportHeight * 0.4);
  return Math.max(ITEM_HEIGHT * 2, Math.min(contentHeight, maxHeight));
};

/**
 * Individual processed file row component
 */
/**
 * Format date safely with fallback
 */
const formatDate = (dateString) => {
  if (!dateString) return 'Unknown date';
  try {
    return new Date(dateString).toLocaleDateString();
  } catch {
    return 'Unknown date';
  }
};

const ProcessedFileRow = memo(function ProcessedFileRow({ index, style, data }) {
  const { files, redactPaths } = data || {};
  const file = files && files[index];

  if (!file) return null;

  const originalName = formatDisplayFileName(file.originalName || 'Unknown', {
    redact: redactPaths
  });
  const newName = formatDisplayFileName(file.newName || 'Unknown', { redact: redactPaths });
  const smartFolder = redactPaths ? 'destination hidden' : file.smartFolder || 'Unknown folder';
  const organizedDate = formatDate(file.organizedAt);

  return (
    <div style={style} className="px-2 py-2">
      <div className="list-row flex h-full items-center justify-between gap-default overflow-hidden p-4">
        <div className="flex min-w-0 flex-1 items-center gap-default overflow-hidden">
          <StatusBadge variant="success">OK</StatusBadge>
          <div className="min-w-0 flex-1 overflow-hidden">
            <Text variant="small" className="truncate font-medium text-system-gray-900">
              {originalName} -&gt; {newName}
            </Text>
            <Text variant="tiny" className="truncate text-system-gray-500">
              {redactPaths ? 'Moved successfully' : `Moved to ${smartFolder}`} | {organizedDate}
            </Text>
          </div>
        </div>
        <Text variant="tiny" className="shrink-0 text-stratosort-success font-semibold">
          Organized
        </Text>
      </div>
    </div>
  );
});

ProcessedFileRow.propTypes = {
  index: PropTypes.number.isRequired,
  style: PropTypes.object.isRequired,
  data: PropTypes.shape({
    files: PropTypes.array.isRequired
  }).isRequired
};

/**
 * VirtualizedProcessedFiles - Renders a virtualized list of organized files
 * Uses react-window FixedSizeList for efficient rendering of large file lists
 */
function VirtualizedProcessedFiles({ files, isLoading = false }) {
  const redactPaths = useSelector(selectRedactPaths);
  const shouldVirtualize = files.length > VIRTUALIZATION_THRESHOLD;

  const rowProps = useMemo(
    () => ({
      data: {
        files,
        redactPaths
      }
    }),
    [files, redactPaths]
  );

  // Calculate optimal list height based on file count (data-aware sizing)
  const listHeight = useMemo(() => {
    const viewportHeight = typeof window !== 'undefined' ? window.innerHeight : 900;
    return getListHeight(files.length, viewportHeight);
  }, [files.length]);

  if (isLoading) {
    return (
      <div
        className="space-y-3 animate-loading-fade"
        role="status"
        aria-live="polite"
        aria-label="Loading organized files"
      >
        {[...Array(3)].map((_, i) => (
          <div
            key={i}
            className="h-16 rounded-xl border border-border-soft bg-system-gray-100 animate-pulse"
          />
        ))}
      </div>
    );
  }

  if (shouldVirtualize) {
    return (
      <div className="w-full max-h-[55vh] min-h-[200px] overflow-hidden">
        <Text variant="tiny" className="text-system-gray-500 mb-2">
          Showing {files.length} organized files (virtualized for performance)
        </Text>
        <List
          rowCount={files.length}
          rowHeight={ITEM_HEIGHT}
          rowComponent={ProcessedFileRow}
          rowProps={rowProps}
          overscanCount={5}
          style={{ height: listHeight, width: '100%' }}
          className="scrollbar-thin scrollbar-thumb-system-gray-300 scrollbar-track-transparent"
        />
      </div>
    );
  }

  // For smaller lists, render normally without virtualization overhead
  // Add max-height constraint to prevent unbounded growth
  return (
    <div className="space-y-4 max-h-viewport-sm overflow-y-auto modern-scrollbar">
      {files.map((file, index) => {
        const originalName = formatDisplayFileName(file.originalName || 'Unknown', {
          redact: redactPaths
        });
        const newName = formatDisplayFileName(file.newName || 'Unknown', { redact: redactPaths });
        const smartFolder = redactPaths
          ? 'destination hidden'
          : file.smartFolder || 'Unknown folder';
        const organizedDate = formatDate(file.organizedAt);

        // Key precedence: originalPath (most specific) → originalPath+newName
        // composite (handles duplicate originalPath after re-process) → name +
        // timestamp + index tiebreaker (handles missing path AND collisions
        // from same-name + same-timestamp). Index is a safe last-resort here
        // because this list is append-only post-organize history; items don't
        // reorder, so index stability is fine.
        const stableKey = file.originalPath
          ? `${file.originalPath}|${file.newName || ''}`
          : `${originalName}|${file.organizedAt || ''}|${index}`;

        return (
          <div
            key={stableKey}
            className="list-row flex items-center justify-between gap-default overflow-hidden p-4"
          >
            <div className="flex min-w-0 flex-1 items-center gap-default overflow-hidden">
              <StatusBadge variant="success">OK</StatusBadge>
              <div className="min-w-0 flex-1 overflow-hidden">
                <Text variant="small" className="truncate font-medium text-system-gray-900">
                  {originalName} -&gt; {newName}
                </Text>
                <Text variant="tiny" className="truncate text-system-gray-500">
                  {redactPaths ? 'Moved successfully' : `Moved to ${smartFolder}`} | {organizedDate}
                </Text>
              </div>
            </div>
            <Text variant="tiny" className="shrink-0 text-stratosort-success font-semibold">
              Organized
            </Text>
          </div>
        );
      })}
    </div>
  );
}

VirtualizedProcessedFiles.propTypes = {
  files: PropTypes.arrayOf(
    PropTypes.shape({
      originalPath: PropTypes.string,
      originalName: PropTypes.string,
      newName: PropTypes.string,
      smartFolder: PropTypes.string,
      organizedAt: PropTypes.string
    })
  ).isRequired,
  isLoading: PropTypes.bool
};

export default memo(VirtualizedProcessedFiles);
