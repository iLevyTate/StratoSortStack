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
