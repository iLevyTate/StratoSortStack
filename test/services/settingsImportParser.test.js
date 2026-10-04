/**
 * Unit tests for the settings-import JSON parser wrapper.
 *
 * These spawn a REAL worker_threads Worker — the whole point of moving
 * this to a worker is to confirm it actually runs off the main thread,
 * so mocking `Worker` would defeat the test.
 */

const path = require('path');

// The worker is resolved like every other worker bundle (webpack entry in
// dist/, unpacked from the asar). Default to the source file so these tests
// still spawn a real worker; individual tests override the resolver.
jest.mock('../../src/main/utils/workerPools', () => ({
  resolveWorkerPath: jest.fn()
}));
const { resolveWorkerPath } = require('../../src/main/utils/workerPools');
const SOURCE_WORKER = path.resolve(
  __dirname,
  '../../src/main/workers/settingsImportParserWorker.js'
);

const {
  parseSettingsImportJson,
  DEFAULT_TIMEOUT_MS
} = require('../../src/main/services/settingsImportParser');

describe('services/settingsImportParser', () => {
  beforeEach(() => {
    resolveWorkerPath.mockReset();
    resolveWorkerPath.mockReturnValue(SOURCE_WORKER);
  });

  test('asks the shared worker resolver for the bundle, by entry name', async () => {
    const res = await parseSettingsImportJson('{"settings":{"a":1}}');
    expect(res).toEqual({ ok: true, value: { settings: { a: 1 } } });
    expect(resolveWorkerPath).toHaveBeenCalledWith('settingsImportParserWorker');
  });

  test('falls back to an in-process parse when no bundle can be resolved', async () => {
    // A path built from __dirname pointed at <app>/workers/… in a built
    // app, where the file never exists; the missing file surfaced as an
    // async worker error, so the fallback never ran and every import
    // failed as "Invalid JSON". The resolver reports absence up front.
    resolveWorkerPath.mockReturnValue(null);
    const res = await parseSettingsImportJson('{"settings":{"b":2}}');
    expect(res).toEqual({ ok: true, value: { settings: { b: 2 } } });
  });

  test('the worker is a webpack entry and an asar-unpacked bundle, like the other workers', () => {
    // The old source-tree path pointed nowhere in a built app because the
    // worker was the only one not emitted to dist/.
    const mainConfig = jest.requireActual('../../webpack.main.config.js')(
      {},
      { mode: 'production' }
    );
    const entries = Array.isArray(mainConfig) ? mainConfig[0].entry : mainConfig.entry;
    expect(entries.settingsImportParserWorker).toBe(
      './src/main/workers/settingsImportParserWorker.js'
    );
    const builderConfig = jest.requireActual('../../electron-builder.json');
    const unpackedWorkers = builderConfig.asarUnpack.find((p) => p.startsWith('dist/{'));
    expect(unpackedWorkers).toContain('settingsImportParserWorker');
  });

  test('parses a well-formed settings export successfully', async () => {
    const payload = JSON.stringify({
      settings: { confidenceThreshold: 0.75, notifications: true }
    });
    const res = await parseSettingsImportJson(payload);
    expect(res.ok).toBe(true);
    expect(res.value).toEqual({
      settings: { confidenceThreshold: 0.75, notifications: true }
    });
  });

  test('returns a structured error for malformed JSON (never throws)', async () => {
    const res = await parseSettingsImportJson('{ not valid json at all');
    expect(res.ok).toBe(false);
    expect(typeof res.error).toBe('string');
    // V8's JSON.parse error text varies between Node versions; we just
    // pin the shape, not the exact message.
    expect(res.error.length).toBeGreaterThan(0);
  });

  test('rejects non-string inputs immediately', async () => {
    let res = await parseSettingsImportJson(undefined);
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/string/i);

    res = await parseSettingsImportJson(Buffer.from('{}'));
    expect(res.ok).toBe(false);
  });

  test('enforces the caller-supplied timeout', async () => {
    // Build a string large enough that JSON.parse will take a noticeable
    // amount of time — but small enough that the test still finishes in
    // tens of milliseconds. A 1 MB of deeply-nested arrays is enough to
    // force a parse well above our 1ms timeout.
    const depth = 5000;
    const deep = '['.repeat(depth) + '1' + ']'.repeat(depth);
    // The timeout here is absurdly small (1ms) to deterministically
    // trigger the timeout path without depending on machine speed. Even
    // the fastest parser can't beat the worker-thread spawn cost.
    const res = await parseSettingsImportJson(deep, { timeoutMs: 1 });
    expect(res.ok).toBe(false);
    expect(res.error).toMatch(/timed out/i);
  });

  test('default timeout is exported as a tunable constant', () => {
    // Smoke: constant exists and is a positive number.
    expect(typeof DEFAULT_TIMEOUT_MS).toBe('number');
    expect(DEFAULT_TIMEOUT_MS).toBeGreaterThan(0);
  });
});
