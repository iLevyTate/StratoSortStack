/**
 * folderScanner: macOS AppleDouble (._*), Office lock (~$*) files and volume
 * system folders are not documents, so a folder scan must not return them.
 * A permission error on the folder the user chose is reported in __scanMeta
 * so the caller can say "StratoSort is not allowed to open this folder"
 * instead of "No files found".
 */

const fs = require('fs').promises;

jest.mock('../../src/shared/logger', () => ({
  createLogger: jest.fn(() => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  }))
}));

const { scanDirectory } = require('../../src/main/folderScanner');

function mockDirent(name, isDir = false) {
  return {
    name,
    isDirectory: () => isDir,
    isFile: () => !isDir,
    isSymbolicLink: () => false
  };
}

describe('folderScanner skips system and lock files', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('AppleDouble ._ files and Office ~$ lock files are not returned', async () => {
    jest
      .spyOn(fs, 'readdir')
      .mockResolvedValue([
        mockDirent('Report.pdf'),
        mockDirent('._Report.pdf'),
        mockDirent('~$data.xlsx'),
        mockDirent('data.xlsx')
      ]);

    const results = await scanDirectory('/Volumes/SSD/exports', undefined, {
      includeStats: false
    });

    expect(results.map((r) => r.name)).toEqual(['Report.pdf', 'data.xlsx']);
    expect(results.__scanMeta.filesIncluded).toBe(2);
  });

  test('volume system folders at the root are not entered', async () => {
    const readdir = jest
      .spyOn(fs, 'readdir')
      .mockResolvedValue([
        mockDirent('.Spotlight-V100', true),
        mockDirent('.Trashes', true),
        mockDirent('.fseventsd', true),
        mockDirent('.TemporaryItems', true),
        mockDirent('.DocumentRevisions-V100', true),
        mockDirent('$RECYCLE.BIN', true),
        mockDirent('System Volume Information', true),
        mockDirent('.DS_Store'),
        mockDirent('gsc.xlsx')
      ]);

    const results = await scanDirectory('/Volumes/SSD', undefined, { includeStats: false });

    expect(readdir).toHaveBeenCalledTimes(1);
    expect(results.map((r) => r.name)).toEqual(['gsc.xlsx']);
  });

  test('a folder whose name looks like a lock file is still entered', async () => {
    const readdir = jest
      .spyOn(fs, 'readdir')
      .mockResolvedValueOnce([mockDirent('~$folder', true)])
      .mockResolvedValueOnce([mockDirent('inside.pdf')]);

    const results = await scanDirectory('/data', undefined, { includeStats: false });

    expect(readdir).toHaveBeenCalledTimes(2);
    expect(results[0].children.map((c) => c.name)).toEqual(['inside.pdf']);
  });
});

describe('folderScanner reports a blocked root folder', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('EPERM on the chosen folder sets __scanMeta.rootError and keeps the error node', async () => {
    const err = Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
    jest.spyOn(fs, 'readdir').mockRejectedValue(err);

    const results = await scanDirectory('/Volumes/SSD');

    expect(results.__scanMeta.rootError).toBe('EPERM');
    expect(results).toHaveLength(1);
    expect(results[0].error).toBe('Permission Denied');
    // Non-enumerable, so callers that serialize the array are unaffected.
    expect(Object.keys(results)).toEqual(['0']);
  });

  test('EACCES on the chosen folder sets rootError EACCES', async () => {
    const err = Object.assign(new Error('Permission denied'), { code: 'EACCES' });
    jest.spyOn(fs, 'readdir').mockRejectedValue(err);

    const results = await scanDirectory('/private');

    expect(results.__scanMeta.rootError).toBe('EACCES');
  });

  test('EPERM on a child folder does not set rootError', async () => {
    const err = Object.assign(new Error('Operation not permitted'), { code: 'EPERM' });
    jest
      .spyOn(fs, 'readdir')
      .mockResolvedValueOnce([mockDirent('locked', true), mockDirent('a.pdf')])
      .mockRejectedValueOnce(err);

    const results = await scanDirectory('/data', undefined, { includeStats: false });

    expect(results.__scanMeta.rootError).toBeUndefined();
    const locked = results.find((r) => r.name === 'locked');
    expect(locked.children[0].error).toBe('Permission Denied');
  });
});
