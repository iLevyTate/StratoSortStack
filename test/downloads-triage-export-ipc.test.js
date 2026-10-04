jest.mock('electron', () => jest.requireActual('./mocks/electron'));

const mockService = {
  start: jest.fn(),
  deepScan: jest.fn(),
  act: jest.fn(),
  getReportRows: jest.fn(() => null),
  setSessionEvictionBroadcaster: jest.fn()
};

jest.mock('../src/main/services/triage/DownloadsTriageService', () => ({
  getDownloadsTriageService: () => mockService
}));

const { ipcMain, dialog } = require('electron');

describe('downloads triage export-report IPC', () => {
  beforeEach(() => {
    ipcMain._handlers.clear();
    ipcMain.handle.mockClear();
    dialog.showSaveDialog.mockClear();
    mockService.getReportRows.mockReset();
    jest.resetModules();
  });

  function register() {
    const registerDownloadsIpc = require('../src/main/ipc/downloads');
    const { IPC_CHANNELS } = require('../src/shared/constants');
    const logger = { error: jest.fn(), info: jest.fn(), warn: jest.fn(), debug: jest.fn() };
    registerDownloadsIpc({ ipcMain, IPC_CHANNELS, logger });
    return { IPC_CHANNELS };
  }

  test('act broadcasts FILE_OPERATION_COMPLETE for trashed and organized files [F-152]', async () => {
    // Pre-fix, triage trash/organize mutated disk without ever emitting the
    // event the renderer's graph/timeline listeners remap from — acted files
    // stayed in the UI pointing at their pre-triage paths. Goes through the
    // REAL safeSend, so this also pins the payloads against
    // fileOperationCompleteSchema (strict mode blocks invalid sends).
    mockService.act.mockResolvedValueOnce({
      success: true,
      trashed: [{ path: '/dl/junk.tmp' }],
      moved: [{ path: '/dl/keep.pdf', destination: '/docs/keep.pdf', size: 1 }]
    });
    const { IPC_CHANNELS } = register();
    const sender = { send: jest.fn(), isDestroyed: () => false };

    const handler = ipcMain._handlers.get(IPC_CHANNELS.DOWNLOADS.TRIAGE_ACT);
    const result = await handler(
      { sender },
      {
        triageId: 't1',
        action: 'trash',
        files: [{ path: '/dl/junk.tmp' }]
      }
    );

    expect(result.success).toBe(true);
    expect(sender.send).toHaveBeenCalledWith('file-operation-complete', {
      operation: 'delete',
      files: ['/dl/junk.tmp']
    });
    expect(sender.send).toHaveBeenCalledWith('file-operation-complete', {
      operation: 'move',
      files: ['/dl/keep.pdf'],
      destinations: ['/docs/keep.pdf']
    });
  });

  test('act does not broadcast when nothing was mutated [F-152]', async () => {
    mockService.act.mockResolvedValueOnce({
      success: false,
      error: 'No file paths belong to this triage session',
      errorCode: 'NOT_IN_SESSION'
    });
    const { IPC_CHANNELS } = register();
    const sender = { send: jest.fn(), isDestroyed: () => false };

    const handler = ipcMain._handlers.get(IPC_CHANNELS.DOWNLOADS.TRIAGE_ACT);
    await handler(
      { sender },
      {
        triageId: 't1',
        action: 'trash',
        files: [{ path: '/dl/other.tmp' }]
      }
    );

    expect(sender.send).not.toHaveBeenCalledWith('file-operation-complete', expect.anything());
  });

  test('returns error without dialog when session is gone', async () => {
    mockService.getReportRows.mockReturnValueOnce(null);
    const { IPC_CHANNELS } = register();
    const handler = ipcMain._handlers.get(IPC_CHANNELS.DOWNLOADS.TRIAGE_EXPORT_REPORT);
    const result = await handler(null, { triageId: 'gone' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/session/i);
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
  });

  test('returns error without dialog when session has no rows', async () => {
    mockService.getReportRows.mockReturnValueOnce([]);
    const { IPC_CHANNELS } = register();
    const handler = ipcMain._handlers.get(IPC_CHANNELS.DOWNLOADS.TRIAGE_EXPORT_REPORT);
    const result = await handler(null, { triageId: 't1' });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no triage results/i);
    expect(dialog.showSaveDialog).not.toHaveBeenCalled();
  });

  test('cancelling the save dialog writes nothing and reports canceled [F-184]', async () => {
    mockService.getReportRows.mockReturnValueOnce([
      {
        fileName: 'a.pdf',
        filePath: '/dl/a.pdf',
        bucket: 'keep',
        confidence: 0.9,
        signal: 's',
        why: 'w',
        sizeBytes: 1,
        modifiedIso: '2026-01-01T00:00:00.000Z',
        suggestedFolderPath: ''
      }
    ]);
    const { IPC_CHANNELS } = register();
    const fs = require('fs');
    const writeSpy = jest.spyOn(fs.promises, 'writeFile');
    dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: undefined });

    const handler = ipcMain._handlers.get(IPC_CHANNELS.DOWNLOADS.TRIAGE_EXPORT_REPORT);
    const result = await handler(null, { triageId: 't1' });

    expect(result).toMatchObject({ success: false, canceled: true });
    expect(writeSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
  });

  test('writes CSV to the chosen path on success', async () => {
    mockService.getReportRows.mockReturnValueOnce([
      {
        fileName: 'a.pdf',
        filePath: 'C:/dl/a.pdf',
        bucket: 'keep',
        confidence: 0.9,
        signal: 's',
        why: 'w',
        sizeBytes: 1,
        modifiedIso: '2026-01-01T00:00:00.000Z',
        suggestedFolderPath: ''
      }
    ]);
    const { IPC_CHANNELS } = register();
    const fs = require('fs');
    const writeSpy = jest.spyOn(fs.promises, 'writeFile').mockResolvedValueOnce(undefined);
    dialog.showSaveDialog.mockResolvedValueOnce({
      canceled: false,
      filePath: 'C:/out/report.csv'
    });

    const handler = ipcMain._handlers.get(IPC_CHANNELS.DOWNLOADS.TRIAGE_EXPORT_REPORT);
    const result = await handler(null, { triageId: 't1' });

    expect(result).toMatchObject({ success: true, filePath: 'C:/out/report.csv' });
    expect(writeSpy).toHaveBeenCalledWith(
      'C:/out/report.csv',
      expect.stringMatching(
        /^fileName,filePath,bucket,confidence,signal,why,sizeBytes,modifiedIso,suggestedFolderPath\na\.pdf,/
      ),
      'utf8'
    );
    writeSpy.mockRestore();
  });
});
