// @ts-check
'use strict';

const { app } = require('electron');
const { IpcServiceContext, createFromLegacyParams } = require('./IpcServiceContext');
const { registerHandlers, safeSendToMain } = require('./ipcWrappers');
const { schemas } = require('./validationSchemas');
const { container, ServiceIds } = require('../services/ServiceContainer');
// McpServerLifecycleService and configSnippets are loaded lazily so this module
// (which is required by src/main/ipc/index.js for ALL handler registration) does
// not pull in @modelcontextprotocol/sdk + @hono/node-server at import time. The
// SDK has ESM-loading quirks under Jest that break unrelated IPC tests if loaded
// eagerly. Lazy require keeps the SDK out of the boot path until MCP is enabled.

/** @type {any} */
let _lifecycle = null;
/** @type {string[]} */
let _registeredChannels = [];
/** @type {((event: import('electron').Event) => void) | null} */
let _willQuitHandler = null;
let _disposing = false;

/**
 * @param {string|null|undefined} token
 */
function _mask(token) {
  return token ? `${token.slice(0, 4)}....` : null;
}

function _ok(extra = {}) {
  return { success: true, ...extra };
}

// Sanitize error messages before they reach the renderer. MCP-side errors
// can carry absolute file paths, model names, llama.cpp internals, and other
// internal-state strings; we want to keep IPC error responses bounded to a
// short, classified shape rather than leaking raw err.message.
const SAFE_MESSAGE_MAX = 240;
/**
 * @param {unknown} message
 */
function _sanitizeMessage(message) {
  let out = String(message ?? '').slice(0, SAFE_MESSAGE_MAX);
  // Windows-style absolute paths: drive letter + backslash.
  out = out.replace(/[A-Z]:\\[^\s"']+/gi, '<path>');
  // Posix-style absolute paths: at the start of the string or after whitespace
  // or quote characters. Anchored matching avoids mangling URLs like
  // https://api.openai.com/v1 or JSON like {"key":"/value"}.
  out = out.replace(/(^|[\s"'(])\/[A-Za-z0-9_./-]+/g, '$1<path>');
  return out;
}

/**
 * @param {{ message?: string, code?: string }} err
 */
function _fail(err) {
  return { success: false, error: _sanitizeMessage(err.message || String(err)), code: err.code };
}

/**
 * @param {IpcServiceContext|Record<string, any>} servicesOrParams - Service context or legacy parameters
 */
function registerMcpIpc(servicesOrParams) {
  const context =
    servicesOrParams instanceof IpcServiceContext
      ? servicesOrParams
      : createFromLegacyParams(servicesOrParams);

  const { ipcMain, IPC_CHANNELS, logger } = context.core;
  const getMainWindow = context.electron?.getMainWindow || null;
  const getCustomFolders = /** @type {any} */ (context).getDelegate
    ? /** @type {any} */ (context).getDelegate('getCustomFolders')
    : context._folders?.getCustomFolders;
  const { getServiceIntegration } = context;

  // Build a "live" services object whose properties resolve at call time, not at
  // construction time. Smart folders aren't a container service (they're a
  // callback in IpcServiceContext), and the active ChatService instance is
  // owned by chat.js's module scope (it tracks LlamaService swaps).
  const buildServices = () => {
    const integration = getServiceIntegration && getServiceIntegration();
    const diContainer = integration?.container || container;
    /** @param {string} id */
    const safeResolve = (id) => {
      try {
        return diContainer.resolve(id);
      } catch {
        return null;
      }
    };

    return {
      get search() {
        return safeResolve(ServiceIds.SEARCH_SERVICE);
      },
      get analysisHistory() {
        return safeResolve(ServiceIds.ANALYSIS_HISTORY);
      },
      get smartFolders() {
        return {
          list: async () => {
            try {
              const folders = getCustomFolders ? getCustomFolders() : [];
              return Array.isArray(folders) ? folders : [];
            } catch {
              return [];
            }
          }
        };
      },
      get chat() {
        try {
          const { getOrCreateChatService } = require('./chat');
          return getOrCreateChatService ? getOrCreateChatService() : null;
        } catch {
          return null;
        }
      }
    };
  };

  const ensureLifecycle = () => {
    if (_lifecycle) return _lifecycle;
    const { McpServerLifecycleService } = require('../services/McpServerLifecycleService');
    const services = buildServices();
    // The lifecycle service tracks "enabled" internally based on enable()/
    // disable() calls; the prior design hardcoded { mcp: { enabled: false } }
    // and status() therefore always reported enabled=false even while the
    // server was running, desyncing the UI toggle.
    _lifecycle = new McpServerLifecycleService({
      services,
      logger
    });
    _lifecycle.on('status-changed', (/** @type {any} */ s) => {
      safeSendToMain(getMainWindow, IPC_CHANNELS.MCP.STATUS_CHANGED, s);
    });
    return _lifecycle;
  };

  // ---- IPC handlers (registerHandlers wires Zod validation + sender check) ---

  /** @type {Record<string, import('./ipcWrappers').HandlerConfig>} */
  const handlerMap = {
    [IPC_CHANNELS.MCP.ENABLE]: {
      schema: schemas.mcpEnable,
      handler: async () => {
        try {
          const { port, token } = await ensureLifecycle().enable();
          return _ok({ port, tokenMasked: _mask(token) });
        } catch (e) {
          return _fail(e);
        }
      }
    },
    [IPC_CHANNELS.MCP.DISABLE]: {
      schema: schemas.mcpDisable,
      handler: async () => {
        try {
          await ensureLifecycle().disable();
          return _ok();
        } catch (e) {
          return _fail(e);
        }
      }
    },
    [IPC_CHANNELS.MCP.STATUS]: {
      schema: schemas.mcpStatus,
      handler: async () => ensureLifecycle().status()
    },
    [IPC_CHANNELS.MCP.ROTATE_TOKEN]: {
      schema: schemas.mcpRotateToken,
      handler: async () => {
        try {
          const { token } = await ensureLifecycle().rotateToken();
          return _ok({ tokenMasked: _mask(token) });
        } catch (e) {
          return _fail(e);
        }
      }
    },
    [IPC_CHANNELS.MCP.GET_CONFIG_SNIPPET]: {
      schema: schemas.mcpGetConfigSnippet,
      handler: async (_e, args) => {
        try {
          const lc = ensureLifecycle();
          const { port, token } = lc.getRuntime();
          if (!port || !token) {
            return _fail(new Error('MCP server is not running. Enable it first.'));
          }
          const { generateSnippet } = require('../transports/mcp/configSnippets');
          // args.client is now Zod-validated to the enum, so generateSnippet
          // can trust the value.
          const snippet = generateSnippet(args.client, { port, token });
          return _ok({ snippet });
        } catch (e) {
          return _fail(e);
        }
      }
    },
    [IPC_CHANNELS.MCP.TEST_CONNECTION]: {
      schema: schemas.mcpTestConnection,
      handler: async () => {
        try {
          const lc = ensureLifecycle();
          const { port, token } = lc.getRuntime();
          if (!port) return _fail(new Error('MCP server is not running.'));
          const { probeMcpTools } = require('../transports/mcp/httpClient');
          const probe = await probeMcpTools({ port, token });
          const tools = probe.tools ?? lc.getToolNames?.() ?? [];
          return _ok({ tools });
        } catch (e) {
          return _fail(e);
        }
      }
    }
  };

  registerHandlers({
    ipcMain,
    logger,
    context: 'MCP',
    handlers: handlerMap
  });
  _registeredChannels = Object.keys(handlerMap);

  // Use will-quit so the async dispose actually completes before exit. The
  // previous before-quit + fire-and-forget pattern allowed the HTTP server's
  // close() to be aborted mid-flight, leaving the port in TIME_WAIT across
  // rapid restarts. The first time will-quit fires we preventDefault, run
  // disposeMcp, and re-trigger quit; the second pass (after _disposing is
  // set) lets quit proceed. Listener is removable so HMR/test cycles can
  // re-init without leaking handlers.
  _willQuitHandler = (event) => {
    if (_disposing) return;
    _disposing = true;
    event.preventDefault();
    disposeMcp()
      .then(() => app.quit())
      .catch(() => app.quit());
  };
  app.on('will-quit', _willQuitHandler);
}

async function disposeMcp() {
  try {
    const { ipcMain } = require('electron');
    for (const channel of _registeredChannels) {
      try {
        ipcMain.removeHandler(channel);
      } catch {
        /* may already be removed */
      }
    }
  } catch {
    /* defensive */
  }
  _registeredChannels = [];

  if (_willQuitHandler) {
    try {
      app.removeListener('will-quit', _willQuitHandler);
    } catch {
      /* defensive */
    }
    _willQuitHandler = null;
  }

  if (_lifecycle) {
    try {
      // Bound the disable() wait so a stuck socket.close() (HTTP keep-alive
      // peer holding the connection open, broken transport, etc.) can't hang
      // the entire app on user quit. 5 s is generous for a local-port HTTP
      // server close. If we time out, accept the orphan process risk over
      // hanging the shutdown — Electron will kill the process anyway when
      // app.quit() proceeds.
      const { withTimeout } = require('../../shared/promiseUtils');
      await withTimeout(_lifecycle.disable(), 5000, 'mcp:lifecycle.disable');
    } catch (err) {
      // Don't fully swallow: lifecycle.disable() throws on close-error to
      // signal the port may still be bound. We can't propagate during
      // shutdown (the IPC layer is already torn down), but we can record
      // the error in the logger's JSONL output so operators / future-us
      // can correlate "MCP port stayed in TIME_WAIT" with this error.
      // Includes the timeout case ("mcp:lifecycle.disable timed out after
      // 5000ms") so a hang is visible in post-mortem logs.
      try {
        const { logger } = require('../../shared/logger');
        logger?.error?.('[mcp] lifecycle.disable() failed during dispose', {
          error: err?.message,
          code: err?.code,
          timedOut: /timed out/i.test(err?.message || '')
        });
      } catch {
        /* logger unavailable in some test contexts */
      }
    }
    _lifecycle = null;
  }
  _disposing = false;
}

module.exports = registerMcpIpc;
module.exports.disposeMcp = disposeMcp;
