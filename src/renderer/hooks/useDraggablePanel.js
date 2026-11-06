// @ts-check
/**
 * Geometry for a floating panel: drag by a handle, resize from the
 * bottom-right corner, move with the arrow keys (Shift+arrows resize), and
 * always keep the whole panel inside the window, including when the window
 * shrinks and when a stored geometry no longer fits. `onCommit` receives the
 * geometry when a drag, resize or key move ends, for persistence.
 *
 * Drags capture the pointer on the handle and listen on `window` for the
 * rest of the gesture. The gesture ends on pointerup, pointercancel, a lost
 * capture (the OS took the pointer, e.g. alt-tab mid-drag) or the window
 * losing focus, so an interrupted drag never sticks to the cursor.
 *
 * Moves are applied per pointermove without an extra animation-frame
 * throttle: Chromium already coalesces pointermove to one event per frame,
 * and a move that clamps to the current geometry (pinned against an edge)
 * skips the state update entirely. The hook adds no CSS transitions, so
 * `prefers-reduced-motion` has nothing to turn off here.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * @typedef {{ x: number, y: number, width: number, height: number }} PanelGeometry
 * @typedef {{ minWidth: number, minHeight: number, maxFraction: number }} PanelLimits
 * @typedef {{ width: number, height: number }} Viewport
 * @typedef {{ button?: number, clientX: number, clientY: number, pointerId?: number, currentTarget?: Element | null, preventDefault?: () => void }} PointerStart
 * @typedef {{ key: string, shiftKey?: boolean, preventDefault: () => void }} KeyInput
 */

export const PANEL_LIMITS = Object.freeze({ minWidth: 320, minHeight: 220, maxFraction: 0.8 });
export const KEYBOARD_STEP_PX = 16;

/** @type {Record<string, [number, number]>} */
const ARROW_DELTAS = {
  ArrowLeft: [-1, 0],
  ArrowRight: [1, 0],
  ArrowUp: [0, -1],
  ArrowDown: [0, 1]
};

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 */
function clampNumber(value, min, max) {
  return Math.min(Math.max(value, min), Math.max(min, max));
}

/**
 * @param {unknown} value
 * @param {number} fallback
 */
function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * @param {PanelGeometry} a
 * @param {PanelGeometry} b
 */
function sameGeometry(a, b) {
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

/** @returns {Viewport} */
export function getViewport() {
  if (typeof window === 'undefined') return { width: 1024, height: 768 };
  return { width: window.innerWidth || 1024, height: window.innerHeight || 768 };
}

/**
 * Size between the minimum and `maxFraction` of the window; position so the
 * whole panel is visible.
 * @param {PanelGeometry} geometry
 * @param {Viewport} viewport
 * @param {PanelLimits} [limits]
 * @returns {PanelGeometry}
 */
export function clampGeometry(geometry, viewport, limits = PANEL_LIMITS) {
  const maxWidth = Math.max(limits.minWidth, Math.floor(viewport.width * limits.maxFraction));
  const maxHeight = Math.max(limits.minHeight, Math.floor(viewport.height * limits.maxFraction));
  const width = clampNumber(
    Math.round(toNumber(geometry.width, limits.minWidth)),
    limits.minWidth,
    maxWidth
  );
  const height = clampNumber(
    Math.round(toNumber(geometry.height, limits.minHeight)),
    limits.minHeight,
    maxHeight
  );
  const x = clampNumber(Math.round(toNumber(geometry.x, 0)), 0, viewport.width - width);
  const y = clampNumber(Math.round(toNumber(geometry.y, 0)), 0, viewport.height - height);
  return { x, y, width, height };
}

/**
 * Capture the pointer on the handle when the platform supports it. Returns a
 * release function (a no-op when nothing was captured).
 * @param {PointerStart} event
 * @returns {() => void}
 */
function capturePointer(event) {
  const target = event.currentTarget;
  const pointerId = event.pointerId;
  if (!target || typeof pointerId !== 'number' || typeof target.setPointerCapture !== 'function') {
    return () => {};
  }
  try {
    target.setPointerCapture(pointerId);
  } catch {
    // The pointer is already gone (e.g. released before the handler ran).
    return () => {};
  }
  return () => {
    try {
      if (typeof target.hasPointerCapture !== 'function' || target.hasPointerCapture(pointerId)) {
        target.releasePointerCapture(pointerId);
      }
    } catch {
      // Already released by the browser.
    }
  };
}

/**
 * @param {{ initialGeometry: PanelGeometry, onCommit?: (geometry: PanelGeometry) => void, limits?: PanelLimits }} options
 */
export function useDraggablePanel({ initialGeometry, onCommit, limits = PANEL_LIMITS }) {
  const [geometry, setGeometry] = useState(() =>
    clampGeometry(initialGeometry, getViewport(), limits)
  );
  const geometryRef = useRef(geometry);
  const onCommitRef = useRef(onCommit);
  const stopSessionRef = useRef(/** @type {(() => void) | null} */ (null));

  useEffect(() => {
    onCommitRef.current = onCommit;
  }, [onCommit]);

  const apply = useCallback(
    (/** @type {PanelGeometry} */ next) => {
      const clamped = clampGeometry(next, getViewport(), limits);
      if (sameGeometry(clamped, geometryRef.current)) return geometryRef.current;
      geometryRef.current = clamped;
      setGeometry(clamped);
      return clamped;
    },
    [limits]
  );

  const commit = useCallback(() => {
    onCommitRef.current?.(geometryRef.current);
  }, []);

  const startSession = useCallback(
    (/** @type {PointerStart} */ event, /** @type {'move' | 'resize'} */ mode) => {
      if (typeof event.button === 'number' && event.button !== 0) return;
      event.preventDefault?.();
      stopSessionRef.current?.();
      const origin = { px: event.clientX, py: event.clientY, geometry: geometryRef.current };
      const releaseCapture = capturePointer(event);
      const captureTarget = event.currentTarget;

      /** @param {MouseEvent} moveEvent */
      const onMove = (moveEvent) => {
        const dx = moveEvent.clientX - origin.px;
        const dy = moveEvent.clientY - origin.py;
        const start = origin.geometry;
        if (mode === 'move') {
          apply({ ...start, x: start.x + dx, y: start.y + dy });
          return;
        }
        const viewport = getViewport();
        apply({
          ...start,
          width: Math.min(start.width + dx, viewport.width - start.x),
          height: Math.min(start.height + dy, viewport.height - start.y)
        });
      };

      /** @param {boolean} shouldCommit */
      const end = (shouldCommit) => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onFinish);
        window.removeEventListener('pointercancel', onFinish);
        window.removeEventListener('blur', onFinish);
        captureTarget?.removeEventListener('lostpointercapture', onFinish);
        releaseCapture();
        if (stopSessionRef.current === stop) stopSessionRef.current = null;
        if (shouldCommit) commit();
      };

      function onFinish() {
        end(true);
      }

      function stop() {
        end(false);
      }

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onFinish);
      window.addEventListener('pointercancel', onFinish);
      window.addEventListener('blur', onFinish);
      captureTarget?.addEventListener('lostpointercapture', onFinish);
      stopSessionRef.current = stop;
    },
    [apply, commit]
  );

  const onKeyDown = useCallback(
    (/** @type {KeyInput} */ event) => {
      const delta = ARROW_DELTAS[event.key];
      if (!delta) return;
      event.preventDefault();
      const current = geometryRef.current;
      const [dx, dy] = delta;
      if (event.shiftKey) {
        apply({
          ...current,
          width: current.width + dx * KEYBOARD_STEP_PX,
          height: current.height + dy * KEYBOARD_STEP_PX
        });
      } else {
        apply({
          ...current,
          x: current.x + dx * KEYBOARD_STEP_PX,
          y: current.y + dy * KEYBOARD_STEP_PX
        });
      }
      commit();
    },
    [apply, commit]
  );

  // Re-clamp on every window resize so a shrinking window never hides the panel.
  useEffect(() => {
    const onResize = () => {
      apply(geometryRef.current);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [apply]);

  // An unmount mid-drag drops the listeners and the capture without committing.
  useEffect(
    () => () => {
      stopSessionRef.current?.();
    },
    []
  );

  return {
    geometry,
    dragHandleProps: {
      onPointerDown: (/** @type {PointerStart} */ event) => startSession(event, 'move'),
      onKeyDown
    },
    resizeHandleProps: {
      onPointerDown: (/** @type {PointerStart} */ event) => startSession(event, 'resize')
    }
  };
}
