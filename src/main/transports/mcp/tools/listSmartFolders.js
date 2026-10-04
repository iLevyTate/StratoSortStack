// @ts-check
'use strict';

const fs = require('fs').promises;

/**
 * What a folder holds right now. Folder records carry no counts, so this
 * reads the directory: `file_count` is the number of files directly inside
 * it and `last_organized_at` is when its entries last changed (a move into
 * or out of it updates the directory mtime). Both are null when the folder
 * cannot be read.
 * @param {string} folderPath
 * @returns {Promise<{ file_count: number | null, last_organized_at: string | null }>}
 */
async function describeFolderContents(folderPath) {
  if (typeof folderPath !== 'string' || !folderPath) {
    return { file_count: null, last_organized_at: null };
  }
  try {
    const [entries, stats] = await Promise.all([
      fs.readdir(folderPath, { withFileTypes: true }),
      fs.stat(folderPath)
    ]);
    return {
      file_count: entries.filter((entry) => entry.isFile()).length,
      last_organized_at: stats.mtime instanceof Date ? stats.mtime.toISOString() : null
    };
  } catch {
    return { file_count: null, last_organized_at: null };
  }
}

function registerListSmartFolders(/** @type {any} */ mcp, /** @type {any} */ services) {
  mcp.registerTool(
    'list_smart_folders',
    {
      description: "List the user's configured StratoSort smart folders. No parameters.",
      inputSchema: {}
    },
    async () => {
      try {
        const folders = await services.smartFolders.list();
        const mapped = await Promise.all(
          (folders || []).map(async (/** @type {any} */ f) => ({
            id: f.id,
            name: f.name,
            description: f.description || '',
            destination_path: f.path,
            ...(await describeFolderContents(f.path))
          }))
        );
        return { content: [{ type: 'text', text: JSON.stringify({ folders: mapped }) }] };
      } catch (err) {
        // Log so an operator can correlate "list_smart_folders returned
        // unavailable" with the underlying service failure.
        services.logger?.warn?.('[mcp.list_smart_folders] service failed', {
          error: err?.message
        });
        return {
          isError: true,
          content: [
            {
              type: 'text',
              text: JSON.stringify({
                error: { code: 'SERVICE_UNAVAILABLE', message: 'smart folders unavailable' }
              })
            }
          ]
        };
      }
    }
  );
  return 'list_smart_folders';
}

module.exports = { registerListSmartFolders };
