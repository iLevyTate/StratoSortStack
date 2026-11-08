/**
 * Analysis history is rewritten in full on every coalesced save. Pins:
 * - history and index are written compact (no indentation) and load back
 *   unchanged, and an indented file from an older build still loads;
 * - a save with nothing changed since the last good one writes nothing;
 * - shutdown (quit) still writes changes the coalesced save was holding.
 *
 * Real AnalysisHistoryServiceCore + real persistence (the JSON backend, which
 * is what Jest selects) over the memfs-backed fs from test/test-setup.js.
 */

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/history-compact-userdata') }
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

const path = require('path');
const fsSync = require('fs');
const fs = require('fs').promises;

const USER_DATA = '/history-compact-userdata';
const HISTORY_FILE = path.join(USER_DATA, 'analysis-history.json');
const INDEX_FILE = path.join(USER_DATA, 'analysis-index.json');

// Newlines, quotes, backslashes and non-ASCII must survive the compact form.
const TRICKY_TEXT = 'Line one\nLine "two"\twith tab\r\nC:\\Users\\x\\file.pdf — ünïcödé ✓\n';

function newService() {
  const Core = require('../src/main/services/analysisHistory/AnalysisHistoryServiceCore');
  return new Core();
}

function record(service, filePath, extra = {}) {
  return service.recordAnalysis(
    { path: filePath, size: 10, lastModified: '2026-01-01T00:00:00Z' },
    { category: 'docs', tags: ['k'], extractedText: TRICKY_TEXT, ...extra }
  );
}

async function recordAndFlush(service, filePath, extra) {
  const pending = record(service, filePath, extra);
  const flushed = await service.flushPendingSaves();
  await pending;
  return flushed;
}

/** Count writes that target the history or index file (atomic temp writes). */
function spyOnHistoryWrites() {
  const realWriteFile = fs.writeFile.bind(fs);
  const targets = [];
  const spy = jest.spyOn(fs, 'writeFile').mockImplementation(async (file, ...rest) => {
    const name = String(file);
    if (name.includes('analysis-history.json') || name.includes('analysis-index.json')) {
      targets.push(name);
    }
    return realWriteFile(file, ...rest);
  });
  return { spy, targets };
}

describe('analysis history compact writes and write skipping', () => {
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

  test('history and index are written compact and load back unchanged', async () => {
    const first = newService();
    services.push(first);
    await first.initialize();
    expect(await recordAndFlush(first, '/docs/a.pdf')).toBe(true);
    await first.shutdown();

    const rawHistory = fsSync.readFileSync(HISTORY_FILE, 'utf8');
    const rawIndex = fsSync.readFileSync(INDEX_FILE, 'utf8');
    // Compact: JSON escapes the text's own newlines, so a raw newline can only
    // come from indentation.
    expect(rawHistory).not.toContain('\n');
    expect(rawIndex).not.toContain('\n');
    expect(rawHistory).toBe(JSON.stringify(JSON.parse(rawHistory)));

    const second = newService();
    services.push(second);
    await second.initialize();
    const [entry] = Object.values(second.analysisHistory.entries);
    expect(entry.originalPath).toBe('/docs/a.pdf');
    expect(entry.analysis.extractedText).toBe(TRICKY_TEXT);
    expect(second.analysisIndex.pathLookup['/docs/a.pdf']).toBe(entry.id);
    // Same pair revision on both files: the loader did not need to rebuild.
    expect(second.analysisIndex.pairRevision).toBe(second.analysisHistory.pairRevision);
    expect(second.hasUnsavedChanges()).toBe(false);
  });

  test('an indented history from an older build still loads', async () => {
    const first = newService();
    services.push(first);
    await first.initialize();
    expect(await recordAndFlush(first, '/docs/old.pdf')).toBe(true);
    await first.shutdown();

    for (const file of [HISTORY_FILE, INDEX_FILE]) {
      const parsed = JSON.parse(fsSync.readFileSync(file, 'utf8'));
      fsSync.writeFileSync(file, JSON.stringify(parsed, null, 2));
    }

    const second = newService();
    services.push(second);
    await second.initialize();
    const [entry] = Object.values(second.analysisHistory.entries);
    expect(entry.originalPath).toBe('/docs/old.pdf');
    expect(entry.analysis.extractedText).toBe(TRICKY_TEXT);
    expect(second.hasUnsavedChanges()).toBe(false);
  });

  test('nothing changed since the last good save: flush, timer and quit write nothing', async () => {
    const service = newService();
    services.push(service);
    await service.initialize();
    expect(await recordAndFlush(service, '/docs/a.pdf')).toBe(true);
    const before = fsSync.readFileSync(HISTORY_FILE, 'utf8');

    const { targets } = spyOnHistoryWrites();
    await expect(service.flushPendingSaves()).resolves.toBe(true);
    await expect(service.flushPendingSaves()).resolves.toBe(true);
    await expect(service._persistUnsavedHistory('timer')).resolves.toBe(true);
    expect(service._historySaveTimer).toBeNull();
    await service.shutdown();

    expect(targets).toEqual([]);
    expect(fsSync.readFileSync(HISTORY_FILE, 'utf8')).toBe(before);
  });

  test('a change after the last save is written once, then nothing more', async () => {
    const service = newService();
    services.push(service);
    await service.initialize();
    expect(await recordAndFlush(service, '/docs/a.pdf')).toBe(true);

    const { targets } = spyOnHistoryWrites();
    await service.updateEmbeddingStateByPath('/docs/a.pdf', { status: 'done' });
    expect(service.hasUnsavedChanges()).toBe(true);
    await expect(service.flushPendingSaves()).resolves.toBe(true);
    const afterChange = targets.length;
    expect(afterChange).toBe(2); // one history + one index write

    await expect(service.flushPendingSaves()).resolves.toBe(true);
    expect(targets).toHaveLength(afterChange);
  });

  test('quit writes changes the coalesced save was still holding', async () => {
    const first = newService();
    services.push(first);
    await first.initialize();
    expect(await recordAndFlush(first, '/docs/a.pdf')).toBe(true);

    // In memory, waiting for the coalesced save (2 s quiet / 10 s spacing).
    await record(first, '/docs/b.pdf');
    expect(first.hasUnsavedChanges()).toBe(true);
    const onDisk = JSON.parse(fsSync.readFileSync(HISTORY_FILE, 'utf8'));
    expect(Object.values(onDisk.entries).map((e) => e.originalPath)).toEqual(['/docs/a.pdf']);

    await first.shutdown();
    expect(first.hasUnsavedChanges()).toBe(false);

    const second = newService();
    services.push(second);
    await second.initialize();
    expect(
      Object.values(second.analysisHistory.entries)
        .map((e) => e.originalPath)
        .sort()
    ).toEqual(['/docs/a.pdf', '/docs/b.pdf']);
    expect(fsSync.readFileSync(HISTORY_FILE, 'utf8')).not.toContain('\n');
  });
});
