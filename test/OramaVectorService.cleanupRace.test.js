/**
 * Quitting while a save is running must not cut that save short.
 *
 * A background save is running, a rebuild's persistAll() waits for it, and
 * cleanup() starts. When the background save ends, persistAll starts its own
 * full save first; cleanup's final rounds used to hit "A save is already
 * running" three times in a row and then clear the in-memory collections
 * while persistAll's save was still writing them (a TypeError in that save,
 * collections not written).
 */

const path = require('path');

const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.mock('electron', () => ({ app: { getPath: jest.fn() } }));
jest.mock('../src/shared/logger', () => ({ createLogger: () => mockLogger, logger: mockLogger }));
jest.mock('../src/shared/singletonFactory', () => ({
  createSingletonHelpers: () => ({
    getInstance: jest.fn(),
    createInstance: jest.fn(),
    registerWithContainer: jest.fn(),
    resetInstance: jest.fn()
  })
}));
jest.mock('../src/main/llamaUtils', () => ({
  getEmbeddingModel: jest.fn(() => 'nomic-embed-text-v1.5-Q8_0.gguf'),
  loadLlamaConfig: jest.fn().mockResolvedValue({
    selectedEmbeddingModel: 'nomic-embed-text-v1.5-Q8_0.gguf'
  })
}));

const { app } = require('electron');
const { OramaVectorService } = require('../src/main/services/OramaVectorService');

const TEMP_DIR = path.join(__dirname, 'temp-orama-cleanup-race');

describe('OramaVectorService cleanup during a save', () => {
  afterAll(async () => {
    await require('fs')
      .promises.rm(TEMP_DIR, { recursive: true, force: true })
      .catch(() => {});
  });

  test('a persistAll that starts its save while cleanup waits finishes it intact', async () => {
    app.getPath.mockReturnValue(TEMP_DIR);
    const service = new OramaVectorService();
    await service.initialize();
    await service.upsertFile({
      id: 'file:a',
      vector: new Array(768).fill(0.1),
      meta: { path: '/x/a.txt' }
    });
    // Let the save the first write may have started finish.
    await service.persistAll();

    // A background save is running (as the debounce timer starts it).
    service._persistPending = true;
    service._currentPersistPromise = service._doPersist();
    // A rebuild asks for persistAll while it runs: it waits in its loop.
    const all = service.persistAll();
    // Quit arrives now.
    const quit = service.cleanup();
    const [allResult] = await Promise.all([all, quit]);

    expect(allResult).toEqual({ success: true });
    expect(mockLogger.error).not.toHaveBeenCalledWith(
      expect.stringContaining('Final persist did not stabilize')
    );
  });
});
