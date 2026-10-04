/**
 * @jest-environment jsdom
 *
 * Graph keyboard contract (U-T14): the hover quick-actions are a mouse-only
 * redundant shortcut; the keyboard path is node focus (React Flow
 * nodesFocusable default) -> Enter selects -> NodeToolbar exposes the full
 * action set as real labeled buttons. These oracles pin both halves.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  NodeToolbar: ({ children, isVisible }) =>
    isVisible ? <div data-testid="node-toolbar">{children}</div> : null
}));

jest.mock('../../src/renderer/contexts/NotificationContext', () => ({
  useNotification: () => ({ showError: jest.fn(), addNotification: jest.fn() })
}));

jest.mock('../../src/renderer/store/hooks', () => ({
  useAppSelector: () => false,
  useAppDispatch: () => jest.fn()
}));

import FileNode from '../../src/renderer/components/search/nodes/FileNode';

// The suite-wide fs mock is memfs — static scans read the real tree.
const fs = jest.requireActual('fs');
const path = jest.requireActual('path');

const baseData = {
  label: 'report.pdf',
  path: 'C:/docs/report.pdf',
  category: 'document'
};

describe('FileNode keyboard action path (U-T14)', () => {
  test('selection reveals the full toolbar action set as labeled buttons', () => {
    render(<FileNode data={baseData} selected />);

    expect(screen.getByTestId('node-toolbar')).toBeInTheDocument();
    for (const name of [
      'Open file',
      'Reveal in folder',
      'Find similar',
      'Focus on node',
      'Copy path'
    ]) {
      expect(screen.getByRole('button', { name })).toBeInTheDocument();
    }
  });

  test('unselected node keeps the toolbar hidden (hover div is mouse-only redundancy)', () => {
    render(<FileNode data={baseData} selected={false} />);
    expect(screen.queryByTestId('node-toolbar')).not.toBeInTheDocument();
  });

  test('the graph does not disable React Flow keyboard accessibility', () => {
    // Tab-focusable nodes + Enter/Space selection are React Flow defaults;
    // the keyboard path above depends on nobody turning them off.
    const source = fs.readFileSync(
      path.join(__dirname, '../../src/renderer/components/search/UnifiedSearchModal.jsx'),
      'utf8'
    );
    expect(source).not.toMatch(/nodesFocusable\s*=\s*\{?\s*false/);
    expect(source).not.toMatch(/disableKeyboardA11y/);
  });
});
