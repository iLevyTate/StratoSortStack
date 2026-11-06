/**
 * Geometry for the Live Activity panel: drag by the title bar, resize from
 * the bottom-right corner, arrow keys, and always fully inside the window.
 */
import React from 'react';
import { render, renderHook, act } from '@testing-library/react';
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

/**
 * jsdom may lack PointerEvent, so a MouseEvent named like a pointer event
 * stands in; `pointerId` is attached when given.
 */
function pointerEvent(type, x, y, pointerId) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  if (pointerId !== undefined) {
    Object.defineProperty(event, 'pointerId', { value: pointerId });
    Object.defineProperty(event, 'isPrimary', { value: true });
  }
  return event;
}

function pointer(type, x, y, pointerId) {
  window.dispatchEvent(pointerEvent(type, x, y, pointerId));
}

function press(key, shiftKey = false, modifiers = {}) {
  return { key, shiftKey, ...modifiers, preventDefault: jest.fn() };
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

  test('a window smaller than the minimum size pins the panel to the top-left corner', () => {
    const tiny = { width: 200, height: 100 };
    for (const geometry of [
      { x: 50, y: 50, width: 400, height: 300 },
      { x: -10, y: -10, width: 10, height: 10 },
      { x: NaN, y: NaN, width: NaN, height: NaN }
    ]) {
      expect(clampGeometry(geometry, tiny)).toEqual({ x: 0, y: 0, width: 320, height: 220 });
    }
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

  test('a second pointer cannot hijack the drag', () => {
    const onCommit = jest.fn();
    const { result } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 100, y: 100, width: 400, height: 300 }, onCommit })
    );

    act(() => result.current.dragHandleProps.onPointerDown({ ...startAt(150, 110), pointerId: 1 }));
    act(() => pointer('pointermove', 200, 160, 1));
    act(() => pointer('pointermove', 900, 900, 2));
    act(() => pointer('pointerup', 900, 900, 2));
    expect(result.current.geometry).toEqual({ x: 150, y: 150, width: 400, height: 300 });
    expect(onCommit).not.toHaveBeenCalled();

    act(() => pointer('pointermove', 210, 170, 1));
    act(() => pointer('pointerup', 210, 170, 1));
    expect(onCommit).toHaveBeenCalledTimes(1);
    expect(onCommit).toHaveBeenCalledWith({ x: 160, y: 160, width: 400, height: 300 });
  });

  test('a non-primary pointer does not start a drag', () => {
    const { result } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 100, y: 100, width: 400, height: 300 } })
    );
    act(() =>
      result.current.dragHandleProps.onPointerDown({
        ...startAt(150, 110),
        pointerId: 2,
        isPrimary: false
      })
    );
    act(() => pointer('pointermove', 400, 400, 2));
    expect(result.current.geometry).toEqual({ x: 100, y: 100, width: 400, height: 300 });
  });

  test('a press that ends where it started does not commit', () => {
    const onCommit = jest.fn();
    const { result } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 100, y: 100, width: 400, height: 300 }, onCommit })
    );

    act(() => result.current.dragHandleProps.onPointerDown(startAt(150, 110)));
    act(() => pointer('pointerup', 150, 110));
    expect(onCommit).not.toHaveBeenCalled();

    act(() => result.current.resizeHandleProps.onPointerDown(startAt(500, 400)));
    act(() => pointer('pointermove', 560, 450));
    act(() => pointer('pointermove', 500, 400));
    act(() => pointer('pointerup', 500, 400));
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('an arrow key that cannot move the panel does not commit', () => {
    const onCommit = jest.fn();
    const { result } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 600, y: 500, width: 400, height: 300 }, onCommit })
    );
    const right = press('ArrowRight');
    act(() => result.current.dragHandleProps.onKeyDown(right));
    act(() => result.current.dragHandleProps.onKeyDown(press('ArrowDown')));
    expect(right.preventDefault).toHaveBeenCalled();
    expect(result.current.geometry).toEqual({ x: 600, y: 500, width: 400, height: 300 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('Shift+arrow resize stops at the window edge instead of pushing the panel', () => {
    const onCommit = jest.fn();
    const { result } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 600, y: 500, width: 400, height: 300 }, onCommit })
    );
    act(() => result.current.dragHandleProps.onKeyDown(press('ArrowRight', true)));
    act(() => result.current.dragHandleProps.onKeyDown(press('ArrowDown', true)));
    expect(result.current.geometry).toEqual({ x: 600, y: 500, width: 400, height: 300 });
    expect(onCommit).not.toHaveBeenCalled();

    act(() => result.current.dragHandleProps.onKeyDown(press('ArrowLeft', true)));
    expect(result.current.geometry).toEqual({ x: 600, y: 500, width: 384, height: 300 });
    expect(onCommit).toHaveBeenCalledTimes(1);
  });

  test('arrow keys with Ctrl, Alt or Meta are left alone', () => {
    const onCommit = jest.fn();
    const { result } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 100, y: 100, width: 400, height: 300 }, onCommit })
    );
    for (const modifier of ['ctrlKey', 'altKey', 'metaKey']) {
      const event = press('ArrowRight', false, { [modifier]: true });
      act(() => result.current.dragHandleProps.onKeyDown(event));
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(result.current.geometry).toEqual({ x: 100, y: 100, width: 400, height: 300 });
    expect(onCommit).not.toHaveBeenCalled();
  });

  test('growing the window back restores the panel the user chose', () => {
    const { result } = renderHook(() =>
      useDraggablePanel({ initialGeometry: { x: 200, y: 100, width: 700, height: 600 } })
    );
    expect(result.current.geometry).toEqual({ x: 200, y: 100, width: 700, height: 600 });

    act(() => result.current.dragHandleProps.onKeyDown(press('ArrowRight')));
    expect(result.current.geometry).toEqual({ x: 216, y: 100, width: 700, height: 600 });

    setViewport(500, 400);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current.geometry).toEqual({ x: 100, y: 80, width: 400, height: 320 });

    setViewport(1000, 800);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(result.current.geometry).toEqual({ x: 216, y: 100, width: 700, height: 600 });
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

describe('useDraggablePanel through React event handlers', () => {
  beforeEach(() => {
    setViewport(1000, 800);
  });

  function Panel({ onCommit }) {
    const { geometry, dragHandleProps, resizeHandleProps } = useDraggablePanel({
      initialGeometry: { x: 100, y: 100, width: 400, height: 300 },
      onCommit
    });
    return (
      <section
        data-testid="panel"
        data-geometry={`${geometry.x},${geometry.y},${geometry.width},${geometry.height}`}
      >
        <div data-testid="handle" role="button" tabIndex={0} {...dragHandleProps}>
          <span data-testid="title">Live activity</span>
          <button type="button" data-testid="nested">
            Close
          </button>
        </div>
        <div data-testid="resize" {...resizeHandleProps} />
      </section>
    );
  }

  function shownGeometry(getByTestId) {
    return getByTestId('panel').getAttribute('data-geometry');
  }

  test('a real pointerdown on the title drags the panel and commits on release', () => {
    const onCommit = jest.fn();
    const { getByTestId } = render(<Panel onCommit={onCommit} />);

    act(() => {
      getByTestId('title').dispatchEvent(pointerEvent('pointerdown', 150, 110, 3));
    });
    act(() => pointer('pointermove', 200, 160, 3));
    expect(shownGeometry(getByTestId)).toBe('150,150,400,300');

    act(() => pointer('pointerup', 200, 160, 3));
    expect(onCommit).toHaveBeenCalledWith({ x: 150, y: 150, width: 400, height: 300 });
  });

  test('a real pointerdown on the resize corner resizes the panel', () => {
    const { getByTestId } = render(<Panel />);

    act(() => {
      getByTestId('resize').dispatchEvent(pointerEvent('pointerdown', 500, 400, 4));
    });
    act(() => pointer('pointermove', 560, 450, 4));
    act(() => pointer('pointerup', 560, 450, 4));
    expect(shownGeometry(getByTestId)).toBe('100,100,460,350');
  });

  test('pressing a control inside the handle does not start a drag', () => {
    const onCommit = jest.fn();
    const { getByTestId } = render(<Panel onCommit={onCommit} />);

    act(() => {
      getByTestId('nested').dispatchEvent(pointerEvent('pointerdown', 150, 110, 5));
    });
    act(() => pointer('pointermove', 400, 400, 5));
    act(() => pointer('pointerup', 400, 400, 5));
    expect(shownGeometry(getByTestId)).toBe('100,100,400,300');
    expect(onCommit).not.toHaveBeenCalled();
  });
});
