'use strict';

jest.mock(
  '@modelcontextprotocol/sdk/server/mcp.js',
  () => ({
    McpServer: class MockMcpServer {
      constructor() {
        this._tools = [];
      }
      registerTool(name, schema, handler) {
        this._tools.push({ name, schema, handler });
      }
      async connect(transport) {
        this.transport = transport;
      }
      async close() {
        if (this.transport && this.transport.close) {
          await this.transport.close();
        }
      }
    }
  }),
  { virtual: true }
);

// Records every transport the server constructs so tests can drive the SDK
// callbacks (onsessioninitialized / onsessionclosed / onclose) directly.
const mockTransports = [];
jest.mock(
  '@modelcontextprotocol/sdk/server/streamableHttp.js',
  () => ({
    StreamableHTTPServerTransport: class MockStreamableHTTPServerTransport {
      constructor(options) {
        this.options = options;
        this.sessionId = undefined;
        this.onclose = undefined;
        this.handleRequest = jest.fn(async (req, res) => {
          if (!this.sessionId) {
            this.sessionId = `session-${mockTransports.length}`;
            await options.onsessioninitialized?.(this.sessionId);
          }
          res.writeHead(200);
          res.end();
        });
        this.close = jest.fn(async () => {
          this.onclose?.();
        });
        mockTransports.push(this);
      }
    }
  }),
  { virtual: true }
);

jest.mock('../../../src/main/transports/mcp/transport', () => ({
  createTransport: jest.fn(async () => ({ port: 8765, close: jest.fn() }))
}));

jest.mock('../../../src/main/transports/mcp/auth', () => ({
  createAuthMiddleware: jest.fn(() => (req, res, next) => next())
}));

jest.mock('../../../src/main/transports/mcp/originGuard', () => ({
  createOriginGuard: jest.fn(() => (req, res, next) => next())
}));

jest.mock('../../../src/main/transports/mcp/rateLimit', () => ({
  createRateLimit: jest.fn(() => (req, res, next) => next())
}));

jest.mock('../../../src/main/transports/mcp/bodyLimit', () => ({
  createBodyLimit: jest.fn(() => (req, res, next) => next())
}));

const { createTransport } = require('../../../src/main/transports/mcp/transport');
const { createMcpServer } = require('../../../src/main/transports/mcp');

const fakeServices = {
  smartFolders: { list: async () => [] },
  analysisHistory: { getAll: () => ({}), getAnalysisByPath: async () => null },
  search: { hybridSearch: async () => ({ results: [], total: 0 }) },
  chat: { runOnce: async () => ({ answer: '', citations: [], sessionId: 's' }) }
};

async function startServer(extra = {}) {
  const server = await createMcpServer({
    services: fakeServices,
    getToken: () => 'a'.repeat(64),
    ...extra
  });
  const { requestHandler } = createTransport.mock.calls.at(-1)[0];
  return { server, requestHandler };
}

function send(requestHandler, { method = 'POST', headers = {} } = {}) {
  return new Promise((resolve) => {
    const res = {
      headersSent: false,
      statusCode: null,
      body: '',
      writeHead(code) {
        this.statusCode = code;
        this.headersSent = true;
      },
      end(chunk) {
        if (chunk) this.body += chunk;
        resolve(res);
      }
    };
    requestHandler({ url: '/mcp', method, headers }, res);
  });
}

describe('createMcpServer', () => {
  beforeEach(() => {
    mockTransports.length = 0;
  });

  test('starts and stops cleanly with all 4 tools registered', async () => {
    const { server } = await startServer();
    expect(server.toolNames.sort()).toEqual([
      'chat_with_documents',
      'get_document_summary',
      'list_smart_folders',
      'search_documents'
    ]);
    expect(server.port).toBeGreaterThan(0);
    await server.close();
  });

  // H8: an unknown session id must be answered with the SDK-conventional 404
  // (so clients re-initialize) without spinning up a throwaway McpServer.
  test('POST with an unknown session id returns 404 JSON-RPC error and creates no transport', async () => {
    const { server, requestHandler } = await startServer();
    const res = await send(requestHandler, { headers: { 'mcp-session-id': 'stale' } });
    expect(res.statusCode).toBe(404);
    expect(JSON.parse(res.body)).toEqual({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found' },
      id: null
    });
    expect(mockTransports).toHaveLength(0);
    await server.close();
  });

  test('header-less POST creates a session and later POSTs route to that transport', async () => {
    const { server, requestHandler } = await startServer();
    await send(requestHandler);
    expect(mockTransports).toHaveLength(1);
    const [transport] = mockTransports;

    await send(requestHandler, { headers: { 'mcp-session-id': transport.sessionId } });
    expect(transport.handleRequest).toHaveBeenCalledTimes(2);
    expect(mockTransports).toHaveLength(1);
    await server.close();
  });

  // H9: the SDK fires onsessionclosed on DELETE — the map entry must go.
  test('onsessionclosed removes the session so its id is unknown afterwards', async () => {
    const { server, requestHandler } = await startServer();
    await send(requestHandler);
    const [transport] = mockTransports;
    expect(typeof transport.options.onsessionclosed).toBe('function');

    await transport.options.onsessionclosed(transport.sessionId);

    const res = await send(requestHandler, { headers: { 'mcp-session-id': transport.sessionId } });
    expect(res.statusCode).toBe(404);
    expect(transport.handleRequest).toHaveBeenCalledTimes(1);
    await server.close();
  });

  // H9: transport.onclose (fired by the SDK when the transport is torn down)
  // must also drop the entry.
  test('transport.onclose removes the session', async () => {
    const { server, requestHandler } = await startServer();
    await send(requestHandler);
    const [transport] = mockTransports;

    transport.onclose();

    const res = await send(requestHandler, { headers: { 'mcp-session-id': transport.sessionId } });
    expect(res.statusCode).toBe(404);
    await server.close();
  });

  test('idle sweep closes sessions with no traffic for sessionIdleMs and keeps active ones', async () => {
    jest.useFakeTimers();
    try {
      const { server, requestHandler } = await startServer({ sessionIdleMs: 1000 });
      await send(requestHandler);
      await send(requestHandler);
      const [idle, active] = mockTransports;

      // Sweep interval is min(60 s, sessionIdleMs) = 1 s. At the t=1 s tick
      // neither session is older than 1 s yet.
      jest.advanceTimersByTime(1500);
      expect(idle.close).not.toHaveBeenCalled();
      expect(active.close).not.toHaveBeenCalled();

      // Touch `active` at t=1.5 s so only `idle` (last seen t=0) is stale at t=2 s.
      await send(requestHandler, { headers: { 'mcp-session-id': active.sessionId } });
      jest.advanceTimersByTime(500);

      expect(idle.close).toHaveBeenCalledTimes(1);
      expect(active.close).not.toHaveBeenCalled();

      const res = await send(requestHandler, { headers: { 'mcp-session-id': idle.sessionId } });
      expect(res.statusCode).toBe(404);
      const stillLive = await send(requestHandler, {
        headers: { 'mcp-session-id': active.sessionId }
      });
      expect(stillLive.statusCode).toBe(200);

      await server.close();
    } finally {
      jest.useRealTimers();
    }
  });

  test('close() cancels the sweep and closes every live session', async () => {
    jest.useFakeTimers();
    try {
      const clearSpy = jest.spyOn(global, 'clearInterval');
      const { server, requestHandler } = await startServer();
      await send(requestHandler);
      await send(requestHandler);

      await server.close();

      expect(clearSpy).toHaveBeenCalled();
      for (const transport of mockTransports) {
        expect(transport.close).toHaveBeenCalledTimes(1);
      }
      clearSpy.mockRestore();
    } finally {
      jest.useRealTimers();
    }
  });
});
