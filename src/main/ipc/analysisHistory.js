// @ts-check
/**
 * Analysis History IPC Handlers
 *
 * Handles retrieval and management of file analysis history.
 * Demonstrates the service check pattern with various fallback responses.
 */
const { IpcServiceContext, createFromLegacyParams } = require('./IpcServiceContext');
const { createHandler, createErrorResponse, safeHandle } = require('./ipcWrappers');
const { schemas } = require('./validationSchemas');
const { normalizeText } = require('../../shared/normalization');
const { getSemanticFileId } = require('../../shared/fileIdUtils');
const { deepSanitizeForExport } = require('../../shared/exportRedaction');
const { csvCell } = require('../../shared/csvUtils');
const { container: diContainer, ServiceIds } = require('../services/ServiceContainer');
const { getInstance: getDegradedStateTracker } = require('../services/DegradedStateTracker');

// Stable code so the renderer's polling banner sees a single flag rather than
// flicker between read/search/get-file/clear codes when several handlers fail
// in quick succession (e.g. service init race during boot).
const ANALYSIS_HISTORY_DEGRADED_CODE = 'analysis-history.unavailable';

/**
 * @param {Record<string, any>} detailContext
 */
function _raiseAnalysisHistoryDegraded(detailContext) {
  // Without this flag, the renderer's history panel renders an empty list and
  // users (correctly) conclude there's no analyzed data — when the real
  // problem is a service-init race or DI resolution failure. Surfacing via
  // DegradedStateBanner gives them an actionable signal instead of a
  // misleading empty UI. Severity is `error` because the panel is the user's
  // primary diagnostic surface; mis-reporting it as "no data" can drive
  // hours of wasted re-analysis.
  try {
    getDegradedStateTracker().raise({
      code: ANALYSIS_HISTORY_DEGRADED_CODE,
      subsystem: 'analysis-history',
      severity: 'error',
      message:
        'Analysis history is temporarily unavailable. Past results may not appear; ' +
        're-analyzing files will not help. Try restarting the app — if this persists, ' +
        'check the app log.',
      detail: detailContext
    });
  } catch {
    /* tracker is best-effort and must not impact the IPC reply path */
  }
}

function _clearAnalysisHistoryDegraded() {
  try {
    getDegradedStateTracker().clear(ANALYSIS_HISTORY_DEGRADED_CODE);
  } catch {
    /* never throw from a successful response path */
  }
}

// This limits the maximum number of history entries that can be retrieved at once
const MAX_HISTORY_EXPORT_LIMIT = 50000;

/**
 * @param {IpcServiceContext|Record<string, any>} servicesOrParams - Service context or legacy parameters
 */
function registerAnalysisHistoryIpc(servicesOrParams) {
  let container;
  if (servicesOrParams instanceof IpcServiceContext) {
    container = servicesOrParams;
  } else {
    container = createFromLegacyParams(servicesOrParams);
  }

  const { ipcMain, IPC_CHANNELS, logger } = container.core;
  const { getServiceIntegration } = container;

  const context = 'AnalysisHistory';

  // Helper to get analysis history service
  const getHistoryService = () => getServiceIntegration()?.analysisHistory;
  const getOramaService = () => {
    const integration =
      typeof getServiceIntegration === 'function' ? getServiceIntegration() : null;
    const activeContainer = integration?.container || diContainer;
    if (!activeContainer || typeof activeContainer.resolve !== 'function') return null;
    try {
      return activeContainer.resolve(ServiceIds.ORAMA_VECTOR);
    } catch {
      return null;
    }
  };

  // Get analysis statistics
  safeHandle(
    ipcMain,
    IPC_CHANNELS.ANALYSIS_HISTORY.GET_STATISTICS,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      serviceName: 'analysisHistory',
      getService: getHistoryService,
      wrapResponse: true,
      fallbackResponse: { success: true },
      handler: async (event, service) => {
        try {
          const value = (await service.getStatistics()) || {};
          _clearAnalysisHistoryDegraded();
          return value;
        } catch (error) {
          logger.error('Failed to get analysis statistics:', error);
          _raiseAnalysisHistoryDegraded({ handler: 'GET_STATISTICS', error: error?.message });
          return {};
        }
      }
    })
  );

  // Get analysis history with pagination
  safeHandle(
    ipcMain,
    IPC_CHANNELS.ANALYSIS_HISTORY.GET,
    createHandler({
      logger,
      context,
      schema: schemas?.historyOptions,
      serviceName: 'analysisHistory',
      getService: getHistoryService,
      fallbackResponse: [],
      handler: async (event, options = {}, service) => {
        try {
          const { all = false, limit, offset = 0 } = options || {};

          // Handle "get all" request with safety cap to prevent memory exhaustion
          if (all || limit === 'all') {
            const full = (await service.getRecentAnalysis(MAX_HISTORY_EXPORT_LIMIT)) || [];
            const result = Array.isArray(full) ? full : [];

            // Log warning if we hit the safety cap
            if (result.length >= MAX_HISTORY_EXPORT_LIMIT) {
              logger.warn('[ANALYSIS-HISTORY] History retrieval hit safety cap', {
                cap: MAX_HISTORY_EXPORT_LIMIT,
                returned: result.length
              });
            }

            return offset > 0 ? result.slice(offset) : result;
          }

          // Handle paginated request
          const effLimit = typeof limit === 'number' && limit > 0 ? limit : 50;

          if (offset > 0) {
            const interim = (await service.getRecentAnalysis(effLimit + offset)) || [];
            const result = Array.isArray(interim) ? interim : [];
            return result.slice(offset, offset + effLimit);
          }

          const result = (await service.getRecentAnalysis(effLimit)) || [];
          _clearAnalysisHistoryDegraded();
          return Array.isArray(result) ? result : [];
        } catch (error) {
          logger.error('Failed to get analysis history:', error);
          _raiseAnalysisHistoryDegraded({ handler: 'GET', error: error?.message });
          return [];
        }
      }
    })
  );

  // Search analysis history
  safeHandle(
    ipcMain,
    IPC_CHANNELS.ANALYSIS_HISTORY.SEARCH,
    createHandler({
      logger,
      context,
      schema: schemas?.analysisHistorySearch,
      serviceName: 'analysisHistory',
      getService: getHistoryService,
      fallbackResponse: [],
      normalize: (payload) => {
        if (Array.isArray(payload)) {
          const [query, options] = payload;
          return [normalizeText(query, { maxLength: 2000 }), options];
        }
        return normalizeText(payload, { maxLength: 2000 });
      },
      handler: async (event, query = '', options = {}, service) => {
        try {
          const value = (await service.searchAnalysis(query, options)) || [];
          _clearAnalysisHistoryDegraded();
          return value;
        } catch (error) {
          logger.error('Failed to search analysis history:', error);
          _raiseAnalysisHistoryDegraded({ handler: 'SEARCH', error: error?.message });
          return [];
        }
      }
    })
  );

  // Get analysis history for specific file
  safeHandle(
    ipcMain,
    IPC_CHANNELS.ANALYSIS_HISTORY.GET_FILE_HISTORY,
    createHandler({
      logger,
      context,
      schema: schemas?.filePath,
      serviceName: 'analysisHistory',
      getService: getHistoryService,
      fallbackResponse: null,
      handler: async (event, filePath, service) => {
        try {
          const value = (await service.getAnalysisByPath(filePath)) || null;
          _clearAnalysisHistoryDegraded();
          return value;
        } catch (error) {
          logger.error('Failed to get file analysis history:', error);
          _raiseAnalysisHistoryDegraded({ handler: 'GET_FILE_HISTORY', error: error?.message });
          return null;
        }
      }
    })
  );

  // Set per-file embedding policy (embed / skip / web_only)
  safeHandle(
    ipcMain,
    IPC_CHANNELS.ANALYSIS_HISTORY.SET_EMBEDDING_POLICY,
    createHandler({
      logger,
      context,
      schema: schemas?.embeddingPolicy,
      serviceName: 'analysisHistory',
      getService: getHistoryService,
      fallbackResponse: { success: false, error: 'Service unavailable' },
      normalize: (payload) => {
        if (!payload || typeof payload !== 'object') return payload;
        return {
          filePath: normalizeText(payload.filePath || '', { maxLength: 2000 }),
          policy: normalizeText(payload.policy || '', { maxLength: 20 })
        };
      },
      handler: async (event, payload, service) => {
        try {
          const filePath = payload?.filePath;
          const policy = payload?.policy;
          if (!filePath) {
            return { success: false, error: 'filePath is required' };
          }
          const allowed = new Set(['embed', 'skip', 'web_only']);
          if (!allowed.has(policy)) {
            return { success: false, error: 'policy must be one of embed|skip|web_only' };
          }

          const result = await service.setEmbeddingPolicyByPath(filePath, policy);
          return { success: true, ...result };
        } catch (error) {
          logger.error('Failed to set embedding policy:', error);
          return createErrorResponse(error);
        }
      }
    })
  );

  // Clear analysis history
  safeHandle(
    ipcMain,
    IPC_CHANNELS.ANALYSIS_HISTORY.CLEAR,
    createHandler({
      logger,
      context,
      schema: schemas?.ipcVoidPayload,
      serviceName: 'analysisHistory',
      getService: getHistoryService,
      fallbackResponse: { success: false, error: 'Service unavailable' },
      handler: async (event, service) => {
        try {
          // Mark embeddings as orphaned before clearing history to keep search/embeddings in sync.
          const oramaService = getOramaService();
          if (oramaService && typeof oramaService.markEmbeddingsOrphaned === 'function') {
            await service.initialize();
            const entries = Object.values(service.analysisHistory?.entries || {});
            const fileIds = Array.from(
              new Set(
                entries
                  .map((entry) => entry?.organization?.actual || entry?.originalPath)
                  .filter((p) => typeof p === 'string' && p.length > 0)
                  .map((p) => getSemanticFileId(p))
              )
            );
            if (fileIds.length > 0) {
              await oramaService.markEmbeddingsOrphaned(fileIds);
            }
          }
          await service.createDefaultStructures();
          return { success: true };
        } catch (error) {
          logger.error('Failed to clear analysis history:', error);
          return createErrorResponse(error);
        }
      }
    })
  );

  // Export analysis history
  safeHandle(
    ipcMain,
    IPC_CHANNELS.ANALYSIS_HISTORY.EXPORT,
    createHandler({
      logger,
      context,
      schema: schemas?.analysisExportFormat,
      serviceName: 'analysisHistory',
      getService: getHistoryService,
      fallbackResponse: { success: false, error: 'Service unavailable' },
      handler: async (event, format = 'json', service) => {
        try {
          const { dialog } = require('electron');
          const fs = require('fs');
          const { getMainWindow } = container.electron;
          const win = typeof getMainWindow === 'function' ? getMainWindow() : null;

          const defaultPath = format === 'csv' ? 'analysis-history.csv' : 'analysis-history.json';
          const filters =
            format === 'csv'
              ? [{ name: 'CSV Files', extensions: ['csv'] }]
              : [{ name: 'JSON Files', extensions: ['json'] }];

          const { filePath, canceled } = await dialog.showSaveDialog(win, {
            title: 'Export Analysis History',
            defaultPath,
            filters
          });

          if (canceled || !filePath) {
            return { success: false, canceled: true };
          }

          const rawHistory = (await service.getRecentAnalysis(MAX_HISTORY_EXPORT_LIMIT)) || [];
          const history = /** @type {any[]} */ (deepSanitizeForExport(rawHistory));

          if (format === 'json') {
            await fs.promises.writeFile(filePath, JSON.stringify(history, null, 2));
            return { success: true, filePath };
          }

          if (format === 'csv') {
            const headers = [
              'fileName',
              'originalPath',
              'category',
              'confidence',
              'keywords',
              'subject',
              'timestamp'
            ];

            const writeStream = fs.createWriteStream(filePath);
            // Capture any async write error (ENOSPC / EPIPE / permission etc.)
            // in a single place so we can reject the promise below rather than
            // silently losing writes. Without this listener Node emits an
            // unhandled 'error' event that crashes the main process.
            /** @type {Error|null} */
            let writeError = null;
            writeStream.on('error', (err) => {
              writeError = writeError || err;
              logger.error('Analysis history CSV write stream error', {
                error: err?.message
              });
            });

            // Respect backpressure. Node's `write()` returns false when the
            // internal buffer is over the highWaterMark; continuing to push
            // data at that point keeps the buffer growing without bound and
            // can exhaust memory on very large histories (millions of rows).
            // awaitDrain() lets the OS flush to disk before we queue more.
            const awaitDrain = () =>
              new Promise((resolve, reject) => {
                const onDrain = () => {
                  writeStream.off('error', onError);
                  resolve();
                };
                /** @param {Error} err */
                const onError = (err) => {
                  writeStream.off('drain', onDrain);
                  reject(err);
                };
                writeStream.once('drain', onDrain);
                writeStream.once('error', onError);
              });
            /** @param {string} chunk */
            const safeWrite = async (chunk) => {
              if (writeError) throw writeError;
              const ok = writeStream.write(chunk);
              if (!ok) await awaitDrain();
            };

            await safeWrite(headers.join(',') + '\n');

            for (const entry of history) {
              const keywords = entry.analysis?.keywords || entry.analysis?.tags || [];
              const keywordStr = Array.isArray(keywords)
                ? keywords.join('; ')
                : String(keywords || '');

              const row = [
                csvCell(entry.fileName || ''),
                csvCell(entry.originalPath || ''),
                csvCell(entry.analysis?.category || entry.category || ''),
                csvCell(String(entry.analysis?.confidence ?? entry.confidence ?? '')),
                csvCell(keywordStr),
                csvCell(entry.analysis?.subject || ''),
                csvCell(entry.timestamp ? new Date(entry.timestamp).toISOString() : '')
              ];
              await safeWrite(row.join(',') + '\n');
            }

            await new Promise((resolve, reject) => {
              writeStream.end((/** @type {Error|null|undefined} */ err) => {
                const fatal = err || writeError;
                if (fatal) reject(fatal);
                else resolve();
              });
            });

            return { success: true, filePath };
          }

          return { success: false, error: 'Unsupported format' };
        } catch (error) {
          logger.error('Failed to export analysis history:', error);
          return createErrorResponse(error);
        }
      }
    })
  );

  // Export a single file's cached transcript as VTT/SRT/JSON
  safeHandle(
    ipcMain,
    IPC_CHANNELS.ANALYSIS_HISTORY.EXPORT_TRANSCRIPT,
    createHandler({
      logger,
      context,
      schema: schemas?.transcriptExport,
      serviceName: 'analysisHistory',
      getService: getHistoryService,
      fallbackResponse: { success: false, error: 'Service unavailable' },
      handler: async (event, payload, service) => {
        try {
          /** @type {{filePath: string, format: 'vtt'|'srt'|'json'}} */
          const { filePath, format } = payload || {};
          const entry = await service.getAnalysisByPath(filePath);
          const analysis = (entry && (entry.analysis || entry)) || {};
          const segments = Array.isArray(analysis.transcriptSegments)
            ? analysis.transcriptSegments
            : [];
          const text = typeof analysis.transcript === 'string' ? analysis.transcript : '';

          if (format !== 'json' && segments.length === 0) {
            return {
              success: false,
              error: 'No timestamped transcript segments available for this file'
            };
          }
          if (format === 'json' && segments.length === 0 && !text) {
            return { success: false, error: 'No transcript available for this file' };
          }

          const { toVtt, toSrt, toTranscriptJson } = require('../services/transcriptFormats');
          const pathForBase = require('path');
          const content =
            format === 'vtt'
              ? toVtt(segments)
              : format === 'srt'
                ? toSrt(segments)
                : toTranscriptJson({
                    // Basename only: the export is a shareable artifact and a
                    // privacy-first product should not embed the machine's
                    // directory layout in it.
                    sourceFile:
                      typeof filePath === 'string' ? pathForBase.basename(filePath) : null,
                    language: analysis.detectedLanguage ?? null,
                    durationSeconds: analysis.durationSeconds ?? null,
                    text,
                    segments
                  });

          // History caps persisted segments at 1000; surface the truncation
          // instead of letting a VTT/SRT silently end mid-media. The >=1000
          // fallback covers entries persisted before the flag existed.
          const truncated =
            analysis.transcriptSegmentsTruncated === true || segments.length >= 1000;

          const { dialog } = require('electron');
          const fs = require('fs');
          const path = require('path');
          const { getMainWindow } = container.electron;
          const win = typeof getMainWindow === 'function' ? getMainWindow() : null;

          const base =
            path.basename(String(filePath), path.extname(String(filePath))) || 'transcript';
          /** @type {Record<string, string>} */
          const filterNames = {
            vtt: 'WebVTT Subtitles',
            srt: 'SubRip Subtitles',
            json: 'JSON Transcript'
          };
          const { filePath: savePath, canceled } = await dialog.showSaveDialog(win, {
            title: 'Export Transcript',
            defaultPath: `${base}.${format}`,
            filters: [{ name: filterNames[format] || format, extensions: [format] }]
          });

          if (canceled || !savePath) {
            return { success: false, canceled: true };
          }

          await fs.promises.writeFile(savePath, content, 'utf8');
          return {
            success: true,
            filePath: savePath,
            segmentCount: segments.length,
            ...(truncated ? { truncated: true } : {})
          };
        } catch (error) {
          logger.error('Failed to export transcript:', error);
          return createErrorResponse(error);
        }
      }
    })
  );

  // Lean paginated timeline page (content-date sorted)
  safeHandle(
    ipcMain,
    IPC_CHANNELS.ANALYSIS_HISTORY.GET_TIMELINE,
    createHandler({
      logger,
      context,
      schema: schemas?.timelineOptions,
      serviceName: 'analysisHistory',
      getService: getHistoryService,
      fallbackResponse: { items: [], total: 0, hasMore: false },
      handler: async (event, options = {}, service) => {
        try {
          const page = await service.getTimelineItems(options || {});
          _clearAnalysisHistoryDegraded();
          return page || { items: [], total: 0, hasMore: false };
        } catch (error) {
          logger.error('Failed to get analysis timeline:', error);
          _raiseAnalysisHistoryDegraded({ handler: 'GET_TIMELINE', error: error?.message });
          return { items: [], total: 0, hasMore: false };
        }
      }
    })
  );
}

module.exports = registerAnalysisHistoryIpc;
