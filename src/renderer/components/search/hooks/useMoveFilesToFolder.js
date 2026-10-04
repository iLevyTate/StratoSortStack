// @ts-check
import { useCallback } from 'react';
import { createLogger } from '../../../../shared/logger';
import { safeBasename } from '../../../../shared/memberPathUtils';
import { joinPath } from '../../../utils/platform';

const logger = createLogger('MoveFilesToFolder');

/**
 * Directory-pick + one batch move, shared by every surface that offers a
 * "move selection to folder" action (search list, atlas map, ...). The whole
 * selection goes to main as a single `batch_move`, which records ONE undo
 * entry; one `move` per file gave a 60-file move 60 undo steps and pushed
 * the previous organize out of history (audit row UR-04).
 *
 * @returns {(filePaths: string[], callbacks?: { onProgress?: (message: string) => void }) =>
 *   Promise<{ moved: number, failed: number, destFolder: string | null }>}
 *   Resolves with counts; `destFolder` is null when the user cancelled the
 *   directory picker (no work attempted).
 */
export function useMoveFilesToFolder() {
  return useCallback(async (filePaths, { onProgress } = {}) => {
    const paths = Array.isArray(filePaths) ? filePaths.filter(Boolean) : [];
    if (paths.length === 0) return { moved: 0, failed: 0, destFolder: null };

    const api = /** @type {any} */ (window).electronAPI?.files;
    const dirResult = await api?.selectDirectory?.({ purpose: 'destination' });
    if (!dirResult?.success || !dirResult?.path) {
      return { moved: 0, failed: 0, destFolder: null };
    }

    const destFolder = dirResult.path;
    if (paths.length > 3) {
      onProgress?.(`Moving ${paths.length} files...`);
    }

    let response;
    try {
      response = await api?.performOperation?.({
        type: 'batch_move',
        label: 'Move files',
        operations: paths.map((sourcePath) => ({
          source: sourcePath,
          destination: joinPath(destFolder, safeBasename(sourcePath))
        }))
      });
    } catch (error) {
      logger.error('Batch move failed', { error: error?.message || String(error) });
      return { moved: 0, failed: paths.length, destFolder };
    }

    // Require an explicit result: a missing bridge method makes the
    // optional-chained call fulfill with `undefined`, which must count as
    // failed, not as "Moved N file(s)" with nothing moved.
    /** @type {Array<{ success?: boolean, skipped?: boolean, error?: string }>} */
    const rows = Array.isArray(response?.results) ? response.results : [];
    const moved = rows.filter((r) => r?.success === true && !r?.skipped).length;
    const skipped = rows.filter((r) => r?.success === true && r?.skipped).length;
    const failed = rows.length > 0 ? rows.filter((r) => r?.success !== true).length : paths.length;
    if (failed > 0) {
      logger.error('Some files were not moved', {
        failed,
        errors: rows.filter((r) => r?.success !== true).map((r) => r?.error ?? 'unknown'),
        bridgeMissing: !response
      });
    }

    return { moved: moved + skipped, failed, destFolder };
  }, []);
}
