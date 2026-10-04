jest.mock('electron', () => jest.requireActual('./mocks/electron'));

const { ipcMain } = require('electron');

describe('AnalysisHistory IPC', () => {
  beforeEach(() => {
    ipcMain._handlers.clear();
    ipcMain.handle.mockClear();
    jest.resetModules();
  });

  test('GET/SEARCH/GET_STATISTICS/EXPORT are wired', async () => {
    const registerAnalysisHistoryIpc = require('../src/main/ipc/analysisHistory');
    const { IPC_CHANNELS } = require('../src/shared/constants');
    const logger = { error: jest.fn(), info: jest.fn(), warn: jest.fn() };
    const service = {
      getStatistics: jest.fn(async () => ({ total: 0 })),
      searchAnalysis: jest.fn(async () => []),
      getAnalysisByPath: jest.fn(async () => []),
      getRecentAnalysis: jest.fn(async () => []),
      clear: jest.fn(async () => ({})),
      createDefaultStructures: jest.fn(async () => ({}))
    };

    registerAnalysisHistoryIpc({
      ipcMain,
      IPC_CHANNELS,
      logger,
      getServiceIntegration: () => ({ analysisHistory: service })
    });

    const mockEvent = null;

    const hGet = ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.GET);
    expect(Array.isArray(await hGet(mockEvent, {}))).toBe(true);

    const hSearch = ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.SEARCH);
    const searchResult = await hSearch(mockEvent, 'term', {});
    expect(Array.isArray(searchResult)).toBe(true);

    const hStats = ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.GET_STATISTICS);
    expect((await hStats(mockEvent)).total).toBe(0);

    const hExport = ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.EXPORT);
    // EXPORT uses dialog.showSaveDialog; default mock returns canceled/filePath empty,
    // so we expect canceled response. Handler is wired correctly.
    const exportResult = await hExport(mockEvent, 'json');
    expect(exportResult).toMatchObject({ success: false, canceled: true });
  });
});
