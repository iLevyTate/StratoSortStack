/**
 * D9 / K-09: retention never forgets a file that still exists.
 *
 * Before the fix `removeExpiredEntries` pruned every entry older than the
 * retention cutoff by timestamp alone. An analysis from two years ago whose
 * file is still on disk lost its history entry, and the cascade in
 * ServiceIntegration then marked its vectors orphaned: the file silently
 * dropped out of semantic search. Age now only expires entries whose file is
 * gone; existing files keep their knowledge until the file itself disappears.
 *
 * `fs` is memfs here (test-setup.js), so "exists" means seeded into the
 * in-memory volume below.
 */

const { vol } = require('memfs');

jest.mock('../src/shared/logger', () => {
  const logger = {
    setContext: jest.fn(),
    info: jest.fn(),
    debug: jest.fn(),
    warn: jest.fn(),
    error: jest.fn()
  };
  return { logger, createLogger: jest.fn(() => logger) };
});
jest.mock('../src/main/services/analysisHistory/cacheManager', () => ({
  updateIncrementalStatsOnRemove: jest.fn(),
  invalidateCachesOnRemove: jest.fn()
}));
jest.mock('../src/main/services/analysisHistory/indexManager', () => ({
  removeFromIndexes: jest.fn()
}));

const maintenance = require('../src/main/services/analysisHistory/maintenance');
const cacheManager = require('../src/main/services/analysisHistory/cacheManager');
const indexManager = require('../src/main/services/analysisHistory/indexManager');

const OLD = '2020-01-01T00:00:00.000Z';
const CUTOFF = new Date('2025-01-01T00:00:00.000Z');
const EXISTING = '/knowledge/still-here.txt';
const MISSING = '/knowledge/gone.txt';

function run(history) {
  const saveHistory = jest.fn().mockResolvedValue(undefined);
  const saveIndex = jest.fn().mockResolvedValue(undefined);
  const removed = maintenance.removeExpiredEntries(
    history,
    {},
    {},
    {},
    CUTOFF,
    saveHistory,
    saveIndex
  );
  return { removed, saveHistory, saveIndex };
}

describe('removeExpiredEntries (D9: only forget files that are gone)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // test-setup.js resets the volume before each test; seed after that.
    vol.fromJSON({ [EXISTING]: 'analyzed long ago, still on disk' });
  });

  test('keeps an expired entry whose file still exists, removes one whose file is gone', async () => {
    const history = {
      entries: {
        keep: { id: 'keep', timestamp: OLD, originalPath: EXISTING, organization: {} },
        drop: { id: 'drop', timestamp: OLD, originalPath: MISSING, organization: {} }
      },
      totalAnalyzed: 2,
      totalSize: 0,
      metadata: { totalEntries: 2 }
    };

    const { removed, saveHistory, saveIndex } = run(history);
    const result = await removed;

    expect(result.map((r) => r.id)).toEqual(['drop']);
    expect(Object.keys(history.entries)).toEqual(['keep']);
    expect(history.totalAnalyzed).toBe(1);
    expect(history.metadata.totalEntries).toBe(1);
    expect(cacheManager.updateIncrementalStatsOnRemove).toHaveBeenCalledTimes(1);
    expect(indexManager.removeFromIndexes).toHaveBeenCalledTimes(1);
    expect(saveHistory).toHaveBeenCalledTimes(1);
    expect(saveIndex).toHaveBeenCalledTimes(1);
  });

  test('checks the organized location when the file was moved after analysis', async () => {
    const history = {
      entries: {
        moved: {
          id: 'moved',
          timestamp: OLD,
          originalPath: MISSING,
          organization: { actual: EXISTING }
        }
      },
      totalAnalyzed: 1,
      totalSize: 0
    };

    const result = await run(history).removed;

    expect(result).toEqual([]);
    expect(history.entries.moved).toBeDefined();
  });

  test('an expired entry with no usable path is still removed', async () => {
    const history = {
      entries: {
        nopath: { id: 'nopath', timestamp: OLD, organization: {} }
      },
      totalAnalyzed: 1,
      totalSize: 0
    };

    const result = await run(history).removed;

    expect(result.map((r) => r.id)).toEqual(['nopath']);
  });

  test('a fresh entry is untouched regardless of its file', async () => {
    const history = {
      entries: {
        fresh: {
          id: 'fresh',
          timestamp: new Date().toISOString(),
          originalPath: MISSING,
          organization: {}
        }
      },
      totalAnalyzed: 1,
      totalSize: 0
    };

    const result = await run(history).removed;

    expect(result).toEqual([]);
    expect(history.entries.fresh).toBeDefined();
  });

  test('does not save when every expired entry still has its file', async () => {
    const history = {
      entries: {
        keep: { id: 'keep', timestamp: OLD, originalPath: EXISTING, organization: {} }
      },
      totalAnalyzed: 1,
      totalSize: 0
    };

    const { removed, saveHistory, saveIndex } = run(history);
    await removed;

    expect(saveHistory).not.toHaveBeenCalled();
    expect(saveIndex).not.toHaveBeenCalled();
    expect(cacheManager.invalidateCachesOnRemove).not.toHaveBeenCalled();
  });
});
