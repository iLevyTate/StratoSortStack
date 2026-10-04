/**
 * @jest-environment node
 *
 * Integration test for MCP server JSON-RPC round trip.
 * Tests the server initialization and tool methods directly without SDK client
 * (due to Jest ESM/fetch compatibility issues with the SDK).
 * Validates that the real server correctly:
 * 1. Accepts and validates authentication
 * 2. Processes JSON-RPC requests
 * 3. Returns properly formatted responses
 * 4. Rejects unauthenticated requests
 */

'use strict';

const http = require('http');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const { startMcpServer } = require('../../../src/main/transports/mcp/server');

const TOKEN = 'a'.repeat(64);

const SERVICES = {
  smartFolders: {
    list: async () => [{ id: 'f1', name: 'Tax', path: '/t', description: '', fileCount: 1 }]
  },
  // get_document_summary reads analysisHistory.getAnalysisByPath (the
  // old services.analysisCache injection is dead — keep the mock on
  // the real contract so summary assertions exercise the tool path).
  analysisHistory: {
    getAll: () => ({}),
    getAnalysisByPath: async (p) =>
      p === '/t/a.pdf'
        ? {
            fileName: 'a.pdf',
            originalPath: '/t/a.pdf',
            analysis: {
              summary: 's',
              category: 'Tax',
              keywords: [],
              confidence: 90
            },
            timestamp: new Date(0).toISOString()
          }
        : null
  },
  search: { hybridSearch: async () => ({ results: [], total: 0 }) },
  chat: {
    runOnce: async () => ({
      sessionId: 's',
      answer: 'ok',
      citations: [],
      tokens_used: { prompt: 0, completion: 0 }
    })
  }
};

function startTestServer() {
  return startMcpServer({ services: SERVICES, getToken: () => TOKEN, port: 0 });
}

describe('MCP server integration', () => {
  let server;

  beforeAll(async () => {
    server = await startTestServer();
  });

  afterAll(async () => {
    if (server) await server.close();
  });

  function makeRequest(method, path, body, headers = {}) {
    return new Promise((resolve, reject) => {
      // Serialize up front so Content-Length can be set explicitly. Without
      // it Node's http client sends Transfer-Encoding: chunked, which the
      // body-limit middleware rejects with 411 by design (real MCP clients
      // always send Content-Length for JSON-RPC posts).
      const payload = body ? JSON.stringify(body) : null;
      const options = {
        hostname: '127.0.0.1',
        port: server.port,
        path,
        method,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
          ...headers
        }
      };

      const req = http.request(options, (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => {
          // Parse response based on content-type
          let parsedBody = data;
          const contentType = res.headers['content-type'] || '';
          try {
            if (contentType.includes('application/json')) {
              parsedBody = JSON.parse(data);
            } else if (contentType.includes('text/event-stream')) {
              // Parse SSE format: "event: message\ndata: {...}\n\n"
              const lines = data.split('\n');
              const jsonLines = [];
              for (const line of lines) {
                if (line.startsWith('data: ')) {
                  jsonLines.push(JSON.parse(line.slice(6)));
                }
              }
              // For SSE, combine all data messages into the response
              parsedBody = jsonLines.length === 1 ? jsonLines[0] : jsonLines;
            }
          } catch (e) {
            // If parsing fails, return raw data
            parsedBody = data;
          }

          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: data,
            contentType,
            parsed: parsedBody
          });
        });
      });

      req.on('error', reject);

      if (payload) {
        req.write(payload);
      }
      req.end();
    });
  }

  test('initialize with authentication', async () => {
    // Full JSON-RPC 2.0 round trip: client -> server -> response
    const initResp = await makeRequest(
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' }
        }
      },
      { Authorization: `Bearer ${TOKEN}` }
    );

    expect(initResp.statusCode).toBe(200);
    const initBody = initResp.parsed;
    expect(initBody.jsonrpc).toBe('2.0');
    expect(initBody.id).toBe(1);
    expect(initBody.result).toBeDefined();
    expect(initBody.result.serverInfo).toBeDefined();
    expect(initBody.result.serverInfo.name).toBe('stratosort');
  });

  const INIT_BODY = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1.0' }
    }
  };
  const LIST_BODY = { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} };
  const AUTH = { Authorization: `Bearer ${TOKEN}` };

  async function openSession() {
    const initResp = await makeRequest('POST', '/mcp', INIT_BODY, AUTH);
    expect(initResp.statusCode).toBe(200);
    const sessionId = initResp.headers['mcp-session-id'];
    expect(typeof sessionId).toBe('string');
    return { sessionId, headers: { ...AUTH, 'mcp-session-id': sessionId } };
  }

  // H8: a stale/unknown session id (e.g. a client reconnecting after an app
  // restart) must get the SDK-conventional 404 so the client re-initializes,
  // instead of a throwaway transport's 400 "Server not initialized".
  test('POST with an unknown Mcp-Session-Id returns 404 Session not found', async () => {
    const resp = await makeRequest('POST', '/mcp', LIST_BODY, {
      ...AUTH,
      'mcp-session-id': 'stale-session-from-previous-run'
    });
    expect(resp.statusCode).toBe(404);
    expect(resp.parsed).toMatchObject({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found' }
    });
  });

  test('GET/DELETE with an unknown Mcp-Session-Id return 404 Session not found', async () => {
    for (const method of ['GET', 'DELETE']) {
      const resp = await makeRequest(method, '/mcp', null, {
        ...AUTH,
        'mcp-session-id': 'never-existed'
      });
      expect(resp.statusCode).toBe(404);
      expect(resp.parsed).toMatchObject({ error: { code: -32001 } });
    }
  });

  // H9: DELETE must actually release the per-session transport; the id is
  // then unknown to the server rather than lingering as a dead map entry.
  test('DELETE terminates the session and subsequent requests with that id get 404', async () => {
    const { sessionId, headers } = await openSession();

    const listBefore = await makeRequest('POST', '/mcp', LIST_BODY, headers);
    expect(listBefore.statusCode).toBe(200);

    const del = await makeRequest('DELETE', '/mcp', null, headers);
    expect(del.statusCode).toBe(200);

    const listAfter = await makeRequest('POST', '/mcp', LIST_BODY, {
      ...AUTH,
      'mcp-session-id': sessionId
    });
    expect(listAfter.statusCode).toBe(404);
    expect(listAfter.parsed).toMatchObject({ error: { code: -32001 } });
  });

  test('rejects unauthenticated requests', async () => {
    const resp = await makeRequest(
      'POST',
      '/mcp',
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' }
        }
      }
      // No Authorization header
    );

    expect(resp.statusCode).toBe(401);
    const body = resp.parsed;
    expect(body.error).toBeDefined();
    expect(body.error.code).toBe(-32001);
  });

  // M1: a header-less POST allocates an McpServer + transport pair before the
  // SDK can reject it. Rejected pairs never reach `sessions`, so they must be
  // closed by the handler itself or they leak one server per attempt.
  test('header-less non-initialize POSTs are rejected without leaking a session', async () => {
    const closeSpy = jest.spyOn(McpServer.prototype, 'close');
    const attempts = 5;
    const liveBefore = server.sessionCount();
    try {
      for (let i = 0; i < attempts; i++) {
        const resp = await makeRequest('POST', '/mcp', LIST_BODY, AUTH);
        expect(resp.statusCode).toBe(400);
      }
      expect(server.sessionCount()).toBe(liveBefore);
      expect(closeSpy).toHaveBeenCalledTimes(attempts);
    } finally {
      closeSpy.mockRestore();
    }
  });

  // M5: auth runs before the rate limiter, so unauthenticated traffic never
  // touches a bucket. With the old rate→auth order the same bogus credential
  // would have started drawing 429s after 60 requests.
  test('repeated bogus bearer requests are all 401, never 429', async () => {
    const responses = await Promise.all(
      Array.from({ length: 200 }, () =>
        makeRequest('POST', '/mcp', INIT_BODY, { Authorization: 'Bearer not-the-token' })
      )
    );
    expect(responses.map((r) => r.statusCode)).toEqual(Array(200).fill(401));
  });

  // The bucket refills at 1 token/s while the loop runs, so the exact request
  // that trips is timing-dependent here; rateLimit.test.js pins "61st is 429"
  // under a frozen clock. This test proves the limiter is keyed per session.
  test('per-session buckets: a session exceeding 60/min is 429, other sessions unaffected', async () => {
    const first = await openSession();
    const statuses = [];
    for (let i = 0; i < 70; i++) {
      const resp = await makeRequest('POST', '/mcp', LIST_BODY, first.headers);
      statuses.push(resp.statusCode);
    }
    expect(statuses.slice(0, 60)).toEqual(Array(60).fill(200));
    expect(statuses.slice(60)).toContain(429);

    const second = await openSession();
    const other = await makeRequest('POST', '/mcp', LIST_BODY, second.headers);
    expect(other.statusCode).toBe(200);
  }, 15000);
});

// M2: http.Server.close() waits for every connection to end and never
// terminates them, so a client parked on the standalone GET SSE stream used to
// hang close() — and with it McpServerLifecycleService.disable() — forever.
describe('MCP server close() with an open SSE stream', () => {
  function post(port, body, headers) {
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify(body);
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json, text/event-stream',
            'Content-Length': Buffer.byteLength(payload),
            ...headers
          }
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res));
        }
      );
      req.on('error', reject);
      req.end(payload);
    });
  }

  function openSseStream(port, headers) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: '/mcp',
          method: 'GET',
          headers: { Accept: 'text/event-stream', ...headers }
        },
        (res) => {
          res.on('error', () => {});
          res.resume();
          resolve(res);
        }
      );
      req.on('error', () => {});
      req.end();
    });
  }

  test('resolves promptly while a client holds the standalone GET SSE stream', async () => {
    const server = await startTestServer();
    const init = await post(
      server.port,
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' }
        }
      },
      { Authorization: `Bearer ${TOKEN}` }
    );
    const sessionId = init.headers['mcp-session-id'];
    expect(typeof sessionId).toBe('string');

    const sse = await openSseStream(server.port, {
      Authorization: `Bearer ${TOKEN}`,
      'mcp-session-id': sessionId
    });
    expect(sse.statusCode).toBe(200);
    expect(sse.headers['content-type']).toContain('text/event-stream');

    const startedAt = Date.now();
    await server.close();
    expect(Date.now() - startedAt).toBeLessThan(1000);
    expect(server.sessionCount()).toBe(0);
  }, 3000);
});
