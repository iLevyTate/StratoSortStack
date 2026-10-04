// @ts-check
'use strict';

const http = require('node:http');

const MCP_ACCEPT = 'application/json, text/event-stream';
const MCP_PROTOCOL_VERSION = '2024-11-05';

function parseMcpPayload(/** @type {any} */ contentType, /** @type {any} */ rawBody) {
  if ((contentType || '').includes('application/json')) {
    return JSON.parse(rawBody);
  }
  for (const line of rawBody.split('\n')) {
    if (line.startsWith('data: ')) {
      return JSON.parse(line.slice(6));
    }
  }
  throw new Error('Unexpected MCP response format');
}

/**
 * @param {{ port: number, token: string, method: 'POST' | 'DELETE', body?: any, headers?: Record<string, any> }} args
 */
function mcpRequest({ port, token, method, body, headers = {} }) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/mcp',
        method,
        headers: {
          ...(payload !== null
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) }
            : {}),
          Accept: MCP_ACCEPT,
          Authorization: `Bearer ${token}`,
          ...headers
        }
      },
      (/** @type {any} */ res) => {
        /** @type {Buffer[]} */
        const chunks = [];
        res.on('data', (/** @type {Buffer} */ chunk) => chunks.push(chunk));
        res.on('end', () => {
          const rawBody = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode,
            headers: res.headers,
            rawBody,
            parsed: (() => {
              try {
                return parseMcpPayload(res.headers['content-type'], rawBody);
              } catch {
                return null;
              }
            })()
          });
        });
      }
    );
    req.on('error', reject);
    if (payload !== null) req.write(payload);
    req.end();
  });
}

/**
 * @param {{ port: number, token: string, body: any, headers?: Record<string, any> }} args
 */
function postMcpJson({ port, token, body, headers = {} }) {
  return mcpRequest({ port, token, method: 'POST', body, headers });
}

/**
 * Terminate a Streamable HTTP session so the server can release its per-session McpServer.
 * @param {{ port: number, token: string, sessionId: string, protocolVersion?: string }} args
 */
function deleteMcpSession({ port, token, sessionId, protocolVersion = MCP_PROTOCOL_VERSION }) {
  return mcpRequest({
    port,
    token,
    method: 'DELETE',
    headers: { 'mcp-session-id': sessionId, 'mcp-protocol-version': protocolVersion }
  });
}

/**
 * @param {{ port: number, token: string, clientName?: string }} args
 * @returns {Promise<{ tools: string[] }>}
 */
async function probeMcpTools({ port, token, clientName = 'stratosort-connection-test' }) {
  const initRes = await postMcpJson({
    port,
    token,
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: clientName, version: '1.0.0' }
      }
    }
  });

  if (initRes.status < 200 || initRes.status >= 300) {
    throw new Error(initRes.parsed?.error?.message || `HTTP ${initRes.status}`);
  }

  const sessionId = initRes.headers['mcp-session-id'];
  const protocolVersion = initRes.parsed?.result?.protocolVersion || MCP_PROTOCOL_VERSION;

  try {
    const listRes = await postMcpJson({
      port,
      token,
      headers: {
        'mcp-session-id': sessionId,
        'mcp-protocol-version': protocolVersion
      },
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
    });
    if (listRes.status < 200 || listRes.status >= 300) {
      throw new Error(`HTTP ${listRes.status}`);
    }

    return {
      tools: listRes.parsed?.result?.tools?.map((/** @type {any} */ t) => t.name) || []
    };
  } finally {
    // The probe is a throwaway client; without DELETE every "Test connection"
    // click would leave a live McpServer behind until the idle sweep.
    if (sessionId) {
      await deleteMcpSession({ port, token, sessionId, protocolVersion }).catch(() => {});
    }
  }
}

module.exports = {
  MCP_ACCEPT,
  MCP_PROTOCOL_VERSION,
  parseMcpPayload,
  postMcpJson,
  deleteMcpSession,
  probeMcpTools
};
