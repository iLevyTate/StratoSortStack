/**
 * ConfirmModal async-error surface tests.
 *
 * The component used to silently log and close when an async `onConfirm`
 * rejected. Users had no way to tell a destructive action had failed. These
 * tests lock in the new behavior: the modal stays open, an inline alert is
 * rendered, and the primary button becomes "Try Again".
 */

import React from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// The global test setup swaps logger for a stub, which is exactly what we
// want here — we only care about the UI surface, not log output.
jest.mock('react-dom', () => {
  const actual = jest.requireActual('react-dom');
  return {
    ...actual,
    createPortal: (node) => node
  };
});

jest.mock('lucide-react', () => ({
  __esModule: true,
  X: (p) => <span data-testid="icon-x" {...p} />,
  AlertTriangle: (p) => <span data-testid="icon-alert" {...p} />,
  Info: (p) => <span data-testid="icon-info" {...p} />,
  HelpCircle: (p) => <span data-testid="icon-help" {...p} />,
  FileText: (p) => <span data-testid="icon-file" {...p} />
}));

jest.mock('../../src/renderer/utils/scrollLock', () => ({
  lockAppScroll: jest.fn(),
  unlockAppScroll: jest.fn()
}));

jest.mock('../../src/renderer/utils/overlayStack', () => ({
  isTopOverlay: () => true,
  registerOverlay: jest.fn(),
  unregisterOverlay: jest.fn()
}));

const { ConfirmModal } = require('../../src/renderer/components/ui/Modal');

function renderModal(props = {}) {
  const defaults = {
    isOpen: true,
    onClose: jest.fn(),
    onConfirm: jest.fn(() => Promise.resolve()),
    title: 'Delete file?',
    message: 'This cannot be undone.',
    confirmText: 'Delete',
    cancelText: 'Cancel',
    variant: 'danger'
  };
  return { props: { ...defaults, ...props }, ...render(<ConfirmModal {...defaults} {...props} />) };
}

describe('ConfirmModal async error handling', () => {
  test('keeps the modal open and shows an alert when onConfirm rejects', async () => {
    const onClose = jest.fn();
    const onConfirm = jest.fn(() => Promise.reject(new Error('Disk full')));

    renderModal({ onClose, onConfirm });

    fireEvent.click(screen.getByText('Delete'));

    await waitFor(() => {
      expect(screen.getByTestId('confirm-modal-error')).toBeInTheDocument();
    });

    expect(screen.getByTestId('confirm-modal-error')).toHaveTextContent('Disk full');
    // Modal must stay open so the user can retry or cancel.
    expect(onClose).not.toHaveBeenCalled();
    // Button relabels to "Try Again" after a failure.
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });

  test('clears the error on retry and closes on success', async () => {
    const onClose = jest.fn();
    let calls = 0;
    const onConfirm = jest.fn(() => {
      calls += 1;
      return calls === 1 ? Promise.reject(new Error('Transient')) : Promise.resolve();
    });

    renderModal({ onClose, onConfirm });

    fireEvent.click(screen.getByText('Delete'));
    await waitFor(() => {
      expect(screen.getByTestId('confirm-modal-error')).toBeInTheDocument();
    });

    fireEvent.click(screen.getByRole('button', { name: /try again/i }));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(onConfirm).toHaveBeenCalledTimes(2);
  });

  test('falls back to a generic message when the rejection has no message', async () => {
    const onClose = jest.fn();
    const onConfirm = jest.fn(() => Promise.reject(null));

    renderModal({ onClose, onConfirm });

    fireEvent.click(screen.getByText('Delete'));

    await waitFor(() => {
      expect(screen.getByTestId('confirm-modal-error')).toBeInTheDocument();
    });
    expect(screen.getByTestId('confirm-modal-error').textContent).toMatch(/went wrong/i);
    expect(onClose).not.toHaveBeenCalled();
  });

  test('closes normally when onConfirm resolves', async () => {
    const onClose = jest.fn();
    const onConfirm = jest.fn(() => Promise.resolve());

    renderModal({ onClose, onConfirm });

    fireEvent.click(screen.getByText('Delete'));

    await waitFor(() => {
      expect(onClose).toHaveBeenCalledTimes(1);
    });
    expect(screen.queryByTestId('confirm-modal-error')).not.toBeInTheDocument();
  });

  test('error state resets when the modal is reopened', async () => {
    const onClose = jest.fn();
    const onConfirm = jest.fn(() => Promise.reject(new Error('nope')));

    const { rerender } = render(
      <ConfirmModal
        isOpen={true}
        onClose={onClose}
        onConfirm={onConfirm}
        title="t"
        message="m"
        confirmText="Go"
        cancelText="Cancel"
      />
    );

    fireEvent.click(screen.getByText('Go'));
    await waitFor(() => {
      expect(screen.getByTestId('confirm-modal-error')).toBeInTheDocument();
    });

    // Closing and reopening must clear the error state so the next invocation
    // starts fresh.
    act(() => {
      rerender(
        <ConfirmModal
          isOpen={false}
          onClose={onClose}
          onConfirm={onConfirm}
          title="t"
          message="m"
          confirmText="Go"
          cancelText="Cancel"
        />
      );
    });
    act(() => {
      rerender(
        <ConfirmModal
          isOpen={true}
          onClose={onClose}
          onConfirm={jest.fn(() => Promise.resolve())}
          title="t"
          message="m"
          confirmText="Go"
          cancelText="Cancel"
        />
      );
    });

    expect(screen.queryByTestId('confirm-modal-error')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Go' })).toBeInTheDocument();
  });
});
