/**
 * @jest-environment jsdom
 *
 * useDialogFocusTrap (U-011) — dialog a11y behaviors for hand-rolled overlays
 * that bypass the shared <Modal>: Escape closes the TOP overlay only, Tab is
 * trapped inside the dialog, initial focus moves in, and focus is restored to
 * the opener on close.
 */
import React, { useRef, useState } from 'react';
import { render, screen, fireEvent, act } from '@testing-library/react';
import '@testing-library/jest-dom';

import useDialogFocusTrap from '../../src/renderer/hooks/useDialogFocusTrap';
import { registerOverlay, unregisterOverlay } from '../../src/renderer/utils/overlayStack';

function Dialog({ onEscape, children }) {
  const ref = useRef(null);
  useDialogFocusTrap({ active: true, containerRef: ref, onEscape });
  return (
    <div ref={ref} role="dialog" aria-modal="true" aria-label="Test dialog" tabIndex={-1}>
      {children}
    </div>
  );
}

function Harness({ onEscape }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      {open && (
        <Dialog
          onEscape={() => {
            onEscape?.();
            setOpen(false);
          }}
        >
          <button type="button">First</button>
          <button type="button">Last</button>
        </Dialog>
      )}
    </div>
  );
}

describe('useDialogFocusTrap', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  function openDialog() {
    const opener = screen.getByRole('button', { name: 'Open' });
    // jsdom's click does not move focus like a real browser click/keypress
    // would; focus explicitly so the hook can capture the opener.
    opener.focus();
    fireEvent.click(opener);
    act(() => {
      jest.advanceTimersByTime(60);
    });
  }

  test('moves initial focus into the dialog', () => {
    render(<Harness />);
    openDialog();
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();
  });

  test('Tab from the last element wraps to the first; Shift+Tab wraps back', () => {
    render(<Harness />);
    openDialog();

    screen.getByRole('button', { name: 'Last' }).focus();
    fireEvent.keyDown(document, { key: 'Tab' });
    expect(screen.getByRole('button', { name: 'First' })).toHaveFocus();

    fireEvent.keyDown(document, { key: 'Tab', shiftKey: true });
    expect(screen.getByRole('button', { name: 'Last' })).toHaveFocus();
  });

  test('Escape invokes onEscape and focus returns to the opener', () => {
    const onEscape = jest.fn();
    render(<Harness onEscape={onEscape} />);
    openDialog();

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open' })).toHaveFocus();
  });

  test('Escape is ignored while a later overlay sits on top of the stack', () => {
    const onEscape = jest.fn();
    render(<Harness onEscape={onEscape} />);
    openDialog();

    registerOverlay('a-higher-overlay');
    try {
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(onEscape).not.toHaveBeenCalled();
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    } finally {
      unregisterOverlay('a-higher-overlay');
    }

    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onEscape).toHaveBeenCalledTimes(1);
  });
});
