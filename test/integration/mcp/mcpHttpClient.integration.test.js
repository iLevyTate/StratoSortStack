/**
 * @jest-environment node
 */

'use strict';

const http = require('node:http');
const { probeMcpTools, postMcpJson } = require('../../../src/main/transports/mcp/httpClient');
const { startMcpServer } = require('../../../src/main/transports/mcp/server');

const TOOL_NAMES = [
  'list_smart_folders',
  'get_document_summary',
  'search_documents',
  'chat_with_documents'
];

describe('MCP httpClient probe', () => {
  let server;
  const TOKEN = 'a'.repeat(64);

  beforeAll(async () => {
    server = await startMcpServer({
      services: {
        smartFolders: { list: async () => [] },
        analysisHistory: { getAll: () => ({}), getAnalysisByPath: async () => null },
        search: { hybridSearch: async () => ({ results: [], total: 0 }) },
        chat: { runOnce: async () => ({}) }
      },
      getToken: () => TOKEN,
      port: 0
    });
  });

  afterAll(async () => {
    if (server) await server.close();
  });

  test('probeMcpTools lists registered tools over HTTP', async () => {
    const result = await probeMcpTools({ port: server.port, token: TOKEN });
    expect(result).not.toHaveProperty('sessionActive');
    expect(result.tools).toEqual(expect.arrayContaining(TOOL_NAMES));
  });

  test('probeMcpTools succeeds for a second concurrent client', async () => {
    const result = await probeMcpTools({ port: server.port, token: TOKEN });
    expect(result.tools).toEqual(expect.arrayContaining(TOOL_NAMES));
  });

  test('probeMcpTools terminates its session with DELETE so the server can release it', async () => {
    const requestSpy = jest.spyOn(http, 'request');
    try {
      await probeMcpTools({ port: server.port, token: TOKEN });
      const methods = requestSpy.mock.calls.map(([options]) => options.method);
      expect(methods).toEqual(['POST', 'POST', 'DELETE']);

      const initOptions = requestSpy.mock.calls[0][0];
      const deleteOptions = requestSpy.mock.calls[2][0];
      expect(initOptions.headers['mcp-session-id']).toBeUndefined();
      expect(deleteOptions.headers['mcp-session-id']).toEqual(expect.any(String));
      // The DELETE must target the session that initialize created.
      const sessionId = requestSpy.mock.calls[1][0].headers['mcp-session-id'];
      expect(deleteOptions.headers['mcp-session-id']).toBe(sessionId);

      // And the server must have honoured it: the id is now unknown.
      const after = await postMcpJson({
        port: server.port,
        token: TOKEN,
        headers: { 'mcp-session-id': sessionId },
        body: { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} }
      });
      expect(after.status).toBe(404);
      expect(after.parsed?.error?.code).toBe(-32001);
    } finally {
      requestSpy.mockRestore();
    }
  });
});
