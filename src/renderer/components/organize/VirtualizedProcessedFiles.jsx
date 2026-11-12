import React, { memo, useMemo } from 'react';
import PropTypes from 'prop-types';
import { useSelector } from 'react-redux';
import { List } from 'react-window';
import { StatusBadge } from '../ui';
import { Text } from '../ui/Typography';
import { UI_VIRTUALIZATION } from '../../../shared/constants';
import { selectRedactPaths } from '../../store/selectors';
import { formatDisplayFileName } from '../../utils/pathDisplay';
import { describeDuplicateRemoval, isRemovedDuplicate } from '../../utils/duplicateRemoval';

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

/**
 * One organized-history entry. Both the virtualized and the plain list render
 * it, so the two cannot drift apart.
 */
function ProcessedFileCard({ file, redactPaths, fill = false }) {
  const originalName = formatDisplayFileName(file.originalName || 'Unknown', {
    redact: redactPaths
  });
  const newName = formatDisplayFileName(file.newName || 'Unknown', { redact: redactPaths });
  const smartFolder = redactPaths ? 'destination hidden' : file.smartFolder || 'Unknown folder';
  const organizedDate = formatDate(file.organizedAt);
  // Not moved: the destination already held an identical copy.
  const duplicate = isRemovedDuplicate(file);
  const outcome = duplicate
    ? `Not moved: an identical copy is already in ${
        redactPaths ? 'the destination' : smartFolder
      }. ${describeDuplicateRemoval(file)}`
    : redactPaths
      ? 'Moved successfully'
      : `Moved to ${smartFolder}`;

  return (
    <div
      className={`list-row flex items-center justify-between gap-default overflow-hidden p-4${
        fill ? ' h-full' : ''
      }`}
    >
      <div className="flex min-w-0 flex-1 items-center gap-default overflow-hidden">
        {duplicate ? (
          <StatusBadge variant="neutral">Duplicate</StatusBadge>
        ) : (
          <StatusBadge variant="success">OK</StatusBadge>
        )}
        <div className="min-w-0 flex-1 overflow-hidden">
          <Text variant="small" className="truncate font-medium text-system-gray-900">
            {duplicate ? originalName : `${originalName} -> ${newName}`}
          </Text>
          <Text
            variant="tiny"
            className="truncate text-system-gray-500"
            title={duplicate ? outcome : undefined}
          >
            {outcome} | {organizedDate}
          </Text>
        </div>
      </div>
      <Text
        variant="tiny"
        className={`shrink-0 font-semibold ${
          duplicate ? 'text-system-gray-500' : 'text-stratosort-success'
        }`}
      >
        {duplicate ? 'Not moved' : 'Organized'}
      </Text>
    </div>
  );
}

ProcessedFileCard.propTypes = {
  file: PropTypes.object.isRequired,
  redactPaths: PropTypes.bool,
  fill: PropTypes.bool
};

/**
 * Individual processed file row component
 */
const ProcessedFileRow = memo(function ProcessedFileRow({ index, style, data }) {
  const { files, redactPaths } = data || {};
  const file = files && files[index];

  if (!file) return null;

  return (
    <div style={style} className="px-2 py-2">
      <ProcessedFileCard file={file} redactPaths={redactPaths} fill />
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
        // Key precedence: originalPath (most specific) → originalPath+newName
        // composite (handles duplicate originalPath after re-process) → name +
        // timestamp + index tiebreaker (handles missing path AND collisions
        // from same-name + same-timestamp). Index is a safe last-resort here
        // because this list is append-only post-organize history; items don't
        // reorder, so index stability is fine.
        const stableKey = file.originalPath
          ? `${file.originalPath}|${file.newName || ''}`
          : `${file.originalName || 'Unknown'}|${file.organizedAt || ''}|${index}`;

        return <ProcessedFileCard key={stableKey} file={file} redactPaths={redactPaths} />;
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
      organizedAt: PropTypes.string,
      duplicateRemoval: PropTypes.oneOf(['trashed', 'deleted'])
    })
  ).isRequired,
  isLoading: PropTypes.bool
};

export default memo(VirtualizedProcessedFiles);
