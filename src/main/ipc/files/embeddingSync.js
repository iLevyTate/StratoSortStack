// @ts-check
const path = require('path');
const { logger: baseLogger, createLogger } = require('../../../shared/logger');
const { getSemanticFileId, isImagePath } = require('../../../shared/fileIdUtils');
const { buildEmbeddingSummary } = require('../../analysis/embeddingSummary');
const { resolveEmbeddingModelOptions } = require('../../analysis/embeddingModelOptions');
const { findContainingSmartFolder } = require('../../../shared/folderUtils');
const { getAllIdVariants } = require('../../utils/fileIdUtils');
const { organizeQueue } = require('../../analysis/embeddingQueue/stageQueues');
const embeddingQueueManager = require('../../analysis/embeddingQueue/queueManager');
const { shouldEmbed } = require('../../services/embedding/embeddingGate');
const { crossPlatformBasename } = require('../../../shared/crossPlatformUtils');

const logger =
  typeof createLogger === 'function' ? createLogger('IPC:Files:EmbeddingSync') : baseLogger;
if (typeof createLogger !== 'function' && logger?.setContext) {
  logger.setContext('IPC:Files:EmbeddingSync');
}

/** Off by default: avoid stalling file moves on organize queue depth (orchestration can throttle elsewhere). */
const ENABLE_ORGANIZE_EMBEDDING_QUEUE_WAIT =
  String(process.env.STRATOSORT_ORGANIZE_EMBEDDING_QUEUE_WAIT || '').toLowerCase() === 'true';

/**
 * @typedef {{ vectorDbService: any, analysisHistoryService: any, folderMatchingService: any, learningFeedbackService: any }} ResolvedServices
 */

/**
 * @returns {ResolvedServices}
 */
function resolveServices() {
  try {
    const { container, ServiceIds } = require('../../services/ServiceContainer');
    /** @param {string} serviceId */
    const safeResolve = (serviceId) => {
      if (typeof container.tryResolve === 'function') {
        return container.tryResolve(serviceId);
      }
      if (typeof container.resolve === 'function') {
        if (typeof container.has === 'function' && !container.has(serviceId)) {
          return null;
        }
        try {
          return container.resolve(serviceId);
        } catch {
          return null;
        }
      }
      return null;
    };

    return {
      vectorDbService: safeResolve(ServiceIds.ORAMA_VECTOR),
      analysisHistoryService: safeResolve(ServiceIds.ANALYSIS_HISTORY),
      folderMatchingService: safeResolve(ServiceIds.FOLDER_MATCHING),
      learningFeedbackService: safeResolve(ServiceIds.LEARNING_FEEDBACK)
    };
  } catch (error) {
    logger.debug('[EmbeddingSync] Failed to resolve services:', error?.message);
    return {
      vectorDbService: null,
      analysisHistoryService: null,
      folderMatchingService: null,
      learningFeedbackService: null
    };
  }
}

/**
 * @param {string} destPath
 * @param {ResolvedServices} services
 * @param {any[]} [smartFoldersOverride]
 */
function getSmartFolderForPath(destPath, services, smartFoldersOverride) {
  const folders = Array.isArray(smartFoldersOverride)
    ? smartFoldersOverride
    : services.learningFeedbackService?.getSmartFolders?.() || [];
  return findContainingSmartFolder(destPath, folders);
}

/**
 * @param {number|null|undefined} confidence
 */
function normalizeConfidence(confidence) {
  if (typeof confidence !== 'number') return 0;
  return confidence > 1 ? Math.round(confidence) : Math.round(confidence * 100);
}

/**
 * @param {{ analysis: Record<string, any>, entry: Record<string, any>|null|undefined, destPath: string, fileExtension: string, type: string, summary: string, smartFolder: { name?: string, path?: string }|null }} params
 */
function buildEmbeddingMeta({
  analysis,
  entry,
  destPath,
  fileExtension,
  type,
  summary,
  smartFolder
}) {
  const extractedText = analysis.extractedText || '';
  const fileName = crossPlatformBasename(destPath);
  const documentType =
    analysis.documentType || (analysis.type && analysis.type !== type ? analysis.type : '');

  /** @type {Record<string, any>} */
  const meta = {
    path: destPath,
    name: fileName,
    fileExtension,
    fileSize: entry?.fileSize || null,
    category: smartFolder?.name || analysis.category || 'Uncategorized',
    confidence: normalizeConfidence(analysis.confidence ?? 0),
    type,
    extractionMethod: analysis.extractionMethod || (extractedText ? 'content' : 'analysis'),
    summary: (summary || analysis.summary || analysis.purpose || '').substring(0, 2000),
    tags: Array.isArray(analysis.keywords) ? analysis.keywords : [],
    keywords: Array.isArray(analysis.keywords) ? analysis.keywords : [],
    date: analysis.documentDate || analysis.date || null,
    suggestedName: analysis.suggestedName || null,
    entity: analysis.entity || '',
    project: analysis.project || '',
    purpose: (analysis.purpose || '').substring(0, 1000),
    reasoning: (analysis.reasoning || '').substring(0, 500),
    documentType,
    keyEntities: Array.isArray(analysis.keyEntities) ? analysis.keyEntities.slice(0, 20) : [],
    extractedText: extractedText.substring(0, 5000),
    smartFolder: smartFolder?.name || null,
    smartFolderPath: smartFolder?.path || null
  };

  if (type === 'image') {
    meta.content_type = analysis.content_type || 'unknown';
    meta.colors = Array.isArray(analysis.colors) ? analysis.colors : [];
    meta.has_text = analysis.has_text === true;
  }

  return meta;
}

/**
 * @param {string|null|undefined} filePath
 * @param {ResolvedServices} services
 * @param {import('../ipcWrappers').LoggerLike} [log]
 */
async function removeEmbeddingsForPath(filePath, services, log = logger) {
  if (!filePath) return { removed: 0 };

  const embeddingQueueRemoved = embeddingQueueManager?.removeByFilePath
    ? embeddingQueueManager.removeByFilePath(filePath)
    : 0;

  const vectorDbService = services.vectorDbService;
  if (!vectorDbService) {
    log.warn(
      '[EmbeddingSync] Vector DB service unavailable for embedding removal - potential orphaned embeddings',
      { filePath }
    );
    return { removed: embeddingQueueRemoved, error: 'service_unavailable' };
  }

  try {
    const ids = getAllIdVariants(filePath);
    let dbRemovedCount = 0;

    if (typeof vectorDbService.batchDeleteFileEmbeddings === 'function') {
      const result = await vectorDbService.batchDeleteFileEmbeddings(ids);
      if (result && result.success) {
        dbRemovedCount = ids.length;
      } else if (result && result.queued) {
        dbRemovedCount = 0; // Queued for later, not yet removed
        logger.debug('[EmbeddingSync] Embedding deletions queued, not yet confirmed');
      } else if (result && result.error) {
        log.warn('[EmbeddingSync] Batch delete failed', { error: result.error });
      }
    } else if (typeof vectorDbService.deleteFileEmbedding === 'function') {
      for (const id of ids) {
        const result = await vectorDbService.deleteFileEmbedding(id);
        if (result === true || (result && (result.success || result.queued))) {
          dbRemovedCount++;
        }
      }
    }

    // PERF: Batch deleteFileChunks calls in parallel instead of sequential
    let chunkDeleteFailures = 0;
    if (typeof vectorDbService.deleteFileChunks === 'function') {
      const chunkDeletePromises = ids.map((id) => vectorDbService.deleteFileChunks(id));
      const chunkResults = await Promise.allSettled(chunkDeletePromises);
      const failures = chunkResults.filter((result) => result.status === 'rejected');
      chunkDeleteFailures = failures.length;
      if (failures.length > 0) {
        log.warn('[EmbeddingSync] Failed to delete some chunks', {
          failures: failures.length,
          errors: failures.map((result) => result.reason?.message || 'Unknown error')
        });
      }
    }

    return {
      removed: dbRemovedCount + embeddingQueueRemoved,
      ...(chunkDeleteFailures > 0 && { chunkDeleteFailures })
    };
  } catch (error) {
    log.warn('[EmbeddingSync] Failed to remove embeddings', {
      filePath,
      error: error.message
    });
    return { removed: embeddingQueueRemoved, error: error.message };
  }
}

/**
 * @param {string|null|undefined} filePath
 * @param {import('../ipcWrappers').LoggerLike} [log]
 */
async function removeEmbeddingsForPathBestEffort(filePath, log = logger) {
  if (!filePath) return { removed: 0 };
  const services = resolveServices();
  return removeEmbeddingsForPath(filePath, services, log);
}

/**
 * @param {{ sourcePath?: string|null, destPath: string, smartFolders?: any[], operation?: string, log?: import('../ipcWrappers').LoggerLike }} params
 */
async function syncEmbeddingForMove({
  sourcePath,
  destPath,
  smartFolders,
  operation = 'move',
  log = logger
}) {
  if (!destPath) return { action: 'skipped', reason: 'missing-dest' };

  const services = resolveServices();
  const smartFolder = getSmartFolderForPath(destPath, services, smartFolders);

  // When destination is NOT in a smart folder, behavior depends on the
  // embeddingScope setting:
  // - 'all_analyzed': preserve embedding but update its path metadata
  // - 'smart_folders_only': remove embedding (file left the monitored scope)
  if (!smartFolder) {
    // Check the scope setting to decide whether to preserve or remove
    const gate = await shouldEmbed({ stage: 'final', isInSmartFolder: false });

    if (gate.scope === 'smart_folders_only') {
      // User chose to only embed smart-folder files — clean up
      await removeEmbeddingsForPath(destPath, services, log);
      if (operation !== 'copy' && sourcePath && sourcePath !== destPath) {
        await removeEmbeddingsForPath(sourcePath, services, log);
      }
      try {
        const hs = services.analysisHistoryService;
        await hs?.updateEmbeddingStateByPath?.(destPath, { status: 'skipped' });
      } catch {
        // non-fatal
      }
      return { action: 'removed', reason: 'not-smart-folder' };
    }

    // Scope is 'all_analyzed' — preserve embedding, just update path metadata
    const vectorDbService = services.vectorDbService;
    const sourceId = sourcePath ? getSemanticFileId(sourcePath) : null;
    const destId = getSemanticFileId(destPath);

    if (vectorDbService?.updateFilePaths && sourceId && operation !== 'copy') {
      try {
        await vectorDbService.initialize?.();
        /** @type {{ path: string, name: string, smartFolder: string|null, smartFolderPath: string|null }} */
        const newMeta = {
          path: destPath,
          name: crossPlatformBasename(destPath),
          smartFolder: null,
          smartFolderPath: null
        };
        let updated = await vectorDbService.updateFilePaths([
          { oldId: sourceId, newId: destId, newMeta }
        ]);
        if (updated === 0) {
          // FilePathCoordinator has usually re-keyed the row to the new id
          // before this runs; the metadata still needs clearing, so address
          // the row where it now is.
          updated = await vectorDbService.updateFilePaths([
            { oldId: destId, newId: destId, newMeta }
          ]);
        }
        if (updated > 0) {
          log.debug('[EmbeddingSync] Updated embedding path for non-smart-folder move', {
            sourcePath,
            destPath
          });
          return { action: 'updated_meta', reason: 'not-smart-folder' };
        }
      } catch (err) {
        log.debug('[EmbeddingSync] Path update failed for non-smart-folder move (non-fatal)', {
          error: err?.message
        });
      }
    }

    // For copies to non-smart-folder locations, source stays indexed — nothing to do.
    // For moves where path update failed, the old ID is stale but we don't delete
    // the embedding to preserve searchability. It will self-heal on next analysis.
    return { action: 'skipped', reason: 'not-smart-folder' };
  }

  const analysisHistoryService = services.analysisHistoryService;
  if (!analysisHistoryService?.getAnalysisByPath) {
    return { action: 'skipped', reason: 'analysis-history-unavailable' };
  }

  let entry = await analysisHistoryService.getAnalysisByPath(destPath);
  if (!entry && sourcePath) {
    entry = await analysisHistoryService.getAnalysisByPath(sourcePath);
  }

  if (!entry?.analysis) {
    return { action: 'skipped', reason: 'no-analysis' };
  }

  // Respect global embedding timing/policy. This is the "final" stage (post-move).
  // We intentionally keep this enabled for both 'during_analysis' and 'after_organize'
  // to ensure files that only become eligible after the move still get embedded.
  const policyOverride = entry?.embedding?.policy || null;
  const gate = await shouldEmbed({ stage: 'final', policyOverride, analysis: entry.analysis });
  if (!gate.shouldEmbed) {
    // Persist skipped state for observability.
    try {
      if (analysisHistoryService?.updateEmbeddingStateByPath) {
        await analysisHistoryService.updateEmbeddingStateByPath(destPath, { status: 'skipped' });
      }
    } catch {
      // Non-fatal
    }
    return {
      action: 'skipped',
      reason: gate.reason || `disabled:${gate.timing}:${gate.policy}`
    };
  }

  const analysis = entry.analysis || {};
  const fileExtension = path.extname(destPath).toLowerCase();
  const type = isImagePath(destPath) || analysis.type === 'image' ? 'image' : 'document';
  // Same budget as the analysis route (F-191 / CP-11): a moved file must not
  // be re-embedded from a shorter text than it was first indexed with.
  const embeddingSummary = buildEmbeddingSummary(
    analysis,
    analysis.extractedText || '',
    fileExtension,
    type,
    await resolveEmbeddingModelOptions()
  );

  if (!embeddingSummary.text || !embeddingSummary.text.trim()) {
    return { action: 'skipped', reason: 'empty-summary' };
  }

  const meta = buildEmbeddingMeta({
    analysis,
    entry,
    destPath,
    fileExtension,
    type,
    summary: embeddingSummary.text,
    smartFolder
  });

  const destId = getSemanticFileId(destPath);
  const sourceId = sourcePath ? getSemanticFileId(sourcePath) : null;

  // Optimization: if an embedding already exists for this destination ID, update metadata
  // in-place via vector DB (avoids recomputing vectors during moves).
  const vectorDbService = services.vectorDbService;
  if (vectorDbService?.updateFilePaths) {
    try {
      await vectorDbService.initialize?.();
      if (vectorDbService.isOnline) {
        const oldId = operation === 'copy' || !sourceId ? destId : sourceId;
        let updated = await vectorDbService.updateFilePaths([
          { oldId, newId: destId, newMeta: meta }
        ]);
        if (updated === 0 && oldId !== destId) {
          // The coordinator already moved the row to destId; update it there
          // instead of re-embedding the whole file on every move.
          updated = await vectorDbService.updateFilePaths([
            { oldId: destId, newId: destId, newMeta: meta }
          ]);
        }
        if (updated > 0) {
          try {
            await analysisHistoryService?.updateEmbeddingStateByPath?.(destPath, {
              status: 'done'
            });
          } catch {
            // Non-fatal
          }
          // For moves/renames, ensure we don't leave behind stale embeddings for the old path.
          // For copies, the source should remain indexed.
          if (operation !== 'copy' && sourcePath && sourcePath !== destPath) {
            try {
              await removeEmbeddingsForPath(sourcePath, services, log);
            } catch {
              // Non-fatal
            }
          }
          return { action: 'updated_meta', smartFolder: smartFolder.name };
        }
      }
    } catch (metaUpdateErr) {
      log.debug('[EmbeddingSync] Metadata-only update failed (will re-embed)', {
        error: metaUpdateErr?.message
      });
    }
  }

  const embedded = await embedSummaryIntoQueue({
    filePath: destPath,
    summaryText: embeddingSummary.text,
    meta,
    services,
    log,
    // For moves/renames, remove stale embeddings for the OLD path BEFORE
    // enqueuing the new one. This prevents a race where a queue flush between
    // enqueue and removal would persist the old-path embedding to the vector DB.
    // For copies, the source should remain indexed.
    onBeforeEnqueue: async () => {
      if (operation !== 'copy' && sourcePath && sourcePath !== destPath) {
        try {
          await removeEmbeddingsForPath(sourcePath, services, log);
        } catch {
          // Non-fatal
        }
      }
    }
  });
  if (embedded.action !== 'enqueued') return embedded;
  return { action: 'enqueued', smartFolder: smartFolder.name };
}

/**
 * Embed an already-built summary and put it on the organize queue, then mark
 * the history entry pending. Shared tail of the post-move re-embed and the
 * history backfill, so both routes embed and enqueue the same way.
 *
 * @param {{ filePath: string, summaryText: string, meta: Record<string, any>,
 *   services: ResolvedServices, log?: import('../ipcWrappers').LoggerLike,
 *   onBeforeEnqueue?: () => Promise<void> }} params
 * @returns {Promise<{ action: 'enqueued'|'skipped', reason?: string }>}
 */
async function embedSummaryIntoQueue({
  filePath,
  summaryText,
  meta,
  services,
  log = logger,
  onBeforeEnqueue
}) {
  const folderMatchingService = services.folderMatchingService;
  if (!folderMatchingService?.embedText) {
    return { action: 'skipped', reason: 'matcher-unavailable' };
  }

  const embedding = await folderMatchingService.embedText(summaryText);
  if (!embedding?.vector || !Array.isArray(embedding.vector) || embedding.vector.length === 0) {
    return { action: 'skipped', reason: 'no-vector' };
  }

  if (ENABLE_ORGANIZE_EMBEDDING_QUEUE_WAIT) {
    /** @type {{ timedOut: boolean, capacityPercent: number|null }} */
    const queueCapacity =
      typeof embeddingQueueManager.waitForOrganizeQueueCapacity === 'function'
        ? await embeddingQueueManager.waitForOrganizeQueueCapacity({
            highWatermarkPercent: 75,
            releasePercent: 50,
            maxWaitMs: 60000
          })
        : { timedOut: false, capacityPercent: null };
    if (queueCapacity.timedOut) {
      log.warn('[EmbeddingSync] Organize embedding queue remained saturated before enqueue', {
        filePath,
        capacityPercent: queueCapacity.capacityPercent
      });
    }
  }

  if (typeof onBeforeEnqueue === 'function') {
    await onBeforeEnqueue();
  }

  await organizeQueue.enqueue({
    id: getSemanticFileId(filePath),
    vector: embedding.vector,
    model: embedding.model,
    meta,
    updatedAt: new Date().toISOString()
  });

  // Persist pending state (queue-backed embedding).
  try {
    if (services.analysisHistoryService?.updateEmbeddingStateByPath) {
      await services.analysisHistoryService.updateEmbeddingStateByPath(filePath, {
        status: 'pending',
        model: embedding.model || null
      });
    }
  } catch {
    // Non-fatal
  }

  return { action: 'enqueued' };
}

/**
 * Re-embed a file from its STORED analysis — no LLM run. Used by the startup
 * knowledge repair (F-198) for history entries that never got a vector, or
 * whose row is a zero-vector placeholder. Same gate, budget and meta shape as
 * the post-move path so the resulting vector is comparable to every other.
 *
 * @param {{ entry: Record<string, any>, filePath: string,
 *   smartFolder?: { name?: string, path?: string }|null,
 *   services: ResolvedServices, log?: import('../ipcWrappers').LoggerLike }} params
 * @returns {Promise<{ action: 'enqueued'|'skipped', reason?: string }>}
 */
async function embedHistoryEntry({ entry, filePath, smartFolder = null, services, log = logger }) {
  if (!filePath || !entry?.analysis) {
    return { action: 'skipped', reason: 'no-analysis' };
  }

  const gate = await shouldEmbed({
    stage: 'final',
    policyOverride: entry?.embedding?.policy || null,
    analysis: entry.analysis
  });
  if (!gate.shouldEmbed) {
    try {
      await services.analysisHistoryService?.updateEmbeddingStateByPath?.(filePath, {
        status: 'skipped'
      });
    } catch {
      // Non-fatal
    }
    return {
      action: 'skipped',
      reason: gate.reason || `disabled:${gate.timing}:${gate.policy}`
    };
  }

  const analysis = entry.analysis || {};
  const fileExtension = path.extname(filePath).toLowerCase();
  const type = isImagePath(filePath) || analysis.type === 'image' ? 'image' : 'document';
  const embeddingSummary = buildEmbeddingSummary(
    analysis,
    analysis.extractedText || '',
    fileExtension,
    type,
    await resolveEmbeddingModelOptions()
  );
  if (!embeddingSummary.text || !embeddingSummary.text.trim()) {
    return { action: 'skipped', reason: 'empty-summary' };
  }

  const meta = buildEmbeddingMeta({
    analysis,
    entry,
    destPath: filePath,
    fileExtension,
    type,
    summary: embeddingSummary.text,
    smartFolder
  });

  return embedSummaryIntoQueue({
    filePath,
    summaryText: embeddingSummary.text,
    meta,
    services,
    log
  });
}

/**
 * Verify that embeddings are correctly stored after a file move.
 * Checks that the destination file ID has a valid embedding and that
 * no stale embedding remains at the source path.
 *
 * @param {Object} params
 * @param {string} params.sourcePath - Original file path (before move)
 * @param {string} params.destPath - Destination file path (after move)
 * @param {string} [params.operation='move'] - Operation type ('move' or 'copy')
 * @param {import('../ipcWrappers').LoggerLike} [params.log] - Logger instance
 * @returns {Promise<{valid: boolean, destHasEmbedding: boolean, sourceCleared: boolean, issues: string[]}>}
 */
async function verifyEmbeddingAfterMove({
  sourcePath,
  destPath,
  operation = 'move',
  log = logger
}) {
  const issues = [];
  let destHasEmbedding = false;
  let sourceCleared = true;

  if (!destPath) {
    return { valid: false, destHasEmbedding, sourceCleared, issues: ['missing-dest-path'] };
  }

  const services = resolveServices();
  const vectorDbService = services.vectorDbService;

  if (!vectorDbService) {
    return {
      valid: false,
      destHasEmbedding: false,
      sourceCleared: true,
      issues: ['vector-db-unavailable']
    };
  }

  try {
    const destId = getSemanticFileId(destPath);

    // Check destination has an embedding
    if (typeof vectorDbService.getFile === 'function') {
      const destDoc = await vectorDbService.getFile(destId);
      if (destDoc) {
        destHasEmbedding = true;
        // Verify the path metadata matches the actual destination
        const storedPath = destDoc.filePath || '';
        const normalizedStoredPath = storedPath.replace(/\\/g, '/');
        const normalizedDestPath = destPath.replace(/\\/g, '/');
        if (normalizedStoredPath !== normalizedDestPath) {
          issues.push(`path-mismatch: stored="${storedPath}" expected="${destPath}"`);
        }
      } else {
        issues.push('dest-embedding-missing');
      }
    }

    // For moves (not copies), verify source embedding was removed
    if (operation !== 'copy' && sourcePath && sourcePath !== destPath) {
      const sourceId = getSemanticFileId(sourcePath);
      if (typeof vectorDbService.getFile === 'function') {
        const sourceDoc = await vectorDbService.getFile(sourceId);
        if (sourceDoc && !sourceDoc.isOrphaned) {
          sourceCleared = false;
          issues.push(`stale-source-embedding: ${sourceId}`);
        }
      }
    }
  } catch (error) {
    issues.push(`verification-error: ${error.message}`);
    log.debug('[EmbeddingSync] Post-move embedding verification error (non-fatal)', {
      error: error.message,
      destPath
    });
  }

  const valid = destHasEmbedding && sourceCleared && issues.length === 0;
  if (!valid && issues.length > 0) {
    log.warn('[EmbeddingSync] Post-move embedding verification found issues', {
      sourcePath: sourcePath ? path.basename(sourcePath) : null,
      destPath: path.basename(destPath),
      operation,
      issues
    });
  }

  return { valid, destHasEmbedding, sourceCleared, issues };
}

module.exports = {
  syncEmbeddingForMove,
  embedHistoryEntry,
  resolveServices,
  getSmartFolderForPath,
  removeEmbeddingsForPath,
  removeEmbeddingsForPathBestEffort,
  verifyEmbeddingAfterMove
};
