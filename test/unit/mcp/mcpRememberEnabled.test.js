'use strict';

/**
 * The MCP server's on/off choice survives a restart. The choice lives in
 * userData/mcp-server.json next to the token, owned by the lifecycle service,
 * and only the user's own toggle (remember: true) writes it — a quit-time
 * disable() must leave it alone so the server comes back on the next launch.
 */

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
  createMcpServer: jest.fn(async () => ({ port: 53827, toolNames: [], close: jest.fn() }))
}));

const path = require('node:path');
const fs = require('node:fs');
const { createMcpServer } = require('../../../src/main/transports/mcp');
const {
  McpServerLifecycleService
} = require('../../../src/main/services/McpServerLifecycleService');

const PREF_FILE = path.join('/tmp/userData', 'mcp-server.json');
const readPref = () => JSON.parse(fs.__files.get(PREF_FILE).toString('utf8'));

describe('McpServerLifecycleService — remembered on/off choice', () => {
  /** @type {any} */
  let svc;
  /** @type {{ warn: jest.Mock, info: jest.Mock, error: jest.Mock, debug: jest.Mock }} */
  let logger;

  beforeEach(() => {
    fs.__files.clear();
    logger = { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() };
    svc = new McpServerLifecycleService({ services: {}, logger });
  });

  test('nothing remembered yet reads as off', async () => {
    await expect(svc.getRememberedEnabled()).resolves.toBe(false);
  });

  test('enable({ remember: true }) saves the choice as on', async () => {
    await svc.enable({ remember: true });
    expect(readPref()).toEqual({ enabled: true });
    await expect(svc.getRememberedEnabled()).resolves.toBe(true);
  });

  test('enable() without remember (start on launch) writes nothing', async () => {
    await svc.enable();
    expect(fs.__files.has(PREF_FILE)).toBe(false);
  });

  test('a failed enable saves nothing', async () => {
    createMcpServer.mockRejectedValueOnce(new Error('EADDRINUSE'));
    await expect(svc.enable({ remember: true })).rejects.toThrow('EADDRINUSE');
    expect(fs.__files.has(PREF_FILE)).toBe(false);
    await expect(svc.getRememberedEnabled()).resolves.toBe(false);
  });

  test('disable({ remember: true }) saves the choice as off', async () => {
    await svc.enable({ remember: true });
    await svc.disable({ remember: true });
    expect(readPref()).toEqual({ enabled: false });
    await expect(svc.getRememberedEnabled()).resolves.toBe(false);
  });

  test('disable() at quit keeps the choice so the server starts next launch', async () => {
    await svc.enable({ remember: true });
    await svc.disable();
    await expect(svc.getRememberedEnabled()).resolves.toBe(true);
  });

  test('disable({ remember: true }) saves off even when the close fails', async () => {
    const close = jest.fn(() => Promise.reject(new Error('close failed')));
    createMcpServer.mockResolvedValueOnce({ port: 53827, toolNames: [], close });
    await svc.enable({ remember: true });
    await expect(svc.disable({ remember: true })).rejects.toThrow('close failed');
    await expect(svc.getRememberedEnabled()).resolves.toBe(false);
  });

  test('a damaged or hand-edited file reads as off', async () => {
    fs.__files.set(PREF_FILE, Buffer.from('{not json'));
    await expect(svc.getRememberedEnabled()).resolves.toBe(false);
    fs.__files.set(PREF_FILE, Buffer.from(JSON.stringify({ enabled: 'yes' })));
    await expect(svc.getRememberedEnabled()).resolves.toBe(false);
  });

  test('a failed save does not fail enable(); it is logged without the token', async () => {
    fs.promises.rename.mockImplementation(async (oldPath, newPath) => {
      if (newPath === PREF_FILE) throw new Error('EPERM');
      const files = fs.__files;
      files.set(newPath, files.get(oldPath));
      files.delete(oldPath);
    });
    try {
      const { token } = await svc.enable({ remember: true });
      expect(svc.status().status).toBe('running');
      expect(logger.warn).toHaveBeenCalledWith(
        expect.stringContaining('could not save'),
        expect.objectContaining({ error: 'EPERM' })
      );
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain(token);
    } finally {
      fs.promises.rename.mockReset();
      fs.promises.rename.mockImplementation(async (oldPath, newPath) => {
        fs.__files.set(newPath, fs.__files.get(oldPath));
        fs.__files.delete(oldPath);
      });
    }
  });
});
