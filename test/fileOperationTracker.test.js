jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const mockFs = {
  readFile: jest.fn(),
  writeFile: jest.fn().mockResolvedValue(),
  mkdir: jest.fn().mockResolvedValue()
};

jest.mock('fs', () => ({
  promises: mockFs
}));

const { FileOperationTracker } = require('../src/shared/fileOperationTracker');

describe('FileOperationTracker', () => {
  beforeEach(() => {
    mockFs.readFile.mockReset();
    mockFs.writeFile.mockReset();
    mockFs.mkdir.mockReset();
  });

  test('recordOperation and wasRecentlyOperated respect cooldown', () => {
    jest.useFakeTimers();
    const tracker = new FileOperationTracker({ cooldownMs: 1000 });

    tracker.recordOperation('C:\\file.txt', 'move', 'watcher');
    expect(tracker.wasRecentlyOperated('C:\\file.txt')).toBe(true);

    jest.advanceTimersByTime(1001);
    expect(tracker.wasRecentlyOperated('C:\\file.txt')).toBe(false);
    jest.useRealTimers();
  });

  test('wasRecentlyOperated excludes source', () => {
    const tracker = new FileOperationTracker({ cooldownMs: 1000 });
    tracker.recordOperation('C:\\file.txt', 'move', 'watcher');
    expect(tracker.wasRecentlyOperated('C:\\file.txt', 'watcher')).toBe(false);
  });

  test('initialize loads persisted operations within cooldown', async () => {
    const now = Date.now();
    mockFs.readFile.mockResolvedValueOnce(
      JSON.stringify([
        { path: 'C:\\file.txt', timestamp: now, operationType: 'move', source: 'persisted' }
      ])
    );

    const tracker = new FileOperationTracker({
      cooldownMs: 5000,
      persistencePath: 'C:\\ops.json'
    });
    await tracker.initialize();

    expect(tracker.wasRecentlyOperated('C:\\file.txt')).toBe(true);
  });

  test('shutdown persists remaining operations', async () => {
    const tracker = new FileOperationTracker({
      cooldownMs: 5000,
      persistencePath: 'C:\\ops.json'
    });
    tracker.recordOperation('C:\\file.txt', 'move', 'watcher');
    await tracker.shutdown();
    expect(mockFs.writeFile).toHaveBeenCalled();
  });

  test('enforces a hard cap on the operations map to protect memory', () => {
    // Use a long cooldown so nothing expires mid-insert; we want to
    // exercise the size-cap path, not the time-based cleanup path.
    const tracker = new FileOperationTracker({ cooldownMs: 60_000 });

    // Insert more than the hard cap (10_000). We don't import the
    // constant to keep the test resilient to tuning changes — we just
    // assert the post-condition: size is bounded below what we inserted.
    const inserted = 10_500;
    for (let i = 0; i < inserted; i++) {
      tracker.recordOperation(`C:\\burst\\file-${i}.bin`, 'move', 'watcher');
    }

    expect(tracker.recentOperations.size).toBeLessThanOrEqual(10_000);
    // And the most recent insert must survive — older entries are
    // evicted first.
    expect(tracker.wasRecentlyOperated(`C:\\burst\\file-${inserted - 1}.bin`)).toBe(true);
  });

  test('persistence load respects the same cap', async () => {
    const now = Date.now();
    const entries = Array.from({ length: 15_000 }, (_, i) => ({
      path: `C:\\p\\${i}.bin`,
      timestamp: now,
      operationType: 'move',
      source: 'persisted'
    }));
    mockFs.readFile.mockResolvedValueOnce(JSON.stringify(entries));

    const tracker = new FileOperationTracker({
      cooldownMs: 60_000,
      persistencePath: 'C:\\ops.json'
    });
    await tracker.initialize();

    expect(tracker.recentOperations.size).toBeLessThanOrEqual(10_000);
  });
});
