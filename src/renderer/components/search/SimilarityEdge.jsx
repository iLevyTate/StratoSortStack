import React, { memo, useMemo } from 'react';
import { BaseEdge, getSmoothStepPath, EdgeLabelRenderer } from '@xyflow/react';
import PropTypes from 'prop-types';
import { Zap } from 'lucide-react';
import BaseEdgeTooltip from './BaseEdgeTooltip';
import { useElkPath, useEdgeHover, useGraphActions } from './useEdgeInteraction';
import { Text } from '../ui/Typography';
import { sanitizeGraphMetadataTerms, sanitizeSemanticTerms } from '../../utils/semanticTerms';
import { summarizeConnectionReasons } from '../../utils/graphUtils';

const EDGE_STROKES = Object.freeze({
  cross: 'var(--color-system-gray-500)',
  tag: 'var(--color-stratosort-blue)',
  category: 'var(--color-stratosort-indigo)',
  content: 'var(--color-stratosort-success)',
  similarity: 'var(--color-system-gray-400)'
});

/**
 * Custom edge component for similarity connections with hover tooltip
 * Shows common keywords, categories, and explanation on hover
 */
const SimilarityEdge = memo(
  ({
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    data,
    style,
    markerEnd
  }) => {
    const { isOpen, handleMouseEnter, handleMouseLeave, togglePin } = useEdgeHover();
    const { onGroupFiles } = useGraphActions();
    const elkPath = useElkPath(data);
    const parallelOffset = Number(data?.parallelOffset || 0);

    // Fallback to ReactFlow's path routing if ELK path is missing
    const [smoothPath, smoothLabelX, smoothLabelY] = getSmoothStepPath({
      sourceX,
      sourceY: sourceY + parallelOffset,
      sourcePosition,
      targetX,
      targetY: targetY + parallelOffset,
      targetPosition,
      borderRadius: 16, // Smoother corners
      centerX: (sourceX + targetX) / 2,
      centerY: (sourceY + targetY) / 2 + parallelOffset
    });

    const edgePath = elkPath || smoothPath;

    // For label position, if we have a custom path, we might want to calculate it more precisely
    // But for now, using the smooth step midpoint is a reasonable approximation
    const labelX = smoothLabelX;
    const labelY = smoothLabelY + parallelOffset;

    const isCrossCluster = data?.kind === 'cross_cluster';
    const tooltipsEnabled = data?.showEdgeTooltips !== false;

    // Phase 2 unified edge model: when an edge carries `reasons[]` from the
    // EdgeAggregator, use the dominant reason to drive styling and let the
    // tooltip list every signal that contributed. Wrapped in useMemo so
    // identity is stable across renders (the reasonsSummary memo depends on
    // it and would otherwise recompute on every frame).
    const reasons = useMemo(
      () => (Array.isArray(data?.reasons) ? data.reasons : []),
      [data?.reasons]
    );
    const dominantReason = reasons[0] || null;

    const topLevelSimilarity = data?.similarity ?? 0;
    const dominantSimilarity =
      dominantReason?.kind === 'content_similarity' || dominantReason?.kind === 'centroid_bridge'
        ? Number(dominantReason?.similarity) || 0
        : null;
    const effectiveSimilarity =
      dominantSimilarity != null && Number.isFinite(dominantSimilarity)
        ? dominantSimilarity
        : topLevelSimilarity;
    const similarityPercent = Math.max(
      0,
      Math.min(100, Math.round((Number(effectiveSimilarity) || 0) * 100))
    );
    // Plain-English headline + technical details, sourced from the shared
    // helper so BridgeAnalysisModal / RelatedDocumentsPanel see the same copy.
    const reasonSummary = useMemo(
      () =>
        summarizeConnectionReasons(reasons, {
          sourceLabel: data?.sourceData?.clusterLabel || data?.sourceData?.category || '',
          targetLabel: data?.targetData?.clusterLabel || data?.targetData?.category || '',
          bridgeCount: data?.bridgeCount
        }),
      [
        reasons,
        data?.sourceData?.clusterLabel,
        data?.sourceData?.category,
        data?.targetData?.clusterLabel,
        data?.targetData?.category,
        data?.bridgeCount
      ]
    );
    const reasonsSummary =
      reasonSummary.details.length > 0 ? reasonSummary.details.join(' · ') : null;

    // Source and target metadata from data
    const sourceData = data?.sourceData || {};
    const targetData = data?.targetData || {};
    const sharedTerms = useMemo(
      () => sanitizeSemanticTerms(data?.sharedTerms, { maxTerms: 4, minLength: 2 }),
      [data?.sharedTerms]
    );

    // Memoize derived values to prevent unnecessary re-renders
    // Use data?.sourceData?.tags directly to ensure stable dependency references
    const sourceTags = useMemo(
      () => sanitizeGraphMetadataTerms(data?.sourceData?.tags, { maxTerms: 12 }),
      [data?.sourceData?.tags]
    );
    const targetTags = useMemo(
      () => sanitizeGraphMetadataTerms(data?.targetData?.tags, { maxTerms: 12 }),
      [data?.targetData?.tags]
    );
    const commonTags = useMemo(() => {
      const targetSet = new Set(targetTags);
      return sourceTags.filter((tag) => targetSet.has(tag));
    }, [sourceTags, targetTags]);

    // Categories
    const sourceCategory = sourceData.category || '';
    const targetCategory = targetData.category || '';
    const sameCategory = sourceCategory && sourceCategory === targetCategory;

    // Subjects
    const sourceSubject = sourceData.subject || '';
    const targetSubject = targetData.subject || '';
    const hasSubjects = sourceSubject || targetSubject;

    // Count relationship signals for edge thickness
    const relationshipStrength =
      (sameCategory ? 1 : 0) + (commonTags.length > 0 ? 1 : 0) + (hasSubjects ? 0.5 : 0);

    // Build explanation text (useMemo since it computes a value, not a callback)
    const explanation = useMemo(() => {
      const parts = [];

      if (sameCategory) {
        parts.push(`Both "${sourceCategory}"`);
      }

      if (commonTags.length > 0) {
        const tagList = commonTags.slice(0, 2).join(', ');
        parts.push(`Tags: ${tagList}`);
      }

      if (similarityPercent >= 85) {
        parts.push('Nearly identical');
      } else if (similarityPercent >= 70) {
        parts.push('Strongly related');
      } else if (similarityPercent >= 55) {
        parts.push('Related content');
      } else {
        parts.push('Some similarity');
      }

      return parts.join(' • ');
    }, [sameCategory, sourceCategory, commonTags, similarityPercent]);

    // Determine primary relationship type and reason
    const {
      primaryType,
      labelText,
      strokeColor,
      showLabel: logicalShowLabel,
      badgeTitle
    } = useMemo(() => {
      // Phase 2: if the edge carries `reasons[]`, the dominant reason drives
      // the styling cascade. Every legacy fallback still runs when an edge
      // has no reasons.
      if (dominantReason) {
        switch (dominantReason.kind) {
          case 'shared_concepts': {
            const cs = Array.isArray(dominantReason.concepts)
              ? dominantReason.concepts.filter(Boolean)
              : [];
            return {
              primaryType: 'tag',
              labelText:
                cs.length > 0
                  ? cs.length > 1
                    ? `Shared: ${cs[0]} +${cs.length - 1}`
                    : `Shared: ${cs[0]}`
                  : 'Shared concepts',
              strokeColor: EDGE_STROKES.tag,
              showLabel: true,
              badgeTitle: reasonsSummary || 'Shared concepts'
            };
          }
          case 'content_similarity': {
            const simPct = Math.round((Number(dominantReason.similarity) || 0) * 100);
            return {
              primaryType: simPct >= 85 ? 'content' : 'similarity',
              labelText: simPct >= 85 ? 'Near identical' : `${simPct}% match`,
              strokeColor: simPct >= 85 ? EDGE_STROKES.content : EDGE_STROKES.similarity,
              showLabel: simPct >= 85,
              badgeTitle: reasonsSummary || 'Similar content'
            };
          }
          case 'centroid_bridge': {
            const ts = Array.isArray(dominantReason.sharedTerms)
              ? dominantReason.sharedTerms.filter(Boolean).slice(0, 2)
              : [];
            return {
              primaryType: 'cross',
              labelText: ts.length > 0 ? `Shared: ${ts.join(', ')}` : 'Cluster link',
              strokeColor: EDGE_STROKES.cross,
              showLabel: false,
              badgeTitle: reasonsSummary || 'Cluster bridge'
            };
          }
          default:
            // Fall through to legacy cascade
            break;
        }
      }

      if (isCrossCluster) {
        const bridgeTerms = sharedTerms.slice(0, 2);
        const bridgeFileCount = Math.max(0, Math.floor(Number(data?.bridgeCount) || 0));
        const bridgeLabel =
          bridgeFileCount > 0
            ? `${bridgeFileCount} linking file${bridgeFileCount === 1 ? '' : 's'}`
            : bridgeTerms.length > 0
              ? `Shared: ${bridgeTerms.join(', ')}`
              : 'Topic link';
        return {
          primaryType: 'cross',
          labelText: bridgeLabel,
          strokeColor: EDGE_STROKES.cross,
          showLabel: false,
          badgeTitle: bridgeFileCount > 0 ? 'Files that connect two topics' : 'Related topic groups'
        };
      }
      // 1. Shared Tags (Strongest logic)
      if (commonTags.length > 0) {
        const tagLabel = commonTags[0];
        return {
          primaryType: 'tag',
          labelText:
            commonTags.length > 1
              ? `Shared: ${tagLabel} +${commonTags.length - 1}`
              : `Shared: ${tagLabel}`,
          strokeColor: EDGE_STROKES.tag,
          showLabel: true,
          badgeTitle: 'Shared tags'
        };
      }

      // 2. Same Category (Structural logic)
      if (sameCategory && sourceCategory !== 'Uncategorized') {
        return {
          primaryType: 'category',
          labelText: `${sourceCategory}`,
          strokeColor: EDGE_STROKES.category,
          showLabel: true,
          badgeTitle: 'Same category'
        };
      }

      // 3. High Similarity (Content logic)
      if (similarityPercent >= 85) {
        return {
          primaryType: 'content',
          labelText: 'Near identical',
          strokeColor: EDGE_STROKES.content,
          showLabel: true,
          badgeTitle: 'High similarity'
        };
      }

      // 4. Moderate Similarity (Fuzzy logic)
      return {
        primaryType: 'similarity',
        labelText: `${similarityPercent}% Match`,
        strokeColor: EDGE_STROKES.similarity,
        showLabel: false, // Hide label for weak/generic connections to reduce clutter
        badgeTitle: 'Similarity'
      };
    }, [
      commonTags,
      sameCategory,
      sourceCategory,
      similarityPercent,
      data?.bridgeCount,
      sharedTerms,
      isCrossCluster,
      dominantReason,
      reasonsSummary
    ]);

    // Apply user preference for label visibility
    // Default to true if not specified (legacy behavior)
    const showLabel = logicalShowLabel && (data?.showEdgeLabels ?? true);

    // Dynamic styling based on hover/pinned and relationship strength
    const baseWidth = 1 + relationshipStrength * 0.5;
    const restingOpacity =
      primaryType === 'cross' ? 0.45 : primaryType === 'similarity' ? 0.6 : 0.8;
    const edgeStyle = {
      ...style,
      stroke: strokeColor,
      strokeWidth: isOpen ? 2.5 : baseWidth,
      strokeDasharray: primaryType === 'similarity' || primaryType === 'cross' ? '4 4' : 'none', // Dash only purely similar edges
      opacity: isOpen ? 1 : restingOpacity,
      filter: isOpen ? `drop-shadow(0 0 4px ${strokeColor})` : 'none',
      transition: 'all 0.2s ease',
      strokeLinecap: 'round',
      strokeLinejoin: 'round'
    };

    const compactLabelText =
      primaryType === 'cross'
        ? `Bridge ${similarityPercent}%`
        : primaryType === 'tag'
          ? `Tag ${similarityPercent}%`
          : primaryType === 'category'
            ? `${sourceCategory || 'Category'}`
            : `${similarityPercent}%`;
    const showCompactBadge =
      !tooltipsEnabled &&
      !isCrossCluster &&
      (commonTags.length > 0 || sameCategory || similarityPercent >= 65);
    const isSurpriseEdge = data?.isSurprise === true;

    return (
      <>
        {/* Invisible wider path for easier hovering / click-to-pin */}
        {tooltipsEnabled && (
          <path
            d={edgePath}
            fill="none"
            stroke="transparent"
            strokeWidth={20}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            onClick={(e) => {
              e.stopPropagation();
              togglePin();
            }}
            style={{ cursor: 'pointer' }}
            role="img"
            aria-label={
              isCrossCluster
                ? data?.bridgeCount > 0
                  ? `${data.bridgeCount} files link two topic groups, ${similarityPercent}% topic overlap`
                  : `Topic bridge between clusters, ${similarityPercent}% similarity`
                : commonTags.length > 0
                  ? `Shared concepts (${commonTags.slice(0, 3).join(', ')}), ${similarityPercent}% similarity`
                  : sameCategory
                    ? `Same category, ${similarityPercent}% content similarity`
                    : `${similarityPercent}% content similarity`
            }
          />
        )}

        {/* Visible edge */}
        <BaseEdge id={id} path={edgePath} style={edgeStyle} markerEnd={markerEnd} />

        {/* Lightweight fallback badge for large graphs */}
        {showCompactBadge && (
          <EdgeLabelRenderer>
            <div
              style={{
                position: 'absolute',
                transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
                fontSize: 10,
                pointerEvents: 'none',
                zIndex: 6
              }}
              className="nodrag nopan"
            >
              <span className="px-1.5 py-0.5 rounded-full bg-system-gray-100 text-system-gray-700 border border-system-gray-200 font-medium whitespace-nowrap">
                {compactLabelText}
              </span>
            </div>
          </EdgeLabelRenderer>
        )}

        {/* Surprise badge for high-similarity, distant-folder connections */}
        {isSurpriseEdge && showLabel && (
          <EdgeLabelRenderer>
            <div
              style={{
                position: 'absolute',
                transform: `translate(-50%, -50%) translate(${labelX + 20}px,${labelY - 16}px)`,
                pointerEvents: 'none',
                zIndex: 11
              }}
              className="nodrag nopan"
            >
              <span className="inline-flex items-center gap-1 rounded-full border border-stratosort-accent/30 bg-stratosort-accent/10 px-1.5 py-0.5 text-xs font-medium text-stratosort-accent">
                <Zap className="h-2.5 w-2.5" />
                Surprise
              </span>
            </div>
          </EdgeLabelRenderer>
        )}

        {/* Persistent Verbal Label (only for strong connections) */}
        {showLabel && (
          <EdgeLabelRenderer>
            <div
              style={{
                position: 'absolute',
                transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
                fontSize: 10,
                pointerEvents: 'all',
                zIndex: 10
              }}
              className="nodrag nopan"
            >
              {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- graph-canvas pointer affordance; keyboard path tracked as U-T14 */}
              <div
                className={`
                  px-2 py-0.5 rounded-full border shadow-sm font-medium whitespace-nowrap transition-transform duration-200
                  ${isOpen ? 'scale-110 z-20' : 'scale-100'}
                  ${
                    primaryType === 'tag'
                      ? 'bg-stratosort-blue/10 border-stratosort-blue/30 text-stratosort-blue'
                      : primaryType === 'category'
                        ? 'bg-stratosort-purple/10 border-stratosort-purple/30 text-stratosort-purple'
                        : primaryType === 'content'
                          ? 'bg-stratosort-success/10 border-stratosort-success/30 text-stratosort-success'
                          : 'bg-system-gray-100 border-system-gray-200 text-system-gray-500'
                  }
                `}
                onMouseEnter={tooltipsEnabled ? handleMouseEnter : undefined}
                onMouseLeave={tooltipsEnabled ? handleMouseLeave : undefined}
              >
                {labelText}
              </div>
            </div>
          </EdgeLabelRenderer>
        )}

        {/* Edge label and tooltip */}
        {tooltipsEnabled && (
          <BaseEdgeTooltip
            isHovered={isOpen}
            onToggle={togglePin}
            labelX={labelX}
            labelY={labelY}
            badgeText={labelText}
            badgeColorClass={
              primaryType === 'tag'
                ? 'bg-stratosort-blue/10 text-stratosort-blue border border-stratosort-blue/30'
                : primaryType === 'category'
                  ? 'bg-stratosort-purple/10 text-stratosort-purple border border-stratosort-purple/30'
                  : primaryType === 'content'
                    ? 'bg-stratosort-success/10 border border-stratosort-success/30 text-stratosort-success'
                    : primaryType === 'cross'
                      ? 'bg-system-gray-50 text-system-gray-700 border border-system-gray-200'
                      : 'bg-system-gray-100 text-system-gray-500 border border-system-gray-200'
            }
            title={badgeTitle || (primaryType === 'cross' ? 'Topic bridge' : 'Content similarity')}
            headerColorClass={
              primaryType === 'tag'
                ? 'text-stratosort-blue'
                : primaryType === 'category'
                  ? 'text-stratosort-purple'
                  : primaryType === 'cross'
                    ? 'text-system-gray-600'
                    : 'text-stratosort-success'
            }
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            {!isCrossCluster ? (
              <>
                <Text
                  as="div"
                  variant="tiny"
                  className="text-system-gray-800 font-medium leading-snug"
                >
                  {reasonSummary.headline}
                </Text>
                <div className="flex items-center gap-compact">
                  <span className="text-system-gray-500">Similarity:</span>
                  <span className="font-medium text-stratosort-success">{similarityPercent}%</span>
                  <div className="flex-1 h-1.5 bg-system-gray-200 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-stratosort-success rounded-full"
                      style={{ width: `${similarityPercent}%` }}
                    />
                  </div>
                </div>

                {commonTags.length > 0 && (
                  <div>
                    <span className="text-system-gray-500">Common tags: </span>
                    <span className="text-stratosort-blue">
                      {commonTags.slice(0, 4).join(', ')}
                      {commonTags.length > 4 && ` +${commonTags.length - 4} more`}
                    </span>
                  </div>
                )}

                {sameCategory && (
                  <div>
                    <span className="text-system-gray-500">Category: </span>
                    <span className="text-stratosort-purple">{sourceCategory}</span>
                  </div>
                )}

                {hasSubjects && (
                  <div className="space-y-0.5">
                    {sourceSubject && (
                      <Text as="div" variant="tiny">
                        <span className="text-system-gray-500">A: </span>
                        <span className="text-stratosort-accent truncate">
                          {sourceSubject.slice(0, 40)}
                        </span>
                      </Text>
                    )}
                    {targetSubject && (
                      <Text as="div" variant="tiny">
                        <span className="text-system-gray-500">B: </span>
                        <span className="text-stratosort-accent truncate">
                          {targetSubject.slice(0, 40)}
                        </span>
                      </Text>
                    )}
                  </div>
                )}

                <Text
                  as="div"
                  variant="tiny"
                  className="text-system-gray-500 italic pt-1 border-t border-system-gray-200"
                >
                  {explanation}
                </Text>
              </>
            ) : (
              <>
                <Text
                  as="div"
                  variant="tiny"
                  className="text-system-gray-800 font-medium leading-snug"
                >
                  {reasonSummary.headline}
                </Text>
                <Text as="div" variant="tiny" className="text-system-gray-500 leading-snug">
                  {data?.bridgeCount > 0
                    ? 'These documents sit in both topic groups — handy for shared clients, projects, or cross-folder duplicates.'
                    : 'These topic groups overlap by meaning, even when no single file spans both.'}
                </Text>
                <div className="flex items-center gap-compact">
                  <span className="text-system-gray-500">Topic overlap:</span>
                  <span className="font-medium text-system-gray-700">{similarityPercent}%</span>
                </div>
                {sharedTerms.length > 0 && (
                  <Text as="div" variant="tiny" className="text-system-gray-600">
                    Shared themes: {sharedTerms.join(', ')}
                  </Text>
                )}
                {data?.bridgeCount > 0 && (
                  <Text as="div" variant="tiny" className="text-system-gray-600">
                    Linking files: {data.bridgeCount}
                  </Text>
                )}
              </>
            )}
            {/* Primary verb: every edge tooltip ends with a one-click "do
                something with this connection" action. Reads source/target
                file IDs straight off the edge data; the `onGroupFiles`
                callback (from GraphActionsContext) handles the folder
                picker + move flow. Hidden when the context provider isn't
                mounted (e.g., legacy harnesses) or when the edge has no
                concrete file endpoints (cluster centroids). */}
            {typeof onGroupFiles === 'function' &&
              (() => {
                const sourceId = data?.sourceData?.id || null;
                const targetId = data?.targetData?.id || null;
                const ids = [sourceId, targetId].filter(Boolean);
                if (ids.length < 2) return null;
                return (
                  <div className="pt-1 border-t border-system-gray-200">
                    <button
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        onGroupFiles(ids);
                      }}
                      className="w-full rounded-md bg-stratosort-blue px-2 py-1 text-xs font-semibold text-white shadow-sm hover:bg-stratosort-blue/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-stratosort-blue/40"
                    >
                      Group both into a folder →
                    </button>
                  </div>
                );
              })()}
          </BaseEdgeTooltip>
        )}
      </>
    );
  }
);

SimilarityEdge.displayName = 'SimilarityEdge';

SimilarityEdge.propTypes = {
  id: PropTypes.string.isRequired,
  sourceX: PropTypes.number.isRequired,
  sourceY: PropTypes.number.isRequired,
  targetX: PropTypes.number.isRequired,
  targetY: PropTypes.number.isRequired,
  sourcePosition: PropTypes.oneOf(['top', 'right', 'bottom', 'left']),
  targetPosition: PropTypes.oneOf(['top', 'right', 'bottom', 'left']),
  data: PropTypes.shape({
    similarity: PropTypes.number,
    showEdgeLabels: PropTypes.bool,
    showEdgeTooltips: PropTypes.bool,
    sourceData: PropTypes.shape({
      label: PropTypes.string,
      tags: PropTypes.arrayOf(PropTypes.string),
      category: PropTypes.string,
      subject: PropTypes.string
    }),
    targetData: PropTypes.shape({
      label: PropTypes.string,
      tags: PropTypes.arrayOf(PropTypes.string),
      category: PropTypes.string,
      subject: PropTypes.string
    }),
    isSurprise: PropTypes.bool,
    parallelOffset: PropTypes.number
  }),
  style: PropTypes.object,
  markerEnd: PropTypes.oneOfType([PropTypes.string, PropTypes.object])
};

export default SimilarityEdge;
