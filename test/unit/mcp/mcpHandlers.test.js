'use strict';

// Do NOT jest.mock('electron') — jest.config.js moduleNameMapper already routes it to
// test/mocks/electron.js (which has ipcMain as a jest.fn()-based mock).
// NOTE: test-setup.js calls jest.clearAllMocks() in beforeEach, which would wipe any
// ipcMain.handle call records registered in beforeAll. Work around this by using a
// local registry map populated via a spy in beforeAll, which we can read in each test.

jest.mock('../../../src/main/services/ServiceContainer', () => ({
  container: { resolve: () => null },
  ServiceIds: {
    SEARCH_SERVICE: 'search',
    ANALYSIS_HISTORY: 'history'
  }
}));

jest.mock('../../../src/main/services/McpServerLifecycleService', () => ({
  McpServerLifecycleService: jest.fn().mockImplementation(() => ({
    on: jest.fn(),
    enable: jest.fn(async () => ({ port: 53827, token: 'a'.repeat(64) })),
    disable: jest.fn(async () => undefined),
    status: jest.fn(() => ({ status: 'running', port: 53827, enabled: true })),
    rotateToken: jest.fn(async () => ({ token: 'b'.repeat(64) })),
    getRuntime: jest.fn(() => ({ port: 53827, token: 'a'.repeat(64) })),
    getToolNames: jest.fn(() => [
      'list_smart_folders',
      'get_document_summary',
      'search_documents',
      'chat_with_documents'
    ]),
    _currentRuntime: jest.fn(() => ({ port: 53827, token: 'a'.repeat(64) }))
  }))
}));

jest.mock('../../../src/main/transports/mcp/httpClient', () => ({
  probeMcpTools: jest.fn(async () => ({
    tools: ['list_smart_folders', 'get_document_summary', 'search_documents', 'chat_with_documents']
  }))
}));

const { IpcServiceContext } = require('../../../src/main/ipc/IpcServiceContext');
const registerMcpIpc = require('../../../src/main/ipc/mcp');

const MCP_CHANNELS = {
  ENABLE: 'mcp:enable',
  DISABLE: 'mcp:disable',
  STATUS: 'mcp:status',
  ROTATE_TOKEN: 'mcp:rotate-token',
  GET_CONFIG_SNIPPET: 'mcp:get-config-snippet',
  TEST_CONNECTION: 'mcp:test-connection',
  STATUS_CHANGED: 'mcp:status-changed'
};

describe('mcp IPC handlers', () => {
  // Local registry to survive jest.clearAllMocks() called by test-setup.js beforeEach.
  const handlers = new Map();

  beforeAll(() => {
    // Build a custom ipcMain mock that writes to our local map, bypassing jest.fn() tracking.
    const mockIpcMain = {
      handle: (channel, fn) => handlers.set(channel, fn)
    };

    const context = new IpcServiceContext()
      .setCore({
        ipcMain: mockIpcMain,
        IPC_CHANNELS: { MCP: MCP_CHANNELS },
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() }
      })
      .setElectron({ getMainWindow: () => null, dialog: null, shell: null })
      .setServiceIntegration(() => null);

    registerMcpIpc(context);
  });

  test('registers all 6 invokable handlers', () => {
    const channels = Array.from(handlers.keys()).sort();
    expect(channels).toContain('mcp:enable');
    expect(channels).toContain('mcp:disable');
    expect(channels).toContain('mcp:status');
    expect(channels).toContain('mcp:rotate-token');
    expect(channels).toContain('mcp:get-config-snippet');
    expect(channels).toContain('mcp:test-connection');
  });

  // Handlers are now registered via registerHandlers() (per audit C1) which
  // wraps them with Zod validation + sender check. The wrapper expects
  // (event, ...payloadArgs) and validates payload[0] against the schema. Pass
  // a stub event object and an empty payload object so the schema + sender
  // wrapper accepts the call shape.
  const stubEvent = { senderFrame: { url: 'app://stratosort/' }, sender: { id: 1 } };

  test('mcp:enable returns success with masked token', async () => {
    const handler = handlers.get('mcp:enable');
    const res = await handler(stubEvent, {});
    expect(res.success).toBe(true);
    expect(res.port).toBe(53827);
    expect(res.tokenMasked).toMatch(/^.{4}\.{4}$/);
  });

  test('mcp:status returns current state', async () => {
    const handler = handlers.get('mcp:status');
    const res = await handler(stubEvent, {});
    expect(res.status).toBe('running');
  });

  test('mcp:get-config-snippet returns snippet', async () => {
    const handler = handlers.get('mcp:get-config-snippet');
    const res = await handler(stubEvent, { client: 'claudeDesktop' });
    expect(res.success).toBe(true);
    expect(typeof res.snippet).toBe('string');
  });

  test('mcp:disable returns success', async () => {
    const handler = handlers.get('mcp:disable');
    const res = await handler(stubEvent, {});
    expect(res.success).toBe(true);
  });

  test('mcp:rotate-token returns masked token', async () => {
    const handler = handlers.get('mcp:rotate-token');
    const res = await handler(stubEvent, {});
    expect(res.success).toBe(true);
    expect(res.tokenMasked).toMatch(/^.{4}\.{4}$/);
  });

  test('mcp:test-connection returns ok when server running', async () => {
    const { probeMcpTools } = require('../../../src/main/transports/mcp/httpClient');
    const handler = handlers.get('mcp:test-connection');
    const res = await handler(stubEvent, {});
    expect(probeMcpTools).toHaveBeenCalled();
    expect(res.success).toBe(true);
    expect(res.tools).toContain('list_smart_folders');
    // Per-session transports mean initialize can never report "already
    // initialized", so the old sessionActive flag was always false; it is gone.
    expect(res).not.toHaveProperty('sessionActive');
  });
});
