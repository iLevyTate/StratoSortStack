#!/usr/bin/env node
'use strict';

const { postMcpJson, MCP_PROTOCOL_VERSION } = require('../src/main/transports/mcp/httpClient');
const { startMcpServer } = require('../src/main/transports/mcp/server');

const TOKEN = 'a'.repeat(64);

const expected = {
  search_documents: ['query', 'top_k', 'mode', 'smart_folder_id'],
  chat_with_documents: ['query', 'session_id', 'max_context_files', 'persona'],
  get_document_summary: ['file_path'],
  list_smart_folders: []
};

async function listTools(port) {
  const initRes = await postMcpJson({
    port,
    token: TOKEN,
    body: {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'verify-mcp-contracts', version: '1.0.0' }
      }
    }
  });
  if (initRes.status === 400 && initRes.parsed?.error?.message?.includes('already initialized')) {
    throw new Error('MCP server already initialized by another client');
  }
  if (initRes.status !== 200 && initRes.status !== 202) {
    console.error(`initialize returned HTTP ${initRes.status}`);
    console.error(`Content-Type: ${initRes.headers['content-type'] || ''}`);
    console.error(`Body: ${initRes.rawBody.slice(0, 1000)}`);
    process.exit(2);
  }

  const sessionId = initRes.headers['mcp-session-id'];
  const protocolVersion = initRes.parsed?.result?.protocolVersion || MCP_PROTOCOL_VERSION;

  return postMcpJson({
    port,
    token: TOKEN,
    headers: {
      'mcp-session-id': sessionId,
      'mcp-protocol-version': protocolVersion
    },
    body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }
  });
}

(async () => {
  const { SearchService } = require('../src/main/services/SearchService');
  const ChatService = require('../src/main/services/ChatService');
  if (typeof SearchService.prototype.hybridSearch !== 'function') {
    console.error('SearchService.prototype.hybridSearch is missing — MCP stubs would hide this');
    process.exit(2);
  }
  if (typeof ChatService.prototype.runOnce !== 'function') {
    console.error('ChatService.prototype.runOnce is missing — MCP stubs would hide this');
    process.exit(2);
  }

  const services = {
    smartFolders: { list: async () => [] },
    analysisHistory: { getAll: () => ({}), getAnalysisByPath: async () => null },
    search: { hybridSearch: async () => ({ results: [], total: 0 }) },
    chat: {
      runOnce: async () => ({
        sessionId: 's',
        answer: '',
        citations: [],
        tokens_used: { prompt: 0, completion: 0 }
      })
    }
  };
  const server = await startMcpServer({
    services,
    getToken: () => TOKEN,
    port: 0
  });

  try {
    const res = await listTools(server.port);
    if (res.status !== 200 && res.status !== 202) {
      console.error(`tools/list returned HTTP ${res.status}`);
      console.error(`Content-Type: ${res.headers['content-type'] || ''}`);
      console.error(`Body: ${res.rawBody.slice(0, 1000)}`);
      process.exit(2);
    }
    const parsed = res.parsed;
    if (!parsed?.result?.tools) {
      console.error('tools/list response missing result.tools', parsed);
      process.exit(2);
    }
    const actual = Object.fromEntries(
      parsed.result.tools.map((t) => [t.name, Object.keys(t.inputSchema?.properties || {})])
    );
    let ok = true;
    for (const [name, keys] of Object.entries(expected)) {
      if (!actual[name]) {
        console.error(`MISSING TOOL: ${name}`);
        ok = false;
        continue;
      }
      const a = actual[name].slice().sort();
      const e = keys.slice().sort();
      if (JSON.stringify(a) !== JSON.stringify(e)) {
        console.error(`SCHEMA DRIFT: ${name}`);
        console.error(`  expected: ${e.join(',')}`);
        console.error(`  actual:   ${a.join(',')}`);
        ok = false;
      }
    }
    // Unexpected tools are drift too: a tool added without updating this
    // contract (and docs/MCP_SERVER.md) ships unreviewed surface area.
    for (const name of Object.keys(actual)) {
      if (!Object.prototype.hasOwnProperty.call(expected, name)) {
        console.error(`UNEXPECTED TOOL: ${name} (add to scripts/verify-mcp-contracts.js + docs)`);
        ok = false;
      }
    }
    // Every declared input property must carry a type and a description —
    // clients rely on both for parameter coercion and tool-call planning.
    for (const tool of parsed.result.tools) {
      const props = tool.inputSchema?.properties || {};
      for (const [propName, propSchema] of Object.entries(props)) {
        if (!propSchema || typeof propSchema !== 'object' || !propSchema.type) {
          console.error(`SCHEMA CONSTRAINT: ${tool.name}.${propName} missing JSON-schema type`);
          ok = false;
        } else if (typeof propSchema.description !== 'string' || !propSchema.description.trim()) {
          console.error(`SCHEMA CONSTRAINT: ${tool.name}.${propName} missing description`);
          ok = false;
        }
      }
    }
    if (!ok) process.exit(1);
    console.log('MCP contracts OK');
  } finally {
    await server.close();
  }
})().catch((e) => {
  console.error(e);
  process.exit(2);
});
