jest.mock('electron', () => jest.requireActual('./mocks/electron'));
jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});

jest.mock('../src/main/services/ServiceContainer', () => ({
  container: {
    has: jest.fn(() => false),
    resolve: jest.fn()
  },
  ServiceIds: {
    RELATIONSHIP_INDEX: 'relationshipIndex'
  }
}));

const { ipcMain } = jest.requireActual('./mocks/electron');

describe('Knowledge IPC', () => {
  beforeEach(() => {
    ipcMain._handlers.clear();
    ipcMain.handle.mockClear();
    jest.resetModules();
  });

  test('GET_RELATIONSHIP_STATS returns index stats', async () => {
    const { IpcServiceContext } = require('../src/main/ipc/IpcServiceContext');
    const registerKnowledgeIpc = require('../src/main/ipc/knowledge');
    const { IPC_CHANNELS } = require('../src/shared/constants');
    const { logger } = require('../src/shared/logger');

    const mockRelationshipIndex = {
      getStats: jest.fn().mockResolvedValue({
        success: true,
        edgeCount: 3,
        conceptCount: 5
      })
    };

    const context = new IpcServiceContext()
      .setCore({ ipcMain, IPC_CHANNELS, logger })
      .setServiceIntegration(() => ({ relationshipIndex: mockRelationshipIndex }));

    registerKnowledgeIpc(context);

    const handler = ipcMain._handlers.get(IPC_CHANNELS.KNOWLEDGE.GET_RELATIONSHIP_STATS);
    const result = await handler();

    expect(mockRelationshipIndex.getStats).toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(result.edgeCount).toBe(3);
  });
});
