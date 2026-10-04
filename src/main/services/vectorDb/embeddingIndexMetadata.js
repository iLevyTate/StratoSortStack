// @ts-check
/**
 * Embedding Index Metadata
 *
 * Stores metadata about the current embedding index (model name, dimensions, source).
 * Used for mismatch warnings and rebuild prompts.
 *
 * The `rebuildInProgress` flag is set before `resetAll()` during a full rebuild and
 * cleared once the rebuild finishes. If startup sees it still set, the prior run
 * crashed mid-rebuild and the index must be considered torn (triggers rebuild prompt).
 *
 * @module services/vectorDb/embeddingIndexMetadata
 */

const path = require('path');
const { app } = require('electron');
const { atomicWriteFile, loadJsonFile } = require('../../../shared/atomicFile');

const METADATA_FILENAME = 'embedding-index.json';

function getMetadataPath() {
  return path.join(app.getPath('userData'), METADATA_FILENAME);
}

async function readEmbeddingIndexMetadata() {
  return loadJsonFile(getMetadataPath(), {
    description: 'embedding index metadata',
    backupCorrupt: true
  });
}

async function writeEmbeddingIndexMetadata(/** @type {any} */ metadata) {
  if (!metadata || typeof metadata !== 'object') return;
  const payload = {
    ...metadata,
    updatedAt: new Date().toISOString()
  };
  await atomicWriteFile(getMetadataPath(), payload, { pretty: true });
}

/**
 * Merge-update the metadata file. Used by the rebuild flow to flip the
 * `rebuildInProgress` flag without clobbering existing model/dims.
 */
async function updateEmbeddingIndexMetadata(/** @type {any} */ patch) {
  if (!patch || typeof patch !== 'object') return;
  let existing;
  try {
    existing = await readEmbeddingIndexMetadata();
  } catch {
    existing = null;
  }
  const merged = {
    ...(existing || {}),
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await atomicWriteFile(getMetadataPath(), merged, { pretty: true });
}

/**
 * Mark a full rebuild as in-progress. Called immediately before `resetAll()`
 * so that a crash/kill mid-rebuild can be detected on next startup.
 */
/** @param {{ model?: string, dims?: number, source?: string }} [opts] */
async function markRebuildInProgress({ model, dims, source } = {}) {
  await updateEmbeddingIndexMetadata({
    rebuildInProgress: true,
    rebuildStartedAt: new Date().toISOString(),
    model: model || undefined,
    dims: Number.isFinite(dims) ? dims : undefined,
    source: source || 'full-rebuild'
  });
}

/**
 * Clear the rebuild-in-progress marker once the rebuild has finished successfully.
 */
async function clearRebuildInProgress(finalMetadata = {}) {
  await updateEmbeddingIndexMetadata({
    ...finalMetadata,
    rebuildInProgress: false,
    rebuildStartedAt: null,
    rebuildCompletedAt: new Date().toISOString()
  });
}

module.exports = {
  readEmbeddingIndexMetadata,
  writeEmbeddingIndexMetadata,
  updateEmbeddingIndexMetadata,
  markRebuildInProgress,
  clearRebuildInProgress
};
