// @ts-check
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { z } = require('zod');

// True when `child` is the same directory as `parent` or strictly inside it.
// Plain string startsWith is wrong: '/home/user/Doc' would match
// '/home/user/Documents'. We normalize both sides and require either equal
// paths or a separator immediately after the parent.
//
// String-only check used for folder-NAME resolution (non-security-critical;
// just decides which display name to attach). The security-critical scope
// filter for search results uses `_isWithinFolderRealSync` below.
function _isWithinFolder(/** @type {any} */ child, /** @type {any} */ parent) {
  if (typeof child !== 'string' || typeof parent !== 'string') return false;
  const normalize = (/** @type {any} */ p) => path.resolve(p).replace(/\\/g, '/');
  const c = normalize(child);
  const p = normalize(parent);
  if (process.platform === 'win32') {
    // Windows paths are case-insensitive at the filesystem level.
    return (
      c === p ||
      c.toLowerCase() === p.toLowerCase() ||
      c.toLowerCase().startsWith(p.toLowerCase() + '/')
    );
  }
  return c === p || c.startsWith(p + '/');
}

// Resolve a path's realpath, returning null on failure (missing path, broken
// symlink, lacking permission). Callers fail closed on null.
function _realpathOrNull(/** @type {any} */ p) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p);
  } catch {
    return null;
  }
}

// Symlink-aware containment check. `realParent` is the caller-resolved realpath
// of the scope folder — resolved ONCE per request rather than per hit (the
// scope filter is synchronous, so the folder's realpath is invariant across the
// loop; resolving it per hit was redundant syscalls). We still deref the child
// here because `path.resolve()` does NOT follow symlinks — a symlink at
// `/library/<smart-folder>/escape` pointing at `/etc` would otherwise pass the
// string-prefix check, then fs.read would happily traverse the symlink and
// serve `/etc/passwd` to an MCP client. A child whose realpath can't be
// resolved fails closed (returns false) — better to drop a stale search result
// than to leak a path.
function _isChildWithinRealParent(/** @type {any} */ child, /** @type {any} */ realParent) {
  if (typeof child !== 'string' || typeof realParent !== 'string') return false;
  const realChild = _realpathOrNull(child);
  if (realChild === null) return false;
  return _isWithinFolder(realChild, realParent);
}

function registerSearchDocuments(/** @type {any} */ mcp, /** @type {any} */ services) {
  mcp.registerTool(
    'search_documents',
    {
      description:
        "Hybrid semantic + keyword search across the user's analyzed documents. Returns ranked file references with snippets and scores.",
      inputSchema: {
        query: z.string().min(1).max(1000).describe('Natural-language or keyword search query'),
        top_k: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe('Maximum number of results to return (default 10)'),
        mode: z
          .enum(['hybrid', 'semantic', 'keyword'])
          .optional()
          .describe('Ranking strategy: hybrid (default), semantic-only, or keyword-only'),
        smart_folder_id: z
          .string()
          .min(1)
          .max(128)
          .optional()
          .describe('Restrict results to documents in this smart folder')
      }
    },
    async (/** @type {any} */ args) => {
      const query = (args?.query || '').trim();
      if (!query) return _err('INVALID_QUERY', 'query is required and must not be empty.');
      const top_k = Math.min(args?.top_k || 10, 50);
      /** @type {Record<string, string>} */
      const modeMap = { hybrid: 'hybrid', semantic: 'vector', keyword: 'bm25' };
      const mode = modeMap[args?.mode || 'hybrid'] || 'hybrid';
      const smartFolderId = args?.smart_folder_id;
      const t0 = Date.now();
      try {
        // smart_folder_id was previously declared in the input schema but
        // never read — users restricting their query to one folder got
        // unfiltered results across the whole corpus. We now filter the
        // result set to entries whose filePath falls under the folder's path.
        const folders = (await services.smartFolders.list()) || [];
        const folderByPath = new Map();
        folders.forEach((/** @type {any} */ f) => folderByPath.set(f.path, f.name));
        const folderById = new Map();
        folders.forEach((/** @type {any} */ f) => f.id && folderById.set(f.id, f));
        const folderScope = smartFolderId ? folderById.get(smartFolderId) : null;
        if (smartFolderId && !folderScope) {
          return _err('INVALID_SMART_FOLDER', 'smart_folder_id does not match a known folder.');
        }
        // Reject criteria-only smart folders (no filesystem path) at the
        // boundary instead of letting the filter silently degrade to
        // unfiltered results. A user scoping to a virtual smart folder
        // should NOT receive documents from outside that scope just because
        // the folder is criteria-defined; that would be a privacy leak.
        if (folderScope && !folderScope.path) {
          return _err(
            'UNSUPPORTED_SMART_FOLDER',
            'smart_folder_id refers to a criteria-based folder; per-path scoping is not supported.'
          );
        }

        if (!services.search?.hybridSearch) {
          return _err('SERVICE_UNAVAILABLE', 'search service failed');
        }
        const r = await services.search.hybridSearch(query, {
          // Over-fetch when scoped so the post-filter can still return up to
          // top_k matches inside the chosen folder.
          topK: folderScope ? Math.max(top_k * 4, 50) : top_k,
          mode
        });
        const rawHits = Array.isArray(r?.results) ? r.results : [];
        const allHits = rawHits.map(_normalizeHit);
        // Path-prefix safety: '/home/user/Doc' must NOT match '/home/user/Documents'.
        // Resolve the scope folder's realpath ONCE (invariant across hits in this
        // synchronous filter), then deref each hit's realpath and apply the
        // prefix check — so a symlink pointing outside the folder cannot leak
        // files. If the folder path itself can't be resolved, fail closed.
        const realScopeParent = folderScope?.path ? _realpathOrNull(folderScope.path) : null;
        const filteredHits = folderScope?.path
          ? realScopeParent === null
            ? []
            : allHits.filter((/** @type {any} */ hit) =>
                _isChildWithinRealParent(hit.filePath, realScopeParent)
              )
          : allHits;

        const results = filteredHits.slice(0, top_k).map((/** @type {any} */ hit) => ({
          file_path: hit.filePath,
          file_name: hit.fileName,
          score: hit.score ?? null,
          snippet: hit.analysis?.summary || hit.analysis?.extractedText?.slice(0, 200) || '',
          smart_folder: _matchFolder(hit.filePath, folderByPath),
          modified_at: hit.modifiedAt || null
        }));
        // total_matches reflects the filtered population, not the post-cap
        // results length — capping at top_k in the displayed results does
        // not change how many documents matched.
        const totalMatches = folderScope ? filteredHits.length : (r.total ?? allHits.length);
        return {
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                results,
                total_matches: totalMatches,
                query_ms: Date.now() - t0
              })
            }
          ]
        };
      } catch (err) {
        // Log internally so debugging context isn't lost, but don't echo
        // err.message to the MCP client — it could include absolute paths,
        // model names, or internal service errors.
        services.logger?.warn?.('[mcp.search] search service failed', { error: err?.message });
        return _err('SERVICE_UNAVAILABLE', 'search service failed');
      }
    }
  );
  return 'search_documents';
}

/**
 * Flatten a SearchService.hybridSearch() hit into the fields this tool emits.
 *
 * SearchService returns `{ id, score, metadata: { path, name, summary,
 * extractedText, ... }, matchDetails: { bestSnippet, contextSnippet, ... } }`
 * (see SearchService `_bm25Search` / `_chunkSearch` / `enrichResults`). The
 * flat `{ filePath, fileName, analysis }` shape is accepted as well so the
 * tool keeps working for callers that pre-flatten (tests, future adapters).
 * @param {any} hit
 */
function _normalizeHit(hit) {
  const meta = hit?.metadata || {};
  const match = hit?.matchDetails || {};
  const analysis = hit?.analysis || {
    summary: meta.summary || match.bestSnippet || match.contextSnippet || undefined,
    extractedText: match.contextSnippet || meta.extractedText || undefined
  };
  return {
    filePath: hit?.filePath || meta.path,
    fileName: hit?.fileName || meta.name,
    score: hit?.score,
    analysis,
    modifiedAt: hit?.modifiedAt || meta.modifiedAt || meta.lastModified || meta.documentDate
  };
}

function _matchFolder(/** @type {any} */ filePath, /** @type {any} */ folderByPath) {
  // Use the same boundary-aware comparison as the smart_folder_id filter.
  // Plain startsWith would mislabel a file under '/home/user/Doc' with the
  // name of '/home/user/Documents'.
  for (const [folderPath, name] of folderByPath) {
    if (_isWithinFolder(filePath, folderPath)) return name;
  }
  return null;
}

function _err(/** @type {any} */ code, /** @type {any} */ message) {
  return {
    isError: true,
    content: [{ type: 'text', text: JSON.stringify({ error: { code, message } }) }]
  };
}

module.exports = { registerSearchDocuments };
