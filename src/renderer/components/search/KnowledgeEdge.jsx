import React, { memo } from 'react';
import PropTypes from 'prop-types';
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from '@xyflow/react';
import BaseEdgeTooltip from './BaseEdgeTooltip';
import { useElkPath, useEdgeHover } from './useEdgeInteraction';
import { Text } from '../ui/Typography';

/**
 * KnowledgeEdge
 *
 * Edge component for knowledge graph relationships (co-occurrence).
 * Shows a tooltip with shared concepts and strength.
 */
const KnowledgeEdge = memo(
  ({
    id,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition = 'right',
    targetPosition = 'left',
    data = null,
    style,
    markerEnd
  }) => {
    const strokeColor = 'var(--color-stratosort-success)';
    const { isHovered, handleMouseEnter, handleMouseLeave } = useEdgeHover();
    const elkPath = useElkPath(data);
    const parallelOffset = Number(data?.parallelOffset || 0);

    const [smoothPath, labelX, labelY] = getSmoothStepPath({
      sourceX,
      sourceY: sourceY + parallelOffset,
      sourcePosition,
      targetX,
      targetY: targetY + parallelOffset,
      targetPosition,
      borderRadius: 16,
      centerX: (sourceX + targetX) / 2,
      centerY: (sourceY + targetY) / 2 + parallelOffset
    });

    const edgePath = elkPath || smoothPath;
    const weight = typeof data?.weight === 'number' ? data.weight : 0;
    // Support both `concepts` and `sharedTerms` field names from different edge sources
    const concepts = Array.isArray(data?.sharedTerms)
      ? data.sharedTerms
      : Array.isArray(data?.concepts)
        ? data.concepts
        : [];
    const sourceLabel = data?.sourceData?.label || '';
    const targetLabel = data?.targetData?.label || '';
    const tooltipsEnabled = data?.showEdgeTooltips !== false;

    const edgeStyle = {
      stroke: strokeColor,
      strokeWidth: isHovered ? 2.5 : 1.5,
      strokeDasharray: '4 4',
      opacity: isHovered ? 1 : 0.8,
      filter: isHovered ? `drop-shadow(0 0 4px ${strokeColor})` : 'none',
      transition: 'all 0.2s ease',
      strokeLinecap: 'round',
      strokeLinejoin: 'round',
      ...style
    };

    const conceptPreview = concepts.slice(0, 4);

    const showCompactBadge = !tooltipsEnabled;

    return (
      <>
        {tooltipsEnabled && (
          <path
            d={edgePath}
            fill="none"
            stroke="transparent"
            strokeWidth={20}
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
            style={{ cursor: 'pointer' }}
          />
        )}
        <BaseEdge id={id} path={edgePath} style={edgeStyle} markerEnd={markerEnd} />
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
              <span className="px-1.5 py-0.5 rounded-full border border-stratosort-success/30 bg-stratosort-success/10 font-medium whitespace-nowrap text-stratosort-success">
                ⟳ {weight}
              </span>
            </div>
          </EdgeLabelRenderer>
        )}
        {tooltipsEnabled && (
          <BaseEdgeTooltip
            isHovered={isHovered}
            labelX={labelX}
            labelY={labelY}
            badgeText="Knowledge"
            badgeColorClass="bg-stratosort-success/10 text-stratosort-success border border-stratosort-success/30"
            title="Why connected"
            headerColorClass="text-stratosort-success"
            onMouseEnter={handleMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
            <div className="flex items-center gap-compact">
              <span className="text-system-gray-500 shrink-0">Strength:</span>
              <div className="flex-1 flex items-center gap-1.5">
                <div className="flex-1 h-1.5 rounded-full bg-system-gray-100 overflow-hidden">
                  <div
                    className="h-full rounded-full bg-stratosort-success transition-[width] duration-300"
                    style={{ width: `${Math.min(100, Math.round((weight / 20) * 100))}%` }}
                  />
                </div>
                <span className="text-xs font-medium text-stratosort-success shrink-0 w-6 text-right">
                  {weight}
                </span>
              </div>
            </div>
            {conceptPreview.length > 0 ? (
              <div className="text-system-gray-600">
                Shared signals: {conceptPreview.join(', ')}
                {concepts.length > conceptPreview.length &&
                  ` +${concepts.length - conceptPreview.length} more`}
              </div>
            ) : (
              <div className="text-system-gray-500">Shared analysis metadata</div>
            )}
            {(sourceLabel || targetLabel) && (
              <Text
                as="div"
                variant="tiny"
                className="text-system-gray-500 pt-1 border-t border-system-gray-200"
              >
                {sourceLabel && <div>A: {sourceLabel.slice(0, 50)}</div>}
                {targetLabel && <div>B: {targetLabel.slice(0, 50)}</div>}
              </Text>
            )}
          </BaseEdgeTooltip>
        )}
      </>
    );
  }
);

KnowledgeEdge.displayName = 'KnowledgeEdge';

KnowledgeEdge.propTypes = {
  id: PropTypes.string.isRequired,
  sourceX: PropTypes.number.isRequired,
  sourceY: PropTypes.number.isRequired,
  targetX: PropTypes.number.isRequired,
  targetY: PropTypes.number.isRequired,
  sourcePosition: PropTypes.oneOf(['top', 'right', 'bottom', 'left']),
  targetPosition: PropTypes.oneOf(['top', 'right', 'bottom', 'left']),
  data: PropTypes.shape({
    weight: PropTypes.number,
    concepts: PropTypes.arrayOf(PropTypes.string),
    sharedTerms: PropTypes.arrayOf(PropTypes.string),
    showEdgeTooltips: PropTypes.bool,
    elkSections: PropTypes.arrayOf(
      PropTypes.shape({
        startPoint: PropTypes.shape({
          x: PropTypes.number,
          y: PropTypes.number
        }),
        endPoint: PropTypes.shape({
          x: PropTypes.number,
          y: PropTypes.number
        }),
        bendPoints: PropTypes.arrayOf(
          PropTypes.shape({
            x: PropTypes.number,
            y: PropTypes.number
          })
        )
      })
    ),
    sourceData: PropTypes.shape({
      label: PropTypes.string
    }),
    targetData: PropTypes.shape({
      label: PropTypes.string
    }),
    parallelOffset: PropTypes.number
  }),
  style: PropTypes.object,
  markerEnd: PropTypes.oneOfType([PropTypes.string, PropTypes.object])
};

export default KnowledgeEdge;
