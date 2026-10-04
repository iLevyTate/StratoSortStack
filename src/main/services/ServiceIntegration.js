// @ts-check
const AnalysisHistoryService = require('./analysisHistory');
const UndoRedoService = require('./UndoRedoService');
const ProcessingStateService = require('./ProcessingStateService');
const FolderMatchingService = require('./FolderMatchingService');
const OrganizationSuggestionService = require('./organization');
const AutoOrganizeService = require('./autoOrganize');
const EmbeddingCache = require('./EmbeddingCache');
const SmartFolderWatcher = require('./SmartFolderWatcher');
const NotificationService = require('./NotificationService');
const { container, ServiceIds, SHUTDOWN_ORDER } = require('./ServiceContainer');
const { getCanonicalFileId } = require('../../shared/pathSanitization');
const { createLogger } = require('../../shared/logger');
const { scheduleStartupKnowledgeRepair } = require('./embedding/knowledgeRepair');

const logger = createLogger('ServiceIntegration');

/**
 * Build the file-backed watcher queue store under userData (K-07). Returns
 * null when Electron's `app` is unavailable (tests, CLI tools) so the watcher
 * falls back to its in-memory-only queue.
 * @returns {{ load: () => Promise<any[]>, save: (items: any[]) => Promise<void> } | null}
 */
function createWatcherQueueStoreSafely() {
  try {
    const path = require('path');
    const { app } = require('electron');
    if (!app || typeof app.getPath !== 'function') return null;
    const { createWatcherQueueStore } = require('./watcher/WatcherQueueStore');
    const userData = app.getPath('userData');
    return createWatcherQueueStore(path.join(userData, 'watcher-analysis-queue.json'), {
      legacyFilePath: path.join(userData, 'smart-folder-watcher-queue.json')
    });
  } catch (error) {
    // The not-Electron case returns above without logging; reaching here means
    // something genuinely broke (no userData path, module load failure) and the
    // watcher silently loses its crash resilience — say so.
    logger.warn('[ServiceIntegration] Watcher queue persistence disabled', { error });
    return null;
  }
}

function throwIfAborted(/** @type {any} */ signal, /** @type {any} */ phase) {
  if (signal?.aborted) {
    const reason =
      signal.reason instanceof Error
        ? signal.reason.message
        : typeof signal.reason === 'string'
          ? signal.reason
          : 'Aborted';
    throw new Error(`[ServiceIntegration] Aborted during ${phase}: ${reason}`);
  }
}
/**
 * FIX: Explicit service initialization order with dependencies
 * This makes the initialization sequence clear and documentable.
 * Services are grouped by dependency tier:
 * - Tier 0: No dependencies (can init in parallel)
 * - Tier 1: Depends on vector DB services
 * - Tier 2: Depends on Tier 0/1 services
 */
const SERVICE_INITIALIZATION_ORDER = {
  // Tier 0: Independent services (can init in parallel)
  tier0: ['analysisHistory', 'undoRedo', 'processingState', 'chatHistoryStore'],
  // Tier 1: Vector DB (in-process Orama - no external server needed)
  tier1: ['vectorDb'],
  // Tier 2: Services that depend on Vector DB
  tier2: ['folderMatching']
};

// The tier-0 services whose failure makes the integration unusable. The
// chat history store is tier 0 for ordering only: when its SQLite file
// fails to open, chat loses its history, nothing else does. Counting it as
// critical turned one unreadable chat database into no smart folder
// watching, no Downloads auto-organize and no organize resume, all without
// a word to the user (audit row LC-01).
const CRITICAL_TIER0_SERVICES = ['analysisHistory', 'undoRedo', 'processingState'];

const STARTUP_DEGRADED_CODE = 'startup.core-services-failed';
const CHAT_HISTORY_DEGRADED_CODE = 'chat-history.unavailable';

/**
 * Raise a DegradedStateTracker flag; never throws (the tracker is a
 * best-effort surface, and this runs on the startup path).
 * @param {{ code: string, subsystem: string, severity: 'warning' | 'error', message: string, detail?: Record<string, any> }} flag
 */
function raiseDegradedFlag(flag) {
  try {
    require('./DegradedStateTracker').getInstance().raise(flag);
  } catch (err) {
    logger.debug('[ServiceIntegration] Could not raise degraded flag', {
      code: flag.code,
      error: err?.message
    });
  }
}

/**
 * ServiceIntegration - Central service orchestration and lifecycle management
 *
 * This class manages the initialization, lifecycle, and coordination of all
 * application services. It uses the ServiceContainer for dependency injection
 * and provides a centralized point for service access.
 *
 * The class supports two modes of operation:
 * 1. Instance-based: Traditional approach where services are stored as instance properties
 * 2. Container-based: Modern DI approach using the ServiceContainer
 *
 * @example
 * // Using ServiceIntegration
 * const integration = new ServiceIntegration();
 * await integration.initialize();
 *
 * // Access services via instance properties (backward compatible)
 * const vectorDb = integration.vectorService;
 *
 * // Or via the container (recommended for new code)
 * const vectorDb = container.resolve(ServiceIds.ORAMA_VECTOR);
 */
class ServiceIntegration {
  constructor() {
    this.analysisHistory = null;
    this.undoRedo = null;
    this.processingState = null;
    this.vectorService = null; // OramaVectorService (in-process)
    this.folderMatchingService = null;
    this.suggestionService = null;
    this.autoOrganizeService = null;
    this.smartFolderWatcher = null;
    this.relationshipIndex = null;
    this.initialized = false;
    /** @type {Promise<any>|null} */
    this._knowledgeRepair = null;
    this._isShuttingDown = false;

    // (e.g. degraded mode after startup timeout). Handlers like GET_CLUSTERS will then resolve
    // 'clustering' successfully; individual services may remain uninitialized until first use.
    this._registerCoreServices();

    // Multiple concurrent initialize() calls would previously both pass the
    // if (this.initialized) check and run in parallel, causing undefined behavior
    this._initPromise = null;

    // Track last initialization outcome for debugging/telemetry
    this._lastInitStatus = null;
    this._lastInitError = null;

    // Reference to the container for external access
    this.container = container;
  }

  /**
   * Backward-compatible alias.
   * Many legacy call sites (including some IPC registrars) still look for `vectorDbService`.
   * In the Orama migration the instance is stored on `vectorService`.
   */
  get vectorDbService() {
    return this.vectorService;
  }

  /**
   * Additional alias for older code that expects `vectorDb`.
   */
  get vectorDb() {
    return this.vectorService;
  }

  /**
   * Initialize all services
   *
   * This method initializes all services in the correct order, respecting
   * their dependencies. It registers services with the container and
   * stores references for backward compatibility.
   *
   * @param {Record<string, any>} [options] - { startupResult }
   * @returns {Promise<Record<string, any>>}
   */
  async initialize(options = {}) {
    if (this._initPromise) {
      return this._initPromise;
    }

    if (this.initialized) {
      return /** @type {any} */ ({
        initialized: [],
        errors: [],
        skipped: [],
        alreadyInitialized: true
      });
    }

    this._initPromise = this._doInitialize(options);
    try {
      return await this._initPromise;
    } finally {
      // Clear the promise after initialization completes (success or failure)
      this._initPromise = null;
    }
  }

  /**
   * Restore the staged embedding queues persisted by a previous process and
   * let them schedule their flush. Errors are logged; the on-disk state is
   * left intact for the next attempt.
   * @private
   */
  async _restorePersistedEmbeddingQueues() {
    try {
      const embeddingQueueManager = require('../analysis/embeddingQueue/queueManager');
      const results = await embeddingQueueManager.initialize();
      const failures = (results || []).filter(
        (/** @type {any} */ r) => r && r.status === 'rejected'
      );
      if (failures.length > 0) {
        logger.warn('[ServiceIntegration] Some persisted embedding queues failed to restore', {
          failed: failures.length,
          errors: failures.map((/** @type {any} */ r) => r.reason?.message || String(r.reason))
        });
      }
    } catch (error) {
      logger.warn('[ServiceIntegration] Persisted embedding queue restore failed:', {
        error: /** @type {any} */ (error)?.message
      });
    }
  }

  /**
   * Internal initialization implementation
   * @param {Record<string, any>} [options] - { startupResult, signal }
   * @private
   */
  async _doInitialize(options = {}) {
    const { signal } = options;
    throwIfAborted(signal, 'initialization setup');
    logger.info('[ServiceIntegration] Starting initialization...');

    this._lastInitStatus = null;
    this._lastInitError = null;

    // Track initialization status for each service (returned to callers)
    /** @type {{ initialized: any[], errors: any[], skipped: any[] }} */
    const initStatus = {
      initialized: [],
      errors: [],
      skipped: []
    };

    try {
      // Register core services with the container
      this._registerCoreServices();
      throwIfAborted(signal, 'service registration');

      // Initialize core services
      this.analysisHistory = container.resolve(ServiceIds.ANALYSIS_HISTORY);
      this.undoRedo = container.resolve(ServiceIds.UNDO_REDO);
      this.processingState = container.resolve(ServiceIds.PROCESSING_STATE);
      this.relationshipIndex = container.resolve(ServiceIds.RELATIONSHIP_INDEX);
      this.chatHistoryStore = container.tryResolve(ServiceIds.CHAT_HISTORY_STORE);

      // Initialize vector service and folder matching
      this.vectorService = container.resolve(ServiceIds.ORAMA_VECTOR);
      if (!this.vectorService) {
        logger.warn(
          '[ServiceIntegration] Vector service is null, some features will be unavailable'
        );
      }

      this.folderMatchingService = container.resolve(ServiceIds.FOLDER_MATCHING);

      // Initialize suggestion service
      const settingsService = container.resolve(ServiceIds.SETTINGS);
      if (!settingsService) {
        logger.warn('[ServiceIntegration] Settings service is null, using defaults');
      }

      this.suggestionService = container.resolve(ServiceIds.ORGANIZATION_SUGGESTION);

      // Initialize auto-organize service
      this.autoOrganizeService = container.resolve(ServiceIds.AUTO_ORGANIZE);
      throwIfAborted(signal, 'service resolution');

      // Vector DB availability check
      // OramaVectorService is in-process, so it's always available (no external server)
      // Only need to check if the service exists
      const { startupResult } = options;
      let isVectorDbReady = !!this.vectorService;
      let skipVectorInit = false;

      if (startupResult?.services?.vectorDb) {
        const vectorStatus = startupResult.services.vectorDb;
        const wasRunning =
          vectorStatus.status === 'running' ||
          vectorStatus.status === 'online' ||
          vectorStatus.success;
        const failed =
          vectorStatus.status === 'failed' ||
          vectorStatus.status === 'error' ||
          vectorStatus.success === false;

        if (wasRunning) {
          isVectorDbReady = true;
          skipVectorInit = true;
          logger.debug('[ServiceIntegration] Using startupResult - vector DB already initialized');
        } else if (failed) {
          isVectorDbReady = false;
          logger.warn(
            '[ServiceIntegration] startupResult indicates vector DB failed to initialize'
          );
        }
      }

      if (!isVectorDbReady) {
        logger.warn(
          '[ServiceIntegration] Vector service is not available. Running in degraded mode.'
        );
      }

      // Tier 0: Initialize independent services in parallel
      throwIfAborted(signal, 'tier0 initialization');
      const tier0Results = await Promise.allSettled([
        this.analysisHistory.initialize(),
        this.undoRedo.initialize(),
        this.processingState.initialize(),
        this.chatHistoryStore ? this.chatHistoryStore.initialize() : Promise.resolve()
      ]);
      throwIfAborted(signal, 'tier0 initialization');

      // Process Tier 0 results
      SERVICE_INITIALIZATION_ORDER.tier0.forEach((name, index) => {
        const result = tier0Results[index];
        if (result.status === 'fulfilled') {
          initStatus.initialized.push(name);
        } else {
          initStatus.errors.push({
            service: name,
            error: result.reason?.message || String(result.reason)
          });
          logger.error(
            `[ServiceIntegration] ${name} initialization failed:`,
            result.reason?.message
          );
        }
      });

      // Tier 1: Initialize Vector DB (OramaVectorService is in-process, always available)
      if (isVectorDbReady && this.vectorService) {
        try {
          throwIfAborted(signal, 'vectorDb initialization');
          if (!skipVectorInit) {
            await this.vectorService.initialize();
          }
          throwIfAborted(signal, 'vectorDb initialization');
          initStatus.initialized.push('vectorDb');

          // Drain embedding items persisted before a crash/quit. The queues
          // only restored themselves from enqueue(), so a process that never
          // enqueued anything new left them idle forever (F-190 / CP-10).
          // Non-fatal: a restore failure keeps the on-disk state for next time.
          await this._restorePersistedEmbeddingQueues();

          // Wire up cascade orphan marking when analysis entries are removed
          // This ensures embeddings and chunks are marked orphaned when their analysis entry is pruned
          if (this.analysisHistory && this.vectorService) {
            this.analysisHistory.setOnEntriesRemovedCallback(
              async (/** @type {any} */ removedEntries) => {
                if (!removedEntries || removedEntries.length === 0) return;

                // Embeddings are stored under semantic IDs (file:/image: + path), not analysis-history UUIDs.
                // Use the most current known path when available (actualPath), otherwise fall back to originalPath.
                const path = require('path');
                const { SUPPORTED_IMAGE_EXTENSIONS } = require('../../shared/constants');

                const fileIds = Array.from(
                  new Set(
                    removedEntries
                      .map((/** @type {any} */ e) => e?.actualPath || e?.originalPath)
                      .filter((/** @type {any} */ p) => typeof p === 'string' && p.length > 0)
                      .map((/** @type {any} */ p) => {
                        const ext = (path.extname(p) || '').toLowerCase();
                        const isImage = SUPPORTED_IMAGE_EXTENSIONS.includes(ext);
                        return getCanonicalFileId(p, isImage);
                      })
                  )
                );
                logger.debug(
                  '[ServiceIntegration] Marking orphaned embeddings for pruned entries',
                  {
                    count: fileIds.length
                  }
                );

                try {
                  const result = await this.vectorService.markEmbeddingsOrphaned(fileIds);
                  logger.info('[ServiceIntegration] Cascade orphan marking complete', {
                    fileEmbeddings: result?.marked || 0,
                    failed: result?.failed || 0
                  });
                } catch (error) {
                  logger.warn('[ServiceIntegration] Cascade orphan marking failed:', {
                    error: error.message,
                    fileIds: fileIds.length
                  });
                }
              }
            );
          }
        } catch (error) {
          const errorMsg = error?.message || String(error);
          initStatus.errors.push({ service: 'vectorDb', error: errorMsg });
          logger.error('[ServiceIntegration] Vector DB initialization failed:', errorMsg);
          isVectorDbReady = false; // Prevent dependent services from initializing
          // Broadcast a degraded status so the renderer can surface a clear
          // "vectors offline" indicator instead of silently returning
          // BM25-only / empty search results forever. Without this the
          // user sees "no results" and can't tell whether their query
          // failed, whether nothing matches, or whether vectors are dead.
          try {
            if (typeof this.vectorDb?._broadcastStatus === 'function') {
              this.vectorDb._broadcastStatus('error', 'init-failed');
            }
          } catch (broadcastErr) {
            logger.debug(
              '[ServiceIntegration] Failed to broadcast vectorDb init-failure status:',
              broadcastErr?.message
            );
          }
        }
      } else {
        initStatus.skipped.push('vectorDb');
        logger.warn(
          '[ServiceIntegration] Vector DB initialization skipped - service not available'
        );
      }

      // Tier 2: Initialize services that depend on Vector DB
      // FolderMatchingService depends on vector DB for vector operations
      if (this.folderMatchingService && isVectorDbReady) {
        try {
          throwIfAborted(signal, 'folderMatching initialization');
          await this.folderMatchingService.initialize();
          throwIfAborted(signal, 'folderMatching initialization');
          initStatus.initialized.push('folderMatching');

          // Store + embedder are up: repair the knowledge layer in the
          // background — restore orphan-marked vectors whose file exists
          // (F-221) and backfill history entries that never got a vector
          // (F-198). Fire-and-forget; it logs its own summary.
          this._knowledgeRepair = scheduleStartupKnowledgeRepair({
            vectorDb: this.vectorService,
            analysisHistory: this.analysisHistory,
            shouldStop: () => this._isShuttingDown === true
          });
        } catch (error) {
          const errorMsg = error?.message || String(error);
          initStatus.errors.push({ service: 'folderMatching', error: errorMsg });
          logger.warn(
            '[ServiceIntegration] FolderMatchingService initialization failed:',
            errorMsg
          );
          // Non-fatal - continue with degraded functionality
        }
      } else if (this.folderMatchingService) {
        initStatus.skipped.push('folderMatching');
        logger.warn('[ServiceIntegration] FolderMatchingService skipped - Vector DB not available');
      }

      // Log initialization summary
      logger.info('[ServiceIntegration] Initialization complete', {
        initialized: initStatus.initialized.length,
        errors: initStatus.errors.length,
        skipped: initStatus.skipped.length
      });

      // Only consider the integration "initialized" if the critical Tier 0
      // services succeeded. Other services can fail and the app can run in
      // degraded mode, but a failure here is announced, never swallowed: the
      // renderer polls the DegradedStateTracker for its banner.
      const criticalTier0Failures = initStatus.errors.filter((e) =>
        CRITICAL_TIER0_SERVICES.includes(e.service)
      );
      const success = criticalTier0Failures.length === 0;
      this.initialized = success;
      this._lastInitStatus = initStatus;
      this._lastInitError = success ? null : criticalTier0Failures.map((e) => e.error).join('; ');

      if (!success) {
        logger.error('[ServiceIntegration] Initialization failed for core services', {
          failures: criticalTier0Failures
        });
        const failedNames = criticalTier0Failures.map((e) => e.service).join(', ');
        raiseDegradedFlag({
          code: STARTUP_DEGRADED_CODE,
          subsystem: 'startup',
          severity: 'error',
          message:
            'Smart folder watching, Downloads auto-organize and organize resume are off ' +
            `this session because core services failed to start (${failedNames}). ` +
            'Restart StratoSort to retry; if it keeps happening, check the log for the ' +
            'failing service.',
          detail: { failures: criticalTier0Failures }
        });
      }

      const chatHistoryFailure = initStatus.errors.find((e) => e.service === 'chatHistoryStore');
      if (chatHistoryFailure) {
        raiseDegradedFlag({
          code: CHAT_HISTORY_DEGRADED_CODE,
          subsystem: 'chat',
          severity: 'warning',
          message:
            'Chat history could not be opened, so past conversations are unavailable and ' +
            'new ones will not be saved this session. Everything else runs normally.',
          detail: { error: chatHistoryFailure.error }
        });
      }

      return { ...initStatus, success };
    } catch (error) {
      const errorMsg = error?.message || String(error);
      logger.error(
        '[ServiceIntegration] Initialization aborted due to unexpected error:',
        errorMsg
      );
      this.initialized = false;
      initStatus.errors.push({ service: 'serviceIntegration', error: errorMsg });
      this._lastInitStatus = initStatus;
      this._lastInitError = errorMsg;
      return { ...initStatus, success: false };
    }
  }

  /**
   * Register core services with the dependency injection container
   *
   * This method sets up the service registrations in the container,
   * defining how each service should be created and what dependencies
   * it requires.
   *
   * @private
   */
  _registerCoreServices() {
    const { getInstance: getSettingsService } = require('./SettingsService');

    // Register settings service (singleton from existing factory)
    if (!container.has(ServiceIds.SETTINGS)) {
      container.registerSingleton(ServiceIds.SETTINGS, () => {
        return getSettingsService();
      });
    }

    // Register OramaVectorService (in-process vector DB)
    if (!container.has(ServiceIds.ORAMA_VECTOR)) {
      const { registerWithContainer: registerOramaVector } = require('./OramaVectorService');
      registerOramaVector(container, ServiceIds.ORAMA_VECTOR);
    }

    // Register state management services
    if (!container.has(ServiceIds.ANALYSIS_HISTORY)) {
      container.registerSingleton(ServiceIds.ANALYSIS_HISTORY, () => {
        return new AnalysisHistoryService();
      });
    }

    if (!container.has(ServiceIds.UNDO_REDO)) {
      container.registerSingleton(ServiceIds.UNDO_REDO, () => {
        return new UndoRedoService();
      });
    }

    if (!container.has(ServiceIds.PROCESSING_STATE)) {
      container.registerSingleton(ServiceIds.PROCESSING_STATE, () => {
        return new ProcessingStateService();
      });
    }

    if (!container.has(ServiceIds.CHAT_HISTORY_STORE)) {
      container.registerSingleton(ServiceIds.CHAT_HISTORY_STORE, () => {
        const { ChatHistoryStore } = require('./ChatHistoryStore');
        return new ChatHistoryStore();
      });
    }

    // Register folder matching service (depends on vector DB)
    if (!container.has(ServiceIds.FOLDER_MATCHING)) {
      container.registerSingleton(ServiceIds.FOLDER_MATCHING, (/** @type {any} */ c) => {
        const vectorDb = c.resolve(ServiceIds.ORAMA_VECTOR);
        return new FolderMatchingService(vectorDb);
      });
    }

    if (!container.has(ServiceIds.RELATIONSHIP_INDEX)) {
      container.registerSingleton(ServiceIds.RELATIONSHIP_INDEX, (/** @type {any} */ c) => {
        const RelationshipIndexService = require('./RelationshipIndexService');
        return new RelationshipIndexService({
          analysisHistoryService: c.resolve(ServiceIds.ANALYSIS_HISTORY)
        });
      });
    }

    // This allows other services to depend on ClusteringService independently
    if (!container.has(ServiceIds.CLUSTERING)) {
      container.registerSingleton(ServiceIds.CLUSTERING, (/** @type {any} */ c) => {
        const { ClusteringService } = require('./ClusteringService');
        const vectorDbService = c.resolve(ServiceIds.ORAMA_VECTOR);
        const { getInstance: getLlamaInstance } = require('./LlamaService');
        const llamaService = getLlamaInstance();

        return new ClusteringService({
          vectorDbService,
          llamaService
        });
      });
    }

    // Register organization suggestion service (depends on vector DB, FolderMatching, Settings, Clustering)
    if (!container.has(ServiceIds.ORGANIZATION_SUGGESTION)) {
      container.registerSingleton(ServiceIds.ORGANIZATION_SUGGESTION, (/** @type {any} */ c) => {
        const settingsService = c.resolve(ServiceIds.SETTINGS);
        return new OrganizationSuggestionService({
          vectorDbService: c.resolve(ServiceIds.ORAMA_VECTOR),
          folderMatchingService: c.resolve(ServiceIds.FOLDER_MATCHING),
          settingsService: settingsService,
          // This allows ClusteringService to be resolved when first needed, not during registration
          getClusteringService: () => c.resolve(ServiceIds.CLUSTERING),
          config: {
            enableLearningSync: false
          }
        });
      });
    }

    // Register auto-organize service (depends on multiple services)
    if (!container.has(ServiceIds.AUTO_ORGANIZE)) {
      container.registerSingleton(ServiceIds.AUTO_ORGANIZE, (/** @type {any} */ c) => {
        return new AutoOrganizeService({
          suggestionService: c.resolve(ServiceIds.ORGANIZATION_SUGGESTION),
          settingsService: c.resolve(ServiceIds.SETTINGS),
          folderMatchingService: c.resolve(ServiceIds.FOLDER_MATCHING),
          undoRedoService: c.resolve(ServiceIds.UNDO_REDO)
        });
      });
    }

    // Register learning feedback service (records implicit organization patterns)
    // This service learns from file placements in smart folders
    if (!container.has(ServiceIds.LEARNING_FEEDBACK)) {
      container.registerSingleton(ServiceIds.LEARNING_FEEDBACK, (/** @type {any} */ c) => {
        const { LearningFeedbackService } = require('./organization/learningFeedback');
        return new LearningFeedbackService({
          suggestionService: c.resolve(ServiceIds.ORGANIZATION_SUGGESTION),
          getSmartFolders: () => [] // Will be updated during app init
        });
      });
    }

    // Register AI/Embedding services
    // New in-process LlamaService (node-llama-cpp)
    if (!container.has(ServiceIds.VISION_SERVICE)) {
      const { registerWithContainer: registerVisionService } = require('./VisionService');
      registerVisionService(container, ServiceIds.VISION_SERVICE);
    }

    if (!container.has(ServiceIds.LLAMA_SERVICE)) {
      const { registerWithContainer: registerLlamaService } = require('./LlamaService');
      registerLlamaService(container, ServiceIds.LLAMA_SERVICE);
    }

    // WhisperService — in-process speech-to-text via whisper.cpp.
    // Registered alongside LlamaService so audio/video pipelines can resolve
    // it lazily; it does not initialize the model until first transcription.
    if (!container.has(ServiceIds.WHISPER_SERVICE)) {
      const { registerWithContainer: registerWhisperService } = require('./WhisperService');
      registerWhisperService(container, ServiceIds.WHISPER_SERVICE);
    }

    if (!container.has(ServiceIds.EMBEDDING_CACHE)) {
      container.registerSingleton(ServiceIds.EMBEDDING_CACHE, () => {
        return new EmbeddingCache();
      });
    }

    if (!container.has(ServiceIds.PARALLEL_EMBEDDING)) {
      const {
        registerWithContainer: registerParallelEmbedding
      } = require('./ParallelEmbeddingService');
      registerParallelEmbedding(container, ServiceIds.PARALLEL_EMBEDDING);
    }

    // Register ModelManager
    if (!container.has(ServiceIds.MODEL_MANAGER)) {
      const { registerWithContainer: registerModelManager } = require('./ModelManager');
      registerModelManager(container, ServiceIds.MODEL_MANAGER);
    }

    // Register ModelDownloadManager (shared singleton factory — idempotent,
    // migrates any early getInstance() local instance into the container)
    if (!container.has(ServiceIds.MODEL_DOWNLOAD_MANAGER)) {
      const {
        registerWithContainer: registerModelDownloadManager
      } = require('./ModelDownloadManager');
      registerModelDownloadManager(container, ServiceIds.MODEL_DOWNLOAD_MANAGER);
    }

    // Register AnalysisCacheService
    if (!container.has(ServiceIds.ANALYSIS_CACHE)) {
      const { registerWithContainer: registerAnalysisCache } = require('./AnalysisCacheService');
      registerAnalysisCache(container, ServiceIds.ANALYSIS_CACHE);
    }

    // Register FileAccessPolicy
    if (!container.has(ServiceIds.FILE_ACCESS_POLICY)) {
      const { registerWithContainer: registerFileAccessPolicy } = require('./FileAccessPolicy');
      registerFileAccessPolicy(container, ServiceIds.FILE_ACCESS_POLICY);
    }

    // Register CacheInvalidationBus (used by all caches for coordinated invalidation)
    if (!container.has(ServiceIds.CACHE_INVALIDATION_BUS)) {
      container.registerSingleton(ServiceIds.CACHE_INVALIDATION_BUS, () => {
        const { getInstance: getCacheInvalidationBus } = require('../../shared/cacheInvalidation');
        return getCacheInvalidationBus();
      });
    }

    // Register FilePathCoordinator (coordinates all path-dependent systems)
    if (!container.has(ServiceIds.FILE_PATH_COORDINATOR)) {
      container.registerSingleton(ServiceIds.FILE_PATH_COORDINATOR, (/** @type {any} */ c) => {
        const { FilePathCoordinator } = require('./FilePathCoordinator');
        const coordinator = new FilePathCoordinator();

        // Wire up services lazily to avoid circular dependencies
        // Services are set after initial construction
        const vectorDb = c.tryResolve(ServiceIds.ORAMA_VECTOR);
        const analysisHistory = c.tryResolve(ServiceIds.ANALYSIS_HISTORY);
        const processingState = c.tryResolve(ServiceIds.PROCESSING_STATE);
        const cacheInvalidationBus = c.tryResolve(ServiceIds.CACHE_INVALIDATION_BUS);

        // EmbeddingQueue is not in the container, use direct require.
        // Use the queue manager so path updates apply to all staged queues.
        let embeddingQueue = null;
        try {
          embeddingQueue = require('../analysis/embeddingQueue/queueManager');
        } catch {
          logger.debug('[ServiceIntegration] EmbeddingQueue not available for FilePathCoordinator');
        }

        coordinator.setServices({
          vectorDbService: vectorDb,
          analysisHistoryService: analysisHistory,
          embeddingQueue,
          processingStateService: processingState,
          cacheInvalidationBus,
          relationshipIndexService: c.tryResolve(ServiceIds.RELATIONSHIP_INDEX)
        });

        return coordinator;
      });
    }

    // Register NotificationService (used by watchers for user feedback)
    if (!container.has(ServiceIds.NOTIFICATION_SERVICE)) {
      container.registerSingleton(ServiceIds.NOTIFICATION_SERVICE, (/** @type {any} */ c) => {
        const settingsService = c.resolve(ServiceIds.SETTINGS);
        return new NotificationService({ settingsService });
      });
    }

    // Register SmartFolderWatcher (depends on multiple services)
    // This watcher auto-analyzes files when they are added to or modified in smart folders
    if (!container.has(ServiceIds.SMART_FOLDER_WATCHER)) {
      container.registerSingleton(ServiceIds.SMART_FOLDER_WATCHER, (/** @type {any} */ c) => {
        // Get required dependencies
        const analysisHistoryService = c.resolve(ServiceIds.ANALYSIS_HISTORY);
        const settingsService = c.resolve(ServiceIds.SETTINGS);
        const vectorDbService = c.resolve(ServiceIds.ORAMA_VECTOR);
        const filePathCoordinator = c.resolve(ServiceIds.FILE_PATH_COORDINATOR);
        const folderMatcher = c.resolve(ServiceIds.FOLDER_MATCHING);
        const notificationService = c.resolve(ServiceIds.NOTIFICATION_SERVICE);

        // Get analysis functions - these are passed in during setup
        // They will be set via setAnalysisFunctions after service creation
        return new SmartFolderWatcher({
          getSmartFolders: /** @returns {any[]} */ () => [],
          analysisHistoryService,
          analyzeDocumentFile: null,
          analyzeImageFile: null,
          analyzeMediaFile: null,
          settingsService,
          vectorDbService,
          filePathCoordinator,
          folderMatcher,
          notificationService,
          queueStore: createWatcherQueueStoreSafely()
        });
      });
    }

    // SearchService is a core feature service that was previously manually instantiated
    if (!container.has(ServiceIds.SEARCH_SERVICE)) {
      container.registerSingleton(ServiceIds.SEARCH_SERVICE, (/** @type {any} */ c) => {
        const { SearchService } = require('./SearchService');
        return new SearchService(
          /** @type {any} */ ({
            vectorDbService: c.resolve(ServiceIds.ORAMA_VECTOR),
            analysisHistoryService: c.resolve(ServiceIds.ANALYSIS_HISTORY),
            parallelEmbeddingService: c.resolve(ServiceIds.PARALLEL_EMBEDDING),
            llamaService: c.tryResolve(ServiceIds.LLAMA_SERVICE),
            relationshipIndexService: c.tryResolve(ServiceIds.RELATIONSHIP_INDEX),
            chatHistoryStore: c.tryResolve(ServiceIds.CHAT_HISTORY_STORE)
          })
        );
      });
    }

    // DownloadWatcher monitors downloads folder and needs proper shutdown handling
    if (!container.has(ServiceIds.DOWNLOAD_WATCHER)) {
      container.registerSingleton(ServiceIds.DOWNLOAD_WATCHER, (/** @type {any} */ c) => {
        const DownloadWatcher = require('./DownloadWatcher');
        return new DownloadWatcher({
          analyzeDocumentFile: null,
          analyzeImageFile: null,
          analyzeMediaFile: null,
          getCustomFolders: /** @returns {any[]} */ () => [],
          autoOrganizeService: c.resolve(ServiceIds.AUTO_ORGANIZE),
          settingsService: c.resolve(ServiceIds.SETTINGS),
          notificationService: c.resolve(ServiceIds.NOTIFICATION_SERVICE),
          analysisHistoryService: c.resolve(ServiceIds.ANALYSIS_HISTORY),
          vectorDbService: c.resolve(ServiceIds.ORAMA_VECTOR),
          folderMatcher: c.resolve(ServiceIds.FOLDER_MATCHING)
        });
      });
    }

    logger.info('[ServiceIntegration] Core services registered with container');
  }

  /**
   * Shutdown all services and cleanup resources
   *
   * This method shuts down all services in the reverse order of initialization,
   * ensuring that dependent services are stopped before their dependencies.
   * It uses both the legacy shutdown approach and the container's shutdown.
   *
   * @returns {Promise<void>}
   */
  async shutdown() {
    this._isShuttingDown = true;
    // This prevents race conditions where shutdown runs concurrently with init
    if (this._initPromise) {
      logger.debug(
        '[ServiceIntegration] Waiting for initialization to complete before shutdown...'
      );
      try {
        await this._initPromise;
      } catch {
        // Ignore init errors - we're shutting down anyway
      }
    }

    // Always attempt container cleanup — partially-initialized services may hold resources
    // (timers, file handles, watchers) even when this.initialized is false.
    try {
      await container.shutdown(SHUTDOWN_ORDER);
    } catch (err) {
      logger.error('[ServiceIntegration] Container shutdown error:', err?.message || String(err));
    }

    if (!this.initialized) return;

    try {
      logger.info('[ServiceIntegration] Starting coordinated shutdown...');

      // Clear orphan marking callback before nulling services
      // This callback holds closures to vectorService, preventing garbage collection
      if (this.analysisHistory?.setOnEntriesRemovedCallback) {
        this.analysisHistory.setOnEntriesRemovedCallback(null);
      }

      // Clear all service references
      this.analysisHistory = null;
      this.undoRedo = null;
      this.processingState = null;
      this.vectorService = null;
      this.folderMatchingService = null;
      this.suggestionService = null;
      this.autoOrganizeService = null;
      // Also clear SmartFolderWatcher reference to prevent memory leaks
      this.smartFolderWatcher = null;
      this.relationshipIndex = null;
      this.chatHistoryStore = null;
      this.initialized = false;

      logger.info('[ServiceIntegration] All services shut down successfully');
    } catch (error) {
      logger.error('[ServiceIntegration] Error during shutdown', {
        error: error?.message || String(error)
      });
    }
  }

  /**
   * Get a service from the container by its ID
   *
   * @param {string} serviceId - The service identifier (from ServiceIds)
   * @returns {*} The resolved service instance
   */
  getService(serviceId) {
    return container.resolve(serviceId);
  }

  /**
   * Check if a service is available
   *
   * @param {string} serviceId - The service identifier
   * @returns {boolean} True if the service is registered and available
   */
  hasService(serviceId) {
    return container.has(serviceId);
  }

  /**
   * Configure the SmartFolderWatcher with required dependencies
   * This must be called after the main process has set up analysis functions
   *
   * @param {Record<string, any>} config - { getSmartFolders, analyzeDocumentFile, analyzeImageFile, analyzeMediaFile? }
   */
  configureSmartFolderWatcher({
    getSmartFolders,
    analyzeDocumentFile,
    analyzeImageFile,
    analyzeMediaFile
  }) {
    try {
      this.smartFolderWatcher = container.resolve(ServiceIds.SMART_FOLDER_WATCHER);

      if (this.smartFolderWatcher) {
        // Update the watcher's dependencies
        this.smartFolderWatcher.getSmartFolders = getSmartFolders;
        this.smartFolderWatcher.analyzeDocumentFile = analyzeDocumentFile;
        this.smartFolderWatcher.analyzeImageFile = analyzeImageFile;
        if (typeof analyzeMediaFile === 'function') {
          this.smartFolderWatcher.analyzeMediaFile = analyzeMediaFile;
        }

        logger.info('[ServiceIntegration] SmartFolderWatcher configured');

        // Auto-start if enabled in settings (async, don't block)
        this._autoStartSmartFolderWatcher();
      }
    } catch (error) {
      logger.warn(
        '[ServiceIntegration] Failed to configure SmartFolderWatcher:',
        error?.message || String(error)
      );
    }
  }

  /**
   * Configure the DownloadWatcher with required dependencies
   * This must be called after the main process has set up analysis functions
   *
   * @param {Record<string, any>} config - { getCustomFolders, analyzeDocumentFile, analyzeImageFile, analyzeMediaFile? }
   */
  configureDownloadWatcher({
    getCustomFolders,
    analyzeDocumentFile,
    analyzeImageFile,
    analyzeMediaFile
  }) {
    try {
      const downloadWatcher = container.resolve(ServiceIds.DOWNLOAD_WATCHER);

      if (downloadWatcher) {
        // Update the watcher's dependencies (only when valid — wrong keys must not wipe defaults)
        if (typeof getCustomFolders === 'function') {
          downloadWatcher.getCustomFolders = getCustomFolders;
        }
        if (typeof analyzeDocumentFile === 'function') {
          downloadWatcher.analyzeDocumentFile = analyzeDocumentFile;
        }
        if (typeof analyzeImageFile === 'function') {
          downloadWatcher.analyzeImageFile = analyzeImageFile;
        }
        if (typeof analyzeMediaFile === 'function') {
          downloadWatcher.analyzeMediaFile = analyzeMediaFile;
        }

        logger.info('[ServiceIntegration] DownloadWatcher configured');
      }
    } catch (error) {
      logger.warn(
        '[ServiceIntegration] Failed to configure DownloadWatcher:',
        error?.message || String(error)
      );
    }
  }

  /**
   * Auto-start the SmartFolderWatcher.
   * start() honors the user-facing `smartFolderWatchEnabled` setting and returns
   * false (without attaching watchers) when the user has disabled it.
   * @private
   */
  async _autoStartSmartFolderWatcher() {
    if (!this.smartFolderWatcher) return;

    try {
      logger.info('[ServiceIntegration] Auto-starting SmartFolderWatcher...');
      await this.smartFolderWatcher.start();
    } catch (error) {
      logger.warn(
        '[ServiceIntegration] Error auto-starting SmartFolderWatcher:',
        error?.message || String(error)
      );
    }
  }

  /**
   * Configure the LearningFeedbackService with required dependencies
   * This must be called after the main process has set up smart folders
   *
   * @param {{ getSmartFolders?: (...args: any[]) => any }} config - Configuration object
   */
  configureLearningFeedback({ getSmartFolders }) {
    try {
      const learningService = container.resolve(ServiceIds.LEARNING_FEEDBACK);

      if (learningService) {
        learningService.getSmartFolders = getSmartFolders;
        logger.info('[ServiceIntegration] LearningFeedbackService configured');
      }
    } catch (error) {
      logger.warn(
        '[ServiceIntegration] Failed to configure LearningFeedbackService:',
        error?.message || String(error)
      );
    }
  }

  /**
   * Run a learning scan on existing smart folder contents
   * This teaches the system from how files are already organized
   *
   * @param {{ maxFilesPerFolder?: number, onlyWithAnalysis?: boolean }} [options] - Scan options
   * @returns {Promise<{scanned: number, learned: number}>}
   */
  async runLearningStartupScan(options = {}) {
    try {
      const learningService = container.resolve(ServiceIds.LEARNING_FEEDBACK);
      const analysisHistory = container.resolve(ServiceIds.ANALYSIS_HISTORY);

      if (!learningService) {
        logger.warn('[ServiceIntegration] LearningFeedbackService not available for startup scan');
        return { scanned: 0, learned: 0 };
      }

      logger.info('[ServiceIntegration] Running learning startup scan...');
      const result = await learningService.learnFromExistingFiles(analysisHistory, {
        maxFilesPerFolder: options.maxFilesPerFolder || 50,
        onlyWithAnalysis: options.onlyWithAnalysis !== false
      });

      logger.info('[ServiceIntegration] Learning startup scan complete', result);
      return result;
    } catch (error) {
      logger.warn(
        '[ServiceIntegration] Error during learning startup scan:',
        error?.message || String(error)
      );
      return { scanned: 0, learned: 0 };
    }
  }
}

// Export the class and re-export container and service IDs for convenience
module.exports = ServiceIntegration;
module.exports.container = container;
module.exports.ServiceIds = ServiceIds;
module.exports.SERVICE_INITIALIZATION_ORDER = SERVICE_INITIALIZATION_ORDER;
module.exports.CRITICAL_TIER0_SERVICES = CRITICAL_TIER0_SERVICES;
