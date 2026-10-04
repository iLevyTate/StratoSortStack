/**
 * Extended tests for llama IPC handlers.
 * Covers UPDATE_CONFIG, TEST_CONNECTION, DOWNLOAD_MODEL,
 * DELETE_MODEL, and GET_DOWNLOAD_STATUS handlers.
 */

const mockHandlers = new Map();

jest.mock('../src/main/ipc/ipcWrappers', () => ({
  createHandler: jest.fn(({ handler }) => handler),
  safeHandle: jest.fn((_ipcMain, channel, handler) => {
    mockHandlers.set(channel, handler);
  }),
  withErrorLogging: jest.fn((_logger, fn) => fn),
  safeSend: jest.fn(),
  z: null
}));

const mockLlamaService = {
  initialize: jest.fn().mockResolvedValue(),
  listModels: jest.fn().mockResolvedValue([]),
  getConfig: jest
    .fn()
    .mockResolvedValue({ textModel: 't.gguf', visionModel: 'v.gguf', embeddingModel: 'e.gguf' }),
  updateConfig: jest.fn().mockResolvedValue(),
  getHealthStatus: jest
    .fn()
    .mockReturnValue({ healthy: true, initialized: true, gpuBackend: 'cpu' }),
  _gpuBackend: 'cpu'
};

jest.mock('../src/main/services/LlamaService', () => ({
  getInstance: jest.fn(() => mockLlamaService),
  registerWithContainer: jest.fn((cont, id) => {
    if (typeof cont.has === 'function' && !cont.has(id)) {
      cont.registerSingleton(id, () => mockLlamaService);
    }
  })
}));

const mockDownloadManager = {
  downloadModel: jest.fn().mockResolvedValue({ success: true }),
  deleteModel: jest.fn().mockResolvedValue({ success: true }),
  getStatus: jest.fn().mockReturnValue({ active: 0 }),
  getDownloadedModels: jest.fn().mockResolvedValue([]),
  isDownloading: jest.fn().mockReturnValue(false),
  cancelDownload: jest.fn().mockReturnValue(true)
};

jest.mock('../src/main/services/ModelDownloadManager', () => ({
  getInstance: jest.fn(() => mockDownloadManager),
  // Mirrors the real module's singletonFactory surface: registration installs
  // a container factory yielding the same (mock) instance.
  registerWithContainer: jest.fn((container, serviceId) => {
    container.registerSingleton(serviceId, () => mockDownloadManager);
  })
}));

const mockEnsureResolvedModelsPath = jest.fn();
jest.mock('../src/main/services/modelPathResolver', () => ({
  ensureResolvedModelsPath: (...args) => mockEnsureResolvedModelsPath(...args)
}));

const { registerLlamaIpc } = require('../src/main/ipc/llama');
const { container } = require('../src/main/services/ServiceContainer');
const { safeSend } = require('../src/main/ipc/ipcWrappers');
const { IPC_EVENTS } = require('../src/shared/constants');

describe('llama IPC – extended handlers', () => {
  let mockLogger;
  /** @type {Record<string, any>} */
  let systemAnalytics;

  beforeEach(() => {
    jest.clearAllMocks();
    mockHandlers.clear();
    container.reset();
    systemAnalytics = {};
    mockLogger = {
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      debug: jest.fn()
    };
    mockLlamaService.updateConfig.mockResolvedValue({
      success: true,
      modelDowngraded: false,
      selected: { text: 't.gguf', vision: 'v.gguf', embedding: 'e.gguf' }
    });
    mockLlamaService.getConfig.mockResolvedValue({
      textModel: 't.gguf',
      visionModel: 'v.gguf',
      embeddingModel: 'e.gguf'
    });
    mockEnsureResolvedModelsPath.mockResolvedValue({
      source: 'current',
      modelsPath: '/test/userData/models',
      currentModelsPath: '/test/userData/models'
    });

    registerLlamaIpc({
      ipcMain: {},
      IPC_CHANNELS: {
        LLAMA: {
          GET_MODELS: 'llama:get-models',
          GET_CONFIG: 'llama:get-config',
          UPDATE_CONFIG: 'llama:update-config',
          TEST_CONNECTION: 'llama:test-connection',
          DOWNLOAD_MODEL: 'llama:download-model',
          DELETE_MODEL: 'llama:delete-model',
          GET_DOWNLOAD_STATUS: 'llama:get-download-status',
          CANCEL_DOWNLOAD: 'llama:cancel-download',
          WARM: 'llama:warm'
        }
      },
      logger: mockLogger,
      systemAnalytics,
      getMainWindow: () => null
    });
  });

  function getHandler(name) {
    for (const [channel, handler] of mockHandlers.entries()) {
      if (channel.includes(name)) return handler;
    }
    throw new Error(`No handler found matching "${name}"`);
  }

  describe('GET_MODELS', () => {
    test('reports a paused model type and the CPU fallback like TEST_CONNECTION does', async () => {
      mockLlamaService.getHealthStatus.mockReturnValueOnce({
        healthy: false,
        initialized: true,
        degraded: true,
        openCircuits: ['text'],
        usingCPUFallback: true,
        gpuBackend: 'cpu'
      });

      const result = await getHandler('get-models')({});

      expect(result.llamaHealth).toMatchObject({
        status: 'unhealthy',
        initialized: true,
        degraded: true,
        openCircuits: ['text'],
        usingCPUFallback: true
      });
    });

    test('a healthy engine reports no degradation', async () => {
      const result = await getHandler('get-models')({});

      expect(result.llamaHealth).toMatchObject({
        status: 'healthy',
        degraded: false,
        openCircuits: [],
        usingCPUFallback: false
      });
    });
  });

  describe('UPDATE_CONFIG', () => {
    test('updates config successfully', async () => {
      const handler = getHandler('update-config');
      mockLlamaService.getConfig
        .mockResolvedValueOnce({
          textModel: 't.gguf',
          visionModel: 'v.gguf',
          embeddingModel: 'e.gguf'
        })
        .mockResolvedValueOnce({
          textModel: 'new-model.gguf',
          visionModel: 'v.gguf',
          embeddingModel: 'e.gguf'
        });
      mockLlamaService.updateConfig.mockResolvedValueOnce({
        success: true,
        modelDowngraded: false,
        selected: { text: 'new-model.gguf', vision: 'v.gguf', embedding: 'e.gguf' }
      });
      const result = await handler({}, { textModel: 'new-model.gguf' });

      expect(result.success).toBe(true);
      expect(result.changes.textModel).toEqual({
        from: 't.gguf',
        to: 'new-model.gguf'
      });
      expect(mockLlamaService.updateConfig).toHaveBeenCalledWith({ textModel: 'new-model.gguf' });
      expect(mockLogger.info).toHaveBeenCalledWith(
        '[IPC:Llama] Config update applied',
        expect.objectContaining({
          changedModelKeys: expect.arrayContaining(['textModel'])
        })
      );
    });

    test('returns error on failure', async () => {
      const handler = getHandler('update-config');
      mockLlamaService.updateConfig.mockRejectedValueOnce(new Error('config invalid'));

      const result = await handler({}, { gpuLayers: 999 });

      expect(result.success).toBe(false);
      expect(result.error).toBe('config invalid');
    });

    test('error envelope includes a stable code field for renderer dispatch', async () => {
      // Regression guard: prior to this fix, every Llama IPC failure returned
      // `{ success: false, error: error.message }` with no machine-readable
      // tag. The renderer could not distinguish MODEL_NOT_LOADED from
      // OUT_OF_MEMORY from GGUF_CORRUPT — they all surfaced as the same
      // generic toast. The handler now emits a `code` field that prefers
      // (in order) the llama classifier code, the native error.code, the
      // error subclass name, then a 'LLAMA_ERROR' fallback. This test
      // exercises each branch.
      const handler = getHandler('update-config');

      // Branch 1: classifier-recognized llama error → llamaCode AND code set.
      // Trigger by throwing an error whose message matches the classifier
      // (we use a "model not found" phrase which classifyLlamaError maps to
      // LLAMA_MODEL_NOT_FOUND).
      mockLlamaService.updateConfig.mockRejectedValueOnce(
        new Error('Whisper model not found at /path/to/model.bin')
      );
      let result = await handler({}, { textModel: 'missing.gguf' });
      expect(result.success).toBe(false);
      expect(typeof result.code).toBe('string');
      // llamaCode should be present whenever the classifier matched.
      expect(typeof result.llamaCode).toBe('string');
      expect(result.code).toBe(result.llamaCode);

      // Branch 2: native error code (no classifier match) → uses error.code.
      const enoent = new Error('disk gone');
      enoent.code = 'ENOENT';
      mockLlamaService.updateConfig.mockRejectedValueOnce(enoent);
      result = await handler({}, { textModel: 'x.gguf' });
      expect(result.code).toBe('ENOENT');
      expect(result.llamaCode).toBeUndefined();

      // Branch 3: subclass name → uses error.name when not generic 'Error'.
      class CustomLlamaError extends Error {
        constructor(message) {
          super(message);
          this.name = 'CustomLlamaError';
        }
      }
      mockLlamaService.updateConfig.mockRejectedValueOnce(new CustomLlamaError('boom'));
      result = await handler({}, { textModel: 'x.gguf' });
      expect(result.code).toBe('CustomLlamaError');

      // Branch 4: plain Error with no code → fallback constant.
      mockLlamaService.updateConfig.mockRejectedValueOnce(new Error('plain failure'));
      result = await handler({}, { textModel: 'x.gguf' });
      expect(result.code).toBe('LLAMA_ERROR');
    });

    test('maps legacy llama* config keys to canonical service keys', async () => {
      const handler = getHandler('update-config');
      await handler({}, { llamaGpuLayers: 42, llamaContextSize: 16384 });

      expect(mockLlamaService.updateConfig).toHaveBeenCalledWith(
        expect.objectContaining({
          llamaGpuLayers: 42,
          llamaContextSize: 16384,
          gpuLayers: 42,
          contextSize: 16384
        })
      );
    });

    test('surfaces model downgrade and logs a warning', async () => {
      const handler = getHandler('update-config');
      mockLlamaService.updateConfig.mockResolvedValueOnce({
        success: true,
        modelDowngraded: true,
        selected: { text: 't.gguf', vision: 'v.gguf', embedding: 'default-embed.gguf' }
      });

      const result = await handler({}, { embeddingModel: 'invalid-not-embedding.gguf' });

      expect(result.success).toBe(true);
      expect(result.modelDowngraded).toBe(true);
      expect(mockLogger.warn).toHaveBeenCalledWith(
        '[IPC:Llama] Unsupported model request adjusted to safe defaults',
        expect.objectContaining({
          requested: expect.objectContaining({
            embeddingModel: 'invalid-not-embedding.gguf'
          })
        })
      );
    });
  });

  describe('TEST_CONNECTION', () => {
    test('returns healthy status', async () => {
      const handler = getHandler('test-connection');
      const result = await handler();

      expect(result.success).toBe(true);
      expect(result.status).toBe('healthy');
      expect(result.inProcess).toBe(true);
    });

    test('returns unhealthy on init failure', async () => {
      const handler = getHandler('test-connection');
      mockLlamaService.initialize.mockRejectedValueOnce(new Error('GPU init failed'));

      const result = await handler();

      expect(result.success).toBe(false);
      expect(result.status).toBe('unhealthy');
      expect(result.error).toBe('GPU init failed');
    });
  });

  describe('llamaHealth snapshot (per-model CPU fallback reaches the renderer)', () => {
    // LlamaService.getHealthStatus() reports WHICH model types fell back to
    // the CPU in `cpuFallbackTypes`, and the Settings badge is the only
    // consumer of that information. Both producers of the renderer-facing
    // `llamaHealth` snapshot must carry it: the Settings panel refreshes
    // models right after a health check (and, when the nav bar already probed
    // the engine, instead of one), so a get-models snapshot that cannot
    // express a fallback silently overwrote the honest badge with a green one.
    const degradedHealth = {
      healthy: true,
      initialized: true,
      degraded: true,
      openCircuits: [],
      usingCPUFallback: true,
      cpuFallbackTypes: ['text', 'embedding'],
      gpuBackend: 'vulkan',
      gpuDetected: { vramMB: 6144 },
      gpuSelection: { selected: 'vulkan' }
    };

    // jest.clearAllMocks() clears calls but keeps implementations, so the
    // shared healthy default has to be put back by hand.
    afterEach(() => {
      mockLlamaService.getHealthStatus.mockReturnValue({
        healthy: true,
        initialized: true,
        gpuBackend: 'cpu'
      });
    });

    test('test-connection forwards cpuFallbackTypes', async () => {
      mockLlamaService.getHealthStatus.mockReturnValueOnce(degradedHealth);

      const result = await getHandler('test-connection')();

      expect(result.llamaHealth).toEqual(
        expect.objectContaining({
          usingCPUFallback: true,
          cpuFallbackTypes: ['text', 'embedding'],
          degraded: true,
          gpuBackend: 'vulkan'
        })
      );
      expect(systemAnalytics.llamaHealth.cpuFallbackTypes).toEqual(['text', 'embedding']);
    });

    test('get-models forwards the fallback fields instead of dropping them', async () => {
      mockLlamaService.getHealthStatus.mockReturnValue(degradedHealth);

      const result = await getHandler('get-models')({});

      expect(result.llamaHealth).toEqual(
        expect.objectContaining({
          usingCPUFallback: true,
          cpuFallbackTypes: ['text', 'embedding'],
          degraded: true,
          openCircuits: [],
          gpuBackend: 'vulkan'
        })
      );
    });

    test('a model refresh after a health check cannot erase an active fallback', async () => {
      mockLlamaService.getHealthStatus.mockReturnValue(degradedHealth);

      await getHandler('test-connection')();
      const afterRefresh = await getHandler('get-models')({});

      // SettingsPanel assigns llamaHealth from whichever call answered last.
      expect(afterRefresh.llamaHealth.usingCPUFallback).toBe(true);
      expect(afterRefresh.llamaHealth.cpuFallbackTypes).toEqual(['text', 'embedding']);
    });

    test('an open circuit breaker survives a model refresh too', async () => {
      mockLlamaService.getHealthStatus.mockReturnValue({
        ...degradedHealth,
        healthy: false,
        usingCPUFallback: false,
        cpuFallbackTypes: [],
        openCircuits: ['text']
      });

      const result = await getHandler('get-models')({});

      expect(result.llamaHealth.openCircuits).toEqual(['text']);
      expect(result.llamaHealth.status).toBe('unhealthy');
    });

    // The failure paths used to hand-build `{ status, error, lastCheck }`,
    // which meant the snapshot shape depended on which code path produced it.
    // Pin every producer to the same field set so a hand-built literal
    // creeping back in fails here rather than in the UI.
    const SNAPSHOT_FIELDS = [
      'status',
      'initialized',
      'degraded',
      'openCircuits',
      'usingCPUFallback',
      'cpuFallbackTypes',
      'gpuBackend',
      'gpuDetected',
      'gpuSelection',
      'lastCheck'
    ];

    test('a failed model listing still produces the full snapshot shape', async () => {
      mockLlamaService.listModels.mockRejectedValueOnce(new Error('models dir unreadable'));

      const result = await getHandler('get-models')({});

      expect(Object.keys(result.llamaHealth)).toEqual(expect.arrayContaining(SNAPSHOT_FIELDS));
      expect(result.llamaHealth).toEqual(
        expect.objectContaining({
          status: 'unhealthy',
          error: 'models dir unreadable',
          initialized: false,
          usingCPUFallback: false,
          cpuFallbackTypes: [],
          openCircuits: []
        })
      );
    });

    test('a failed health check still produces the full snapshot shape', async () => {
      mockLlamaService.initialize.mockRejectedValueOnce(new Error('GPU init failed'));

      const result = await getHandler('test-connection')();

      expect(Object.keys(result.llamaHealth)).toEqual(expect.arrayContaining(SNAPSHOT_FIELDS));
      expect(result.llamaHealth).toEqual(
        expect.objectContaining({
          status: 'unhealthy',
          error: 'GPU init failed',
          initialized: false,
          cpuFallbackTypes: []
        })
      );
    });
  });

  describe('DOWNLOAD_MODEL', () => {
    test('rejects empty model name', async () => {
      const handler = getHandler('download-model');
      const result = await handler({}, '');

      expect(result.success).toBe(false);
      expect(result.error).toContain('required');
    });

    test('rejects path traversal in model name', async () => {
      const handler = getHandler('download-model');

      const dotResult = await handler({}, '../../../etc/passwd');
      expect(dotResult.success).toBe(false);
      expect(dotResult.error).toContain('Invalid');

      const slashResult = await handler({}, 'models/evil.gguf');
      expect(slashResult.success).toBe(false);
      expect(slashResult.error).toContain('Invalid');

      const backslashResult = await handler({}, 'models\\evil.gguf');
      expect(backslashResult.success).toBe(false);
      expect(backslashResult.error).toContain('Invalid');
    });

    test('starts model download and returns immediately', async () => {
      const handler = getHandler('download-model');
      const result = await handler({}, 'llama-3.gguf');

      expect(result.success).toBe(true);
      expect(result.started).toBe(true);
      expect(mockDownloadManager.downloadModel).toHaveBeenCalledWith(
        'llama-3.gguf',
        expect.objectContaining({ onProgress: expect.any(Function) })
      );
    });

    test('returns success immediately even when download will fail (non-blocking)', async () => {
      // The download handler is non-blocking: it starts the download in the
      // background and returns { success: true, started: true } immediately.
      // Errors are reported via IPC OPERATION_PROGRESS events, not the return value.
      const handler = getHandler('download-model');
      mockDownloadManager.downloadModel.mockRejectedValueOnce(new Error('network error'));

      const result = await handler({}, 'model.gguf');

      expect(result.success).toBe(true);
      expect(result.started).toBe(true);
      expect(mockDownloadManager.downloadModel).toHaveBeenCalledWith(
        'model.gguf',
        expect.objectContaining({ onProgress: expect.any(Function) })
      );
    });

    test('emits legacy directory warning before download when legacy path is active', async () => {
      mockHandlers.clear();
      const win = { isDestroyed: () => false, webContents: {} };
      mockEnsureResolvedModelsPath.mockResolvedValueOnce({
        source: 'legacy',
        modelsPath: '/legacy/userData/models',
        currentModelsPath: '/test/userData/models'
      });

      registerLlamaIpc({
        ipcMain: {},
        IPC_CHANNELS: {
          LLAMA: {
            GET_MODELS: 'llama:get-models',
            GET_CONFIG: 'llama:get-config',
            UPDATE_CONFIG: 'llama:update-config',
            TEST_CONNECTION: 'llama:test-connection',
            DOWNLOAD_MODEL: 'llama:download-model',
            DELETE_MODEL: 'llama:delete-model',
            GET_DOWNLOAD_STATUS: 'llama:get-download-status',
            CANCEL_DOWNLOAD: 'llama:cancel-download',
            WARM: 'llama:warm'
          }
        },
        logger: mockLogger,
        systemAnalytics: {},
        getMainWindow: () => win
      });

      const handler = getHandler('download-model');
      const result = await handler({}, 'legacy-model.gguf');

      expect(result.success).toBe(true);
      expect(safeSend).toHaveBeenCalledWith(
        win.webContents,
        IPC_EVENTS.NOTIFICATION,
        expect.objectContaining({
          message: expect.stringContaining('legacy models directory'),
          severity: 'warning'
        })
      );
    });
  });

  describe('DELETE_MODEL', () => {
    test('rejects empty model name', async () => {
      const handler = getHandler('delete-model');
      const result = await handler({}, '  ');

      expect(result.success).toBe(false);
      expect(result.error).toContain('required');
    });

    test('rejects path traversal', async () => {
      const handler = getHandler('delete-model');
      const result = await handler({}, '../../secrets.txt');

      expect(result.success).toBe(false);
      expect(result.error).toContain('Invalid');
    });

    test('deletes model successfully', async () => {
      const handler = getHandler('delete-model');
      const result = await handler({}, 'old-model.gguf');

      expect(result.success).toBe(true);
      expect(mockDownloadManager.deleteModel).toHaveBeenCalledWith('old-model.gguf');
    });
  });

  describe('GET_DOWNLOAD_STATUS', () => {
    test('returns download status', async () => {
      const handler = getHandler('download-status');
      const result = await handler();

      expect(result.success).toBe(true);
      expect(result.status).toBeDefined();
    });

    test('returns error on failure', async () => {
      const handler = getHandler('download-status');
      mockDownloadManager.getStatus.mockImplementationOnce(() => {
        throw new Error('manager disposed');
      });

      const result = await handler();

      expect(result.success).toBe(false);
      expect(result.error).toBe('manager disposed');
    });
  });

  describe('CANCEL_DOWNLOAD', () => {
    test('exposes llama:cancel-download on IPC_CHANNELS', () => {
      const { IPC_CHANNELS } = jest.requireActual('../src/shared/constants');
      expect(IPC_CHANNELS.LLAMA.CANCEL_DOWNLOAD).toBe('llama:cancel-download');
    });

    test('cancels an in-progress download', async () => {
      const handler = getHandler('cancel-download');
      const result = await handler({}, 'model.gguf');

      expect(result).toEqual({ success: true, cancelled: true });
      expect(mockDownloadManager.cancelDownload).toHaveBeenCalledWith('model.gguf');
    });

    test('returns error when no download is in progress', async () => {
      const handler = getHandler('cancel-download');
      mockDownloadManager.cancelDownload.mockReturnValueOnce(false);
      const result = await handler({}, 'missing.gguf');

      expect(result.success).toBe(false);
      expect(result.error).toMatch(/no in-progress download/i);
    });
  });
});
