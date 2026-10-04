jest.mock('../src/main/analysis/embeddingQueue/stageQueues', () => {
  const analysisQueue = {
    updateByFilePath: jest.fn(() => 1),
    updateByFilePaths: jest.fn(() => 2),
    removeByFilePath: jest.fn(() => 1),
    removeByFilePaths: jest.fn(() => 2),
    getStats: jest.fn(() => ({ size: 1, capacityPercent: 40 })),
    forceFlush: jest.fn().mockResolvedValue('ok'),
    shutdown: jest.fn().mockResolvedValue('ok'),
    initialize: jest.fn().mockResolvedValue(undefined)
  };
  const organizeQueue = {
    updateByFilePath: jest.fn(() => 3),
    updateByFilePaths: jest.fn(() => 4),
    removeByFilePath: jest.fn(() => 3),
    removeByFilePaths: jest.fn(() => 2),
    getStats: jest.fn(() => ({ size: 2, capacityPercent: 30 })),
    forceFlush: jest.fn().mockResolvedValue('ok'),
    shutdown: jest.fn().mockResolvedValue('ok'),
    initialize: jest.fn().mockResolvedValue(undefined)
  };
  return { analysisQueue, organizeQueue };
});

const manager = require('../src/main/analysis/embeddingQueue/queueManager');

describe('embeddingQueueManager', () => {
  // F-190 (CP-10): each staged queue restores its persisted items (and
  // schedules a flush) inside initialize(), but nothing called it until the
  // first enqueue() of the process. The manager exposes one startup drain.
  describe('initialize (startup drain of persisted queues)', () => {
    const {
      analysisQueue,
      organizeQueue
    } = require('../src/main/analysis/embeddingQueue/stageQueues');

    afterEach(() => {
      analysisQueue.initialize.mockReset().mockResolvedValue(undefined);
      organizeQueue.initialize.mockReset().mockResolvedValue(undefined);
    });

    test('restores every staged queue', async () => {
      await manager.initialize();
      expect(analysisQueue.initialize).toHaveBeenCalledTimes(1);
      expect(organizeQueue.initialize).toHaveBeenCalledTimes(1);
    });

    test('one queue failing to restore does not stop the other, and does not throw', async () => {
      analysisQueue.initialize.mockRejectedValueOnce(new Error('disk gone'));
      const results = await manager.initialize();
      expect(organizeQueue.initialize).toHaveBeenCalledTimes(1);
      expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);
    });
  });

  test('updateByFilePath sums queue results', () => {
    const total = manager.updateByFilePath('a', 'b');
    expect(total).toBe(4);
  });

  test('updateByFilePaths sums queue results', () => {
    const total = manager.updateByFilePaths([{ old: 'a', new: 'b' }]);
    expect(total).toBe(6);
  });

  test('removeByFilePath sums queue results', () => {
    const total = manager.removeByFilePath('/path/file.pdf');
    expect(total).toBe(4);
  });

  test('removeByFilePaths sums queue results', () => {
    const total = manager.removeByFilePaths(['/a.pdf', '/b.pdf']);
    expect(total).toBe(4);
  });

  test('getStats returns both queues', () => {
    const stats = manager.getStats();
    expect(stats.analysis.size).toBe(1);
    expect(stats.organize.size).toBe(2);
  });

  test('forceFlush resolves when all succeed', async () => {
    const result = await manager.forceFlush();
    expect(result).toHaveLength(2);
  });

  test('waitForAnalysisQueueCapacity returns when under highWatermark', async () => {
    const result = await manager.waitForAnalysisQueueCapacity({ highWatermarkPercent: 75 });
    expect(result.waited).toBe(false);
    expect(result.capacityPercent).toBe(40);
  });

  test('waitForOrganizeQueueCapacity returns when under highWatermark', async () => {
    const result = await manager.waitForOrganizeQueueCapacity({ highWatermarkPercent: 75 });
    expect(result.waited).toBe(false);
  });
});
