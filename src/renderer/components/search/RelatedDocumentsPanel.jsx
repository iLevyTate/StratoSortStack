import React, { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import PropTypes from 'prop-types';
import { useSelector } from 'react-redux';
import { Link, Sparkles, Layers, X } from 'lucide-react';
import Button from '../ui/Button';
import { Heading, Text } from '../ui/Typography';
import FileIcon from '../ui/FileIcon';
import { useFileActions } from '../../hooks/useFileActions';
import { selectRedactPaths } from '../../store/selectors';
import { formatDisplayFileName, formatDisplayPath } from '../../utils/pathDisplay';
import { safeBasename } from '../../utils/pathUtils';
import { summarizeConnectionReasons } from '../../utils/graphUtils';
import { createLogger } from '../../../shared/logger';

const logger = createLogger('RelatedDocumentsPanel');

// Icon + color metadata per reason kind. The describing text now comes from
// the shared `summarizeConnectionReasons` helper so all three "why connected"
// surfaces (edge tooltip, bridge modal, this panel) read the same way.
const REASON_META = {
  shared_concepts: {
    label: 'Shared concepts',
    Icon: Sparkles,
    iconClass: 'text-stratosort-indigo'
  },
  content_similarity: {
    label: 'Similar content',
    Icon: Link,
    iconClass: 'text-stratosort-blue'
  },
  centroid_bridge: {
    label: 'Cluster bridge',
    Icon: Layers,
    iconClass: 'text-system-gray-500'
  }
};

/**
 * RelatedDocumentsPanel
 *
 * Right-rail panel that opens when a file node is selected. Lists up to
 * `limit` related documents with one-line "why" text sourced from the unified
 * edge model (shared_concepts / content_similarity / centroid_bridge). Clicking
 * a row fires `onFocusFile(neighborId)` so the parent can focus that node.
 */
export default function RelatedDocumentsPanel({
  isOpen,
  fileId,
  fileName,
  filePath,
  limit = 10,
  onClose,
  onFocusFile
}) {
  const [state, setState] = useState({
    loading: false,
    error: null,
    edges: [],
    files: {},
    seedId: null
  });
  const { openFile, revealFile } = useFileActions();
  const redactPaths = useSelector(selectRedactPaths);
  const loadRequestIdRef = useRef(0);

  const loadRelated = useCallback(async () => {
    if (!fileId || !isOpen) return;
    const requestId = ++loadRequestIdRef.current;
    setState((prev) => ({ ...prev, loading: true, error: null, seedId: fileId }));
    try {
      const api = window?.electronAPI?.knowledge?.getRelatedDocuments;
      if (typeof api !== 'function') {
        throw new Error('knowledge.getRelatedDocuments API is unavailable');
      }
      const result = await api(fileId, { limit });
      if (requestId !== loadRequestIdRef.current) {
        return;
      }
      if (!result?.success) {
        setState({
          loading: false,
          error: result?.error || 'Failed to load related documents',
          edges: [],
          files: {},
          seedId: fileId
        });
        return;
      }
      setState({
        loading: false,
        error: null,
        edges: Array.isArray(result.edges) ? result.edges : [],
        files: result.files && typeof result.files === 'object' ? result.files : {},
        seedId: fileId
      });
    } catch (err) {
      if (requestId !== loadRequestIdRef.current) {
        return;
      }
      logger.error('[RelatedDocumentsPanel] load failed', {
        fileId,
        error: err?.message
      });
      setState({
        loading: false,
        error: err?.message || 'Failed to load related documents',
        edges: [],
        files: {},
        seedId: fileId
      });
    }
  }, [fileId, isOpen, limit]);

  useEffect(() => {
    loadRelated();
  }, [loadRelated]);

  const rows = useMemo(() => {
    if (!state.seedId) return [];
    const seedName = fileName || safeBasename(filePath || '') || '';
    return state.edges.map((edge) => {
      const neighborId = edge.source === state.seedId ? edge.target : edge.source;
      const file = state.files[neighborId] || {};
      const reasons = Array.isArray(edge.reasons) && edge.reasons.length > 0 ? edge.reasons : [];
      const primary = reasons[0];
      const primaryMeta = REASON_META[primary?.kind] || null;
      const summary = summarizeConnectionReasons(reasons, {
        sourceLabel: seedName,
        targetLabel: file.fileName || safeBasename(file.filePath || '') || ''
      });
      return {
        edgeId: edge.id,
        neighborId,
        file,
        reasons,
        primary,
        primaryMeta,
        summary,
        weight: edge.weight || 0
      };
    });
  }, [state, fileName, filePath]);

  if (!isOpen) return null;

  const displaySeedName = formatDisplayFileName(fileName || safeBasename(filePath || ''), {
    redact: redactPaths
  });

  return (
    <aside
      className="flex flex-col h-full w-full max-w-sm border-l border-system-gray-200 shadow-lg"
      style={{ backgroundColor: 'var(--surface-raised)' }}
      aria-label="Related documents"
    >
      <header className="flex items-start gap-compact px-4 py-3 border-b border-system-gray-200 shrink-0">
        <div className="flex-1 min-w-0">
          <Heading as="h3" variant="h6" className="text-system-gray-800 truncate">
            Related documents
          </Heading>
          <Text variant="tiny" className="text-system-gray-500 truncate">
            {displaySeedName || 'No file selected'}
          </Text>
        </div>
        <Button
          size="xs"
          variant="ghost"
          onClick={onClose}
          title="Close"
          aria-label="Close related documents panel"
        >
          <X className="w-4 h-4" />
        </Button>
      </header>

      <div className="flex-1 min-h-0 overflow-y-auto">
        {state.loading && (
          <div className="p-4 text-system-gray-500">
            <Text variant="small">Loading related documents&hellip;</Text>
          </div>
        )}
        {state.error && !state.loading && (
          <div className="m-4 p-3 rounded-lg bg-stratosort-danger/10 border border-stratosort-danger/30">
            <Text variant="small" className="text-stratosort-danger">
              {state.error}
            </Text>
          </div>
        )}
        {!state.loading && !state.error && rows.length === 0 && (
          <div className="p-4 text-system-gray-400">
            <Text variant="small">
              No related documents found. Try running <strong>Rebuild relationships</strong> from
              Settings if this file was recently analyzed.
            </Text>
          </div>
        )}
        {!state.loading &&
          rows.map((row) => {
            const path = row.file.filePath || '';
            const name = row.file.fileName || safeBasename(path) || row.neighborId;
            const displayName = formatDisplayFileName(name, { redact: redactPaths });
            const displayPath = formatDisplayPath(path, { redact: redactPaths, segments: 2 });
            const PrimaryIcon = row.primaryMeta?.Icon;
            return (
              <button
                type="button"
                key={row.edgeId}
                onClick={() => onFocusFile?.(row.neighborId)}
                aria-label={`Focus related file in graph: ${displayName}`}
                className="w-full text-left px-4 py-3 border-b border-system-gray-100 hover:bg-system-gray-50 focus:bg-system-gray-50 focus:outline-none"
              >
                <div className="flex items-start gap-cozy">
                  <FileIcon filename={name} className="w-8 h-8 shrink-0 mt-0.5" />
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
                      </Text>
                    )}
                    <div className="mt-1 flex items-center gap-1 text-system-gray-600">
                      {PrimaryIcon && (
                        <PrimaryIcon
                          className={`w-3.5 h-3.5 shrink-0 ${row.primaryMeta?.iconClass || ''}`}
                        />
                      )}
                      <Text variant="tiny" className="truncate text-system-gray-700">
                        {row.summary.headline}
                      </Text>
                      {row.reasons.length > 1 && (
                        <Text
                          as="span"
                          variant="tiny"
                          className="shrink-0 inline-flex items-center px-1.5 py-0.5 rounded-md font-medium bg-system-gray-100 text-system-gray-600 border border-system-gray-200"
                          title={row.summary.details.join(' · ')}
                        >
                          +{row.reasons.length - 1}
                        </Text>
                      )}
                    </div>
                    {row.summary.details.length > 0 && (
                      <Text
                        as="div"
                        variant="tiny"
                        className="text-system-gray-400 mt-0.5 truncate"
                        title={row.summary.details.join(' · ')}
                      >
                        {row.summary.details.join(' · ')}
                      </Text>
                    )}
                  </div>
                  <div className="flex flex-col gap-1 shrink-0">
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (path) openFile(path);
                      }}
                      disabled={!path}
                      title="Open file"
                    >
                      Open
                    </Button>
                    <Button
                      size="xs"
                      variant="ghost"
                      onClick={(e) => {
                        e.stopPropagation();
                        if (path) revealFile(path);
                      }}
                      disabled={!path}
                      title="Reveal in folder"
                    >
                      Reveal
                    </Button>
                  </div>
                </div>
              </button>
            );
          })}
      </div>

      <footer className="px-4 py-2 border-t border-system-gray-200 text-system-gray-500 shrink-0">
        <Text variant="tiny">Signals: shared concepts, content similarity, cluster bridge.</Text>
      </footer>
    </aside>
  );
}

RelatedDocumentsPanel.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  fileId: PropTypes.string,
  fileName: PropTypes.string,
  filePath: PropTypes.string,
  limit: PropTypes.number,
  onClose: PropTypes.func.isRequired,
  onFocusFile: PropTypes.func
};
