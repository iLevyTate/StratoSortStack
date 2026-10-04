import React, { memo, useCallback, useMemo } from 'react';
import PropTypes from 'prop-types';
import { useSelector } from 'react-redux';
import { FileText, ChevronRight, Info, FolderPlus } from 'lucide-react';
import Input from '../ui/Input';
import Select from '../ui/Select';
import { Button, StatusBadge } from '../ui';
import Card from '../ui/Card';
import { Text } from '../ui/Typography';
import { formatDisplayPath } from '../../utils/pathDisplay';
import { selectRedactPaths } from '../../store/selectors';
import { toCanonicalPath } from '../../utils/canonicalPath';
import {
  getSelectableSmartFolders,
  isDefaultCategoryName
} from '../../../shared/categoryFolderMatching';

function ReadyFileItem({
  file,
  index: _index,
  isSelected = false,
  onToggleSelected,
  stateDisplay,
  smartFolders = [],
  editing = null,
  onEdit,
  category: categoryProp = null,
  // { folder, source: 'user'|'engine'|'name'|'none', engine } from
  // resolveOrganizeDestination: where the file goes and why.
  routing = null,
  onViewDetails = null,
  // Optional: caller passes a function that opens AddSmartFolderModal seeded
  // with the folder name. Without it we still render the hint chip but the
  // CTA falls back to a no-op (informational-only, matches Setup phase
  // behavior when no add handler is wired).
  onCreateSuggestedFolder = null
}) {
  // PERF: Use memoized selector instead of inline Boolean coercion
  const redactPaths = useSelector(selectRedactPaths);
  const analysis = editing?.analysis || file?.analysis;
  const suggestedName = editing?.suggestedName ?? analysis?.suggestedName;
  const category = categoryProp ?? editing?.category ?? analysis?.category;
  const selectableFolders = useMemo(() => getSelectableSmartFolders(smartFolders), [smartFolders]);
  const categoryIsFallback = isDefaultCategoryName(category);
  const hasCategoryOption =
    categoryIsFallback || selectableFolders.some((folder) => folder.name === category);
  // Surface analysis.suggestedNewFolder when the LLM identified a meaningful
  // theme that did NOT match any existing smart folder (e.g. "Labcorp"). The
  // analysis pipeline now sets this field whenever a folder match falls below
  // the unmatched-category floor (see semanticFolderMatcher.js + commit
  // 2951264f). Without this UI the field sat unused, so users only saw the
  // file routed to "Uncategorized" with no hint about WHY — which was the
  // most-cited "regression" complaint after the 0.55 -> 0.75 floor change.
  const suggestedNewFolder =
    typeof analysis?.suggestedNewFolder === 'string' && analysis.suggestedNewFolder.trim()
      ? analysis.suggestedNewFolder.trim()
      : null;
  // Only show the hint when the suggestion would actually change the route:
  // skip it if a smart folder with that exact name already exists, and skip
  // when the user has already overridden the category to something matched.
  const suggestedNewFolderApplies =
    suggestedNewFolder !== null &&
    !smartFolders?.some(
      (f) => f.name && f.name.toLowerCase() === suggestedNewFolder.toLowerCase()
    ) &&
    suggestedNewFolder.toLowerCase() !== String(category || '').toLowerCase();
  const handleCreateSuggested = useCallback(() => {
    if (typeof onCreateSuggestedFolder === 'function' && suggestedNewFolder) {
      onCreateSuggestedFolder({ name: suggestedNewFolder, file });
    }
  }, [onCreateSuggestedFolder, suggestedNewFolder, file]);
  // When the engine placed the file, show its routing confidence (how sure
  // it is about this folder), not the LLM's confidence in its own label.
  const engine = routing?.engine || null;
  const routedByEngine = routing?.source === 'engine' && engine;
  const rawConfidence = routedByEngine ? engine.confidence : analysis?.confidence;
  const confidenceValue =
    typeof rawConfidence === 'number' && Number.isFinite(rawConfidence) && rawConfidence >= 0
      ? rawConfidence
      : null;
  const computedConfidence =
    confidenceValue === null
      ? null
      : confidenceValue > 1
        ? Math.round(confidenceValue)
        : Math.round(confidenceValue * 100);
  // Engine-ranked folders first (primary, then alternatives), limited to
  // folders the user can pick; the rest follow under "All folders".
  const rankedNames = useMemo(() => {
    if (!engine) return [];
    const selectable = new Set(selectableFolders.map((folder) => folder.name));
    const names = [];
    for (const candidate of [engine, ...(engine.alternatives || [])]) {
      if (
        candidate?.folder &&
        selectable.has(candidate.folder) &&
        !names.includes(candidate.folder)
      )
        names.push(candidate.folder);
    }
    return names;
  }, [engine, selectableFolders]);
  const routingNote = useMemo(() => {
    if (!routing) return null;
    if (routing.source === 'engine' && engine) {
      return engine.explanation || 'Ranked by what the file contains';
    }
    if (routing.source === 'user') {
      return engine?.folder && engine.folder !== routing.folder?.name
        ? `Your choice (suggested: ${engine.folder})`
        : 'Your choice';
    }
    if (routing.source === 'name') return 'Matched by folder name';
    return null;
  }, [routing, engine]);
  const showConfidence = computedConfidence !== null;
  const fileKey = toCanonicalPath(file?.path) || file?.path || '';
  const handleToggle = useCallback(() => onToggleSelected(fileKey), [onToggleSelected, fileKey]);
  const handleEditName = useCallback(
    (e) => onEdit(fileKey, 'suggestedName', e.target.value),
    [onEdit, fileKey]
  );
  const handleEditCategory = useCallback(
    (e) => onEdit(fileKey, 'category', e.target.value),
    [onEdit, fileKey]
  );
  const handleViewDetails = useCallback(
    () => onViewDetails && onViewDetails(file),
    [onViewDetails, file]
  );

  const filePath = file.path || '';
  const displayFilePath = formatDisplayPath(filePath, { redact: redactPaths, segments: 2 });
  const tone = stateDisplay.color?.includes('green')
    ? 'success'
    : stateDisplay.color?.includes('amber') || stateDisplay.color?.includes('warning')
      ? 'warning'
      : stateDisplay.color?.includes('red') || stateDisplay.color?.includes('danger')
        ? 'error'
        : 'info';

  return (
    <Card
      variant={isSelected ? 'interactive' : 'default'}
      className={`h-full min-h-0 flex flex-col !p-0 overflow-hidden rounded-xl relative shadow-sm ${
        isSelected ? 'ring-2 ring-stratosort-blue/25' : ''
      }`}
    >
      {/* Header: Checkbox + File Info + Status */}
      <div className="flex items-start gap-cozy sm:gap-default p-4 pb-3 border-b border-system-gray-100 rounded-t-xl bg-[var(--surface-primary)]">
        <input
          type="checkbox"
          checked={isSelected}
          onChange={handleToggle}
          className="form-checkbox accent-stratosort-blue h-4 w-4 rounded border-border-soft focus:ring-stratosort-blue mt-1 flex-shrink-0"
          aria-label={`Select ${file.name}`}
        />

        <div className="flex-1 min-w-0">
          <div className="flex items-start justify-between gap-cozy">
            <div className="flex items-start gap-2.5 min-w-0 flex-1">
              <FileText className="w-4 h-4 text-system-gray-400 flex-shrink-0 mt-0.5" />
              <div className="min-w-0">
                <Text
                  variant="small"
                  className="font-medium text-system-gray-900 line-clamp-2 break-words leading-snug min-w-0 hyphens-auto"
                  title={`${file.name}${displayFilePath ? ` (${displayFilePath})` : ''}`}
                >
                  {file.name}
                </Text>
                <Text variant="tiny" className="text-system-gray-500 mt-0.5">
                  {file.size ? `${Math.round(file.size / 1024)} KB` : 'Pending size'}
                </Text>
              </div>
            </div>

            {/* Status Badge - Top Right */}
            <StatusBadge
              variant={tone}
              size="sm"
              className="min-w-0 max-w-[46%] flex-shrink-0 sm:max-w-none"
            >
              <span className="flex min-w-0 items-center gap-0.5">
                <span
                  className={`flex-shrink-0 ${stateDisplay.spinning ? 'animate-spin' : ''}`}
                  aria-hidden
                >
                  {stateDisplay.icon}
                </span>
                <span className="truncate">{stateDisplay.label}</span>
              </span>
            </StatusBadge>
          </div>
        </div>
      </div>

      {/* Body: Form Fields */}
      {analysis ? (
        <div className="min-w-0 space-y-4 p-4 bg-[var(--surface-primary)]">
          <Input
            label="Suggested name"
            type="text"
            value={suggestedName}
            onChange={handleEditName}
            className="min-w-0 w-full text-sm"
            title={suggestedName}
          />

          <Select
            label="Category"
            value={category}
            onChange={handleEditCategory}
            className="min-w-0 w-full text-sm"
          >
            {categoryIsFallback && (
              <option value={category}>Fallback — no folder match (Uncategorized)</option>
            )}
            {!hasCategoryOption && category && (
              <option value={category}>{`Unmapped: ${category}`}</option>
            )}
            {/* Select reads option/optgroup children directly (arrays are
                flattened, fragments are not), so the groups go in an array. */}
            {rankedNames.length > 0
              ? [
                  <optgroup key="suggested" label="Suggested">
                    {rankedNames.map((name, rank) => (
                      <option key={`ranked-${name}`} value={name}>
                        {rank === 0 ? `${name} (best match)` : name}
                      </option>
                    ))}
                  </optgroup>,
                  <optgroup key="all" label="All folders">
                    {selectableFolders
                      .filter((folder) => !rankedNames.includes(folder.name))
                      .map((folder) => (
                        <option key={folder.id || folder.name} value={folder.name}>
                          {folder.name}
                        </option>
                      ))}
                  </optgroup>
                ]
              : selectableFolders.map((folder) => (
                  <option key={folder.id || folder.name} value={folder.name}>
                    {folder.name}
                  </option>
                ))}
          </Select>
          {routingNote && (
            <Text
              variant="tiny"
              className="-mt-2 text-system-gray-500 line-clamp-2"
              data-testid="organize-routing-note"
            >
              {routingNote}
            </Text>
          )}

          {suggestedNewFolderApplies && (
            <div
              className="flex flex-wrap items-center gap-compact rounded-lg border border-dashed border-stratosort-blue/40 bg-stratosort-blue/5 px-3 py-2"
              role="note"
              aria-label="Suggested new smart folder"
            >
              <FolderPlus className="w-3.5 h-3.5 flex-shrink-0 text-stratosort-blue" aria-hidden />
              <Text variant="tiny" className="flex-1 min-w-0 text-system-gray-700">
                AI suggests a new smart folder:{' '}
                <span className="font-medium text-system-gray-900">
                  &ldquo;{suggestedNewFolder}&rdquo;
                </span>
              </Text>
              {typeof onCreateSuggestedFolder === 'function' && (
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={handleCreateSuggested}
                  className="px-2 text-stratosort-blue hover:text-stratosort-indigo"
                  aria-label={`Create smart folder named ${suggestedNewFolder}`}
                >
                  Create
                </Button>
              )}
            </div>
          )}
        </div>
      ) : (
        <div className="p-4">
          <Text variant="small" className="text-system-red-600">
            Analysis failed - will be skipped
          </Text>
        </div>
      )}

      {/* Footer: Confidence + Actions */}
      {analysis && (
        <div className="mt-auto flex flex-wrap items-center justify-between gap-x-3 gap-y-2 px-4 py-3 bg-system-gray-50/50 border-t border-system-gray-100 rounded-b-xl">
          {/* Confidence */}
          {showConfidence ? (
            <div className="flex items-center gap-compact">
              <div className="flex items-center gap-1.5">
                <div
                  className={`w-2 h-2 rounded-full ${
                    computedConfidence >= 80
                      ? 'bg-stratosort-success'
                      : computedConfidence >= 50
                        ? 'bg-stratosort-warning'
                        : 'bg-system-gray-400'
                  }`}
                />
                <Text variant="tiny" className="font-medium text-system-gray-600">
                  {computedConfidence}% confidence
                </Text>
              </div>
              {/* Mini progress bar */}
              <div className="w-16 h-1.5 bg-system-gray-200 rounded-full overflow-hidden">
                <div
                  className={`h-full rounded-full transition-[width,background-color] ${
                    computedConfidence >= 80
                      ? 'bg-stratosort-success'
                      : computedConfidence >= 50
                        ? 'bg-stratosort-warning'
                        : 'bg-system-gray-400'
                  }`}
                  style={{ width: `${computedConfidence}%` }}
                />
              </div>
            </div>
          ) : (
            <div />
          )}

          {/* View Details Link */}
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={handleViewDetails}
            className="px-1 text-system-gray-500 hover:text-stratosort-blue"
            aria-label={`View analysis details for ${file.name}`}
          >
            <Info className="w-3.5 h-3.5" />
            Details
            <ChevronRight className="w-3 h-3" />
          </Button>
        </div>
      )}
    </Card>
  );
}

ReadyFileItem.propTypes = {
  file: PropTypes.object.isRequired,
  index: PropTypes.number.isRequired,
  isSelected: PropTypes.bool,
  onToggleSelected: PropTypes.func.isRequired,
  stateDisplay: PropTypes.object.isRequired,
  smartFolders: PropTypes.array,
  editing: PropTypes.object,
  onEdit: PropTypes.func.isRequired,
  category: PropTypes.string,
  routing: PropTypes.shape({
    folder: PropTypes.object,
    source: PropTypes.oneOf(['user', 'engine', 'name', 'none']),
    engine: PropTypes.object
  }),
  onViewDetails: PropTypes.func,
  onCreateSuggestedFolder: PropTypes.func
};

function areReadyFileItemPropsEqual(prev, next) {
  if (prev.onToggleSelected !== next.onToggleSelected) return false;
  if (prev.onEdit !== next.onEdit) return false;
  if (prev.onViewDetails !== next.onViewDetails) return false;
  if (prev.onCreateSuggestedFolder !== next.onCreateSuggestedFolder) return false;
  if (prev.index !== next.index) return false;
  if (prev.isSelected !== next.isSelected) return false;
  if (prev.category !== next.category) return false;
  if (prev.smartFolders !== next.smartFolders) return false;
  if (prev.routing?.source !== next.routing?.source) return false;
  if (prev.routing?.folder !== next.routing?.folder) return false;
  if (prev.routing?.engine !== next.routing?.engine) return false;

  const prevFile = prev.file;
  const nextFile = next.file;
  if (prevFile !== nextFile) {
    if (prevFile?.path !== nextFile?.path) return false;
    if (prevFile?.name !== nextFile?.name) return false;
    if (prevFile?.size !== nextFile?.size) return false;
    if (prevFile?.source !== nextFile?.source) return false;
    if (prevFile?.analysis !== nextFile?.analysis) return false;
    // suggestedNewFolder drives the inline "AI suggests a new smart folder"
    // chip. The reference-equality check above catches most updates because
    // the analyzer typically yields a fresh `analysis` object, but if a
    // future code path mutates analysis in place (e.g. a partial enrichment
    // pass) we want the chip to refresh — so deep-check the field too.
    if (prevFile?.analysis?.suggestedNewFolder !== nextFile?.analysis?.suggestedNewFolder)
      return false;
  }

  const prevEditing = prev.editing;
  const nextEditing = next.editing;
  if (prevEditing !== nextEditing) {
    if (prevEditing?.suggestedName !== nextEditing?.suggestedName) return false;
    if (prevEditing?.category !== nextEditing?.category) return false;
    if (prevEditing?.analysis !== nextEditing?.analysis) return false;
    if (prevEditing?.analysis?.suggestedNewFolder !== nextEditing?.analysis?.suggestedNewFolder)
      return false;
  }

  const prevState = prev.stateDisplay;
  const nextState = next.stateDisplay;
  if (prevState !== nextState) {
    if (prevState?.label !== nextState?.label) return false;
    if (prevState?.color !== nextState?.color) return false;
    if (prevState?.spinning !== nextState?.spinning) return false;
    if (prevState?.icon !== nextState?.icon) return false;
  }

  return true;
}

export default memo(ReadyFileItem, areReadyFileItemPropsEqual);
