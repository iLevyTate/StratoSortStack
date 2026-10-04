import React, { useCallback, useMemo, useState } from 'react';
import PropTypes from 'prop-types';
import { FolderPlus, RefreshCw, Sparkles } from 'lucide-react';
import { Button } from '../ui';
import { Text } from '../ui/Typography';
import Card from '../ui/Card';
import { AddSmartFolderModal } from '../setup';
import { createLogger } from '../../../shared/logger';
import { smartFoldersIpc } from '../../services/ipc';
import { mapErrorToNotification } from '../../utils/errorMapping';

const logger = createLogger('UncategorizedActionsBar');

/**
 * Threshold above which a recurring entity in uncategorized files becomes a
 * Smart Folder suggestion. Picked so the user sees the suggestion early enough
 * to be useful (after the third file) but not so eagerly that one-off entities
 * trigger noise.
 */
const PATTERN_SUGGESTION_THRESHOLD = 3;

/**
 * Heuristic: extract a normalized "entity" key from a file's analysis result
 * for grouping. Falls back through the most-specific to least-specific fields
 * so we group on whatever signal the LLM produced. Returns null when no
 * entity can be derived (file shouldn't contribute to pattern detection).
 */
function deriveEntityKey(file) {
  const analysis = file?.analysis;
  if (!analysis || typeof analysis !== 'object') return null;
  const candidate =
    analysis.vendor ||
    analysis.organization ||
    analysis.entity ||
    analysis.sender ||
    analysis.project ||
    analysis.category ||
    null;
  if (!candidate || typeof candidate !== 'string') return null;
  const trimmed = candidate.trim();
  if (!trimmed) return null;
  // Lowercase + collapse whitespace so "Acme Inc" and "acme inc " group together.
  return trimmed.toLowerCase().replace(/\s+/g, ' ');
}

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

function UncategorizedActionsBar({
  unprocessedFiles,
  findSmartFolderForCategory,
  findSmartFolderForFile,
  resolveDestination = null,
  defaultLocation,
  existingFolders,
  onFolderCreated,
  addNotification
}) {
  const [isModalOpen, setIsModalOpen] = useState(false);
  const [prefillName, setPrefillName] = useState('');
  const [isReanalyzing, setIsReanalyzing] = useState(false);

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

    // Group by derived entity to find recurring patterns.
    const counts = new Map();
    for (const file of uncategorized) {
      const key = deriveEntityKey(file);
      if (!key) continue;
      const entry = counts.get(key) || { displayName: null, files: [] };
      // Preserve the first non-lowercased label we see for display.
      if (!entry.displayName) {
        const raw =
          file?.analysis?.vendor ||
          file?.analysis?.organization ||
          file?.analysis?.entity ||
          file?.analysis?.sender ||
          file?.analysis?.project ||
          file?.analysis?.category ||
          key;
        entry.displayName = String(raw).trim();
      }
      entry.files.push(file);
      counts.set(key, entry);
    }

    // Find the top suggestion: largest group above threshold. We surface only
    // ONE suggestion at a time to avoid stacking banners — once the user
    // creates that folder (or dismisses), the next pattern will surface.
    let topGroup = null;
    for (const entry of counts.values()) {
      if (entry.files.length < PATTERN_SUGGESTION_THRESHOLD) continue;
      if (!topGroup || entry.files.length > topGroup.files.length) topGroup = entry;
    }

    return { uncategorizedFiles: uncategorized, suggestion: topGroup };
  }, [unprocessedFiles, findSmartFolderForFile, findSmartFolderForCategory, resolveDestination]);

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

  const handleReanalyzeAll = useCallback(async () => {
    if (!window?.electronAPI?.embeddings?.reanalyzeFile) {
      addNotification?.('Reanalyze is not available in this build.', 'warning');
      return;
    }
    if (uncategorizedFiles.length === 0) return;

    setIsReanalyzing(true);
    let succeeded = 0;
    let outOfScope = 0;
    let otherFailed = 0;
    try {
      // Sequential rather than parallel: the embedding queue serializes
      // anyway, and parallel calls just queue depth without finishing faster.
      // Sequential also keeps the notification count predictable.
      for (const file of uncategorizedFiles) {
        if (!file?.path) {
          otherFailed += 1;
          continue;
        }
        try {
          const result = await window.electronAPI.embeddings.reanalyzeFile(file.path);
          if (result?.success !== false) {
            succeeded += 1;
          } else if (result?.errorCode === 'NOT_IN_SMART_FOLDER') {
            outOfScope += 1;
          } else {
            otherFailed += 1;
          }
        } catch (err) {
          logger.warn('Reanalyze single file failed', {
            path: file.path,
            error: err?.message
          });
          otherFailed += 1;
        }
      }
      // Tailor the toast to what actually happened so users understand the
      // scope guard: out-of-scope rejections need a different remediation
      // (add the source folder as a Smart Folder) than transient failures.
      if (succeeded > 0 && outOfScope === 0 && otherFailed === 0) {
        addNotification?.(
          `Reanalyzed ${succeeded} ${succeeded === 1 ? 'file' : 'files'}.`,
          'success'
        );
      } else if (outOfScope > 0 && otherFailed === 0) {
        const skipNote = `${outOfScope} skipped (not inside a configured Smart Folder). Add the source folder as a Smart Folder destination to enable reanalysis.`;
        addNotification?.(
          succeeded > 0 ? `Reanalyzed ${succeeded}. ${skipNote}` : skipNote,
          'warning'
        );
      } else {
        const parts = [];
        if (succeeded > 0) parts.push(`Reanalyzed ${succeeded}`);
        if (outOfScope > 0) parts.push(`${outOfScope} not in a Smart Folder`);
        if (otherFailed > 0) parts.push(`${otherFailed} failed`);
        addNotification?.(parts.join(', ') + '.', 'warning');
      }
    } finally {
      setIsReanalyzing(false);
    }
  }, [uncategorizedFiles, addNotification]);

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
                <Sparkles className="w-3.5 h-3.5 text-stratosort-blue inline-shrink-0" />
                <span>
                  {suggestion.files.length} are from{' '}
                  <strong className="text-system-gray-800">{suggestion.displayName}</strong> — want
                  a Smart Folder for them?
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
                aria-label={`Create Smart Folder for ${suggestion.displayName}`}
              >
                <Sparkles className="w-4 h-4 mr-1.5" />
                Create folder for {suggestion.displayName}
              </Button>
            )}
            <Button
              variant={suggestion ? 'ghost' : 'secondary'}
              size="sm"
              onClick={() => openCreateModal('')}
              aria-label="Create a new Smart Folder"
            >
              <FolderPlus className="w-4 h-4 mr-1.5" />
              {suggestion ? 'Different folder…' : '+ Create Smart Folder'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={handleReanalyzeAll}
              disabled={isReanalyzing}
              aria-label={`Reanalyze ${uncategorizedFiles.length} uncategorized files`}
            >
              <RefreshCw className={`w-4 h-4 mr-1.5 ${isReanalyzing ? 'animate-spin' : ''}`} />
              {isReanalyzing ? 'Reanalyzing…' : `Reanalyze ${uncategorizedFiles.length}`}
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
  addNotification: PropTypes.func
};

export default UncategorizedActionsBar;
