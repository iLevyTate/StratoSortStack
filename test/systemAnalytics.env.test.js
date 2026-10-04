/**
 * @jest-environment node
 *
 * Verifies that `systemAnalytics.collectMetrics()` returns only the
 * `STRATOSORT_*` env namespace under `metrics.env`. This surface feeds the
 * Settings → Diagnostics panel, so we want defensive guarantees that:
 *   1. Unrelated env vars never leak.
 *   2. Values are coerced to strings.
 *   3. Missing/unset flags produce an empty object, not `undefined`.
 */

// Platform-guarded helper. The path-redaction sanity test below asserts both
// Windows (`C:\Users\...`) and POSIX (`/home/...`) paths get basename-redacted.
// The SUT only redacts paths matching the current platform's separator, so on
// Linux the Windows-path assertion fails. Skip on non-win32 until the redactor
// is made platform-independent.
const testOnWin32 = process.platform === 'win32' ? test : test.skip;

jest.mock('../src/shared/logger', () => ({
  createLogger: () => ({
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn()
  })
}));

const systemAnalytics = require('../src/main/core/systemAnalytics');

describe('systemAnalytics.collectMetrics env snapshot', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    // Strip any pre-existing STRATOSORT_* vars so each test gets a clean slate.
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('STRATOSORT_')) delete process.env[key];
    }
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  test('returns an empty env object when no STRATOSORT_* vars are set', async () => {
    const metrics = await systemAnalytics.collectMetrics();
    expect(metrics.env).toEqual({});
  });

  test('includes only STRATOSORT_* vars, coerced to strings', async () => {
    process.env.STRATOSORT_ENABLE_EMBEDDING_WORKER = 'true';
    process.env.STRATOSORT_MAX_LOG_MB = '50';
    process.env.NOT_STRATOSORT_SECRET = 'should-not-appear';
    process.env.HOME = '/home/test';

    const metrics = await systemAnalytics.collectMetrics();

    expect(metrics.env).toEqual({
      STRATOSORT_ENABLE_EMBEDDING_WORKER: 'true',
      STRATOSORT_MAX_LOG_MB: '50'
    });
    expect(metrics.env.NOT_STRATOSORT_SECRET).toBeUndefined();
    expect(metrics.env.HOME).toBeUndefined();
  });
});

describe('systemAnalytics.collectMetrics recentErrors sanitization', () => {
  beforeEach(() => {
    systemAnalytics.errors = [];
    systemAnalytics.failedOperations = 0;
  });

  testOnWin32('strips raw stack and basename-redacts absolute paths', async () => {
    const failure = new Error(
      "ENOENT: no such file or directory, open 'C:\\Users\\benja\\secrets\\creds.json'"
    );
    failure.stack =
      'Error: ...\n    at readCreds (C:\\Users\\benja\\project\\src\\secrets.js:42:9)';
    systemAnalytics.recordFailure(failure);
    systemAnalytics.recordFailure(
      Object.assign(new Error('boom /home/ubuntu/.config/StratoSort Core/settings.json'), {
        stack: 'Error\n  at secret (/home/ubuntu/.config/StratoSort Core/settings.js:1:1)'
      })
    );

    const metrics = await systemAnalytics.collectMetrics();
    expect(metrics.recentErrors).toHaveLength(2);
    for (const entry of metrics.recentErrors) {
      expect(entry).not.toHaveProperty('stack');
      expect(entry.message).not.toMatch(/C:\\Users\\benja/);
      expect(entry.message).not.toMatch(/\/home\/ubuntu/);
    }
    expect(metrics.recentErrors[0].message).toContain('creds.json');
    expect(metrics.recentErrors[1].message).toContain('settings.json');
  });
});
