/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

jest.mock('../../src/renderer/components/ui', () => ({
  StatusBadge: ({ children }) => <span>{children}</span>,
  Card: ({ children, ...props }) => <div {...props}>{children}</div>
}));

jest.mock('../../src/renderer/components/ui/Typography', () => ({
  Text: ({ children }) => <span>{children}</span>
}));

jest.mock('lucide-react', () => ({
  FolderOpen: () => <span />
}));

import AnalysisProgress from '../../src/renderer/components/discover/AnalysisProgress';

describe('AnalysisProgress live region (SW-79)', () => {
  test('surface="none" still exposes a status live region', () => {
    render(
      <AnalysisProgress
        surface="none"
        progress={{ current: 1, total: 4 }}
        currentFile="/tmp/a.pdf"
      />
    );

    expect(screen.getByRole('status')).toBeInTheDocument();
  });
});
