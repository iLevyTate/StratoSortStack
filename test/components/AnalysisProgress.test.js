/**
 * @jest-environment jsdom
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import '@testing-library/jest-dom';

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

describe('AnalysisProgress wording', () => {
  test('the percentage is labeled as progress and shown once', () => {
    render(<AnalysisProgress progress={{ current: 26, total: 39 }} />);

    expect(screen.getByText('Analyzing 26 of 39 files')).toBeInTheDocument();
    expect(screen.getByText('67% complete')).toBeInTheDocument();
    expect(screen.queryByText('67%')).not.toBeInTheDocument();
    expect(screen.getByRole('progressbar')).toHaveAttribute(
      'aria-valuetext',
      '67 percent complete'
    );
  });

  test('one file is not "files"', () => {
    render(<AnalysisProgress progress={{ current: 0, total: 1 }} />);

    expect(screen.getByText('Analyzing 0 of 1 file')).toBeInTheDocument();
  });
});
