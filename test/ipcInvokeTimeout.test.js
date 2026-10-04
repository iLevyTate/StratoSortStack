/**
 * @jest-environment node
 */
const { IPC_CHANNELS } = require('../src/shared/constants');

jest.mock('../src/shared/performanceConstants', () => ({
  LIMITS: { IPC_INVOKE_TIMEOUT: 1000 },
  TIMEOUTS: {
    DIRECTORY_SCAN: 2000,
    AI_ANALYSIS_LONG: 3000,
    AI_ANALYSIS_BATCH: 9999,
    TRIAGE_SCAN_LONG: 900000,
    USER_DIALOG: 600000
  }
}));

const { getIpcInvokeTimeout } = require('../src/shared/ipcInvokeTimeout');

describe('getIpcInvokeTimeout', () => {
  test('maps suggestions:get-batch to AI_ANALYSIS_BATCH (not long single-op budget)', () => {
    expect(getIpcInvokeTimeout(IPC_CHANNELS.SUGGESTIONS.GET_BATCH_SUGGESTIONS)).toBe(9999);
  });

  test('maps analysis:analyze-batch to AI_ANALYSIS_BATCH', () => {
    expect(getIpcInvokeTimeout(IPC_CHANNELS.ANALYSIS.ANALYZE_BATCH)).toBe(9999);
  });

  test('maps suggestions:get-file to AI_ANALYSIS_LONG', () => {
    expect(getIpcInvokeTimeout(IPC_CHANNELS.SUGGESTIONS.GET_FILE_SUGGESTIONS)).toBe(3000);
  });

  test('maps downloads triage start/deep-scan to TRIAGE_SCAN_LONG', () => {
    expect(getIpcInvokeTimeout(IPC_CHANNELS.DOWNLOADS.TRIAGE_START)).toBe(900000);
    expect(getIpcInvokeTimeout(IPC_CHANNELS.DOWNLOADS.TRIAGE_DEEP_SCAN)).toBe(900000);
  });

  test('maps every modal-dialog channel to USER_DIALOG, not the 30s default [F-159]', () => {
    // Pre-fix these got the default budget, so the preload raced the USER'S
    // OWN thinking time in the dialog: >30s of browsing rejected the invoke
    // (raw timeout shown in the UI) while the dialog stayed open and a late
    // Save/Open still executed — "failed" on screen, file written on disk.
    for (const channel of [
      IPC_CHANNELS.FILES.SELECT,
      IPC_CHANNELS.FILES.SELECT_DIRECTORY,
      IPC_CHANNELS.DOWNLOADS.TRIAGE_EXPORT_REPORT,
      IPC_CHANNELS.ANALYSIS_HISTORY.EXPORT,
      IPC_CHANNELS.ANALYSIS_HISTORY.EXPORT_TRANSCRIPT,
      IPC_CHANNELS.SETTINGS.EXPORT,
      IPC_CHANNELS.SETTINGS.IMPORT,
      IPC_CHANNELS.SYSTEM.EXPORT_LOGS
    ]) {
      expect(getIpcInvokeTimeout(channel)).toBe(600000);
    }
  });
});
