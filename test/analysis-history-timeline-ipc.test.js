jest.mock('electron', () => jest.requireActual('./mocks/electron'));

const { ipcMain } = require('electron');

function register(serviceOverrides = {}) {
  const registerAnalysisHistoryIpc = require('../src/main/ipc/analysisHistory');
  const { IPC_CHANNELS } = require('../src/shared/constants');
  const logger = { error: jest.fn(), info: jest.fn(), warn: jest.fn() };
  const service = {
    getStatistics: jest.fn(async () => ({})),
    searchAnalysis: jest.fn(async () => []),
    getAnalysisByPath: jest.fn(async () => null),
    getRecentAnalysis: jest.fn(async () => []),
    getTimelineItems: jest.fn(async () => ({ items: [], total: 0, hasMore: false })),
    clear: jest.fn(async () => ({})),
    createDefaultStructures: jest.fn(async () => ({})),
    ...serviceOverrides
  };
  registerAnalysisHistoryIpc({
    ipcMain,
    IPC_CHANNELS,
    logger,
    getServiceIntegration: () => ({ analysisHistory: service })
  });
  return { IPC_CHANNELS, service, logger };
}

describe('AnalysisHistory timeline IPC', () => {
  beforeEach(() => {
    ipcMain._handlers.clear();
    ipcMain.handle.mockClear();
    jest.resetModules();
  });

  test('GET_TIMELINE delegates to service.getTimelineItems and returns its page', async () => {
    const page = { items: [{ id: 'a' }], total: 1, hasMore: false };
    const { IPC_CHANNELS, service } = register({
      getTimelineItems: jest.fn(async () => page)
    });
    const handler = ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.GET_TIMELINE);
    const result = await handler(null, { limit: 100, offset: 0 });
    expect(service.getTimelineItems).toHaveBeenCalledWith({ limit: 100, offset: 0 });
    expect(result).toEqual(page);
  });

  test('GET_TIMELINE returns empty page on service error', async () => {
    const { IPC_CHANNELS, logger } = register({
      getTimelineItems: jest.fn(async () => {
        throw new Error('boom');
      })
    });
    const handler = ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.GET_TIMELINE);
    const result = await handler(null, {});
    expect(result).toEqual({ items: [], total: 0, hasMore: false });
    expect(logger.error).toHaveBeenCalled();
  });
});

describe('AnalysisHistory uncategorized IPC', () => {
  beforeEach(() => {
    ipcMain._handlers.clear();
    ipcMain.handle.mockClear();
    jest.resetModules();
  });

  test('GET_UNCATEGORIZED returns the service items', async () => {
    const items = [{ path: '/a.pdf', name: 'a.pdf', analysis: { category: 'Uncategorized' } }];
    const { IPC_CHANNELS, service } = register({
      getUncategorizedItems: jest.fn(async () => items)
    });
    const handler = ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.GET_UNCATEGORIZED);
    expect(await handler(null, { limit: 50 })).toEqual({ items });
    expect(service.getUncategorizedItems).toHaveBeenCalledWith({ limit: 50 });
  });

  test('GET_UNCATEGORIZED returns no items on service error', async () => {
    const { IPC_CHANNELS } = register({
      getUncategorizedItems: jest.fn(async () => {
        throw new Error('boom');
      })
    });
    const handler = ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.GET_UNCATEGORIZED);
    expect(await handler(null, {})).toEqual({ items: [] });
  });
});
