/**
 * Tests for ModelMemoryManager.registerExternalConsumer / unregister.
 *
 * The hooks let services that aren't owned by LlamaService (e.g.
 * WhisperService) declare VRAM usage and provide a dispose callback so
 * the manager can include them in budget math and evict them under
 * memory pressure.
 */

jest.mock('os', () => ({
  totalmem: jest.fn(() => 16 * 1024 * 1024 * 1024),
  freemem: jest.fn(() => 8 * 1024 * 1024 * 1024)
}));

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const { ModelMemoryManager } = require('../src/main/services/ModelMemoryManager');

function makeLlamaShim() {
  return {
    _models: { text: null, vision: null, embedding: null },
    _contexts: { text: null, vision: null, embedding: null },
    _loadModel: jest.fn()
  };
}

describe('ModelMemoryManager — registerExternalConsumer', () => {
  test('registers an external consumer and reflects in current usage', () => {
    const manager = new ModelMemoryManager(makeLlamaShim());
    const beforeUsage = manager._currentMemoryUsage;
    const dispose = jest.fn();

    const ok = manager.registerExternalConsumer({
      type: 'audio',
      sizeBytes: 200 * 1024 * 1024,
      dispose,
      label: 'whisper:ggml-base.en.bin'
    });

    expect(ok).toBe(true);
    expect(manager._loadedModels.has('audio')).toBe(true);
    expect(manager._currentMemoryUsage).toBe(beforeUsage + 200 * 1024 * 1024);
    expect(manager._modelSizeEstimates.audio).toBe(200 * 1024 * 1024);
    const status = manager.getMemoryStatus();
    expect(status.loadedModels).toContain('audio');
  });

  test('rejects collision with built-in LlamaService types', () => {
    const manager = new ModelMemoryManager(makeLlamaShim());
    for (const reserved of ['text', 'vision', 'embedding']) {
      expect(() =>
        manager.registerExternalConsumer({
          type: reserved,
          sizeBytes: 100,
          dispose: jest.fn()
        })
      ).toThrow(/reserved for LlamaService/);
    }
  });

  test('rejects malformed inputs', () => {
    const manager = new ModelMemoryManager(makeLlamaShim());
    expect(() => manager.registerExternalConsumer({})).toThrow(/non-empty type/);
    expect(() =>
      manager.registerExternalConsumer({ type: 'audio', sizeBytes: -1, dispose: jest.fn() })
    ).toThrow(/non-negative sizeBytes/);
    expect(() => manager.registerExternalConsumer({ type: 'audio', sizeBytes: 100 })).toThrow(
      /dispose function/
    );
  });

  test('duplicate registration is a no-op (returns false)', () => {
    const manager = new ModelMemoryManager(makeLlamaShim());
    const dispose = jest.fn();
    const first = manager.registerExternalConsumer({
      type: 'audio',
      sizeBytes: 100,
      dispose
    });
    const second = manager.registerExternalConsumer({
      type: 'audio',
      sizeBytes: 999, // ignored
      dispose: jest.fn()
    });
    expect(first).toBe(true);
    expect(second).toBe(false);
    // Original size should be preserved
    expect(manager._loadedModels.get('audio').sizeBytes).toBe(100);
  });
});

describe('ModelMemoryManager — unregisterExternalConsumer', () => {
  test('unregister releases the slot and decrements usage', () => {
    const manager = new ModelMemoryManager(makeLlamaShim());
    manager.registerExternalConsumer({
      type: 'audio',
      sizeBytes: 150 * 1024 * 1024,
      dispose: jest.fn()
    });
    const usageBefore = manager._currentMemoryUsage;

    const removed = manager.unregisterExternalConsumer('audio');

    expect(removed).toBe(true);
    expect(manager._loadedModels.has('audio')).toBe(false);
    expect(manager._currentMemoryUsage).toBe(usageBefore - 150 * 1024 * 1024);
  });

  test('unregister returns false when no entry exists', () => {
    const manager = new ModelMemoryManager(makeLlamaShim());
    expect(manager.unregisterExternalConsumer('audio')).toBe(false);
  });

  test('unregister refuses to remove built-in (non-external) entries', () => {
    const manager = new ModelMemoryManager(makeLlamaShim());
    // Pretend a text model is loaded the normal way.
    manager._loadedModels.set('text', {
      context: {},
      lastUsed: Date.now(),
      sizeBytes: 1024
    });
    expect(manager.unregisterExternalConsumer('text')).toBe(false);
    expect(manager._loadedModels.has('text')).toBe(true);
  });
});

describe('ModelMemoryManager — eviction routes through external dispose', () => {
  test('_unloadModel calls the per-entry dispose for external consumers', async () => {
    const manager = new ModelMemoryManager(makeLlamaShim());
    const dispose = jest.fn().mockResolvedValue(undefined);
    manager.registerExternalConsumer({
      type: 'audio',
      sizeBytes: 100,
      dispose
    });

    await manager._unloadModel('audio');

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(manager._loadedModels.has('audio')).toBe(false);
  });

  test('memory pressure evicts the LRU external consumer before loading new model', async () => {
    const llamaService = makeLlamaShim();
    const manager = new ModelMemoryManager(llamaService);
    // Tight budget: enough for one consumer or one embedding, not both.
    const audioSize = 200 * 1024 * 1024;
    manager._maxMemoryUsage = manager._modelSizeEstimates.embedding + audioSize - 1;

    const audioDispose = jest.fn().mockResolvedValue(undefined);
    manager.registerExternalConsumer({
      type: 'audio',
      sizeBytes: audioSize,
      dispose: audioDispose
    });

    // _refreshMemoryBudget recomputes from os.freemem; freeze it so the
    // tight budget we set above survives the call.
    jest.spyOn(manager, '_refreshMemoryBudget').mockImplementation(() => {});

    const context = {};
    llamaService._loadModel.mockResolvedValue(context);
    llamaService._models.embedding = context;

    await manager.ensureModelLoaded('embedding');

    // Audio consumer should have been evicted to make room.
    expect(audioDispose).toHaveBeenCalledTimes(1);
    expect(manager._loadedModels.has('audio')).toBe(false);
    expect(manager._loadedModels.has('embedding')).toBe(true);
  });
});

describe('ModelMemoryManager — canFitExternalLoad (vision runtime budget, ML-01)', () => {
  const GiB = 1024 * 1024 * 1024;

  function managerWithResidentText({ budgetBytes }) {
    const llamaService = makeLlamaShim();
    const manager = new ModelMemoryManager(llamaService);
    manager._maxMemoryUsage = budgetBytes;
    jest.spyOn(manager, '_refreshMemoryBudget').mockImplementation(() => {});
    manager._loadedModels.set('text', {
      context: {},
      lastUsed: Date.now(),
      sizeBytes: manager._modelSizeEstimates.text
    });
    manager._currentMemoryUsage = manager._modelSizeEstimates.text;
    return manager;
  }

  test('refuses a vision runtime that does not fit beside a resident text model', () => {
    const manager = managerWithResidentText({ budgetBytes: 7 * GiB });
    expect(manager.canFitExternalLoad(5 * GiB)).toBe(false);
  });

  test('allows it when the budget holds both', () => {
    const manager = managerWithResidentText({ budgetBytes: 16 * GiB });
    expect(manager.canFitExternalLoad(5 * GiB)).toBe(true);
  });

  test('with nothing resident an oversized single estimate is allowed through', () => {
    const manager = new ModelMemoryManager(makeLlamaShim());
    manager._maxMemoryUsage = 3 * GiB;
    jest.spyOn(manager, '_refreshMemoryBudget').mockImplementation(() => {});
    expect(manager.canFitExternalLoad(5 * GiB)).toBe(true);
  });

  test('excludeType leaves a registration about to be replaced out of the sum', () => {
    const manager = managerWithResidentText({ budgetBytes: 10 * GiB });
    manager.registerExternalConsumer({
      type: 'vision-runtime',
      sizeBytes: 5 * GiB,
      dispose: jest.fn()
    });
    // text 4 + runtime 5 = 9 resident; a respawn of the same runtime adds nothing.
    expect(manager.canFitExternalLoad(5 * GiB)).toBe(false);
    expect(manager.canFitExternalLoad(5 * GiB, { excludeType: 'vision-runtime' })).toBe(true);
  });

  test('makeRoomForExternalLoad evicts an idle whisper model so the vision runtime can spawn', async () => {
    // 8 GB machine: budget 4 GiB, vision estimate 6 GiB, whisper's 190 MB
    // left over from a voice memo an hour ago. canFitExternalLoad alone said
    // no; with nothing resident an oversized single estimate is allowed.
    const manager = new ModelMemoryManager(makeLlamaShim());
    manager._maxMemoryUsage = 4 * GiB;
    jest.spyOn(manager, '_refreshMemoryBudget').mockImplementation(() => {});
    const dispose = jest.fn().mockResolvedValue(undefined);
    manager.registerExternalConsumer({ type: 'audio', sizeBytes: 190 * 1024 * 1024, dispose });
    expect(manager.canFitExternalLoad(6 * GiB, { excludeType: 'vision-runtime' })).toBe(false);

    await expect(
      manager.makeRoomForExternalLoad(6 * GiB, { excludeType: 'vision-runtime' })
    ).resolves.toBe(true);

    expect(dispose).toHaveBeenCalledTimes(1);
    expect(manager._loadedModels.has('audio')).toBe(false);
  });

  test('makeRoomForExternalLoad leaves pinned residents alone and answers no', async () => {
    const manager = new ModelMemoryManager(makeLlamaShim());
    manager._maxMemoryUsage = 4 * GiB;
    jest.spyOn(manager, '_refreshMemoryBudget').mockImplementation(() => {});
    jest.spyOn(manager, 'unloadModel').mockResolvedValue(false);
    const dispose = jest.fn().mockResolvedValue(undefined);
    manager.registerExternalConsumer({ type: 'audio', sizeBytes: 190 * 1024 * 1024, dispose });
    manager.acquireRef('audio'); // a transcription is running

    await expect(manager.makeRoomForExternalLoad(6 * GiB)).resolves.toBe(false);

    expect(manager.unloadModel).not.toHaveBeenCalled();
    expect(manager._loadedModels.has('audio')).toBe(true);
  });

  test('text + vision runtime + embedding: the third load is refused when pinned residents exceed the budget', async () => {
    const llamaService = makeLlamaShim();
    const manager = new ModelMemoryManager(llamaService);
    manager._maxMemoryUsage = 9 * GiB;
    jest.spyOn(manager, '_refreshMemoryBudget').mockImplementation(() => {});
    manager._loadedModels.set('text', { context: {}, lastUsed: 1, sizeBytes: 4 * GiB });
    manager._currentMemoryUsage = 4 * GiB;
    manager.acquireRef('text');
    const dispose = jest.fn().mockResolvedValue(undefined);
    manager.registerExternalConsumer({ type: 'vision-runtime', sizeBytes: 5 * GiB, dispose });
    manager.acquireRef('vision-runtime');
    manager._modelSizeEstimates.embedding = 1 * GiB;

    await expect(manager.ensureModelLoaded('embedding')).rejects.toMatchObject({
      code: 'MODEL_MEMORY_BUDGET_EXCEEDED'
    });
    // Pinned residents are never evicted to make room.
    expect(dispose).not.toHaveBeenCalled();
    expect(llamaService._loadModel).not.toHaveBeenCalled();
  }, 20000);
});

describe('ModelMemoryManager — recorded size follows the refined estimate (ML-03)', () => {
  test('a load that refines its estimate is recorded at the refined size', async () => {
    const llamaService = makeLlamaShim();
    const manager = new ModelMemoryManager(llamaService);
    jest.spyOn(manager, '_refreshMemoryBudget').mockImplementation(() => {});
    manager._maxMemoryUsage = 64 * 1024 * 1024 * 1024;
    const fileSize = 4.8 * 1024 * 1024 * 1024;
    llamaService._loadModel.mockImplementation(async (type) => {
      manager.updateModelSizeEstimate(type, fileSize);
      return {};
    });

    await manager.ensureModelLoaded('text');

    const expected = Math.ceil(fileSize * 1.3);
    expect(manager._loadedModels.get('text').sizeBytes).toBe(expected);
    expect(manager._currentMemoryUsage).toBe(expected);
  });
});
