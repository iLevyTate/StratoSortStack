const os = require('os');
const path = require('path');
const { ipcMain, dialog } = require('./mocks/electron');
const { getSemanticFileId } = require('../src/shared/fileIdUtils');

// Hot-replace the DegradedStateTracker singleton so the assertions below can
// observe raise/clear calls without standing up the real EventEmitter machine.
const mockTracker = { raise: jest.fn(), clear: jest.fn() };
jest.mock('../src/main/services/DegradedStateTracker', () => ({
  getInstance: () => mockTracker
}));
// Export redaction has its own suite; the CSV export assertion below is about
// cell encoding, so pass rows through untouched.
jest.mock('../src/shared/exportRedaction', () => ({ deepSanitizeForExport: (data) => data }));

describe('AnalysisHistory IPC (behavior)', () => {
  beforeEach(() => {
    ipcMain._handlers.clear();
    ipcMain.handle.mockClear();
    mockTracker.raise.mockClear();
    mockTracker.clear.mockClear();
    jest.resetModules();
  });

  function registerWith(serviceIntegration) {
    const registerAnalysisHistoryIpc = require('../src/main/ipc/analysisHistory');
    const { IPC_CHANNELS } = require('../src/shared/constants');
    const logger = { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() };

    registerAnalysisHistoryIpc({
      ipcMain,
      IPC_CHANNELS,
      logger,
      getServiceIntegration: () => serviceIntegration
    });

    return { IPC_CHANNELS };
  }

  test('GET supports all=true with safety cap and offset slicing', async () => {
    const service = {
      getStatistics: jest.fn(async () => ({})),
      searchAnalysis: jest.fn(async () => []),
      getAnalysisByPath: jest.fn(async () => null),
      getRecentAnalysis: jest.fn(async () => [1, 2, 3, 4, 5]),
      clear: jest.fn(async () => ({})),
      createDefaultStructures: jest.fn(async () => ({}))
    };

    const { IPC_CHANNELS } = registerWith({
      analysisHistory: service,
      container: { resolve: jest.fn() }
    });
    const handler = ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.GET);

    const result = await handler(null, { all: true, offset: 2 });
    expect(result).toEqual([3, 4, 5]);
    expect(service.getRecentAnalysis).toHaveBeenCalledWith(50000);
  });

  test('EXPORT csv uses RFC 4180 quoting and neutralizes formula-leading cells', async () => {
    const timestamp = Date.UTC(2026, 0, 2, 3, 4, 5);
    const service = {
      getRecentAnalysis: jest.fn(async () => [
        {
          fileName: "=cmd|'/c calc'!A1.pdf",
          originalPath: 'C:\\dl\\evil.pdf',
          analysis: { category: '@SUM(1)', confidence: 0.9, keywords: ['a', 'b'], subject: 'a"b' },
          timestamp
        }
      ])
    };

    const { IPC_CHANNELS } = registerWith({
      analysisHistory: service,
      container: { resolve: jest.fn() }
    });
    const handler = ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.EXPORT);
    // The global memfs mock is re-instantiated by resetModules(); use the same
    // instance the handler sees.
    const fs = require('fs');
    const tmpDir = path.join(os.tmpdir(), 'stratosort-csv-export');
    fs.mkdirSync(tmpDir, { recursive: true });
    const filePath = path.join(tmpDir, 'history.csv');
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath });

    try {
      const result = await handler(null, 'csv');
      expect(result).toEqual({ success: true, filePath });
      const lines = fs.readFileSync(filePath, 'utf8').split('\n');
      expect(lines[0]).toBe('fileName,originalPath,category,confidence,keywords,subject,timestamp');
      expect(lines[1]).toBe(
        `"'=cmd|'/c calc'!A1.pdf",C:\\dl\\evil.pdf,"'@SUM(1)",0.9,a; b,"a""b",2026-01-02T03:04:05.000Z`
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  test('SET_EMBEDDING_POLICY validates payload and calls service', async () => {
    const service = {
      setEmbeddingPolicyByPath: jest.fn(async () => ({ updated: 1 }))
    };

    const { IPC_CHANNELS } = registerWith({
      analysisHistory: service,
      container: { resolve: jest.fn() }
    });
    const handler = ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.SET_EMBEDDING_POLICY);

    // Validation returns structured error response with Zod details
    const emptyPathResult = await handler(null, { filePath: '', policy: 'embed' });
    expect(emptyPathResult.success).toBe(false);

    const invalidPolicyResult = await handler(null, { filePath: 'C:\\x\\a.pdf', policy: 'nope' });
    expect(invalidPolicyResult.success).toBe(false);

    await expect(handler(null, { filePath: 'C:\\x\\a.pdf', policy: 'skip' })).resolves.toEqual(
      expect.objectContaining({ success: true, updated: 1 })
    );
    expect(service.setEmbeddingPolicyByPath).toHaveBeenCalledWith('C:\\x\\a.pdf', 'skip');
  });

  test('CLEAR marks embeddings orphaned via OramaVectorService when available', async () => {
    const filePath = 'C:\\docs\\a.pdf';
    const oramaService = {
      markEmbeddingsOrphaned: jest.fn(async () => undefined)
    };

    const service = {
      initialize: jest.fn(async () => undefined),
      analysisHistory: {
        entries: {
          e1: { originalPath: filePath }
        }
      },
      createDefaultStructures: jest.fn(async () => ({}))
    };

    const { IPC_CHANNELS } = registerWith({
      analysisHistory: service,
      container: {
        resolve: jest.fn(() => oramaService)
      }
    });
    const handler = ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.CLEAR);

    const res = await handler(null);
    expect(res).toEqual(expect.objectContaining({ success: true }));
    expect(service.initialize).toHaveBeenCalled();
    expect(oramaService.markEmbeddingsOrphaned).toHaveBeenCalledWith([getSemanticFileId(filePath)]);
    expect(service.createDefaultStructures).toHaveBeenCalled();
  });

  // Re-mock the tracker for this describe block. The top-level mock IS active,
  // but `jest.resetModules()` in beforeEach can re-evaluate the import on the
  // SUT side; the mockTracker reference stays stable across resets so these
  // assertions still see the same jest.fn() spies.
  describe('degraded-state flag', () => {
    test('GET raises analysis-history.unavailable when service throws', async () => {
      const service = {
        getRecentAnalysis: jest.fn(async () => {
          throw new Error('service init race');
        })
      };

      const { IPC_CHANNELS } = registerWith({
        analysisHistory: service,
        container: { resolve: jest.fn() }
      });
      const handler = ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.GET);

      const result = await handler(null, {});

      // Existing behaviour preserved: still returns an empty array.
      expect(result).toEqual([]);
      // New behaviour: raised the flag with the agreed code/severity so the
      // DegradedStateBanner surfaces "history unavailable" instead of an
      // empty list. severity:error reflects the user impact (driving wasted
      // re-analysis) rather than mere log spam.
      expect(mockTracker.raise).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'analysis-history.unavailable',
          subsystem: 'analysis-history',
          severity: 'error',
          message: expect.stringMatching(/history.*unavailable/i)
        })
      );
    });

    test('GET clears the flag on the next successful read', async () => {
      const service = {
        getRecentAnalysis: jest.fn(async () => [{ path: '/a.pdf' }])
      };

      const { IPC_CHANNELS } = registerWith({
        analysisHistory: service,
        container: { resolve: jest.fn() }
      });
      const handler = ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.GET);

      await handler(null, {});

      // Without clear(), once the flag was raised the banner would stick
      // around indefinitely even after the subsystem recovered.
      expect(mockTracker.clear).toHaveBeenCalledWith('analysis-history.unavailable');
      expect(mockTracker.raise).not.toHaveBeenCalled();
    });

    test('GET_STATISTICS, SEARCH and GET_FILE_HISTORY all share one flag code', async () => {
      // Single stable code across handlers so the banner shows ONE entry
      // rather than flickering between four different codes when several
      // panels poll simultaneously during a service-init race.
      const failingService = {
        getStatistics: jest.fn(async () => {
          throw new Error('boom');
        }),
        searchAnalysis: jest.fn(async () => {
          throw new Error('boom');
        }),
        getAnalysisByPath: jest.fn(async () => {
          throw new Error('boom');
        })
      };

      const { IPC_CHANNELS } = registerWith({
        analysisHistory: failingService,
        container: { resolve: jest.fn() }
      });

      await ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.GET_STATISTICS)(null);
      await ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.SEARCH)(null, '');
      await ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.GET_FILE_HISTORY)(null, '/foo.pdf');

      const codes = mockTracker.raise.mock.calls.map((c) => c[0].code);
      expect(codes).toEqual([
        'analysis-history.unavailable',
        'analysis-history.unavailable',
        'analysis-history.unavailable'
      ]);
    });
  });
});
