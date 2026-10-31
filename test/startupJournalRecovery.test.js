/**
 * Bootstrap contract: crash-journal recovery must run during main-process
 * startup, before any service reads or mutates userData.
 *
 * The recovery behavior itself is covered by
 * test/atomicFileOperations.recovery.test.js. What that suite cannot catch is the
 * wiring being dropped from src/main/simple-main.js (e.g. during a startup
 * refactor) — files half-written at crash time would then never be rolled
 * back. Booting real Electron in Jest is not practical, so this asserts the
 * contract statically against the bootstrap source.
 */
// The global Jest setup swaps `fs` for memfs; the bootstrap source lives on
// the real disk, so use the unmocked module.
const fs = jest.requireActual('fs');
const path = require('path');

const SIMPLE_MAIN_PATH = path.resolve(__dirname, '..', 'src', 'main', 'simple-main.js');

describe('startup journal recovery wiring', () => {
  let source;

  beforeAll(() => {
    source = fs.readFileSync(SIMPLE_MAIN_PATH, 'utf8');
  });

  test('bootstrap configures atomic file operations with userData directories', () => {
    expect(source).toMatch(/configureAtomicFileOperations\s*\(/);
    expect(source).toMatch(/journalBaseDirectory:\s*app\.getPath\(['"]userData['"]\)/);
    // Backups must colocate with userData: fs.rename across volumes throws
    // EXDEV on Windows, breaking the backup-and-replace atomicity invariant.
    expect(source).toMatch(/backupBaseDirectory:\s*app\.getPath\(['"]userData['"]\)/);
  });

  test('bootstrap awaits recoverFromJournals()', () => {
    expect(source).toMatch(/await\s+recoverFromJournals\s*\(\s*\)/);
  });

  test('journal recovery runs before user-data migration and service construction', () => {
    const recoveryIndex = source.indexOf('await recoverFromJournals');
    const migrationIndex = source.indexOf('await migrateUserDataState');
    const serviceIndex = source.indexOf('new ServiceIntegration');

    expect(recoveryIndex).toBeGreaterThan(-1);
    expect(migrationIndex).toBeGreaterThan(-1);
    expect(serviceIndex).toBeGreaterThan(-1);
    expect(recoveryIndex).toBeLessThan(migrationIndex);
    expect(recoveryIndex).toBeLessThan(serviceIndex);
  });

  test('window is created before the first-paint gate, which precedes coordinated startup', () => {
    // Pins the window-first ordering: heavyweight AI bring-up must not be
    // queued in the same tick as createWindow(); it waits on the first-paint
    // gate (core/firstPaintGate.js) so its synchronous stretches cannot delay
    // the first visible frame.
    const windowIndex = source.indexOf('createWindow();');
    const gateIndex = source.indexOf('waitForFirstPaint(');
    const coordinatedIndex = source.indexOf('await runCoordinatedStartupInBackground(');

    expect(windowIndex).toBeGreaterThan(-1);
    expect(gateIndex).toBeGreaterThan(-1);
    expect(coordinatedIndex).toBeGreaterThan(-1);
    expect(windowIndex).toBeLessThan(gateIndex);
    expect(gateIndex).toBeLessThan(coordinatedIndex);
  });

  test('background setup is chained onto the first-paint gate', () => {
    const gateIndex = source.indexOf('waitForFirstPaint(');
    const backgroundSetupIndex = source.indexOf('runBackgroundSetup();');
    const coordinatedIndex = source.indexOf('await runCoordinatedStartupInBackground(');

    expect(backgroundSetupIndex).toBeGreaterThan(gateIndex);
    expect(backgroundSetupIndex).toBeLessThan(coordinatedIndex);
    // Exactly one call site: the pre-gate call was removed, not duplicated.
    expect(source.match(/runBackgroundSetup\(\);/g)).toHaveLength(1);
  });
});

describe('startup and shutdown wiring around the window', () => {
  let source;

  beforeAll(() => {
    source = fs.readFileSync(SIMPLE_MAIN_PATH, 'utf8');
  });

  test('single-instance lock follows the app name and userData setup and precedes the heavy requires', () => {
    // Electron keys the lock to the app name and the userData directory, so
    // it must come after both; a duplicate launch should exit before the
    // service, analysis and IPC graph is evaluated.
    const lockIndex = source.indexOf('app.requestSingleInstanceLock()');
    const refusalExitIndex = source.indexOf('app.exit(0);');
    expect(source.match(/app\.requestSingleInstanceLock\(\)/g)).toHaveLength(1);
    expect(lockIndex).toBeGreaterThan(source.indexOf("require('dotenv')"));
    expect(lockIndex).toBeGreaterThan(source.indexOf("app.name = 'StratoSort Stack'"));
    expect(lockIndex).toBeGreaterThan(source.indexOf("app.setPath('userData'"));
    expect(refusalExitIndex).toBeGreaterThan(lockIndex);

    for (const heavyRequire of [
      "require('./errors/ErrorHandler')",
      "require('./services/ServiceIntegration')",
      "require('./analysis/documentAnalysis')",
      "require('./core/gpuConfig')",
      "require('./core/createWindow')",
      "require('./ipc');"
    ]) {
      const requireIndex = source.indexOf(heavyRequire);
      expect(requireIndex).toBeGreaterThan(-1);
      expect(requireIndex).toBeGreaterThan(refusalExitIndex);
    }
  });

  test('a launch during shutdown requests a relaunch instead of a window', () => {
    const handlerIndex = source.indexOf('const secondInstanceHandler');
    const shutdownCheck = source.indexOf('if (_shutdownState.shouldClose)', handlerIndex);
    const relaunchCall = source.indexOf(
      "requestRelaunchAfterShutdown('second-instance')",
      handlerIndex
    );
    const createCall = source.indexOf('createWindow();', handlerIndex);

    expect(handlerIndex).toBeGreaterThan(-1);
    expect(shutdownCheck).toBeGreaterThan(handlerIndex);
    expect(relaunchCall).toBeGreaterThan(shutdownCheck);
    expect(relaunchCall).toBeLessThan(createCall);
    // lifecycle runs eventListeners cleanups in its first shutdown phase; the
    // handler must stay registered to see launches during the later phases.
    expect(source).not.toMatch(/removeListener\(\s*'second-instance'/);
  });

  test('old-log and crash-dump sweeps run after first paint, never before the window', () => {
    expect(source).not.toMatch(/await\s+errorHandler\.cleanup(Logs|CrashDumps)\(/);
    const windowIndex = source.indexOf("perfMarks.mark('startup:main:after-window')");
    const gateIndex = source.indexOf('waitForFirstPaint(');
    const sweepIndex = source.indexOf('sweepOldLogsAndCrashDumps();');
    const coordinatedIndex = source.indexOf('await runCoordinatedStartupInBackground(');

    expect(windowIndex).toBeGreaterThan(-1);
    expect(sweepIndex).toBeGreaterThan(windowIndex);
    expect(sweepIndex).toBeGreaterThan(gateIndex);
    expect(sweepIndex).toBeLessThan(coordinatedIndex);
    expect(source.match(/sweepOldLogsAndCrashDumps\(\);/g)).toHaveLength(1);
  });

  test('a degraded startup still sweeps old logs and crash dumps and schedules the GPU flag check', () => {
    // A launch that keeps failing (crash loop, broken userData file) is when
    // logs and dumps pile up; the degraded branch must not skip the sweep.
    const degradedIndex = source.indexOf(
      "logger.warn('[STARTUP] Creating window in degraded mode due to startup errors')"
    );
    expect(degradedIndex).toBeGreaterThan(-1);
    const degradedWindow = source.indexOf('createWindow();', degradedIndex);
    const degradedSweep = source.indexOf(
      'trackTimeout(sweepOldLogsAndCrashDumps, TIMEOUTS.FIRST_PAINT_GATE);',
      degradedIndex
    );
    const degradedGpuClear = source.indexOf('scheduleGpuFallbackClear();', degradedIndex);
    expect(degradedSweep).toBeGreaterThan(degradedWindow);
    expect(degradedGpuClear).toBeGreaterThan(degradedWindow);
    // One call on the normal path (after the window), one in the degraded branch.
    expect(source.match(/scheduleGpuFallbackClear\(\);/g)).toHaveLength(2);
    expect(source.indexOf('scheduleGpuFallbackClear();')).toBeGreaterThan(
      source.indexOf("perfMarks.mark('startup:main:after-window')")
    );
  });

  test('the default Uncategorized folder can no longer abort startup', () => {
    expect(source).not.toMatch(/Failed to create default Uncategorized folder/);
    expect(source).toMatch(/await createDefaultUncategorizedFolder\(\)/);
    const folderIndex = source.indexOf('await createDefaultUncategorizedFolder()');
    expect(folderIndex).toBeLessThan(
      source.indexOf("perfMarks.mark('startup:main:before-window')")
    );
  });

  test('GPU: no raster switches, and the sticky fallback is cleared on a stable-run timer', () => {
    expect(source).not.toMatch(/appendSwitch\('enable-(gpu-rasterization|zero-copy)'\)/);
    expect(source).toMatch(/clearGpuFallbackAfterStableRun\(\);/);
    expect(source).toMatch(/TIMEOUTS\.GPU_FALLBACK_STABLE_RUN/);
    expect(source).toMatch(/isFirstShowPending: \(\) => mainWindowFirstShowPending/);
  });
});
