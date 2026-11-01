/**
 * Tests for System IPC Handlers
 * Tests system metrics, statistics, and configuration handlers
 */

// Mock dependencies
jest.mock('../src/main/ipc/ipcWrappers', () => ({
  createHandler: jest.fn(({ handler }) => handler),
  createErrorResponse: jest.fn((error) => ({
    success: false,
    error: error.message || String(error)
  })),
  safeHandle: (ipcMain, channel, handler) => {
    ipcMain.handle(channel, handler);
  }
}));

// Mock the DegradedStateTracker singleton so we can observe raise/clear calls
// without standing up the EventEmitter machinery.
const mockDegradedTracker = { raise: jest.fn(), clear: jest.fn() };
jest.mock('../src/main/services/DegradedStateTracker', () => ({
  getInstance: () => mockDegradedTracker
}));

// APPLY_UPDATE routes through core/autoUpdater.quitAndInstall(), not electron-updater
// directly. Mock must be hoisted (top-level jest.mock) so the SUT's `require(...)` sees it.
jest.mock('../src/main/core/autoUpdater', () => ({
  quitAndInstall: jest.fn(),
  checkForUpdates: jest.fn()
}));

jest.mock('../src/shared/config/index', () => ({
  dump: jest.fn().mockReturnValue({
    config: { test: 'value' },
    metadata: { version: '1.0.0' }
  }),
  validate: jest.fn().mockReturnValue({
    valid: true,
    errors: [],
    warnings: []
  }),
  get: jest.fn().mockReturnValue('config-value')
}));

describe('registerSystemIpc', () => {
  let registerSystemIpc;
  let mockIpcMain;
  let mockLogger;
  let mockSystemAnalytics;
  let mockServiceIntegration;
  let handlers;
  let mockChildLogger;

  const { IPC_CHANNELS } = require('../src/shared/constants');
  const SYSTEM_CHANNELS = IPC_CHANNELS.SYSTEM;

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();

    handlers = {};
    mockIpcMain = {
      handle: jest.fn((channel, handler) => {
        handlers[channel] = handler;
      })
    };

    mockLogger = {
      info: jest.fn(),
      debug: jest.fn(),
      warn: jest.fn(),
      error: jest.fn()
    };
    mockChildLogger = {
      trace: jest.fn(),
      debug: jest.fn(),
      info: jest.fn(),
      warn: jest.fn(),
      error: jest.fn(),
      fatal: jest.fn()
    };
    mockLogger.pino = {
      child: jest.fn(() => mockChildLogger)
    };

    mockSystemAnalytics = {
      collectMetrics: jest.fn().mockResolvedValue({
        cpu: 50,
        memory: 60,
        uptime: 3600
      })
    };

    mockServiceIntegration = {
      analysisHistory: {
        getStatistics: jest.fn().mockResolvedValue({
          totalFiles: 100,
          totalCategories: 10
        }),
        getRecentAnalysis: jest
          .fn()
          .mockResolvedValue([{ fileName: 'test.pdf', category: 'documents' }])
      },
      undoRedo: {
        getActionHistory: jest
          .fn()
          .mockReturnValue([{ type: 'organize', timestamp: new Date().toISOString() }])
      }
    };

    registerSystemIpc = require('../src/main/ipc/system');
    registerSystemIpc({
      ipcMain: mockIpcMain,
      IPC_CHANNELS,
      logger: mockLogger,
      systemAnalytics: mockSystemAnalytics,
      getServiceIntegration: () => mockServiceIntegration
    });
  });

  describe('registration', () => {
    test('registers all system IPC handlers', () => {
      expect(mockIpcMain.handle).toHaveBeenCalledWith(
        SYSTEM_CHANNELS.GET_APPLICATION_STATISTICS,
        expect.any(Function)
      );
      expect(mockIpcMain.handle).toHaveBeenCalledWith(
        SYSTEM_CHANNELS.GET_METRICS,
        expect.any(Function)
      );
      expect(mockIpcMain.handle).toHaveBeenCalledWith(
        SYSTEM_CHANNELS.APPLY_UPDATE,
        expect.any(Function)
      );
      expect(mockIpcMain.handle).toHaveBeenCalledWith(
        SYSTEM_CHANNELS.GET_CONFIG,
        expect.any(Function)
      );
      expect(mockIpcMain.handle).toHaveBeenCalledWith(
        SYSTEM_CHANNELS.GET_CONFIG_VALUE,
        expect.any(Function)
      );
      expect(mockIpcMain.handle).toHaveBeenCalledWith(SYSTEM_CHANNELS.LOG, expect.any(Function));
    });
  });

  describe('GET_APPLICATION_STATISTICS handler', () => {
    test('returns application statistics', async () => {
      const handler = handlers[SYSTEM_CHANNELS.GET_APPLICATION_STATISTICS];

      const result = await handler();

      expect(result).toEqual({
        analysis: { totalFiles: 100, totalCategories: 10 },
        recentActions: expect.any(Array),
        recentAnalysis: expect.any(Array),
        timestamp: expect.any(String)
      });
    });

    test('fetches statistics from service integration', async () => {
      const handler = handlers[SYSTEM_CHANNELS.GET_APPLICATION_STATISTICS];

      await handler();

      expect(mockServiceIntegration.analysisHistory.getStatistics).toHaveBeenCalled();
      expect(mockServiceIntegration.analysisHistory.getRecentAnalysis).toHaveBeenCalledWith(20);
    });

    test('handles missing service gracefully', async () => {
      registerSystemIpc({
        ipcMain: mockIpcMain,
        IPC_CHANNELS,
        logger: mockLogger,
        systemAnalytics: mockSystemAnalytics,
        getServiceIntegration: () => null
      });

      const handler = handlers[SYSTEM_CHANNELS.GET_APPLICATION_STATISTICS];
      const result = await handler();

      expect(result).toEqual({
        analysis: {},
        recentActions: [],
        recentAnalysis: [],
        timestamp: expect.any(String)
      });
    });

    test('handles errors and returns empty object', async () => {
      mockServiceIntegration.analysisHistory.getStatistics.mockRejectedValue(
        new Error('Database error')
      );

      const handler = handlers[SYSTEM_CHANNELS.GET_APPLICATION_STATISTICS];
      const result = await handler();

      expect(result).toEqual({});
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to get system statistics:',
        expect.any(Error)
      );
    });
  });

  describe('GET_METRICS handler', () => {
    test('returns system metrics', async () => {
      const handler = handlers[SYSTEM_CHANNELS.GET_METRICS];

      const result = await handler();

      expect(result).toEqual({
        cpu: 50,
        memory: 60,
        uptime: 3600
      });
    });

    test('calls systemAnalytics.collectMetrics', async () => {
      const handler = handlers[SYSTEM_CHANNELS.GET_METRICS];

      await handler();

      expect(mockSystemAnalytics.collectMetrics).toHaveBeenCalled();
    });

    test('handles errors and returns empty object', async () => {
      mockSystemAnalytics.collectMetrics.mockRejectedValue(new Error('Metrics error'));

      const handler = handlers[SYSTEM_CHANNELS.GET_METRICS];
      const result = await handler();

      expect(result).toEqual({});
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to collect system metrics:',
        expect.any(Error)
      );
    });

    test('raises system.metrics-collection-failed flag on error', async () => {
      // Without this flag, the in-app health pill / metrics dashboard
      // shows zeros indistinguishable from "everything's fine". The
      // banner needs to fire so the user knows the indicator is
      // unreliable. Severity is `warning` (not `error`) — telemetry
      // failure isn't fatal to the user's main task.
      mockDegradedTracker.raise.mockClear();
      mockDegradedTracker.clear.mockClear();
      mockSystemAnalytics.collectMetrics.mockRejectedValue(new Error('boom'));

      const handler = handlers[SYSTEM_CHANNELS.GET_METRICS];
      await handler();

      expect(mockDegradedTracker.raise).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'system.metrics-collection-failed',
          subsystem: 'metrics',
          severity: 'warning',
          message: expect.stringMatching(/health metrics couldn't be collected/i)
        })
      );
    });

    test('clears the flag on the next successful metrics read', async () => {
      mockDegradedTracker.raise.mockClear();
      mockDegradedTracker.clear.mockClear();
      mockSystemAnalytics.collectMetrics.mockResolvedValue({ cpu: 1 });

      const handler = handlers[SYSTEM_CHANNELS.GET_METRICS];
      await handler();

      expect(mockDegradedTracker.clear).toHaveBeenCalledWith('system.metrics-collection-failed');
      expect(mockDegradedTracker.raise).not.toHaveBeenCalled();
    });
  });

  describe('APPLY_UPDATE handler', () => {
    let quitAndInstallMock;

    beforeEach(() => {
      // Reset the module-level mock before each test so assertions are isolated.
      ({ quitAndInstall: quitAndInstallMock } = require('../src/main/core/autoUpdater'));
      quitAndInstallMock.mockReset();
    });

    test('invokes autoUpdater.quitAndInstall and returns success', async () => {
      quitAndInstallMock.mockReturnValue({ success: true });

      const handler = handlers[SYSTEM_CHANNELS.APPLY_UPDATE];
      const result = await handler();

      expect(quitAndInstallMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ success: true });
    });

    test('returns error response when quitAndInstall reports failure', async () => {
      quitAndInstallMock.mockReturnValue({ success: false, error: 'No update available' });

      const handler = handlers[SYSTEM_CHANNELS.APPLY_UPDATE];
      const result = await handler();

      expect(quitAndInstallMock).toHaveBeenCalledTimes(1);
      expect(result).toMatchObject({ success: false });
      expect(String(result.error)).toContain('No update available');
    });

    test('catches thrown errors and logs them', async () => {
      quitAndInstallMock.mockImplementation(() => {
        throw new Error('autoUpdater not initialized');
      });

      const handler = handlers[SYSTEM_CHANNELS.APPLY_UPDATE];
      const result = await handler();

      expect(result).toMatchObject({ success: false });
      expect(mockLogger.error).toHaveBeenCalledWith('Failed to apply update:', expect.any(Error));
    });
  });

  describe('CHECK_FOR_UPDATES handler', () => {
    let checkForUpdatesMock;

    beforeEach(() => {
      ({ checkForUpdates: checkForUpdatesMock } = require('../src/main/core/autoUpdater'));
      checkForUpdatesMock.mockReset();
    });

    test('returns success when the check starts', async () => {
      checkForUpdatesMock.mockResolvedValue({ success: true });

      const result = await handlers[SYSTEM_CHANNELS.CHECK_FOR_UPDATES]();

      expect(checkForUpdatesMock).toHaveBeenCalledTimes(1);
      expect(result).toEqual({ success: true });
    });

    test('passes the reason through when this copy cannot update itself', async () => {
      const reason = 'This copy was not installed with the StratoSort Stack installer.';
      checkForUpdatesMock.mockResolvedValue({ success: false, unsupported: true, error: reason });

      const result = await handlers[SYSTEM_CHANNELS.CHECK_FOR_UPDATES]();

      expect(result).toEqual({ success: true, unsupported: true, reason });
    });

    test('passes disabled through when auto-updates are turned off', async () => {
      checkForUpdatesMock.mockResolvedValue({ success: true, disabled: true });

      const result = await handlers[SYSTEM_CHANNELS.CHECK_FOR_UPDATES]();

      expect(result).toEqual({ success: true, disabled: true });
    });

    test('returns an error response when the check fails', async () => {
      checkForUpdatesMock.mockResolvedValue({
        success: false,
        error: 'net::ERR_INTERNET_DISCONNECTED'
      });

      const result = await handlers[SYSTEM_CHANNELS.CHECK_FOR_UPDATES]();

      expect(result).toMatchObject({ success: false });
      expect(result.unsupported).toBeUndefined();
      expect(JSON.stringify(result.error)).toContain('net::ERR_INTERNET_DISCONNECTED');
    });

    test('catches thrown errors and logs them', async () => {
      checkForUpdatesMock.mockRejectedValue(new Error('boom'));

      const result = await handlers[SYSTEM_CHANNELS.CHECK_FOR_UPDATES]();

      expect(result).toMatchObject({ success: false });
      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to check for updates:',
        expect.any(Error)
      );
    });
  });

  describe('GET_CONFIG handler', () => {
    test('returns configuration dump', async () => {
      const handler = handlers[SYSTEM_CHANNELS.GET_CONFIG];

      const result = await handler();

      expect(result).toEqual({
        success: true,
        config: { test: 'value' },
        metadata: { version: '1.0.0' },
        validation: {
          valid: true,
          errorCount: 0,
          warningCount: 0
        }
      });
    });

    test('calls config dump with includeSensitive: false', async () => {
      const { dump } = require('../src/shared/config/index');
      const handler = handlers[SYSTEM_CHANNELS.GET_CONFIG];

      await handler();

      expect(dump).toHaveBeenCalledWith({ includeSensitive: false });
    });

    test('includes validation results', async () => {
      const { validate } = require('../src/shared/config/index');
      validate.mockReturnValue({
        valid: false,
        errors: ['Error 1', 'Error 2'],
        warnings: ['Warning 1']
      });

      const handler = handlers[SYSTEM_CHANNELS.GET_CONFIG];
      const result = await handler();

      expect(result.validation).toEqual({
        valid: false,
        errorCount: 2,
        warningCount: 1
      });
    });

    test('handles errors', async () => {
      const { dump } = require('../src/shared/config/index');
      dump.mockImplementation(() => {
        throw new Error('Config error');
      });

      const handler = handlers[SYSTEM_CHANNELS.GET_CONFIG];
      const result = await handler();

      expect(result.success).toBe(false);
      expect(result.error).toBe('Config error');
    });
  });

  describe('GET_CONFIG_VALUE handler', () => {
    test('returns config value by path', async () => {
      const handler = handlers[SYSTEM_CHANNELS.GET_CONFIG_VALUE];

      const result = await handler(null, 'test.path');

      expect(result).toEqual({
        success: true,
        path: 'test.path',
        value: 'config-value'
      });
    });

    test('calls config get with path', async () => {
      const { get } = require('../src/shared/config/index');
      const handler = handlers[SYSTEM_CHANNELS.GET_CONFIG_VALUE];

      await handler(null, 'my.config.path');

      expect(get).toHaveBeenCalledWith('my.config.path');
    });

    test('handles errors', async () => {
      const { get } = require('../src/shared/config/index');
      get.mockImplementation(() => {
        throw new Error('Path not found');
      });

      const handler = handlers[SYSTEM_CHANNELS.GET_CONFIG_VALUE];
      const result = await handler(null, 'invalid.path');

      expect(result.success).toBe(false);
      expect(result.error).toBe('Path not found');
    });

    test('rejects blocked prototype segments', async () => {
      const handler = handlers[SYSTEM_CHANNELS.GET_CONFIG_VALUE];
      const result = await handler(null, '__proto__.polluted');

      expect(result.success).toBe(false);
      expect(result.error).toContain('blocked segment');
    });

    test('rejects traversal-like or invalid characters', async () => {
      const handler = handlers[SYSTEM_CHANNELS.GET_CONFIG_VALUE];

      const traversal = await handler(null, 'ENV..nodeEnv');
      expect(traversal.success).toBe(false);
      expect(traversal.error).toContain('invalid');

      const invalidChars = await handler(null, 'ENV.nodeEnv;$');
      expect(invalidChars.success).toBe(false);
      expect(invalidChars.error).toContain('invalid characters');
    });
  });

  describe('DISMISS_DEGRADED_FLAG handler', () => {
    const DegradedStateTrackerPath = '../src/main/services/DegradedStateTracker';

    beforeEach(() => {
      jest.doMock(DegradedStateTrackerPath, () => ({
        getInstance: () => ({
          dismiss: jest.fn((code) => code === 'MEMORY_PRESSURE')
        })
      }));
    });

    afterEach(() => {
      jest.dontMock(DegradedStateTrackerPath);
    });

    test('uses the payload `code` (not the IPC event) when dismissing', async () => {
      const handler = handlers[SYSTEM_CHANNELS.DISMISS_DEGRADED_FLAG];
      const mockEvent = { sender: { id: 1 } };

      const ok = await handler(mockEvent, { code: 'MEMORY_PRESSURE' });
      expect(ok).toEqual({ success: true, dismissed: true });

      const miss = await handler(mockEvent, { code: 'UNKNOWN_FLAG' });
      expect(miss).toEqual({ success: true, dismissed: false });
    });

    test('rejects empty payload', async () => {
      const handler = handlers[SYSTEM_CHANNELS.DISMISS_DEGRADED_FLAG];
      const result = await handler({ sender: { id: 1 } }, {});
      expect(result).toEqual(expect.objectContaining({ success: false }));
    });
  });

  describe('SYSTEM.LOG handler', () => {
    test('returns success false for invalid payload', async () => {
      const handler = handlers[SYSTEM_CHANNELS.LOG];
      const result = await handler(null, null);
      expect(result).toEqual({ success: false });
    });

    test('sanitizes large payloads and defaults invalid log level', async () => {
      const handler = handlers[SYSTEM_CHANNELS.LOG];
      const veryLargeMessage = 'm'.repeat(9000);
      const veryLargeData = {
        context: 'ctx'.repeat(200),
        blob: 'x'.repeat(200000)
      };

      const result = await handler(null, {
        level: 'not-a-level',
        message: veryLargeMessage,
        data: veryLargeData
      });

      expect(result).toEqual({ success: true });
      expect(mockLogger.info).toHaveBeenCalledTimes(1);

      const [loggedMessage, loggedData] = mockLogger.info.mock.calls[0];
      expect(typeof loggedMessage).toBe('string');
      expect(loggedMessage.length).toBeLessThanOrEqual(8250);
      expect(loggedData).toEqual(
        expect.objectContaining({
          truncated: true,
          reason: 'payload_too_large'
        })
      );
    });

    test('strips log-line injection characters from message and data (regression)', async () => {
      const handler = handlers[SYSTEM_CHANNELS.LOG];
      // Classic log-injection payload: CR/LF to forge a new line, plus an
      // ANSI/OSC escape and a C0 control char.
      const attackerMessage = 'hello\r\n[ERROR] forged line\u001b[31m\u0007\u0000end';
      const attackerData = {
        context: 'Security\u001bBYPASS',
        nested: {
          note: 'line1\nline2\rline3'
        }
      };

      const result = await handler(null, {
        level: 'warn',
        message: attackerMessage,
        data: attackerData
      });

      expect(result).toEqual({ success: true });
      expect(mockLogger.warn).toHaveBeenCalledTimes(1);

      const [loggedMessage, loggedData] = mockLogger.warn.mock.calls[0];
      // No CR, LF, BEL, ESC, or NUL should survive in the composed log line.
      // eslint-disable-next-line no-control-regex -- assertion intentionally checks for control bytes
      expect(loggedMessage).not.toMatch(/[\r\n\u0000\u0007\u001b]/);
      // "Renderer" facility prefix must always be present, and the
      // attacker-supplied context must not impersonate a separate facility
      // with control bytes.
      expect(loggedMessage).toMatch(/^\[Renderer:/);
      // Nested string values must also be stripped of injection bytes.
      expect(loggedData.nested.note).not.toMatch(/[\r\n]/);
    });

    test('keeps the Renderer: facility prefix even when renderer provides no context', async () => {
      const handler = handlers[SYSTEM_CHANNELS.LOG];
      const result = await handler(null, { level: 'info', message: 'plain', data: {} });
      expect(result).toEqual({ success: true });
      const [loggedMessage] = mockLogger.info.mock.calls.at(-1);
      expect(loggedMessage.startsWith('[Renderer]')).toBe(true);
    });
  });
});
