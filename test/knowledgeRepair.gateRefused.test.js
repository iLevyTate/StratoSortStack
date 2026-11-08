/**
 * Startup repair under settings that keep files out of the local index
 * ('manual' timing, a 'skip' default policy, a smart-folders-only scope).
 * Those files can never be embedded by the repair, so a launch must not stat
 * each of them, hand each to the embedder, or rewrite their history entries:
 * the work repeated on every launch and nothing improved.
 * Uses the real embedding gate with stubbed settings.
 */

jest.mock('../src/shared/logger', () => {
  const l = { debug: jest.fn(), info: jest.fn(), warn: jest.fn(), error: jest.fn() };
  return { logger: l, createLogger: () => l };
});

let mockSettings = {};
jest.mock('../src/main/services/ServiceContainer', () => ({
  container: {
    tryResolve: (id) => (id === 'SETTINGS' ? { load: async () => mockSettings } : null)
  },
  ServiceIds: { SETTINGS: 'SETTINGS' }
}));
jest.mock('../src/main/services/SettingsService', () => ({
  getInstance: () => ({ load: async () => mockSettings })
}));

const mockEmbedHistoryEntry = jest.fn(async () => ({ action: 'enqueued' }));
const mockGetSmartFolderForPath = jest.fn((filePath) =>
  filePath.startsWith('/library/') ? { name: 'Library', path: '/library' } : null
);
jest.mock('../src/main/ipc/files/embeddingSync', () => ({
  resolveServices: jest.fn(() => ({
    vectorDbService: null,
    analysisHistoryService: null,
    folderMatchingService: null,
    learningFeedbackService: null
  })),
  embedHistoryEntry: (...a) => mockEmbedHistoryEntry(...a),
  getSmartFolderForPath: (...a) => mockGetSmartFolderForPath(...a)
}));

const fsp = require('fs').promises;
const {
  scheduleStartupKnowledgeRepair
} = require('../src/main/services/embedding/knowledgeRepair');

const entry = (p, extra = {}) => ({ originalPath: p, analysis: { summary: 's' }, ...extra });

function run(entries) {
  // No row for any file: every entry looks like it needs a re-embed.
  const vectorDb = {
    getFile: jest.fn(async () => null),
    hasUsableVector: jest.fn(async () => false),
    restoreOrphanedEmbeddings: jest.fn(async () => ({ restored: 0 }))
  };
  return scheduleStartupKnowledgeRepair({
    vectorDb,
    analysisHistory: { analysisHistory: { entries } },
    delayMs: 0
  });
}

describe('startup repair when the embedding gate refuses', () => {
  let statSpy;
  beforeEach(() => {
    mockEmbedHistoryEntry.mockClear();
    statSpy = jest.spyOn(fsp, 'stat').mockResolvedValue({ isDirectory: () => false });
    mockSettings = { embeddingTiming: 'during_analysis', defaultEmbeddingPolicy: 'embed' };
  });
  afterEach(() => statSpy.mockRestore());

  test('manual timing: no file is stat-ed or handed to the embedder', async () => {
    mockSettings.embeddingTiming = 'manual';
    const entries = Object.fromEntries(
      Array.from({ length: 200 }, (_, i) => [`e${i}`, entry(`/docs/f${i}.pdf`)])
    );

    const summary = await run(entries);

    expect(statSpy).not.toHaveBeenCalled();
    expect(mockEmbedHistoryEntry).not.toHaveBeenCalled();
    expect(summary).toMatchObject({ embedded: 0, skippedGate: 200, checked: 0 });
  });

  test("a 'skip' default policy only lets per-file 'embed' overrides through", async () => {
    mockSettings.defaultEmbeddingPolicy = 'skip';

    const summary = await run({
      a: entry('/docs/a.pdf'),
      b: entry('/docs/b.pdf', { embedding: { policy: 'embed' } }),
      c: entry('/docs/c.pdf', { embedding: { policy: 'web_only' } })
    });

    expect(statSpy).toHaveBeenCalledTimes(1);
    expect(statSpy).toHaveBeenCalledWith('/docs/b.pdf');
    expect(mockEmbedHistoryEntry).toHaveBeenCalledTimes(1);
    expect(mockEmbedHistoryEntry.mock.calls[0][0].filePath).toBe('/docs/b.pdf');
    expect(summary).toMatchObject({ embedded: 1, skippedGate: 2 });
  });

  test('smart-folders-only scope: files outside every smart folder are not stat-ed', async () => {
    mockSettings.embeddingScope = 'smart_folders_only';

    const summary = await run({
      out: entry('/downloads/x.pdf'),
      in: entry('/library/y.pdf')
    });

    expect(statSpy).toHaveBeenCalledTimes(1);
    expect(statSpy).toHaveBeenCalledWith('/library/y.pdf');
    expect(mockEmbedHistoryEntry).toHaveBeenCalledTimes(1);
    expect(summary).toMatchObject({ embedded: 1, skippedGate: 1 });
  });

  test('default settings still backfill every missing vector', async () => {
    const summary = await run({ a: entry('/docs/a.pdf'), b: entry('/docs/b.pdf') });

    expect(mockEmbedHistoryEntry).toHaveBeenCalledTimes(2);
    expect(summary).toMatchObject({ embedded: 2, skippedGate: 0 });
  });
});
