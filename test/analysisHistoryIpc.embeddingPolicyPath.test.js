/**
 * SET_EMBEDDING_POLICY must hand the service the exact path it received and
 * report a miss. The service matches entries by exact string, so a normalized
 * path (double space collapsed, long path cut) never matches, and replying
 * success for a miss made the renderer show a policy that was never stored.
 */
const { ipcMain } = require('./mocks/electron');

jest.mock('../src/main/services/DegradedStateTracker', () => ({
  getInstance: () => ({ raise: jest.fn(), clear: jest.fn() })
}));

describe('AnalysisHistory IPC SET_EMBEDDING_POLICY path handling', () => {
  beforeEach(() => {
    ipcMain._handlers.clear();
    ipcMain.handle.mockClear();
    jest.resetModules();
  });

  function register(service) {
    const registerAnalysisHistoryIpc = require('../src/main/ipc/analysisHistory');
    const { IPC_CHANNELS } = require('../src/shared/constants');
    const logger = { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() };
    registerAnalysisHistoryIpc({
      ipcMain,
      IPC_CHANNELS,
      logger,
      getServiceIntegration: () => ({
        analysisHistory: service,
        container: { resolve: jest.fn() }
      })
    });
    return ipcMain._handlers.get(IPC_CHANNELS.ANALYSIS_HISTORY.SET_EMBEDDING_POLICY);
  }

  test('passes a path with repeated spaces through unchanged', async () => {
    const service = { setEmbeddingPolicyByPath: jest.fn(async () => ({ updated: 1 })) };
    const handler = register(service);
    const filePath = 'C:\\Docs\\Invoice  2024.pdf';

    const result = await handler(null, { filePath, policy: 'skip' });

    expect(service.setEmbeddingPolicyByPath).toHaveBeenCalledWith(filePath, 'skip');
    expect(result).toEqual(expect.objectContaining({ success: true, updated: 1 }));
  });

  test('does not cut a path longer than 2000 characters', async () => {
    const service = { setEmbeddingPolicyByPath: jest.fn(async () => ({ updated: 1 })) };
    const handler = register(service);
    const filePath = `/data/${'a'.repeat(2100)}/file.pdf`;

    await handler(null, { filePath, policy: 'embed' });

    expect(service.setEmbeddingPolicyByPath).toHaveBeenCalledWith(filePath, 'embed');
  });

  test('reports failure when no history entry matched', async () => {
    const service = {
      setEmbeddingPolicyByPath: jest.fn(async () => ({ updated: 0, notFound: 1 }))
    };
    const handler = register(service);

    const result = await handler(null, { filePath: 'C:\\Docs\\missing.pdf', policy: 'skip' });

    expect(result.success).toBe(false);
    expect(result.notFound).toBe(true);
    expect(result.updated).toBe(0);
    expect(typeof result.error).toBe('string');
  });
});
