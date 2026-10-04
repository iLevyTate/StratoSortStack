import React, { useState, useMemo, useEffect } from 'react';
import PropTypes from 'prop-types';
import { Network, ArrowRight, FileText } from 'lucide-react';
import Modal from '../ui/Modal';
import Button from '../ui/Button';
import { Heading, Text } from '../ui/Typography';
import FileIcon from '../ui/FileIcon';
import { useFileActions } from '../../hooks/useFileActions';
import { safeBasename } from '../../utils/pathUtils';
import { summarizeConnectionReasons } from '../../utils/graphUtils';

const resolveBridgePath = (file) => {
  if (!file || typeof file !== 'object') return '';
  const directPath =
    typeof file.path === 'string' && file.path.trim()
      ? file.path.trim()
      : typeof file.filePath === 'string' && file.filePath.trim()
        ? file.filePath.trim()
        : '';
  if (directPath) return directPath;

  const id = typeof file.id === 'string' ? file.id.trim() : '';
  if (!id) return '';
  const stripped = id.replace(/^(file|image):/i, '').trim();
  if (!stripped) return '';
  return /^[A-Za-z]:[\\/]/.test(stripped) || stripped.startsWith('/') || /[\\/]/.test(stripped)
    ? stripped
    : '';
};

const resolveBridgeName = (file, resolvedPath) =>
  (typeof file?.name === 'string' && file.name.trim()) ||
  (typeof file?.fileName === 'string' && file.fileName.trim()) ||
  safeBasename(resolvedPath || '') ||
  safeBasename(String(file?.id || '')) ||
  'Indexed file';

/**
 * BridgeAnalysisModal
 *
 * A modal for analyzing bridge connections between clusters.
 * Shows a list of bridges and the files that create them.
 */
export default function BridgeAnalysisModal({
  isOpen,
  onClose,
  bridges = [], // Array of edges with data.kind === 'cross_cluster'
  clusters = [], // Array of cluster nodes
  onGroupFiles = null // (fileIds[]) => void — primary "Group bridge files" verb
}) {
  const { openFile, revealFile } = useFileActions();
  const [selectedBridgeId, setSelectedBridgeId] = useState(null);

  // Map cluster ID to cluster node for quick lookup
  const clusterMap = useMemo(() => {
    return new Map(clusters.map((c) => [c.id, c]));
  }, [clusters]);

  // Enrich bridges with cluster names. Phase 2: centroid-only bridges (those
  // with an empty bridgeFiles list) are no longer filtered out — they render
  // with dedicated copy explaining that the connection is topical rather than
  // file-level. Users can still see which cluster pairs are semantically
  // close even when no single document spans them.
  const enrichedBridges = useMemo(() => {
    return bridges.map((bridge) => {
      const source = clusterMap.get(bridge.source);
      const target = clusterMap.get(bridge.target);
      const files = bridge.data?.bridgeFiles || [];
      const sourceLabel = source?.data?.label || 'Unknown cluster';
      const targetLabel = target?.data?.label || 'Unknown cluster';
      const reasons = Array.isArray(bridge.data?.reasons) ? bridge.data.reasons : [];
      // Synthesize a centroid_bridge reason from the existing edge data when
      // the edge didn't ship explicit reasons[] — cross_cluster edges from
      // ClusteringService carry similarity + sharedTerms on data directly,
      // so the summarizer should still produce a sensible headline.
      const effectiveReasons =
        reasons.length > 0
          ? reasons
          : [
              {
                kind: 'centroid_bridge',
                similarity: Number(bridge.data?.similarity) || 0,
                sharedTerms: Array.isArray(bridge.data?.sharedTerms)
                  ? bridge.data.sharedTerms.filter(Boolean)
                  : [],
                clusters: [sourceLabel, targetLabel]
              }
            ];
      const summary = summarizeConnectionReasons(effectiveReasons, {
        sourceLabel,
        targetLabel,
        bridgeCount: files.length
      });
      return {
        ...bridge,
        sourceLabel,
        targetLabel,
        bridgeFiles: files,
        centroidOnly: files.length === 0,
        summary
      };
    });
  }, [bridges, clusterMap]);

  // Reset selection when the bridge set changes so a stale selectedBridgeId from
  // a previous cluster computation can't accidentally pin the highlight to a
  // removed (or coincidentally same-id, semantically different) bridge. Without
  // this, the useMemo below would silently fall back to enrichedBridges[0]
  // while leaving the stale id in state — masking an actual mismatch in DevTools.
  useEffect(() => {
    if (!selectedBridgeId) return;
    if (!enrichedBridges.some((b) => b.id === selectedBridgeId)) {
      setSelectedBridgeId(null);
    }
  }, [enrichedBridges, selectedBridgeId]);

  const selectedBridge = useMemo(() => {
    return enrichedBridges.find((b) => b.id === selectedBridgeId) || enrichedBridges[0];
  }, [enrichedBridges, selectedBridgeId]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Bridge analysis"
      description="Explore how your topic clusters are connected."
      size="xl"
    >
      <div className="flex h-[60vh] gap-relaxed">
        {/* Sidebar: List of Bridges */}
        <div className="w-1/3 border-r border-system-gray-100 pr-4 overflow-y-auto">
          <Heading as="h4" variant="h6" className="mb-3 text-system-gray-700">
            Connections ({enrichedBridges.length})
          </Heading>
          <div className="space-y-2">
            {enrichedBridges.map((bridge) => (
              <div
                key={bridge.id}
                className={`
                  p-3 rounded-lg cursor-pointer transition-colors border
                  ${
                    selectedBridge?.id === bridge.id
                      ? 'bg-stratosort-blue/5 border-stratosort-blue/20'
                      : 'bg-system-gray-100 border-transparent hover:bg-system-gray-50'
                  }
                `}
                role="button"
                tabIndex={0}
                aria-pressed={selectedBridge?.id === bridge.id}
                onClick={() => setSelectedBridgeId(bridge.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    setSelectedBridgeId(bridge.id);
                  }
                }}
              >
                <div className="flex items-center gap-compact">
                  <Text
                    as="span"
                    variant="small"
                    className="font-medium text-system-gray-900 truncate max-w-[45%]"
                  >
                    {bridge.sourceLabel}
                  </Text>
                  <ArrowRight className="w-3 h-3 text-system-gray-400 shrink-0" />
                  <Text
                    as="span"
                    variant="small"
                    className="font-medium text-system-gray-900 truncate max-w-[45%]"
                  >
                    {bridge.targetLabel}
                  </Text>
                </div>
                <Text variant="tiny" className="mt-1">
                  {bridge.centroidOnly
                    ? 'Topic overlap (no bridging files)'
                    : `${bridge.bridgeFiles.length} connecting file${bridge.bridgeFiles.length !== 1 ? 's' : ''}`}
                </Text>
              </div>
            ))}
            {enrichedBridges.length === 0 && (
              <div className="text-center py-8 text-system-gray-400">
                <Network className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <Text variant="small">No bridges found.</Text>
              </div>
            )}
          </div>
        </div>

        {/* Main Content: Selected Bridge Details */}
        <div className="flex-1 overflow-y-auto pl-2">
          {selectedBridge ? (
            <div className="space-y-6">
              {/* Header */}
              <div className="flex items-center justify-between flex-wrap gap-cozy">
                <div className="flex items-center gap-cozy">
                  <Text
                    as="span"
                    variant="small"
                    className="px-3 py-1 bg-stratosort-indigo/10 text-stratosort-indigo rounded-full font-medium"
                  >
                    {selectedBridge.sourceLabel}
                  </Text>
                  <ArrowRight className="w-5 h-5 text-system-gray-400" />
                  <Text
                    as="span"
                    variant="small"
                    className="px-3 py-1 bg-stratosort-purple/10 text-stratosort-purple rounded-full font-medium"
                  >
                    {selectedBridge.targetLabel}
                  </Text>
                </div>
                {typeof onGroupFiles === 'function' && (
                  <Button
                    variant="primary"
                    size="sm"
                    disabled={
                      selectedBridge.centroidOnly || selectedBridge.bridgeFiles.length === 0
                    }
                    title={
                      selectedBridge.centroidOnly
                        ? 'No concrete files to move — this bridge is a topical overlap only.'
                        : `Move ${selectedBridge.bridgeFiles.length} bridge file${selectedBridge.bridgeFiles.length === 1 ? '' : 's'} into a folder of your choice.`
                    }
                    onClick={() =>
                      onGroupFiles(selectedBridge.bridgeFiles.map((f) => f?.id).filter(Boolean), {
                        source: 'bridge_modal'
                      })
                    }
                  >
                    Group these {selectedBridge.bridgeFiles.length} file
                    {selectedBridge.bridgeFiles.length === 1 ? '' : 's'} into a folder
                  </Button>
                )}
              </div>

              {/* Narrative */}
              <div className="bg-system-gray-50 p-4 rounded-xl border border-system-gray-100">
                <Heading as="h5" variant="h6" className="mb-2 text-system-gray-900">
                  Why are they connected?
                </Heading>
                <Text className="text-system-gray-800 font-medium">
                  {selectedBridge.summary.headline}.
                </Text>
                <Text variant="small" className="text-system-gray-600 mt-1">
                  {selectedBridge.centroidOnly
                    ? `The clusters ${selectedBridge.sourceLabel} and ${selectedBridge.targetLabel} are semantically close, but no single document spans them.`
                    : `${selectedBridge.bridgeFiles.length} document${selectedBridge.bridgeFiles.length === 1 ? '' : 's'} below ${selectedBridge.bridgeFiles.length === 1 ? 'spans' : 'span'} both clusters.`}
                </Text>
                {selectedBridge.summary.details.length > 0 && (
                  <ul className="mt-2 list-disc list-inside text-system-gray-500 space-y-0.5">
                    {selectedBridge.summary.details.map((line, i) => (
                      <li key={i}>
                        <Text as="span" variant="tiny" className="text-system-gray-500">
                          {line}
                        </Text>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              {/* Bridge Files */}
              <div>
                <Heading
                  as="h5"
                  variant="h6"
                  className="mb-3 text-system-gray-900 flex items-center gap-compact"
                >
                  <FileText className="w-4 h-4 text-system-gray-500" />
                  Connecting documents
                </Heading>
                {selectedBridge.centroidOnly && (
                  <Text variant="small" className="text-system-gray-500 mb-2">
                    This bridge was inferred from cluster centroids only. Re-analyze individual
                    files to surface concrete connectors.
                  </Text>
                )}
                <div className="space-y-2">
                  {selectedBridge.bridgeFiles.map((file, index) => {
                    const path = resolveBridgePath(file);
                    const name = resolveBridgeName(file, path);
                    const key = file?.id || path || `bridge-file-${index}`;
                    return (
                      <div
                        key={key}
                        className="group flex items-center gap-cozy rounded-lg border border-border-soft bg-system-gray-100/90 p-3 transition-colors hover:border-stratosort-blue/20"
                      >
                        <FileIcon fileName={name} className="w-8 h-8 shrink-0" />
                        <div className="flex-1 min-w-0">
                          <Text
                            variant="small"
                            className="font-medium text-system-gray-900 truncate"
                          >
                            {name}
                          </Text>
                          <Text variant="tiny" className="truncate">
                            {path || 'Indexed in knowledge base (path unavailable)'}
                          </Text>
                        </div>
                        {path && (
                          <div className="flex gap-1 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
                            <Button size="xs" variant="ghost" onClick={() => openFile(path)}>
                              Open
                            </Button>
                            <Button size="xs" variant="ghost" onClick={() => revealFile(path)}>
                              Reveal
                            </Button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-full text-system-gray-400">
              <Text>Select a connection to view details.</Text>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}

BridgeAnalysisModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  bridges: PropTypes.array,
  clusters: PropTypes.array,
  onGroupFiles: PropTypes.func
};
