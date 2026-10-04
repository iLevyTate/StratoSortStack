import React, { memo } from 'react';
import PropTypes from 'prop-types';
import ResultRow from './ResultRow';

const EMPTY_SET = Object.freeze(new Set());

/**
 * Virtualized search result row adapter — wraps ResultRow with the
 * (index, style, results, ...) signature that react-window's List
 * passes to its `rowComponent`.
 */
const VirtualizedSearchResultRow = memo(function VirtualizedSearchResultRow({
  index,
  style,
  results = [],
  selectedSearchId,
  bulkSelectedIds = EMPTY_SET,
  focusedResultIndex,
  query = '',
  onSelect,
  onToggleBulk,
  onOpen,
  onReveal,
  onCopyPath,
  showGraphActions = true
}) {
  const result = results?.[index];
  if (!result) return null;
  return (
    <div style={style} className="pb-2">
      <ResultRow
        result={result}
        isSelected={result.id === selectedSearchId}
        isBulkSelected={bulkSelectedIds?.has(result.id)}
        isFocused={index === focusedResultIndex}
        query={query}
        index={index}
        onSelect={onSelect}
        onToggleBulk={onToggleBulk}
        onOpen={onOpen}
        onReveal={onReveal}
        onCopyPath={onCopyPath}
        showGraphActions={showGraphActions}
      />
    </div>
  );
});

VirtualizedSearchResultRow.propTypes = {
  index: PropTypes.number.isRequired,
  style: PropTypes.object.isRequired,
  results: PropTypes.array.isRequired,
  selectedSearchId: PropTypes.string,
  bulkSelectedIds: PropTypes.instanceOf(Set),
  focusedResultIndex: PropTypes.number.isRequired,
  query: PropTypes.string.isRequired,
  onSelect: PropTypes.func.isRequired,
  onToggleBulk: PropTypes.func.isRequired,
  onOpen: PropTypes.func.isRequired,
  onReveal: PropTypes.func.isRequired,
  onCopyPath: PropTypes.func.isRequired,
  showGraphActions: PropTypes.bool
};

export default VirtualizedSearchResultRow;
