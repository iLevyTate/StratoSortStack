import React from 'react';
import PropTypes from 'prop-types';
import { AlertTriangle, RefreshCw } from 'lucide-react';
import { IconButton } from '../ui';
import { Text } from '../ui/Typography';

function StatsDisplay({ stats, isLoadingStats, statsUnavailable, onRefresh, simpleMode = false }) {
  const smartFolderCount =
    typeof stats?.smartFolderCount === 'number' ? stats.smartFolderCount : null;
  const folderEmbeddingCount = typeof stats?.folders === 'number' ? stats.folders : null;
  const healthHint = stats?.embeddingModelMismatch
    ? 'model mismatch'
    : stats?.embeddingBuildInProgress
      ? 'indexing…'
      : stats?.needsFileEmbeddingRebuild
        ? typeof stats?.files === 'number' && stats.files > 0
          ? 'incomplete index'
          : 'empty index'
        : stats?.embeddingCoverageLow
          ? 'incomplete index'
          : '';

  // Visually flag stale stats while a refresh is in flight. Previously we
  // ignored `isLoadingStats` when `stats` was already populated (the else-if
  // branch below only renders during a cold load), so the UI showed the
  // previous snapshot's counts with no indication that a refresh was
  // running. For users on the settings screen who toggle "rebuild index",
  // this looked like the change silently did nothing.
  const isStale = Boolean(isLoadingStats && stats);

  return (
    <div className="flex items-center gap-compact" aria-busy={isStale || undefined}>
      {stats ? (
        <Text
          as="span"
          variant="tiny"
          className={`flex items-center gap-1 text-system-gray-500 ${
            isStale ? 'opacity-60 animate-loading-fade' : ''
          }`.trim()}
          title={isStale ? 'Refreshing index stats…' : undefined}
        >
          {typeof smartFolderCount === 'number' && (
            <>
              <Text as="span" variant="tiny" className="font-medium text-system-gray-700">
                {smartFolderCount}
              </Text>
              <span>smart folder{smartFolderCount !== 1 ? 's' : ''}</span>
              <span className="text-system-gray-300">•</span>
            </>
          )}
          {typeof smartFolderCount !== 'number' && typeof folderEmbeddingCount === 'number' && (
            <>
              <Text as="span" variant="tiny" className="font-medium text-system-gray-700">
                {folderEmbeddingCount}
              </Text>
              <span>
                {simpleMode
                  ? `indexed folder${folderEmbeddingCount !== 1 ? 's' : ''}`
                  : `folder embedding${folderEmbeddingCount !== 1 ? 's' : ''}`}
              </span>
              <span className="text-system-gray-300">•</span>
            </>
          )}
          <Text as="span" variant="tiny" className="font-medium text-system-gray-700">
            {stats.files}
          </Text>
          <span>{`file${stats.files !== 1 ? 's' : ''} indexed`}</span>
          {healthHint && (
            <>
              <span className="text-system-gray-300">•</span>
              <span className="font-medium text-stratosort-warning">{healthHint}</span>
            </>
          )}
        </Text>
      ) : isLoadingStats ? (
        <Text
          as="span"
          variant="tiny"
          className="flex items-center gap-compact text-system-gray-400 animate-loading-fade"
        >
          <span className="inline-flex h-2 w-2 animate-pulse rounded-full bg-system-gray-300" />
          Loading index...
        </Text>
      ) : statsUnavailable ? (
        <Text
          as="span"
          variant="tiny"
          className="flex items-center gap-compact text-stratosort-warning"
        >
          <AlertTriangle className="h-3.5 w-3.5" />
          Search offline
        </Text>
      ) : (
        <Text as="span" variant="tiny" className="text-system-gray-400">
          {simpleMode ? 'No search index yet' : 'No embeddings'}
        </Text>
      )}
      <IconButton
        icon={<RefreshCw className={`h-3.5 w-3.5 ${isLoadingStats ? 'animate-spin' : ''}`} />}
        size="sm"
        variant="ghost"
        onClick={onRefresh}
        disabled={isLoadingStats}
        title={simpleMode ? 'Refresh search index status' : 'Refresh embeddings status'}
        aria-label={simpleMode ? 'Refresh search index status' : 'Refresh embeddings status'}
        className="h-7 w-7 text-system-gray-400 hover:text-system-gray-700"
      />
    </div>
  );
}

StatsDisplay.propTypes = {
  stats: PropTypes.object,
  isLoadingStats: PropTypes.bool.isRequired,
  statsUnavailable: PropTypes.bool,
  onRefresh: PropTypes.func.isRequired,
  simpleMode: PropTypes.bool
};
StatsDisplay.displayName = 'StatsDisplay';

export default StatsDisplay;
