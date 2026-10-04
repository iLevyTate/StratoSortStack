import React, { useState, useMemo, useRef, useCallback, useEffect } from 'react';
import PropTypes from 'prop-types';
import { useSelector } from 'react-redux';
import { Trash2, Check, ChevronDown, ChevronRight } from 'lucide-react';
import { List } from 'react-window';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { Heading, Text } from '../ui/Typography';
import FileIcon from '../ui/FileIcon';
import { useFileActions } from '../../hooks/useFileActions';
import { selectRedactPaths } from '../../store/selectors';
import { formatDisplayFileName, formatDisplayPath } from '../../utils/pathDisplay';
import { normalizeDuplicateMember, safeBasename } from '../../../shared/memberPathUtils';
import { formatBytes } from '../../utils/format';
import { createLogger } from '../../../shared/logger';

const logger = createLogger('DuplicateResolutionModal');

const TIER_CONFIG = {
  exact: {
    label: 'Exact duplicates',
    reasonCopy: 'Byte-identical. Safe to send to Trash.',
    badgeClass: 'bg-stratosort-success/10 text-stratosort-success border-stratosort-success/20'
  },
  nearIdentical: {
    label: 'Near-identical',
    reasonCopy: 'Likely the same document. Review before trashing.',
    badgeClass: 'bg-amber-50 text-amber-700 border-amber-100'
  },
  related: {
    label: 'Related',
    reasonCopy:
      'Topically similar — may be drafts or versions. Do not bulk-delete without reviewing.',
    badgeClass: 'bg-system-gray-100 text-system-gray-600 border-system-gray-200'
  }
};

function getByteSize(value) {
  if (value == null || value === '') return null;
  const size = Number(value);
  return Number.isFinite(size) && size >= 0 ? size : null;
}

function formatByteSummary(summary, emptyLabel = 'Size unavailable') {
  if (!summary?.hasKnown) return emptyLabel;
  if (summary.hasUnknown) return `At least ${formatBytes(summary.totalBytes)}`;
  return formatBytes(summary.totalBytes);
}

function summarizeByteValues(values) {
  return values.reduce(
    (summary, value) => {
      const size = getByteSize(value);
      if (size == null) {
        summary.hasUnknown = true;
        return summary;
      }
      summary.totalBytes += size;
      summary.hasKnown = true;
      return summary;
    },
    { totalBytes: 0, hasKnown: false, hasUnknown: false }
  );
}

function formatGroupSizeLabel(group) {
  const sizes = group.members.map((member) => getByteSize(member.size));
  const knownSizes = sizes.filter((size) => size != null);

  if (knownSizes.length === 0) return 'Size unavailable';
  if (knownSizes.length !== sizes.length) {
    return `At least ${formatBytes(knownSizes.reduce((sum, size) => sum + size, 0))} total`;
  }
  if (knownSizes.every((size) => size === knownSizes[0])) {
    return `${formatBytes(knownSizes[0])} each`;
  }
  return `${formatBytes(knownSizes.reduce((sum, size) => sum + size, 0))} total`;
}

function pathDepth(filePath) {
  if (!filePath) return 0;
  return String(filePath).split(/[\\/]/).filter(Boolean).length;
}

/**
 * Tier-specific default keeper selection. Returns the member whose path/id
 * should be pre-selected as "keep" (delete the others). Returns null for
 * RELATED tier where the user must actively choose.
 */
function pickDefaultKeeper(group) {
  const members = Array.isArray(group.members) ? group.members : [];
  if (members.length === 0) return null;
  const tier = group.tier || 'related';

  if (tier === 'related') return null;

  if (tier === 'exact') {
    // Keep the newest + largest (proxy: most recent mtime, then largest size).
    const sorted = [...members].sort((a, b) => {
      const mtA = Number(a.mtime || a.mtimeMs || 0);
      const mtB = Number(b.mtime || b.mtimeMs || 0);
      if (mtA !== mtB) return mtB - mtA;
      const sizeA = getByteSize(a.size) || 0;
      const sizeB = getByteSize(b.size) || 0;
      if (sizeA !== sizeB) return sizeB - sizeA;
      return String(a.path || a.id || '').localeCompare(String(b.path || b.id || ''));
    });
    return sorted[0]?.path || sorted[0]?.id || null;
  }

  // nearIdentical: prefer largest file, deepest path (proxy for "organized copy").
  const sorted = [...members].sort((a, b) => {
    const sizeA = getByteSize(a.size) || 0;
    const sizeB = getByteSize(b.size) || 0;
    if (sizeA !== sizeB) return sizeB - sizeA;
    const depthDiff = pathDepth(b.path) - pathDepth(a.path);
    if (depthDiff !== 0) return depthDiff;
    return String(a.path || a.id || '').localeCompare(String(b.path || b.id || ''));
  });
  return sorted[0]?.path || sorted[0]?.id || null;
}

const VirtualizedGroupRow = React.memo(function VirtualizedGroupRow({ index, style, data }) {
  const { groups, selections, handleSelectKeep, openFile, revealFile, redactPaths } = data;
  const group = groups[index];
  const groupIndex = group?.flatIndex ?? index;

  if (!group) return null;

  const tierCfg = TIER_CONFIG[group.tier] || TIER_CONFIG.related;

  return (
    <div style={style} className="pr-2 pb-6">
      <div className="bg-system-gray-50 rounded-xl p-4 border border-system-gray-100 h-full overflow-hidden flex flex-col">
        <div className="flex items-center justify-between mb-3 shrink-0">
          <Heading as="h4" variant="h6" className="text-system-gray-700">
            Duplicate set {groupIndex + 1}
          </Heading>
          <div className="flex items-center gap-compact">
            <Text
              as="span"
              variant="tiny"
              className={`inline-flex items-center px-2 py-0.5 rounded-md font-medium border ${tierCfg.badgeClass}`}
            >
              {group.tier === 'exact'
                ? 'Identical'
                : Number.isFinite(group.averageSimilarity) && group.averageSimilarity < 1
                  ? `${Math.floor(group.averageSimilarity * 1000) / 10}% similar`
                  : tierCfg.label}
            </Text>
            <Text variant="small" className="text-system-gray-500">
              {group.members.length} files • {formatGroupSizeLabel(group)}
            </Text>
          </div>
        </div>

        <div className="space-y-2 flex-1 overflow-y-auto">
          {group.members.map((file) => {
            const path = file.path || file.id;
            const isKept = selections[groupIndex] === path;
            const rawLabel = file.name || safeBasename(path);
            const displayLabel = formatDisplayFileName(rawLabel, { redact: redactPaths });
            const displayPathLine = formatDisplayPath(String(path || ''), {
              redact: redactPaths,
              segments: 2
            });
            const sizeLabel =
              getByteSize(file.size) != null ? formatBytes(Number(file.size)) : null;

            return (
              <div
                key={path}
                className={`
                  group relative flex items-center gap-cozy p-3 rounded-lg border transition
                  ${
                    isKept
                      ? 'bg-system-gray-100 border-stratosort-blue ring-1 ring-stratosort-blue shadow-sm z-10'
                      : selections[groupIndex] == null
                        ? 'bg-system-gray-100/40 border-system-gray-200 hover:border-system-gray-300'
                        : 'bg-system-gray-100/60 border-system-gray-200 hover:border-system-gray-300 opacity-70 hover:opacity-100'
                  }
                `}
              >
                <div className="flex items-center justify-center w-6 h-6 shrink-0">
                  <input
                    type="radio"
                    name={`group-${groupIndex}`}
                    checked={isKept}
                    onChange={() => handleSelectKeep(groupIndex, path)}
                    aria-label={`Keep ${displayLabel}`}
                    className="text-stratosort-blue focus:ring-stratosort-blue"
                  />
                </div>

                <button
                  type="button"
                  onClick={() => handleSelectKeep(groupIndex, path)}
                  aria-pressed={isKept}
                  className="flex min-w-0 flex-1 items-center gap-cozy text-left"
                >
                  <FileIcon
                    filename={file.name || safeBasename(path)}
                    className="w-8 h-8 shrink-0"
                  />

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-compact">
                      <Text
                        as="span"
                        variant="small"
                        className={`font-medium truncate ${isKept ? 'text-system-gray-900' : 'text-system-gray-600'}`}
                      >
                        {displayLabel}
                      </Text>
                      {isKept && (
                        <Text
                          as="span"
                          variant="tiny"
                          className="inline-flex items-center px-1.5 py-0.5 rounded-md font-medium bg-stratosort-blue/10 text-stratosort-blue"
                        >
                          Keep
                        </Text>
                      )}
                      {!isKept && selections[groupIndex] != null && (
                        <Text
                          as="span"
                          variant="tiny"
                          className="inline-flex items-center px-1.5 py-0.5 rounded-md font-medium bg-stratosort-danger/10 text-stratosort-danger"
                        >
                          Delete
                        </Text>
                      )}
                    </div>
                    <Text
                      as="div"
                      variant="tiny"
                      className="text-system-gray-500 truncate font-mono"
                      title={redactPaths ? undefined : path}
                    >
                      {displayPathLine}
                      {sizeLabel ? ` · ${sizeLabel}` : ''}
                    </Text>
                  </div>
                </button>

                <div className="flex gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      openFile(path);
                    }}
                    title="Open file"
                  >
                    Open
                  </Button>
                  <Button
                    size="xs"
                    variant="ghost"
                    onClick={(e) => {
                      e.stopPropagation();
                      revealFile(path);
                    }}
                    title="Show in folder"
                  >
                    Reveal
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});

VirtualizedGroupRow.propTypes = {
  index: PropTypes.number.isRequired,
  style: PropTypes.object.isRequired,
  data: PropTypes.shape({
    groups: PropTypes.array.isRequired,
    selections: PropTypes.object.isRequired,
    handleSelectKeep: PropTypes.func.isRequired,
    openFile: PropTypes.func.isRequired,
    revealFile: PropTypes.func.isRequired,
    redactPaths: PropTypes.bool.isRequired
  }).isRequired
};

function TierSection({
  tier,
  groups,
  selections,
  handleSelectKeep,
  openFile,
  revealFile,
  redactPaths,
  collapsed,
  onToggle,
  threshold,
  onThresholdChange
}) {
  const cfg = TIER_CONFIG[tier];

  const getGroupHeight = useCallback(
    (index) => {
      const group = groups[index];
      if (!group) return 100;
      const memberCount = group.members.length;
      return 92 + memberCount * 68 + (memberCount - 1) * 8;
    },
    [groups]
  );

  const rowProps = useMemo(
    () => ({
      data: {
        groups,
        selections,
        handleSelectKeep,
        openFile,
        revealFile,
        redactPaths
      }
    }),
    [groups, selections, handleSelectKeep, openFile, revealFile, redactPaths]
  );

  const containerRef = useRef(null);
  const [listHeight, setListHeight] = useState(300);
  useEffect(() => {
    if (!containerRef.current) return;
    const observer = new ResizeObserver((entries) => {
      for (const entry of entries) {
        setListHeight(entry.contentRect.height);
      }
    });
    observer.observe(containerRef.current);
    return () => observer.disconnect();
  }, [collapsed]);

  return (
    <div className="flex flex-col border-b border-system-gray-200 last:border-b-0">
      <button
        type="button"
        onClick={onToggle}
        className="flex items-center justify-between px-4 py-3 hover:bg-system-gray-50 transition-colors text-left"
      >
        <div className="flex items-center gap-compact">
          {collapsed ? <ChevronRight size={16} /> : <ChevronDown size={16} />}
          <Text as="span" variant="small" className="font-semibold">
            {cfg.label}
          </Text>
          <Text
            as="span"
            variant="tiny"
            className={`inline-flex items-center px-2 py-0.5 rounded-md font-medium border ${cfg.badgeClass}`}
          >
            {groups.length} {groups.length === 1 ? 'group' : 'groups'}
          </Text>
        </div>
        <Text as="span" variant="tiny" className="text-system-gray-500">
          {cfg.reasonCopy}
        </Text>
      </button>

      {!collapsed && tier === 'related' && onThresholdChange && (
        <div className="px-4 pb-2 flex items-center gap-compact">
          <Text as="span" variant="tiny" className="text-system-gray-500">
            Threshold:
          </Text>
          <input
            type="range"
            min={0.9}
            max={0.97}
            step={0.01}
            value={threshold}
            aria-label="Similarity threshold"
            onChange={(e) => onThresholdChange(Number(e.target.value))}
            className="flex-1 accent-stratosort-blue"
          />
          <Text as="span" variant="tiny" className="font-mono text-system-gray-600 w-12">
            {Math.round(threshold * 100)}%
          </Text>
        </div>
      )}

      {!collapsed && groups.length > 0 && (
        <div ref={containerRef} className="px-4 pb-3" style={{ height: 360 }}>
          <List
            rowCount={groups.length}
            rowHeight={getGroupHeight}
            rowComponent={VirtualizedGroupRow}
            rowProps={rowProps}
            overscanCount={2}
            style={{ height: listHeight, width: '100%' }}
            className="scrollbar-thin scrollbar-thumb-system-gray-300 scrollbar-track-transparent"
          />
        </div>
      )}

      {!collapsed && groups.length === 0 && (
        <div className="px-4 pb-4">
          <Text variant="small" className="text-system-gray-400">
            No {cfg.label.toLowerCase()} found.
          </Text>
        </div>
      )}
    </div>
  );
}

TierSection.propTypes = {
  tier: PropTypes.oneOf(['exact', 'nearIdentical', 'related']).isRequired,
  groups: PropTypes.array.isRequired,
  selections: PropTypes.object.isRequired,
  handleSelectKeep: PropTypes.func.isRequired,
  openFile: PropTypes.func.isRequired,
  revealFile: PropTypes.func.isRequired,
  redactPaths: PropTypes.bool.isRequired,
  collapsed: PropTypes.bool.isRequired,
  onToggle: PropTypes.func.isRequired,
  threshold: PropTypes.number,
  onThresholdChange: PropTypes.func
};

/**
 * DuplicateResolutionModal
 *
 * Renders three tier sections (EXACT / NEAR-IDENTICAL / RELATED) with per-tier
 * default selection and copy. Delete action routes through shell.trashItem +
 * batched undo via the parent `onResolve` callback.
 */
export default function DuplicateResolutionModal({
  isOpen,
  onClose,
  duplicateGroups = [],
  onResolve
}) {
  const [selections, setSelections] = useState({});
  const [isResolving, setIsResolving] = useState(false);
  const [resolveError, setResolveError] = useState(null);
  const [collapsedTiers, setCollapsedTiers] = useState({
    exact: false,
    nearIdentical: false,
    related: true
  });
  const [relatedThreshold, setRelatedThreshold] = useState(0.82);
  const { openFile, revealFile } = useFileActions();
  const redactPaths = useSelector(selectRedactPaths);
  const prevIsOpenRef = useRef(false);

  // Normalize incoming groups and attach a stable flatIndex used as selection key.
  const normalizedGroups = useMemo(() => {
    const list = (Array.isArray(duplicateGroups) ? duplicateGroups : [])
      .map((group) => {
        const members = Array.isArray(group)
          ? group
          : Array.isArray(group?.members)
            ? group.members
            : [];
        const normalizedMembers = members
          .map((member, memberIndex) => normalizeDuplicateMember(member, memberIndex, group?.id))
          .filter((member) => Boolean(member.id));
        const tier = group?.tier || (group?.reason === 'sha256' ? 'exact' : 'related');
        const similarity = Number(group?.averageSimilarity);
        return {
          id: group?.id,
          tier,
          reason: group?.reason || null,
          members: normalizedMembers,
          averageSimilarity: Number.isFinite(similarity)
            ? Math.max(0, Math.min(1, similarity))
            : null
        };
      })
      .filter((group) => group.members.length > 0);
    // Assign flatIndex for selection state keying, preserving tier grouping order.
    return list.map((group, idx) => ({ ...group, flatIndex: idx }));
  }, [duplicateGroups]);

  const tierBuckets = useMemo(() => {
    const filterRelated = (group) => {
      if (group.tier !== 'related') return true;
      return Number.isFinite(group.averageSimilarity)
        ? group.averageSimilarity >= relatedThreshold
        : true;
    };
    return {
      exact: normalizedGroups.filter((g) => g.tier === 'exact'),
      nearIdentical: normalizedGroups.filter((g) => g.tier === 'nearIdentical'),
      related: normalizedGroups.filter((g) => g.tier === 'related' && filterRelated(g))
    };
  }, [normalizedGroups, relatedThreshold]);

  const relatedHiddenByThreshold = useMemo(
    () =>
      normalizedGroups.filter(
        (g) =>
          g.tier === 'related' &&
          Number.isFinite(g.averageSimilarity) &&
          g.averageSimilarity < relatedThreshold
      ).length,
    [normalizedGroups, relatedThreshold]
  );

  // Initialize per-tier default selection on open.
  useEffect(() => {
    const wasOpen = prevIsOpenRef.current;
    prevIsOpenRef.current = isOpen;
    if (isOpen && !wasOpen && normalizedGroups.length > 0) {
      const initial = {};
      for (const group of normalizedGroups) {
        const keeper = pickDefaultKeeper(group);
        if (keeper != null) {
          initial[group.flatIndex] = keeper;
        }
      }
      setSelections(initial);
      setCollapsedTiers({
        exact: false,
        nearIdentical: false,
        related: tierBuckets.related.length === 0
      });
    }
  }, [isOpen, normalizedGroups, tierBuckets.related.length]);

  const handleSelectKeep = useCallback((groupIndex, filePath) => {
    setSelections((prev) => ({ ...prev, [groupIndex]: filePath }));
  }, []);

  const handleResolve = useCallback(async () => {
    setIsResolving(true);
    setResolveError(null);
    try {
      const resolutions = [];
      for (const group of normalizedGroups) {
        const keepId = selections[group.flatIndex];
        if (!keepId) continue;
        const keepFile = group.members.find((f) => (f.path || f.id) === keepId);
        const deleteFiles = group.members.filter((f) => (f.path || f.id) !== keepId);
        if (keepFile && deleteFiles.length > 0) {
          resolutions.push({ keep: keepFile, delete: deleteFiles, tier: group.tier });
        }
      }
      await onResolve(resolutions);
      onClose();
    } catch (error) {
      logger.error('Failed to resolve duplicates', {
        error: error?.message,
        stack: error?.stack
      });
      setResolveError(error?.message || 'Failed to resolve duplicates');
    } finally {
      setIsResolving(false);
    }
  }, [normalizedGroups, selections, onResolve, onClose]);

  const totalSavingsSummary = useMemo(() => {
    const sizes = [];
    for (const group of normalizedGroups) {
      const keepId = selections[group.flatIndex];
      if (!keepId) continue;
      group.members.forEach((file) => {
        if ((file.path || file.id) !== keepId) sizes.push(file.size);
      });
    }
    return summarizeByteValues(sizes);
  }, [normalizedGroups, selections]);

  const pendingDeleteCount = useMemo(() => {
    let count = 0;
    for (const group of normalizedGroups) {
      const keepId = selections[group.flatIndex];
      if (!keepId) continue;
      count += group.members.filter((f) => (f.path || f.id) !== keepId).length;
    }
    return count;
  }, [normalizedGroups, selections]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Resolve duplicates"
      description={`Found ${tierBuckets.exact.length} exact, ${
        tierBuckets.nearIdentical.length
      } near-identical, and ${tierBuckets.related.length} related groups${
        relatedHiddenByThreshold > 0
          ? ` (${relatedHiddenByThreshold} related group${
              relatedHiddenByThreshold === 1 ? '' : 's'
            } below ${Math.round(relatedThreshold * 100)}% — lower the related slider to show)`
          : ''
      }.`}
      size="xl"
      closeOnOverlayClick={!isResolving}
      closeOnEsc={!isResolving}
      closeDisabled={isResolving}
      footer={
        <>
          <Text as="div" variant="small" className="flex-1 text-system-gray-500">
            {pendingDeleteCount > 0
              ? `Will send ${pendingDeleteCount} file(s) to Trash · `
              : 'No files selected · '}
            <Text as="span" variant="small" className="font-medium text-system-gray-900">
              {formatByteSummary(totalSavingsSummary)}
            </Text>
          </Text>
          <Button variant="secondary" size="sm" onClick={onClose} disabled={isResolving}>
            Cancel
          </Button>
          <Button
            variant="danger"
            size="sm"
            onClick={handleResolve}
            disabled={isResolving || pendingDeleteCount === 0}
            isLoading={isResolving}
            leftIcon={<Trash2 className="w-4 h-4" />}
          >
            Send {pendingDeleteCount || ''} to Trash
          </Button>
        </>
      }
    >
      <div className="flex flex-col h-[60vh] overflow-auto">
        {resolveError && (
          <div className="bg-stratosort-danger/10 border border-stratosort-danger/30 rounded-lg p-3 text-stratosort-danger text-sm mb-4 mx-4 shrink-0">
            {resolveError}
          </div>
        )}

        {normalizedGroups.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-system-gray-400">
            <Check className="w-12 h-12 mb-2 text-stratosort-success opacity-50" />
            <Text>No duplicates found!</Text>
          </div>
        ) : (
          <>
            <TierSection
              tier="exact"
              groups={tierBuckets.exact}
              selections={selections}
              handleSelectKeep={handleSelectKeep}
              openFile={openFile}
              revealFile={revealFile}
              redactPaths={redactPaths}
              collapsed={collapsedTiers.exact}
              onToggle={() => setCollapsedTiers((p) => ({ ...p, exact: !p.exact }))}
            />
            <TierSection
              tier="nearIdentical"
              groups={tierBuckets.nearIdentical}
              selections={selections}
              handleSelectKeep={handleSelectKeep}
              openFile={openFile}
              revealFile={revealFile}
              redactPaths={redactPaths}
              collapsed={collapsedTiers.nearIdentical}
              onToggle={() => setCollapsedTiers((p) => ({ ...p, nearIdentical: !p.nearIdentical }))}
            />
            <TierSection
              tier="related"
              groups={tierBuckets.related}
              selections={selections}
              handleSelectKeep={handleSelectKeep}
              openFile={openFile}
              revealFile={revealFile}
              redactPaths={redactPaths}
              collapsed={collapsedTiers.related}
              onToggle={() => setCollapsedTiers((p) => ({ ...p, related: !p.related }))}
              threshold={relatedThreshold}
              onThresholdChange={setRelatedThreshold}
            />
          </>
        )}
      </div>
    </Modal>
  );
}

DuplicateResolutionModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  duplicateGroups: PropTypes.array,
  onResolve: PropTypes.func.isRequired
};
