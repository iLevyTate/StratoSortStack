import React, { memo } from 'react';
import PropTypes from 'prop-types';
import { BaseEdge, getSmoothStepPath, EdgeLabelRenderer } from '@xyflow/react';
import { useElkPath } from './useEdgeInteraction';

/**
 * SmartStepEdge
 *
 * A custom edge component that uses smooth step pathing.
 * This provides cleaner orthogonal routing compared to default bezier curves,
 * especially for the hierarchical layout used in the graph.
 */
const SmartStepEdge = ({
  id: _id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  style = {},
  markerEnd,
  label = null,
  data
}) => {
  // Prefer ELK-routed path if available for collision avoidance
  const elkPath = useElkPath(data);
  const parallelOffset = Number(data?.parallelOffset || 0);

  const [smoothPath, smoothLabelX, smoothLabelY] = getSmoothStepPath({
    sourceX,
    sourceY: sourceY + parallelOffset,
    sourcePosition,
    targetX,
    targetY: targetY + parallelOffset,
    targetPosition,
    borderRadius: 16, // Increased border radius for smoother corners
    offset: 20 // Offset for the path to avoid hugging nodes too closely
  });

  const edgePath = elkPath || smoothPath;
  const labelX = smoothLabelX;
  const labelY = smoothLabelY + parallelOffset;
  const edgeStyle = {
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    ...style
  };

  return (
    <>
      <BaseEdge path={edgePath} markerEnd={markerEnd} style={edgeStyle} />
      {label && (
        <EdgeLabelRenderer>
          <div
            style={{
              position: 'absolute',
              transform: `translate(-50%, -50%) translate(${labelX}px,${labelY}px)`,
              fontSize: 10,
              pointerEvents: 'none',
              zIndex: 10
            }}
            className="nodrag nopan"
          >
            {/* Neutral chip tokens shared with SimilarityEdge/QueryMatchEdge —
                theme-scoped, unlike the previous hardcoded white. */}
            <span className="px-1.5 py-0.5 rounded-full bg-system-gray-100 text-system-gray-700 border border-system-gray-200 font-medium whitespace-nowrap">
              {label}
            </span>
          </div>
        </EdgeLabelRenderer>
      )}
    </>
  );
};

SmartStepEdge.propTypes = {
  id: PropTypes.string.isRequired,
  sourceX: PropTypes.number.isRequired,
  sourceY: PropTypes.number.isRequired,
  targetX: PropTypes.number.isRequired,
  targetY: PropTypes.number.isRequired,
  sourcePosition: PropTypes.string,
  targetPosition: PropTypes.string,
  style: PropTypes.object,
  markerEnd: PropTypes.oneOfType([PropTypes.string, PropTypes.object]),
  label: PropTypes.node,
  data: PropTypes.shape({
    parallelOffset: PropTypes.number,
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
    )
  })
};

export default memo(SmartStepEdge);
