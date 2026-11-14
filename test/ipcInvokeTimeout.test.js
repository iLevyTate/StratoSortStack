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
    ANALYSIS_RUN_MAX: 50000,
    GLOBAL_ANALYSIS: 1000,
    TRIAGE_SCAN_LONG: 900000,
    USER_DIALOG: 600000
  }
}));

const { getIpcInvokeTimeout } = require('../src/shared/ipcInvokeTimeout');

describe('getIpcInvokeTimeout', () => {
  test('maps suggestions:get-batch to AI_ANALYSIS_BATCH (not long single-op budget)', () => {
    expect(getIpcInvokeTimeout(IPC_CHANNELS.SUGGESTIONS.GET_BATCH_SUGGESTIONS)).toBe(9999);
  });

  // One request carries a whole Discover run. With the 30-minute batch
  // budget, every longer run was cancelled in main and finished per file.
  test('gives analysis:analyze-batch the run cap plus a margin, not the batch budget', () => {
    expect(getIpcInvokeTimeout(IPC_CHANNELS.ANALYSIS.ANALYZE_BATCH)).toBe(50000 + 3 * 1000);
  });

  test('the batch request outlasts the longest run the renderer allows', () => {
    jest.isolateModules(() => {
      jest.doMock('../src/shared/performanceConstants', () =>
        jest.requireActual('../src/shared/performanceConstants')
      );
      const { TIMEOUTS } = require('../src/shared/performanceConstants');
      const real = require('../src/shared/ipcInvokeTimeout');
      // useAnalysis gives its own wait the hard cap plus two watchdog windows.
      const longestRendererWait = TIMEOUTS.ANALYSIS_RUN_MAX + 2 * TIMEOUTS.GLOBAL_ANALYSIS;
      expect(real.getIpcInvokeTimeout(IPC_CHANNELS.ANALYSIS.ANALYZE_BATCH)).toBeGreaterThan(
        longestRendererWait
      );
      expect(real.getIpcInvokeTimeout(IPC_CHANNELS.SUGGESTIONS.GET_BATCH_SUGGESTIONS)).toBe(
        TIMEOUTS.AI_ANALYSIS_BATCH
      );
    });
  });

  // One request carries a whole organize batch (up to 1000 moves, possibly
  // large files going to another drive). With the 5-minute AI budget the
  // preload told main to stop a batch that was still moving files and the
  // user saw a timeout; the rest only moved at the next launch.
  test('does not put files:perform-operation on the AI budget or any other short one', () => {
    expect(getIpcInvokeTimeout(IPC_CHANNELS.FILES.PERFORM_OPERATION)).not.toBe(3000);
    jest.isolateModules(() => {
      jest.doMock('../src/shared/performanceConstants', () =>
        jest.requireActual('../src/shared/performanceConstants')
      );
      const { TIMEOUTS } = require('../src/shared/performanceConstants');
      const real = require('../src/shared/ipcInvokeTimeout');
      const budget = real.getIpcInvokeTimeout(IPC_CHANNELS.FILES.PERFORM_OPERATION);
      expect(budget).toBe(real.FILE_OPERATION_INVOKE_TIMEOUT_MS);
      expect(budget).toBeGreaterThan(TIMEOUTS.AI_ANALYSIS_LONG);
      expect(budget).toBeGreaterThanOrEqual(real.ANALYZE_BATCH_INVOKE_TIMEOUT_MS);
      // setTimeout fires at once for a delay above 2^31 - 1.
      expect(budget).toBeLessThanOrEqual(2 ** 31 - 1);
    });
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
      IPC_CHANNELS.FILES.EXPORT_ORGANIZE_REPORT,
      IPC_CHANNELS.ANALYSIS_HISTORY.EXPORT,
      IPC_CHANNELS.ANALYSIS_HISTORY.EXPORT_TRANSCRIPT,
      IPC_CHANNELS.SETTINGS.EXPORT,
      IPC_CHANNELS.SETTINGS.IMPORT,
      IPC_CHANNELS.SYSTEM.EXPORT_LOGS
    ]) {
      expect(getIpcInvokeTimeout(channel)).toBe(600000);
    }
  });

  test('maps live-log subscribe/unsubscribe to a 5 s budget, not the default', () => {
    // The renderer waits for the previous unsubscribe before subscribing again;
    // a stuck release must not hold a reconnect for the full default budget.
    expect(getIpcInvokeTimeout(IPC_CHANNELS.SYSTEM.LIVE_LOG_SUBSCRIBE)).toBe(5000);
    expect(getIpcInvokeTimeout(IPC_CHANNELS.SYSTEM.LIVE_LOG_UNSUBSCRIBE)).toBe(5000);
    expect(getIpcInvokeTimeout(IPC_CHANNELS.SYSTEM.GET_METRICS)).toBe(1000);
  });

  test('gives the VC++ runtime install more than the 10 min main-process ceiling, not USER_DIALOG', () => {
    // Equal budgets let the preload time out while main was still waiting on
    // vc_redist, which kept running; a retry then hit exit code 1618.
    expect(getIpcInvokeTimeout(IPC_CHANNELS.SYSTEM.INSTALL_VC_RUNTIME)).toBe(11 * 60 * 1000);
    expect(getIpcInvokeTimeout(IPC_CHANNELS.SYSTEM.INSTALL_VC_RUNTIME)).toBeGreaterThan(600000);
  });
});
