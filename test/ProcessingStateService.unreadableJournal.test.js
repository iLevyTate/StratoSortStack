/**
 * A processing-state.json that exists but cannot be read at startup (an
 * antivirus/indexer hold, a permission flap, an I/O error) is the organize
 * resume journal and the durable ready queue. It must never be replaced by an
 * empty state: transient holds are retried, and a file that stays unreadable
 * is set aside or left untouched instead of being overwritten.
 *
 * Uses the memfs-backed `fs` from test/test-setup.js with real rename/open
 * semantics; only `readFile` on the journal path is made to fail.
 */

jest.mock('electron', () => ({
  app: { getPath: jest.fn(() => '/pss-unreadable-userdata') }
}));

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const mockRaise = jest.fn();
jest.mock('../src/main/services/DegradedStateTracker', () => ({
  getInstance: () => ({ raise: mockRaise, clear: jest.fn() })
}));

const fsSync = require('fs');
const fs = require('fs').promises;
const path = require('path');
const ProcessingStateService = require('../src/main/services/ProcessingStateService');

const USER_DATA = '/pss-unreadable-userdata';
const STATE_PATH = path.join(USER_DATA, 'processing-state.json');

function journalWithIncompleteBatch() {
  return JSON.stringify(
    {
      schemaVersion: '1.0.0',
      createdAt: '2026-11-01T00:00:00.000Z',
      updatedAt: '2026-11-01T00:00:00.000Z',
      analysis: {
        jobs: {},
        ready: {
          '/docs/a.pdf': {
            path: '/docs/a.pdf',
            name: 'a.pdf',
            analyzedAt: new Date().toISOString(),
            analysis: { category: 'invoice' }
          }
        },
        lastUpdated: '2026-11-01T00:00:00.000Z'
      },
      organize: {
        batches: {
          'batch-1': {
            id: 'batch-1',
            operations: [
              { source: '/docs/a.pdf', destination: '/sorted/a.pdf', status: 'done' },
              { source: '/docs/b.pdf', destination: '/sorted/b.pdf', status: 'pending' }
            ],
            startedAt: '2026-11-01T00:00:00.000Z',
            completedAt: null
          }
        },
        lastUpdated: '2026-11-01T00:00:00.000Z'
      }
    },
    null,
    2
  );
}

function errorWithCode(code) {
  return Object.assign(new Error(`${code}: simulated read failure`), { code });
}

/** Make reads of the journal path fail `times` times (Infinity = always). */
function failJournalReads(code, times) {
  const realReadFile = fs.readFile.bind(fs);
  let remaining = times;
  return jest.spyOn(fs, 'readFile').mockImplementation(async (file, ...rest) => {
    if (String(file) === STATE_PATH && remaining > 0) {
      remaining -= 1;
      throw errorWithCode(code);
    }
    return realReadFile(file, ...rest);
  });
}

function listUserData() {
  return fsSync.readdirSync(USER_DATA).sort();
}

describe('ProcessingStateService unreadable journal at startup', () => {
  let service;
  const original = journalWithIncompleteBatch();

  beforeEach(() => {
    mockRaise.mockReset();
    try {
      fsSync.rmSync(USER_DATA, { recursive: true, force: true });
    } catch {
      // first run
    }
    fsSync.mkdirSync(USER_DATA, { recursive: true });
    fsSync.writeFileSync(STATE_PATH, original, 'utf8');
    service = new ProcessingStateService();
    service._startSweepInterval = jest.fn();
    service._journalReadRetryDelaysMs = [1, 1, 1];
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    if (service) await service.destroy();
  });

  test('a transient hold that clears during the read retry loads the journal intact', async () => {
    failJournalReads('EBUSY', 2);

    await service.initialize();

    expect(service.initialized).toBe(true);
    expect(service.getIncompleteOrganizeBatches().map((b) => b.id)).toEqual(['batch-1']);
    expect(fsSync.readFileSync(STATE_PATH, 'utf8')).toBe(original);
  });

  test('a journal that stays unreadable is never overwritten with an empty state', async () => {
    failJournalReads('EACCES', Infinity);
    // The hold also blocks moving the file aside (Windows AV/indexer hold).
    const realRename = fs.rename.bind(fs);
    const renameSpy = jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (path.basename(String(from)) === 'processing-state.json') throw errorWithCode('EBUSY');
      return realRename(from, to);
    });

    await service.initialize();

    expect(service.initialized).toBe(true);
    // The live journal is byte-for-byte untouched by startup...
    expect(fsSync.readFileSync(STATE_PATH, 'utf8')).toBe(original);

    // ...and by later state mutations while it is still held.
    await service.markAnalysisStart('/docs/c.pdf');
    await service.flushSaveState();
    expect(fsSync.readFileSync(STATE_PATH, 'utf8')).toBe(original);
    expect(renameSpy).not.toHaveBeenCalledWith(expect.stringContaining('.tmp.'), STATE_PATH);
    expect(mockRaise).toHaveBeenCalledWith(
      expect.objectContaining({ code: 'processing-state.journal-unreadable' })
    );
  });

  test('once the held journal can be set aside, saves resume and the old bytes are kept', async () => {
    failJournalReads('EACCES', Infinity);
    const realRename = fs.rename.bind(fs);
    let holdActive = true;
    jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (path.basename(String(from)) === 'processing-state.json' && holdActive)
        throw errorWithCode('EBUSY');
      return realRename(from, to);
    });
    jest.spyOn(fs, 'copyFile').mockRejectedValue(errorWithCode('EACCES'));

    await service.initialize();
    holdActive = false;

    await service.markAnalysisStart('/docs/c.pdf');
    await service.flushSaveState();

    const setAside = listUserData().filter((name) =>
      name.startsWith('processing-state.json.unreadable.')
    );
    expect(setAside).toHaveLength(1);
    expect(fsSync.readFileSync(path.join(USER_DATA, setAside[0]), 'utf8')).toBe(original);
    const live = JSON.parse(fsSync.readFileSync(STATE_PATH, 'utf8'));
    expect(Object.keys(live.analysis.jobs)).toHaveLength(1);
  });

  test('when only a copy could be kept, saves resume once the hold clears', async () => {
    failJournalReads('EACCES', Infinity);
    const realRename = fs.rename.bind(fs);
    let holdActive = true;
    jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (path.basename(String(from)) === 'processing-state.json' && holdActive)
        throw errorWithCode('EBUSY');
      return realRename(from, to);
    });

    await service.initialize();
    // Copying succeeded during the hold: a copy sits beside the live journal.
    const copies = listUserData().filter((name) =>
      name.startsWith('processing-state.json.unreadable.')
    );
    expect(copies).toHaveLength(1);
    expect(fsSync.readFileSync(STATE_PATH, 'utf8')).toBe(original);

    holdActive = false;
    await service.markAnalysisStart('/docs/c.pdf');
    await service.flushSaveState();

    const setAside = listUserData().filter((name) =>
      name.startsWith('processing-state.json.unreadable.')
    );
    expect(setAside).toHaveLength(1);
    expect(fsSync.readFileSync(path.join(USER_DATA, setAside[0]), 'utf8')).toBe(original);
    const live = JSON.parse(fsSync.readFileSync(STATE_PATH, 'utf8'));
    expect(Object.keys(live.analysis.jobs)).toEqual(['/docs/c.pdf']);
  });

  test('a corrupt (unparseable) journal still resets to a fresh persisted state', async () => {
    fsSync.writeFileSync(STATE_PATH, '{ not json', 'utf8');

    await service.initialize();

    expect(service.initialized).toBe(true);
    const live = JSON.parse(fsSync.readFileSync(STATE_PATH, 'utf8'));
    expect(live.organize.batches).toEqual({});
  });
  test.each([
    ['a truncated journal (SyntaxError)', () => original.slice(0, Math.floor(original.length / 2))],
    ['an array-root journal (wrong shape)', () => JSON.stringify([JSON.parse(original)])]
  ])('%s is kept under a quarantine name before the reset', async (_label, makeContent) => {
    const corrupt = makeContent();
    fsSync.writeFileSync(STATE_PATH, corrupt, 'utf8');

    await service.initialize();

    expect(service.initialized).toBe(true);
    const kept = listUserData().filter((name) => name.startsWith('processing-state.json.corrupt.'));
    expect(kept).toHaveLength(1);
    expect(fsSync.readFileSync(path.join(USER_DATA, kept[0]), 'utf8')).toBe(corrupt);
    // The live journal is reset to a fresh, parseable state.
    const live = JSON.parse(fsSync.readFileSync(STATE_PATH, 'utf8'));
    expect(live.organize.batches).toEqual({});
    expect(mockRaise).toHaveBeenCalledWith(
      expect.objectContaining({
        code: 'processing-state.journal-unreadable',
        detail: expect.objectContaining({ quarantinePath: path.join(USER_DATA, kept[0]) })
      })
    );
  });

  test('a corrupt journal that cannot be set aside is left untouched', async () => {
    fsSync.writeFileSync(STATE_PATH, '{ not json', 'utf8');
    const realRename = fs.rename.bind(fs);
    jest.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (path.basename(String(from)) === 'processing-state.json') throw errorWithCode('EBUSY');
      return realRename(from, to);
    });
    jest.spyOn(fs, 'copyFile').mockRejectedValue(errorWithCode('EACCES'));

    await service.initialize();
    await service.markAnalysisStart('/docs/c.pdf');
    await service.flushSaveState();

    expect(fsSync.readFileSync(STATE_PATH, 'utf8')).toBe('{ not json');
  });
});
