/**
 * @jest-environment node
 *
 * Tests for llamaBackendCache.js: the last-known-good GPU backend record the
 * backend selector reads before its candidate ladder. Runs against a real
 * temp directory so the atomic write helper is exercised as shipped.
 */

jest.mock('../src/shared/logger', () => require('./mocks/logger'));

const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const { logger: mockLogger } = require('./mocks/logger');
const {
  BACKEND_CACHE_FILENAME,
  BACKEND_CACHE_MAX_AGE_MS,
  createLlamaBackendCache
} = require('../src/main/utils/llamaBackendCache');

const NOW = Date.parse('2026-10-31T12:00:00.000Z');
const GPU = { type: 'cuda', name: 'NVIDIA GeForce RTX 4070', vramMB: 12282 };

describe('llamaBackendCache', () => {
  let userDataPath;

  /** @param {Record<string, any>} [overrides] */
  const makeCache = (overrides = {}) =>
    createLlamaBackendCache({
      userDataPath,
      appVersion: '4.1.0',
      nodeLlamaVersion: '3.22.2',
      gpuInfo: GPU,
      platform: 'win32',
      arch: 'x64',
      now: () => NOW,
      ...overrides
    });

  const recordPath = () => path.join(userDataPath, BACKEND_CACHE_FILENAME);

  const ignoredReasons = () =>
    mockLogger.debug.mock.calls
      .filter(([message]) => message === '[LlamaBackendCache] Ignoring cached backend record')
      .map(([, meta]) => meta.reason);

  beforeEach(async () => {
    jest.clearAllMocks();
    userDataPath = await fs.mkdtemp(path.join(os.tmpdir(), 'llama-backend-cache-'));
  });

  afterEach(async () => {
    await fs.rm(userDataPath, { recursive: true, force: true, maxRetries: 3 });
  });

  test('returns null when no userData directory is given', () => {
    expect(createLlamaBackendCache({ userDataPath: null })).toBeNull();
    expect(createLlamaBackendCache({ userDataPath: '   ' })).toBeNull();
  });

  test('builds the fingerprint from platform, versions and the detected GPU', () => {
    const cache = makeCache({ gpuInfo: { ...GPU, type: 'CUDA', driverVersion: ' 566.36 ' } });

    expect(cache.filePath).toBe(recordPath());
    expect(cache.fingerprint).toEqual({
      platform: 'win32',
      arch: 'x64',
      appVersion: '4.1.0',
      nodeLlamaVersion: '3.22.2',
      gpuType: 'cuda',
      gpuName: 'NVIDIA GeForce RTX 4070',
      driverVersion: '566.36'
    });
  });

  test('carries null for fingerprint fields that are unknown', () => {
    const cache = makeCache({ gpuInfo: null, nodeLlamaVersion: undefined, appVersion: '' });

    expect(cache.fingerprint).toEqual(
      expect.objectContaining({
        appVersion: null,
        nodeLlamaVersion: null,
        gpuType: null,
        gpuName: null,
        driverVersion: null
      })
    );
  });

  test('write then read round-trips the backend for a matching fingerprint', async () => {
    const cache = makeCache();

    await expect(cache.write('vulkan')).resolves.toBe(true);
    await expect(makeCache().read()).resolves.toBe('vulkan');

    const stored = JSON.parse(await fs.readFile(recordPath(), 'utf8'));
    expect(stored).toEqual({
      backend: 'vulkan',
      fingerprint: cache.fingerprint,
      supportedGpuTypes: null,
      savedAt: new Date(NOW).toISOString()
    });
    // The write leaves no temp file behind.
    expect(await fs.readdir(userDataPath)).toEqual([BACKEND_CACHE_FILENAME]);
  });

  test('creates the userData directory when it does not exist yet', async () => {
    const nested = path.join(userDataPath, 'not-yet-created');
    const cache = makeCache({ userDataPath: nested });

    await expect(cache.write('cuda')).resolves.toBe(true);
    await expect(cache.read()).resolves.toBe('cuda');
  });

  test.each([
    ['appVersion', { appVersion: '4.1.1' }],
    ['nodeLlamaVersion', { nodeLlamaVersion: '3.23.0' }],
    ['gpuName', { gpuInfo: { ...GPU, name: 'NVIDIA GeForce RTX 5080' } }],
    ['gpuType', { gpuInfo: { ...GPU, type: 'vulkan' } }],
    ['driverVersion', { gpuInfo: { ...GPU, driverVersion: '572.16' } }],
    ['arch', { arch: 'arm64' }],
    ['platform', { platform: 'linux' }]
  ])('ignores the record when %s changed', async (field, overrides) => {
    await makeCache().write('cuda');

    await expect(makeCache(overrides).read()).resolves.toBeNull();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      '[LlamaBackendCache] Ignoring cached backend record',
      expect.objectContaining({ reason: 'fingerprint-mismatch', changed: [field] })
    );
  });

  test('stores the supported-backend set as a sorted key and matches it on read', async () => {
    await makeCache().write('vulkan', { supportedGpuTypes: ['vulkan', false, 'CUDA', 'cuda'] });

    const stored = JSON.parse(await fs.readFile(recordPath(), 'utf8'));
    expect(stored.supportedGpuTypes).toBe('cuda,vulkan');
    await expect(makeCache().read({ supportedGpuTypes: ['cuda', 'vulkan', false] })).resolves.toBe(
      'vulkan'
    );
  });

  test('ignores the record when the supported-backend set changed since it was saved', async () => {
    // Saved on a driver-only launch (no CUDA runtime); a CUDA toolkit has
    // since been installed, so CUDA must get its turn ahead of Vulkan again.
    await makeCache().write('vulkan', { supportedGpuTypes: ['vulkan', false] });

    await expect(
      makeCache().read({ supportedGpuTypes: ['cuda', 'vulkan', false] })
    ).resolves.toBeNull();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      '[LlamaBackendCache] Ignoring cached backend record',
      expect.objectContaining({
        reason: 'supported-backends-changed',
        saved: 'vulkan',
        current: 'cuda,vulkan'
      })
    );
  });

  test('a record saved without a known supported set is ignored once the set is known', async () => {
    await makeCache().write('vulkan');

    await expect(makeCache().read({ supportedGpuTypes: ['vulkan', false] })).resolves.toBeNull();
    expect(ignoredReasons()).toEqual(['supported-backends-changed']);
  });

  test('an unknown supported set this launch (probe failed) does not discard the record', async () => {
    await makeCache().write('vulkan', { supportedGpuTypes: ['vulkan', false] });

    await expect(makeCache().read({ supportedGpuTypes: null })).resolves.toBe('vulkan');
    await expect(makeCache().read()).resolves.toBe('vulkan');
    await expect(makeCache().read(null)).resolves.toBe('vulkan');
  });

  test('returns null for a missing record without treating it as an error', async () => {
    await expect(makeCache().read()).resolves.toBeNull();
    expect(ignoredReasons()).toEqual(['missing']);
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  test('ignores corrupt JSON with a debug log and leaves the file alone', async () => {
    await fs.writeFile(recordPath(), '{"backend": "cuda", "fingerp', 'utf8');

    await expect(makeCache().read()).resolves.toBeNull();
    expect(ignoredReasons()).toEqual(['corrupt']);
    expect(mockLogger.warn).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
    await expect(fs.readFile(recordPath(), 'utf8')).resolves.toContain('fingerp');
  });

  test.each([
    ['a JSON array', '["cuda"]'],
    ['a JSON string', '"cuda"'],
    ['an empty file', '']
  ])('treats %s as corrupt', async (_label, contents) => {
    await fs.writeFile(recordPath(), contents, 'utf8');

    await expect(makeCache().read()).resolves.toBeNull();
    expect(ignoredReasons()).toEqual(['corrupt']);
  });

  test.each([
    ['cpu', 'cpu'],
    ['auto', 'auto'],
    ['false', false],
    ['an unknown backend', 'directml']
  ])('ignores a record whose backend is %s', async (_label, backend) => {
    const cache = makeCache();
    await fs.writeFile(
      recordPath(),
      JSON.stringify({
        backend,
        fingerprint: cache.fingerprint,
        savedAt: new Date(NOW).toISOString()
      }),
      'utf8'
    );

    await expect(cache.read()).resolves.toBeNull();
    expect(ignoredReasons()).toEqual(['invalid']);
  });

  test('ignores a record without a fingerprint object', async () => {
    await fs.writeFile(
      recordPath(),
      JSON.stringify({ backend: 'cuda', savedAt: new Date(NOW).toISOString() }),
      'utf8'
    );

    await expect(makeCache().read()).resolves.toBeNull();
    expect(ignoredReasons()).toEqual(['fingerprint-mismatch']);
  });

  test('ignores an unreadable record with a debug log', async () => {
    // A directory where the file should be makes readFile fail with EISDIR.
    await fs.mkdir(recordPath());

    await expect(makeCache().read()).resolves.toBeNull();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      '[LlamaBackendCache] Ignoring cached backend record',
      expect.objectContaining({ reason: 'unreadable', error: expect.any(String) })
    );
  });

  test('expires a record older than the max age so the full ladder runs again', async () => {
    await makeCache().write('vulkan');

    const justInside = makeCache({ now: () => NOW + BACKEND_CACHE_MAX_AGE_MS });
    await expect(justInside.read()).resolves.toBe('vulkan');

    const stale = makeCache({ now: () => NOW + BACKEND_CACHE_MAX_AGE_MS + 1 });
    await expect(stale.read()).resolves.toBeNull();
    expect(ignoredReasons()).toEqual(['expired']);
  });

  test.each([
    ['a timestamp from the future', new Date(NOW + 60_000).toISOString()],
    ['an unparseable timestamp', 'yesterday'],
    ['a missing timestamp', undefined]
  ])('treats %s as expired', async (_label, savedAt) => {
    const cache = makeCache();
    await fs.writeFile(
      recordPath(),
      JSON.stringify({ backend: 'cuda', fingerprint: cache.fingerprint, savedAt }),
      'utf8'
    );

    await expect(cache.read()).resolves.toBeNull();
    expect(ignoredReasons()).toEqual(['expired']);
  });

  test('refuses to write CPU or non-GPU values', async () => {
    const cache = makeCache();

    await expect(cache.write('cpu')).resolves.toBe(false);
    await expect(cache.write(false)).resolves.toBe(false);
    await expect(cache.write('auto')).resolves.toBe(false);
    await expect(cache.write(undefined)).resolves.toBe(false);
    await expect(fs.readdir(userDataPath)).resolves.toEqual([]);
  });

  test('a failed write resolves false with a debug log instead of throwing', async () => {
    // A regular file where the userData directory should be: mkdir fails.
    const blocker = path.join(userDataPath, 'blocker');
    await fs.writeFile(blocker, 'x', 'utf8');
    const cache = makeCache({ userDataPath: path.join(blocker, 'userData') });

    await expect(cache.write('cuda')).resolves.toBe(false);
    expect(mockLogger.debug).toHaveBeenCalledWith(
      '[LlamaBackendCache] Failed to save cached backend record',
      expect.objectContaining({ backend: 'cuda', error: expect.any(String) })
    );
  });

  test('clear removes the record and tolerates a missing one', async () => {
    const cache = makeCache();
    await cache.write('cuda');

    await cache.clear();
    await expect(fs.readdir(userDataPath)).resolves.toEqual([]);
    await expect(cache.read()).resolves.toBeNull();

    await expect(cache.clear()).resolves.toBeUndefined();
    expect(mockLogger.debug).not.toHaveBeenCalledWith(
      '[LlamaBackendCache] Failed to clear cached backend record',
      expect.anything()
    );
  });

  test('clear never throws when the record cannot be removed', async () => {
    // A non-empty directory at the record path: unlink fails with EISDIR/EPERM.
    await fs.mkdir(recordPath());
    await fs.writeFile(path.join(recordPath(), 'inner'), 'x', 'utf8');

    await expect(makeCache().clear()).resolves.toBeUndefined();
    expect(mockLogger.debug).toHaveBeenCalledWith(
      '[LlamaBackendCache] Failed to clear cached backend record',
      expect.objectContaining({ error: expect.any(String) })
    );
  });
});
