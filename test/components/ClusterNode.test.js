/**
 * @jest-environment jsdom
 *
 * ClusterNode label ink (U-017): the cluster bubble is intentionally light in
 * every theme (accent mixed with white), so the label must carry the
 * `cluster-node-label` hook class that styles.css overrides to dark ink under
 * data-theme='light' (text-system-gray-50 is near-white there).
 */
import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('@xyflow/react', () => ({
  Handle: () => null,
  Position: { Left: 'left', Right: 'right', Top: 'top', Bottom: 'bottom' },
  NodeToolbar: ({ children }) => <div data-testid="node-toolbar">{children}</div>
}));

import ClusterNode from '../../src/renderer/components/search/ClusterNode';

// The light-theme override lives in the real stylesheet; jsdom does not apply
// it, so the contract is asserted from both sides: hook class on the label,
// scoped rule in styles.css.
const fs = jest.requireActual('fs');
const path = require('path');
const stylesCss = fs.readFileSync(path.join(__dirname, '../../src/renderer/styles.css'), 'utf8');

describe('ClusterNode label ink (U-017)', () => {
  test('label carries the cluster-node-label hook class', () => {
    render(<ClusterNode data={{ label: 'Tax Documents', memberCount: 3 }} selected={false} />);

    const label = screen.getByText('Tax Documents');
    expect(label.className).toContain('cluster-node-label');
    expect(label.className).toContain('text-system-gray-50');
  });

  test('styles.css scopes dark ink onto the label in the light theme', () => {
    const ruleStart = stylesCss.indexOf(":root[data-theme='light'] .cluster-node-label");
    expect(ruleStart).toBeGreaterThan(-1);
    const ruleBody = stylesCss.slice(ruleStart, stylesCss.indexOf('}', ruleStart));
    expect(ruleBody).toContain('color: var(--color-system-gray-900)');
  });
});

describe('ClusterNode rename keyboard path (U-T14)', () => {
  const renameProps = {
    data: { label: 'Tax Documents', memberCount: 3, onRenameCluster: jest.fn() },
    selected: true
  };

  test('inline pencil is a real button that reveals on keyboard focus', () => {
    render(<ClusterNode {...renameProps} />);

    const pencil = screen.getByRole('button', { name: 'Rename cluster' });
    expect(pencil.className).toContain('opacity-0');
    expect(pencil.className).toContain('group-hover/label:opacity-100');
    expect(pencil.className).toContain('focus-visible:opacity-100');
  });

  test('pencil activation enters label edit mode', () => {
    render(<ClusterNode {...renameProps} />);

    fireEvent.click(screen.getByRole('button', { name: 'Rename cluster' }));
    expect(screen.getByRole('textbox', { name: 'Cluster label' })).toBeInTheDocument();
  });

  test('the selected-state toolbar carries the primary Rename button', () => {
    render(<ClusterNode {...renameProps} />);
    expect(screen.getByRole('button', { name: 'Rename' })).toBeInTheDocument();
  });
});
