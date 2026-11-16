/**
 * @jest-environment node
 */
/**
 * Tests for TrashService — the shell.trashItem wrapper used by Phase 1
 * (Duplicate Finder) and Phase 3 (Downloads Triage).
 */

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const path = require('path');
const fs = require('fs').promises;
const os = require('os');

const mockTrashItem = jest.fn();

jest.mock('electron', () => ({
  shell: {
    trashItem: (...args) => mockTrashItem(...args)
  }
}));

describe('TrashService', () => {
  let TrashService;
  let testDir;
  let service;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `trash-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    jest.resetModules();
    mockTrashItem.mockReset();
    ({ TrashService } = require('../src/main/services/TrashService'));
    service = new TrashService({ maxBatchSize: 100 });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('trashOne returns NOT_FOUND when file does not exist', async () => {
    const missing = path.join(testDir, 'does-not-exist.txt');
    const result = await service.trashOne(missing);
    expect(result.success).toBe(false);
    expect(result.code).toBe('NOT_FOUND');
    expect(mockTrashItem).not.toHaveBeenCalled();
  });

  test('trashOne delegates to shell.trashItem for existing files', async () => {
    const file = path.join(testDir, 'doomed.txt');
    await fs.writeFile(file, 'bye');
    mockTrashItem.mockResolvedValue(undefined);

    const result = await service.trashOne(file);
    expect(result.success).toBe(true);
    expect(result.path).toBe(path.resolve(file));
    expect(mockTrashItem).toHaveBeenCalledWith(path.resolve(file));
  });

  test('trashOne captures trashItem errors as structured failure', async () => {
    const file = path.join(testDir, 'stuck.txt');
    await fs.writeFile(file, 'locked');
    mockTrashItem.mockRejectedValue(new Error('trash unavailable'));

    const result = await service.trashOne(file);
    expect(result.success).toBe(false);
    expect(result.code).toBe('TRASH_FAILED');
    expect(result.error).toMatch(/trash unavailable/);
  });

  test('trashBatch returns trashed/failed split and total bytes', async () => {
    const fileA = path.join(testDir, 'a.txt');
    const fileB = path.join(testDir, 'b.txt');
    await fs.writeFile(fileA, 'aaaa'); // 4 bytes
    await fs.writeFile(fileB, 'bb'); // 2 bytes

    mockTrashItem.mockImplementation(async (p) => {
      if (p.endsWith('b.txt')) throw new Error('no');
    });

    const result = await service.trashBatch([fileA, fileB]);
    expect(result.trashed).toHaveLength(1);
    expect(result.trashed[0].path).toBe(path.resolve(fileA));
    expect(result.trashed[0].size).toBe(4);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].code).toBe('TRASH_FAILED');
    expect(result.totalBytes).toBe(4);
  });

  test('trashBatch rejects oversized batches', async () => {
    const small = new TrashService({ maxBatchSize: 2 });
    await expect(small.trashBatch(['/tmp/a', '/tmp/b', '/tmp/c'])).rejects.toThrow(
      /exceeds maximum/
    );
  });

  test('trashBatch handles empty input', async () => {
    const result = await service.trashBatch([]);
    expect(result.trashed).toEqual([]);
    expect(result.failed).toEqual([]);
    expect(result.totalBytes).toBe(0);
  });

  test('trashBatch continues after validation failure on one path', async () => {
    const good = path.join(testDir, 'good.txt');
    await fs.writeFile(good, 'ok');
    mockTrashItem.mockResolvedValue(undefined);
    const result = await service.trashBatch(['relative/bad.txt', good]);
    expect(result.trashed).toHaveLength(1);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].code).toBe('VALIDATION_ERROR');
    expect(mockTrashItem).toHaveBeenCalledTimes(1);
  });

  test('trashOne rejects relative paths via pathSanitization', async () => {
    await expect(service.trashOne('relative/path.txt')).rejects.toThrow();
    expect(mockTrashItem).not.toHaveBeenCalled();
  });

  test('trashBatch runs trash operations concurrently under the bound [P-008]', async () => {
    const files = [];
    for (let i = 0; i < 6; i++) {
      const f = path.join(testDir, `bulk-${i}.txt`);
      await fs.writeFile(f, 'x');
      files.push(f);
    }

    let inFlight = 0;
    let maxInFlight = 0;
    let releaseAll;
    const gate = new Promise((resolve) => {
      releaseAll = resolve;
    });
    mockTrashItem.mockImplementation(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight -= 1;
    });

    const bounded = new TrashService({ maxBatchSize: 100, concurrency: 3 });
    const resultPromise = bounded.trashBatch(files);

    // Wait until the pool has saturated its 3 slots (validation + stat are
    // real fs operations, so poll instead of counting microtask turns).
    await new Promise((resolve) => {
      const check = () => (mockTrashItem.mock.calls.length >= 3 ? resolve() : setTimeout(check, 5));
      check();
    });
    expect(inFlight).toBe(3);

    releaseAll();
    const result = await resultPromise;
    expect(maxInFlight).toBe(3); // bounded AND actually parallel (serial would be 1)
    expect(result.trashed).toHaveLength(6);
    expect(result.totalBytes).toBe(6);
  });

  test('trashBatch preserves input order in trashed/failed aggregation [P-008]', async () => {
    const files = [];
    for (let i = 0; i < 5; i++) {
      const f = path.join(testDir, `ord-${i}.txt`);
      await fs.writeFile(f, 'x');
      files.push(f);
    }

    // Later items finish first: completion order is reversed.
    let started = 0;
    mockTrashItem.mockImplementation(async () => {
      started += 1;
      await new Promise((resolve) => setTimeout(resolve, (6 - started) * 10));
    });

    const bounded = new TrashService({ maxBatchSize: 100, concurrency: 5 });
    const result = await bounded.trashBatch(files);
    expect(result.trashed.map((t) => t.path)).toEqual(files.map((f) => path.resolve(f)));
  });

  test('trashBatch refuses a directory: only files the finder indexed may be trashed', async () => {
    const dir = path.join(testDir, 'whole-folder');
    await fs.mkdir(dir);
    const file = path.join(testDir, 'dup.txt');
    await fs.writeFile(file, 'dup');
    mockTrashItem.mockResolvedValue(undefined);

    const result = await service.trashBatch([dir, file]);

    expect(result.trashed.map((t) => t.path)).toEqual([file]);
    expect(result.failed).toEqual([expect.objectContaining({ path: dir, code: 'NOT_A_FILE' })]);
    expect(mockTrashItem).toHaveBeenCalledTimes(1);
    expect(mockTrashItem).toHaveBeenCalledWith(file);
  });
});

// Windows keeps no Recycle Bin on a network share, so a file there must not
// reach shell.trashItem: it is reported as left in place instead.
describe('TrashService on a Windows network drive', () => {
  const originalPlatform = process.platform;
  let testDir;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `trash-net-test-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });
    jest.resetModules();
    mockTrashItem.mockReset();
    Object.defineProperty(process, 'platform', { value: 'win32' });
  });

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: originalPlatform });
    jest.restoreAllMocks();
    await fs.rm(testDir, { recursive: true, force: true }).catch(() => {});
  });

  test('a file on a drive mapped to a share is left in place with a clear reason', async () => {
    const file = path.join(testDir, 'shared-report.pdf');
    await fs.writeFile(file, 'x');
    // A mapped drive resolves to its \\server\share path.
    jest
      .spyOn(require('fs').promises, 'realpath')
      .mockResolvedValue('\\\\fileserver\\team\\shared-report.pdf');
    const { TrashService } = require('../src/main/services/TrashService');

    const one = await new TrashService().trashOne(file);
    const batch = await new TrashService().trashBatch([file]);

    expect(one).toMatchObject({ success: false, code: 'NETWORK_NO_RECYCLE_BIN' });
    expect(one.error).toMatch(/network drive/i);
    expect(batch.trashed).toEqual([]);
    expect(batch.failed[0].code).toBe('NETWORK_NO_RECYCLE_BIN');
    expect(mockTrashItem).not.toHaveBeenCalled();
  });

  test('isWindowsNetworkPath tells shares from local and device paths', async () => {
    const realpath = jest.spyOn(require('fs').promises, 'realpath');
    const { isWindowsNetworkPath } = require('../src/main/services/TrashService');
    const judge = async (p) => {
      realpath.mockResolvedValueOnce(p);
      return isWindowsNetworkPath(p);
    };

    expect(await judge('\\\\server\\share\\a.txt')).toBe(true);
    expect(await judge('//server/share/a.txt')).toBe(true);
    expect(await judge('\\\\?\\UNC\\server\\share\\a.txt')).toBe(true);
    expect(await judge('C:\\Users\\alex\\a.txt')).toBe(false);
    expect(await judge('\\\\?\\C:\\Users\\alex\\a.txt')).toBe(false);
    expect(await judge('\\\\.\\PhysicalDrive0')).toBe(false);
  });

  test('a local file still goes to the Recycle Bin', async () => {
    const file = path.join(testDir, 'local.txt');
    await fs.writeFile(file, 'x');
    mockTrashItem.mockResolvedValue(undefined);
    const { TrashService } = require('../src/main/services/TrashService');

    const result = await new TrashService().trashOne(file);

    expect(result.success).toBe(true);
    expect(mockTrashItem).toHaveBeenCalledTimes(1);
  });
});
