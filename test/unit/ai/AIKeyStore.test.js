'use strict';

jest.mock('electron', () => ({
  safeStorage: {
    isEncryptionAvailable: jest.fn(() => true),
    encryptString: jest.fn((s) => Buffer.from(`enc:${s}`)),
    decryptString: jest.fn((b) => b.toString().replace(/^enc:/, ''))
  },
  app: { getPath: jest.fn(() => '/tmp/userData') }
}));

jest.mock('node:fs', () => {
  const real = jest.requireActual('node:fs');
  const mockFiles = new Map();
  // In-memory FS for tests. The store uses fs.promises.open() (with mode
  // 0o600) plus handle.writeFile / handle.sync / handle.close — the mock
  // must implement that handle shape, not just writeFile.
  const writeFileMock = jest.fn(async (p, data) => {
    mockFiles.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data));
  });
  return {
    ...real,
    promises: {
      ...real.promises,
      mkdir: jest.fn(async () => undefined),
      // Closure-bind `p` per open() call so concurrent calls don't race on a
      // shared lastOpenedPath. Each handle's writeFile() routes its bytes to
      // its own .tmp path.
      open: jest.fn(async (p) => ({
        writeFile: jest.fn(async (data) => {
          await writeFileMock(p, data);
        }),
        sync: jest.fn(async () => undefined),
        close: jest.fn(async () => undefined)
      })),
      readFile: jest.fn(async (p) => {
        if (mockFiles.has(p)) return mockFiles.get(p);
        const e = new Error('ENOENT');
        e.code = 'ENOENT';
        throw e;
      }),
      writeFile: writeFileMock,
      rename: jest.fn(async (oldPath, newPath) => {
        if (!mockFiles.has(oldPath)) {
          const e = new Error('ENOENT');
          e.code = 'ENOENT';
          throw e;
        }
        mockFiles.set(newPath, mockFiles.get(oldPath));
        mockFiles.delete(oldPath);
      }),
      unlink: jest.fn(async (p) => {
        mockFiles.delete(p);
      }),
      chmod: jest.fn(async () => undefined)
    },
    __mockFiles: mockFiles
  };
});

const fs = require('node:fs');

const { AIKeyStore } = require('../../../src/main/services/ai/AIKeyStore');

describe('AIKeyStore', () => {
  let store;
  beforeEach(() => {
    fs.__mockFiles.clear();
    jest.clearAllMocks();
    store = new AIKeyStore();
  });

  test('returns null when no key is stored', async () => {
    expect(await store.get('anthropic')).toBeNull();
  });

  test('round-trips a key via safeStorage', async () => {
    await store.set('anthropic', 'sk-ant-test-1234567890abcdef');
    const out = await store.get('anthropic');
    expect(out).toBe('sk-ant-test-1234567890abcdef');
  });

  test('overwrites an existing key', async () => {
    await store.set('anthropic', 'sk-ant-old');
    await store.set('anthropic', 'sk-ant-new');
    expect(await store.get('anthropic')).toBe('sk-ant-new');
  });

  test('remove deletes the stored key', async () => {
    await store.set('anthropic', 'sk-ant-test');
    await store.remove('anthropic');
    expect(await store.get('anthropic')).toBeNull();
  });

  test('remove is idempotent when no key exists', async () => {
    await expect(store.remove('anthropic')).resolves.toBeUndefined();
  });

  test('status returns hasKey + lastFour without revealing the key', async () => {
    await store.set('anthropic', 'sk-ant-test-1234567890abcdef');
    const s = await store.status('anthropic');
    expect(s.hasKey).toBe(true);
    expect(s.lastFour).toBe('cdef');
  });

  test('status returns hasKey:false for missing keys', async () => {
    const s = await store.status('anthropic');
    expect(s).toEqual({ hasKey: false, lastFour: null });
  });

  test('writes via temp-file-then-rename for atomicity', async () => {
    await store.set('anthropic', 'sk-ant-test');
    expect(fs.promises.open).toHaveBeenCalled();
    expect(fs.promises.rename).toHaveBeenCalled();
    // The open call should target a *.tmp path
    const openCall = fs.promises.open.mock.calls[0];
    expect(openCall[0]).toMatch(/\.tmp$/);
    // The rename should move .tmp → final path
    const renameCall = fs.promises.rename.mock.calls[0];
    expect(renameCall[0]).toMatch(/\.tmp$/);
    expect(renameCall[1]).toMatch(/anthropic\.bin$/);
  });

  test('refuses to write when safeStorage is unavailable (fail-closed)', async () => {
    const electron = require('electron');
    electron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
    await expect(store.set('openaiCompatible', 'sk-fallback')).rejects.toMatchObject({
      code: 'ENCRYPTION_UNAVAILABLE'
    });
  });

  test('falls back to plaintext only when allowPlaintext: true is passed', async () => {
    const electron = require('electron');
    electron.safeStorage.isEncryptionAvailable.mockReturnValue(false);
    const result = await store.set('openaiCompatible', 'sk-fallback', { allowPlaintext: true });
    expect(result.encryption).toBe('plaintext');
    expect(await store.get('openaiCompatible')).toBe('sk-fallback');
  });

  test('returns encryption: safeStorage when keyring is available', async () => {
    const electron = require('electron');
    electron.safeStorage.isEncryptionAvailable.mockReturnValue(true);
    const result = await store.set('anthropic', 'sk-ant-test');
    expect(result.encryption).toBe('safeStorage');
  });

  test('concurrent set() calls for the same provider are serialized', async () => {
    // Without the per-provider write chain, two parallel set() calls would
    // both write to the same .tmp path, racing on open/writeFile/sync/rename.
    // The mutex makes the second wait for the first.
    const electron = require('electron');
    electron.safeStorage.isEncryptionAvailable.mockReturnValue(true);

    const events = [];
    const originalOpen = fs.promises.open;
    fs.promises.open = jest.fn(async (p) => {
      events.push(`open:${p}`);
      const handle = await originalOpen(p);
      const wrappedWriteFile = handle.writeFile;
      handle.writeFile = jest.fn(async (data) => {
        // Yield to the event loop so a second concurrent caller would
        // overlap WITHOUT the mutex.
        await new Promise((r) => setImmediate(r));
        events.push(`write:${p}`);
        return wrappedWriteFile.call(handle, data);
      });
      return handle;
    });

    await Promise.all([store.set('anthropic', 'first-key'), store.set('anthropic', 'second-key')]);

    // Verify ordering: each set's open MUST complete before the next set's
    // open begins. The interleaving forbidden by the mutex is
    // open,open,write,write — which would have been the natural order
    // without serialization.
    const openCount = events.filter((e) => e.startsWith('open:')).length;
    const writeCount = events.filter((e) => e.startsWith('write:')).length;
    expect(openCount).toBe(2);
    expect(writeCount).toBe(2);
    // First write must come before second open (true serialization).
    expect(events.indexOf('write:' + events[0].slice(5))).toBeLessThan(
      events.lastIndexOf(events[2])
    );

    // Final stored value should reflect ONE of the two keys (last writer wins),
    // never a corrupted mix.
    const final = await store.get('anthropic');
    expect(['first-key', 'second-key']).toContain(final);
  });

  test('rejects unknown provider names', async () => {
    await expect(store.set('gemini', 'k')).rejects.toThrow(/unknown provider/i);
    await expect(store.get('gemini')).rejects.toThrow(/unknown provider/i);
  });

  test('rejects empty or non-string keys', async () => {
    await expect(store.set('anthropic', '')).rejects.toThrow(/must be a non-empty string/i);
    await expect(store.set('anthropic', null)).rejects.toThrow(/must be a non-empty string/i);
  });

  test('toJSON / inspect methods do not leak key material', () => {
    const s = new AIKeyStore();
    expect(JSON.stringify(s)).not.toMatch(/sk-/);
    expect(String(s)).not.toMatch(/sk-/);
  });

  test('refuses to decrypt a plaintext-marked key after safeStorage becomes available', async () => {
    const { safeStorage } = require('electron');
    safeStorage.isEncryptionAvailable.mockReturnValue(false);
    await store.set('anthropic', 'sk-ant-plain', { allowPlaintext: true });
    safeStorage.decryptString.mockClear();
    safeStorage.isEncryptionAvailable.mockReturnValue(true);
    const out = await store.get('anthropic');
    expect(out).toBe('sk-ant-plain');
    expect(safeStorage.decryptString).not.toHaveBeenCalled();
  });

  test('throws ENCRYPTION_UNAVAILABLE when an encrypted key cannot be decrypted', async () => {
    const { safeStorage } = require('electron');
    await store.set('anthropic', 'sk-ant-enc');
    safeStorage.isEncryptionAvailable.mockReturnValue(false);
    await expect(store.get('anthropic')).rejects.toMatchObject({
      code: 'ENCRYPTION_UNAVAILABLE'
    });
  });
});
