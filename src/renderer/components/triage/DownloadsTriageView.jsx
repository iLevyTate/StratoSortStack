import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PropTypes from 'prop-types';
import {
  Trash2,
  FolderOpen,
  EyeOff,
  Play,
  Sparkles,
  AlertTriangle,
  Filter,
  Download
} from 'lucide-react';
import Modal, { ConfirmModal } from '../ui/Modal';
import Button from '../ui/Button';
import FileIcon from '../ui/FileIcon';
import { Heading, Text } from '../ui/Typography';
import { useFileActions } from '../../hooks/useFileActions';
import { formatBytes } from '../../utils/format';
import { formatDisplayFileName, formatDisplayPath } from '../../utils/pathDisplay';
import { normalizeConfidence } from '../../utils/scoreUtils';
import { toErrorMessage } from '../../utils/errorMapping';
import { useSelector } from 'react-redux';
import { selectRedactPaths } from '../../store/selectors';
import { createLogger } from '../../../shared/logger';
import { triagePathKey } from '../../utils/triagePathKey';

const logger = createLogger('DownloadsTriageView');

// Friendlier labels for the technical scan-cap reason codes surfaced in the
// partial-scan banner. Falls back to a spaced, lowercased version of the code.
const SCAN_REASON_LABELS = {
  maxDepth: 'depth limit',
  maxFiles: 'file limit',
  maxBytes: 'size limit',
  timeout: 'time limit',
  symlink: 'symlinks'
};
const formatScanReason = (reason) =>
  SCAN_REASON_LABELS[reason] ||
  String(reason || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .toLowerCase();

const TAB_DEFS = [
  {
    key: 'trash',
    label: 'Trash candidates',
    copy: 'Exact duplicates of organized files. Sending these to Trash reclaims space safely.'
  },
  {
    key: 'keep',
    label: 'Keep',
    copy: 'High-confidence matches to your Smart Folders — ready to organize.'
  },
  {
    key: 'excluded',
    label: 'Excluded',
    copy: 'Skipped by exclusion rules (installers, partial downloads, already-organized files, too-recent).'
  },
  {
    key: 'ambiguous',
    label: 'Ambiguous',
    copy: 'No confident match on metadata alone. Click "Deep scan" to run the embedding pass on this subset.'
  },
  {
    key: 'review',
    label: 'Review',
    copy: 'Deep scan found a possible match but below the confidence threshold. Review before acting.'
  },
  {
    key: 'unmatched',
    label: 'Unmatched',
    copy: "Deep scan couldn't find a folder match. These are likely orphans — decide manually."
  }
];

function Row({ record, onSelect, selected, openFile, revealFile, redactPaths }) {
  const path = record.filePath;
  const name =
    record.fileName ||
    (typeof path === 'string' ? path.split(/[\\/]/).pop() : '') ||
    record.filePath;
  const displayName = formatDisplayFileName(name, { redact: redactPaths });
  const displayPath = formatDisplayPath(path || '', { redact: redactPaths, segments: 2 });
  const sizeLabel = Number.isFinite(record.size) ? formatBytes(record.size) : null;
  const confidencePercent = normalizeConfidence(record.confidence);

  return (
    <li
      className={`group flex items-start gap-cozy px-3 py-2 border-b border-system-gray-100 hover:bg-system-gray-50 ${
        selected ? 'bg-stratosort-blue/5' : ''
      }`}
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={(e) => onSelect(record.filePath, e.target.checked)}
        aria-label={`Select ${name}`}
        className="mt-1 accent-stratosort-blue"
      />
      <FileIcon filename={name} className="w-7 h-7 shrink-0 mt-0.5" />
      <div className="flex-1 min-w-0">
        <Text as="div" variant="small" className="font-medium truncate">
          {displayName}
        </Text>
        {displayPath && (
          <Text
            as="div"
            variant="tiny"
            className="text-system-gray-500 truncate font-mono"
            title={redactPaths ? undefined : path}
          >
            {displayPath}
            {sizeLabel ? ` · ${sizeLabel}` : ''}
          </Text>
        )}
        <Text variant="tiny" className="text-system-gray-600 mt-0.5 truncate">
          {record.why}
          {confidencePercent > 0 && ` · ${confidencePercent}%`}
        </Text>
      </div>
      <div className="flex gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity shrink-0">
        <Button
          size="xs"
          variant="ghost"
          onClick={() => openFile(path)}
          disabled={!path}
          title="Open file"
        >
          Open
        </Button>
        <Button
          size="xs"
          variant="ghost"
          onClick={() => revealFile(path)}
          disabled={!path}
          title="Reveal in folder"
        >
          Reveal
        </Button>
      </div>
    </li>
  );
}

Row.propTypes = {
  record: PropTypes.object.isRequired,
  onSelect: PropTypes.func.isRequired,
  selected: PropTypes.bool,
  openFile: PropTypes.func.isRequired,
  revealFile: PropTypes.func.isRequired,
  redactPaths: PropTypes.bool.isRequired
};

/**
 * DownloadsTriageView
 *
 * One-shot sweep of a chosen folder (defaults to OS Downloads). Shows the
 * Tier 0 classification buckets as tabs, lets the user trigger a Tier 1
 * deep scan on the Ambiguous bucket, and performs batched trash / organize /
 * ignore actions — all routed through downloads.triage.* IPC.
 */
export default function DownloadsTriageView({ isOpen, onClose }) {
  const [triageId, setTriageId] = useState(null);
  const [folderPath, setFolderPath] = useState('');
  const [buckets, setBuckets] = useState({
    keep: [],
    trash: [],
    excluded: [],
    ambiguous: [],
    review: [],
    unmatched: []
  });
  const [activeTab, setActiveTab] = useState('trash');
  const [selected, setSelected] = useState(new Set());
  const [error, setError] = useState(null);
  const [isScanning, setIsScanning] = useState(false);
  const [isDeepScanning, setIsDeepScanning] = useState(false);
  const [isActing, setIsActing] = useState(false);
  const [scanProgress, setScanProgress] = useState(null);
  // When set, the trash confirmation dialog opens. Shape: { count, bytes, run }.
  const [pendingTrash, setPendingTrash] = useState(null);
  /** Auto-select all trash rows once per triage session (not on every deselect). */
  const hasAutoSelectedTrashRef = useRef(null);
  const triageIdRef = useRef(null);
  useEffect(() => {
    triageIdRef.current = triageId;
  }, [triageId]);

  useEffect(() => {
    const sub = window?.electronAPI?.downloads?.triage?.onSessionInvalidated;
    if (typeof sub !== 'function') return undefined;
    return sub((detail) => {
      const evictedIds = Array.isArray(detail?.evictedIds) ? detail.evictedIds : [];
      const id = triageIdRef.current;
      if (!id || !evictedIds.includes(id)) return;
      setTriageId(null);
      setFolderPath('');
      setBuckets({
        keep: [],
        trash: [],
        excluded: [],
        ambiguous: [],
        review: [],
        unmatched: []
      });
      setSelected(new Set());
      setActiveTab('trash');
      setIsDeepScanning(false);
      hasAutoSelectedTrashRef.current = null;
      setError('Triage session expired — rescan the folder.');
    });
  }, []);

  const { openFile, revealFile } = useFileActions();
  const redactPaths = useSelector(selectRedactPaths);
  const downloadsTriageExclusions = useSelector(
    (state) => state?.ui?.settings?.downloadsTriageExclusions
  );
  const [scanWarning, setScanWarning] = useState(null);
  const [exportStatus, setExportStatus] = useState('');

  const runStart = useCallback(
    async (chosenFolder) => {
      hasAutoSelectedTrashRef.current = null;
      setScanProgress(null);
      setScanWarning(null);
      setIsScanning(true);
      setError(null);
      setExportStatus('');
      setSelected(new Set());
      try {
        const api = window?.electronAPI?.downloads?.triage?.start;
        if (typeof api !== 'function') throw new Error('Downloads triage API unavailable');
        const payload = chosenFolder ? { folderPath: chosenFolder } : {};
        if (Array.isArray(downloadsTriageExclusions) && downloadsTriageExclusions.length > 0) {
          payload.exclusionGlobs = downloadsTriageExclusions;
        }
        const result = await api(payload);
        if (result?.canceled || result?.cancelled) {
          setError('Scan was cancelled.');
          return;
        }
        if (!result?.success) {
          setError(toErrorMessage(result?.error, 'Failed to start triage'));
          return;
        }
        const scan = result.scan;
        if (
          scan?.partial ||
          (typeof scan?.skippedSymlinks === 'number' && scan.skippedSymlinks > 0)
        ) {
          setScanWarning({
            partial: Boolean(scan?.partial),
            reasons: Array.isArray(scan?.reasons) ? scan.reasons : [],
            maxFiles: scan?.maxFiles,
            filesIncluded: scan?.filesIncluded,
            skippedSymlinks: scan?.skippedSymlinks
          });
        } else {
          setScanWarning(null);
        }
        setTriageId(result.triageId);
        setFolderPath(result.folderPath);
        setBuckets({
          keep: result.buckets?.keep || [],
          trash: result.buckets?.trash || [],
          excluded: result.buckets?.excluded || [],
          ambiguous: result.buckets?.ambiguous || [],
          review: [],
          unmatched: []
        });
        const suggested = (result.buckets?.trash || []).length > 0 ? 'trash' : 'keep';
        setActiveTab(suggested);
      } catch (err) {
        logger.error('[DownloadsTriageView] start failed', { error: err?.message });
        setError(err?.message || 'Failed to start triage');
      } finally {
        setIsScanning(false);
        setScanProgress(null);
      }
    },
    [downloadsTriageExclusions]
  );

  const handleChooseFolder = useCallback(async () => {
    try {
      // The folder is scanned, not written to.
      const result = await window?.electronAPI?.files?.selectDirectory?.({ purpose: 'source' });
      if (result?.success && result.path) {
        await runStart(result.path);
      } else if (result && result.success === false && result.error) {
        // Cancel returns success:false with no error — only surface real
        // picker failures instead of silently swallowing them.
        setError(result.error);
      }
    } catch (err) {
      logger.error('[DownloadsTriageView] choose folder failed', { error: err?.message });
      setError(err?.message || 'Folder selection failed');
    }
  }, [runStart]);

  const handleExportReport = useCallback(async () => {
    if (!triageId) return;
    setExportStatus('');
    try {
      const result = await window?.electronAPI?.downloads?.triage?.exportReport?.(triageId);
      if (result?.success) {
        setExportStatus(
          Number.isFinite(result.rowCount) ? `Saved ${result.rowCount} rows` : 'Report saved'
        );
      } else if (!result?.canceled) {
        setExportStatus(result?.error || 'Export failed');
      }
    } catch (err) {
      setExportStatus(err?.message || 'Export failed');
    }
  }, [triageId]);

  const handleDeepScan = useCallback(async () => {
    if (!triageId) return;
    setScanProgress(null);
    setIsDeepScanning(true);
    setError(null);
    try {
      const api = window?.electronAPI?.downloads?.triage?.deepScan;
      if (typeof api !== 'function') throw new Error('Deep scan API unavailable');
      const result = await api({ triageId });
      if (result?.canceled || result?.cancelled) {
        setError('Deep scan was cancelled.');
        return;
      }
      if (!result?.success) {
        setError(toErrorMessage(result?.error, 'Deep scan failed'));
        return;
      }
      setBuckets({
        keep: result.buckets?.keep || [],
        trash: result.buckets?.trash || [],
        excluded: result.buckets?.excluded || [],
        ambiguous: result.buckets?.ambiguous || [],
        review: result.buckets?.review || [],
        unmatched: result.buckets?.unmatched || []
      });
      setSelected(new Set());
      if ((result.buckets?.review || []).length > 0) setActiveTab('review');
      else if ((result.buckets?.unmatched || []).length > 0) setActiveTab('unmatched');
    } catch (err) {
      logger.error('[DownloadsTriageView] deep scan failed', { error: err?.message });
      setError(err?.message || 'Deep scan failed');
    } finally {
      setIsDeepScanning(false);
      setScanProgress(null);
    }
  }, [triageId]);

  React.useEffect(() => {
    if (!isOpen) return undefined;
    const sub = window?.electronAPI?.downloads?.triage?.onScanProgress;
    if (typeof sub !== 'function') return undefined;
    return sub((data) => {
      if (!data || typeof data !== 'object') return;
      const done = Number(data.done);
      const total = Number(data.total);
      if (!Number.isFinite(done) || !Number.isFinite(total)) return;
      setScanProgress({
        done,
        total,
        phase: typeof data.phase === 'string' ? data.phase : 'tier0',
        etaSeconds: Number.isFinite(Number(data.etaSeconds)) ? Number(data.etaSeconds) : undefined
      });
    });
  }, [isOpen]);

  const runAct = useCallback(
    async (action) => {
      if (selected.size === 0) return;
      setIsActing(true);
      setError(null);
      try {
        const api = window?.electronAPI?.downloads?.triage?.act;
        if (typeof api !== 'function') throw new Error('Triage act API unavailable');
        const activeRecords = buckets[activeTab] || [];
        const files = activeRecords
          .filter((r) => selected.has(triagePathKey(r.filePath)))
          .map((r) => ({
            path: r.filePath,
            size: r.size,
            suggestedFolderPath: r.suggestedFolder?.path
          }));
        if (files.length === 0) return;
        const result = await api({
          triageId,
          action,
          files,
          summary: { label: `Downloads triage — ${action}` }
        });
        if (result?.errorCode === 'NO_SESSION' || result?.errorCode === 'NOT_IN_SESSION') {
          setTriageId(null);
          setFolderPath('');
          setBuckets({
            keep: [],
            trash: [],
            excluded: [],
            ambiguous: [],
            review: [],
            unmatched: []
          });
          setSelected(new Set());
          setActiveTab('trash');
          setIsDeepScanning(false);
          hasAutoSelectedTrashRef.current = null;
          setError(
            result?.errorCode === 'NOT_IN_SESSION'
              ? 'Those files are not in this triage session — rescan.'
              : 'Session expired — rescan the folder.'
          );
          return;
        }
        if (!result?.success && (action === 'trash' || action === 'organize')) {
          const failed = Array.isArray(result?.failed) ? result.failed.length : 0;
          const done = action === 'trash' ? result?.trashed?.length : result?.moved?.length;
          setError(
            `${action === 'trash' ? 'Trashed' : 'Organized'} ${done || 0} of ${files.length}. ${failed} failed — see logs.`
          );
        } else if (!result?.success) {
          setError(toErrorMessage(result?.error, 'Action failed'));
        }
        // The service deliberately surfaces these so the user can be warned
        // (see act()'s undoUnavailable/rejected fields) — swallowing them
        // meant files were trashed with silently-missing undo history and
        // not-in-session rows lingered with no message.
        const actWarnings = [];
        if (result?.undoUnavailable) {
          actWarnings.push(
            action === 'trash'
              ? 'Undo could not record this trash — restore from the OS Trash manually if needed.'
              : 'Undo could not record this move — undo will not cover these files.'
          );
        }
        const rejectedCount = Array.isArray(result?.rejected) ? result.rejected.length : 0;
        if (rejectedCount > 0 && result?.success) {
          actWarnings.push(
            `${rejectedCount} file(s) were no longer in this session and were skipped.`
          );
        }
        if (actWarnings.length > 0) {
          setError((prev) => [prev, ...actWarnings].filter(Boolean).join(' '));
        }
        let removePaths;
        if (action === 'ignore' && result?.success) {
          removePaths = new Set(files.map((f) => f.path));
        } else if (action === 'trash') {
          removePaths = new Set((result?.trashed || []).map((t) => t.path));
        } else if (action === 'organize') {
          removePaths = new Set((result?.moved || []).map((m) => m.path));
        } else {
          removePaths = new Set();
        }
        if (removePaths.size > 0) {
          const removeKeySet = new Set([...removePaths].map((p) => triagePathKey(p)));
          setBuckets((prev) => {
            const next = { ...prev };
            for (const bn of Object.keys(next)) {
              next[bn] = next[bn].filter((r) => !removeKeySet.has(triagePathKey(r.filePath)));
            }
            return next;
          });
        }
        setSelected(new Set());
      } catch (err) {
        logger.error('[DownloadsTriageView] act failed', {
          action,
          error: err?.message
        });
        setError(err?.message || 'Action failed');
      } finally {
        setIsActing(false);
      }
    },
    [buckets, activeTab, selected, triageId]
  );

  // For the trash action we raise a ConfirmModal with count + total bytes so
  // the user always gets a visible checkpoint before destructive work.
  // Non-destructive actions (organize, ignore) run immediately.
  const handleAct = useCallback(
    (action) => {
      if (selected.size === 0) return;
      if (action !== 'trash') {
        runAct(action);
        return;
      }
      const activeRecords = buckets[activeTab] || [];
      const selectedRecords = activeRecords.filter((r) => selected.has(triagePathKey(r.filePath)));
      const bytes = selectedRecords.reduce((sum, r) => sum + (Number(r.size) || 0), 0);
      setPendingTrash({
        count: selectedRecords.length,
        bytes,
        run: () => runAct('trash')
      });
    },
    [buckets, activeTab, selected, runAct]
  );

  const toggleRow = useCallback((filePath, nextSelected) => {
    const k = triagePathKey(filePath);
    setSelected((prev) => {
      const next = new Set(prev);
      if (nextSelected) next.add(k);
      else next.delete(k);
      return next;
    });
  }, []);

  const selectAllInTab = useCallback(
    (nextSelected) => {
      setSelected(() => {
        if (!nextSelected) return new Set();
        return new Set((buckets[activeTab] || []).map((r) => triagePathKey(r.filePath)));
      });
    },
    [buckets, activeTab]
  );

  const activeRows = useMemo(() => buckets[activeTab] || [], [buckets, activeTab]);
  const tabsToShow = useMemo(
    () =>
      TAB_DEFS.filter(
        (t) =>
          t.key === 'trash' ||
          t.key === 'keep' ||
          t.key === 'excluded' ||
          (buckets[t.key] && buckets[t.key].length > 0)
      ),
    [buckets]
  );
  const activeDef = TAB_DEFS.find((t) => t.key === activeTab) || TAB_DEFS[0];

  // Pre-select defaults per tab: all trash candidates are pre-checked once per
  // session so the safe-by-default "Send to Trash" path is one click; user can
  // clear selection without an infinite re-select loop.
  React.useEffect(() => {
    if (!triageId || activeTab !== 'trash' || activeRows.length === 0) return;
    if (hasAutoSelectedTrashRef.current === triageId) return;
    setSelected(new Set(activeRows.map((r) => triagePathKey(r.filePath))));
    hasAutoSelectedTrashRef.current = triageId;
  }, [triageId, activeTab, activeRows]);

  const selectedCount = selected.size;
  const selectedBytes = useMemo(() => {
    return activeRows
      .filter((r) => selected.has(triagePathKey(r.filePath)))
      .reduce((sum, r) => sum + (Number(r.size) || 0), 0);
  }, [activeRows, selected]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Downloads triage"
      description={
        folderPath
          ? `Classifying ${folderPath}`
          : 'Scan a folder to classify files against your Smart Folders.'
      }
      size="xl"
      closeOnOverlayClick={!isScanning && !isDeepScanning && !isActing}
      closeDisabled={isScanning || isDeepScanning || isActing}
    >
      <div className="flex flex-col h-[70vh]">
        {scanWarning && (
          <div className="mx-4 mt-3" role="status">
            <div className="flex items-start gap-cozy rounded-lg border border-stratosort-warning/30 bg-stratosort-warning/10 px-3.5 py-3">
              <AlertTriangle
                className="mt-0.5 h-4 w-4 shrink-0 text-stratosort-warning"
                aria-hidden="true"
              />
              <div className="min-w-0 flex-1 space-y-1.5">
                <Text variant="small" className="font-semibold text-stratosort-warning">
                  {scanWarning.partial ? 'Partial scan — results may be incomplete' : 'Scan note'}
                </Text>
                {(typeof scanWarning.filesIncluded === 'number' &&
                  typeof scanWarning.maxFiles === 'number') ||
                (typeof scanWarning.skippedSymlinks === 'number' &&
                  scanWarning.skippedSymlinks > 0) ? (
                  <Text variant="tiny" as="div" className="leading-snug text-system-gray-600">
                    {typeof scanWarning.filesIncluded === 'number' &&
                    typeof scanWarning.maxFiles === 'number'
                      ? `Included ${scanWarning.filesIncluded.toLocaleString()} of a ${scanWarning.maxFiles.toLocaleString()}-file cap.`
                      : ''}
                    {typeof scanWarning.skippedSymlinks === 'number' &&
                    scanWarning.skippedSymlinks > 0
                      ? ` ${scanWarning.skippedSymlinks.toLocaleString()} symlink${scanWarning.skippedSymlinks === 1 ? '' : 's'} skipped.`
                      : ''}
                  </Text>
                ) : null}
                {Array.isArray(scanWarning.reasons) && scanWarning.reasons.length > 0 && (
                  <div className="flex flex-wrap gap-1.5 pt-0.5">
                    {scanWarning.reasons.map((reason) => (
                      <span
                        key={reason}
                        className="inline-flex items-center rounded-full border border-stratosort-warning/40 px-2 py-0.5 text-micro font-medium text-stratosort-warning"
                      >
                        {formatScanReason(reason)}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
        {/* Header actions */}
        <div className="flex items-center justify-between gap-cozy px-4 py-3 border-b border-system-gray-200">
          <div className="flex-1 min-w-0">
            {triageId ? (
              <div className="flex items-center gap-compact min-w-0" title={`Session ${triageId}`}>
                <Filter className="h-3.5 w-3.5 shrink-0 text-system-gray-400" aria-hidden="true" />
                <Text variant="tiny" className="text-system-gray-500 truncate">
                  Default exclusions applied · installers, partial downloads, recent files
                </Text>
              </div>
            ) : (
              <Text variant="small" className="text-system-gray-600">
                Tier 0 classifies files in parallel from metadata (large folders may take a few
                minutes). Deep scan is opt-in and only runs on the Ambiguous subset.
              </Text>
            )}
          </div>
          <div className="flex items-center gap-compact">
            <Button
              size="sm"
              variant="secondary"
              onClick={handleChooseFolder}
              disabled={isScanning || isDeepScanning}
              leftIcon={<FolderOpen className="w-4 h-4" />}
            >
              Choose folder…
            </Button>
            <Button
              size="sm"
              variant="primary"
              onClick={() => runStart(folderPath || undefined)}
              disabled={isScanning || isDeepScanning}
              isLoading={isScanning}
              leftIcon={<Play className="w-4 h-4" />}
            >
              {triageId ? 'Rescan' : 'Scan Downloads'}
            </Button>
            {triageId && (
              <Button
                size="sm"
                variant="ghost"
                onClick={handleExportReport}
                disabled={isScanning || isDeepScanning}
                leftIcon={<Download className="w-4 h-4" />}
              >
                Export report
              </Button>
            )}
            {exportStatus && (
              <span className="text-micro text-system-gray-500" role="status">
                {exportStatus}
              </span>
            )}
          </div>
        </div>

        {error && (
          <div className="mx-4 mt-3 p-3 rounded-lg bg-stratosort-danger/10 border border-stratosort-danger/30">
            <Text variant="small" className="text-stratosort-danger">
              {error}
            </Text>
          </div>
        )}

        {(isScanning || isDeepScanning) && scanProgress && scanProgress.total > 0 && (
          <div className="mx-4 mt-3" aria-live="polite">
            <Text variant="tiny" className="text-system-gray-600">
              {scanProgress.phase === 'tier1' ? 'Deep scan' : 'Scanning'}: {scanProgress.done} /{' '}
              {scanProgress.total}
              {typeof scanProgress.etaSeconds === 'number' &&
              scanProgress.etaSeconds > 0 &&
              scanProgress.done < scanProgress.total
                ? ` · ~${Math.round(scanProgress.etaSeconds)}s left`
                : ''}
            </Text>
            <div
              className="mt-1 h-1.5 bg-system-gray-100 rounded overflow-hidden"
              role="progressbar"
              aria-valuenow={scanProgress.done}
              aria-valuemin={0}
              aria-valuemax={scanProgress.total}
              aria-label={
                scanProgress.phase === 'tier1' ? 'Deep scan progress' : 'Folder scan progress'
              }
            >
              <div
                className="h-full bg-stratosort-blue transition-[width]"
                style={{
                  width: `${Math.min(100, (scanProgress.done / scanProgress.total) * 100)}%`
                }}
              />
            </div>
          </div>
        )}

        {/* Tabs */}
        <div className="flex gap-1 px-4 pt-3 border-b border-system-gray-200 shrink-0 overflow-x-auto">
          {tabsToShow.map((tab) => {
            const count = (buckets[tab.key] || []).length;
            const isActive = tab.key === activeTab;
            return (
              <button
                type="button"
                key={tab.key}
                onClick={() => {
                  setActiveTab(tab.key);
                  setSelected(new Set());
                }}
                className={`px-3 py-2 text-sm font-medium border-b-2 transition-colors whitespace-nowrap ${
                  isActive
                    ? 'border-stratosort-blue text-stratosort-blue'
                    : 'border-transparent text-system-gray-600 hover:text-system-gray-900'
                }`}
              >
                {tab.label} ({count})
              </button>
            );
          })}
        </div>

        <div className="px-4 pt-2 pb-1 shrink-0">
          <Text variant="tiny" className="text-system-gray-500">
            {activeDef.copy}
          </Text>
        </div>

        {/* Bulk-action toolbar */}
        {triageId && activeRows.length > 0 && (
          <div className="flex items-center justify-between gap-cozy px-4 py-2 border-b border-system-gray-100 shrink-0">
            <label className="inline-flex items-center gap-compact text-sm text-system-gray-600">
              <input
                type="checkbox"
                className="accent-stratosort-blue"
                checked={selectedCount > 0 && selectedCount === activeRows.length}
                ref={(el) => {
                  if (el) el.indeterminate = selectedCount > 0 && selectedCount < activeRows.length;
                }}
                onChange={(e) => selectAllInTab(e.target.checked)}
                aria-label="Select all in current tab"
              />
              Select all
            </label>
            <div className="flex items-center gap-compact">
              <Text variant="tiny" className="text-system-gray-500">
                {selectedCount} selected
                {selectedBytes > 0 ? ` · ${formatBytes(selectedBytes)}` : ''}
              </Text>
              {activeTab === 'ambiguous' && (
                <Button
                  size="sm"
                  variant="primary"
                  onClick={handleDeepScan}
                  disabled={isDeepScanning}
                  isLoading={isDeepScanning}
                  leftIcon={<Sparkles className="w-4 h-4" />}
                >
                  {`Deep scan ${buckets.ambiguous.length}`}
                </Button>
              )}
              <Button
                size="sm"
                variant="danger"
                onClick={() => handleAct('trash')}
                disabled={isActing || selectedCount === 0}
                isLoading={isActing}
                leftIcon={<Trash2 className="w-4 h-4" />}
              >
                Send to Trash
              </Button>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => handleAct('organize')}
                disabled={isActing || selectedCount === 0 || activeTab === 'trash'}
                leftIcon={<FolderOpen className="w-4 h-4" />}
              >
                Organize
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => handleAct('ignore')}
                disabled={isActing || selectedCount === 0}
                leftIcon={<EyeOff className="w-4 h-4" />}
              >
                Ignore
              </Button>
            </div>
          </div>
        )}

        {/* Tab body */}
        <div className="flex-1 min-h-0 overflow-y-auto">
          {!triageId ? (
            <div className="p-8 text-center text-system-gray-500">
              <Heading as="h4" variant="h6" className="mb-2 text-system-gray-700">
                Ready to triage
              </Heading>
              <Text variant="small">
                Click <strong>Scan Downloads</strong> to classify files in your Downloads folder
                against your Smart Folders. No files are moved or deleted until you explicitly act
                on a bucket.
              </Text>
            </div>
          ) : activeRows.length === 0 ? (
            <div className="p-8 text-center text-system-gray-400">
              <Text variant="small">No files in this tab.</Text>
            </div>
          ) : (
            <ul>
              {activeRows.map((record) => (
                <Row
                  key={triagePathKey(record.filePath)}
                  record={record}
                  onSelect={toggleRow}
                  selected={selected.has(triagePathKey(record.filePath))}
                  openFile={openFile}
                  revealFile={revealFile}
                  redactPaths={redactPaths}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
      <ConfirmModal
        isOpen={Boolean(pendingTrash)}
        onClose={() => setPendingTrash(null)}
        onConfirm={async () => {
          if (!pendingTrash) return;
          await pendingTrash.run();
          setPendingTrash(null);
        }}
        title="Send files to Trash"
        message={
          pendingTrash
            ? `${pendingTrash.count} file${pendingTrash.count === 1 ? '' : 's'} will be moved to your system Trash` +
              (pendingTrash.bytes > 0 ? ` (${formatBytes(pendingTrash.bytes)} reclaimed).` : '.') +
              ' You can restore them from Trash while your OS still has them.'
            : ''
        }
        confirmText="Send to Trash"
        cancelText="Cancel"
        variant="danger"
      />
    </Modal>
  );
}

DownloadsTriageView.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired
};
