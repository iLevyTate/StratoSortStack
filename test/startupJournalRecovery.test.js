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
});
