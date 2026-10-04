// @ts-check
/**
 * useEdgeInteraction
 *
 * Shared hooks and utilities for ReactFlow edge components.
 * Consolidates the ELK path calculation and hover interaction logic
 * that was previously duplicated across KnowledgeEdge, SimilarityEdge,
 * QueryMatchEdge, and SmartStepEdge.
 *
 * @module search/useEdgeInteraction
 */

import React, { useState, useCallback, useContext, useMemo } from 'react';

/**
 * Context for graph-level actions that need to be callable from deep inside
 * ReactFlow edge / node components without prop-drilling through ReactFlow's
 * `nodeTypes` / `edgeTypes` registration. Today it only carries one action:
 *
 *   onGroupFiles(fileIds: string[]): void | Promise<void>
 *
 * which prompts the user for a destination folder and moves the given files
 * there (the canonical "Group into folder" verb surfaced everywhere in the
 * graph view). The provider lives in UnifiedSearchModal.
 */
export const GraphActionsContext = React.createContext({
  onGroupFiles: null
});

export function useGraphActions() {
  return useContext(GraphActionsContext);
}

const isValidSection = (/** @type {any} */ s) =>
  Boolean(
    s?.startPoint &&
    s?.endPoint &&
    typeof s.startPoint.x === 'number' &&
    typeof s.startPoint.y === 'number' &&
    typeof s.endPoint.x === 'number' &&
    typeof s.endPoint.y === 'number'
  );

/**
 * Build an SVG path string from ELK-routed edge sections.
 * Returns null if no valid sections are provided, signalling
 * the caller should fall back to ReactFlow's built-in pathing.
 *
 * @param {any[]|null|undefined} elkSections - ELK edge sections from layout
 * @param {number} parallelOffset - Perpendicular pixel offset for multi-edges
 * @returns {string|null} SVG path string or null
 */
export function buildElkPath(elkSections, parallelOffset = 0) {
  if (!elkSections || elkSections.length === 0) return null;

  const validSections = elkSections.filter(isValidSection);
  if (validSections.length === 0) return null;

  // Shift all ELK points along a single edge-normal so parallel relations do not
  // render directly on top of each other for the same source/target pair.
  const firstSection = validSections[0];
  const lastSection = validSections[validSections.length - 1];
  const dx = lastSection.endPoint.x - firstSection.startPoint.x;
  const dy = lastSection.endPoint.y - firstSection.startPoint.y;
  const length = Math.hypot(dx, dy) || 1;
  const normalX = -dy / length;
  const normalY = dx / length;
  const shiftX = normalX * parallelOffset;
  const shiftY = normalY * parallelOffset;

  return validSections
    .map((/** @type {any} */ section) => {
      let pathStr = `M ${section.startPoint.x + shiftX},${section.startPoint.y + shiftY}`;
      if (section.bendPoints) {
        section.bendPoints.forEach((/** @type {any} */ bp) => {
          pathStr += ` L ${bp.x + shiftX},${bp.y + shiftY}`;
        });
      }
      pathStr += ` L ${section.endPoint.x + shiftX},${section.endPoint.y + shiftY}`;
      return pathStr;
    })
    .join(' ');
}

/**
 * Hook that memoizes the ELK path calculation for an edge.
 *
 * @param {any} data - Edge data from ReactFlow (must contain elkSections)
 * @returns {string|null} Memoized SVG path string or null
 */
export function useElkPath(data) {
  return useMemo(
    () => buildElkPath(data?.elkSections, Number(data?.parallelOffset || 0)),
    [data?.elkSections, data?.parallelOffset]
  );
}

/**
 * Hook that provides hover state and stable callbacks for edge interaction.
 *
 * Adds a `pinned` mode: a tooltip stays open after the mouse leaves until the
 * user toggles it off (or another pinned tooltip takes over via the shared
 * pin coordinator below). `isOpen` is the combined visibility (`hover ||
 * pinned`) so consumers don't have to OR them themselves.
 *
 * Backwards-compat: `isHovered` keeps the original meaning (hover-only). New
 * callers should prefer `isOpen` for tooltip visibility.
 *
 * @returns {{
 *   isHovered: boolean,
 *   isPinned: boolean,
 *   isOpen: boolean,
 *   handleMouseEnter: Function,
 *   handleMouseLeave: Function,
 *   togglePin: Function
 * }}
 */
export function useEdgeHover() {
  const [isHovered, setIsHovered] = useState(false);
  const [isPinned, setIsPinned] = useState(false);
  const handleMouseEnter = useCallback(() => setIsHovered(true), []);
  const handleMouseLeave = useCallback(() => setIsHovered(false), []);

  // Single-pin coordinator: lives at module scope so clicking one edge unpins
  // any other edge that was pinned. Avoids piling up overlapping tooltips
  // when the user clicks several edges in a row.
  const togglePin = useCallback((/** @type {any} */ next) => {
    setIsPinned((prev) => {
      const wantOpen = typeof next === 'boolean' ? next : !prev;
      if (wantOpen) {
        if (activePinSetter && activePinSetter !== setIsPinned) {
          activePinSetter(false);
        }
        activePinSetter = setIsPinned;
        return true;
      }
      if (activePinSetter === setIsPinned) {
        activePinSetter = null;
      }
      return false;
    });
  }, []);

  return {
    isHovered,
    isPinned,
    isOpen: isHovered || isPinned,
    handleMouseEnter,
    handleMouseLeave,
    togglePin
  };
}

// Module-scoped pointer to the currently-pinned edge's setter. Lets a fresh
// pin reach in and unpin the previous one without exposing a context. The
// trade-off is "one pinned tooltip at a time," which matches the intent
// — no list management, no leaks.
/** @type {((v: boolean) => void) | null} */
let activePinSetter = null;

/**
 * Imperatively clear whichever edge tooltip is currently pinned. Used by
 * canvas-level click handlers ("click empty canvas → unpin").
 */
export function clearActiveEdgePin() {
  if (activePinSetter) {
    activePinSetter(false);
    activePinSetter = null;
  }
}
