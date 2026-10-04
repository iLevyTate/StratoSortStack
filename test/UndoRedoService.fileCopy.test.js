/**
 * @jest-environment node
 */
/**
 * FILE_COPY undo/redo (P04-C).
 *
 * A user-initiated file copy is now recorded on the undo stack: undo trashes the
 * copied destination (the source is left untouched — no data loss), and redo
 * re-copies the source to the destination. TrashService wraps Electron's
 * shell.trashItem, which is unavailable under the test electron mock, so it is
 * mocked here to remove the file and record the call.
 */
jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const path = require('path');
const fs = require('fs').promises;
const os = require('os');

// Prefixed with `mock` so the jest.mock factory may reference it.
const mockTrashOne = jest.fn(async (/** @type {string} */ p) => {
  // Emulate a successful trash by removing the file from its location.
  await fs.rm(p, { force: true });
  return { success: true };
});
jest.mock('../src/main/services/TrashService', () => ({
  TrashService: class {
    trashOne = mockTrashOne;
  }
}));

jest.mock('electron', () => ({ app: { getPath: jest.fn() } }));

describe('UndoRedoService — FILE_COPY (P04-C)', () => {
  let UndoRedoService;
  let service;
  let testDir;

  beforeEach(async () => {
    testDir = path.join(
      os.tmpdir(),
      `undo-copy-test-${Date.now()}-${Math.random().toString(36).slice(2)}`
    );
    await fs.mkdir(testDir, { recursive: true });

    const electron = require('electron');
    electron.app.getPath.mockReturnValue(testDir);
    jest.resetModules();
    require('electron').app.getPath.mockReturnValue(testDir);

    UndoRedoService = require('../src/main/services/UndoRedoService');
    service = new UndoRedoService({
      maxActions: 10,
      maxMemoryMB: 1,
      maxBatchSize: 100,
      saveDebounceMs: 0
    });
    mockTrashOne.mockClear();
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
  });

  test('undo trashes the copied destination and leaves the source intact', async () => {
    const src = path.join(testDir, 'orig.txt');
    const dest = path.join(testDir, 'copy.txt');
    await fs.writeFile(src, 'hello');
    await fs.copyFile(src, dest); // the copy that the handler performed

    await service.recordAction('FILE_COPY', { originalPath: src, newPath: dest });
    expect(service.canUndo()).toBe(true);

    await service.undo();

    expect(mockTrashOne).toHaveBeenCalledWith(dest);
    await expect(fs.access(dest)).rejects.toBeDefined(); // copy removed
    await expect(fs.readFile(src, 'utf8')).resolves.toBe('hello'); // source untouched
  });

  test('redo re-copies the source to the destination', async () => {
    const src = path.join(testDir, 'orig.txt');
    const dest = path.join(testDir, 'copy.txt');
    await fs.writeFile(src, 'world');

    await service.recordAction('FILE_COPY', { originalPath: src, newPath: dest });
    await service.undo(); // dest absent -> reverse is a no-op break
    expect(service.canRedo()).toBe(true);

    await service.redo();
    await expect(fs.readFile(dest, 'utf8')).resolves.toBe('world');
  });

  test('describes the action as "Copy <file> to <dir>"', () => {
    const desc = service.getActionDescription('FILE_COPY', {
      originalPath: '/a/orig.txt',
      newPath: '/b/copy.txt'
    });
    expect(desc).toMatch(/^Copy orig\.txt to /);
  });
});
