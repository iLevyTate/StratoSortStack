/**
 * @jest-environment jsdom
 *
 * Focus-restore guard: when a Modal closes, it restores focus to the element
 * focused before it opened — UNLESS something else already claimed focus
 * during the close animation. Without that guard, swapping overlays (e.g.
 * Knowledge OS closing while the Settings panel opens and claims focus at
 * +50ms, before the ~140ms close animation ends) yanked keyboard focus out
 * of the newly opened dialog.
 */
import React from 'react';
import { render, act } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('lucide-react', () => ({
  X: (props) => <svg data-testid="icon-x" {...props} />,
  AlertTriangle: (props) => <svg {...props} />,
  Info: (props) => <svg {...props} />,
  HelpCircle: (props) => <svg {...props} />,
  FileText: (props) => <svg {...props} />
}));

jest.mock('../../src/renderer/components/ui/IconButton', () => ({
  __esModule: true,
  default: ({ icon, children, ...props }) => (
    <button {...props}>
      {icon}
      {children}
    </button>
  )
}));

jest.mock('../../src/renderer/components/ui/Button', () => ({
  __esModule: true,
  default: ({ children, ...props }) => <button {...props}>{children}</button>
}));

jest.mock('../../src/renderer/components/ui/Typography', () => ({
  Heading: ({ as: Component = 'h3', children, ...props }) => (
    <Component {...props}>{children}</Component>
  ),
  Text: ({ as: Component = 'span', children, ...props }) => (
    <Component {...props}>{children}</Component>
  )
}));

jest.mock('../../src/renderer/utils/motionPreferences', () => ({
  getMotionDurationMs: jest.fn(() => 140),
  prefersReducedMotion: jest.fn(() => false)
}));

import Modal from '../../src/renderer/components/ui/Modal';

function Harness({ open }) {
  return (
    <>
      <button type="button" data-testid="opener">
        open
      </button>
      <button type="button" data-testid="outside">
        outside
      </button>
      <Modal isOpen={open} onClose={() => {}} title="Test Modal">
        Body
      </Modal>
    </>
  );
}

describe('Modal focus restore', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });

  afterEach(() => {
    act(() => {
      jest.runOnlyPendingTimers();
    });
    jest.useRealTimers();
  });

  function openModal() {
    const utils = render(<Harness open={false} />);
    const opener = utils.getByTestId('opener');
    opener.focus();
    expect(document.activeElement).toBe(opener);

    utils.rerender(<Harness open />);
    act(() => {
      jest.advanceTimersByTime(60);
    });
    // Modal claimed focus (its first focusable is the close button).
    expect(utils.getByTestId('opener')).not.toBe(document.activeElement);
    return utils;
  }

  test('restores focus to the opener when nothing else claimed focus', () => {
    const utils = openModal();

    utils.rerender(<Harness open={false} />);
    act(() => {
      jest.advanceTimersByTime(200);
    });

    expect(document.activeElement).toBe(utils.getByTestId('opener'));
  });

  test('does not yank focus from an element that claimed it during the close animation', () => {
    const utils = openModal();

    utils.rerender(<Harness open={false} />);
    // While the ~140ms close animation runs, another surface (e.g. the
    // Settings panel in the overlay swap) claims focus.
    const outside = utils.getByTestId('outside');
    act(() => {
      outside.focus();
      jest.advanceTimersByTime(200);
    });

    expect(document.activeElement).toBe(outside);
  });
});
