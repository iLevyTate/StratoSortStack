// @ts-check
'use strict';
const path = require('node:path');
const { z } = require('zod');
const { sanitizePath } = require('../../../../shared/pathSanitization');

function _isAbsoluteSafe(/** @type {any} */ p) {
  if (typeof p !== 'string' || !p) return false;
  if (p.startsWith('\\\\') || p.startsWith('//')) return false; // UNC
  if (/^[a-z][a-z0-9+\-.]*:\/\//i.test(p)) return false; // URL
  // path.isAbsolute is platform-dependent; the MCP cache may hold paths
  // captured under either ruleset, so accept both POSIX and Win32 absolutes.
  return path.posix.isAbsolute(p) || path.win32.isAbsolute(p);
}

/**
 * Validate an MCP-supplied file path with the same rules the main-process IPC
 * layer applies (traversal, ADS, null bytes, length/depth limits, reserved
 * names) on top of the transport-level UNC/URL/absolute checks.
 * @returns {string|null} Sanitized path, or null when rejected
 */
function _validateFilePath(/** @type {any} */ filePath) {
  if (!_isAbsoluteSafe(filePath)) return null;
  try {
    const sanitized = sanitizePath(filePath);
    return sanitized || null;
  } catch {
    return null;
  }
}

function registerGetDocumentSummary(/** @type {any} */ mcp, /** @type {any} */ services) {
  mcp.registerTool(
    'get_document_summary',
    {
      description:
        'Return cached LLM analysis (summary, category, entity, keywords, confidence) for a file the user has previously analyzed in StratoSort. No new inference is run.',
      inputSchema: {
        file_path: z
          .string()
          .min(1)
          .max(4096)
          .describe('Absolute path of a file previously analyzed in StratoSort')
      }
    },
    async (/** @type {any} */ args) => {
      const filePath = _validateFilePath(args?.file_path);
      if (!filePath) {
        return _err('INVALID_PATH', 'file_path must be an absolute non-UNC, non-URL path.');
      }
      try {
        const history = services.analysisHistory;
        if (!history?.getAnalysisByPath) {
          return _err('SERVICE_UNAVAILABLE', 'document summary unavailable');
        }
        const entry = await history.getAnalysisByPath(filePath);
        if (!entry) {
          // Don't echo the raw filePath back to the MCP client — it leaks
          // the user's filesystem layout to whatever client made the call
          // (Claude Desktop, Cursor, etc.). The client already has the path
          // it sent in.
          return _err(
            'FILE_NOT_ANALYZED',
            'File has not been analyzed yet. Open StratoSort and run analysis on the file first.'
          );
        }
        const a = entry.analysis || {};
        // Analysis confidence is stored on the 0-100 scale across the pipeline.
        const confidence =
          typeof a.confidence === 'number'
            ? Math.round(Math.min(100, Math.max(0, a.confidence)))
            : null;
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                // Where the file is now: organizing moves it, and the
                // history row keeps the pre-organize path as originalPath.
                file_path: entry.organization?.actual || entry.originalPath || null,
                summary: a.summary || '',
                category: a.category || null,
                entity: a.entity || null,
                type: a.documentType || null,
                date: a.documentDate || null,
                keywords: a.tags || [],
                key_entities: a.keyEntities || [],
                suggested_name: entry.organization?.newName || null,
                confidence,
                analyzed_at: entry.timestamp || null
              })
            }
          ]
        };
      } catch (err) {
        services.logger?.warn?.('[mcp.get_document_summary] service failed', {
          error: err?.message
        });
        return _err('SERVICE_UNAVAILABLE', 'document summary unavailable');
      }
    }
  );
  return 'get_document_summary';
}

function _err(/** @type {any} */ code, /** @type {any} */ message) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }]
  };
}

module.exports = { registerGetDocumentSummary };
