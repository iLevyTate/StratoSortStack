/**
 * @jest-environment jsdom
 *
 * Tests for the previewBatchOrganize helper added in
 * src/renderer/components/UndoRedoSystem.jsx. The helper is the
 * renderer-side wrapper around the dry-run path baked into
 * handleBatchOrganize on the main side — it MUST send dryRun: true
 * and route through electronAPI.files.performOperation, otherwise
 * the main handler runs the real batch with no preview.
 */

const performOperationMock = jest.fn();

beforeEach(() => {
  performOperationMock.mockReset();
  // jsdom doesn't provide window.electronAPI; install a stub for the test.
  global.window = global.window || {};
  global.window.electronAPI = {
    files: { performOperation: performOperationMock }
  };
  // crypto.randomUUID is available in modern jsdom but stub for determinism
  global.crypto = global.crypto || {};
  global.crypto.randomUUID = jest.fn(() => 'fixed-uuid');
});

afterEach(() => {
  delete global.window.electronAPI;
});

describe('previewBatchOrganize (renderer wrapper)', () => {
  test('sends dryRun:true through electronAPI.files.performOperation', async () => {
    performOperationMock.mockResolvedValue({
      success: true,
      dryRun: true,
      total: 2,
      wouldMove: [
        {
          source: '/in/a.pdf',
          destination: '/out/a.pdf',
          originalDestination: '/out/a.pdf',
          collision: false
        }
      ],
      skipped: [],
      wouldCreateFolders: ['/out'],
      conflicts: 0
    });

    const { previewBatchOrganize } = require('../src/renderer/components/UndoRedoSystem');
    const operations = [
      { source: '/in/a.pdf', destination: '/out/a.pdf' },
      { source: '/in/b.pdf', destination: '/out/b.pdf' }
    ];
    const result = await previewBatchOrganize(operations);

    expect(performOperationMock).toHaveBeenCalledTimes(1);
    const arg = performOperationMock.mock.calls[0][0];
    expect(arg.type).toBe('batch_organize');
    expect(arg.dryRun).toBe(true);
    expect(arg.operations).toBe(operations);
    expect(typeof arg.correlationId).toBe('string');
    expect(arg.correlationId).toMatch(/^org_preview_/);
    expect(result).toEqual(
      expect.objectContaining({
        success: true,
        dryRun: true,
        wouldCreateFolders: ['/out']
      })
    );
  });

  test('throws when the file API is unavailable so callers see the failure', async () => {
    delete global.window.electronAPI;
    const { previewBatchOrganize } = require('../src/renderer/components/UndoRedoSystem');
    await expect(previewBatchOrganize([])).rejects.toThrow(/File operations API not available/);
  });

  test('correlation id is unique per invocation (lets the main side dedupe)', async () => {
    performOperationMock.mockResolvedValue({});
    let counter = 0;
    global.crypto.randomUUID = () => `uuid-${++counter}`;
    const { previewBatchOrganize } = require('../src/renderer/components/UndoRedoSystem');
    await previewBatchOrganize([]);
    await previewBatchOrganize([]);
    const a = performOperationMock.mock.calls[0][0].correlationId;
    const b = performOperationMock.mock.calls[1][0].correlationId;
    expect(a).not.toBe(b);
  });

  test('every correlation id starts with the preview prefix (helps log filtering)', async () => {
    performOperationMock.mockResolvedValue({});
    let counter = 0;
    global.crypto.randomUUID = () => `uuid-${++counter}`;
    const { previewBatchOrganize } = require('../src/renderer/components/UndoRedoSystem');
    await previewBatchOrganize([]);
    await previewBatchOrganize([]);
    expect(performOperationMock.mock.calls[0][0].correlationId.startsWith('org_preview_')).toBe(
      true
    );
    expect(performOperationMock.mock.calls[1][0].correlationId.startsWith('org_preview_')).toBe(
      true
    );
  });
});
