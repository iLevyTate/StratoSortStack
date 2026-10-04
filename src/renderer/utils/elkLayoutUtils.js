// @ts-check
/**
 * Pure layout utilities for elkLayout - no ELK dependency, no import.meta.
 * Extracted for testability (Jest cannot load elkLayout.js due to import.meta.url).
 *
 * @module renderer/utils/elkLayoutUtils
 */

export const NODE_SIZES = {
  queryNode: { width: 240, height: 92 },
  fileNode: { width: 240, height: 124 },
  folderNode: { width: 240, height: 96 },
  clusterNode: { width: 190, height: 190 },
  default: { width: 230, height: 110 }
};

/**
 * Calculate bounding box of nodes for fitView
 *
 * @param {any[]} nodes - ReactFlow nodes
 * @returns {Record<string, number>} Bounding box { minX, minY, maxX, maxY, width, height }
 */
export function getLayoutBounds(nodes) {
  if (!nodes || nodes.length === 0) {
    return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  nodes.forEach((/** @type {any} */ node) => {
    const pos = node.position || { x: 0, y: 0 };
    const size = /** @type {Record<string, any>} */ (NODE_SIZES)[node.type] || NODE_SIZES.default;

    minX = Math.min(minX, pos.x);
    minY = Math.min(minY, pos.y);
    maxX = Math.max(maxX, pos.x + size.width);
    maxY = Math.max(maxY, pos.y + size.height);
  });

  return {
    minX,
    minY,
    maxX,
    maxY,
    width: maxX - minX,
    height: maxY - minY
  };
}

/**
 * Layout nodes in a radial pattern around a center node
 *
 * @param {any} centerNode - The center node (optional if options.centerX/Y provided)
 * @param {any[]} nodes - Nodes to arrange around center
 * @param {{ radius?: number, startAngle?: number, endAngle?: number, centerX?: number, centerY?: number }} [options]
 * @returns {any[]} Positioned nodes
 */
export function radialLayout(centerNode, nodes, options = {}) {
  const { radius = 200, startAngle = 0, endAngle = 2 * Math.PI, centerX, centerY } = options;

  if (!nodes || nodes.length === 0) {
    return [];
  }

  let cX = centerX;
  let cY = centerY;

  if (centerNode && centerNode.position) {
    cX = centerNode.position.x;
    cY = centerNode.position.y;
  } else if (cX === undefined || cY === undefined) {
    cX = 0;
    cY = 0;
  }

  const totalAngle = endAngle - startAngle;
  const isFullCircle = Math.abs(Math.abs(totalAngle) - 2 * Math.PI) < 0.01;
  const count = nodes.length;
  const angleStep = count <= 1 ? 0 : isFullCircle ? totalAngle / count : totalAngle / (count - 1);

  return nodes.map((node, index) => {
    const angle = startAngle + index * angleStep;
    return {
      ...node,
      position: {
        x: cX + radius * Math.cos(angle),
        y: cY + radius * Math.sin(angle)
      }
    };
  });
}
