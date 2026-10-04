import React from 'react';
import PropTypes from 'prop-types';
import { AlertTriangle } from 'lucide-react';
import { Button } from '../ui';
import { Text } from '../ui/Typography';

function IndexHealthBanner({
  stats,
  onRebuildFiles,
  isRebuildingFiles,
  onOpenSettings,
  simpleMode = false
}) {
  const coverageLow =
    Boolean(stats?.embeddingCoverageLow) &&
    !stats?.embeddingModelMismatch &&
    !stats?.needsFileEmbeddingRebuild;
  if (!stats?.embeddingModelMismatch && !stats?.needsFileEmbeddingRebuild && !coverageLow) {
    return null;
  }

  const indexedEmbeddingModel =
    typeof stats?.indexedEmbeddingModel === 'string' ? stats.indexedEmbeddingModel : '';
  const activeEmbeddingModel =
    typeof stats?.activeEmbeddingModel === 'string' ? stats.activeEmbeddingModel : '';
  const details =
    indexedEmbeddingModel && activeEmbeddingModel
      ? `Indexed with "${indexedEmbeddingModel}" but active model is "${activeEmbeddingModel}".`
      : 'Embedding health requires attention.';

  // Coverage warning (F-197): a partial index used to read as healthy.
  const uncovered = Number(stats?.uncoveredFiles) || 0;
  const analyzedTotal = Number(stats?.analysisHistoryTotal) || 0;
  const coveragePercent =
    typeof stats?.embeddingCoverage === 'number' ? Math.round(stats.embeddingCoverage * 100) : null;

  let title;
  let description;
  if (stats?.embeddingModelMismatch) {
    title = simpleMode
      ? 'Search index model mismatch detected.'
      : 'Embedding model mismatch detected.';
    description = `${details} ${simpleMode ? 'Rebuild the search index to restore consistent ranking.' : 'Rebuild embeddings to restore consistent semantic ranking.'}`;
  } else if (stats?.needsFileEmbeddingRebuild) {
    title = 'Search index is empty.';
    description = simpleMode
      ? 'Build the file search index to enable semantic search coverage.'
      : 'Build file embeddings to enable semantic search coverage.';
  } else {
    title = `${uncovered}${analyzedTotal > 0 ? ` of ${analyzedTotal}` : ''} analyzed file${uncovered === 1 ? ' is' : 's are'} missing from search${coveragePercent !== null ? ` (${coveragePercent}% covered)` : ''}.`;
    description = simpleMode
      ? 'They are indexed in the background at startup; Rebuild does it now.'
      : 'They are re-embedded in the background at startup; Rebuild does it now.';
  }

  return (
    <div className="glass-panel border border-stratosort-warning/30 bg-stratosort-warning/5 px-3 py-2 rounded-lg flex items-start justify-between gap-cozy">
      <div className="flex items-start gap-compact">
        <AlertTriangle className="w-4 h-4 text-stratosort-warning shrink-0 mt-0.5" />
        <Text as="span" variant="tiny" className="text-system-gray-700">
          <strong>{title}</strong> {description}
        </Text>
      </div>
      <div className="flex gap-compact shrink-0">
        {onOpenSettings && (
          <Button variant="secondary" size="xs" onClick={onOpenSettings}>
            Settings
          </Button>
        )}
        <Button variant="primary" size="xs" onClick={onRebuildFiles} disabled={isRebuildingFiles}>
          {isRebuildingFiles ? 'Building...' : 'Rebuild'}
        </Button>
      </div>
    </div>
  );
}

IndexHealthBanner.propTypes = {
  stats: PropTypes.shape({
    files: PropTypes.number,
    uncoveredFiles: PropTypes.number,
    needsFileEmbeddingRebuild: PropTypes.bool,
    embeddingCoverageLow: PropTypes.bool,
    analysisHistoryTotal: PropTypes.number,
    embeddingCoverage: PropTypes.number,
    embeddingModelMismatch: PropTypes.bool,
    indexedEmbeddingModel: PropTypes.string,
    activeEmbeddingModel: PropTypes.string
  }),
  onRebuildFiles: PropTypes.func.isRequired,
  isRebuildingFiles: PropTypes.bool.isRequired,
  onOpenSettings: PropTypes.func,
  simpleMode: PropTypes.bool
};
IndexHealthBanner.displayName = 'IndexHealthBanner';

export default IndexHealthBanner;
