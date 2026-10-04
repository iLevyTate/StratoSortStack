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
  // Path-keyed in-memory FS. The service writes via open()/handle.writeFile/
  // sync/close then rename(), and reads both the token and its marker.
  const files = new Map();
  const enoent = () => {
    const e = new Error('ENOENT');
    e.code = 'ENOENT';
    throw e;
  };
  return {
    ...real,
    promises: {
      ...real.promises,
      mkdir: jest.fn(async () => undefined),
      open: jest.fn(async (p) => ({
        writeFile: jest.fn(async (data) => {
          files.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data));
        }),
        sync: jest.fn(async () => undefined),
        close: jest.fn(async () => undefined)
      })),
      readFile: jest.fn(async (p) => (files.has(p) ? files.get(p) : enoent())),
      writeFile: jest.fn(async (p, data) => {
        files.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data));
      }),
      rename: jest.fn(async (oldPath, newPath) => {
        if (!files.has(oldPath)) enoent();
        files.set(newPath, files.get(oldPath));
        files.delete(oldPath);
      }),
      unlink: jest.fn(async (p) => {
        files.delete(p);
      }),
      chmod: jest.fn(async () => undefined)
    },
    __files: files
  };
});

jest.mock('../../../src/main/transports/mcp', () => ({
  createMcpServer: jest.fn(async () => ({
    port: 53827,
    toolNames: [
      'list_smart_folders',
      'get_document_summary',
      'search_documents',
      'chat_with_documents'
    ],
    close: jest.fn()
  }))
}));

const path = require('node:path');
const fs = require('node:fs');
const { safeStorage } = require('electron');
const {
  McpServerLifecycleService
} = require('../../../src/main/services/McpServerLifecycleService');

const TOKEN_FILE = path.join('/tmp/userData', 'mcp-token.bin');
const MARKER_FILE = path.join('/tmp/userData', 'mcp-token.enc');
const HEX_64 = /^[0-9a-f]{64}$/;

const readMarker = () => JSON.parse(fs.__files.get(MARKER_FILE).toString('utf8')).encryption;

describe('McpServerLifecycleService', () => {
  let svc;
  beforeEach(() => {
    fs.__files.clear();
    safeStorage.isEncryptionAvailable.mockReturnValue(true);
    safeStorage.decryptString.mockImplementation((b) => b.toString().replace(/^enc:/, ''));
    svc = new McpServerLifecycleService({ services: {}, settings: { mcp: { enabled: false } } });
  });

  test('starts in stopped state', () => {
    expect(svc.status()).toEqual({ status: 'stopped', port: null, enabled: false });
  });

  test('generates a 64-char hex token on first enable()', async () => {
    const result = await svc.enable();
    expect(result.token).toMatch(HEX_64);
    expect(result.port).toBe(53827);
    expect(svc.status().status).toBe('running');
  });

  test('reuses existing token across enable/disable cycles', async () => {
    const a = await svc.enable();
    await svc.disable();
    const b = await svc.enable();
    expect(b.token).toBe(a.token);
  });

  test('rotateToken changes token and emits STATUS_CHANGED', async () => {
    await svc.enable();
    const before = svc._token;
    const events = [];
    svc.on('status-changed', (s) => events.push(s));
    const after = await svc.rotateToken();
    expect(after.token).not.toBe(before);
    expect(events.length).toBeGreaterThan(0);
  });

  test('disable surfaces close() errors so renderer state reflects actual transport state', async () => {
    // Per audit L1: disable() previously set _status='stopped' regardless of
    // whether httpHandle.close() succeeded — a close failure left the port
    // potentially still bound while the UI showed a clean stop. The fix
    // surfaces the close error and marks status='error'.
    await svc.enable();
    const close = svc._httpHandle.close;
    close.mockRejectedValueOnce(new Error('close failed'));
    await expect(svc.disable()).rejects.toThrow('close failed');
    expect(close).toHaveBeenCalled();
    expect(svc.status().status).toBe('error');
    expect(svc.status().port).toBeNull();
  });

  test('disable transitions to stopped on a clean close', async () => {
    await svc.enable();
    await expect(svc.disable()).resolves.toBeUndefined();
    expect(svc.status().status).toBe('stopped');
    expect(svc.status().port).toBeNull();
  });

  // M2: a close() that never settles must not wedge the lifecycle mutex.
  test('disable() times out a hung close() and a later enable() still runs', async () => {
    jest.useFakeTimers();
    try {
      await svc.enable();
      svc._httpHandle.close.mockReturnValueOnce(new Promise(() => {}));
      const rejection = expect(svc.disable()).rejects.toThrow(/timed out/);
      await jest.advanceTimersByTimeAsync(10_000);
      await rejection;
      expect(svc.status().status).toBe('error');

      await expect(svc.enable()).resolves.toMatchObject({ port: 53827 });
      expect(svc.status().status).toBe('running');
    } finally {
      jest.useRealTimers();
    }
  });

  describe('token persistence across encryption-availability flips (M3)', () => {
    test('records the write mode in a sidecar marker', async () => {
      await svc.enable();
      expect(readMarker()).toBe('safeStorage');
      expect(fs.__files.get(TOKEN_FILE).toString()).toMatch(/^enc:/);
    });

    test('plaintext token survives encryption becoming available and is upgraded', async () => {
      safeStorage.isEncryptionAvailable.mockReturnValue(false);
      const { token } = await svc.enable();
      expect(readMarker()).toBe('plaintext');
      await svc.disable();

      safeStorage.isEncryptionAvailable.mockReturnValue(true);
      safeStorage.decryptString.mockImplementation(() => {
        throw new Error('Error while decrypting the ciphertext');
      });
      const result = await svc.enable();
      expect(result.token).toBe(token);
      expect(result.token).toMatch(HEX_64);
      expect(readMarker()).toBe('safeStorage');
      expect(fs.__files.get(TOKEN_FILE).toString()).toBe(`enc:${token}`);
    });

    test('encrypted token with safeStorage now unavailable is regenerated, not returned as ciphertext', async () => {
      const { token } = await svc.enable();
      expect(readMarker()).toBe('safeStorage');
      await svc.disable();

      safeStorage.isEncryptionAvailable.mockReturnValue(false);
      const result = await svc.enable();
      expect(result.token).not.toBe(token);
      expect(result.token).toMatch(HEX_64);
      expect(readMarker()).toBe('plaintext');
      expect(svc.status().status).toBe('running');
    });

    test('legacy token without a marker that fails to decrypt is regenerated', async () => {
      fs.__files.set(TOKEN_FILE, Buffer.from('opaque-ciphertext'));
      safeStorage.decryptString.mockImplementation(() => {
        throw new Error('Error while decrypting the ciphertext');
      });
      const result = await svc.enable();
      expect(result.token).toMatch(HEX_64);
      expect(readMarker()).toBe('safeStorage');
    });

    test('legacy plaintext token without a marker is still honoured', async () => {
      const legacy = 'b'.repeat(64);
      safeStorage.isEncryptionAvailable.mockReturnValue(false);
      fs.__files.set(TOKEN_FILE, Buffer.from(legacy, 'utf8'));
      const result = await svc.enable();
      expect(result.token).toBe(legacy);
    });
  });
});
