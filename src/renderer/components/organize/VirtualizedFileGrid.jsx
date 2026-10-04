import React, { memo, useCallback, useMemo, useState, useEffect } from 'react';
import PropTypes from 'prop-types';
import { List } from 'react-window';
import { ErrorBoundaryCore } from '../ErrorBoundary';
import ReadyFileItem from './ReadyFileItem';
import { Text } from '../ui/Typography';
import { joinPath } from '../../utils/platform';
import { UI_VIRTUALIZATION } from '../../../shared/constants';
import { isGenericBucketFolder } from '../../../shared/categoryFolderMatching';
import { toCanonicalPath } from '../../utils/canonicalPath';

function resolveSmartFolderForRow(
  fileWithEdits,
  rawCategory,
  findSmartFolderForCategory,
  findSmartFolderForFile
) {
  const categoryFolder = findSmartFolderForCategory(rawCategory);
  const fileFolder = findSmartFolderForFile ? findSmartFolderForFile(fileWithEdits) : null;
  if (fileFolder && (!categoryFolder || isGenericBucketFolder(categoryFolder))) {
    return fileFolder;
  }
  return categoryFolder;
}

/**
 * Where this row's file goes, and why. OrganizePhase passes
 * `resolveDestination` (the same resolution the commit uses: user choice,
 * engine ranking, then name matching); without it the grid falls back to
 * name matching alone.
 */
function resolveRowRouting({
  file,
  fileWithEdits,
  rawCategory,
  resolveDestination,
  findSmartFolderForCategory,
  findSmartFolderForFile
}) {
  if (typeof resolveDestination === 'function') {
    return resolveDestination(file) || { folder: null, source: 'none', engine: null };
  }
  const folder = resolveSmartFolderForRow(
    fileWithEdits,
    rawCategory,
    findSmartFolderForCategory,
    findSmartFolderForFile
  );
  return { folder, source: folder ? 'name' : 'none', engine: null };
}

const DEFAULT_ROW_HEIGHT = UI_VIRTUALIZATION.FILE_GRID_ROW_HEIGHT;
// Extra slack so row height ≥ tallest card (multi-line names + form + footer + shadows)
const MEASUREMENT_PADDING = 56;
const ROW_HEIGHT_TOLERANCE = 16; // avoid reflows for small delta (component-specific)
// UX-first threshold for organize cards:
// keep moderate batches in a natural grid (better visual stability),
// reserve virtualization for very large sets.
const VIRTUALIZATION_THRESHOLD = Math.max(UI_VIRTUALIZATION.THRESHOLD, 220);

// Use dynamic column calculation that matches CSS grid-adaptive-lg behavior
// minmax(min(100%, 320px), 1fr) behavior in JS
const MIN_COLUMN_WIDTH = 320;

/**
 * Calculate how many columns to render based on container width
 * Used only for virtualized mode - non-virtualized uses CSS auto-fit
 */
const getColumnCount = (containerWidth) => {
  // Ensure at least one column, floor division gives us the number of full columns that fit
  const cols = Math.floor(containerWidth / MIN_COLUMN_WIDTH);
  return Math.max(1, cols);
};

/**
 * Check whether the current row's selected state changed between renders.
 * This lets row memoization skip unaffected rows when selection toggles.
 */
const didRowSelectionChange = (prevData, nextData, rowIndex) => {
  const columnsPerRow = nextData?.columnsPerRow ?? prevData?.columnsPerRow ?? 1;
  const filesLength = (nextData?.files || prevData?.files || []).length;
  const startIndex = rowIndex * columnsPerRow;
  const endIndex = Math.min(startIndex + columnsPerRow, filesLength);
  if (endIndex <= startIndex) return false;

  const prevSelected = prevData?.selectedFiles instanceof Set ? prevData.selectedFiles : new Set();
  const nextSelected = nextData?.selectedFiles instanceof Set ? nextData.selectedFiles : new Set();

  for (let i = startIndex; i < endIndex; i++) {
    const file = (nextData?.files || prevData?.files || [])[i];
    const key = toCanonicalPath(file?.path);
    if (prevSelected.has(key) !== nextSelected.has(key)) {
      return true;
    }
  }

  return false;
};

const areRowStylesEqual = (a, b) =>
  a === b ||
  (a && b && a.top === b.top && a.left === b.left && a.width === b.width && a.height === b.height);

const areVirtualizedRowPropsEqual = (prevProps, nextProps) => {
  if (prevProps.index !== nextProps.index) return false;
  if (!areRowStylesEqual(prevProps.style, nextProps.style)) return false;

  const prevData = prevProps.data || {};
  const nextData = nextProps.data || {};

  if (prevData.files !== nextData.files) return false;
  if (prevData.columnsPerRow !== nextData.columnsPerRow) return false;
  if (prevData.toggleFileSelection !== nextData.toggleFileSelection) return false;
  if (prevData.getFileWithEdits !== nextData.getFileWithEdits) return false;
  if (prevData.editingFiles !== nextData.editingFiles) return false;
  if (prevData.findSmartFolderForCategory !== nextData.findSmartFolderForCategory) return false;
  if (prevData.resolveDestination !== nextData.resolveDestination) return false;
  if (prevData.getFileStateDisplay !== nextData.getFileStateDisplay) return false;
  if (prevData.handleEditFile !== nextData.handleEditFile) return false;
  if (prevData.smartFolders !== nextData.smartFolders) return false;
  if (prevData.defaultLocation !== nextData.defaultLocation) return false;
  if (prevData.onViewDetails !== nextData.onViewDetails) return false;

  if (didRowSelectionChange(prevData, nextData, nextProps.index)) return false;

  return true;
};

/**
 * Virtualized row component that renders multiple file items per row
 */
const VirtualizedFileRow = memo(function VirtualizedFileRow({ index, style, data }) {
  const {
    files,
    columnsPerRow,
    selectedFiles = new Set(),
    toggleFileSelection,
    getFileWithEdits,
    editingFiles = {},
    findSmartFolderForCategory,
    findSmartFolderForFile,
    resolveDestination,
    getFileStateDisplay,
    handleEditFile,
    smartFolders = [],
    defaultLocation = '',
    onViewDetails
  } = data || {};
  const startIndex = index * columnsPerRow;
  const rowItems = [];

  if (!files) return null;

  for (let col = 0; col < columnsPerRow; col++) {
    const fileIndex = startIndex + col;
    if (fileIndex >= files.length) break;

    const file = files[fileIndex];
    if (!file) continue;

    const fileWithEdits = getFileWithEdits(file, fileIndex);
    const editKey = toCanonicalPath(file.path);
    const rawCategory = editingFiles[editKey]?.category || fileWithEdits.analysis?.category;
    // Try category match first (preserves existing precedence — least surprise
    // for files that already had a matching folder), then fall back to the
    // per-file matcher so a folder named after the file's vendor / entity
    // still resolves when category doesn't match.
    const routing = resolveRowRouting({
      file,
      fileWithEdits,
      rawCategory,
      resolveDestination,
      findSmartFolderForCategory,
      findSmartFolderForFile
    });
    const smartFolder = routing.folder;
    // Fall back to "Uncategorized" to prevent showing/targeting non-existent folders.
    const uncategorizedFolder = findSmartFolderForCategory('Uncategorized');
    const resolvedFolder = smartFolder || uncategorizedFolder;
    const currentCategory = resolvedFolder?.name || 'Uncategorized';
    const isSelected = selectedFiles.has(toCanonicalPath(file.path));
    const stateDisplay = getFileStateDisplay(file.path, !!file.analysis);
    // An empty defaultLocation would produce paths like '/Finance' instead of 'C:\Users\...\Finance'
    const safeDefaultLocation = defaultLocation && defaultLocation.trim() ? defaultLocation : null;
    const destination = resolvedFolder?.path
      ? resolvedFolder.path
      : safeDefaultLocation
        ? joinPath(safeDefaultLocation, currentCategory)
        : currentCategory;

    rowItems.push(
      // Key on identity, not position: an index-suffixed key remounts every
      // row below a removed/reordered file and drops its local edit state.
      // Selection is keyed by canonical path, so rows are too.
      <div
        key={toCanonicalPath(file.path) || file.id || `unpathed|${fileIndex}`}
        className="flex-1 min-w-0"
      >
        <ReadyFileItem
          file={fileWithEdits}
          index={fileIndex}
          isSelected={isSelected}
          onToggleSelected={toggleFileSelection}
          stateDisplay={stateDisplay}
          smartFolders={smartFolders}
          editing={editingFiles[editKey]}
          onEdit={handleEditFile}
          destination={destination}
          category={currentCategory}
          routing={routing}
          onViewDetails={onViewDetails}
        />
      </div>
    );
  }

  // Fill remaining space if row is incomplete
  while (rowItems.length < columnsPerRow) {
    rowItems.push(
      <div key={`empty-${rowItems.length}`} className="flex-1 min-w-0" aria-hidden="true" />
    );
  }

  return (
    <div style={style} className="flex gap-x-8 gap-y-4 pb-5 box-border min-h-0">
      {rowItems}
    </div>
  );
}, areVirtualizedRowPropsEqual);

VirtualizedFileRow.propTypes = {
  index: PropTypes.number.isRequired,
  style: PropTypes.object.isRequired,
  data: PropTypes.shape({
    files: PropTypes.array.isRequired,
    columnsPerRow: PropTypes.number.isRequired,
    selectedFiles: PropTypes.instanceOf(Set).isRequired,
    toggleFileSelection: PropTypes.func.isRequired,
    getFileWithEdits: PropTypes.func.isRequired,
    editingFiles: PropTypes.object.isRequired,
    findSmartFolderForCategory: PropTypes.func.isRequired,
    findSmartFolderForFile: PropTypes.func,
    resolveDestination: PropTypes.func,
    getFileStateDisplay: PropTypes.func.isRequired,
    handleEditFile: PropTypes.func.isRequired,
    smartFolders: PropTypes.array.isRequired,
    defaultLocation: PropTypes.string.isRequired,
    onViewDetails: PropTypes.func.isRequired
  }).isRequired
};

/**
 * VirtualizedFileGrid - Renders a virtualized grid of file items
 * Uses react-window FixedSizeList for efficient rendering of large file lists
 */
function VirtualizedFileGrid({
  files,
  isLoading = false,
  selectedFiles,
  toggleFileSelection,
  getFileWithEdits,
  editingFiles,
  findSmartFolderForCategory,
  findSmartFolderForFile,
  resolveDestination = null,
  getFileStateDisplay,
  handleEditFile,
  smartFolders,
  defaultLocation,
  containerWidth = 1200, // Default to xl breakpoint width
  onViewDetails,
  focusFileIndex = null,
  onFocusApplied
}) {
  const safeFiles = useMemo(() => (Array.isArray(files) ? files : []), [files]);
  const safeSelectedFiles = useMemo(
    () => (selectedFiles instanceof Set ? selectedFiles : new Set()),
    [selectedFiles]
  );
  const safeEditingFiles = useMemo(
    () =>
      editingFiles && typeof editingFiles === 'object' && !Array.isArray(editingFiles)
        ? editingFiles
        : {},
    [editingFiles]
  );
  const safeSmartFolders = useMemo(
    () => (Array.isArray(smartFolders) ? smartFolders : []),
    [smartFolders]
  );
  const safeDefaultLocation = useMemo(
    () => (typeof defaultLocation === 'string' ? defaultLocation : ''),
    [defaultLocation]
  );

  const containerRef = React.useRef(null);
  const listRef = React.useRef(null);
  const gridRef = React.useRef(null);
  const [dimensions, setDimensions] = useState({ width: containerWidth, height: 600 });
  const [rowHeight, setRowHeight] = useState(DEFAULT_ROW_HEIGHT);

  useEffect(() => {
    if (!containerRef.current) return undefined;

    let isActive = true;
    let rafId = null;

    // This prevents state updates from firing during the resize observer callback
    // which can cause "ResizeObserver loop limit exceeded" errors and memory leaks
    const observer = new ResizeObserver((entries) => {
      if (!isActive) return;

      // Cancel any pending RAF to debounce rapid resize events
      if (rafId) {
        cancelAnimationFrame(rafId);
      }

      rafId = requestAnimationFrame(() => {
        if (!isActive) return;
        const entry = entries[0];
        if (entry) {
          const { width, height } = entry.contentRect;
          const nextWidth = Math.max(1, Math.round(width || containerWidth));
          const nextHeight = Math.max(
            200,
            Math.round(height || (typeof window !== 'undefined' ? window.innerHeight * 0.6 : 600))
          );
          setDimensions((prev) => {
            if (Math.abs(prev.width - nextWidth) < 1 && Math.abs(prev.height - nextHeight) < 1) {
              return prev;
            }
            return { width: nextWidth, height: nextHeight };
          });
        }
      });
    });

    observer.observe(containerRef.current);
    return () => {
      isActive = false;
      if (rafId) {
        cancelAnimationFrame(rafId);
      }
      observer.disconnect();
    };
  }, [containerWidth]);

  const columnsPerRow = getColumnCount(dimensions.width);
  const rowCount = Math.max(1, Math.ceil(safeFiles.length / columnsPerRow));
  const shouldVirtualize = safeFiles.length > VIRTUALIZATION_THRESHOLD;
  const columnWidthEstimate = useMemo(
    () => Math.max(320, Math.floor(dimensions.width / columnsPerRow) - 32),
    [dimensions.width, columnsPerRow]
  );

  useEffect(() => {
    if (focusFileIndex == null || focusFileIndex < 0 || focusFileIndex >= safeFiles.length) {
      return;
    }

    if (shouldVirtualize) {
      const rowIndex = Math.floor(focusFileIndex / columnsPerRow);
      listRef.current?.scrollToRow?.({ index: rowIndex, align: 'smart' });
    } else {
      const el = gridRef.current?.querySelector(`[data-organize-file-index="${focusFileIndex}"]`);
      el?.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
    }

    onFocusApplied?.();
  }, [focusFileIndex, shouldVirtualize, columnsPerRow, safeFiles.length, onFocusApplied]);

  const measureRef = useCallback((node) => {
    if (!node) return;
    const measured = Math.ceil(node.getBoundingClientRect().height);
    const paddedHeight = Math.max(DEFAULT_ROW_HEIGHT, measured + MEASUREMENT_PADDING);
    setRowHeight((prev) =>
      Math.abs(prev - paddedHeight) > ROW_HEIGHT_TOLERANCE ? paddedHeight : prev
    );
  }, []);
  const shouldMeasure =
    shouldVirtualize && safeFiles.length > 0 && rowHeight === DEFAULT_ROW_HEIGHT;

  // findSmartFolderForFile is a sibling prop pulled in via useMemo deps below.
  const sampleItem = useMemo(() => {
    if (!shouldVirtualize || safeFiles.length === 0) return null;
    const sampleIndex = 0;
    const file = safeFiles[sampleIndex];
    const fileWithEdits = getFileWithEdits(file, sampleIndex);
    const sampleKey = toCanonicalPath(file.path);
    const rawCategory = safeEditingFiles[sampleKey]?.category || fileWithEdits.analysis?.category;
    const routing = resolveRowRouting({
      file,
      fileWithEdits,
      rawCategory,
      resolveDestination,
      findSmartFolderForCategory,
      findSmartFolderForFile
    });
    const smartFolder = routing.folder;
    const uncategorizedFolder = findSmartFolderForCategory('Uncategorized');
    const resolvedFolder = smartFolder || uncategorizedFolder;
    const currentCategory = resolvedFolder?.name || 'Uncategorized';
    const stateDisplay = getFileStateDisplay(file.path, !!file.analysis);
    const resolvedDefaultLocation =
      safeDefaultLocation && safeDefaultLocation.trim() ? safeDefaultLocation : null;
    const destination = resolvedFolder?.path
      ? resolvedFolder.path
      : resolvedDefaultLocation
        ? joinPath(resolvedDefaultLocation, currentCategory)
        : currentCategory;

    return {
      routing,
      file: fileWithEdits,
      index: sampleIndex,
      isSelected: safeSelectedFiles.has(toCanonicalPath(file.path)),
      stateDisplay,
      smartFolder: resolvedFolder,
      currentCategory,
      destination,
      editKey: sampleKey
    };
  }, [
    shouldVirtualize,
    safeFiles,
    safeEditingFiles,
    findSmartFolderForCategory,
    findSmartFolderForFile,
    resolveDestination,
    getFileWithEdits,
    getFileStateDisplay,
    safeDefaultLocation,
    safeSelectedFiles
  ]);

  // react-window List passes shared data via rowProps (consumed by the row renderer).
  // Selection Set is included, and row-level memoization only re-renders rows whose
  // selected indices changed.
  const rowProps = useMemo(
    () => ({
      data: {
        files: safeFiles,
        columnsPerRow,
        selectedFiles: safeSelectedFiles,
        toggleFileSelection,
        getFileWithEdits,
        editingFiles: safeEditingFiles,
        findSmartFolderForCategory,
        findSmartFolderForFile,
        resolveDestination,
        getFileStateDisplay,
        handleEditFile,
        smartFolders: safeSmartFolders,
        defaultLocation: safeDefaultLocation,
        onViewDetails
      }
    }),
    [
      safeFiles,
      columnsPerRow,
      safeSelectedFiles,
      toggleFileSelection,
      getFileWithEdits,
      safeEditingFiles,
      findSmartFolderForCategory,
      findSmartFolderForFile,
      resolveDestination,
      getFileStateDisplay,
      handleEditFile,
      safeSmartFolders,
      safeDefaultLocation,
      onViewDetails
    ]
  );
  // Calculate optimal list height based on file count (data-aware sizing)
  const listHeight = useMemo(() => {
    // Use measured height or fallback to viewport calculation
    const availableHeight =
      dimensions.height || (typeof window !== 'undefined' ? window.innerHeight : 900);
    return availableHeight;
  }, [dimensions.height]);

  if (isLoading) {
    return (
      <div
        className="grid grid-cols-auto-fit-md gap-default animate-loading-fade"
        role="status"
        aria-live="polite"
        aria-label="Loading files"
      >
        {[...Array(6)].map((_, i) => (
          <div key={i} className="h-64 rounded-xl bg-system-gray-100 animate-pulse" />
        ))}
      </div>
    );
  }

  if (shouldVirtualize) {
    return (
      <div ref={containerRef} className="relative w-full h-full min-h-[12rem] overflow-x-hidden">
        {/* Helper for measurement only */}
        <div
          style={{
            height: '100%',
            width: '100%',
            position: 'absolute',
            top: 0,
            left: 0,
            pointerEvents: 'none',
            visibility: 'hidden'
          }}
        />

        {sampleItem && shouldMeasure && (
          <div
            aria-hidden
            ref={measureRef}
            className="absolute opacity-0 pointer-events-none"
            style={{ width: `${columnWidthEstimate}px`, maxWidth: '100%' }}
          >
            <ReadyFileItem
              file={sampleItem.file}
              index={sampleItem.index}
              isSelected={sampleItem.isSelected}
              onToggleSelected={toggleFileSelection}
              stateDisplay={sampleItem.stateDisplay}
              smartFolders={smartFolders}
              editing={editingFiles[sampleItem.editKey]}
              onEdit={handleEditFile}
              destination={sampleItem.destination}
              category={sampleItem.currentCategory}
              routing={sampleItem.routing}
              onViewDetails={onViewDetails}
            />
          </div>
        )}
        <Text
          as="div"
          variant="tiny"
          className="text-system-gray-500 mb-2 absolute top-0 right-0 z-10 bg-system-gray-100/90 px-2 py-1 rounded border border-border-soft/60 shadow-sm"
        >
          Showing {safeFiles.length} files
        </Text>
        <List
          key={`list-${rowHeight}-${columnsPerRow}-${safeFiles.length}`}
          listRef={listRef}
          rowCount={rowCount}
          rowHeight={rowHeight}
          rowComponent={VirtualizedFileRow}
          rowProps={rowProps}
          overscanCount={2}
          className="scrollbar-thin scrollbar-thumb-system-gray-300 scrollbar-track-transparent"
          style={{ height: listHeight, width: dimensions.width, paddingBottom: '0.75rem' }}
        />
      </div>
    );
  }

  // For smaller lists, render normally without virtualization overhead
  // Use auto-fit grid that adapts to content amount
  // Added p-6 (padding all around) to ensure shadows are not cut off and provide breathing room
  return (
    <div
      ref={(node) => {
        containerRef.current = node;
        gridRef.current = node;
      }}
      className="grid grid-adaptive-lg gap-x-8 gap-y-8 h-full min-h-0 overflow-y-auto overflow-x-hidden modern-scrollbar py-2 pb-12"
    >
      {safeFiles.map((file, index) => {
        const fileWithEdits = getFileWithEdits(file, index);
        const editKey = toCanonicalPath(file.path);
        const rawCategory = safeEditingFiles[editKey]?.category || fileWithEdits.analysis?.category;
        const routing = resolveRowRouting({
          file,
          fileWithEdits,
          rawCategory,
          resolveDestination,
          findSmartFolderForCategory,
          findSmartFolderForFile
        });
        const smartFolder = routing.folder;
        const uncategorizedFolder = findSmartFolderForCategory('Uncategorized');
        const resolvedFolder = smartFolder || uncategorizedFolder;
        const currentCategory = resolvedFolder?.name || 'Uncategorized';
        const isSelected = safeSelectedFiles.has(toCanonicalPath(file.path));
        const stateDisplay = getFileStateDisplay(file.path, !!file.analysis);
        const resolvedDefaultLocation =
          safeDefaultLocation && safeDefaultLocation.trim() ? safeDefaultLocation : null;
        const destination = resolvedFolder?.path
          ? resolvedFolder.path
          : resolvedDefaultLocation
            ? joinPath(resolvedDefaultLocation, currentCategory)
            : currentCategory;
        return (
          <div
            key={toCanonicalPath(file.path) || file.id || `unpathed|${index}`}
            data-organize-file-index={index}
          >
            <ReadyFileItem
              file={fileWithEdits}
              index={index}
              isSelected={isSelected}
              onToggleSelected={toggleFileSelection}
              stateDisplay={stateDisplay}
              smartFolders={safeSmartFolders}
              editing={safeEditingFiles[editKey]}
              onEdit={handleEditFile}
              destination={destination}
              category={currentCategory}
              routing={routing}
              onViewDetails={onViewDetails}
            />
          </div>
        );
      })}
    </div>
  );
}

VirtualizedFileGrid.propTypes = {
  files: PropTypes.array.isRequired,
  isLoading: PropTypes.bool,
  selectedFiles: PropTypes.instanceOf(Set).isRequired,
  toggleFileSelection: PropTypes.func.isRequired,
  getFileWithEdits: PropTypes.func.isRequired,
  editingFiles: PropTypes.object.isRequired,
  findSmartFolderForCategory: PropTypes.func.isRequired,
  findSmartFolderForFile: PropTypes.func,
  resolveDestination: PropTypes.func,
  getFileStateDisplay: PropTypes.func.isRequired,
  handleEditFile: PropTypes.func.isRequired,
  smartFolders: PropTypes.array.isRequired,
  defaultLocation: PropTypes.string.isRequired,
  containerWidth: PropTypes.number,
  onViewDetails: PropTypes.func.isRequired,
  focusFileIndex: PropTypes.number,
  onFocusApplied: PropTypes.func
};

const MemoizedVirtualizedFileGrid = memo(VirtualizedFileGrid);

export default function VirtualizedFileGridWithErrorBoundary(props) {
  return (
    <ErrorBoundaryCore contextName="File Grid" variant="simple">
      <MemoizedVirtualizedFileGrid {...props} />
    </ErrorBoundaryCore>
  );
}
