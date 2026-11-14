'use strict';

/**
 * files:export-organize-report saves an organize run's file list as CSV in a
 * place the user picks. A cancelled dialog writes nothing.
 */

const mockHandlers = new Map();
jest.mock('../../../src/main/ipc/ipcWrappers', () => {
  const actual = jest.requireActual('../../../src/main/ipc/ipcWrappers');
  return {
    ...actual,
    safeHandle: jest.fn((_ipcMain, channel, handler) => {
      mockHandlers.set(channel, handler);
    })
  };
});

const mockSafeWriteFile = jest.fn(async () => undefined);
jest.mock('../../../src/shared/atomicFileOperations', () => ({
  safeWriteFile: (...args) => mockSafeWriteFile(...args)
}));

const {
  registerReportHandlers,
  exportOrganizeReportSchema,
  defaultReportName
} = require('../../../src/main/ipc/files/reportHandlers');
const { IPC_CHANNELS } = require('../../../src/shared/constants');

const row = {
  name: 'a.csv',
  originalPath: '/in/a.csv',
  finalPath: '/out/a.csv',
  outcome: 'moved',
  reason: ''
};

function setup(dialogResult) {
  mockHandlers.clear();
  const dialog = { showSaveDialog: jest.fn(async () => dialogResult) };
  const win = { id: 1 };
  registerReportHandlers({
    core: { ipcMain: {} },
    electron: { dialog, getMainWindow: () => win }
  });
  return {
    handler: mockHandlers.get(IPC_CHANNELS.FILES.EXPORT_ORGANIZE_REPORT),
    dialog,
    win
  };
}

describe('files:export-organize-report', () => {
  beforeEach(() => jest.clearAllMocks());

  test('a cancelled dialog writes nothing', async () => {
    const { handler } = setup({ canceled: true });
    await expect(handler({}, { rows: [row] })).resolves.toEqual({
      success: false,
      canceled: true
    });
    expect(mockSafeWriteFile).not.toHaveBeenCalled();
  });

  test('a save writes the CSV atomically and says how many rows it holds', async () => {
    const { handler, dialog, win } = setup({ canceled: false, filePath: 'C:\\Out\\r.csv' });
    const result = await handler({}, { rows: [row, { ...row, name: 'b.csv' }] });

    expect(result).toEqual({ success: true, filePath: 'C:\\Out\\r.csv', rowCount: 2 });
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(
      win,
      expect.objectContaining({
        title: 'Save organize results',
        filters: [{ name: 'CSV Files', extensions: ['csv'] }]
      })
    );
    const [writtenPath, csv] = mockSafeWriteFile.mock.calls[0];
    expect(writtenPath).toBe('C:\\Out\\r.csv');
    expect(csv).toContain('File,Outcome,Details,Original location,Final location');
    expect(csv).toContain('b.csv,Moved,,/in/a.csv,/out/a.csv');
  });

  test('a failed write is reported, not thrown', async () => {
    mockSafeWriteFile.mockRejectedValueOnce(new Error('EACCES: permission denied'));
    const { handler } = setup({ canceled: false, filePath: '/ro/r.csv' });
    await expect(handler({}, { rows: [row] })).resolves.toEqual({
      success: false,
      error: 'EACCES: permission denied'
    });
  });

  test('the payload is checked before the dialog opens', async () => {
    const { handler, dialog } = setup({ canceled: false, filePath: '/r.csv' });
    const result = await handler({}, { rows: [{ ...row, outcome: 'deleted' }] });
    expect(result.success).toBe(false);
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
  });

  test('the schema refuses an unknown outcome, an empty list and too many rows', () => {
    expect(exportOrganizeReportSchema.safeParse({ rows: [row] }).success).toBe(true);
    expect(
      exportOrganizeReportSchema.safeParse({ rows: [{ ...row, finalPath: null }] }).success
    ).toBe(true);
    expect(
      exportOrganizeReportSchema.safeParse({ rows: [{ ...row, outcome: 'deleted' }] }).success
    ).toBe(false);
    expect(exportOrganizeReportSchema.safeParse({ rows: [] }).success).toBe(false);
    expect(exportOrganizeReportSchema.safeParse({ rows: Array(10001).fill(row) }).success).toBe(
      false
    );
  });

  test('the suggested name carries the local date', () => {
    expect(defaultReportName(new Date(2026, 10, 3))).toBe(
      'stratosort-organize-results-2026-11-03.csv'
    );
  });
});
