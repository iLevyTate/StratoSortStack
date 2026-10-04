import React from 'react';
import PropTypes from 'prop-types';
import { Sparkles } from 'lucide-react';
import { Button, StateMessage } from '../ui';

function EmptyEmbeddingsBanner({
  onRebuildFolders,
  onRebuildFiles,
  isRebuildingFolders,
  isRebuildingFiles,
  embeddingConfig,
  indexHealth,
  onOpenSettings,
  simpleMode = false
}) {
  const timing = embeddingConfig?.timing || null;
  const policy = embeddingConfig?.policy || null;
  const isManual = timing === 'manual';
  const isPolicyDisabled = policy === 'skip' || policy === 'web_only';
  const isDeferred = timing === 'after_organize';
  const needsFileEmbeddingRebuild = Boolean(indexHealth?.needsFileEmbeddingRebuild);
  const embeddingModelMismatch = Boolean(indexHealth?.embeddingModelMismatch);
  const indexedEmbeddingModel =
    typeof indexHealth?.indexedEmbeddingModel === 'string' ? indexHealth.indexedEmbeddingModel : '';
  const activeEmbeddingModel =
    typeof indexHealth?.activeEmbeddingModel === 'string' ? indexHealth.activeEmbeddingModel : '';

  const mismatchDetails =
    indexedEmbeddingModel && activeEmbeddingModel
      ? `Indexed with "${indexedEmbeddingModel}" but active model is "${activeEmbeddingModel}".`
      : 'The active embedding model does not match the model used to build this index.';

  const title = embeddingModelMismatch
    ? simpleMode
      ? 'Search index model mismatch'
      : 'Embedding model mismatch'
    : needsFileEmbeddingRebuild
      ? 'Search index needs rebuild'
      : isManual
        ? simpleMode
          ? 'Search indexing is set to manual'
          : 'Embeddings are set to manual'
        : isPolicyDisabled
          ? simpleMode
            ? 'Search indexing is off'
            : 'Embeddings are disabled'
          : isDeferred
            ? simpleMode
              ? 'Search indexing is deferred until after organize'
              : 'Embeddings are deferred until after organize'
            : simpleMode
              ? 'No search index yet'
              : 'No embeddings yet';

  const description = embeddingModelMismatch
    ? simpleMode
      ? `${mismatchDetails} Rebuild the search index to restore reliable semantic search.`
      : `${mismatchDetails} Rebuild embeddings to restore reliable semantic search.`
    : needsFileEmbeddingRebuild
      ? 'You already have analyzed files, but the embedding index is empty or incomplete. Run a file embedding rebuild from analysis history to restore full Knowledge OS coverage.'
      : isManual
        ? simpleMode
          ? 'Knowledge OS search needs a local search index, but your settings are set to Manual only. Turn automatic indexing back on (Settings -> Embedding behavior), then rebuild to populate the index.'
          : 'Knowledge OS search needs local embeddings, but your settings are set to Manual only. Turn automatic embedding back on (Settings -> Embedding behavior), then rebuild to populate the index.'
        : isPolicyDisabled
          ? simpleMode
            ? `Your default indexing policy is set to "${policy}". Knowledge OS will not build a local search index, so semantic search will return no results.`
            : `Your default embedding policy is set to "${policy}". Knowledge OS won’t create local embeddings, so semantic search will return no results.`
          : isDeferred
            ? simpleMode
              ? 'Your indexing timing is set to After organize/move. Files will be indexed once they are moved into Smart Folders. You can also run a rebuild now.'
              : 'Your embedding timing is set to After organize/move. Files will be indexed once they are moved into Smart Folders. You can also run a rebuild now.'
            : simpleMode
              ? 'Knowledge OS requires a file search index. If you already analyzed files in the past but this number is still zero, the index was likely reset and needs a one-time rebuild from analysis history.'
              : 'Knowledge OS requires file embeddings. If you already analyzed files in the past but this number is still zero, your search index was likely reset and needs a one-time rebuild from analysis history.';

  return (
    <StateMessage
      icon={Sparkles}
      tone="warning"
      size="md"
      align="left"
      title={title}
      description={description}
      action={
        <div className="flex flex-wrap gap-compact">
          {onOpenSettings && (isManual || isPolicyDisabled || isDeferred) && (
            <Button variant="secondary" size="sm" onClick={onOpenSettings}>
              Open settings
            </Button>
          )}
          <Button
            variant="secondary"
            size="sm"
            onClick={onRebuildFolders}
            disabled={isRebuildingFolders}
          >
            {isRebuildingFolders
              ? 'Building...'
              : simpleMode
                ? 'Build folder index'
                : 'Build folder embeddings'}
          </Button>
          <Button variant="primary" size="sm" onClick={onRebuildFiles} disabled={isRebuildingFiles}>
            {isRebuildingFiles
              ? 'Building...'
              : simpleMode
                ? 'Build file index'
                : 'Build file embeddings'}
          </Button>
        </div>
      }
      className="glass-panel border border-stratosort-warning/30 bg-stratosort-warning/10 p-4 rounded-xl"
      contentClassName="max-w-xl"
    />
  );
}

EmptyEmbeddingsBanner.propTypes = {
  onRebuildFolders: PropTypes.func.isRequired,
  onRebuildFiles: PropTypes.func.isRequired,
  isRebuildingFolders: PropTypes.bool.isRequired,
  isRebuildingFiles: PropTypes.bool.isRequired,
  embeddingConfig: PropTypes.shape({
    timing: PropTypes.oneOf(['during_analysis', 'after_organize', 'manual']),
    policy: PropTypes.oneOf(['embed', 'skip', 'web_only'])
  }),
  indexHealth: PropTypes.shape({
    needsFileEmbeddingRebuild: PropTypes.bool,
    embeddingModelMismatch: PropTypes.bool,
    indexedEmbeddingModel: PropTypes.string,
    activeEmbeddingModel: PropTypes.string
  }),
  onOpenSettings: PropTypes.func,
  simpleMode: PropTypes.bool
};
EmptyEmbeddingsBanner.displayName = 'EmptyEmbeddingsBanner';

export default EmptyEmbeddingsBanner;
