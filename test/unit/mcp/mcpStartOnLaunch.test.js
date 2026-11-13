'use strict';

/**
 * The MCP IPC layer remembers the user's toggle and starts the server on
 * launch when it was left on. A failed start on launch is logged and never
 * thrown into app startup.
 */

jest.mock('../../../src/main/services/ServiceContainer', () => ({
  container: { resolve: () => null },
  ServiceIds: { SEARCH_SERVICE: 'search', ANALYSIS_HISTORY: 'history' }
}));

const TOKEN = 'c'.repeat(64);
const mockLifecycle = {
  on: jest.fn(),
  enable: jest.fn(),
  disable: jest.fn(),
  status: jest.fn(() => ({ status: 'stopped', port: null, enabled: false })),
  getRememberedEnabled: jest.fn(),
  getRuntime: jest.fn(() => ({ port: null, token: null }))
};

jest.mock('../../../src/main/services/McpServerLifecycleService', () => ({
  McpServerLifecycleService: jest.fn(() => mockLifecycle)
}));

const MCP_CHANNELS = {
  ENABLE: 'mcp:enable',
  DISABLE: 'mcp:disable',
  STATUS: 'mcp:status',
  ROTATE_TOKEN: 'mcp:rotate-token',
  GET_CONFIG_SNIPPET: 'mcp:get-config-snippet',
  TEST_CONNECTION: 'mcp:test-connection',
  STATUS_CHANGED: 'mcp:status-changed'
};
const stubEvent = { senderFrame: { url: 'app://stratosort/' }, sender: { id: 1 } };
const flush = () => new Promise((resolve) => setImmediate(resolve));

/** @type {any} */
let registerMcpIpc;
/** @type {any} */
let IpcServiceContext;
/** @type {Map<string, Function>} */
let handlers;
/** @type {{ info: jest.Mock, warn: jest.Mock, error: jest.Mock, debug: jest.Mock }} */
let logger;

function register() {
  handlers = new Map();
  logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  const context = new IpcServiceContext()
    .setCore({
      ipcMain: { handle: (channel, fn) => handlers.set(channel, fn) },
      IPC_CHANNELS: { MCP: MCP_CHANNELS },
      logger
    })
    .setElectron({ getMainWindow: () => null, dialog: null, shell: null })
    .setServiceIntegration(() => null);
  registerMcpIpc(context);
}

describe('mcp IPC — remember the toggle and start on launch', () => {
  beforeEach(() => {
    jest.isolateModules(() => {
      // Same registry as mcp.js so its `instanceof IpcServiceContext` holds.
      registerMcpIpc = require('../../../src/main/ipc/mcp');
      ({ IpcServiceContext } = require('../../../src/main/ipc/IpcServiceContext'));
    });
    mockLifecycle.enable.mockReset().mockResolvedValue({ port: 53827, token: TOKEN });
    mockLifecycle.disable.mockReset().mockResolvedValue(undefined);
    mockLifecycle.getRememberedEnabled.mockReset().mockResolvedValue(false);
  });

  test('the Enable toggle starts the server and remembers the choice', async () => {
    register();
    await flush();
    const res = await handlers.get('mcp:enable')(stubEvent, {});
    expect(res.success).toBe(true);
    expect(mockLifecycle.enable).toHaveBeenCalledWith({ remember: true });
  });

  test('the Disable toggle stops the server and remembers the choice', async () => {
    register();
    await flush();
    const res = await handlers.get('mcp:disable')(stubEvent, {});
    expect(res.success).toBe(true);
    expect(mockLifecycle.disable).toHaveBeenCalledWith({ remember: true });
  });

  test('starts the server on launch when it was left on', async () => {
    mockLifecycle.getRememberedEnabled.mockResolvedValue(true);
    register();
    expect(mockLifecycle.enable).not.toHaveBeenCalled(); // deferred off the boot path
    await flush();
    await flush();
    expect(mockLifecycle.enable).toHaveBeenCalledTimes(1);
    expect(mockLifecycle.enable).toHaveBeenCalledWith();
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('started on launch'),
      expect.objectContaining({ port: 53827 })
    );
    expect(JSON.stringify(logger.info.mock.calls)).not.toContain(TOKEN);
  });

  test('does not start the server on launch when it was left off', async () => {
    register();
    await flush();
    await flush();
    expect(mockLifecycle.getRememberedEnabled).toHaveBeenCalled();
    expect(mockLifecycle.enable).not.toHaveBeenCalled();
  });

  test('a failed start on launch is logged, not thrown', async () => {
    mockLifecycle.getRememberedEnabled.mockResolvedValue(true);
    mockLifecycle.enable.mockRejectedValue(new Error('listen EADDRINUSE C:\\Users\\x\\y'));
    expect(() => register()).not.toThrow();
    await flush();
    await flush();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('could not start on launch'),
      expect.objectContaining({ error: expect.stringContaining('EADDRINUSE') })
    );
    // Paths are scrubbed the same way as IPC error replies.
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('Users');
  });

  test('a failed read of the saved choice is logged, not thrown', async () => {
    mockLifecycle.getRememberedEnabled.mockRejectedValue(new Error('boom'));
    register();
    await flush();
    await flush();
    expect(mockLifecycle.enable).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });
});
