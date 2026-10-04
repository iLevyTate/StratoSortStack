/**
 * @jest-environment node
 */
/**
 * Tests for UndoRedoService.recordBatch (new in Phase 1) and the TRASH_BATCH
 * undo semantics — a trashed batch records ONE undo entry and its reverse
 * operation surfaces a structured "restore from system trash" result rather
 * than silently succeeding.
 */

jest.unmock('fs');
jest.unmock('fs/promises');
jest.unmock('os');

const path = require('path');
const fs = require('fs').promises;
const os = require('os');

jest.mock('electron', () => ({
  app: { getPath: jest.fn() },
  shell: { trashItem: jest.fn().mockResolvedValue(undefined) }
}));

describe('UndoRedoService.recordBatch', () => {
  let UndoRedoService;
  let service;
  let testDir;

  beforeEach(async () => {
    testDir = path.join(os.tmpdir(), `batch-undo-${Date.now()}`);
    await fs.mkdir(testDir, { recursive: true });

    const electron = require('electron');
    electron.app.getPath.mockReturnValue(testDir);
    jest.resetModules();
    const electronAfter = require('electron');
    electronAfter.app.getPath.mockReturnValue(testDir);

    UndoRedoService = require('../src/main/services/UndoRedoService');
    service = new UndoRedoService({ maxActions: 10, saveDebounceMs: 0 });
  });

  afterEach(async () => {
    try {
      await fs.rm(testDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  });

  test('recordBatch writes exactly one undo entry for N operations', async () => {
    const ops = [
      { type: 'trash', originalPath: path.join(testDir, 'a.txt') },
      { type: 'trash', originalPath: path.join(testDir, 'b.txt') },
      { type: 'trash', originalPath: path.join(testDir, 'c.txt') }
    ];
    await service.recordBatch('TRASH_BATCH', ops, {
      summary: { label: 'Delete duplicates', tier: 'exact' }
    });

    const history = service.getActionHistory(10);
    expect(history).toHaveLength(1);
    expect(history[0].type).toBe('TRASH_BATCH');
    expect(history[0].description).toMatch(/Delete duplicates.*3 files/);
  });

  // F-202 (K-12): undoing a batch organize retracts the learning feedback the
  // batch recorded for each file that actually moved back.
  test('undo of a BATCH_ORGANIZE retracts learning feedback for every reverted move', async () => {
    const { container, ServiceIds } = require('../src/main/services/ServiceContainer');
    const learning = { retractFileFeedback: jest.fn().mockResolvedValue({}) };
    container.registerSingleton(ServiceIds.LEARNING_FEEDBACK, () => learning);
    try {
      const srcDir = path.join(testDir, 'in');
      const destDir = path.join(testDir, 'Finance');
      await fs.mkdir(srcDir, { recursive: true });
      await fs.mkdir(destDir, { recursive: true });
      const ops = [];
      for (const name of ['a.txt', 'b.txt']) {
        const originalPath = path.join(srcDir, name);
        const newPath = path.join(destDir, name);
        await fs.writeFile(newPath, name); // the batch already moved them
        ops.push({ type: 'move', originalPath, newPath });
      }
      await service.recordAction('BATCH_ORGANIZE', { operations: ops });

      const response = await service.undo();

      expect(response.success).toBe(true);
      expect(learning.retractFileFeedback).toHaveBeenCalledTimes(2);
      for (const op of ops) {
        expect(learning.retractFileFeedback).toHaveBeenCalledWith(op.newPath);
        await expect(fs.access(op.originalPath)).resolves.toBeUndefined();
      }
    } finally {
      if (typeof container.unregister === 'function')
        container.unregister(ServiceIds.LEARNING_FEEDBACK);
    }
  });

  test('recordBatch rejects empty operations', async () => {
    await expect(service.recordBatch('TRASH_BATCH', [])).rejects.toThrow(
      /non-empty operations array/
    );
  });

  test('undo on TRASH_BATCH restores nothing, says so, and drops the entry (UR-14)', async () => {
    const ops = [
      { type: 'trash', originalPath: path.join(testDir, 'x.txt') },
      { type: 'trash', originalPath: path.join(testDir, 'y.txt') }
    ];
    await service.recordBatch('TRASH_BATCH', ops);

    const response = await service.undo();
    // Electron cannot restore from the OS Trash; the old response claimed
    // "Undid: Send 2 files to Trash" with success: true.
    expect(response.success).toBe(false);
    expect(response.code).toBe('TRASH_NO_RESTORE');
    expect(response.removedFromHistory).toBe(true);
    expect(response.message).toMatch(/Nothing restored: 2 files are in the system Trash/);
    expect(response.successCount).toBe(0);
    expect(response.failCount).toBe(0);
    expect(response.results).toHaveLength(2);
    for (const r of response.results) {
      expect(r.success).toBe(false);
      expect(r.code).toBe('TRASH_NO_RESTORE');
      expect(r.error).toMatch(/system Trash/i);
    }
  });

  test('undo on TRASH_BATCH leaves nothing to redo: the entry is gone', async () => {
    const ops = [{ type: 'trash', originalPath: path.join(testDir, 'x.txt') }];
    await service.recordBatch('TRASH_BATCH', ops);
    expect(service.canUndo()).toBe(true);

    await service.undo();
    expect(service.canUndo()).toBe(false);
    expect(service.canRedo()).toBe(false);
    expect(service.actions).toHaveLength(0);
    await expect(service.redo()).rejects.toThrow('No actions to redo');
  });

  test('two TRASH_BATCH entries are removed one undo at a time, newest first', async () => {
    await service.recordBatch('TRASH_BATCH', [
      { type: 'trash', originalPath: path.join(testDir, 'a.txt') }
    ]);
    await service.recordBatch('TRASH_BATCH', [
      { type: 'trash', originalPath: path.join(testDir, 'b.txt') }
    ]);
    expect(service.currentIndex).toBe(1);

    const first = await service.undo();
    expect(first.code).toBe('TRASH_NO_RESTORE');
    expect(first.results[0].originalPath).toBe(path.join(testDir, 'b.txt'));
    expect(service.actions).toHaveLength(1);
    expect(service.currentIndex).toBe(0);

    const second = await service.undo();
    expect(second.code).toBe('TRASH_NO_RESTORE');
    expect(second.results[0].originalPath).toBe(path.join(testDir, 'a.txt'));
    expect(service.actions).toHaveLength(0);
    expect(service.canUndo()).toBe(false);
  });
});
