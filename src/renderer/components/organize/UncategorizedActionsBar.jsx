import React, { useCallback, useEffect, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { FolderPlus, RefreshCw, Lightbulb } from 'lucide-react';
import { Button } from '../ui';
import { Text } from '../ui/Typography';
import Card from '../ui/Card';
import { AddSmartFolderModal } from '../setup';
import { createLogger } from '../../../shared/logger';
import { smartFoldersIpc } from '../../services/ipc';
import { mapErrorToNotification } from '../../utils/errorMapping';
import { findRecurringTheme } from './uncategorizedThemes';

const logger = createLogger('UncategorizedActionsBar');

/**
 * Determine whether a file is currently routed to the Uncategorized bucket —
 * either because no Smart Folder matched any of its analysis fields, or
 * because it matched a folder literally named "Uncategorized".
 *
 * Uses the per-file matcher so a file whose `category` doesn't match any
 * folder but whose `vendor` / `organization` / etc. does, still resolves —
 * which is what the user expects after creating a folder named after the
 * suggestion banner's entity.
 */
function isUncategorized(file, findFolderForFile) {
  const folder = findFolderForFile(file);
  if (!folder) return true;
  return String(folder?.name || '').toLowerCase() === 'uncategorized';
}

/** Same file, whichever slash or letter case the path was recorded with. */
const pathKey = (file) =>
  String(file?.path || '')
    .replace(/\\/g, '/')
    .toLowerCase();

/**
 * Files analyzed in earlier runs that are still uncategorized, shaped like
 * this screen's files. Themes are counted across these too: three invoices
 * from one vendor rarely arrive in the same batch.
 */
function useEarlierUncategorizedFiles() {
  const [files, setFiles] = useState([]);
  useEffect(() => {
    let cancelled = false;
    const load = window.electronAPI?.analysisHistory?.getUncategorized;
    if (typeof load !== 'function') return undefined;
    Promise.resolve(load({ limit: 500 }))
      .then((result) => {
        if (cancelled || !Array.isArray(result?.items)) return undefined;
        setFiles(
          result.items.map((item) => ({
            ...item,
            // History keeps keywords under `tags`.
            analysis: { ...item.analysis, keywords: item.analysis?.tags }
          }))
        );
        return undefined;
      })
      .catch((error) => {
        logger.debug('Could not load earlier uncategorized files', { error: error?.message });
      });
    return () => {
      cancelled = true;
    };
  }, []);
  return files;
}

function UncategorizedActionsBar({
  unprocessedFiles,
  findSmartFolderForCategory,
  findSmartFolderForFile,
  resolveDestination = null,
  defaultLocation,
  existingFolders,
  onFolderCreated,
  onReanalyze,
  isAnalyzing = false,
  addNotification
}) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [prefillName, setPrefillName] = useState('');
  const earlierFiles = useEarlierUncategorizedFiles();

  // Derive uncategorized files + pattern suggestions in one pass.
  const { uncategorizedFiles, suggestion } = useMemo(() => {
    // Prefer the grid's own resolution (user choice, engine ranking, then
    // name matching) so this bar never counts a file the card shows placed.
    const matcher =
      typeof resolveDestination === 'function'
        ? (file) => resolveDestination(file)?.folder || null
        : findSmartFolderForFile ||
          ((file) => findSmartFolderForCategory(file?.analysis?.category));
    const uncategorized = (unprocessedFiles || []).filter((f) => isUncategorized(f, matcher));

    // One suggestion at a time, the largest recurring theme: once the user
    // creates that folder, its files leave this list and the next theme shows.
    // Earlier files count toward a theme too, until a folder matches them.
    const inThisRun = new Set((unprocessedFiles || []).map(pathKey));
    const earlier = earlierFiles.filter(
      (f) => !inThisRun.has(pathKey(f)) && isUncategorized(f, matcher)
    );
    const combined = findRecurringTheme([...uncategorized, ...earlier]);
    const earlierCount = combined ? combined.files.filter((f) => earlier.includes(f)).length : 0;
    // A theme made only of earlier files says nothing about the files on
    // screen, so fall back to what this run shows on its own.
    const theme =
      combined && earlierCount < combined.files.length
        ? { ...combined, earlierCount }
        : findRecurringTheme(uncategorized);
    return { uncategorizedFiles: uncategorized, suggestion: theme };
  }, [
    unprocessedFiles,
    earlierFiles,
    findSmartFolderForFile,
    findSmartFolderForCategory,
    resolveDestination
  ]);

  const openCreateModal = useCallback((seedName = '') => {
    setPrefillName(seedName);
    setIsModalOpen(true);
  }, []);

  const handleAddFolder = useCallback(
    async (newFolder) => {
      try {
        const result = await smartFoldersIpc.add(newFolder);
        if (!result?.success) {
          addNotification?.(`Failed to create folder: ${result?.error || 'unknown'}`, 'error');
          return false;
        }
        addNotification?.(`Created Smart Folder: ${newFolder.name}`, 'success');
        // Fire-and-forget parent reload. A failed reload must NOT invalidate
        // the already-successful add — otherwise the modal stays open with a
        // misleading error toast.
        if (typeof onFolderCreated === 'function') {
          Promise.resolve()
            .then(() => onFolderCreated())
            .catch((reloadError) => {
              logger.error('Smart folder list reload failed after add', {
                error: reloadError?.message,
                stack: reloadError?.stack
              });
              addNotification?.(
                'Folder added, but the file list did not refresh. Refresh manually if it does not update.',
                'warning'
              );
            });
        }
        return true;
      } catch (err) {
        logger.error('Failed to create smart folder from organize bar', {
          error: err?.message,
          stack: err?.stack
        });
        const { message, severity } = mapErrorToNotification({
          error: err?.message,
          operationType: 'Smart folder creation'
        });
        addNotification?.(message, severity);
        return false;
      }
    },
    [addNotification, onFolderCreated]
  );

  // The analysis run does the work and reports the outcome. The button is
  // disabled while any analysis runs: the run refuses a reanalysis then.
  const handleReanalyzeAll = useCallback(() => {
    if (typeof onReanalyze !== 'function') {
      addNotification?.('Reanalyze is not available in this build.', 'warning');
      return;
    }
    const paths = uncategorizedFiles.map((file) => file?.path).filter(Boolean);
    if (paths.length > 0) onReanalyze(paths);
  }, [uncategorizedFiles, onReanalyze, addNotification]);

  if (uncategorizedFiles.length === 0) return null;

  return (
    <>
      <Card
        variant="static"
        className="mb-3 border border-stratosort-warning/30 bg-stratosort-warning/8 p-3"
      >
        <div className="flex flex-wrap items-center gap-cozy">
          <div className="flex-1 min-w-[12rem]">
            <Text variant="small" className="font-medium text-system-gray-800">
              {uncategorizedFiles.length}{' '}
              {uncategorizedFiles.length === 1 ? 'file is' : 'files are'} uncategorized
            </Text>
            {suggestion ? (
              <Text variant="tiny" className="text-system-gray-600 mt-1 flex items-center gap-1">
                <Lightbulb className="w-3.5 h-3.5 text-stratosort-blue inline-shrink-0" />
                <span>
                  {suggestion.files.length}{' '}
                  {suggestion.source === 'entity' ? 'are from' : 'share the theme'}{' '}
                  <strong className="text-system-gray-800">{suggestion.displayName}</strong>
                  {suggestion.earlierCount > 0
                    ? ` (${suggestion.earlierCount} analyzed earlier)`
                    : ''}{' '}
                  — want a Smart Folder for them?
                </span>
              </Text>
            ) : (
              <Text variant="tiny" className="text-system-gray-600 mt-1">
                No matching Smart Folder yet. Create one inline, or reanalyze if the categories look
                wrong.
              </Text>
            )}
          </div>

          <div className="flex flex-wrap items-center gap-compact">
            {suggestion && (
              <Button
                variant="primary"
                size="sm"
                onClick={() => openCreateModal(suggestion.displayName)}
              >
                <FolderPlus className="w-4 h-4 mr-1.5" />
                Create folder for {suggestion.displayName}
              </Button>
            )}
            <Button
              variant={suggestion ? 'ghost' : 'secondary'}
              size="sm"
              onClick={() => openCreateModal('')}
              // The accessible name must contain the visible text (WCAG 2.5.3).
              aria-label={suggestion ? 'Different folder… create a new Smart Folder' : undefined}
            >
              <FolderPlus className="w-4 h-4 mr-1.5" />
              {suggestion ? 'Different folder…' : '+ Create Smart Folder'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReanalyzeAll}
              disabled={isAnalyzing}
              aria-label={`Reanalyze ${uncategorizedFiles.length} uncategorized files`}
            >
              <RefreshCw className="w-4 h-4 mr-1.5" />
              Reanalyze {uncategorizedFiles.length}
            </Button>
          </div>
        </div>
      </Card>

      <AddSmartFolderModal
        isOpen={isModalOpen}
        onClose={() => {
          setIsModalOpen(false);
          setPrefillName('');
        }}
        onAdd={handleAddFolder}
        defaultLocation={defaultLocation}
        existingFolders={existingFolders}
        showNotification={addNotification}
        initialName={prefillName}
      />
    </>
  );
}

UncategorizedActionsBar.propTypes = {
  unprocessedFiles: PropTypes.array.isRequired,
  findSmartFolderForCategory: PropTypes.func.isRequired,
  findSmartFolderForFile: PropTypes.func,
  resolveDestination: PropTypes.func,
  defaultLocation: PropTypes.string,
  existingFolders: PropTypes.array,
  onFolderCreated: PropTypes.func,
  // Analyzes the given paths again (the analysis run's reanalyzeFiles).
  onReanalyze: PropTypes.func,
  isAnalyzing: PropTypes.bool,
  addNotification: PropTypes.func
};

export default UncategorizedActionsBar;
