/**
 * @jest-environment jsdom
 *
 * Keyboard affordances for the graph FolderNode.
 *
 * Graph nodes rendered by React Flow have no keyboard semantics by default:
 * the host `<div>` renders without `tabIndex` or a role, so screen-reader
 * and keyboard-only users cannot activate the suggested actions. These
 * tests lock in the baseline WCAG 2.1.1 (Keyboard) contract: the node is
 * focusable, announces itself via `aria-label`, and responds to Enter /
 * Shift+Enter with the same events the toolbar buttons dispatch.
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

// reactflow mocks: replace the parts FolderNode imports with inert shims.
jest.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Top: 'top', Left: 'left', Right: 'right', Bottom: 'bottom' },
  NodeToolbar: ({ children, isVisible }) => (isVisible ? <div>{children}</div> : null)
}));

jest.mock('../../src/renderer/components/ui', () => ({
  IconButton: ({ onClick, 'aria-label': ariaLabel }) => (
    <button type="button" onClick={onClick} aria-label={ariaLabel}>
      {ariaLabel}
    </button>
  )
}));

import FolderNode from '../../src/renderer/components/search/nodes/FolderNode';

const baseData = {
  id: 'folder-1',
  label: 'Invoices/2025',
  memberCount: 4
};

describe('FolderNode keyboard affordances', () => {
  beforeEach(() => {
    jest.restoreAllMocks();
  });

  test('renders as a focusable button with a descriptive aria-label', () => {
    render(<FolderNode data={baseData} selected={false} />);

    const node = screen.getByRole('button', { name: /Invoices\/2025/i });
    expect(node).toHaveAttribute('tabindex', '0');
    expect(node).toHaveAttribute('aria-pressed', 'false');
    expect(node.getAttribute('aria-label')).toMatch(/4 files/);
    expect(node.getAttribute('aria-label')).toMatch(/Enter/);
  });

  test('reflects selected state via aria-pressed', () => {
    render(<FolderNode data={baseData} selected />);
    const node = screen.getAllByRole('button', { name: /Invoices\/2025/i })[0];
    expect(node).toHaveAttribute('aria-pressed', 'true');
  });

  test('Enter dispatches the moveFilesHere primary action', () => {
    const handler = jest.fn();
    window.addEventListener('graph:folderAction', handler);

    render(<FolderNode data={baseData} selected={false} />);
    const node = screen.getByRole('button', { name: /Invoices\/2025/i });
    fireEvent.keyDown(node, { key: 'Enter' });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].detail).toEqual({
      action: 'moveFilesHere',
      folderId: 'folder-1',
      folderPath: 'Invoices/2025'
    });
    window.removeEventListener('graph:folderAction', handler);
  });

  test('Shift+Enter dispatches reveal instead of moveFilesHere', () => {
    const handler = jest.fn();
    window.addEventListener('graph:folderAction', handler);

    render(<FolderNode data={baseData} selected={false} />);
    const node = screen.getByRole('button', { name: /Invoices\/2025/i });
    fireEvent.keyDown(node, { key: 'Enter', shiftKey: true });

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler.mock.calls[0][0].detail.action).toBe('reveal');
    window.removeEventListener('graph:folderAction', handler);
  });

  test('ignores Space so React Flow can continue to use it for panning', () => {
    const handler = jest.fn();
    window.addEventListener('graph:folderAction', handler);

    render(<FolderNode data={baseData} selected={false} />);
    const node = screen.getByRole('button', { name: /Invoices\/2025/i });
    fireEvent.keyDown(node, { key: ' ' });
    fireEvent.keyDown(node, { key: 'Spacebar' });

    expect(handler).not.toHaveBeenCalled();
    window.removeEventListener('graph:folderAction', handler);
  });

  test('toolbar actions still dispatch the matching events', () => {
    const handler = jest.fn();
    window.addEventListener('graph:folderAction', handler);

    render(<FolderNode data={baseData} selected />);
    fireEvent.click(screen.getByRole('button', { name: /Move connected files here/i }));
    fireEvent.click(screen.getByRole('button', { name: /Reveal folder in Explorer/i }));

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0][0].detail.action).toBe('moveFilesHere');
    expect(handler.mock.calls[1][0].detail.action).toBe('reveal');
    window.removeEventListener('graph:folderAction', handler);
  });
});
