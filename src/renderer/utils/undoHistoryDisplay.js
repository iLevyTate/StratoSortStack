// @ts-check
/**
 * Display helpers for the Action history modal.
 * Keeps rows structured (badge / title / detail) and path-safe for demos.
 */

import { formatDisplayFileName, formatDisplayPath } from './pathDisplay';

/**
 * @param {any} value
 * @returns {string}
 */
function basename(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const trimmed = value.replace(/[\\/]+$/, '');
  const parts = trimmed.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || trimmed;
}

/**
 * Strip absolute-looking path tokens from freeform descriptions when redacting.
 * @param {string} text
 * @returns {string}
 */
function redactFreeformDescription(text) {
  return String(text || '')
    .replace(/[A-Za-z]:\\[^\s"'`]+/g, '…')
    .replace(/\\\\[^\s"'`]+/g, '…')
    .replace(/\/(?:Users|home)\/[^\s"'`]+/g, '…')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * @param {any} action
 * @param {{ redact?: boolean }} [options]
 * @returns {{ badge: string, title: string, detail: string, ariaLabel: string }}
 */
export function formatHistoryActionDisplay(action, options = {}) {
  const redact = Boolean(options.redact);
  const type = String(action?.type || '');
  const description = typeof action?.description === 'string' ? action.description : '';
  const metadata = action?.metadata && typeof action.metadata === 'object' ? action.metadata : {};
  const operations = Array.isArray(metadata.operations) ? metadata.operations : null;

  const singleSource =
    typeof metadata.source === 'string'
      ? metadata.source
      : typeof operations?.[0]?.source === 'string'
        ? operations[0].source
        : '';
  const singleDestination =
    typeof metadata.destination === 'string'
      ? metadata.destination
      : typeof operations?.[0]?.destination === 'string'
        ? operations[0].destination
        : '';
  const opCount =
    operations?.length > 0 ? operations.length : singleSource || singleDestination ? 1 : 0;

  if (opCount > 1) {
    const allTrash =
      Array.isArray(operations) &&
      operations.length > 0 &&
      operations.every((op) => op?.type === 'trash');
    if (allTrash || type === 'TRASH_BATCH') {
      const title = redact
        ? `${opCount} files sent to Trash`
        : description || `Sent ${opCount} files to Trash`;
      const detail = 'In the system Trash; StratoSort cannot restore these';
      return { badge: 'Trash', title, detail, ariaLabel: `${title}. ${detail}` };
    }
    const title = redact ? `${opCount} files moved` : description || `Moved ${opCount} files`;
    const detail = redact ? 'Destinations hidden' : `${opCount} reversible file moves`;
    return {
      badge: 'Batch',
      title,
      detail,
      ariaLabel: `${title}. ${detail}`
    };
  }

  if (singleSource || singleDestination) {
    const fileName = basename(singleSource) || basename(singleDestination) || 'File';
    const title = formatDisplayFileName(fileName, {
      redact,
      fallbackLabel: 'Hidden file'
    });
    const destDisplay = singleDestination
      ? formatDisplayPath(singleDestination, { redact, segments: 2 })
      : '';
    const detail = destDisplay
      ? redact
        ? `Moved · ${destDisplay}`
        : `Moved to ${destDisplay}`
      : type.includes('DELETE')
        ? 'Deleted'
        : type.includes('RENAME')
          ? 'Renamed'
          : 'File operation';
    return {
      badge: type.includes('DELETE') ? 'Delete' : type.includes('RENAME') ? 'Rename' : 'Move',
      title,
      detail,
      ariaLabel: redact ? `${detail}: ${title}` : `${detail}: ${fileName}`
    };
  }

  const title = redact
    ? redactFreeformDescription(description) || 'Action'
    : description || 'Action';
  let badge = 'Action';
  if (type.includes('SETTINGS')) badge = 'Settings';
  else if (type.includes('TRASH')) badge = 'Trash';
  else if (type.includes('BATCH')) badge = 'Batch';
  else if (type.includes('DELETE')) badge = 'Delete';
  else if (type.includes('RENAME')) badge = 'Rename';
  else if (type.includes('MOVE') || /^move\b/i.test(description)) badge = 'Move';
  else if (type.includes('FOLDER')) badge = 'Folder';
  else if (type.includes('ANALYSIS')) badge = 'Analysis';

  return {
    badge,
    title,
    detail: '',
    ariaLabel: title
  };
}
