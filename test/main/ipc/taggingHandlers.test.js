'use strict';

// Capture the handler that registerTaggingHandlers wires up. Mocking ipcWrappers
// lets us invoke the handler body directly (schema validation is covered
// separately by verify:ipc-handler-schemas).
const mockHandlers = new Map();
jest.mock('../../../src/main/ipc/ipcWrappers', () => ({
  createHandler: jest.fn(({ handler }) => handler),
  safeHandle: jest.fn((_ipcMain, channel, handler) => {
    mockHandlers.set(channel, handler);
  })
}));

const { registerTaggingHandlers } = require('../../../src/main/ipc/files/taggingHandlers');
const { IPC_CHANNELS } = require('../../../src/shared/constants');
const { logger } = require('../../../src/shared/logger');

function buildContainer({ orama, analysisHistory, integration } = {}) {
  const resolvedOrama = orama || {
    getDocument: jest.fn(),
    updateDocumentTags: jest.fn().mockResolvedValue()
  };
  const resolvedHistory = analysisHistory || { updateTags: jest.fn().mockResolvedValue() };
  const activeContainer = { resolve: jest.fn(() => resolvedOrama) };
  return {
    container: {
      core: { ipcMain: {} },
      getServiceIntegration: () =>
        integration === null
          ? null
          : { container: activeContainer, analysisHistory: resolvedHistory }
    },
    orama: resolvedOrama,
    analysisHistory: resolvedHistory
  };
}

function getHandler(container) {
  mockHandlers.clear();
  registerTaggingHandlers(container);
  return mockHandlers.get(IPC_CHANNELS.FILES.ADD_TAGS);
}

const event = {};

describe('taggingHandlers', () => {
  afterEach(() => jest.clearAllMocks());

  test('merges unique tags into Orama and analysis history, reports updated count', async () => {
    const { container, orama, analysisHistory } = buildContainer();
    orama.getDocument
      .mockResolvedValueOnce({ filePath: '/docs/a.pdf', tags: ['old'] })
      .mockResolvedValueOnce({ filePath: '/docs/b.pdf', tags: ['keep'] });

    const handler = getHandler(container);
    const result = await handler(event, ['id-a', 'id-b'], ['old', 'new']);

    expect(result).toEqual({ success: true, updated: 2, errors: undefined });
    // id-a already carries 'old', so the merge de-duplicates it rather than appending twice
    expect(orama.updateDocumentTags).toHaveBeenCalledWith('id-a', ['old', 'new']);
    // id-b keeps its existing tag and gains the full input set
    expect(orama.updateDocumentTags).toHaveBeenCalledWith('id-b', ['keep', 'old', 'new']);
    expect(analysisHistory.updateTags).toHaveBeenCalledWith('/docs/a.pdf', ['old', 'new']);
  });

  test('records an error entry for a document that is not found', async () => {
    const { container, orama, analysisHistory } = buildContainer();
    orama.getDocument.mockResolvedValueOnce(null);

    const handler = getHandler(container);
    const result = await handler(event, ['missing'], ['tag']);

    expect(result.success).toBe(false);
    expect(result.updated).toBe(0);
    expect(result.errors).toEqual([{ id: 'missing', error: 'Document not found' }]);
    expect(analysisHistory.updateTags).not.toHaveBeenCalled();
  });

  test('warns but still counts success when a document has no filePath', async () => {
    const warnSpy = jest.spyOn(logger, 'warn').mockImplementation(() => {});
    const { container, orama, analysisHistory } = buildContainer();
    orama.getDocument.mockResolvedValueOnce({ tags: [] });

    const handler = getHandler(container);
    const result = await handler(event, ['no-path'], ['tag']);

    expect(result).toEqual({ success: true, updated: 1, errors: undefined });
    expect(analysisHistory.updateTags).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalled();
  });

  test('captures per-document failures without aborting the batch', async () => {
    const { container, orama } = buildContainer();
    orama.getDocument
      .mockRejectedValueOnce(new Error('orama down'))
      .mockResolvedValueOnce({ filePath: '/docs/ok.pdf', tags: [] });

    const handler = getHandler(container);
    const result = await handler(event, ['boom', 'ok'], ['tag']);

    expect(result.success).toBe(true);
    expect(result.updated).toBe(1);
    expect(result.errors).toEqual([{ id: 'boom', error: 'orama down' }]);
  });

  test('throws when the service integration is unavailable', async () => {
    const { container } = buildContainer({ integration: null });
    const handler = getHandler(container);
    await expect(handler(event, ['id'], ['tag'])).rejects.toThrow('Services not available');
  });
});
