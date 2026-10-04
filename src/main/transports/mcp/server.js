// @ts-check
'use strict';

const crypto = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
const {
  StreamableHTTPServerTransport
} = require('@modelcontextprotocol/sdk/server/streamableHttp.js');

const { createTransport } = require('./transport');
const { createAuthMiddleware } = require('./auth');
const { createOriginGuard } = require('./originGuard');
const { createRateLimit } = require('./rateLimit');
const { createBodyLimit } = require('./bodyLimit');
const { TIMEOUTS } = require('../../../shared/performanceConstants');

const { registerListSmartFolders } = require('./tools/listSmartFolders');
const { registerGetDocumentSummary } = require('./tools/getDocumentSummary');
const { registerSearchDocuments } = require('./tools/searchDocuments');
const { registerChatWithDocuments } = require('./tools/chatWithDocuments');

const SESSION_SWEEP_INTERVAL_MS = 60 * 1000;

/**
 * @typedef {import('@modelcontextprotocol/sdk/server/streamableHttp.js').StreamableHTTPServerTransport} SessionTransport
 * @typedef {{ transport: SessionTransport, mcp: McpServer, lastActivityAt: number }} SessionEntry
 */

/**
 * @param {any} mcp
 * @param {any} services
 */
function registerTools(mcp, services) {
  const toolNames = [];
  toolNames.push(registerListSmartFolders(mcp, services));
  toolNames.push(registerGetDocumentSummary(mcp, services));
  toolNames.push(registerSearchDocuments(mcp, services));
  toolNames.push(registerChatWithDocuments(mcp, services));
  return toolNames;
}

/**
 * JSON-RPC error body matching the SDK's own "Session not found" response, so
 * clients that re-initialize on 404 (Claude Desktop, Cursor) recover after an
 * app restart instead of treating the server as broken.
 * @param {any} res
 */
function respondSessionNotFound(res) {
  res.writeHead(404, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32001, message: 'Session not found' },
      id: null
    })
  );
}

/**
 * @param {{ services: any, getToken: () => string, port: number, logger?: any, sessionIdleMs?: number }} args
 */
async function startMcpServer({
  services,
  getToken,
  port,
  logger = null,
  sessionIdleMs = TIMEOUTS.MCP_SESSION_IDLE
}) {
  const toolProbe = new McpServer({ name: 'stratosort', version: '1.0.0' });
  const toolNames = registerTools(toolProbe, services);

  /** @type {Map<string, SessionEntry>} */
  const sessions = new Map();

  /** @param {string | undefined} sessionId */
  const forgetSession = (sessionId) => {
    if (sessionId) sessions.delete(sessionId);
  };

  /** @param {SessionEntry} entry */
  const closeSession = async (entry) => {
    forgetSession(entry.transport.sessionId);
    try {
      // Closing the McpServer closes its transport, which fires onclose.
      await entry.mcp.close();
    } catch (err) {
      logger?.warn?.('[mcp] session close failed', { error: err?.message });
    }
  };

  /**
   * @returns {Promise<{ transport: SessionTransport, mcp: McpServer }>}
   */
  async function createSessionTransport() {
    const sessionMcp = new McpServer({ name: 'stratosort', version: '1.0.0' });
    registerTools(sessionMcp, services);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => crypto.randomUUID(),
      onsessioninitialized: (/** @type {string} */ sessionId) => {
        sessions.set(sessionId, { transport, mcp: sessionMcp, lastActivityAt: Date.now() });
      },
      onsessionclosed: forgetSession
    });
    // Set before connect(): the SDK's Protocol.connect chains any existing
    // onclose handler rather than replacing it.
    transport.onclose = () => forgetSession(transport.sessionId);
    await sessionMcp.connect(transport);
    return { transport, mcp: sessionMcp };
  }

  const sweepIdleSessions = () => {
    const cutoff = Date.now() - sessionIdleMs;
    for (const entry of sessions.values()) {
      if (entry.lastActivityAt < cutoff) void closeSession(entry);
    }
  };
  const sweepTimer = setInterval(
    sweepIdleSessions,
    Math.min(SESSION_SWEEP_INTERVAL_MS, sessionIdleMs)
  );
  sweepTimer.unref?.();

  const auth = createAuthMiddleware(getToken);
  const origin = createOriginGuard();
  const rate = createRateLimit({ limitPerMin: 60 });
  const bodyLimit = createBodyLimit();

  const sessionHandler = async (/** @type {any} */ req, /** @type {any} */ res) => {
    const urlPath = String(req.url || '').split('?')[0];
    if (!urlPath.startsWith('/mcp')) {
      res.writeHead(404);
      return res.end();
    }

    if (req.method !== 'GET' && req.method !== 'DELETE' && req.method !== 'POST') {
      res.writeHead(405);
      return res.end();
    }

    const sessionIdHeader = req.headers['mcp-session-id'];
    const sessionId = Array.isArray(sessionIdHeader) ? sessionIdHeader[0] : sessionIdHeader;

    if (sessionId) {
      const existing = sessions.get(sessionId);
      if (!existing) return respondSessionNotFound(res);
      existing.lastActivityAt = Date.now();
      return existing.transport.handleRequest(req, res);
    }

    // Only a header-less POST (initialize) may create a session; the SDK
    // rejects anything else with its own 400.
    if (req.method !== 'POST') return respondSessionNotFound(res);

    const { transport, mcp } = await createSessionTransport();
    try {
      await transport.handleRequest(req, res);
    } finally {
      // The SDK assigns sessionId and awaits onsessioninitialized inside
      // handlePostRequest before producing the response, so a valid
      // initialize is registered (and owned by `sessions`) by now. Anything
      // the SDK rejected (400/406/415, bad body) never got an id and would
      // otherwise leak forever.
      if (!transport.sessionId) await mcp.close().catch(() => {});
    }
  };

  // Auth runs before the rate limiter so unauthenticated callers cannot mint
  // a fresh bucket per bogus credential; the limiter keys on the
  // server-issued session id, which only exists past auth.
  const requestHandler = (/** @type {any} */ req, /** @type {any} */ res) => {
    origin(req, res, () =>
      bodyLimit(req, res, () =>
        auth(req, res, () =>
          rate(req, res, () => {
            Promise.resolve(sessionHandler(req, res)).catch((err) => {
              logger?.warn?.('[mcp] request handler failed', { error: err?.message });
              if (!res.headersSent) {
                res.writeHead(500);
                res.end();
              }
            });
          })
        )
      )
    );
  };

  const transport = await createTransport({ requestHandler, port, logger });
  return {
    port: transport.port,
    toolNames,
    sessionCount: () => sessions.size,
    close: async () => {
      clearInterval(sweepTimer);
      // Sessions first so open SSE streams end cleanly before the transport
      // tears down whatever connections remain.
      await Promise.all(Array.from(sessions.values(), closeSession));
      sessions.clear();
      await transport.close();
    }
  };
}

module.exports = { startMcpServer };
