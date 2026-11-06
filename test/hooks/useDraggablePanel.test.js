/**
 * Geometry for the Live Activity panel: drag by the title bar, resize from
 * the bottom-right corner, arrow keys, and always fully inside the window.
 */
import { renderHook, act } from '@testing-library/react';
import {
  KEYBOARD_STEP_PX,
  PANEL_LIMITS,
  clampGeometry,
  useDraggablePanel
} from '../../src/renderer/hooks/useDraggablePanel';

function setViewport(width, height) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
  Object.defineProperty(window, 'innerHeight', {
    configurable: true,
    writable: true,
    value: height
  });
}

function pointer(type, x, y) {
  window.dispatchEvent(new MouseEvent(type, { clientX: x, clientY: y }));
}

function press(key, shiftKey = false) {
  return { key, shiftKey, preventDefault: jest.fn() };
}

function startAt(x, y, button = 0) {
  return { button, clientX: x, clientY: y, preventDefault: jest.fn() };
}

/**
 * jsdom has no pointer-capture API, so the handle element gets a fake one
 * that tracks which pointer ids it holds.
 */
function captureHandle() {
  const el = document.createElement('div');
  const held = new Set();
  el.setPointerCapture = jest.fn((id) => held.add(id));
  el.releasePointerCapture = jest.fn((id) => held.delete(id));
  el.hasPointerCapture = jest.fn((id) => held.has(id));
  return el;
}

function startCaptured(el, x, y, pointerId = 7) {
  return { ...startAt(x, y), pointerId, currentTarget: el };
}

describe('clampGeometry', () => {
  const viewport = { width: 1000, height: 800 };

  test('documents the limits from the spec', () => {
    expect(PANEL_LIMITS).toEqual({ minWidth: 320, minHeight: 220, maxFraction: 0.8 });
    expect(KEYBOARD_STEP_PX).toBe(16);
  });

  test('keeps an in-bounds geometry unchanged', () => {
    expect(clampGeometry({ x: 10, y: 20, width: 400, height: 300 }, viewport)).toEqual({
      x: 10,
      y: 20,
      width: 400,
      height: 300
    });
  });

  test('enforces the minimum size', () => {
    expect(clampGeometry({ x: 0, y: 0, width: 100, height: 50 }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 320,
      height: 220
    });
  });

  test('caps the size at 80% of the window', () => {
    expect(clampGeometry({ x: 0, y: 0, width: 2000, height: 2000 }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 800,
      height: 640
    });
  });

  test('keeps the panel fully inside the window', () => {
    expect(clampGeometry({ x: 900, y: 700, width: 400, height: 300 }, viewport)).toEqual({
      x: 600,
      y: 500,
      width: 400,
      height: 300
    });
    expect(clampGeometry({ x: -50, y: -10, width: 400, height: 300 }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 400,
      height: 300
    });
  });

  test('falls back to safe values for non-numeric input', () => {
    expect(clampGeometry({ x: NaN, y: undefined, width: 'a', height: null }, viewport)).toEqual({
      x: 0,
      y: 0,
      width: 320,
      height: 220
    });
  });
});

describe('useDraggablePanel', () => {
  beforeEach(() => {
    setViewport(1000, 800);
  });

  test('clamps the initial geometry to the window', () => {
    setViewport(800, 600);
    const { result } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 700, y: 500, width: 400, height: 300 } })
    );
    expect(result.current.geometry).toEqual({ x: 400, y: 300, width: 400, height: 300 });
  });

  test('a stored tiny, far-off geometry mounts as a visible minimum-size panel', () => {
    // loadPanelState accepts any positive size and positions up to 100000
    // without fitting them to the window; the hook does the fitting.
    const { result } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 99999, y: 99999, width: 0.5, height: 0.5 } })
    );
    expect(result.current.geometry).toEqual({ x: 680, y: 580, width: 320, height: 220 });
  });

  test('dragging the title bar moves the panel, clamps it, and commits on release', () => {
    const onCommit = jest.fn();
    const { result } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 100, y: 100, width: 400, height: 300 }, onCommit })
    );

    act(() => result.current.dragHandleProps.onPointerDown(startAt(150, 110)));
    act(() => pointer('pointermove', 200, 160));
    expect(result.current.geometry).toEqual({ x: 150, y: 150, width: 400, height: 300 });

    act(() => pointer('pointermove', 5000, 5000));
    expect(result.current.geometry).toEqual({ x: 600, y: 500, width: 400, height: 300 });
    expect(onCommit).not.toHaveBeenCalled();

    act(() => pointer('pointerup', 5000, 5000));
    expect(onCommit).toHaveBeenCalledWith({ x: 600, y: 500, width: 400, height: 300 });

    act(() => pointer('pointermove', 0, 0));
    expect(result.current.geometry.x).toBe(600);
  });

  test('ignores non-primary buttons', () => {
    const { result } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 100, y: 100, width: 400, height: 300 } })
    );
    act(() => result.current.dragHandleProps.onPointerDown(startAt(150, 110, 2)));
    act(() => pointer('pointermove', 400, 400));
    expect(result.current.geometry).toEqual({ x: 100, y: 100, width: 400, height: 300 });
  });

  test('corner resize respects the minimum and maximum size', () => {
    const onCommit = jest.fn();
    const { result } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 100, y: 100, width: 400, height: 300 }, onCommit })
    );

    act(() => result.current.resizeHandleProps.onPointerDown(startAt(500, 400)));
    act(() => pointer('pointermove', 100, 100));
    expect(result.current.geometry).toEqual({ x: 100, y: 100, width: 320, height: 220 });

    act(() => pointer('pointermove', 5000, 5000));
    expect(result.current.geometry).toEqual({ x: 100, y: 100, width: 800, height: 640 });

    act(() => pointer('pointerup', 5000, 5000));
    expect(onCommit).toHaveBeenLastCalledWith({ x: 100, y: 100, width: 800, height: 640 });
  });

  test('corner resize grows toward the window edge without pushing the panel', () => {
    const { result } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 500, y: 400, width: 400, height: 300 } })
    );
    act(() => result.current.resizeHandleProps.onPointerDown(startAt(900, 700)));
    act(() => pointer('pointermove', 5000, 5000));
    expect(result.current.geometry).toEqual({ x: 500, y: 400, width: 500, height: 400 });
  });

  test('arrow keys move by 16 px and Shift+arrow keys resize; each commits', () => {
    const onCommit = jest.fn();
    const { result } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 100, y: 100, width: 400, height: 300 }, onCommit })
    );

    act(() => result.current.dragHandleProps.onKeyDown(press('ArrowRight')));
    act(() => result.current.dragHandleProps.onKeyDown(press('ArrowDown')));
    act(() => result.current.dragHandleProps.onKeyDown(press('ArrowLeft', true)));
    act(() => result.current.dragHandleProps.onKeyDown(press('ArrowUp', true)));

    expect(result.current.geometry).toEqual({ x: 116, y: 116, width: 384, height: 284 });
    expect(onCommit).toHaveBeenCalledTimes(4);

    const other = press('Enter');
    act(() => result.current.dragHandleProps.onKeyDown(other));
    expect(other.preventDefault).not.toHaveBeenCalled();
    expect(onCommit).toHaveBeenCalledTimes(4);
  });

  test('re-clamps when the window shrinks', () => {
    const { result } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 600, y: 500, width: 400, height: 300 } })
    );
    setViewport(700, 500);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current.geometry).toEqual({ x: 300, y: 200, width: 400, height: 300 });
  });

  test('a shrinking window also caps the size at 80% of the new window', () => {
    const { result } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 100, y: 100, width: 700, height: 600 } })
    );
    setViewport(500, 400);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current.geometry).toEqual({ x: 100, y: 80, width: 400, height: 320 });
  });

  test('moves pinned against the window edge do not re-render', () => {
    let renders = 0;
    const { result } = renderHook(() => {
      renders += 1;
      return useDraggablePanel({ initialGeometry: { x: 100, y: 100, width: 400, height: 300 } });
    });
    act(() => result.current.dragHandleProps.onPointerDown(startAt(150, 110)));
    act(() => pointer('pointermove', 5000, 5000));
    const afterFirst = renders;
    act(() => pointer('pointermove', 6000, 6000));
    act(() => pointer('pointermove', 7000, 7000));
    expect(renders).toBe(afterFirst);
    expect(result.current.geometry).toEqual({ x: 600, y: 500, width: 400, height: 300 });
  });

  test('unmounting mid-drag removes the window listeners without committing', () => {
    const onCommit = jest.fn();
    const { result, unmount } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 100, y: 100, width: 400, height: 300 }, onCommit })
    );
    act(() => result.current.dragHandleProps.onPointerDown(startAt(150, 110)));
    unmount();

    expect(() => pointer('pointermove', 300, 300)).not.toThrow();
    expect(() => pointer('pointerup', 300, 300)).not.toThrow();
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('every window listener added during a drag is removed on unmount', () => {
    const added = [];
    const removed = [];
    const addSpy = jest.spyOn(window, 'addEventListener').mockImplementation(function (type, fn) {
      added.push([type, fn]);
      return EventTarget.prototype.addEventListener.apply(this, arguments);
    });
    const removeSpy = jest
      .spyOn(window, 'removeEventListener')
      .mockImplementation(function (type, fn) {
        removed.push([type, fn]);
        return EventTarget.prototype.removeEventListener.apply(this, arguments);
      });
    try {
      const { result, unmount } = renderHook(() =>
        useDraggablePanel({ initialGeometry: { x: 100, y: 100, width: 400, height: 300 } })
      );
      act(() => result.current.dragHandleProps.onPointerDown(startAt(150, 110)));
      unmount();
      expect(added.length).toBeGreaterThan(0);
      for (const [type, fn] of added) {
        expect(removed).toContainEqual([type, fn]);
      }
    } finally {
      addSpy.mockRestore();
      removeSpy.mockRestore();
    }
  });

  describe('pointer capture', () => {
    test('captures the pointer on the handle and releases it once on pointerup', () => {
      const onCommit = jest.fn();
      const el = captureHandle();
      const { result } = renderHook(() =>
        useDraggablePanel({
          initialGeometry: { x: 100, y: 100, width: 400, height: 300 },
          onCommit
        })
      );

      act(() => result.current.dragHandleProps.onPointerDown(startCaptured(el, 150, 110)));
      expect(el.setPointerCapture).toHaveBeenCalledWith(7);

      act(() => pointer('pointermove', 200, 160));
      act(() => pointer('pointerup', 200, 160));
      expect(el.releasePointerCapture).toHaveBeenCalledWith(7);
      expect(onCommit).toHaveBeenCalledTimes(1);

      // The browser's own lostpointercapture after pointerup must not commit again.
      act(() => {
        el.dispatchEvent(new Event('lostpointercapture'));
      });
      expect(onCommit).toHaveBeenCalledTimes(1);
    });

    test('lostpointercapture (e.g. alt-tab mid-drag) ends the drag', () => {
      const onCommit = jest.fn();
      const el = captureHandle();
      const { result } = renderHook(() =>
        useDraggablePanel({
          initialGeometry: { x: 100, y: 100, width: 400, height: 300 },
          onCommit
        })
      );

      act(() => result.current.dragHandleProps.onPointerDown(startCaptured(el, 150, 110)));
      act(() => pointer('pointermove', 200, 160));
      act(() => {
        el.dispatchEvent(new Event('lostpointercapture'));
      });
      expect(onCommit).toHaveBeenCalledWith({ x: 150, y: 150, width: 400, height: 300 });

      act(() => pointer('pointermove', 400, 400));
      expect(result.current.geometry).toEqual({ x: 150, y: 150, width: 400, height: 300 });
    });

    test('pointercancel ends the drag and releases the capture', () => {
      const onCommit = jest.fn();
      const el = captureHandle();
      const { result } = renderHook(() =>
        useDraggablePanel({
          initialGeometry: { x: 100, y: 100, width: 400, height: 300 },
          onCommit
        })
      );

      act(() => result.current.resizeHandleProps.onPointerDown(startCaptured(el, 500, 400)));
      act(() => pointer('pointermove', 540, 440));
      act(() => pointer('pointercancel', 540, 440));
      expect(el.releasePointerCapture).toHaveBeenCalledWith(7);
      expect(onCommit).toHaveBeenCalledTimes(1);

      act(() => pointer('pointermove', 900, 900));
      expect(result.current.geometry).toEqual({ x: 100, y: 100, width: 440, height: 340 });
    });

    test('the window losing focus ends the drag', () => {
      const onCommit = jest.fn();
      const { result } = renderHook(() =>
        useDraggablePanel({
          initialGeometry: { x: 100, y: 100, width: 400, height: 300 },
          onCommit
        })
      );

      act(() => result.current.dragHandleProps.onPointerDown(startAt(150, 110)));
      act(() => pointer('pointermove', 200, 160));
      act(() => {
        window.dispatchEvent(new Event('blur'));
      });
      expect(onCommit).toHaveBeenCalledTimes(1);

      act(() => pointer('pointermove', 400, 400));
      expect(result.current.geometry.x).toBe(150);
    });

    test('unmounting mid-drag releases the capture without committing', () => {
      const onCommit = jest.fn();
      const el = captureHandle();
      const { result, unmount } = renderHook(() =>
        useDraggablePanel({
          initialGeometry: { x: 100, y: 100, width: 400, height: 300 },
          onCommit
        })
      );

      act(() => result.current.dragHandleProps.onPointerDown(startCaptured(el, 150, 110)));
      unmount();
      expect(el.releasePointerCapture).toHaveBeenCalledWith(7);
      el.dispatchEvent(new Event('lostpointercapture'));
      expect(onCommit).not.toHaveBeenCalled();
    });

    test('a capture API that throws does not break the drag', () => {
      const el = captureHandle();
      el.setPointerCapture = jest.fn(() => {
        throw new Error('NotFoundError');
      });
      const { result } = renderHook(() =>
        useDraggablePanel({ initialGeometry: { x: 100, y: 100, width: 400, height: 300 } })
      );

      act(() => result.current.dragHandleProps.onPointerDown(startCaptured(el, 150, 110)));
      act(() => pointer('pointermove', 200, 160));
      expect(result.current.geometry).toEqual({ x: 150, y: 150, width: 400, height: 300 });
    });
  });
});
