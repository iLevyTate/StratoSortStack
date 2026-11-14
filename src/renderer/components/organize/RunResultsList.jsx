import React, { memo, useCallback, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { List } from 'react-window';
import {
  AlertCircle,
  AlertTriangle,
  Check,
  Clock,
  Copy,
  Download,
  FolderOpen,
  Undo2
} from 'lucide-react';
import { Button } from '../ui';
import { Text } from '../ui/Typography';
import { UI_VIRTUALIZATION } from '../../../shared/constants';
import { useNotification } from '../../contexts/NotificationContext';
import { filesIpc } from '../../services/ipc';
import { formatDisplayFileName } from '../../utils/pathDisplay';
import {
  countRunOutcomes,
  destinationTotals,
  parentFolder,
  revealPathFor
} from '../../utils/organizeRunResults';

const ROW_HEIGHT = 76;
const VIRTUALIZATION_THRESHOLD = UI_VIRTUALIZATION.THRESHOLD;
const HIDDEN_DESTINATION = 'Destination hidden';

const OUTCOME_ICON = {
  moved: { Icon: Check, className: 'text-stratosort-success' },
  duplicate: { Icon: Copy, className: 'text-system-gray-500' },
  failed: { Icon: AlertCircle, className: 'text-stratosort-danger' },
  notMoved: { Icon: Clock, className: 'text-stratosort-warning' },
  restored: { Icon: Undo2, className: 'text-system-gray-500' },
  leftAtDestination: { Icon: AlertTriangle, className: 'text-stratosort-warning' }
};

/** Which rows each filter shows. */
const FILTERS = {
  all: () => true,
  moved: (row) => row.outcome === 'moved' || row.outcome === 'leftAtDestination',
  duplicate: (row) => row.outcome === 'duplicate',
  notMoved: (row) =>
    row.outcome === 'failed' || row.outcome === 'notMoved' || row.outcome === 'restored'
};

/** Last segment of a path ("C:\Docs\GSC" -> "GSC"). */
function baseName(p) {
  if (typeof p !== 'string' || !p) return '';
  const trimmed = p.replace(/[\\/]+$/, '');
  return trimmed.slice(Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\')) + 1);
}

const plural = (count, one, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * The two lines under a file's name: where it is now (or why it did not
 * move), then where it came from (or where it still is).
 */
function describeRow(row, redactPaths) {
  const final = redactPaths ? HIDDEN_DESTINATION : row.finalPath || '';
  const fromFolder = redactPaths ? '' : parentFolder(row.originalPath);
  const stillAt = redactPaths ? 'Still in its original folder' : `Still at ${row.originalPath}`;
  switch (row.outcome) {
    case 'moved':
      return {
        status: `Now at ${final}${
          row.renamedOnCollision ? ' (renamed: a file with this name was already there)' : ''
        }`,
        origin: fromFolder ? `From ${fromFolder}` : ''
      };
    case 'duplicate':
      return {
        status: `Not moved: an identical copy is already ${
          redactPaths ? 'in the destination' : `at ${final}`
        }. ${row.reason || ''}`.trim(),
        origin: fromFolder ? `From ${fromFolder}` : ''
      };
    case 'leftAtDestination':
      return { status: row.reason, origin: redactPaths ? HIDDEN_DESTINATION : `Now at ${final}` };
    case 'restored':
      return { status: row.reason, origin: stillAt };
    default:
      return { status: `Not moved: ${row.reason || 'Unknown reason.'}`, origin: stillAt };
  }
}

const ResultRow = memo(function ResultRow({ row, redactPaths, onReveal, style, ariaAttributes }) {
  const { Icon, className: iconClass } = OUTCOME_ICON[row.outcome] || OUTCOME_ICON.notMoved;
  const name = formatDisplayFileName(row.name || baseName(row.originalPath) || 'File', {
    redact: redactPaths
  });
  const { status, origin } = describeRow(row, redactPaths);
  const revealPath = revealPathFor(row);
  const duplicate = row.outcome === 'duplicate';

  return (
    <div
      style={style}
      role="listitem"
      {...ariaAttributes}
      className="flex items-center gap-cozy px-4 py-2 border-b border-border-soft/30 last:border-0"
    >
      <Icon className={`h-4 w-4 flex-shrink-0 ${iconClass}`} aria-hidden="true" />
      <div className="min-w-0 flex-1">
        <Text variant="small" className="truncate text-system-gray-800" title={name}>
          {name}
        </Text>
        <Text variant="tiny" className="truncate text-system-gray-600" title={status}>
          {status}
        </Text>
        {origin && (
          <Text variant="tiny" className="truncate text-system-gray-500" title={origin}>
            {origin}
          </Text>
        )}
      </div>
      {revealPath && onReveal && (
        <Button
          onClick={() => onReveal(revealPath)}
          variant="ghost"
          size="sm"
          className="flex-shrink-0"
          title={duplicate ? 'Show the kept copy in its folder' : 'Show in folder'}
          aria-label={
            duplicate ? `Show the kept copy of ${name} in its folder` : `Show ${name} in its folder`
          }
        >
          <FolderOpen className="h-4 w-4" aria-hidden="true" />
        </Button>
      )}
    </div>
  );
});

ResultRow.propTypes = {
  row: PropTypes.object.isRequired,
  redactPaths: PropTypes.bool,
  onReveal: PropTypes.func,
  style: PropTypes.object,
  ariaAttributes: PropTypes.object
};

/** react-window row: picks its file out of the shared row props. */
function VirtualRow({ index, style, ariaAttributes, rows, redactPaths, onReveal }) {
  const row = rows[index];
  if (!row) return <div style={style} {...ariaAttributes} />;
  return (
    <ResultRow
      row={row}
      redactPaths={redactPaths}
      onReveal={onReveal}
      style={style}
      ariaAttributes={ariaAttributes}
    />
  );
}

VirtualRow.propTypes = {
  index: PropTypes.number.isRequired,
  style: PropTypes.object,
  ariaAttributes: PropTypes.object,
  rows: PropTypes.array.isRequired,
  redactPaths: PropTypes.bool,
  onReveal: PropTypes.func
};

const rowKey = (row, index) => `${row.originalPath || row.name || 'file'}|${index}`;

/**
 * The "Save list as CSV" action for `rows`: main asks where to save, then
 * one message says where the list went or why it could not be saved. A
 * cancelled dialog says nothing.
 * @param {any[]} rows
 * @returns {() => Promise<void>}
 */
export function useRunResultsExport(rows) {
  const { showSuccess, showError } = useNotification();
  return useCallback(async () => {
    const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
    if (list.length === 0) return;
    try {
      const result = await filesIpc.exportOrganizeReport(list);
      if (result?.success) {
        const count = Number.isInteger(result.rowCount) ? result.rowCount : list.length;
        showSuccess(
          `Saved the list of ${plural(count, 'file')} to ${baseName(result.filePath) || 'the file you chose'}.`
        );
        return;
      }
      if (result?.canceled) return;
      showError(`Could not save the list: ${result?.error || 'the file could not be written.'}`);
    } catch (error) {
      showError(`Could not save the list: ${error?.message || String(error)}`);
    }
  }, [rows, showSuccess, showError]);
}

/**
 * Every file of an organize run, accounted for: a line of totals, the folders
 * files went to with a count and an Open button each, filters, and one row
 * per file saying where it is now or why it did not move, with a button that
 * shows it in its folder. Lists longer than UI_VIRTUALIZATION.THRESHOLD are
 * virtualized. Rows come from utils/organizeRunResults.
 */
function RunResultsList({ rows, onReveal, onOpenFolder, onExport, redactPaths = false }) {
  const safeRows = useMemo(() => (Array.isArray(rows) ? rows.filter(Boolean) : []), [rows]);
  const counts = useMemo(() => countRunOutcomes(safeRows), [safeRows]);
  const folders = useMemo(() => destinationTotals(safeRows), [safeRows]);
  const [filter, setFilter] = useState('all');

  const filterOptions = [
    { id: 'all', label: `All (${safeRows.length})` },
    { id: 'moved', label: `Moved (${counts.moved})` },
    ...(counts.duplicates > 0
      ? [{ id: 'duplicate', label: `Duplicates removed (${counts.duplicates})` }]
      : []),
    ...(counts.notMoved > 0 ? [{ id: 'notMoved', label: `Not moved (${counts.notMoved})` }] : [])
  ];
  // A filter whose button went away (the rows changed) falls back to All.
  const activeFilter = filterOptions.some((option) => option.id === filter) ? filter : 'all';
  const visibleRows = useMemo(
    () => safeRows.filter(FILTERS[activeFilter] || FILTERS.all),
    [safeRows, activeFilter]
  );

  const headline = [
    counts.moved > 0 ? `${counts.moved} moved` : '',
    counts.duplicates > 0 ? `${plural(counts.duplicates, 'duplicate')} removed` : '',
    counts.notMoved > 0 ? `${counts.notMoved} not moved` : ''
  ]
    .filter(Boolean)
    .join(' · ');

  const rowProps = useMemo(
    () => ({ rows: visibleRows, redactPaths, onReveal }),
    [visibleRows, redactPaths, onReveal]
  );
  const listHeight = useMemo(() => {
    const viewport = typeof window !== 'undefined' ? window.innerHeight : 900;
    return Math.max(ROW_HEIGHT * 3, Math.min(visibleRows.length * ROW_HEIGHT, viewport * 0.5));
  }, [visibleRows.length]);

  return (
    <div className="flex flex-col gap-default" data-testid="run-results-list">
      <div className="flex flex-wrap items-center justify-between gap-cozy px-4 pt-3">
        <Text variant="small" className="font-medium text-system-gray-800">
          {headline || 'No files in this run'}
        </Text>
        {onExport && safeRows.length > 0 && (
          <Button onClick={onExport} variant="secondary" size="sm">
            <Download className="h-4 w-4" aria-hidden="true" />
            Save list as CSV
          </Button>
        )}
      </div>

      {folders.length > 0 && (
        <section aria-label="Where files went" className="px-4">
          <Text as="h3" variant="tiny" className="mb-1 font-semibold text-system-gray-700">
            Where files went
          </Text>
          <ul className="flex flex-col gap-1">
            {folders.map((entry, index) => {
              const folderName = redactPaths ? '' : baseName(entry.folder);
              const tally = [
                entry.moved > 0 ? plural(entry.moved, 'file') : '',
                entry.duplicates > 0 ? `${plural(entry.duplicates, 'duplicate')} removed` : ''
              ]
                .filter(Boolean)
                .join(', ');
              return (
                <li
                  key={`${entry.folder}|${index}`}
                  className="flex items-center gap-cozy rounded-lg bg-system-gray-100/60 px-3 py-1.5"
                >
                  <FolderOpen
                    className="h-4 w-4 flex-shrink-0 text-stratosort-blue"
                    aria-hidden="true"
                  />
                  <Text
                    as="span"
                    variant="tiny"
                    className="min-w-0 flex-1 truncate text-system-gray-800"
                    title={redactPaths ? undefined : entry.folder}
                  >
                    {redactPaths ? HIDDEN_DESTINATION : entry.folder}
                  </Text>
                  <Text as="span" variant="tiny" className="flex-shrink-0 text-system-gray-600">
                    {tally}
                  </Text>
                  {onOpenFolder && (
                    <Button
                      onClick={() => onOpenFolder(entry.folder)}
                      variant="ghost"
                      size="sm"
                      className="flex-shrink-0"
                      title="Open this folder"
                      aria-label={folderName ? `Open ${folderName}` : `Open folder ${index + 1}`}
                    >
                      <FolderOpen className="h-4 w-4" aria-hidden="true" />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {filterOptions.length > 2 && (
        <div role="group" aria-label="Show files" className="flex flex-wrap gap-compact px-4">
          {filterOptions.map((option) => (
            <Button
              key={option.id}
              onClick={() => setFilter(option.id)}
              variant={activeFilter === option.id ? 'secondary' : 'ghost'}
              size="sm"
              aria-pressed={activeFilter === option.id}
            >
              {option.label}
            </Button>
          ))}
        </div>
      )}

      {visibleRows.length > VIRTUALIZATION_THRESHOLD ? (
        <List
          rowCount={visibleRows.length}
          rowHeight={ROW_HEIGHT}
          rowComponent={VirtualRow}
          rowProps={rowProps}
          overscanCount={UI_VIRTUALIZATION.OVERSCAN_COUNT}
          style={{ height: listHeight, width: '100%' }}
          aria-label="Files in this run"
          className="modern-scrollbar"
        />
      ) : (
        <div role="list" aria-label="Files in this run">
          {visibleRows.map((row, index) => (
            <ResultRow
              key={rowKey(row, index)}
              row={row}
              redactPaths={redactPaths}
              onReveal={onReveal}
            />
          ))}
        </div>
      )}
    </div>
  );
}

RunResultsList.propTypes = {
  rows: PropTypes.arrayOf(
    PropTypes.shape({
      name: PropTypes.string,
      originalPath: PropTypes.string,
      finalPath: PropTypes.string,
      outcome: PropTypes.oneOf([
        'moved',
        'duplicate',
        'failed',
        'notMoved',
        'restored',
        'leftAtDestination'
      ]).isRequired,
      reason: PropTypes.string,
      renamedOnCollision: PropTypes.bool
    })
  ).isRequired,
  onReveal: PropTypes.func,
  onOpenFolder: PropTypes.func,
  onExport: PropTypes.func,
  redactPaths: PropTypes.bool
};

export default memo(RunResultsList);
