import React, { memo } from 'react';
import PropTypes from 'prop-types';
import { CheckSquare, Copy, ExternalLink, FolderOpen, Network, Square } from 'lucide-react';
import { IconButton } from '../ui';
import HighlightedText from '../ui/HighlightedText';
import { Text } from '../ui/Typography';
import normalizeList from '../../utils/normalizeList';
import { normalizeConfidence } from '../../utils/scoreUtils';
import { getMetadataPath, getMetadataName } from './utils';

const ResultRow = memo(function ResultRow({
  result,
  isSelected,
  isBulkSelected,
  isFocused,
  query,
  index = 0,
  onSelect,
  onToggleBulk,
  onOpen,
  onReveal,
  onCopyPath,
  showGraphActions = true
}) {
  const path = getMetadataPath(result, result?.id);
  const name = getMetadataName(result, path, result?.id) || result?.id || 'Unknown';
  const category = result?.metadata?.category || 'Uncategorized';

  // Format date and confidence
  // The vector DB stores the date under 'documentDate'; 'date' is a legacy alias
  const rawDate = result?.metadata?.documentDate || result?.metadata?.date;
  const parsedDate = rawDate ? new Date(rawDate) : null;
  const dateStr =
    parsedDate && !Number.isNaN(parsedDate.getTime()) ? parsedDate.toLocaleDateString() : '';

  const confidence = result?.metadata?.confidence || 0;

  // Keywords are stored as 'tags' (array) in the vector DB; 'keywords' is a legacy alias
  const rawKeywords = result?.metadata?.tags || result?.metadata?.keywords || [];
  const keywords = Array.isArray(rawKeywords)
    ? rawKeywords
    : typeof rawKeywords === 'string' && rawKeywords.length > 0
      ? rawKeywords
          .split(',')
          .map((k) => k.trim())
          .filter(Boolean)
      : [];
  const keywordDisplay = keywords.slice(0, 8);
  const keywordOverflow = Math.max(0, keywords.length - keywordDisplay.length);

  const entities = normalizeList(result?.metadata?.keyEntities).slice(0, 3);
  const dates = normalizeList(result?.metadata?.dates).slice(0, 2);

  // Calculate animation delay - stagger up to 300ms max
  const animationDelay = `${Math.min(index * 30, 300)}ms`;

  return (
    <div
      data-result-item
      style={{ animationDelay }}
      className={`
        group w-full text-left rounded-xl border p-4 transition-colors transition-shadow [transition-duration:var(--motion-duration-fast)] [transition-timing-function:var(--motion-ease-standard)] cursor-pointer search-result-item relative
        ${
          isSelected
            ? 'border-stratosort-blue/35 bg-stratosort-blue/8 shadow-sm'
            : 'border-border-soft bg-system-gray-100/90 hover:border-stratosort-blue/20 hover:bg-system-gray-100 hover:shadow-md'
        }
        ${isBulkSelected ? 'ring-2 ring-stratosort-blue/20' : ''}
        ${isFocused && !isSelected ? 'ring-2 ring-stratosort-blue/40 border-stratosort-blue/50' : ''}
      `}
    >
      {/* Bulk Selection Checkbox */}
      <IconButton
        onClick={(e) => {
          e.stopPropagation();
          onToggleBulk(result.id);
        }}
        icon={
          isBulkSelected ? (
            <CheckSquare className="w-5 h-5 text-stratosort-blue bg-system-gray-100 rounded-sm" />
          ) : (
            <Square className="w-5 h-5 text-system-gray-300 bg-system-gray-100 rounded-sm" />
          )
        }
        size="sm"
        variant="ghost"
        className={`absolute top-4 left-3 z-10 h-7 w-7 p-0.5 transition-opacity focus-visible:opacity-100 ${isBulkSelected ? 'opacity-100' : 'opacity-0 group-hover:opacity-100 group-focus-within:opacity-100'}`}
        title={isBulkSelected ? 'Deselect' : 'Select'}
        aria-label={isBulkSelected ? 'Deselect result' : 'Select result'}
      />

      <button
        type="button"
        onClick={() => onSelect(result, index)}
        className={`block w-full pl-7 text-left${isSelected ? ' pb-14' : ''}`}
      >
        {/* Header: Name and Date */}
        <div className="flex justify-between items-start gap-default mb-1">
          <div className="min-w-0 flex-1">
            <HighlightedText
              text={name}
              query={query}
              className="font-semibold text-system-gray-900 truncate block text-base"
            />
          </div>
          {dateStr && (
            <Text
              as="span"
              variant="tiny"
              className="text-system-gray-400 whitespace-nowrap pt-1 font-medium"
            >
              {dateStr}
            </Text>
          )}
        </div>

        {/* Sub-header: Category and Confidence */}
        <div className="flex items-center gap-cozy mb-3">
          <Text as="span" variant="small" className="text-stratosort-blue font-medium">
            {category}
          </Text>
          <Text as="span" variant="small" className="text-system-gray-400">
            Confidence: {normalizeConfidence(confidence)}%
          </Text>
        </div>

        {/* Keywords / Tags */}
        {keywordDisplay.length > 0 && (
          <div className="flex flex-wrap gap-compact">
            {keywordDisplay.map((keyword, idx) => (
              <Text
                as="span"
                variant="tiny"
                key={`${result.id}-kw-${idx}`}
                className="px-3 py-1 rounded-full bg-stratosort-blue/10 text-stratosort-blue font-medium"
              >
                {keyword}
              </Text>
            ))}
            {keywordOverflow > 0 && (
              <Text as="span" variant="tiny" className="text-system-gray-400">
                +{keywordOverflow} more
              </Text>
            )}
          </div>
        )}
        {(entities.length > 0 || dates.length > 0) && (
          <div className="mt-2 space-y-1">
            {entities.length > 0 && (
              <Text as="div" variant="tiny" className="text-system-gray-500">
                Entities: {entities.join(', ')}
              </Text>
            )}
            {dates.length > 0 && (
              <Text as="div" variant="tiny" className="text-system-gray-500">
                Dates: {dates.join(', ')}
              </Text>
            )}
          </div>
        )}
      </button>

      {/* Quick actions - only on selected */}
      {isSelected && (
        <div className="absolute bottom-4 right-4 flex gap-1 rounded-lg border border-border-soft bg-system-gray-100/90 p-1 shadow-sm">
          <IconButton
            onClick={(e) => {
              e.stopPropagation();
              onOpen(path);
            }}
            title="Open file"
            aria-label="Open file"
            size="sm"
            variant="ghost"
            className="h-7 w-7 hover:bg-stratosort-blue/10"
            icon={<ExternalLink className="w-4 h-4 text-stratosort-blue" />}
          />
          <IconButton
            onClick={(e) => {
              e.stopPropagation();
              onReveal(path);
            }}
            title="Show in folder"
            aria-label="Show in folder"
            size="sm"
            variant="ghost"
            className="h-7 w-7 hover:bg-stratosort-blue/10"
            icon={<FolderOpen className="w-4 h-4 text-stratosort-blue" />}
          />
          <IconButton
            onClick={(e) => {
              e.stopPropagation();
              onCopyPath(path);
            }}
            title="Copy path"
            aria-label="Copy path"
            size="sm"
            variant="ghost"
            className="h-7 w-7 hover:bg-stratosort-blue/10"
            icon={<Copy className="w-4 h-4 text-stratosort-blue" />}
          />
          {showGraphActions && (
            <IconButton
              onClick={(e) => {
                e.stopPropagation();
                window.dispatchEvent(
                  new CustomEvent('graph:viewInGraph', {
                    detail: {
                      resultId: result.id,
                      resultPath: path || null
                    }
                  })
                );
              }}
              title="View in graph"
              aria-label="View in graph"
              size="sm"
              variant="ghost"
              className="h-7 w-7 hover:bg-stratosort-indigo/10"
              icon={<Network className="w-4 h-4 text-stratosort-indigo" />}
            />
          )}
        </div>
      )}
    </div>
  );
});

ResultRow.propTypes = {
  result: PropTypes.object.isRequired,
  isSelected: PropTypes.bool.isRequired,
  isBulkSelected: PropTypes.bool.isRequired,
  isFocused: PropTypes.bool,
  query: PropTypes.string,
  index: PropTypes.number,
  onSelect: PropTypes.func.isRequired,
  onToggleBulk: PropTypes.func.isRequired,
  onOpen: PropTypes.func.isRequired,
  onReveal: PropTypes.func.isRequired,
  onCopyPath: PropTypes.func.isRequired,
  showGraphActions: PropTypes.bool
};
ResultRow.displayName = 'ResultRow';

export default ResultRow;
