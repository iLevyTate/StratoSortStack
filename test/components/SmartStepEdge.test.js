/**
 * @jest-environment jsdom
 *
 * SmartStepEdge label theming (U-006).
 *
 * The edge label used to hardcode `background: 'white'` and
 * `border: '1px solid #e5e7eb'` inline — a theme-invisible white chip on the
 * dark graph canvas in the `primary`/`dark` palettes, with inherited (light)
 * text on white. Sibling edges in the same graph (SimilarityEdge,
 * QueryMatchEdge) already render their labels with the app's theme-scoped
 * neutral chip tokens. These tests lock SmartStepEdge onto that same pattern:
 * token classes only, no inline color literals. The tokens themselves
 * (`--color-system-gray-*`) are redefined per `data-theme` in styles.css, so
 * class adoption is what makes the label theme-correct.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

// reactflow mocks: replace the parts SmartStepEdge imports with inert shims.
jest.mock('@xyflow/react', () => ({
  BaseEdge: () => null,
  EdgeLabelRenderer: ({ children }) => <div data-testid="edge-label-renderer">{children}</div>,
  getSmoothStepPath: () => ['M0 0 L50 50', 50, 50]
}));

jest.mock('../../src/renderer/components/search/useEdgeInteraction', () => ({
  useElkPath: () => null
}));

import SmartStepEdge from '../../src/renderer/components/search/SmartStepEdge';

const baseProps = {
  id: 'e1',
  sourceX: 0,
  sourceY: 0,
  targetX: 100,
  targetY: 100,
  sourcePosition: 'bottom',
  targetPosition: 'top'
};

describe('SmartStepEdge label theming', () => {
  test('renders no label markup when label is absent', () => {
    render(<SmartStepEdge {...baseProps} />);
    expect(screen.queryByTestId('edge-label-renderer')).not.toBeInTheDocument();
  });

  test('label chip uses the sibling neutral token classes, matching SimilarityEdge', () => {
    render(<SmartStepEdge {...baseProps} label="Organize" />);

    const chip = screen.getByText('Organize');
    // The exact neutral chip pattern shared by SimilarityEdge/QueryMatchEdge.
    expect(chip).toHaveClass(
      'bg-system-gray-100',
      'text-system-gray-700',
      'border',
      'border-system-gray-200',
      'rounded-full',
      'font-medium',
      'whitespace-nowrap'
    );
  });

  test('label carries no hardcoded, theme-invisible inline colors', () => {
    render(<SmartStepEdge {...baseProps} label="Organize" />);

    const renderer = screen.getByTestId('edge-label-renderer');
    const offenders = Array.from(renderer.querySelectorAll('*')).filter((el) => {
      const inline = el.getAttribute('style') || '';
      return /background|border/i.test(inline) && /white|#[0-9a-f]{3,8}|rgb/i.test(inline);
    });
    expect(offenders).toEqual([]);
  });

  test('label keeps its structural positioning wrapper', () => {
    render(<SmartStepEdge {...baseProps} label="Organize" />);

    const wrapper = screen.getByText('Organize').closest('.nodrag');
    expect(wrapper).not.toBeNull();
    expect(wrapper.style.position).toBe('absolute');
    expect(wrapper.style.pointerEvents).toBe('none');
  });
});
