/**
 * @jest-environment node
 */

const mockFileSizes = new Map();

jest.mock('electron', () => ({
  app: {
    getPath: jest.fn(() => '/test/userData')
  }
}));

jest.mock('fs', () => ({
  promises: {
    readFile: jest.fn(),
    writeFile: jest.fn(async (filePath, content) => {
      mockFileSizes.set(filePath, Buffer.byteLength(content));
    }),
    rename: jest.fn().mockResolvedValue(undefined),
    unlink: jest.fn().mockResolvedValue(undefined),
    mkdir: jest.fn().mockResolvedValue(undefined),
    stat: jest.fn(async (filePath) => ({ size: mockFileSizes.get(filePath) ?? 0 }))
  }
}));

jest.mock('../src/shared/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })),
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    setContext: jest.fn()
  }
}));

const fs = require('fs').promises;
const { PatternPersistence } = require('../src/main/services/organization/persistence');

/**
 * The only caller saves the full PatternMatcher state each time, so the
 * newest queued snapshot is the truth. Merging it with an older queued one
 * brought back patterns deleted in between (undo within the 5 s throttle).
 */
describe('PatternPersistence throttled saves', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockFileSizes.clear();
  });

  const written = () => JSON.parse(fs.writeFile.mock.calls.at(-1)[1]);

  it.each([
    ['the throttle timer fires', (p) => jest.advanceTimersByTimeAsync(5000)],
    ['the app quits', (p) => p.shutdown()]
  ])('a pattern removed inside the throttle stays removed when %s', async (_label, flush) => {
    jest.useFakeTimers();
    try {
      const persistence = new PatternPersistence({ saveThrottleMs: 5000 });
      persistence.lastSaveTime = Date.now();

      await persistence.save({
        patterns: [
          ['a', { count: 1 }],
          ['b', { count: 1 }]
        ],
        feedbackHistory: [{ timestamp: 1, file: { name: 'b.csv' }, accepted: true }],
        folderUsageStats: [['gsc', { count: 2 }]]
      });
      // Undo took back "b": the next full snapshot no longer has it.
      await persistence.save({
        patterns: [['a', { count: 1 }]],
        feedbackHistory: [],
        folderUsageStats: [['gsc', { count: 1 }]]
      });
      await flush(persistence);

      expect(fs.writeFile).toHaveBeenCalledTimes(1);
      const saved = written();
      expect(saved.patterns).toEqual([['a', { count: 1 }]]);
      expect(saved.feedbackHistory).toEqual([]);
      expect(saved.folderUsageStats).toEqual([['gsc', { count: 1 }]]);
    } finally {
      jest.useRealTimers();
    }
  });
});
