/**
 * Regression coverage for the crash-dump README that ships inside every
 * exported log zip. The README is the user-facing contract explaining what
 * we DID NOT include, why, and how long dumps are retained locally. If it
 * silently drifts from ErrorHandler.cleanupCrashDumps defaults, users will
 * get wrong retention information when they share a zip with support.
 */

jest.unmock('../src/shared/logger');

const {
  buildCrashDumpReadme,
  CRASH_DUMP_RETENTION_DAYS,
  CRASH_DUMP_MAX_FILES
} = require('../src/main/workers/logExportWorker');

describe('logExportWorker crash-dump README', () => {
  test('documents that binary dumps are NOT shared', () => {
    const body = buildCrashDumpReadme();
    expect(body).toMatch(/NOT included/);
    expect(body).toMatch(/\.dmp/);
  });

  test('documents uploadToServer: false (local-only posture)', () => {
    const body = buildCrashDumpReadme();
    expect(body).toMatch(/uploadToServer:\s*false/);
  });

  test('states retention days and max-files values', () => {
    const body = buildCrashDumpReadme();
    expect(body).toContain(`${CRASH_DUMP_RETENTION_DAYS} days`);
    expect(body).toContain(`${CRASH_DUMP_MAX_FILES} files`);
  });

  test('mentions that support provides out-of-band instructions', () => {
    const body = buildCrashDumpReadme();
    expect(body).toMatch(/out-of-band/);
  });

  test('defaults match ErrorHandler.cleanupCrashDumps retention contract', () => {
    // If this fails, update BOTH:
    //   src/main/errors/ErrorHandler.js (cleanupCrashDumps defaults)
    //   src/main/workers/logExportWorker.js (CRASH_DUMP_* constants)
    // so the README users see stays truthful.
    expect(CRASH_DUMP_RETENTION_DAYS).toBe(30);
    expect(CRASH_DUMP_MAX_FILES).toBe(20);
  });
});
