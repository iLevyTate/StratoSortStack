/**
 * @jest-environment node
 */

jest.mock('../../../../src/main/ipc/files/batchOrganizeHandler', () => ({
  performFileMove: jest.fn(),
  computeFileChecksum: jest.fn()
}));

describe('DownloadsTriageService act(organize) destination directory validation', () => {
  test('rejects invalid raw destination directory before path.join; does not call performFileMove', async () => {
    jest.resetModules();
    const pathSan = require('../../../../src/shared/pathSanitization');
    const actual = jest.requireActual('../../../../src/shared/pathSanitization');
    const spy = jest
      .spyOn(pathSan, 'validateFileOperationPath')
      .mockImplementation(async (p, opts) => {
        if (typeof p === 'string' && p.startsWith('/__bad_dest__')) {
          return {
            valid: false,
            normalizedPath: '',
            error: 'rejected raw destination directory'
          };
        }
        return actual.validateFileOperationPath(p, opts);
      });

    const { performFileMove } = require('../../../../src/main/ipc/files/batchOrganizeHandler');
    const {
      DownloadsTriageService
    } = require('../../../../src/main/services/triage/DownloadsTriageService');
    const svc = new DownloadsTriageService();
    const tid = 't-dest-validate';
    const row = {
      filePath: '/tmp/nope.txt',
      fileName: 'nope.txt',
      size: 1,
      suggestedFolder: { id: 'x', name: 'bad', path: '/__bad_dest__/nested' }
    };
    svc._sessions.set(tid, {
      triageId: tid,
      folderPath: '/tmp',
      smartFolders: [],
      smartFolderPaths: [],
      exclusionGlobs: [],
      minAgeMs: 0,
      classifications: new Map([['/tmp/nope.txt', row]]),
      buckets: {
        keep: [row],
        trash: [],
        excluded: [],
        ambiguous: [],
        review: [],
        unmatched: []
      },
      createdAt: Date.now(),
      actMutex: Promise.resolve()
    });

    const result = await svc.act({
      triageId: tid,
      action: 'organize',
      files: [
        {
          path: '/tmp/nope.txt',
          size: 1,
          suggestedFolderPath: '/__bad_dest__/nested'
        }
      ]
    });

    expect(result.success).toBe(false);
    expect(result.failed).toEqual([
      expect.objectContaining({
        path: '/tmp/nope.txt',
        error: 'rejected raw destination directory'
      })
    ]);
    expect(performFileMove).not.toHaveBeenCalled();

    spy.mockRestore();
  });

  test('no-ops a destination outside the session roots (corrupted session state); does not call performFileMove', async () => {
    jest.resetModules();
    const path = require('path');
    const os = require('os');

    const { performFileMove } = require('../../../../src/main/ipc/files/batchOrganizeHandler');
    performFileMove.mockClear();
    const {
      DownloadsTriageService
    } = require('../../../../src/main/services/triage/DownloadsTriageService');
    const svc = new DownloadsTriageService();

    const downloadsRoot = path.join(os.tmpdir(), 'triage-contain', 'downloads');
    const smartRoot = path.join(os.tmpdir(), 'triage-contain', 'smart');
    // Passes generic path validation but sits outside BOTH session roots —
    // only reachable if session state is corrupted or a classifier regression
    // suggests a folder that was never a Smart Folder.
    const escapedDir = path.join(os.tmpdir(), 'triage-contain', 'elsewhere');
    const srcPath = path.join(downloadsRoot, 'doc.txt');

    const tid = 't-dest-containment';
    const row = {
      filePath: srcPath,
      fileName: 'doc.txt',
      size: 1,
      suggestedFolder: { id: 'x', name: 'Escaped', path: escapedDir }
    };
    svc._sessions.set(tid, {
      triageId: tid,
      folderPath: downloadsRoot,
      smartFolders: [{ path: smartRoot }],
      smartFolderPaths: [smartRoot],
      exclusionGlobs: [],
      minAgeMs: 0,
      classifications: new Map([[srcPath, row]]),
      buckets: {
        keep: [row],
        trash: [],
        excluded: [],
        ambiguous: [],
        review: [],
        unmatched: []
      },
      createdAt: Date.now(),
      actMutex: Promise.resolve()
    });

    const result = await svc.act({
      triageId: tid,
      action: 'organize',
      files: [{ path: srcPath, size: 1, suggestedFolderPath: escapedDir }]
    });

    expect(result.success).toBe(false);
    expect(result.failed).toEqual([
      expect.objectContaining({
        path: srcPath,
        error: 'Destination outside the session triage roots'
      })
    ]);
    expect(performFileMove).not.toHaveBeenCalled();
  });

  test('allows a destination inside a session Smart Folder root', async () => {
    jest.resetModules();
    const path = require('path');
    const os = require('os');
    const fsp = require('fs').promises;

    const { performFileMove } = require('../../../../src/main/ipc/files/batchOrganizeHandler');
    performFileMove.mockClear();
    performFileMove.mockResolvedValue({});
    const {
      DownloadsTriageService
    } = require('../../../../src/main/services/triage/DownloadsTriageService');
    const svc = new DownloadsTriageService();

    // This suite runs on the in-memory fs mock; materialize tmpdir first.
    await fsp.mkdir(os.tmpdir(), { recursive: true });
    const base = await fsp.mkdtemp(path.join(os.tmpdir(), 'triage-contain-ok-'));
    const downloadsRoot = path.join(base, 'downloads');
    const smartRoot = path.join(base, 'smart');
    const destDir = path.join(smartRoot, 'Docs');
    const srcPath = path.join(downloadsRoot, 'doc.txt');
    await fsp.mkdir(downloadsRoot, { recursive: true });
    await fsp.writeFile(srcPath, 'content');

    const tid = 't-dest-containment-ok';
    const row = {
      filePath: srcPath,
      fileName: 'doc.txt',
      size: 1,
      suggestedFolder: { id: 'x', name: 'Docs', path: destDir }
    };
    svc._sessions.set(tid, {
      triageId: tid,
      folderPath: downloadsRoot,
      smartFolders: [{ path: smartRoot }],
      smartFolderPaths: [smartRoot],
      exclusionGlobs: [],
      minAgeMs: 0,
      classifications: new Map([[srcPath, row]]),
      buckets: {
        keep: [row],
        trash: [],
        excluded: [],
        ambiguous: [],
        review: [],
        unmatched: []
      },
      createdAt: Date.now(),
      actMutex: Promise.resolve()
    });

    const result = await svc.act({
      triageId: tid,
      action: 'organize',
      files: [{ path: srcPath, size: 1, suggestedFolderPath: destDir }]
    });

    expect(result.failed).toEqual([]);
    expect(performFileMove).toHaveBeenCalledTimes(1);

    await fsp.rm(base, { recursive: true, force: true });
  });
});
