/**
 * History and its index are persisted as two separate writes (two SQLite
 * rows, or two JSON files). When only one of them lands (a crash between
 * them, or one write failing), the next launch must not keep an index that
 * disagrees with the history: the index is derived data and is rebuilt from
 * the history when the pair on disk does not match.
 *
 * Real AnalysisHistoryServiceCore + real persistence (the JSON backend, which
 * is what Jest selects) over the memfs-backed fs from test/test-setup.js.
 */

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/history-consistency-userdata') }
}));

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

const fsSync = require('fs');
const fs = require('fs').promises;

const USER_DATA = '/history-consistency-userdata';

function newService() {
  const Core = require('../src/main/services/analysisHistory/AnalysisHistoryServiceCore');
  return new Core();
}

async function recordAndFlush(service, filePath) {
  const pending = service.recordAnalysis(
    { path: filePath, size: 10, lastModified: '2026-01-01T00:00:00Z' },
    { category: 'docs', keywords: ['k'] }
  );
  const flushed = await service.flushPendingSaves();
  await pending;
  return flushed;
}

describe('analysis history index consistency on load', () => {
  const services = [];

  beforeEach(() => {
    try {
      fsSync.rmSync(USER_DATA, { recursive: true, force: true });
    } catch {
      // first run
    }
    fsSync.mkdirSync(USER_DATA, { recursive: true });
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    for (const s of services.splice(0)) {
      try {
        await s.shutdown();
      } catch {
        // already shut down
      }
    }
  });

  test('an index write that did not land is rebuilt from the history on the next load', async () => {
    const first = newService();
    services.push(first);
    await first.initialize();
    expect(await recordAndFlush(first, '/docs/a.pdf')).toBe(true);

    // The index write fails; the history write lands.
    const realWriteFile = fs.writeFile.bind(fs);
    const writeSpy = jest.spyOn(fs, 'writeFile').mockImplementation(async (file, ...rest) => {
      if (String(file).includes('analysis-index')) {
        throw Object.assign(new Error('EIO: simulated index write failure'), { code: 'EIO' });
      }
      return realWriteFile(file, ...rest);
    });
    expect(await recordAndFlush(first, '/docs/b.pdf')).toBe(false);
    writeSpy.mockRestore();
    // Simulate the process dying before the retry: drop the first instance
    // without letting it write again.
    first._isShutdown = true;
    first.hasUnsavedChanges = () => false;

    const second = newService();
    services.push(second);
    await second.initialize();

    const entries = Object.values(second.analysisHistory.entries);
    expect(entries.map((e) => e.originalPath).sort()).toEqual(['/docs/a.pdf', '/docs/b.pdf']);
    for (const entry of entries) {
      expect(second.analysisIndex.fileHashes[entry.fileHash]).toBe(entry.id);
      expect(second.analysisIndex.pathLookup[entry.originalPath]).toBe(entry.id);
    }
    const found = await second.getAnalysisByPath('/docs/b.pdf');
    expect(found?.originalPath).toBe('/docs/b.pdf');
  });

  test('a rebuild keeps the history when an entry lacks analysis or a timestamp', async () => {
    const path = require('path');
    const first = newService();
    services.push(first);
    await first.initialize();
    expect(await recordAndFlush(first, '/docs/a.pdf')).toBe(true);
    await first.shutdown();

    // Older or partial entries: no `analysis` block, no `timestamp`. The
    // history revision no longer matches the index, so the next load rebuilds.
    const historyPath = path.join(USER_DATA, 'analysis-history.json');
    const history = JSON.parse(fsSync.readFileSync(historyPath, 'utf8'));
    history.entries.legacy1 = {
      id: 'legacy1',
      originalPath: '/docs/legacy1.pdf',
      fileHash: 'hash-legacy1',
      timestamp: '2025-01-01T00:00:00.000Z',
      fileSize: 10
    };
    history.entries.legacy2 = {
      id: 'legacy2',
      originalPath: '/docs/legacy2.pdf',
      fileHash: 'hash-legacy2',
      fileSize: 10,
      analysis: { category: 'docs' }
    };
    history.pairRevision = 'revision-not-in-index';
    fsSync.writeFileSync(historyPath, JSON.stringify(history));

    const second = newService();
    services.push(second);
    await second.initialize();

    const expected = ['/docs/a.pdf', '/docs/legacy1.pdf', '/docs/legacy2.pdf'];
    const inMemory = Object.values(second.analysisHistory.entries).map((e) => e.originalPath);
    expect(inMemory.sort()).toEqual(expected);
    expect(second._readOnly).toBe(false);
    for (const id of ['legacy1', 'legacy2']) {
      const entry = second.analysisHistory.entries[id];
      expect(second.analysisIndex.pathLookup[entry.originalPath]).toBe(id);
      expect(second.analysisIndex.fileHashes[entry.fileHash]).toBe(id);
    }

    await second.flushPendingSaves();
    const onDisk = JSON.parse(fsSync.readFileSync(historyPath, 'utf8'));
    expect(
      Object.values(onDisk.entries)
        .map((e) => e.originalPath)
        .sort()
    ).toEqual(expected);
  });

  test('a consistent pair loads as saved without a rebuild', async () => {
    const first = newService();
    services.push(first);
    await first.initialize();
    expect(await recordAndFlush(first, '/docs/a.pdf')).toBe(true);
    await first.shutdown();

    const second = newService();
    services.push(second);
    await second.initialize();
    expect(second.hasUnsavedChanges()).toBe(false);
    const [entry] = Object.values(second.analysisHistory.entries);
    expect(second.analysisIndex.pathLookup[entry.originalPath]).toBe(entry.id);
  });
});

// An entry keeps `originalPath` for good; once the file is moved, the entry
// lives at `organization.actual`. A different file that later shows up at the
// old path (a second Downloads/report.pdf) must not be mistaken for it.
describe('a moved entry is not addressed by the path it left', () => {
  const services = [];
  const OLD = '/downloads/report.pdf';
  const MOVED = '/docs/report.pdf';

  beforeEach(() => {
    try {
      fsSync.rmSync(USER_DATA, { recursive: true, force: true });
    } catch {
      // first run
    }
    fsSync.mkdirSync(USER_DATA, { recursive: true });
  });

  afterEach(async () => {
    for (const s of services.splice(0)) {
      try {
        await s.shutdown();
      } catch {
        // already shut down
      }
    }
  });

  async function analysedThenMoved() {
    const service = newService();
    services.push(service);
    await service.initialize();
    await recordAndFlush(service, OLD);
    const [first] = Object.values(service.analysisHistory.entries);
    await service.updateEntryPaths([{ oldPath: OLD, newPath: MOVED }]);
    return { service, first };
  }

  test('analysing a new file at the old path keeps the moved file in history', async () => {
    const { service, first } = await analysedThenMoved();
    first.accessCount = 7;

    await recordAndFlush(service, OLD);

    const entries = Object.values(service.analysisHistory.entries);
    expect(entries).toHaveLength(2);
    expect(service.analysisHistory.entries[first.id]).toBe(first);
    expect((await service.getAnalysisByPath(MOVED))?.id).toBe(first.id);
    const second = await service.getAnalysisByPath(OLD);
    expect(second?.id).not.toBe(first.id);
    expect(second?.originalPath).toBe(OLD);
    // Usage belongs to the moved file, not to the newcomer.
    expect(second?.accessCount).toBe(0);
    expect(service.analysisHistory.totalAnalyzed).toBe(2);
  });

  test('moving an unanalysed file from the old path leaves the moved entry alone', async () => {
    const { service, first } = await analysedThenMoved();

    const result = await service.updateEntryPaths([
      {
        oldPath: OLD,
        newPath: '/photos/renamed.pdf',
        newName: 'renamed.pdf',
        newCategory: 'Photos'
      }
    ]);

    expect(result).toMatchObject({ updated: 0, notFound: 1, divergences: [] });
    expect(first.organization.actual).toBe(MOVED);
    expect(first.fileName).toBe('report.pdf');
    expect(first.analysis.category).toBe('docs');
    expect((await service.getAnalysisByPath(MOVED))?.id).toBe(first.id);
    expect(await service.getAnalysisByPath('/photos/renamed.pdf')).toBeNull();
  });

  test('moving a second analysed file from the old path moves only its own entry', async () => {
    const { service, first } = await analysedThenMoved();
    await recordAndFlush(service, OLD);
    const second = await service.getAnalysisByPath(OLD);

    const result = await service.updateEntryPaths([{ oldPath: OLD, newPath: '/photos/b.pdf' }]);

    expect(result).toMatchObject({ updated: 1, notFound: 0 });
    expect(first.organization.actual).toBe(MOVED);
    expect(second.organization.actual).toBe('/photos/b.pdf');
    expect((await service.getAnalysisByPath(MOVED))?.id).toBe(first.id);
    expect((await service.getAnalysisByPath('/photos/b.pdf'))?.id).toBe(second.id);
    expect(await service.getAnalysisByPath(OLD)).toBeNull();
  });

  test('the old path no longer resolves, and resolves again after the move is undone', async () => {
    const { service, first } = await analysedThenMoved();

    expect(await service.getAnalysisByPath(OLD)).toBeNull();

    await service.updateEntryPaths([{ oldPath: MOVED, newPath: OLD }]);
    expect((await service.getAnalysisByPath(OLD))?.id).toBe(first.id);
    expect(await service.getAnalysisByPath(MOVED)).toBeNull();
  });

  test('deleting, tagging or flagging the old path does not touch the moved entry', async () => {
    const { service, first } = await analysedThenMoved();

    expect(await service.removeEntriesByPath(OLD)).toEqual({ removed: 0 });
    expect(await service.updateTags(OLD, ['wrong-file'])).toMatchObject({ updated: 0 });
    expect(await service.updateEmbeddingStateByPath(OLD, { status: 'skipped' })).toMatchObject({
      updated: 0
    });

    expect(service.analysisHistory.entries[first.id]).toBe(first);
    expect(first.analysis.tags).not.toContain('wrong-file');
    expect(first.embedding.status).not.toBe('skipped');
    expect((await service.getAnalysisByPath(MOVED))?.id).toBe(first.id);
  });

  test('removing the moved entry keeps the newcomer at the old path findable', async () => {
    const { service, first } = await analysedThenMoved();
    await recordAndFlush(service, OLD);
    const second = await service.getAnalysisByPath(OLD);

    expect(await service.removeEntriesByPath(MOVED)).toEqual({ removed: 1 });

    expect(service.analysisHistory.entries[first.id]).toBeUndefined();
    expect((await service.getAnalysisByPath(OLD))?.id).toBe(second.id);
  });

  test('an index rebuilt on load does not bring the old path back', async () => {
    const path = require('path');
    const { service, first } = await analysedThenMoved();
    await service.shutdown();

    const historyPath = path.join(USER_DATA, 'analysis-history.json');
    const history = JSON.parse(fsSync.readFileSync(historyPath, 'utf8'));
    history.pairRevision = 'revision-not-in-index';
    fsSync.writeFileSync(historyPath, JSON.stringify(history));

    const reloaded = newService();
    services.push(reloaded);
    await reloaded.initialize();

    expect(await reloaded.getAnalysisByPath(OLD)).toBeNull();
    expect((await reloaded.getAnalysisByPath(MOVED))?.id).toBe(first.id);
  });
});
