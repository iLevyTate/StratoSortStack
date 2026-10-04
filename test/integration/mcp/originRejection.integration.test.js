/**
 * @jest-environment node
 *
 * Integration test for MCP server DNS-rebinding defense.
 * Verifies that origin validation rejects HTTP/HTTPS origins
 * (DNS-rebinding attack prevention) while allowing native clients
 * (missing Origin header).
 */

'use strict';

const http = require('node:http');
const { startMcpServer } = require('../../../src/main/transports/mcp/server');

function postJson({ port, path, body, headers }) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data),
          ...headers
        }
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () =>
          resolve({
            status: res.statusCode,
            body: Buffer.concat(chunks).toString('utf8')
          })
        );
      }
    );
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

describe('MCP origin rejection', () => {
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

  test('rejects http:// origin with 403', async () => {
    const res = await postJson({
      port: server.port,
      path: '/mcp',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      headers: { Origin: 'http://evil.example.com', Authorization: `Bearer ${TOKEN}` }
    });
    expect(res.status).toBe(403);
    const body = JSON.parse(res.body);
    expect(body.error.message).toBe('ORIGIN_FORBIDDEN');
  });

  test('rejects https:// origin with 403', async () => {
    const res = await postJson({
      port: server.port,
      path: '/mcp',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} },
      headers: { Origin: 'https://example.com', Authorization: `Bearer ${TOKEN}` }
    });
    expect(res.status).toBe(403);
  });

  test('allows missing Origin header (native client)', async () => {
    const res = await postJson({
      port: server.port,
      path: '/mcp',
      body: {
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'test', version: '1.0' }
        }
      },
      headers: { Authorization: `Bearer ${TOKEN}`, Accept: 'application/json, text/event-stream' }
    });
    // Should NOT be 403 (origin guard passes); auth + JSON-RPC should succeed.
    expect([200, 202]).toContain(res.status);
  });
});
